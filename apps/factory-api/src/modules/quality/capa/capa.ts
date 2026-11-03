import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, type ScopedRecord } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { QUALITY_CAPA_MANAGE, QUALITY_CAPA_VIEW } from '@nexus/factory-domain/quality/capa/permissions'
import {
  allMet,
  CAPA_LIMITS,
  CAPA_RECORD,
  capaDraftProblems,
  closeChecks,
  firstStage,
  isFinal,
  moveProblem,
  nextStage,
  teamProblems,
  type CapaChangedField,
  type CapaPriority,
  type CapaStatus,
  type CapaType,
  type SourceType,
  type TeamMember,
} from '@nexus/factory-domain/quality/capa/rules'
import { QUALITY_COMPLAINTS_VIEW } from '@nexus/factory-domain/quality/complaints/permissions'
import { QUALITY_NCR_VIEW } from '@nexus/factory-domain/quality/ncr/permissions'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { followInCommand } from '../../../platform/threads/followers'
import { assertOpen, contextOf, held, mayOn, officeCapa, officeOf, refuse } from './access'
import { addSourcesInCommand, type SourceInput } from './sources'
import { closeReminderTasks } from './reminders'
import {
  actionViews,
  asDay,
  CAPA_COLUMNS,
  capaSummary,
  customersOf,
  dayOf,
  iso,
  lockCapa,
  namesOf,
  readActions,
  readCapa,
  readSources,
  seesCapa,
  sourceFactsOf,
  sourceLabels,
  teamOf,
  type CapaRow,
  type Reader,
} from './store'

/**
 * CAPA and 8D records (B-W2b-108; QHS-093; design quality.capa capa-new, the record's Problem tab capa-d123 and its band):
 * open, change, move along the stages, close, cancel. Each write is ONE command(); the refusals come first, in words; the
 * …_quality_problems_w2b_guards triggers hold the same rules for every login. Every write of a CAPA locks its row first
 * (FOR UPDATE: its actions and sources hold it FOR SHARE, so a close waits for an action write in flight), checks the
 * version the screen read and bumps it. Sources (escalation) are ./sources.ts, actions ./actions.ts, reminders and
 * escalation ./reminders.ts, the 8D report ./report.ts, the list ./reads.ts.
 *
 *   open    (quality.capa.manage over the company and customer) a CAPA (PLAN) or an 8D (D1), numbered from the company's
 *           CAPA series (allocateNumber), with its owner (the caller unless named), team, due day, priority, customer (a
 *           CUSTOMER or BRAND of the company) and problem statement, and the NCRs and complaints it comes from (escalated
 *           in the same command: sources.ts). The owner and the team follow it (ASSIGNEE), its maker too (CREATOR).
 *   change  (manage) its title, owner, team, due day, priority, customer and problem, while it is open.
 *   stage   (manage) any stage of its own type, either way.
 *   close   (manage) from its last stage (CHECK, D8) once at least one action is done and none is open, with the closing
 *           words (D8); its open reminder tasks are closed with it.
 *   cancel  (manage) from any stage, with the reason; its open actions stay as they are (the CAPA never changes again).
 */

export interface OpenBody {
  readonly companyId?: string | undefined
  readonly type: CapaType
  readonly title: string
  readonly ownerId?: string | undefined
  readonly team?: readonly TeamMember[] | undefined
  readonly dueOn: BusinessDate
  readonly priority?: CapaPriority | undefined
  readonly customerId?: string | null | undefined
  readonly problemWhat?: string | null | undefined
  readonly problemWhere?: string | null | undefined
  readonly problemWhen?: string | null | undefined
  readonly problemHowMany?: string | null | undefined
  readonly sources?: readonly SourceInput[] | undefined
}

export interface EditBody {
  readonly version: number
  readonly title?: string | undefined
  readonly ownerId?: string | undefined
  readonly team?: readonly TeamMember[] | undefined
  readonly dueOn?: BusinessDate | undefined
  readonly priority?: CapaPriority | undefined
  readonly customerId?: string | null | undefined
  readonly problemWhat?: string | null | undefined
  readonly problemWhere?: string | null | undefined
  readonly problemWhen?: string | null | undefined
  readonly problemHowMany?: string | null | undefined
}

const cleanOrNull = (value: string | null | undefined): string | null => (value === null || value === undefined ? null : value.trim() || null)
const cleanTeam = (team: readonly TeamMember[]): TeamMember[] => team.map((member) => ({ userId: member.userId, role: member.role.trim() }))

// ---- the record --------------------------------------------------------------------------------------------------------

/** The CAPA record (GET /quality/capa/:capaId and the answer of every write). */
export async function recordOf(db: Reader, row: CapaRow, context: OfficeContext, now: Date) {
  const actor = actorOf(context)
  const sources = await readSources(db, [row.id])
  const actions = await readActions(db, [row.id])
  const facts = await sourceFactsOf(db, sources)
  const mayNcr = (ncr: { companyId: string; siteId: string }) => can(actor, QUALITY_NCR_VIEW, { companyId: ncr.companyId, siteId: ncr.siteId })
  const mayComplaint = (complaint: { companyId: string; partyId: string }) => can(actor, QUALITY_COMPLAINTS_VIEW, { companyId: complaint.companyId, partyId: complaint.partyId })
  const labels = sourceLabels(facts, mayNcr, mayComplaint)
  const customer = (await customersOf(db, [row])).get(row.customerId ?? '') ?? null
  const summary = capaSummary(row, { sources, actions, customer, labels }, now)

  // D3 and D4, live from the NCRs the reader sees: their containment actions and the cause codes they name.
  const visibleNcrs = [...facts.ncrs.values()].filter(mayNcr)
  const containmentRows = visibleNcrs.length === 0 ? [] : await db.ncrContainmentAction.findMany({ where: { ncrId: { in: visibleNcrs.map((ncr) => ncr.id) } }, select: { ncrId: true, seq: true, kind: true, description: true, status: true, dueAt: true, doneAt: true }, orderBy: [{ ncrId: 'asc' }, { seq: 'asc' }] })
  const activeHolds = visibleNcrs.length === 0 ? [] : await db.qualityHold.groupBy({ by: ['ncrId'], where: { ncrId: { in: visibleNcrs.map((ncr) => ncr.id) }, status: 'ACTIVE' }, _count: { _all: true } })
  const holdsOf = new Map(activeHolds.map((entry) => [entry.ncrId, entry._count._all]))
  const causeIds = [...new Set(visibleNcrs.flatMap((ncr) => (ncr.causeCodeId ? [ncr.causeCodeId] : [])))]
  const causes = causeIds.length === 0 ? [] : await db.causeCode.findMany({ where: { id: { in: causeIds } }, select: { id: true, code: true, labelIt: true, labelEn: true, process: true }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] })
  const documents = await db.generatedDocument.findMany({ where: { recordType: CAPA_RECORD, recordId: row.id, kind: 'EIGHT_D' }, select: { id: true, version: true, language: true, number: true, fileId: true, createdAt: true, createdById: true }, orderBy: { version: 'desc' } })

  const status = row.status as CapaStatus
  const type = row.type as CapaType
  const closing = closeChecks({ type, status, actions: actions.map((action) => ({ status: action.status as 'OPEN' | 'DONE' | 'CANCELLED' })) })
  const manage = mayOn(context, QUALITY_CAPA_MANAGE, row)
  const team = teamOf(row.team)
  return {
    capa: {
      ...summary,
      problem: { what: row.problemWhat, where: row.problemWhere, when: row.problemWhen, howMany: row.problemHowMany },
      closedById: row.closedById,
      closeNote: row.closeNote,
      cancelReason: row.cancelReason,
      createdById: row.createdById,
    },
    sources: sources.map((source) => {
      const ncr = source.recordType === 'Nonconformance' ? facts.ncrs.get(source.recordId) : undefined
      const complaint = source.recordType === 'Complaint' ? facts.complaints.get(source.recordId) : undefined
      const record = ncr && mayNcr(ncr)
        ? { number: ncr.number, title: ncr.title, state: ncr.stage, severity: ncr.severity, category: null, siteId: ncr.siteId, namesThisCapa: ncr.capaId === row.id }
        : complaint && mayComplaint(complaint)
          ? { number: complaint.number, title: complaint.customerRef, state: complaint.status, severity: null, category: complaint.category, siteId: null, namesThisCapa: true }
          : null
      return { id: source.id, recordType: source.recordType as SourceType, recordId: source.recordId, note: source.note, createdAt: iso(source.createdAt)!, createdById: source.createdById, record }
    }),
    containment: visibleNcrs.map((ncr) => ({
      ncrId: ncr.id,
      number: ncr.number,
      stage: ncr.stage,
      activeHolds: holdsOf.get(ncr.id) ?? 0,
      actions: containmentRows.filter((action) => action.ncrId === ncr.id).map((action) => ({ seq: action.seq, kind: action.kind, description: action.description, status: action.status, dueAt: iso(action.dueAt), doneAt: iso(action.doneAt) })),
    })),
    causes: causes.map((cause) => ({ id: cause.id, code: cause.code, labelIt: cause.labelIt, labelEn: cause.labelEn, process: cause.process })),
    actions: await actionViews(db, actions, now),
    documents: documents.map((document) => ({ id: document.id, version: document.version, language: document.language, number: document.number, fileId: document.fileId, createdAt: iso(document.createdAt)!, createdById: document.createdById })),
    next: { stage: isFinal(status) ? null : nextStage(type, status) },
    closing: { checks: closing, ready: !isFinal(status) && allMet(closing) },
    may: { manage, edit: manage && !isFinal(status), close: manage && !isFinal(status) && allMet(closing), report: manage },
    people: await namesOf(db, [row.ownerId, row.closedById, row.createdById, ...team.map((member) => member.userId), ...actions.flatMap((action) => [action.ownerId, action.escalateToId, action.doneById]), ...sources.map((source) => source.createdById), ...documents.map((document) => document.createdById)]),
  }
}
export type CapaRecordView = Awaited<ReturnType<typeof recordOf>>

export async function answerOf(tools: Pick<CommandTools, 'tx' | 'now' | 'context'>, capaId: string) {
  const row = (await readCapa(tools.tx, capaId))!
  return { record: await recordOf(tools.tx, row, contextOf(tools), tools.now) }
}

/** GET /quality/capa/:capaId */
export async function capaRecord(caller: CommandCaller, capaId: string) {
  const { context, capa } = await officeCapa(caller, capaId)
  return { record: await caller.withClient((client) => recordOf(client, capa, context, new Date())) }
}

// ---- inside a command --------------------------------------------------------------------------------------------------

/**
 * The CAPA's row locked FOR UPDATE, open, at the version the caller read (when given), and its version bumped. Answers the
 * row as it is now. `bump: false` for a write that leaves the CAPA as it is (an action's own write): the lock only.
 */
export async function lockCapaRow(tools: CommandTools, capaId: string, options: { readonly version?: number | undefined; readonly bump?: boolean; readonly allowFinal?: boolean } = {}): Promise<CapaRow> {
  const { tx, now } = tools
  const locked = await lockCapa(tx, capaId)
  if (!locked) throw new NotFoundError('CAPA not found.')
  const row = (await readCapa(tx, capaId))!
  if (!options.allowFinal) assertOpen(row)
  if (options.version !== undefined && locked.version !== options.version) throw new StaleVersionError('Capa', capaId, locked.version, options.version)
  if (options.bump === false) return row
  return tx.capa.update({ where: { id: capaId }, data: { version: { increment: 1 }, updatedAt: now }, select: CAPA_COLUMNS })
}

/** The people a CAPA names, checked: ACTIVE office users who see it (quality.capa.view over its scope); the caller is one already. */
export async function peopleProblems(tx: Reader, context: OfficeContext, scope: ScopedRecord, people: readonly { readonly path: string; readonly userId: string | null | undefined }[], now: Date): Promise<Issue[]> {
  const problems: Issue[] = []
  const checked = new Map<string, boolean>()
  for (const person of people) {
    if (!person.userId || person.userId === context.actorId) continue
    if (!checked.has(person.userId)) checked.set(person.userId, await seesCapa(tx, context.tenantId, person.userId, scope, now))
    if (!checked.get(person.userId)) problems.push({ path: person.path, message: 'An active person of the office who sees this CAPA (quality.capa.view over its company).' })
  }
  return problems
}

/** The customer an 8D is written for: a CUSTOMER or BRAND of the company the caller reaches. */
async function customerProblems(tx: Reader, context: OfficeContext, companyId: string, customerId: string | null | undefined): Promise<Issue[]> {
  if (!customerId) return []
  const party = isUuid(customerId) ? await tx.party.findUnique({ where: { id: customerId }, select: { companyId: true, roles: true, status: true } }) : null
  if (!party || (party.companyId !== null && party.companyId !== companyId) || !can(actorOf(context), QUALITY_CAPA_MANAGE, { companyId, partyId: customerId })) return [{ path: 'customerId', message: "Not a customer of the CAPA's company you can see." }]
  if (!party.roles.includes('CUSTOMER') && !party.roles.includes('BRAND')) return [{ path: 'customerId', message: 'An 8D is written for a customer or a brand.' }]
  if (party.status === 'ARCHIVED') return [{ path: 'customerId', message: 'The customer is archived.' }]
  return []
}

/** The owner and the team follow the CAPA (ASSIGNEE): only real office people (a test session's actor is no person). */
async function follow(tools: CommandTools, row: Pick<CapaRow, 'id' | 'companyId'>, userIds: readonly string[], reason: 'ASSIGNEE' | 'CREATOR', by: string | null): Promise<void> {
  for (const userId of [...new Set(userIds)]) {
    if (!isUuid(userId) || !(await tools.tx.user.findUnique({ where: { id: userId }, select: { id: true } }))) continue
    await followInCommand(tools, { type: CAPA_RECORD, id: row.id, companyId: row.companyId, siteId: null }, userId, reason, by)
  }
}

// ---- open ----------------------------------------------------------------------------------------------------------------

/** POST /quality/capa: open a CAPA or an 8D, with the records it comes from escalated to it in the same command. */
export async function openCapa(caller: CommandCaller, body: OpenBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const { result } = await command(caller, { name: 'quality.openCapa', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const today = businessDate(now)
    // The company: named, else the one of the records it comes from.
    let companyId = body.companyId ?? null
    if (!companyId && (body.sources ?? []).length > 0) {
      const first = body.sources![0]!
      const record = first.recordType === 'Nonconformance'
        ? isUuid(first.recordId) ? await tx.nonconformance.findUnique({ where: { id: first.recordId }, select: { companyId: true } }) : null
        : isUuid(first.recordId) ? await tx.complaint.findUnique({ where: { id: first.recordId }, select: { companyId: true } }) : null
      companyId = record?.companyId ?? null
    }
    if (!companyId) refuse([{ path: 'companyId', message: 'Name the company the CAPA is for (or the records it comes from).' }], 'Name the company.')
    const company = isUuid(companyId!) ? await tx.company.findUnique({ where: { id: companyId! }, select: { id: true } }) : null
    if (!company || !can(actor, QUALITY_CAPA_VIEW, { companyId: companyId! })) refuse([{ path: 'companyId', message: 'Not a company you can see.' }], 'The company is not found.')
    const scope: ScopedRecord = { companyId: companyId!, ...(body.customerId ? { partyId: body.customerId } : {}) }
    if (!can(actor, QUALITY_CAPA_MANAGE, { companyId: companyId! })) refuse([{ path: 'companyId', message: 'You open CAPAs only for the companies your role reaches (quality.capa.manage).' }], 'Not your company.')

    const team = cleanTeam(body.team ?? [])
    const problems: Issue[] = [
      ...capaDraftProblems(body, true, today),
      ...teamProblems(team),
      ...(await customerProblems(tx, context, companyId!, body.customerId)),
      ...(await peopleProblems(tx, context, scope, [{ path: 'ownerId', userId: body.ownerId }, ...team.map((member, index) => ({ path: `team/${index}/userId`, userId: member.userId }))], now)),
    ]
    if ((body.sources ?? []).length > CAPA_LIMITS.sources) problems.push({ path: 'sources', message: `At most ${CAPA_LIMITS.sources} records at once.` })
    if (problems.length > 0) refuse(problems, 'The CAPA is not complete.')

    const id = newId()
    const number = (await allocateNumber(tools, { companyId: companyId!, kind: 'CAPA' }, { type: CAPA_RECORD, id })).formatted
    const data: Prisma.CapaUncheckedCreateInput = {
      id,
      companyId: companyId!,
      number,
      type: body.type,
      title: body.title.trim(),
      ownerId: body.ownerId ?? context.actorId,
      team: team as unknown as Prisma.InputJsonValue,
      dueOn: asDay(body.dueOn),
      priority: body.priority ?? 'NORMAL',
      customerId: body.customerId ?? null,
      problemWhat: cleanOrNull(body.problemWhat),
      problemWhere: cleanOrNull(body.problemWhere),
      problemWhen: cleanOrNull(body.problemWhen),
      problemHowMany: cleanOrNull(body.problemHowMany),
      status: firstStage(body.type),
      createdAt: now,
      updatedAt: now,
      createdById: context.actorId,
    }
    const row = await tx.capa.create({ data, select: CAPA_COLUMNS })
    tools.audit({ action: 'quality.openCapa', recordType: CAPA_RECORD, recordId: id, companyId: row.companyId, after: { ...data, dueOn: body.dueOn, createdAt: undefined, updatedAt: undefined } })
    const added = await addSourcesInCommand(tools, row, body.sources ?? [], context)
    tools.emit({ type: 'capa.opened', subject: id, companyId: row.companyId, payload: { capaId: id, number, type: body.type, priority: data.priority as CapaPriority, customerId: data.customerId ?? null, sources: added } })
    await follow(tools, row, [context.actorId], 'CREATOR', context.actorId)
    await follow(tools, row, [row.ownerId, ...team.map((member) => member.userId)].filter((userId) => userId !== context.actorId), 'ASSIGNEE', context.actorId)
    return answerOf(tools, id)
  })
  return result
}

// ---- change ---------------------------------------------------------------------------------------------------------------

/** PATCH /quality/capa/:capaId */
export async function editCapa(caller: CommandCaller, capaId: string, body: EditBody, idempotencyKey?: string) {
  const { context, capa } = await officeCapa(caller, capaId, QUALITY_CAPA_MANAGE)
  assertOpen(capa)
  const { result } = await command(caller, { name: 'quality.editCapa', idempotencyKey, input: { capaId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const before = await lockCapaRow(tools, capaId, { version: body.version, bump: false })
    const team = body.team !== undefined ? cleanTeam(body.team) : undefined
    const customerId = body.customerId !== undefined ? body.customerId : before.customerId
    const scope: ScopedRecord = { companyId: before.companyId, ...(customerId ? { partyId: customerId } : {}) }
    const problems: Issue[] = [
      ...capaDraftProblems(body, false, businessDate(now)),
      ...(team ? teamProblems(team) : []),
      ...(body.customerId !== undefined && body.customerId !== before.customerId ? await customerProblems(tx, context, before.companyId, body.customerId) : []),
      ...(await peopleProblems(
        tx,
        context,
        scope,
        [
          ...(body.ownerId !== undefined && body.ownerId !== before.ownerId ? [{ path: 'ownerId', userId: body.ownerId }] : []),
          ...(team ?? []).filter((member) => !teamOf(before.team).some((old) => old.userId === member.userId)).map((member) => ({ path: `team/${team!.indexOf(member)}/userId`, userId: member.userId })),
        ],
        now,
      )),
    ]
    if (problems.length > 0) refuse(problems, 'The change is not valid.')

    const data: Prisma.CapaUncheckedUpdateInput = {}
    const fields: CapaChangedField[] = []
    const set = <Field extends CapaChangedField>(field: Field, value: unknown, changed: boolean) => {
      if (!changed) return
      ;(data as Record<string, unknown>)[field] = value
      fields.push(field)
    }
    if (body.title !== undefined) set('title', body.title.trim(), body.title.trim() !== before.title)
    if (body.ownerId !== undefined) set('ownerId', body.ownerId, body.ownerId !== before.ownerId)
    if (team) set('team', team as unknown as Prisma.InputJsonValue, JSON.stringify(team) !== JSON.stringify(teamOf(before.team)))
    if (body.dueOn !== undefined) set('dueOn', asDay(body.dueOn), body.dueOn !== dayOf(before.dueOn))
    if (body.priority !== undefined) set('priority', body.priority, body.priority !== before.priority)
    if (body.customerId !== undefined) set('customerId', body.customerId, body.customerId !== before.customerId)
    for (const field of ['problemWhat', 'problemWhere', 'problemWhen', 'problemHowMany'] as const) {
      if (body[field] !== undefined) set(field, cleanOrNull(body[field]), cleanOrNull(body[field]) !== before[field])
    }
    if (fields.length === 0) return answerOf(tools, capaId)
    const row = await tx.capa.update({ where: { id: capaId }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: CAPA_COLUMNS })
    const pick = (source: CapaRow) => Object.fromEntries(fields.map((field) => [field, field === 'dueOn' ? dayOf(source.dueOn) : source[field]]))
    tools.audit({ action: 'quality.editCapa', recordType: CAPA_RECORD, recordId: capaId, companyId: row.companyId, before: pick(before), after: pick(row) })
    tools.emit({ type: 'capa.changed', subject: capaId, companyId: row.companyId, payload: { capaId, number: row.number, fields } })
    const newcomers = [...(fields.includes('ownerId') ? [row.ownerId] : []), ...(team ?? []).map((member) => member.userId).filter((userId) => !teamOf(before.team).some((old) => old.userId === userId))]
    await follow(tools, row, newcomers, 'ASSIGNEE', context.actorId)
    return answerOf(tools, capaId)
  })
  return result
}

// ---- stages, close, cancel ----------------------------------------------------------------------------------------------

/** POST /quality/capa/:capaId/stage {to, version} */
export async function moveCapa(caller: CommandCaller, capaId: string, body: { readonly version: number; readonly to: CapaStatus }, idempotencyKey?: string) {
  const { capa } = await officeCapa(caller, capaId, QUALITY_CAPA_MANAGE)
  const problem = moveProblem(capa.type as CapaType, capa.status as CapaStatus, body.to)
  if (problem) throw isFinal(capa.status as CapaStatus) ? held('FINAL', problem) : refuse([{ path: 'to', message: problem }], problem)
  const { result } = await command(caller, { name: 'quality.moveCapa', idempotencyKey, input: { capaId, ...body } }, async (tools) => {
    const before = await lockCapaRow(tools, capaId, { version: body.version, bump: false })
    const again = moveProblem(before.type as CapaType, before.status as CapaStatus, body.to)
    if (again) refuse([{ path: 'to', message: again }], again)
    const row = await tools.tx.capa.update({ where: { id: capaId }, data: { status: body.to, version: { increment: 1 }, updatedAt: tools.now }, select: CAPA_COLUMNS })
    tools.audit({ action: 'quality.moveCapa', recordType: CAPA_RECORD, recordId: capaId, companyId: row.companyId, before: { status: before.status }, after: { status: row.status } })
    tools.emit({ type: 'capa.stage_changed', subject: capaId, companyId: row.companyId, payload: { capaId, number: row.number, from: before.status as CapaStatus, to: body.to } })
    return answerOf(tools, capaId)
  })
  return result
}

const CLOSE_HELD = { LAST_STAGE: 'NOT_LAST_STAGE', ACTION_DONE: 'NO_ACTION_DONE', NO_OPEN_ACTION: 'ACTIONS_OPEN' } as const

/** POST /quality/capa/:capaId/close {note, version}: the closing words (D8); every check met. */
export async function closeCapa(caller: CommandCaller, capaId: string, body: { readonly version: number; readonly note: string }, idempotencyKey?: string) {
  const { capa } = await officeCapa(caller, capaId, QUALITY_CAPA_MANAGE)
  assertOpen(capa)
  if (!body.note.trim()) refuse([{ path: 'note', message: 'Write the closing words: what was done and how you know it worked.' }], 'Write the closing words.')
  const { result } = await command(caller, { name: 'quality.closeCapa', idempotencyKey, input: { capaId, ...body } }, async (tools) => {
    const { tx, now } = tools
    // The CAPA first (FOR UPDATE), then its actions: an action write in flight holds the CAPA FOR SHARE and finishes first.
    const before = await lockCapaRow(tools, capaId, { version: body.version, bump: false })
    const actions = await readActions(tx, [capaId])
    const checks = closeChecks({ type: before.type as CapaType, status: before.status as CapaStatus, actions: actions.map((action) => ({ status: action.status as 'OPEN' | 'DONE' | 'CANCELLED' })) })
    const failed = checks.filter((check) => !check.ok)
    if (failed.length > 0) throw held(CLOSE_HELD[failed[0]!.key], failed[0]!.words, failed.slice(1).map((check) => ({ path: `held/${CLOSE_HELD[check.key]}`, message: check.words })))
    const context = contextOf(tools)
    const row = await tx.capa.update({ where: { id: capaId }, data: { status: 'CLOSED', closedAt: now, closedById: context.actorId, closeNote: body.note.trim(), version: { increment: 1 }, updatedAt: now }, select: CAPA_COLUMNS })
    tools.audit({ action: 'quality.closeCapa', recordType: CAPA_RECORD, recordId: capaId, companyId: row.companyId, before: { status: before.status }, after: { status: 'CLOSED', closedAt: now.toISOString(), closedById: context.actorId, closeNote: row.closeNote } })
    tools.emit({ type: 'capa.stage_changed', subject: capaId, companyId: row.companyId, payload: { capaId, number: row.number, from: before.status as CapaStatus, to: 'CLOSED' } })
    return answerOf(tools, capaId)
  })
  return result
}

/** POST /quality/capa/:capaId/cancel {reason, version}: raised by mistake. Its open actions' reminder tasks are closed. */
export async function cancelCapa(caller: CommandCaller, capaId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const { capa } = await officeCapa(caller, capaId, QUALITY_CAPA_MANAGE)
  assertOpen(capa)
  if (!body.reason.trim()) refuse([{ path: 'reason', message: 'Say why it is cancelled.' }], 'Say why it is cancelled.')
  const { result } = await command(caller, { name: 'quality.cancelCapa', idempotencyKey, input: { capaId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const before = await lockCapaRow(tools, capaId, { version: body.version, bump: false })
    const actions = await readActions(tx, [capaId])
    // The tasks first: once CANCELLED the CAPA's actions never change, and their reminders mean nothing any more.
    for (const action of actions.filter((entry) => entry.status === 'OPEN')) await closeReminderTasks(tools, before, action, 'CANCELLED')
    const row = await tx.capa.update({ where: { id: capaId }, data: { status: 'CANCELLED', cancelledAt: now, cancelReason: body.reason.trim(), version: { increment: 1 }, updatedAt: now }, select: CAPA_COLUMNS })
    tools.audit({ action: 'quality.cancelCapa', recordType: CAPA_RECORD, recordId: capaId, companyId: row.companyId, before: { status: before.status }, after: { status: 'CANCELLED', cancelReason: row.cancelReason }, reason: row.cancelReason ?? undefined })
    tools.emit({ type: 'capa.stage_changed', subject: capaId, companyId: row.companyId, payload: { capaId, number: row.number, from: before.status as CapaStatus, to: 'CANCELLED' } })
    return answerOf(tools, capaId)
  })
  return result
}

