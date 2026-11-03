import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { PEOPLE_EARNINGS_MANAGE, PEOPLE_EARNINGS_REVIEW, PEOPLE_EARNINGS_VIEW } from '@nexus/factory-domain/people/earnings/permissions'
import { NOT_A_LEAD, NOT_DRAFT, NOT_REVIEW, OWN_FAULT_WORDS, OWN_RECORD, statementStale, type StatementStatus } from '@nexus/factory-domain/people/earnings/rules'
import type { StatementSummary } from '@nexus/factory-domain/people/earnings/statement'
import { openReasonProblems, type OpenReason } from '@nexus/factory-domain/people/privacy/figures'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { fullName, type Client } from '../attendance/store'
import { dayOf, dayOrNull } from '../employees/access'
import { assertPersonDecides } from '../privacy/decide'
import { openPersonFiguresInCommand, personFiguresAccess, requirePersonFigures, type PersonFiguresAccess } from '../privacy/access'
import { hasRight, officeOf, refuseEarnings, requireRight, seesPay } from './access'
import type { OpenStatementBody, VersionBody, LeadReviewBody } from './contract'
import { periodOf } from './periods'
import { leadReviewOf, ledgerSums } from './person'
import { monthOfPeriod, periodById } from './store'

/**
 * Worker statements (B-W2b-43; MES-261; c.c. art. 2101 c.3; design people.piecerates pop-up "Worker statement": "Opening a
 * statement is recorded"). The list of a period names nobody (J / K walks its ids); opening one is ONE command that writes
 * the opening down and answers the statement. Two people open one: HR, with the right (people.earnings.records and the pay
 * grain); and a lead, through the People privacy gate (the site's PERFORMANCE gate, the basis covers leads, the person is in
 * their team): the pieces and minutes, the pay grain drops the money. HR approves while the period is in review, nobody
 * their own.
 */

const STATEMENT_SELECT = { id: true, companyId: true, siteId: true, payPeriodId: true, employeeId: true, revision: true, status: true, summary: true, earningsAmount: true, makeUpAmount: true, currency: true, fileId: true, approvedAt: true, approvedById: true, supersededAt: true, version: true } as const satisfies Prisma.WorkerStatementSelect
type StatementRow = Prisma.WorkerStatementGetPayload<{ select: typeof STATEMENT_SELECT }>

const leadReview = (row: Pick<StatementRow, 'summary'>): { readonly at: string; readonly byName: string | null; readonly note: string | null } | null => leadReviewOf(row.summary) as never

export async function statementOf(caller: CommandCaller, statementId: string): Promise<{ context: OfficeContext; row: StatementRow }> {
  const context = officeOf(caller)
  const row = isUuid(statementId) ? await caller.withClient((db) => db.workerStatement.findUnique({ where: { id: statementId }, select: STATEMENT_SELECT })) : null
  if (!row || !can(actorOf(context), PEOPLE_EARNINGS_VIEW, { companyId: row.companyId, siteId: row.siteId })) throw new NotFoundError('Statement not found.')
  return { context, row }
}

const isStale = (row: StatementRow, sums: ReadonlyMap<string, { earnings: number; makeUp: number }>): boolean => {
  const sum = sums.get(row.employeeId) ?? { earnings: 0, makeUp: 0 }
  return row.earningsAmount !== sum.earnings || row.makeUpAmount !== sum.makeUp
}

/** A period's statements: states only, no name, no figure (J / K walks them). */
export async function listStatements(caller: CommandCaller, periodId: string) {
  const { period } = await periodOf(caller, periodId, PEOPLE_EARNINGS_VIEW)
  return caller.withClient(async (db) => {
    const rows = await db.workerStatement.findMany({ where: { payPeriodId: period.id, status: { not: 'SUPERSEDED' } }, select: STATEMENT_SELECT, orderBy: [{ id: 'asc' }] })
    const sums = await ledgerSums(db, period.id)
    return {
      periodId: period.id,
      month: monthOfPeriod(period),
      statements: rows.map((row) => ({ id: row.id, siteId: row.siteId, status: row.status as StatementStatus, revision: row.revision, leadReviewed: leadReview(row) !== null, stale: period.status === 'REVIEW' && isStale(row, sums), version: row.version })),
      words: ['Statements name nobody here: one statement opens one at a time, and each opening is recorded.'],
    }
  })
}

async function view(db: Client, context: OfficeContext, row: StatementRow, as: 'HR' | 'LEAD') {
  const period = (await periodById(db, row.payPeriodId))!
  const person = (await db.employee.findUnique({ where: { id: row.employeeId }, select: { id: true, firstName: true, lastName: true, employeeCode: true, userId: true } }))!
  const sums = await ledgerSums(db, row.payPeriodId)
  const summary = (row.summary ?? null) as (StatementSummary & { leadReview?: unknown }) | null
  const disputes = await db.labourDispute.findMany({ where: { employeeId: row.employeeId, workDate: { gte: period.periodStart, lte: period.periodEnd } }, select: { id: true, status: true, workDate: true, recordType: true }, orderBy: [{ workDate: 'asc' }, { id: 'asc' }] })
  const money = <T>(value: T) => asMoney('pay', value)
  return {
    id: row.id,
    periodId: row.payPeriodId,
    month: monthOfPeriod(period),
    periodStatus: period.status,
    person: { employeeId: person.id, name: fullName(person), code: person.employeeCode },
    revision: row.revision,
    status: row.status as StatementStatus,
    openedAs: as,
    currency: row.currency,
    lines: (summary?.lines ?? []).map((line) => ({ operationCode: line.operationCode, operationName: line.operationName, pieces: line.pieces, minutes: line.minutes, sharePct: line.sharePct, rate: money(line.rate), amount: money(line.amount) })),
    time: (summary?.time ?? []).map((line) => ({ code: line.code, minutes: line.minutes, rate: money(line.rate), amount: money(line.amount) })),
    corrections: (summary?.corrections ?? []).map((line) => ({ kind: line.kind, month: line.month, words: line.words, amount: money(line.amount) })),
    attendance: summary?.attendance ?? null,
    makeUp: summary?.makeUp ? { minutes: summary.makeUp.minutes, rate: money(summary.makeUp.ratePerMinute), guaranteed: money(summary.makeUp.guaranteed), earned: money(summary.makeUp.earned), amount: money(summary.makeUp.amount) } : null,
    held: summary?.held ?? { open: 0, counted: 0, notPaid: 0 },
    defects: { scrap: summary?.defects.scrap ?? 0, rework: summary?.defects.rework ?? 0, othersScrap: summary?.defects.othersScrap ?? 0, othersRework: summary?.defects.othersRework ?? 0 },
    bonus: summary?.bonus ? { ...summary.bonus, amount: money(summary.bonus.amount) } : null,
    disputes: disputes.map((dispute) => ({ id: dispute.id, status: dispute.status, workDate: dayOf(dispute.workDate), recordType: dispute.recordType })),
    earningsAmount: money(row.earningsAmount),
    makeUpAmount: money(row.makeUpAmount),
    // A preview's period figures are not booked yet: the statement can only be behind the ledger once they are.
    stale: period.status === 'REVIEW' && isStale(row, sums),
    leadReview: leadReview(row),
    fileId: row.fileId,
    approvedAt: row.approvedAt ? toUtcIso(row.approvedAt) : null,
    canApprove: can(actorOf(context), PEOPLE_EARNINGS_MANAGE, { companyId: row.companyId, siteId: row.siteId }) && row.status === 'DRAFT' && period.status === 'REVIEW' && person.userId !== context.actorId,
    version: row.version,
    words: [OWN_FAULT_WORDS, 'Opening a statement is recorded.'],
  }
}

/** "Worker statement": written down and answered in one command. */
export async function openStatement(caller: CommandCaller, statementId: string, body: OpenStatementBody) {
  const { context, row } = await statementOf(caller, statementId)
  const right = hasRight(context, row)
  let access: PersonFiguresAccess | null = null
  if (!right) {
    access = await personFiguresAccess(caller, row.employeeId, 'PERFORMANCE')
    requirePersonFigures(access)
    const problems = openReasonProblems(access.decision, body.reason, body.note)
    if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  }
  // Every opening is a new row of the record: no key, so opening twice is recorded twice.
  const { result } = await command(caller, { name: 'people.openWorkerStatement', input: { statementId, body, at: Date.now() } }, async (tools) => {
    if (access) openPersonFiguresInCommand(tools, access, { reason: body.reason as OpenReason | undefined, note: body.note })
    tools.audit({ action: 'people.openWorkerStatement', recordType: 'WorkerStatement', recordId: row.id, companyId: row.companyId, siteId: row.siteId, after: { employeeId: row.employeeId, periodId: row.payPeriodId, revision: row.revision, as: right ? 'HR' : 'LEAD' } })
    return view(tools.tx, context, row, right ? 'HR' : 'LEAD')
  })
  return result
}

/** HR approves a statement, while the period is in review and only if it still matches the ledger. Never their own. */
export async function approveStatement(caller: CommandCaller, statementId: string, body: VersionBody, idempotencyKey?: string) {
  const { context, row } = await statementOf(caller, statementId)
  if (!can(actorOf(context), PEOPLE_EARNINGS_MANAGE, { companyId: row.companyId, siteId: row.siteId })) throw new ForbiddenError()
  requireRight(context, row)
  const { result } = await command(caller, { name: 'people.approveWorkerStatement', idempotencyKey, input: body, record: { type: 'WorkerStatement', id: row.id, expectedVersion: body.version } }, async (tools) => {
    const actorId = assertPersonDecides(tools.context, 'PAY_STATEMENT_APPROVAL')
    const current = (await tools.tx.workerStatement.findUnique({ where: { id: row.id }, select: STATEMENT_SELECT }))!
    const period = (await periodById(tools.tx, row.payPeriodId))!
    if (current.status !== 'DRAFT') refuseEarnings(NOT_DRAFT)
    if (period.status !== 'REVIEW') refuseEarnings(NOT_REVIEW)
    const owner = await tools.tx.employee.findUnique({ where: { id: row.employeeId }, select: { userId: true } })
    if (owner?.userId === actorId) refuseEarnings(OWN_RECORD)
    if (isStale(current, await ledgerSums(tools.tx, row.payPeriodId))) refuseEarnings(statementStale(1))
    await tools.tx.workerStatement.update({ where: { id: row.id }, data: { status: 'APPROVED', approvedAt: tools.now, approvedById: actorId }, select: { id: true } })
    tools.audit({ action: 'people.approveWorkerStatement', recordType: 'WorkerStatement', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { status: 'DRAFT' }, after: { status: 'APPROVED', revision: row.revision, employeeId: row.employeeId } })
    tools.emit({ type: 'worker_statement.changed', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { statementId: row.id, periodId: row.payPeriodId, siteId: row.siteId, status: 'APPROVED', revision: row.revision, change: 'APPROVED' } })
    return view(tools.tx, context, { ...current, status: 'APPROVED', approvedAt: tools.now, approvedById: actorId }, 'HR')
  })
  return result
}

/**
 * A lead's review (MES-260 "lead and HR review"): the lead of a person's team, where the site's legal basis lets leads see
 * one person's figures, says the pieces and minutes look right. It tells HR; it never stops an approval: with the legal
 * default (leads see nobody's figures) no lead could ever do it, and pay must not wait on that.
 */
export async function leadReviewStatement(caller: CommandCaller, statementId: string, body: LeadReviewBody, idempotencyKey?: string) {
  const { context, row } = await statementOf(caller, statementId)
  if (!can(actorOf(context), PEOPLE_EARNINGS_REVIEW, { companyId: row.companyId, siteId: row.siteId })) throw new ForbiddenError()
  const access = await personFiguresAccess(caller, row.employeeId, 'PERFORMANCE')
  if (!access.decision.allowed || access.decision.as !== 'LEAD') refuseEarnings(NOT_A_LEAD)
  const reviewer = await caller.withClient((db) => db.user.findUnique({ where: { id: context.actorId }, select: { displayName: true } }))
  const { result } = await command(caller, { name: 'people.leadReviewStatement', idempotencyKey, input: body, record: { type: 'WorkerStatement', id: row.id, expectedVersion: body.version } }, async (tools) => {
    const current = (await tools.tx.workerStatement.findUnique({ where: { id: row.id }, select: STATEMENT_SELECT }))!
    const period = (await periodById(tools.tx, row.payPeriodId))!
    if (current.status !== 'DRAFT') refuseEarnings(NOT_DRAFT)
    if (period.status !== 'REVIEW') refuseEarnings(NOT_REVIEW)
    const review = { at: toUtcIso(tools.now), byName: reviewer?.displayName ?? null, note: body.note?.trim() || null }
    const summary = { ...((current.summary ?? {}) as object), leadReview: review }
    await tools.tx.workerStatement.update({ where: { id: row.id }, data: { summary: summary as Prisma.InputJsonValue }, select: { id: true } })
    tools.audit({ action: 'people.leadReviewStatement', recordType: 'WorkerStatement', recordId: row.id, companyId: row.companyId, siteId: row.siteId, after: { leadReviewed: true, employeeId: row.employeeId } })
    tools.emit({ type: 'worker_statement.changed', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { statementId: row.id, periodId: row.payPeriodId, siteId: row.siteId, status: 'DRAFT', revision: row.revision, change: 'LEAD_REVIEWED' } })
    return { id: row.id, status: 'DRAFT' as const, leadReview: review }
  })
  return result
}

/** The employee record's Pay tab: one person's statements. */
export async function statementsOfEmployee(caller: CommandCaller, employeeId: string) {
  const context = officeOf(caller)
  const person = isUuid(employeeId) ? await caller.withClient((db) => db.employee.findUnique({ where: { id: employeeId }, select: { id: true, companyId: true, siteId: true } })) : null
  if (!person) throw new NotFoundError('Person not found.')
  requireRight(context, person)
  return caller.withClient(async (db) => {
    const rows = await db.workerStatement.findMany({ where: { employeeId, status: { not: 'SUPERSEDED' } }, select: { ...STATEMENT_SELECT, payPeriod: { select: { periodStart: true, status: true } } }, orderBy: [{ payPeriod: { periodStart: 'desc' } }] })
    return {
      employeeId,
      payShown: seesPay(context),
      statements: rows.map((row) => ({ id: row.id, month: monthOfPeriod(row.payPeriod), periodStatus: row.payPeriod.status, status: row.status as StatementStatus, revision: row.revision, currency: row.currency, earningsAmount: asMoney('pay', row.earningsAmount), makeUpAmount: asMoney('pay', row.makeUpAmount), approvedOn: row.approvedAt ? dayOrNull(row.approvedAt) : null })),
    }
  })
}

