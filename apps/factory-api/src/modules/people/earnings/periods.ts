import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { PEOPLE_EARNINGS_MANAGE, PEOPLE_EARNINGS_VIEW } from '@nexus/factory-domain/people/earnings/permissions'
import { checksOpen, lockPhrase, moveRefusal, notOver, paysOn, periodChecks, statementsOpen, statementStale, wrongPhrase, type EarningsRefusal, type PeriodCheck, type PeriodFacts, type PayWindow } from '@nexus/factory-domain/people/earnings/rules'
import { TOO_FEW_WORDS, groupShown } from '@nexus/factory-domain/people/privacy/groups'
import { monthPeriod } from '@nexus/factory-domain/people/overtime/timesheets'
import { eachDay } from '@nexus/factory-domain/calendars/dates'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { lockPerson } from '../attendance/compute'
import { personOf, type Client } from '../attendance/store'
import { actorIdOf, assertVersion, dayOf, todayOf } from '../employees/access'
import { assertPersonDecides } from '../privacy/decide'
import { minimumGroupSizeFor } from '../privacy/groups'
import { lineRows } from '../reports/earnings/report'
import { officeOf, refuseEarnings, seesPay, tenantOf } from './access'
import type { CreatePeriodBody, LockBody, PeriodsQuery, ReasonVersionBody, VersionBody } from './contract'
import { ledgerSums, syncPersonInCommand } from './person'
import { monthOfPeriod, PayFacts, periodById, periodOfMonth, periodStatus, PERIOD_SELECT, type PeriodRecord } from './store'
import { placeOf } from './ledger'

/**
 * Pay periods (B-W2b-43; MES-260 "monthly run with a preview per worker, lead and HR review, then lock"; design
 * people.piecerates "Pay periods", pop-up "Lock period"; c.c. art. 2101 c.3). A period is one company's month. Each step is a
 * person's, under people.earnings.manage with a grant over every site of the company (a period pays at all of them).
 *
 *   run           OPEN | PREVIEW → PREVIEW: the scans put right, every person's figures computed, a DRAFT statement each.
 *                 Nothing but scans is booked. Any time: a month not over gives a preview of the days so far.
 *   review        PREVIEW → REVIEW: once the month is over and nothing blocks it (`periodChecks`), the run again, and now
 *                 team shares, paid time and make-up are booked. Statements are approved in review.
 *   back          REVIEW → PREVIEW with why (a mistake found): run again; what moved is reversed, never edited.
 *   lock          REVIEW → LOCKED, typed, by a person (PAY_PERIOD_LOCK): every statement approved and matching the ledger.
 *                 The database refuses a held scan, a DRAFT statement or a person paid without an approved one (again).
 * One command per person (their lock, a short transaction), then one for the period: a run stopped half way is simply run
 * again, nothing is paid twice.
 */

const COMPANY_SCOPE = { company: 'companyId' } as const

/** A period is the company's: changing it needs a grant over every site of the company. */
async function mayChange(db: Client, context: OfficeContext, permission: Permission, companyId: string): Promise<boolean> {
  const actor = actorOf(context)
  if (!can(actor, permission, { companyId })) return false
  const sites = await db.site.findMany({ where: { companyId }, select: { id: true } })
  return sites.every((site) => can(actor, permission, { companyId, siteId: site.id }))
}

/** The period, when the caller may see it (else 404) and do `permission` on it (else 403). */
export async function periodOf(caller: CommandCaller, periodId: string, permission: Permission): Promise<{ context: OfficeContext; period: PeriodRecord }> {
  const context = officeOf(caller)
  const found = await caller.withClient(async (db) => {
    const period = await periodById(db, periodId)
    if (!period || !can(actorOf(context), PEOPLE_EARNINGS_VIEW, { companyId: period.companyId })) return null
    return { period, allowed: permission === PEOPLE_EARNINGS_VIEW || (await mayChange(db, context, permission, period.companyId)) }
  })
  if (!found) throw new NotFoundError('Pay period not found.')
  if (!found.allowed) throw new ForbiddenError()
  return { context, period: found.period }
}

/** A site's piece-pay windows that touch the month. */
async function paySites(db: Client, facts: PayFacts, period: PeriodRecord): Promise<{ readonly id: string; readonly windows: readonly PayWindow[] }[]> {
  const sites = await db.site.findMany({ where: { companyId: period.companyId }, select: { id: true } })
  const days = eachDay(dayOf(period.periodStart), dayOf(period.periodEnd))
  const out: { id: string; windows: readonly PayWindow[] }[] = []
  for (const site of sites) {
    const { windows } = await facts.site(site.id)
    if (days.some((day) => paysOn(windows, day))) out.push({ id: site.id, windows })
  }
  return out
}

const monthRange = (period: PeriodRecord): { gte: Date; lt: Date } => ({ gte: new Date(period.periodStart.getTime() - 2 * 86_400_000), lt: new Date(period.periodEnd.getTime() + 3 * 86_400_000) })

/** Who a period pays: everyone with a scan in a window of the month, a team share, an entry or a hold. */
export async function peopleOfPeriod(db: Client, facts: PayFacts, period: PeriodRecord): Promise<string[]> {
  const sites = (await paySites(db, facts, period)).map((site) => site.id)
  const range = monthRange(period)
  const [scans, members, entries, holds] = await Promise.all([
    db.operationScan.findMany({ where: { siteId: { in: sites }, serverTime: range, kind: { in: ['REPORT', 'CORRECTION', 'PARTIAL'] }, workerId: { not: null } }, distinct: ['workerId'], select: { workerId: true } }),
    db.operationScanMember.findMany({ where: { siteId: { in: sites }, employeeId: { not: null }, scan: { serverTime: range } }, distinct: ['employeeId'], select: { employeeId: true } }),
    db.earningsEntry.findMany({ where: { payPeriodId: period.id }, distinct: ['employeeId'], select: { employeeId: true } }),
    db.heldScan.findMany({ where: { payPeriodId: period.id }, distinct: ['employeeId'], select: { employeeId: true } }),
  ])
  const workers = scans.length === 0 ? [] : await db.worker.findMany({ where: { id: { in: scans.map((row) => row.workerId!) }, employeeId: { not: null } }, select: { employeeId: true } })
  return [...new Set([...workers.map((row) => row.employeeId!), ...members.map((row) => row.employeeId!), ...entries.map((row) => row.employeeId), ...holds.map((row) => row.employeeId)])].sort()
}

/** What the period's checks count (factory-domain periodChecks). */
export async function factsOfPeriod(db: Client, facts: PayFacts, period: PeriodRecord): Promise<PeriodFacts> {
  const sites = await paySites(db, facts, period)
  const siteIds = sites.map((site) => site.id)
  const people = await peopleOfPeriod(db, facts, period)
  const days = { gte: period.periodStart, lte: period.periodEnd }
  const range = monthRange(period)
  const [heldOpen, daysOpen, overtimePending, blocksWaiting, scansWithoutRate, workersWithoutEmployee, disputesOpen] = await Promise.all([
    db.heldScan.count({ where: { payPeriodId: period.id, status: 'OPEN' } }),
    db.attendanceDay.count({ where: { employeeId: { in: people }, date: days, status: 'OPEN' } }),
    db.overtimeEntry.count({ where: { employeeId: { in: people }, date: days, status: 'PENDING' } }),
    db.offStandardEntry.count({ where: { employeeId: { in: people }, workDate: days, status: { in: ['OPEN', 'PENDING'] } } }),
    // A standing scan of a known person that pays nothing and waits for no one: no rate applied (the sync tried).
    db.operationScan.count({ where: { siteId: { in: siteIds }, serverTime: range, kind: { in: ['REPORT', 'CORRECTION', 'PARTIAL'] }, goodQuantity: { gt: 0 }, worker: { is: { employeeId: { not: null } } }, earningsEntries: { none: {} }, heldScans: { none: {} }, correctedBy: { none: {} }, members: { none: {} } } }),
    db.worker.count({ where: { siteId: { in: siteIds }, employeeId: null, operationScans: { some: { serverTime: range, kind: { in: ['REPORT', 'CORRECTION', 'PARTIAL'] } } } } }),
    db.labourDispute.count({ where: { siteId: { in: siteIds }, workDate: days, status: 'OPEN' } }),
  ])
  let sitesWithoutClock = 0
  for (const id of siteIds) if (!(await facts.clockReadable(id))) sitesWithoutClock += 1
  const first = dayOf(period.periodStart)
  const last = dayOf(period.periodEnd)
  const schemes = await facts.schemesOf(period.companyId)
  const bonusSchemes = siteIds.length === 0 ? 0 : schemes.filter((scheme) => scheme.kind === 'STANDARD_MINUTE_BONUS' && scheme.validFrom <= last && (scheme.validTo === null || scheme.validTo >= first)).length
  return { heldOpen, daysOpen, overtimePending, blocksWaiting, bonusSchemes, scansWithoutRate, workersWithoutEmployee, disputesOpen, sitesWithoutClock }
}

async function checksOf(db: Client, period: PeriodRecord, now: Date): Promise<PeriodCheck[]> {
  return periodChecks(await factsOfPeriod(db, new PayFacts(db, now), period))
}

const refusalView = (refusal: EarningsRefusal | null) => ({ allowed: refusal === null, refusal: refusal ? { code: refusal.code, message: refusal.message } : null })

async function statementCounts(db: Client, periodId: string): Promise<{ draft: number; approved: number }> {
  const rows = await db.workerStatement.groupBy({ by: ['status'], where: { payPeriodId: periodId, status: { not: 'SUPERSEDED' } }, _count: { _all: true } })
  return { draft: rows.find((row) => row.status === 'DRAFT')?._count._all ?? 0, approved: rows.find((row) => row.status === 'APPROVED')?._count._all ?? 0 }
}

/** A row of the list: the state and counts; the totals of the whole period, only for a group large enough. */
async function periodRow(db: Client, context: OfficeContext, period: PeriodRecord, minimum: number) {
  const sums = await ledgerSums(db, period.id)
  const people = sums.size
  const shown = seesPay(context) && (groupShown(people, minimum) || can(actorOf(context), 'people.earnings.records', { companyId: period.companyId }))
  const [earnings, makeUp] = [...sums.values()].reduce(([a, b], row) => [a + row.earnings, b + row.makeUp] as const, [0, 0] as readonly [number, number])
  const [heldOpen, disputesOpen, statements, currency] = await Promise.all([
    db.heldScan.count({ where: { payPeriodId: period.id, status: 'OPEN' } }),
    db.labourDispute.count({ where: { siteId: { in: (await db.site.findMany({ where: { companyId: period.companyId }, select: { id: true } })).map((site) => site.id) }, workDate: { gte: period.periodStart, lte: period.periodEnd }, status: 'OPEN' } }),
    statementCounts(db, period.id),
    db.earningsEntry.findFirst({ where: { payPeriodId: period.id }, select: { currency: true } }),
  ])
  return {
    id: period.id,
    companyId: period.companyId,
    month: monthOfPeriod(period),
    periodStart: dayOf(period.periodStart),
    periodEnd: dayOf(period.periodEnd),
    status: periodStatus(period),
    people,
    earnings: asMoney('pay', shown ? earnings : null),
    makeUp: asMoney('pay', shown ? makeUp : null),
    currency: currency?.currency ?? 'EUR',
    tooFew: !groupShown(people, minimum) && !shown,
    heldOpen,
    disputesOpen,
    statements,
    version: period.version,
  }
}

export async function listPeriods(caller: CommandCaller, query: PeriodsQuery) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const where: Prisma.PayPeriodWhereInput = { AND: [scopeWhere(actorOf(context), PEOPLE_EARNINGS_VIEW, COMPANY_SCOPE) as Prisma.PayPeriodWhereInput, query.companyId ? { companyId: query.companyId } : {}, query.status ? { status: query.status } : {}] }
    const rows = await db.payPeriod.findMany({ where, select: PERIOD_SELECT, orderBy: [{ periodStart: 'desc' }, { id: 'asc' }], take: query.limit ?? 24 })
    const out = []
    for (const row of rows) out.push(await periodRow(db, context, row, await minimumGroupSizeFor(db, row.companyId)))
    return { periods: out, payShown: seesPay(context), words: out.some((row) => row.tooFew) ? [TOO_FEW_WORDS] : [] }
  })
}

async function detail(db: Client, context: OfficeContext, period: PeriodRecord, now: Date) {
  const minimum = await minimumGroupSizeFor(db, period.companyId)
  const status = periodStatus(period)
  const month = monthOfPeriod(period)
  const checks = await checksOf(db, period, now)
  const blocking = checks.filter((check) => check.blocking)
  const over = dayOf(period.periodEnd) < todayOf(now)
  const canManage = await mayChange(db, context, PEOPLE_EARNINGS_MANAGE, period.companyId)
  const statements = await statementCounts(db, period.id)
  return {
    period: { ...(await periodRow(db, context, period, minimum)), previewedAt: period.previewedAt?.toISOString() ?? null, reviewStartedAt: period.reviewStartedAt?.toISOString() ?? null, lockedAt: period.lockedAt?.toISOString() ?? null, lockNote: period.lockNote },
    checks,
    lines: await lineRows(db, { companyId: period.companyId, from: month, to: month, minimum, payShown: seesPay(context) }),
    actions: {
      run: refusalView(moveRefusal(status, 'RUN')),
      reopen: refusalView(moveRefusal(status, 'REOPEN')),
      startReview: refusalView(moveRefusal(status, 'START_REVIEW') ?? (!over ? notOver(month, todayOf(now)) : blocking.length > 0 ? checksOpen(blocking.map((check) => check.words)) : null)),
      back: refusalView(moveRefusal(status, 'BACK')),
      lock: refusalView(moveRefusal(status, 'LOCK') ?? (statements.draft > 0 ? statementsOpen(statements.draft) : null)),
    },
    lockPhrase: lockPhrase(month),
    canManage,
    payShown: seesPay(context),
  }
}

export async function period(caller: CommandCaller, periodId: string) {
  const { context, period: row } = await periodOf(caller, periodId, PEOPLE_EARNINGS_VIEW)
  return caller.withClient((db) => detail(db, context, row, serverClock.now()))
}

/** Opens a month's period (OPEN); one already there answers as it is. */
export async function createPeriod(caller: CommandCaller, body: CreatePeriodBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  if (!monthPeriod(body.month)) throw new ValidationError('Give the month as YYYY-MM.', [{ path: 'body/month', message: 'Give the month as YYYY-MM.' }])
  const allowed = await caller.withClient(async (db) => (await db.company.findUnique({ where: { id: body.companyId }, select: { id: true } })) !== null && mayChange(db, context, PEOPLE_EARNINGS_MANAGE, body.companyId))
  if (!allowed) throw new ForbiddenError()
  const { result, replayed } = await command(caller, { name: 'people.createPayPeriod', idempotencyKey, input: body }, async (tools) => {
    const known = await periodOfMonth(tools.tx, body.companyId, body.month)
    if (known) {
      tools.audit({ recordType: 'PayPeriod', recordId: known.id, companyId: body.companyId, after: { month: body.month, unchanged: true } })
      return { periodId: known.id, created: false }
    }
    const { period: made } = await placeOf(tools, body.companyId, `${body.month}-01`)
    return { periodId: made.id, created: true }
  })
  return { ...(await caller.withClient(async (db) => detail(db, context, (await periodById(db, result.periodId))!, serverClock.now()))), created: result.created, replayed }
}

/** Every person's figures, one command each. `book`: the period's figures go into the ledger too. */
async function syncEveryone(caller: CommandCaller, row: PeriodRecord, book: boolean): Promise<{ readonly people: number; readonly added: number; readonly reversed: number }> {
  const people = await caller.withClient((db) => peopleOfPeriod(db, new PayFacts(db, serverClock.now()), row))
  let added = 0
  let reversed = 0
  for (const employeeId of people) {
    const { result } = await command(caller, { name: 'people.syncPersonPay', input: { periodId: row.id, employeeId, book, at: serverClock.now().toISOString() } }, async (tools) => {
      await lockPerson(tools.tx, tenantOf(tools.context), employeeId)
      const person = (await personOf(tools.tx, employeeId))!
      const facts = new PayFacts(tools.tx, tools.now)
      const current = (await periodById(tools.tx, row.id))!
      const run = await syncPersonInCommand(tools, facts, current, person, { book })
      tools.audit({ action: 'people.syncPersonPay', recordType: 'PayPeriod', recordId: row.id, companyId: row.companyId, siteId: person.siteId, after: { employeeId, book, added: run.added, reversed: run.reversed, statementId: run.statementId } })
      return run
    })
    added += result.added
    reversed += result.reversed
  }
  return { people: people.length, added, reversed }
}

function emitPeriod(tools: CommandTools, row: PeriodRecord, status: string, change: string): void {
  tools.emit({ type: 'pay_period.changed', subject: row.id, companyId: row.companyId, siteId: null, payload: { periodId: row.id, companyId: row.companyId, month: monthOfPeriod(row), status, change } })
}

/** "Run <month> pay period". */
export async function runPeriod(caller: CommandCaller, periodId: string, body: VersionBody, idempotencyKey?: string) {
  const { context, period: row } = await periodOf(caller, periodId, PEOPLE_EARNINGS_MANAGE)
  assertVersion('pay period', row.version, body.version)
  refuseEarnings(moveRefusal(periodStatus(row), 'RUN'))
  const synced = await syncEveryone(caller, row, false)
  await command(caller, { name: 'people.runPayPeriod', idempotencyKey, input: body, record: { type: 'PayPeriod', id: row.id, expectedVersion: body.version } }, async (tools) => {
    await tools.tx.payPeriod.update({ where: { id: row.id }, data: { status: 'PREVIEW', previewedAt: tools.now, previewedById: actorIdOf(tools.context) }, select: { id: true } })
    tools.audit({ action: 'people.runPayPeriod', recordType: 'PayPeriod', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: 'PREVIEW', people: synced.people, added: synced.added, reversed: synced.reversed } })
    emitPeriod(tools, row, 'PREVIEW', 'RUN')
    return { status: 'PREVIEW' }
  })
  return { ...(await caller.withClient(async (db) => detail(db, context, (await periodById(db, row.id))!, serverClock.now()))), run: synced }
}

/** Back to OPEN: the preview is put aside (what the scans booked stands). */
export async function reopenPeriod(caller: CommandCaller, periodId: string, body: VersionBody, idempotencyKey?: string) {
  const { context, period: row } = await periodOf(caller, periodId, PEOPLE_EARNINGS_MANAGE)
  refuseEarnings(moveRefusal(periodStatus(row), 'REOPEN'))
  await command(caller, { name: 'people.reopenPayPeriod', idempotencyKey, input: body, record: { type: 'PayPeriod', id: row.id, expectedVersion: body.version } }, async (tools) => {
    await tools.tx.payPeriod.update({ where: { id: row.id }, data: { status: 'OPEN' }, select: { id: true } })
    tools.audit({ action: 'people.reopenPayPeriod', recordType: 'PayPeriod', recordId: row.id, companyId: row.companyId, before: { status: 'PREVIEW' }, after: { status: 'OPEN' } })
    emitPeriod(tools, row, 'OPEN', 'REOPENED')
    return { status: 'OPEN' }
  })
  return caller.withClient(async (db) => detail(db, context, (await periodById(db, row.id))!, serverClock.now()))
}

/** "Start the review": the month over, nothing blocking; the figures booked; statements ready to approve. */
export async function startReview(caller: CommandCaller, periodId: string, body: VersionBody, idempotencyKey?: string) {
  const { context, period: row } = await periodOf(caller, periodId, PEOPLE_EARNINGS_MANAGE)
  assertVersion('pay period', row.version, body.version)
  refuseEarnings(moveRefusal(periodStatus(row), 'START_REVIEW'))
  const today = todayOf(serverClock.now())
  if (dayOf(row.periodEnd) >= today) refuseEarnings(notOver(monthOfPeriod(row), today))
  const refuseChecks = async (): Promise<void> => {
    const blocking = (await caller.withClient((db) => checksOf(db, row, serverClock.now()))).filter((check) => check.blocking)
    if (blocking.length > 0) refuseEarnings(checksOpen(blocking.map((check) => check.words)))
  }
  await refuseChecks()
  const synced = await syncEveryone(caller, row, true)
  await refuseChecks()
  await command(caller, { name: 'people.startPayReview', idempotencyKey, input: body, record: { type: 'PayPeriod', id: row.id, expectedVersion: body.version } }, async (tools) => {
    await tools.tx.payPeriod.update({ where: { id: row.id }, data: { status: 'REVIEW', reviewStartedAt: tools.now, reviewStartedById: actorIdOf(tools.context) }, select: { id: true } })
    tools.audit({ action: 'people.startPayReview', recordType: 'PayPeriod', recordId: row.id, companyId: row.companyId, before: { status: 'PREVIEW' }, after: { status: 'REVIEW', people: synced.people, added: synced.added, reversed: synced.reversed } })
    emitPeriod(tools, row, 'REVIEW', 'REVIEW_STARTED')
    return { status: 'REVIEW' }
  })
  return { ...(await caller.withClient(async (db) => detail(db, context, (await periodById(db, row.id))!, serverClock.now()))), run: synced }
}

/** Back to PREVIEW, with why: a mistake found in review. */
export async function backToPreview(caller: CommandCaller, periodId: string, body: ReasonVersionBody, idempotencyKey?: string) {
  const { context, period: row } = await periodOf(caller, periodId, PEOPLE_EARNINGS_MANAGE)
  refuseEarnings(moveRefusal(periodStatus(row), 'BACK'))
  await command(caller, { name: 'people.backToPayPreview', idempotencyKey, input: body, record: { type: 'PayPeriod', id: row.id, expectedVersion: body.version } }, async (tools) => {
    await tools.tx.payPeriod.update({ where: { id: row.id }, data: { status: 'PREVIEW', reviewStartedAt: null, reviewStartedById: null }, select: { id: true } })
    tools.audit({ action: 'people.backToPayPreview', recordType: 'PayPeriod', recordId: row.id, companyId: row.companyId, before: { status: 'REVIEW' }, after: { status: 'PREVIEW' }, reason: body.reason.trim() })
    emitPeriod(tools, row, 'PREVIEW', 'REVIEW_TAKEN_BACK')
    return { status: 'PREVIEW' }
  })
  return caller.withClient(async (db) => detail(db, context, (await periodById(db, row.id))!, serverClock.now()))
}

/** "Lock <month> pay period": typed, by a person. Statements final; later changes are new entries in a later period. */
export async function lockPeriod(caller: CommandCaller, periodId: string, body: LockBody, idempotencyKey?: string) {
  const { context, period: row } = await periodOf(caller, periodId, PEOPLE_EARNINGS_MANAGE)
  const month = monthOfPeriod(row)
  refuseEarnings(moveRefusal(periodStatus(row), 'LOCK'))
  if (body.phrase.trim() !== lockPhrase(month)) refuseEarnings(wrongPhrase(month))
  await command(caller, { name: 'people.lockPayPeriod', idempotencyKey, input: body, record: { type: 'PayPeriod', id: row.id, expectedVersion: body.version } }, async (tools) => {
    const actorId = assertPersonDecides(tools.context, 'PAY_PERIOD_LOCK')
    const live = await tools.tx.workerStatement.findMany({ where: { payPeriodId: row.id, status: { not: 'SUPERSEDED' } }, select: { employeeId: true, status: true, earningsAmount: true, makeUpAmount: true } })
    const sums = await ledgerSums(tools.tx, row.id)
    const stated = new Map(live.map((statement) => [statement.employeeId, statement]))
    const open = live.filter((statement) => statement.status === 'DRAFT').length + [...sums.keys()].filter((id) => !stated.has(id)).length
    if (open > 0) refuseEarnings(statementsOpen(open))
    const stale = live.filter((statement) => {
      const sum = sums.get(statement.employeeId) ?? { earnings: 0, makeUp: 0 }
      return statement.earningsAmount !== sum.earnings || statement.makeUpAmount !== sum.makeUp
    }).length
    if (stale > 0) refuseEarnings(statementStale(stale))
    await tools.tx.payPeriod.update({ where: { id: row.id }, data: { status: 'LOCKED', lockedAt: tools.now, lockedById: actorId, lockNote: body.note?.trim() || null }, select: { id: true } })
    tools.audit({ action: 'people.lockPayPeriod', recordType: 'PayPeriod', recordId: row.id, companyId: row.companyId, before: { status: 'REVIEW' }, after: { status: 'LOCKED', month, statements: live.length } })
    emitPeriod(tools, row, 'LOCKED', 'LOCKED')
    return { status: 'LOCKED' }
  })
  return caller.withClient(async (db) => detail(db, context, (await periodById(db, row.id))!, serverClock.now()))
}

