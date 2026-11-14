import type { Prisma } from '@nexus/factory-db'
import { ConflictError, DomainError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import type { IssueProblem } from '@nexus/factory-domain/invoicing/checks'
import { INVOICES_ISSUE, INVOICES_MANAGE, INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { monthOfDay, monthStartOf, pickProblems, runIssuePlan, runMonthProblem, runWords, type RunStatus } from '@nexus/factory-domain/invoicing/runs/runs'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import type { FilesRuntime } from '../../../platform/files/service'
import { draftFromDdtsInCommand, draftPlanOf } from '../from-shipment/draft'
import { deferredDue } from '../from-shipment/deferred'
import { readDdts } from '../from-shipment/store'
import { filesAfterIssue, issueChecks, issueInCommand } from '../issue'
import { sendToSdi } from '../sdi/send'
import type { SdiRuntime } from '../sdi/runtime'
import { mayOn, officeContextOf, type Reader } from '../store'
import { refusingInWords } from '../tax-codes/store'

/**
 * The monthly invoice run (B-W2b-396; FIN-068 "Monthly invoice run"; design finance.invoices ⋯ "Monthly invoice run":
 * customers with deferred invoicing, a preview per customer, a CheckList per invoice, "Issue and send n invoices"):
 *
 *   GET    /invoicing/runs                       the runs the caller may see (company, month, status)
 *   GET    /invoicing/runs/candidates            a company's customers whose DDTs of the month take a deferred invoice
 *                                                (W2a's deferred list: monthly customers, or several DDTs / past 12 days)
 *   POST   /invoicing/runs                       a PREVIEW run of a company and month with the customers picked: the run,
 *                                                then each customer's TD24 of the month's DDTs still to invoice (W2a's
 *                                                deferred draft: goods, freight, fees, deposits, terms) naming the run, one
 *                                                command per customer (a customer with nothing to invoice is answered with
 *                                                why, and stays picked)
 *   GET    /invoicing/runs/:runId                the run: each customer's draft with its checks (the CheckList)
 *   PUT    /invoicing/runs/:runId/customers      pick again: the drafts of customers left out are deleted, new ones made
 *   POST   /invoicing/runs/:runId/issue          (invoices.issue, step-up) every draft whose checks pass is issued, its
 *                                                files made and sent to SDI (test mode while the company is in it); a
 *                                                draft that does not pass is let go from the run (it stays a draft); then
 *                                                the run is ISSUED (frozen). Each invoice is its own command (a refusal or a
 *                                                failed send never undoes the others); issuing again finishes a run left
 *                                                half done
 *   DELETE /invoicing/runs/:runId                a PREVIEW with nothing issued: its drafts and the run
 * The customers' and the run's commands guard the run's version (one writer at a time); the database holds the rest (a
 * run picks 1–1000 parties, a draft names only a PREVIEW run that picks its customer, ISSUED only with no draft left, an
 * issued run is never changed or deleted). A customer is in one live preview of a month at a time.
 */

const RUN_COLUMNS = { id: true, companyId: true, month: true, partyIds: true, status: true, issuedAt: true, issuedById: true, version: true, createdAt: true } as const satisfies Prisma.InvoiceRunSelect
type RunRow = Prisma.InvoiceRunGetPayload<{ select: typeof RUN_COLUMNS }>

/** The scope columns of a run: its company. */
const RUN_SCOPE = { company: 'companyId' } as const

const monthOf = (row: Pick<RunRow, 'month'>): string => monthOfDay(row.month.toISOString().slice(0, 10))
const mayCompany = (context: OfficeContext, permission: Permission, companyId: string): boolean => can(actorOf(context), permission, { companyId })

function assertCompany(context: OfficeContext, permission: Permission, companyId: string): void {
  if (!mayCompany(context, INVOICES_VIEW, companyId)) throw new NotFoundError('Company not found.')
  if (!mayCompany(context, permission, companyId)) throw new DomainError('forbidden', 'You may not do this for invoices of this company.')
}

async function readRun(db: Reader, runId: string): Promise<RunRow | null> {
  return isUuid(runId) ? db.invoiceRun.findUnique({ where: { id: runId }, select: RUN_COLUMNS }) : null
}

/** The run the caller may see (else 404) and act on with `permission` over its company (else 403). */
async function officeRun(caller: CommandCaller, runId: string, permission: Permission = INVOICES_VIEW): Promise<{ context: OfficeContext; run: RunRow }> {
  const context = officeContextOf(caller)
  const run = await caller.withClient((client) => readRun(client, runId))
  if (!run || !mayCompany(context, INVOICES_VIEW, run.companyId)) throw new NotFoundError('Invoice run not found.')
  if (!mayCompany(context, permission, run.companyId)) throw new DomainError('forbidden', 'You may not do this for invoices of this company.')
  return { context, run }
}

/** Every customer picked must be one the caller may invoice (else 404 in words, naming the customer's place in the list). */
function assertCustomers(context: OfficeContext, companyId: string, partyIds: readonly string[], permission: Permission): void {
  const issues = pickProblems(partyIds)
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  partyIds.forEach((partyId, index) => {
    if (!mayOn(context, INVOICES_VIEW, { companyId, partyId })) throw new ValidationError('Not a customer of this company you may invoice.', [{ path: `body/partyIds/${index}`, message: 'Not a customer you may invoice.' }])
    if (!mayOn(context, permission, { companyId, partyId })) throw new DomainError('forbidden', 'You may not invoice one of these customers.', [{ path: `body/partyIds/${index}`, message: 'Not yours to invoice.' }])
  })
}

/** The customers another live preview of the month picks already (it would find their DDTs held by its drafts). */
async function pickedElsewhere(db: Reader, run: { readonly id: string | null; readonly companyId: string; readonly month: string }, partyIds: readonly string[]): Promise<string[]> {
  const others = await db.invoiceRun.findMany({ where: { companyId: run.companyId, month: new Date(`${monthStartOf(run.month)}T00:00:00.000Z`), status: 'PREVIEW', partyIds: { hasSome: [...partyIds] }, ...(run.id ? { id: { not: run.id } } : {}) }, select: { partyIds: true } })
  return partyIds.filter((partyId) => others.some((other) => other.partyIds.includes(partyId)))
}

// ---- reads ----------------------------------------------------------------------------------------------------------

async function runViewOf(caller: CommandCaller, context: OfficeContext, run: RunRow) {
  const { parties, invoices } = await caller.withClient(async (client) => ({
    parties: await client.party.findMany({ where: { id: { in: run.partyIds } }, select: { id: true, code: true, legalName: true } }),
    invoices: await client.invoice.findMany({ where: { invoiceRunId: run.id }, select: { id: true, version: true, buyerPartyId: true, docType: true, status: true, number: true, currency: true, netTotal: true, grossTotal: true, lines: { where: { ddtId: { not: null } }, select: { ddtId: true } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
  }))
  const checked = new Map<string, IssueProblem[]>()
  for (const invoice of invoices.filter((row) => row.status === 'DRAFT')) checked.set(invoice.id, mayOn(context, INVOICES_VIEW, { companyId: run.companyId, partyId: invoice.buyerPartyId }) ? (await issueChecks(caller, invoice.id)).problems : [])
  const customers = run.partyIds.map((partyId) => {
    const party = parties.find((row) => row.id === partyId)
    const invoice = invoices.find((row) => row.buyerPartyId === partyId)
    const problems = invoice ? (checked.get(invoice.id) ?? []) : []
    return {
      partyId,
      code: party?.code ?? '',
      legalName: party?.legalName ?? '',
      invoice: invoice
        ? {
            id: invoice.id,
            version: invoice.version,
            docType: invoice.docType,
            status: invoice.status,
            number: invoice.number,
            currency: invoice.currency,
            ddts: new Set(invoice.lines.map((line) => line.ddtId)).size,
            netTotal: asMoney('price', invoice.netTotal),
            grossTotal: asMoney('price', invoice.grossTotal),
            ready: invoice.status === 'DRAFT' && problems.length === 0,
            problems,
          }
        : null,
      words: invoice
        ? invoice.status === 'DRAFT'
          ? problems.length === 0
            ? 'Ready to issue.'
            : `${problems.length} thing${problems.length === 1 ? '' : 's'} to fix before it is issued: ${problems[0]!.message}`
          : `Issued as ${invoice.number}.`
        : run.status === 'ISSUED'
          ? 'No invoice in this run (left out, or nothing to invoice).'
          : 'No deferred invoice: nothing of this month waits to be invoiced, or its draft was let go.',
    }
  })
  const drafts = invoices.filter((row) => row.status === 'DRAFT')
  const counts = { customers: run.partyIds.length, drafts: drafts.length, ready: drafts.filter((row) => (checked.get(row.id) ?? []).length === 0).length, issued: invoices.length - drafts.length }
  const preview = run.status === 'PREVIEW'
  return {
    id: run.id,
    version: run.version,
    companyId: run.companyId,
    month: monthOf(run),
    status: run.status as RunStatus,
    issuedAt: run.issuedAt ? toUtcIso(run.issuedAt) : null,
    issuedById: run.issuedById,
    createdAt: toUtcIso(run.createdAt),
    customers,
    counts,
    words: runWords(run.status as RunStatus, monthOf(run), counts),
    can: {
      pick: preview && mayCompany(context, INVOICES_MANAGE, run.companyId),
      issue: preview && mayCompany(context, INVOICES_ISSUE, run.companyId),
      delete: preview && counts.issued === 0 && mayCompany(context, INVOICES_MANAGE, run.companyId),
    },
  }
}

/** GET /invoicing/runs. */
export async function listRuns(caller: CommandCaller, query: { companyId?: string | undefined; month?: string | undefined; status?: RunStatus | undefined }) {
  const context = officeContextOf(caller)
  const where: Prisma.InvoiceRunWhereInput = {
    AND: [
      scopeWhere(actorOf(context), INVOICES_VIEW, RUN_SCOPE) as Prisma.InvoiceRunWhereInput,
      query.companyId ? { companyId: query.companyId } : {},
      query.month ? { month: new Date(`${monthStartOf(query.month)}T00:00:00.000Z`) } : {},
      query.status ? { status: query.status } : {},
    ],
  }
  return caller.withClient(async (client) => {
    const rows = await client.invoiceRun.findMany({ where, select: { ...RUN_COLUMNS, _count: { select: { invoices: true } } }, orderBy: [{ month: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }], take: 200 })
    return { runs: rows.map((row) => ({ id: row.id, version: row.version, companyId: row.companyId, month: monthOf(row), status: row.status as RunStatus, customers: row.partyIds.length, invoices: row._count.invoices, issuedAt: row.issuedAt ? toUtcIso(row.issuedAt) : null, createdAt: toUtcIso(row.createdAt) })) }
  })
}

/** GET /invoicing/runs/candidates: the company's customers whose DDTs of the month take a deferred invoice. */
export async function runCandidates(caller: CommandCaller, query: { companyId: string; month: string }) {
  const context = officeContextOf(caller)
  assertCompany(context, INVOICES_VIEW, query.companyId)
  const due = await deferredDue(caller, { companyId: query.companyId })
  const groups = due.groups.filter((group) => group.companyId === query.companyId && group.month === query.month)
  const elsewhere = await caller.withClient((client) =>
    client.invoiceRun.findMany({ where: { companyId: query.companyId, month: new Date(`${monthStartOf(query.month)}T00:00:00.000Z`), status: 'PREVIEW', partyIds: { hasSome: groups.map((group) => group.partyId) } }, select: { id: true, partyIds: true } }),
  )
  return {
    asOf: due.asOf,
    companyId: query.companyId,
    month: query.month,
    customers: groups.map((group) => ({
      partyId: group.partyId,
      code: group.code,
      legalName: group.legalName,
      invoiceTiming: group.invoiceTiming,
      ddts: group.ddts.length,
      valueAmount: group.valueAmount,
      freightAmount: group.freightAmount,
      drafts: group.drafts,
      deadline: group.deadline,
      words: group.words,
      inRunId: elsewhere.find((run) => run.partyIds.includes(group.partyId))?.id ?? null,
    })),
  }
}

/** GET /invoicing/runs/:runId. */
export async function getRun(caller: CommandCaller, runId: string) {
  const { context, run } = await officeRun(caller, runId)
  return { run: await runViewOf(caller, context, run) }
}

// ---- writes ---------------------------------------------------------------------------------------------------------

const monthRange = (month: string): { gte: Date; lt: Date } => {
  const start = new Date(`${monthStartOf(month)}T00:00:00.000Z`)
  const end = new Date(start)
  end.setUTCMonth(end.getUTCMonth() + 1)
  return { gte: start, lt: end }
}

/**
 * One customer's deferred invoice of the month in the run (its own command, on the run: its version bump keeps the run a
 * PREVIEW that picks the customer while the draft is made). Returns why when none is made.
 */
async function draftForCustomer(caller: CommandCaller, run: { readonly id: string; readonly companyId: string; readonly month: string }, partyId: string): Promise<string | null> {
  const where = { companyId: run.companyId, partyId, documentDate: monthRange(run.month), cancellations: { none: {} }, shipment: { status: { in: ['SHIPPED' as const, 'DELIVERED' as const] } } }
  const ddts = await caller.withClient((client) => readDdts(client, where, 500))
  if (ddts.length === 0) return `No DDT of ${run.month} of this customer waits for an invoice (shipped, not cancelled).`
  const scope = { companyId: run.companyId, partyId }
  try {
    const plan = await draftPlanOf(caller, scope)
    const ids = ddts.map((ddt) => ddt.id)
    await refusingInWords(() =>
      command(caller, { name: 'invoices.runDraft', input: { runId: run.id, partyId }, record: { type: 'InvoiceRun', id: run.id } }, async (tools) => {
        const current = (await tools.tx.invoiceRun.findUnique({ where: { id: run.id }, select: { status: true, partyIds: true } }))!
        if (current.status !== 'PREVIEW' || !current.partyIds.includes(partyId)) throw new ConflictError('The run changed meanwhile: read it again.')
        const answer = await draftFromDdtsInCommand(tools, scope, ids, { ddtIds: ids, docType: 'TD24' }, plan, 'invoices.runDraft')
        await tools.tx.invoice.update({ where: { id: answer.invoice.id }, data: { invoiceRunId: run.id }, select: { id: true } })
        tools.audit({ action: 'invoices.runDraft', recordType: 'InvoiceRun', recordId: run.id, companyId: run.companyId, after: { partyId, invoiceId: answer.invoice.id, ddts: ids.length } })
        return { invoiceId: answer.invoice.id }
      }),
    )
    return null
  } catch (error) {
    if (error instanceof DomainError && error.code !== 'forbidden' && error.code !== 'unauthenticated') return error.message
    throw error
  }
}

async function draftsFor(caller: CommandCaller, run: { readonly id: string; readonly companyId: string; readonly month: string }, partyIds: readonly string[]): Promise<{ partyId: string; reason: string }[]> {
  const skipped: { partyId: string; reason: string }[] = []
  for (const partyId of partyIds) {
    const reason = await draftForCustomer(caller, run, partyId)
    if (reason) skipped.push({ partyId, reason })
  }
  return skipped
}

/** POST /invoicing/runs (invoices.manage over the company and each customer). */
export async function createRun(caller: CommandCaller, body: { companyId: string; month: string; partyIds: string[] }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  assertCompany(context, INVOICES_MANAGE, body.companyId)
  const today = businessDate(serverClock.now())
  const problem = runMonthProblem(body.month, today)
  if (problem) throw new ValidationError(problem.message, [problem])
  assertCustomers(context, body.companyId, body.partyIds, INVOICES_MANAGE)
  const busy = await caller.withClient((client) => pickedElsewhere(client, { id: null, companyId: body.companyId, month: body.month }, body.partyIds))
  if (busy.length > 0) throw new DomainError('conflict', `${busy.length} of these customers ${busy.length === 1 ? 'is' : 'are'} in another preview of ${body.month} already: issue or change that run first.`, busy.map((partyId) => ({ path: `body/partyIds/${body.partyIds.indexOf(partyId)}`, message: 'In another preview of this month.' })))
  const id = newId()
  await refusingInWords(() =>
    command(caller, { name: 'invoices.createRun', idempotencyKey, input: body }, async (tools) => {
      if (!(await tools.tx.company.findUnique({ where: { id: body.companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
      const found = await tools.tx.party.count({ where: { id: { in: body.partyIds } } })
      if (found !== body.partyIds.length) throw new ValidationError('Not a customer you may invoice.', [{ path: 'body/partyIds', message: 'Customers of this tenant.' }])
      await tools.tx.invoiceRun.create({ data: { id, companyId: body.companyId, month: new Date(`${monthStartOf(body.month)}T00:00:00.000Z`), partyIds: body.partyIds, status: 'PREVIEW', createdById: context.actorId }, select: { id: true } })
      tools.audit({ action: 'invoices.createRun', recordType: 'InvoiceRun', recordId: id, companyId: body.companyId, after: { month: body.month, partyIds: body.partyIds, status: 'PREVIEW' } })
      return { id }
    }),
  )
  const skipped = await draftsFor(caller, { id, companyId: body.companyId, month: body.month }, body.partyIds)
  await announce(caller, (await caller.withClient((client) => readRun(client, id)))!, 'CREATED')
  return { run: await runViewOf(caller, context, (await caller.withClient((client) => readRun(client, id)))!), skipped }
}

/** The run's event, in a command of its own on the run (after the customers' drafts, with how many invoices it holds). */
async function announce(caller: CommandCaller, run: RunRow, action: 'CREATED' | 'PICKED'): Promise<void> {
  await command(caller, { name: 'invoices.runChanged', input: { runId: run.id, action }, record: { type: 'InvoiceRun', id: run.id } }, async (tools) => {
    const invoices = await tools.tx.invoice.count({ where: { invoiceRunId: run.id } })
    tools.audit({ action: 'invoices.runChanged', recordType: 'InvoiceRun', recordId: run.id, companyId: run.companyId, after: { action, invoices } })
    tools.emit({ type: 'invoice_run.changed', subject: run.id, companyId: run.companyId, payload: { invoiceRunId: run.id, companyId: run.companyId, month: monthOf(run), action, invoices } })
    return { invoices }
  })
}

/** Deletes a run's drafts of these customers (or every draft), inside a command on the run. Returns how many. */
async function deleteDrafts(tools: CommandTools, runId: string, partyIds: readonly string[] | null): Promise<number> {
  const drafts = await tools.tx.invoice.findMany({ where: { invoiceRunId: runId, status: 'DRAFT', ...(partyIds ? { buyerPartyId: { in: [...partyIds] } } : {}) }, select: { id: true, docType: true, companyId: true, buyerPartyId: true } })
  for (const draft of drafts) {
    await tools.tx.invoiceLine.deleteMany({ where: { invoiceId: draft.id } })
    await tools.tx.invoice.delete({ where: { id: draft.id }, select: { id: true } })
    tools.audit({ action: 'invoices.deleteDraft', recordType: 'Invoice', recordId: draft.id, companyId: draft.companyId, before: { docType: draft.docType, status: 'DRAFT', buyerPartyId: draft.buyerPartyId, invoiceRunId: runId } })
    tools.emit({ type: 'invoice.draft_deleted', subject: draft.id, companyId: draft.companyId, payload: { invoiceId: draft.id, docType: draft.docType } })
  }
  return drafts.length
}

/** PUT /invoicing/runs/:runId/customers (invoices.manage): pick again. */
export async function pickRun(caller: CommandCaller, runId: string, body: { version: number; partyIds: string[] }, idempotencyKey?: string) {
  const { context, run } = await officeRun(caller, runId, INVOICES_MANAGE)
  if (run.status !== 'PREVIEW') throw new InvalidStateError(`The run of ${monthOf(run)} is issued: it changes no more.`)
  assertCustomers(context, run.companyId, body.partyIds, INVOICES_MANAGE)
  const removed = run.partyIds.filter((partyId) => !body.partyIds.includes(partyId))
  removed.forEach((partyId) => {
    if (!mayOn(context, INVOICES_MANAGE, { companyId: run.companyId, partyId })) throw new DomainError('forbidden', 'You may not take out a customer you may not invoice.')
  })
  const busy = await caller.withClient((client) => pickedElsewhere(client, { id: run.id, companyId: run.companyId, month: monthOf(run) }, body.partyIds))
  if (busy.length > 0) throw new ConflictError(`${busy.length} of these customers ${busy.length === 1 ? 'is' : 'are'} in another preview of ${monthOf(run)} already.`)
  await refusingInWords(() =>
    command(caller, { name: 'invoices.pickRun', idempotencyKey, input: { runId, ...body }, record: { type: 'InvoiceRun', id: run.id, expectedVersion: body.version } }, async (tools) => {
      const current = (await tools.tx.invoiceRun.findUnique({ where: { id: run.id }, select: { status: true } }))!
      if (current.status !== 'PREVIEW') throw new InvalidStateError('The run is issued: it changes no more.')
      const issued = removed.length > 0 ? await tools.tx.invoice.count({ where: { invoiceRunId: run.id, status: { not: 'DRAFT' }, buyerPartyId: { in: removed } } }) : 0
      if (issued > 0) throw new ConflictError('A customer taken out has an invoice issued in this run already: it stays in the run.')
      const deleted = await deleteDrafts(tools, run.id, removed)
      await tools.tx.invoiceRun.update({ where: { id: run.id }, data: { partyIds: body.partyIds, updatedAt: tools.now }, select: { id: true } })
      tools.audit({ action: 'invoices.pickRun', recordType: 'InvoiceRun', recordId: run.id, companyId: run.companyId, before: { partyIds: run.partyIds }, after: { partyIds: body.partyIds, removed, draftsDeleted: deleted } })
      return { deleted }
    }),
  )
  const added = body.partyIds.filter((partyId) => !run.partyIds.includes(partyId))
  const skipped = await draftsFor(caller, { id: run.id, companyId: run.companyId, month: monthOf(run) }, added)
  const fresh = (await caller.withClient((client) => readRun(client, run.id)))!
  await announce(caller, fresh, 'PICKED')
  return { run: await runViewOf(caller, context, (await caller.withClient((client) => readRun(client, run.id)))!), skipped, removed }
}

/** POST /invoicing/runs/:runId/issue (invoices.issue, step-up): issue and send what passes, let go the rest, then ISSUED. */
export async function issueRun(files: FilesRuntime, sdi: () => SdiRuntime, caller: CommandCaller, runId: string, body: { version?: number | undefined; send?: boolean | undefined }, stepUp: () => void) {
  const { context, run } = await officeRun(caller, runId, INVOICES_ISSUE)
  stepUp()
  if (run.status !== 'PREVIEW') throw new InvalidStateError(`The run of ${monthOf(run)} is issued already.`)
  if (body.version !== undefined && body.version !== run.version) throw new DomainError('conflict', `This invoice run changed since it was read (version ${body.version}); it is now at version ${run.version}. Reload it and issue it again.`, [{ path: 'version', message: `The current version is ${run.version}.` }])
  const drafts = await caller.withClient((client) => client.invoice.findMany({ where: { invoiceRunId: run.id, status: 'DRAFT' }, select: { id: true, buyerPartyId: true, status: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))
  drafts.forEach((draft) => {
    if (!mayOn(context, INVOICES_ISSUE, { companyId: run.companyId, partyId: draft.buyerPartyId })) throw new DomainError('forbidden', 'The run holds an invoice of a customer you may not issue invoices to.')
  })
  const facts = []
  for (const draft of drafts) facts.push({ invoiceId: draft.id, partyId: draft.buyerPartyId, status: draft.status, problems: (await issueChecks(caller, draft.id)).problems })
  const plan = runIssuePlan(facts)
  const held = [...plan.held]
  const issued: { invoiceId: string; number: string; filesPending: boolean; sent: boolean; sendProblem: string | null }[] = []
  for (const ready of plan.ready) {
    try {
      const { result } = await command(caller, { name: 'invoices.issue', input: { invoiceId: ready.invoiceId, runId: run.id }, record: { type: 'Invoice', id: ready.invoiceId } }, (tools) => issueInCommand(tools, ready.invoiceId))
      const outcome = await filesAfterIssue(files, caller, ready.invoiceId)
      let sent = false
      let sendProblem: string | null = null
      if (body.send !== false) {
        try {
          await sendToSdi(files, sdi(), caller, ready.invoiceId, {}, undefined, () => undefined)
          sent = true
        } catch (error) {
          sendProblem = error instanceof DomainError ? error.message : 'The send to SDI did not start: send it from the invoice.'
        }
      }
      issued.push({ invoiceId: ready.invoiceId, number: result.number, filesPending: outcome.filesPending, sent, sendProblem })
    } catch (error) {
      if (!(error instanceof DomainError)) throw error
      held.push({ ...ready, problems: error.issues?.length ? error.issues.map((issue) => ({ code: 'ISSUE', path: issue.path, message: issue.message })) : [{ code: 'ISSUE', path: 'invoice', message: error.message }] })
    }
  }
  await refusingInWords(() =>
    command(caller, { name: 'invoices.issueRun', input: { runId, ...body }, record: { type: 'InvoiceRun', id: run.id } }, async (tools) => {
      const letGo = held.map((entry) => entry.invoiceId)
      if (letGo.length > 0) await tools.tx.invoice.updateMany({ where: { id: { in: letGo }, invoiceRunId: run.id, status: 'DRAFT' }, data: { invoiceRunId: null } })
      const left = await tools.tx.invoice.count({ where: { invoiceRunId: run.id, status: 'DRAFT' } })
      if (left > 0) throw new ConflictError('A draft was added to the run meanwhile: read the run and issue it again.')
      await tools.tx.invoiceRun.update({ where: { id: run.id }, data: { status: 'ISSUED', issuedAt: tools.now, issuedById: context.actorId, updatedAt: tools.now }, select: { id: true } })
      tools.audit({ action: 'invoices.issueRun', recordType: 'InvoiceRun', recordId: run.id, companyId: run.companyId, before: { status: 'PREVIEW' }, after: { status: 'ISSUED', issued: issued.map((entry) => entry.number), letGo, sent: issued.filter((entry) => entry.sent).length } })
      tools.emit({ type: 'invoice_run.changed', subject: run.id, companyId: run.companyId, payload: { invoiceRunId: run.id, companyId: run.companyId, month: monthOf(run), action: 'ISSUED', invoices: await tools.tx.invoice.count({ where: { invoiceRunId: run.id } }) } })
      return { letGo: letGo.length }
    }),
  )
  const fresh = (await caller.withClient((client) => readRun(client, run.id)))!
  return { run: await runViewOf(caller, context, fresh), issued, held: held.map((entry) => ({ invoiceId: entry.invoiceId, partyId: entry.partyId, problems: [...entry.problems] })) }
}

/** DELETE /invoicing/runs/:runId (invoices.manage): a preview with nothing issued, with its drafts. */
export async function deleteRun(caller: CommandCaller, runId: string, query: { version?: number | undefined }, idempotencyKey?: string) {
  const { context, run } = await officeRun(caller, runId, INVOICES_MANAGE)
  if (run.status !== 'PREVIEW') throw new InvalidStateError(`The run of ${monthOf(run)} is issued: it is kept.`)
  const holders = await caller.withClient((client) => client.invoice.findMany({ where: { invoiceRunId: run.id }, select: { buyerPartyId: true } }))
  holders.forEach((holder) => {
    if (!mayOn(context, INVOICES_MANAGE, { companyId: run.companyId, partyId: holder.buyerPartyId })) throw new DomainError('forbidden', 'The run holds a draft of a customer you may not invoice.')
  })
  const { result } = await refusingInWords(() =>
    command(caller, { name: 'invoices.deleteRun', idempotencyKey, input: { runId, ...query }, record: { type: 'InvoiceRun', id: run.id, ...(query.version === undefined ? {} : { expectedVersion: query.version }) } }, async (tools) => {
      const issued = await tools.tx.invoice.count({ where: { invoiceRunId: run.id, status: { not: 'DRAFT' } } })
      if (issued > 0) throw new ConflictError(`The run issued ${issued} invoice${issued === 1 ? '' : 's'} already: issue it to finish it instead.`)
      const drafts = await deleteDrafts(tools, run.id, null)
      await tools.tx.invoiceRun.delete({ where: { id: run.id }, select: { id: true } })
      tools.audit({ action: 'invoices.deleteRun', recordType: 'InvoiceRun', recordId: run.id, companyId: run.companyId, before: { month: monthOf(run), partyIds: run.partyIds, status: 'PREVIEW' }, after: { draftsDeleted: drafts } })
      tools.emit({ type: 'invoice_run.changed', subject: run.id, companyId: run.companyId, payload: { invoiceRunId: run.id, companyId: run.companyId, month: monthOf(run), action: 'DELETED', invoices: 0 } })
      return { drafts }
    }),
  )
  return { deleted: true as const, id: run.id, drafts: result.drafts }
}
