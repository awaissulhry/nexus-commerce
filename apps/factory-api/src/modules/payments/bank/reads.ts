import type { Prisma } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { can } from '@nexus/factory-domain/core/permissions'
import { PAYMENTS_BANK_VIEW } from '@nexus/factory-domain/payments/bank/permissions'
import { PAYMENTS_VIEW } from '@nexus/factory-domain/payments/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { openItemsOf } from '../matching/facts'
import { officeContextOf, officePayment, type Reader } from '../store'
import { toleranceOf } from '../write-offs/sums'
import { bankAccess, LINE_COLUMNS, lineView, MATCH_COLUMNS, matchContext, matchView, type LineRow, type MatchRow } from './store'

/**
 * The bank's reads (B-W2b-393; FIN-130, FIN-132; design finance.bank: tiles, "Match bank lines", the statements; design
 * finance.payments rec tab "Bank line"), payments.bank.view over the company, amounts by the price grain:
 *
 *   GET /payments/bank/accounts?companyId             the company's accounts, each with its last statement's day
 *   GET /payments/bank/statements?companyId…          the statements imported, newest first
 *   GET /payments/bank/statements/:statementId        one statement and its lines
 *   GET /payments/bank/lines?companyId&view…          the lines: TO_MATCH (default, oldest first), SURE (a High
 *                                                     suggestion to accept), OLD (to match, booked more than 7 days
 *                                                     ago), MATCHED, ALL — each with its suggestions (how sure, why,
 *                                                     what accepting would leave) or its acceptance
 *   GET /payments/bank/lines/counts?companyId         the tiles: lines to match, sure matches to accept, unmatched over
 *                                                     7 days, and the last statement's day (AsOf); never money
 *   GET /payments/bank/lines/:lineId                  one line
 *   GET /payments/:paymentId/bank-line                the payment's record: the bank line it came from with how sure
 *                                                     and why, or none ("recorded by hand") — payments.view on the
 *                                                     payment; the line itself only with payments.bank.view
 */

export const OLD_AFTER_DAYS = 7
export const LINE_VIEWS = ['TO_MATCH', 'SURE', 'OLD', 'MATCHED', 'ALL'] as const
export type LineListView = (typeof LINE_VIEWS)[number]

const dateValue = (day: string): Date => new Date(`${day}T00:00:00.000Z`)
const day = (value: Date): string => value.toISOString().slice(0, 10)
const today = (): string => businessDate(serverClock.now())
const daysBefore = (from: string, days: number): string => day(new Date(Date.parse(`${from}T00:00:00Z`) - days * 86_400_000))

const LIVE: Prisma.BankMatchWhereInput = { acceptedAt: { not: null }, reversedAt: null }

/** The views of these lines (their matches, names and what is open now read once). */
async function viewsOf(db: Reader, companyId: string, lines: readonly LineRow[]) {
  if (lines.length === 0) return []
  const matches: MatchRow[] = await db.bankMatch.findMany({ where: { bankLineId: { in: lines.map((line) => line.id) } }, select: MATCH_COLUMNS })
  const suggestions = matches.filter((row) => row.acceptedAt === null)
  const invoiceIds = [...new Set(suggestions.flatMap((row) => row.invoiceIds))]
  const depositRequestIds = [...new Set(suggestions.flatMap((row) => row.depositRequestIds))]
  const open = invoiceIds.length === 0 && depositRequestIds.length === 0 ? [] : await openItemsOf(db, companyId, { invoiceIds, depositRequestIds })
  const context = await matchContext(db, matches, open, (await toleranceOf(db, companyId)).amount)
  const now = today()
  return lines.map((line) => lineView(line, matches, context, now))
}

/** GET /payments/bank/accounts. */
export async function listAccounts(caller: CommandCaller, query: { readonly companyId: string }) {
  bankAccess(caller, query.companyId)
  return caller.withClient(async (db) => {
    const accounts = await db.bankAccount.findMany({ where: { companyId: query.companyId }, select: { id: true, holder: true, iban: true, bic: true, bankName: true, currency: true, active: true, version: true }, orderBy: [{ active: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }] })
    const last = accounts.length === 0 ? [] : await db.bankStatement.groupBy({ by: ['bankAccountId'], where: { bankAccountId: { in: accounts.map((account) => account.id) } }, _max: { periodEnd: true }, _count: { _all: true } })
    return {
      accounts: accounts.map((account) => {
        const mine = last.find((row) => row.bankAccountId === account.id)
        return { ...account, lastStatementOn: mine?._max.periodEnd ? day(mine._max.periodEnd) : null, statements: mine?._count._all ?? 0 }
      }),
    }
  })
}

/** GET /payments/bank/statements. */
export async function listStatements(caller: CommandCaller, query: { readonly companyId: string; readonly bankAccountId?: string | undefined; readonly cursor?: string | undefined; readonly limit: number }) {
  bankAccess(caller, query.companyId)
  return caller.withClient(async (db) => {
    const rows = await db.bankStatement.findMany({
      where: { companyId: query.companyId, ...(query.bankAccountId ? { bankAccountId: query.bankAccountId } : {}), ...(query.cursor ? { id: { lt: query.cursor } } : {}) },
      select: { id: true, bankAccountId: true, fileId: true, format: true, periodStart: true, periodEnd: true, importedById: true, importedAt: true, file: { select: { originalName: true } }, _count: { select: { lines: true } } },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    return {
      statements: page.map((row) => ({ id: row.id, bankAccountId: row.bankAccountId, fileId: row.fileId, fileName: row.file.originalName, format: row.format, periodStart: day(row.periodStart), periodEnd: day(row.periodEnd), lines: row._count.lines, importedById: row.importedById, importedAt: toUtcIso(row.importedAt) })),
      nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
    }
  })
}

/** GET /payments/bank/statements/:statementId. */
export async function getStatement(caller: CommandCaller, statementId: string) {
  const row = isUuid(statementId) ? await caller.withClient((db) => db.bankStatement.findUnique({ where: { id: statementId }, select: { id: true, companyId: true, bankAccountId: true, fileId: true, format: true, periodStart: true, periodEnd: true, importedById: true, importedAt: true, file: { select: { originalName: true } } } })) : null
  if (!row) throw new NotFoundError('Statement not found.')
  bankAccess(caller, row.companyId)
  return caller.withClient(async (db) => {
    const lines = await db.bankLine.findMany({ where: { statementId: row.id }, select: LINE_COLUMNS, orderBy: [{ bookedOn: 'asc' }, { id: 'asc' }] })
    const importer = await db.user.findUnique({ where: { id: row.importedById }, select: { displayName: true } })
    return {
      statement: { id: row.id, companyId: row.companyId, bankAccountId: row.bankAccountId, fileId: row.fileId, fileName: row.file.originalName, format: row.format, periodStart: day(row.periodStart), periodEnd: day(row.periodEnd), importedById: row.importedById, importedBy: importer?.displayName ?? null, importedAt: toUtcIso(row.importedAt) },
      lines: await viewsOf(db, row.companyId, lines),
    }
  })
}

/** The where of a list view (the tiles' saved filters). */
function viewWhere(view: LineListView, now: string): Prisma.BankLineWhereInput {
  switch (view) {
    case 'TO_MATCH':
      return { matches: { none: LIVE } }
    case 'SURE':
      return { matches: { none: LIVE, some: { acceptedAt: null, confidence: 'HIGH' } } }
    case 'OLD':
      return { matches: { none: LIVE }, bookedOn: { lt: dateValue(daysBefore(now, OLD_AFTER_DAYS)) } }
    case 'MATCHED':
      return { matches: { some: LIVE } }
    case 'ALL':
      return {}
  }
}

/** GET /payments/bank/lines. */
export async function listLines(caller: CommandCaller, query: { readonly companyId: string; readonly view?: LineListView | undefined; readonly bankAccountId?: string | undefined; readonly direction?: 'IN' | 'OUT' | undefined; readonly cursor?: string | undefined; readonly limit: number }) {
  bankAccess(caller, query.companyId)
  const view = query.view ?? 'TO_MATCH'
  const newestFirst = view === 'MATCHED' || view === 'ALL'
  let after: { bookedOn: string; id: string } | null = null
  if (query.cursor) {
    const [booked, id] = query.cursor.split('|')
    if (!booked || !id || !isUuid(id) || !/^\d{4}-\d{2}-\d{2}$/.test(booked)) throw new ValidationError('The cursor is not one this list gave.', [{ path: 'querystring/cursor', message: 'Unknown cursor.' }])
    after = { bookedOn: booked, id }
  }
  const now = today()
  const where: Prisma.BankLineWhereInput = {
    AND: [
      { companyId: query.companyId },
      viewWhere(view, now),
      query.bankAccountId ? { bankAccountId: query.bankAccountId } : {},
      query.direction === 'IN' ? { amount: { gt: 0 } } : query.direction === 'OUT' ? { amount: { lt: 0 } } : {},
      after
        ? newestFirst
          ? { OR: [{ bookedOn: { lt: dateValue(after.bookedOn) } }, { bookedOn: dateValue(after.bookedOn), id: { lt: after.id } }] }
          : { OR: [{ bookedOn: { gt: dateValue(after.bookedOn) } }, { bookedOn: dateValue(after.bookedOn), id: { gt: after.id } }] }
        : {},
    ],
  }
  return caller.withClient(async (db) => {
    const order = newestFirst ? ('desc' as const) : ('asc' as const)
    const rows = await db.bankLine.findMany({ where, select: LINE_COLUMNS, orderBy: [{ bookedOn: order }, { id: order }], take: query.limit + 1 })
    const page = rows.slice(0, query.limit)
    const last = page[page.length - 1]
    return { view, lines: await viewsOf(db, query.companyId, page), nextCursor: rows.length > query.limit && last ? `${day(last.bookedOn)}|${last.id}` : null }
  })
}

/** GET /payments/bank/lines/counts: the tiles (a count, never money). */
export async function lineCounts(caller: CommandCaller, query: { readonly companyId: string }) {
  bankAccess(caller, query.companyId)
  const now = today()
  return caller.withClient(async (db) => {
    const count = async (view: LineListView) => db.bankLine.count({ where: { AND: [{ companyId: query.companyId }, viewWhere(view, now)] } })
    const toMatch = await count('TO_MATCH')
    const sure = await count('SURE')
    const old = await count('OLD')
    const last = await db.bankStatement.aggregate({ where: { companyId: query.companyId }, _max: { periodEnd: true } })
    return { companyId: query.companyId, today: now, oldAfterDays: OLD_AFTER_DAYS, toMatch, sureMatches: sure, unmatchedOverDays: old, lastStatementOn: last._max.periodEnd ? day(last._max.periodEnd) : null }
  })
}

/** GET /payments/bank/lines/:lineId. */
export async function getLine(caller: CommandCaller, lineId: string) {
  const line = isUuid(lineId) ? await caller.withClient((db) => db.bankLine.findUnique({ where: { id: lineId }, select: LINE_COLUMNS })) : null
  if (!line) throw new NotFoundError('Bank line not found.')
  bankAccess(caller, line.companyId)
  return { line: (await caller.withClient((db) => viewsOf(db, line.companyId, [line])))[0]! }
}

/** GET /payments/:paymentId/bank-line: the line a payment came from (its live acceptance), or none. */
export async function paymentBankLine(caller: CommandCaller, paymentId: string) {
  const payment = await officePayment(caller, paymentId, PAYMENTS_VIEW)
  return caller.withClient(async (db) => {
    const match = await db.bankMatch.findFirst({ where: { paymentId: payment.id, ...LIVE }, select: MATCH_COLUMNS })
    if (!match) return { paymentId: payment.id, recordedByHand: true, line: null }
    const line = (await db.bankLine.findUnique({ where: { id: match.bankLineId }, select: LINE_COLUMNS }))!
    // The bank line itself is the bank's (payments.bank.view over the company); the payment's reader sees that it has one.
    if (!can(actorOf(officeContextOf(caller)), PAYMENTS_BANK_VIEW, { companyId: line.companyId })) return { paymentId: payment.id, recordedByHand: false, line: null }
    const account = await db.bankAccount.findUnique({ where: { id: line.bankAccountId }, select: { bankName: true, iban: true } })
    const context = await matchContext(db, [match], [], null)
    return {
      paymentId: payment.id,
      recordedByHand: false,
      line: { id: line.id, statementId: line.statementId, bank: account?.bankName ?? null, accountIban: account?.iban ?? null, bookedOn: day(line.bookedOn), valueOn: line.valueOn ? day(line.valueOn) : null, referenceText: line.referenceText, counterpartyName: line.counterpartyName, counterpartyIban: line.counterpartyIban, match: matchView(match, line, context) },
    }
  })
}
