import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { entryKey } from '@nexus/factory-domain/people/earnings/ledger'
import { PEOPLE_EARNINGS_MANAGE, PEOPLE_EARNINGS_RECORDS, PEOPLE_EARNINGS_VIEW } from '@nexus/factory-domain/people/earnings/permissions'
import { ALREADY_REVERSED, IS_REVERSAL, LIST_LIMIT, NO_WORKER, OWN_RECORD, type EarningsKind } from '@nexus/factory-domain/people/earnings/rules'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { lockPerson } from '../attendance/compute'
import { fullName, type Client } from '../attendance/store'
import { dateOf, dayOf } from '../employees/access'
import { assertPersonDecides } from '../privacy/decide'
import { refusePersonKeys } from '../privacy/groups'
import { officeOf, refuseEarnings, requireRight, seesPay, tenantOf } from './access'
import type { AdjustBody, CorrectBody, CountsQuery, LedgerQuery } from './contract'
import { addEntry, reverseEntry } from './ledger'
import { decimalOf, ENTRY_SELECT, monthOfPeriod, type EntryRecord } from './store'

/**
 * The earnings ledger (B-W2b-43; MES-256 "every valid scan adds an earnings entry; corrections are new entries, never edits";
 * design people.piecerates "Earnings ledger"). The grid is for those with the right and carries no name and no person key
 * (Owner answer W1: a person is opened as one record, their statement); one entry opens with its person. "Correct" writes
 * the reversal and, when it says so, a new line with the reason: never an edit.
 */

const SCOPE = { company: 'companyId', site: 'siteId' } as const

/** What a row shows of its scan or block. */
async function placesOf(db: Client, rows: readonly EntryRecord[]) {
  const scanIds = [...new Set(rows.flatMap((row) => (row.operationScanId ? [row.operationScanId] : [])))]
  const scans = scanIds.length === 0 ? [] : await db.operationScan.findMany({ where: { id: { in: scanIds } }, select: { id: true, operation: { select: { code: true, name: true } }, bundle: { select: { code: true } } } })
  return new Map(scans.map((scan) => [scan.id, { operation: scan.operation, bundle: scan.bundle.code }]))
}

function rowOf(row: EntryRecord, places: Awaited<ReturnType<typeof placesOf>>, months: ReadonlyMap<string, string>) {
  const place = row.operationScanId ? places.get(row.operationScanId) : undefined
  return {
    id: row.id,
    workDate: dayOf(row.workDate),
    siteId: row.siteId,
    periodId: row.payPeriodId,
    kind: row.kind as EarningsKind,
    bundle: place?.bundle ?? null,
    operation: place?.operation ?? null,
    pieces: row.pieces,
    minutes: decimalOf(row.minutes),
    sharePct: decimalOf(row.sharePct),
    rate: asMoney('pay', decimalOf(row.rate)),
    amount: asMoney('pay', row.amount),
    currency: row.currency,
    /** The entry it reverses. */
    reversesId: row.reversalOfId,
    /** The locked month it corrects. */
    correctsMonth: row.correctsPeriodId ? (months.get(row.correctsPeriodId) ?? null) : null,
    reason: row.reason,
    createdAt: toUtcIso(row.createdAt),
  }
}

async function monthsOf(db: Client, rows: readonly EntryRecord[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.flatMap((row) => (row.correctsPeriodId ? [row.correctsPeriodId] : [])))]
  return new Map((ids.length === 0 ? [] : await db.payPeriod.findMany({ where: { id: { in: ids } }, select: { id: true, periodStart: true } })).map((row) => [row.id, monthOfPeriod(row)]))
}

export async function ledger(caller: CommandCaller, query: LedgerQuery) {
  const context = officeOf(caller)
  refusePersonKeys({ filters: query.employeeId !== undefined ? ['employeeId'] : [], groupBy: query.groupBy ? [query.groupBy] : [] })
  if (!seesPay(context)) throw new ForbiddenError('The ledger needs the pay grain.')
  return caller.withClient(async (db) => {
    const cursor = query.cursor ? /^([0-9a-f-]{36})$/.exec(query.cursor) : null
    if (query.cursor && !cursor) throw new ValidationError('The cursor is not one this list gave.', [{ path: 'querystring/cursor', message: 'Use nextCursor as given.' }])
    const line: Prisma.EarningsEntryWhereInput = query.lineId ? { operationScan: { is: { OR: [{ station: { is: { lineId: query.lineId } } }, { stationId: null, device: { is: { lineId: query.lineId } } }] } } } : {}
    const where: Prisma.EarningsEntryWhereInput = {
      AND: [
        scopeWhere(actorOf(context), PEOPLE_EARNINGS_RECORDS, SCOPE) as Prisma.EarningsEntryWhereInput,
        query.periodId ? { payPeriodId: query.periodId } : {},
        query.siteId ? { siteId: query.siteId } : {},
        query.kind ? { kind: query.kind } : {},
        query.from ? { workDate: { gte: dateOf(query.from) } } : {},
        query.to ? { workDate: { lte: dateOf(query.to) } } : {},
        line,
        cursor ? { id: { lt: cursor[1]! } } : {},
      ],
    }
    const limit = Math.min(query.limit ?? 100, LIST_LIMIT)
    const rows = await db.earningsEntry.findMany({ where, select: ENTRY_SELECT, orderBy: [{ id: 'desc' }], take: limit + 1 })
    const page = rows.slice(0, limit)
    const [places, months] = await Promise.all([placesOf(db, page), monthsOf(db, page)])
    return { entries: page.map((row) => rowOf(row, places, months)), nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null, words: ['The ledger names nobody: an entry opens one at a time, and a person is read on their statement.'] }
  })
}

async function entryOf(caller: CommandCaller, entryId: string): Promise<EntryRecord> {
  const context = officeOf(caller)
  const row = isUuid(entryId) ? await caller.withClient((db) => db.earningsEntry.findUnique({ where: { id: entryId }, select: ENTRY_SELECT })) : null
  if (!row || !can(actorOf(context), PEOPLE_EARNINGS_VIEW, { companyId: row.companyId, siteId: row.siteId })) throw new NotFoundError('Earnings entry not found.')
  requireRight(context, row)
  return row
}

export async function entry(caller: CommandCaller, entryId: string) {
  const row = await entryOf(caller, entryId)
  return caller.withClient(async (db) => {
    const [places, months] = await Promise.all([placesOf(db, [row]), monthsOf(db, [row])])
    const person = (await db.employee.findUnique({ where: { id: row.employeeId }, select: { id: true, firstName: true, lastName: true, employeeCode: true } }))!
    const reversedBy = await db.earningsEntry.findFirst({ where: { reversalOfId: row.id }, select: { id: true } })
    return { ...rowOf(row, places, months), person: { employeeId: person.id, name: fullName(person), code: person.employeeCode }, reversedById: reversedBy?.id ?? null, canCorrect: row.reversalOfId === null && reversedBy === null }
  })
}

/** "Correct": the reversal of the entry and, with an amount, a new line. The source pays no more by itself after this. */
export async function correctEntry(caller: CommandCaller, entryId: string, body: CorrectBody, idempotencyKey?: string) {
  const row = await entryOf(caller, entryId)
  const context = officeOf(caller)
  if (!can(actorOf(context), PEOPLE_EARNINGS_MANAGE, { companyId: row.companyId, siteId: row.siteId })) throw new ForbiddenError()
  await command(caller, { name: 'people.correctEarningsEntry', idempotencyKey, input: { entryId, ...body } }, async (tools) => {
    const actorId = assertPersonDecides(tools.context, 'LABOUR_CORRECTION')
    await lockPerson(tools.tx, tenantOf(tools.context), row.employeeId)
    if ((await tools.tx.employee.findUnique({ where: { id: row.employeeId }, select: { userId: true } }))?.userId === actorId) refuseEarnings(OWN_RECORD)
    if (row.reversalOfId) refuseEarnings(IS_REVERSAL)
    if (await tools.tx.earningsEntry.findFirst({ where: { reversalOfId: row.id }, select: { id: true } })) refuseEarnings(ALREADY_REVERSED)
    const reason = body.reason.trim()
    await reverseEntry(tools, row, reason, entryKey.correct(row.id))
    const amount = body.amount as number | undefined
    if (amount !== undefined && amount !== 0) {
      await addEntry(tools, row.companyId, { key: '', kind: 'ADJUSTMENT', siteId: row.siteId, employeeId: row.employeeId, workerId: row.workerId, workDate: dayOf(row.workDate), pieces: null, minutes: null, rate: null, amount, currency: row.currency, sourceType: 'EarningsEntry', sourceId: row.id, reason }, entryKey.adjust(row.id))
    }
    tools.audit({ action: 'people.correctEarningsEntry', recordType: 'EarningsEntry', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { amount: markMoney('pay', row.amount) }, after: { reversed: true, amount: markMoney('pay', amount ?? 0) }, reason })
    tools.emit({ type: 'earnings.recorded', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { siteId: row.siteId, bundleId: null, added: amount ? 1 : 0, reversed: 1, held: 0, released: 0 } })
    return { id: row.id }
  })
  return entry(caller, entryId)
}

/** An adjustment typed by HR, with its reason (paid on top: it never counts towards the guaranteed pay). */
export async function adjust(caller: CommandCaller, body: AdjustBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const person = await caller.withClient((db) => db.employee.findUnique({ where: { id: body.employeeId }, select: { id: true, companyId: true, siteId: true } }))
  if (!person) throw new NotFoundError('Person not found.')
  if (!can(actorOf(context), PEOPLE_EARNINGS_MANAGE, { companyId: person.companyId, siteId: body.siteId })) throw new ForbiddenError()
  requireRight(context, { companyId: person.companyId, siteId: body.siteId })
  const { result } = await command(caller, { name: 'people.adjustEarnings', idempotencyKey, input: body }, async (tools) => {
    const actorId = assertPersonDecides(tools.context, 'LABOUR_CORRECTION')
    await lockPerson(tools.tx, tenantOf(tools.context), person.id)
    if ((await tools.tx.employee.findUnique({ where: { id: person.id }, select: { userId: true } }))?.userId === actorId) refuseEarnings(OWN_RECORD)
    const worker = await tools.tx.worker.findFirst({ where: { employeeId: person.id, siteId: body.siteId }, select: { id: true } })
    if (!worker) refuseEarnings(NO_WORKER)
    const reason = body.reason.trim()
    const amount = body.amount as number
    const id = await addEntry(tools, person.companyId, { key: '', kind: 'ADJUSTMENT', siteId: body.siteId, employeeId: person.id, workerId: worker!.id, workDate: body.workDate, pieces: null, minutes: null, rate: null, amount, currency: body.currency ?? 'EUR', reason }, entryKey.adjust(newId()))
    tools.audit({ action: 'people.adjustEarnings', recordType: 'EarningsEntry', recordId: id, companyId: person.companyId, siteId: body.siteId, after: { employeeId: person.id, workDate: body.workDate, amount: markMoney('pay', amount) }, reason })
    tools.emit({ type: 'earnings.recorded', subject: id, companyId: person.companyId, siteId: body.siteId, payload: { siteId: body.siteId, bundleId: null, added: 1, reversed: 0, held: 0, released: 0 } })
    return { id }
  })
  return entry(caller, result.id)
}

/** The tiles of the Piece rates page: what needs HR before a period runs (counts, never a person). */
export async function counts(caller: CommandCaller, query: CountsQuery) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const scoped = scopeWhere(actorOf(context), PEOPLE_EARNINGS_VIEW, SCOPE) as Prisma.HeldScanWhereInput
    const heldOpen = await db.heldScan.count({ where: { AND: [scoped, query.companyId ? { companyId: query.companyId } : {}, query.siteId ? { siteId: query.siteId } : {}], status: 'OPEN' } })
    const site = scopeWhere(actorOf(context), PEOPLE_EARNINGS_VIEW, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput
    const sites = await db.site.findMany({ where: { AND: [site, query.companyId ? { companyId: query.companyId } : {}, query.siteId ? { id: query.siteId } : {}] }, select: { id: true } })
    const disputesOpen = await db.labourDispute.count({ where: { status: 'OPEN', siteId: { in: sites.map((row) => row.id) } } })
    return { heldOpen, disputesOpen, asOf: toUtcIso(serverClock.now()) }
  })
}
