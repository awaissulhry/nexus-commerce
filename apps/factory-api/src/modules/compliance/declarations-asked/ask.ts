import type { FastifyRequest } from 'fastify'
import {
  askProblems,
  cancelProblem,
  DECLARATION_LIMITS,
  KIND_SHORT,
  OPEN,
  planAsk,
  taskLabelOf,
  taskSourceKey,
  WAITING,
  type AskChannel,
  type AskGroup,
  type AskMaterial,
  type AskParty,
  type DeclarationStatus,
  type OpenRequest,
} from '@nexus/factory-domain/compliance/declarations-asked/rules'
import { SUPPLIER_DECLARATIONS_VIEW } from '@nexus/factory-domain/compliance/declarations-asked/permissions'
import type { DeclarationKind } from '@nexus/factory-domain/compliance/substances/rules'
import { InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { runCommand, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { closeTasksInCommand, openTaskInCommand } from '../../../platform/portal/tasks/store'
import { officeOf } from '../register-of-rules/common'
import { substancesClock, substancesGuarded, substancesSettings } from '../substances/common'
import type { Reader } from '../substances/store'
import { assertMayManage, personName, readRequest, taskDueAt } from './common'
import { dayValue, linesOf, newestListVersion, REQUEST_SELECT, requestViews } from './store'

/**
 * Request declarations (B-W2b-256; PRD-304; design ts-request "Materials and suppliers, declaration types, due date,
 * reminder cadence. Publish-dialog pattern: review per supplier (the e-mail and the portal task), one send, a result per
 * supplier"). POST /compliance/declarations-asked with `dryRun` answers the plan and writes nothing; without it ONE command
 * makes every request of the plan: per supplier and kind a numbered request (SUPPLIER_DECLARATION series) with a line per
 * material as the supplier knows it, born SENT; asked in the portal, its UPLOAD_DOCUMENT partner task (B-W2b-167's
 * fan-out tells the supplier's people, only while its portal is on: the Owner's switch per partner, OFF by default);
 * asked by the office, nothing goes out from here (the office mails it by hand). A supplier's open request of that kind
 * waiting for its answer takes the new materials as new lines instead of a second request. Nothing is ordered from a lab.
 *
 * Ask again (POST …/:requestId/ask-again): a new request superseding the one named, the same supplier, kind and materials
 * (REACH SVHC: against the newest Candidate List, the list grew); one still waiting is withdrawn in the same command, an
 * answered one is decided first.
 */

export interface AskBody {
  readonly materials: readonly { readonly itemId: string; readonly partyId?: string | null | undefined }[]
  readonly kinds: readonly string[]
  readonly dueOn: string
  readonly reminderEveryDays?: number | null | undefined
  readonly message?: string | null | undefined
  /** PORTAL or OFFICE (LINK is refused in words: no link purpose for a declaration yet). */
  readonly channel?: string | null | undefined
  readonly companyId?: string | null | undefined
  readonly dryRun?: boolean | undefined
}

interface Plan {
  readonly companyId: string
  readonly groups: readonly AskGroup[]
  readonly parties: ReadonlyMap<string, AskParty>
  readonly materials: ReadonlyMap<string, { readonly code: string; readonly name: string }>
  readonly svhcListVersion: { readonly id: string; readonly publishedOn: BusinessDate; readonly entryCount: number } | null
}

const blank = (value: string | null | undefined): string | null => (value === null || value === undefined || value.trim() === '' ? null : value.trim())

/** Reads the facts and plans the requests (inside the command when it sends: the same reads, then the writes). */
async function planOf(db: Reader, actor: Actor, context: OfficeContext, body: AskBody): Promise<Plan> {
  const issues: Issue[] = []
  const ids = [...new Set(body.materials.map((entry) => entry.itemId))]
  const items = await db.item.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, kind: true, companyId: true, defaultSupplierId: true, supplierArticleCode: true, status: true } })
  const byId = new Map(items.map((item) => [item.id, item]))
  body.materials.forEach((entry, index) => {
    const item = byId.get(entry.itemId)
    if (!item || !can(actor, SUPPLIER_DECLARATIONS_VIEW, { companyId: item.companyId })) issues.push({ path: `body/materials/${index}/itemId`, message: 'Not a material you can see.' })
    else if (item.kind === 'FINISHED') issues.push({ path: `body/materials/${index}/itemId`, message: `${item.code} is a finished garment: a declaration is asked about a material.` })
  })
  if (issues.length > 0) throw new ValidationError('A material asked about is not valid.', issues)
  const sources = await db.supplierItem.findMany({ where: { itemId: { in: ids }, status: 'ACTIVE' }, select: { itemId: true, partyId: true, supplierArticleCode: true, companyId: true } })
  const wanted = new Map<string, { partyId: string; articleCode: string | null }[]>()
  body.materials.forEach((entry, index) => {
    const item = byId.get(entry.itemId)!
    const list = wanted.get(item.id) ?? []
    const add = (partyId: string) => {
      if (list.some((supplier) => supplier.partyId === partyId)) return
      const source = sources.find((row) => row.itemId === item.id && row.partyId === partyId)
      list.push({ partyId, articleCode: source?.supplierArticleCode ?? (item.defaultSupplierId === partyId ? item.supplierArticleCode : null) })
    }
    if (entry.partyId) add(entry.partyId)
    else {
      if (item.defaultSupplierId) add(item.defaultSupplierId)
      for (const source of sources.filter((row) => row.itemId === item.id)) add(source.partyId)
      if (list.length === 0) issues.push({ path: `body/materials/${index}/partyId`, message: `${item.code} has no supplier: name the supplier to ask.` })
    }
    wanted.set(item.id, list)
  })
  if (issues.length > 0) throw new ValidationError('A material has no supplier to ask.', issues)
  const partyIds = [...new Set([...wanted.values()].flat().map((supplier) => supplier.partyId))]
  const partyRows = await db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, code: true, legalName: true, companyId: true, status: true, roles: true } })
  const portals = new Map((partyIds.length === 0 ? [] : await db.portalSettings.findMany({ where: { partyId: { in: partyIds } }, select: { partyId: true, portalOn: true } })).map((row) => [row.partyId, row.portalOn]))

  // The company that asks: the one named, else the materials' (one), else the suppliers' (one), else the screen's.
  const companies = (values: readonly (string | null)[]) => [...new Set(values.filter((value): value is string => value !== null))]
  const itemCompanies = companies(items.map((item) => item.companyId))
  if (itemCompanies.length > 1 && !body.companyId) throw new ValidationError('The materials belong to more than one company.', [{ path: 'body/companyId', message: 'Ask for the materials of one company at a time, or name the company that asks.' }])
  const companyId = body.companyId ?? itemCompanies[0] ?? (companies(partyRows.map((party) => party.companyId)).length === 1 ? companies(partyRows.map((party) => party.companyId))[0]! : null) ?? context.companyId ?? null
  if (!companyId) throw new ValidationError('Name the company that asks.', [{ path: 'body/companyId', message: 'Every material and supplier is for every company: name the company that asks.' }])
  assertMayManage(actor, companyId)
  items.forEach((item) => {
    if (item.companyId !== null && item.companyId !== companyId) issues.push({ path: 'body/materials', message: `${item.code} is another company's material.` })
  })
  if (issues.length > 0) throw new ValidationError('A material is of another company.', issues)

  const parties = new Map<string, AskParty>()
  for (const party of partyRows) {
    const refusal =
      party.companyId !== null && party.companyId !== companyId
        ? `${party.code} is another company's party.`
        : !party.roles.some((role) => role === 'SUPPLIER' || role === 'SUBCONTRACTOR')
          ? `${party.code} is not a supplier.`
          : party.status !== 'ACTIVE'
            ? `${party.code} is ${party.status.toLowerCase()}: only an active supplier is asked.`
            : null
    parties.set(party.id, { id: party.id, code: party.code, name: party.legalName, portalOn: portals.get(party.id) === true, refusal })
  }
  const kinds = body.kinds as DeclarationKind[]
  const openRows = await db.supplierDeclarationRequest.findMany({
    where: { companyId, partyId: { in: partyIds }, kind: { in: kinds }, status: { in: [...OPEN] } },
    select: { id: true, number: true, partyId: true, kind: true, status: true, svhcListVersionId: true },
  })
  const openLines = await linesOf(db, openRows.map((row) => row.id))
  const open: OpenRequest[] = openRows.map((row) => ({
    requestId: row.id,
    number: row.number,
    partyId: row.partyId,
    kind: row.kind as DeclarationKind,
    status: row.status as DeclarationStatus,
    svhcListVersionId: row.svhcListVersionId,
    itemIds: (openLines.get(row.id) ?? []).map((line) => line.itemId),
    lines: (openLines.get(row.id) ?? []).length,
  }))
  const newest = await newestListVersion(db)
  const askMaterials: AskMaterial[] = items.map((item) => ({ itemId: item.id, code: item.code, name: item.name, suppliers: wanted.get(item.id) ?? [] }))
  const groups = planAsk({ materials: askMaterials, parties, kinds, open, channel: (body.channel ?? null) as AskChannel | null, svhcListVersionId: newest?.id ?? null })
  return { companyId, groups, parties, materials: new Map(items.map((item) => [item.id, { code: item.code, name: item.name }])), svhcListVersion: newest }
}

/** A group as the review and the result show it: the supplier, the kind, how it goes, the materials, what happens and why. */
function groupView(plan: Plan, group: AskGroup, done?: { readonly requestId: string; readonly number: string }) {
  const party = plan.parties.get(group.partyId)
  return {
    party: { id: group.partyId, code: party?.code ?? '?', name: party?.name ?? '?', portalOn: party?.portalOn ?? false },
    kind: group.kind,
    kindShort: KIND_SHORT[group.kind],
    channel: group.channel,
    outcome: group.outcome,
    why: group.why,
    materials: group.lines.map((line) => ({ itemId: line.itemId, code: plan.materials.get(line.itemId)?.code ?? '?', name: plan.materials.get(line.itemId)?.name ?? '?', articleLabel: line.articleLabel })),
    request: done ?? group.openRequest,
  }
}

interface NewRequest {
  readonly companyId: string
  readonly partyId: string
  readonly kind: DeclarationKind
  readonly channel: AskChannel
  readonly svhcListVersionId: string | null
  readonly message: string | null
  readonly dueOn: BusinessDate
  readonly reminderEveryDays: number | null
  readonly lines: readonly { readonly itemId: string; readonly articleLabel: string }[]
  readonly supersedesId: string | null
}

/** Inside a command: one numbered request, its lines and (portal) its partner task. */
async function makeRequest(tools: CommandTools, input: NewRequest, asker: { readonly id: string; readonly name: string } | null): Promise<{ readonly requestId: string; readonly number: string }> {
  const { tx, now } = tools
  const id = newId()
  const issued = await allocateNumber(tools, { companyId: input.companyId, kind: 'SUPPLIER_DECLARATION' }, { type: 'SupplierDeclarationRequest', id })
  await tx.supplierDeclarationRequest.create({
    data: {
      id,
      companyId: input.companyId,
      number: issued.formatted,
      partyId: input.partyId,
      kind: input.kind,
      svhcListVersionId: input.kind === 'REACH_SVHC' ? input.svhcListVersionId : null,
      channel: input.channel,
      message: input.message,
      sentAt: now,
      dueOn: dayValue(input.dueOn),
      reminderEveryDays: input.reminderEveryDays,
      supersedesId: input.supersedesId,
      createdAt: now,
      updatedAt: now,
      createdById: asker?.id ?? null,
    },
    select: { id: true },
  })
  await tx.supplierDeclarationLine.createMany({
    data: input.lines.map((line, index) => ({ id: newId(), partyId: input.partyId, requestId: id, seq: index + 1, itemId: line.itemId, articleLabel: line.articleLabel, createdAt: now, updatedAt: now, createdById: asker?.id ?? null })),
  })
  let taskId: string | null = null
  if (input.channel === 'PORTAL') {
    const { task } = await openTaskInCommand(tools, {
      companyId: input.companyId,
      partyId: input.partyId,
      kind: 'UPLOAD_DOCUMENT',
      record: { type: 'SupplierDeclarationRequest', id, label: taskLabelOf(issued.formatted, input.kind, input.lines.map((line) => line.articleLabel)) },
      sourceKey: taskSourceKey(id),
      dueAt: taskDueAt(input.dueOn),
      askedBy: asker,
    })
    taskId = task.id
    await tx.supplierDeclarationRequest.update({ where: { id }, data: { partnerTaskId: task.id, updatedAt: now }, select: { id: true } })
  }
  tools.audit({
    action: 'compliance.supplierDeclarations.ask',
    recordType: 'SupplierDeclarationRequest',
    recordId: id,
    companyId: input.companyId,
    after: { number: issued.formatted, partyId: input.partyId, kind: input.kind, channel: input.channel, dueOn: input.dueOn, reminderEveryDays: input.reminderEveryDays, svhcListVersionId: input.svhcListVersionId, items: input.lines.map((line) => line.itemId), partnerTaskId: taskId, supersedesId: input.supersedesId },
  })
  tools.emit({
    type: 'compliance_material_tests.declaration_asked',
    subject: id,
    companyId: input.companyId,
    payload: { requestId: id, number: issued.formatted, partyId: input.partyId, kind: input.kind, channel: input.channel, lines: input.lines.length, dueOn: input.dueOn, supersedesId: input.supersedesId },
  })
  return { requestId: id, number: issued.formatted }
}

/** POST /compliance/declarations-asked — the plan (dryRun) or the send. */
export async function askDeclarations(caller: CommandCaller & Pick<FastifyRequest, 'withClient'>, body: AskBody, key: string | null | undefined) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const now = substancesClock().now()
  const today = businessDate(now)
  if (body.materials.length === 0 || body.materials.length > DECLARATION_LIMITS.materials) throw new ValidationError('Ask about 1 to 100 materials.', [{ path: 'body/materials', message: `1 to ${DECLARATION_LIMITS.materials} materials.` }])
  const problems = askProblems(body, today)
  if (problems.length > 0) throw new ValidationError('The request is not valid.', problems)
  const answer = (plan: Plan, done: ReadonlyMap<AskGroup, { requestId: string; number: string }>, sent: boolean) => ({
    sent,
    companyId: plan.companyId,
    svhcListVersion: plan.svhcListVersion,
    groups: plan.groups.map((group) => groupView(plan, group, done.get(group))),
    counts: {
      send: plan.groups.filter((group) => group.outcome === 'SEND').length,
      add: plan.groups.filter((group) => group.outcome === 'ADD').length,
      skip: plan.groups.filter((group) => group.outcome === 'SKIP').length,
    },
  })
  if (body.dryRun) {
    const plan = await caller.withClient((db) => planOf(db, actor, context, body))
    return answer(plan, new Map(), false)
  }
  const { result } = await substancesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.supplierDeclarations.ask', idempotencyKey: key, input: body },
      async (tools) => {
        const plan = await planOf(tools.tx, actor, context, body)
        if (!plan.groups.some((group) => group.outcome !== 'SKIP')) {
          throw new InvalidStateError(`Nothing to ask: ${plan.groups.map((group) => group.why).filter(Boolean).join(' ') || 'no supplier to ask.'}`)
        }
        const asker = { id: context.actorId, name: await personName(tools.tx, context.actorId) }
        const done = new Map<AskGroup, { requestId: string; number: string }>()
        for (const group of plan.groups) {
          if (group.outcome === 'SEND') {
            done.set(
              group,
              await makeRequest(
                tools,
                { companyId: plan.companyId, partyId: group.partyId, kind: group.kind, channel: group.channel!, svhcListVersionId: plan.svhcListVersion?.id ?? null, message: blank(body.message), dueOn: body.dueOn, reminderEveryDays: body.reminderEveryDays ?? null, lines: group.lines, supersedesId: null },
                asker,
              ),
            )
          } else if (group.outcome === 'ADD' && group.openRequest) {
            const request = group.openRequest
            const existing = (await linesOf(tools.tx, [request.requestId])).get(request.requestId) ?? []
            const seq = existing.reduce((max, line) => Math.max(max, line.seq), 0)
            await tools.tx.supplierDeclarationLine.createMany({
              data: group.lines.map((line, index) => ({ id: newId(), partyId: group.partyId, requestId: request.requestId, seq: seq + index + 1, itemId: line.itemId, articleLabel: line.articleLabel, createdAt: tools.now, updatedAt: tools.now, createdById: context.actorId })),
            })
            await tools.tx.supplierDeclarationRequest.update({ where: { id: request.requestId }, data: { version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
            tools.audit({ action: 'compliance.supplierDeclarations.extend', recordType: 'SupplierDeclarationRequest', recordId: request.requestId, companyId: plan.companyId, after: { added: group.lines.map((line) => line.itemId) } })
            tools.emit({
              type: 'compliance_material_tests.declaration_extended',
              subject: request.requestId,
              companyId: plan.companyId,
              payload: { requestId: request.requestId, number: request.number, partyId: group.partyId, kind: group.kind, added: group.lines.length, lines: existing.length + group.lines.length },
            })
            done.set(group, request)
          }
        }
        return answer(plan, done, true)
      },
      substancesSettings(),
    ),
  )
  return result
}

export interface AskAgainBody {
  readonly version: number
  readonly dueOn: string
  readonly reminderEveryDays?: number | null | undefined
  readonly message?: string | null | undefined
  readonly channel?: string | null | undefined
}

/** POST /compliance/declarations-asked/:requestId/ask-again. */
export async function askAgain(caller: CommandCaller & Pick<FastifyRequest, 'withClient'>, requestId: string, body: AskAgainBody, key: string | null | undefined) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const now = substancesClock().now()
  const today = businessDate(now)
  const first = await caller.withClient((db) => readRequest(db, actor, requestId))
  assertMayManage(actor, first.companyId)
  const problems = askProblems({ kinds: [first.kind], dueOn: body.dueOn, reminderEveryDays: body.reminderEveryDays ?? null, message: body.message ?? null, channel: body.channel ?? null }, today)
  if (problems.length > 0) throw new ValidationError('The request is not valid.', problems)
  const { result } = await substancesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.supplierDeclarations.askAgain', idempotencyKey: key, input: { requestId, ...body }, record: { type: 'SupplierDeclarationRequest', id: requestId, expectedVersion: body.version } },
      async (tools) => {
        const old = await readRequest(tools.tx, actor, requestId)
        const status = old.status as DeclarationStatus
        if (status === 'ANSWERED') throw new InvalidStateError(`${old.number} is answered: accept or refuse it before asking again.`)
        const lines = (await linesOf(tools.tx, [old.id])).get(old.id) ?? []
        const once = [...new Map(lines.map((line) => [line.itemId, line])).values()]
        const portal = (await tools.tx.portalSettings.findFirst({ where: { partyId: old.partyId }, select: { portalOn: true } }))?.portalOn === true
        const channel: AskChannel = (body.channel as AskChannel | null | undefined) ?? (portal ? 'PORTAL' : 'OFFICE')
        if (channel === 'PORTAL' && !portal) throw new InvalidStateError("The supplier's portal is off: ask by e-mail (OFFICE), or switch its portal on first.")
        const newest = await newestListVersion(tools.tx)
        if (old.kind === 'REACH_SVHC' && !newest) throw new InvalidStateError('No Candidate List version is recorded.')
        const asker = { id: context.actorId, name: await personName(tools.tx, context.actorId) }
        // One still waiting is withdrawn first (a request asks again only one that was decided or withdrawn).
        if (WAITING.has(status)) {
          await tools.tx.supplierDeclarationRequest.update({ where: { id: old.id }, data: { status: 'CANCELLED', cancelledAt: tools.now, cancelReason: 'Asked again in a new request.', updatedAt: tools.now }, select: { id: true } })
          if (old.partnerTaskId) await closeTasksInCommand(tools, { recordType: 'SupplierDeclarationRequest', recordId: old.id, kinds: ['UPLOAD_DOCUMENT'], status: 'CANCELLED', doneById: null })
        }
        const made = await makeRequest(
          tools,
          {
            companyId: old.companyId,
            partyId: old.partyId,
            kind: old.kind as DeclarationKind,
            channel,
            svhcListVersionId: newest?.id ?? null,
            message: blank(body.message) ?? old.message,
            dueOn: body.dueOn,
            reminderEveryDays: body.reminderEveryDays === undefined ? old.reminderEveryDays : body.reminderEveryDays,
            lines: once.map((line) => ({ itemId: line.itemId, articleLabel: line.articleLabel })),
            supersedesId: old.id,
          },
          asker,
        )
        if (WAITING.has(status)) {
          tools.audit({ action: 'compliance.supplierDeclarations.cancel', recordType: 'SupplierDeclarationRequest', recordId: old.id, companyId: old.companyId, before: { status }, after: { status: 'CANCELLED', askedAgainIn: made.number } })
          tools.emit({ type: 'compliance_material_tests.declaration_cancelled', subject: old.id, companyId: old.companyId, payload: { requestId: old.id, partyId: old.partyId, supersededById: made.requestId } })
        }
        const row = await tools.tx.supplierDeclarationRequest.findUniqueOrThrow({ where: { id: made.requestId }, select: REQUEST_SELECT })
        return { request: (await requestViews(tools.tx, [row], tools.now))[0]!, previous: { id: old.id, number: old.number, status: WAITING.has(status) ? ('CANCELLED' as const) : status }, at: toUtcIso(tools.now) }
      },
      substancesSettings(),
    ),
  )
  return result
}

/** POST /compliance/declarations-asked/:requestId/cancel. */
export async function cancelRequest(caller: CommandCaller & Pick<FastifyRequest, 'withClient'>, requestId: string, body: { readonly version: number; readonly reason: string }, key: string | null | undefined) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const first = await caller.withClient((db) => readRequest(db, actor, requestId))
  assertMayManage(actor, first.companyId)
  const problem = cancelProblem(body.reason)
  if (problem) throw new ValidationError('The cancellation is not valid.', [{ path: 'body/reason', message: problem }])
  const { result } = await substancesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.supplierDeclarations.cancel', idempotencyKey: key, input: { requestId, ...body }, record: { type: 'SupplierDeclarationRequest', id: requestId, expectedVersion: body.version } },
      async (tools) => {
        const row = await readRequest(tools.tx, actor, requestId)
        const status = row.status as DeclarationStatus
        if (!WAITING.has(status)) throw new InvalidStateError(status === 'ANSWERED' ? `${row.number} is answered: accept or refuse it instead.` : `${row.number} is ${status.toLowerCase()} already.`)
        await tools.tx.supplierDeclarationRequest.update({ where: { id: row.id }, data: { status: 'CANCELLED', cancelledAt: tools.now, cancelReason: body.reason.trim(), updatedAt: tools.now }, select: { id: true } })
        if (row.partnerTaskId) await closeTasksInCommand(tools, { recordType: 'SupplierDeclarationRequest', recordId: row.id, kinds: ['UPLOAD_DOCUMENT'], status: 'CANCELLED', doneById: null })
        tools.audit({ action: 'compliance.supplierDeclarations.cancel', recordType: 'SupplierDeclarationRequest', recordId: row.id, companyId: row.companyId, reason: body.reason.trim(), before: { status }, after: { status: 'CANCELLED' } })
        tools.emit({ type: 'compliance_material_tests.declaration_cancelled', subject: row.id, companyId: row.companyId, payload: { requestId: row.id, partyId: row.partyId, supersededById: null } })
        const fresh = await tools.tx.supplierDeclarationRequest.findUniqueOrThrow({ where: { id: row.id }, select: REQUEST_SELECT })
        return { request: (await requestViews(tools.tx, [fresh], tools.now))[0]! }
      },
      substancesSettings(),
    ),
  )
  return result
}
