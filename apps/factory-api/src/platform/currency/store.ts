import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { DomainError, UnauthenticatedError, ForbiddenError } from '@nexus/factory-domain/core/errors'
import { can, grantsFor, type Permission } from '@nexus/factory-domain/core/permissions'
import { addDays, dayRateFrom, LOOKBACK_DAYS, pairsFor, type DayRate, type RateRow, type RateSource } from '@nexus/factory-domain/money/currency/rates'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { CommandCaller, CommandTx } from '../../core/command'
import { actorOf, type OfficeContext } from '../../core/context'

/**
 * Currencies and exchange rates — the readers (B-W2b-389; PLT-132, PLT-133; factory-db currency.prisma). A reader takes a
 * command's transaction or a scoped client: row-level security decides what it finds (the rates are the tenant's, the
 * currencies a company's). The day's rate itself is the domain's (money/currency/rates dayRateFrom): these only read the
 * rows it needs, the days of the lookback window before the day asked.
 */

export type Reader = FactoryClient | CommandTx

export const RATE_COLUMNS = { id: true, base: true, quote: true, rateDate: true, rate: true, source: true, overriddenById: true, key: true, version: true, createdAt: true, updatedAt: true } as const satisfies Prisma.ExchangeRateSelect
export type StoredRate = Prisma.ExchangeRateGetPayload<{ select: typeof RATE_COLUMNS }>

export const CURRENCY_COLUMNS = { id: true, companyId: true, code: true, minorUnits: true, active: true, version: true, createdAt: true, updatedAt: true } as const satisfies Prisma.CurrencySelect
export type StoredCurrency = Prisma.CurrencyGetPayload<{ select: typeof CURRENCY_COLUMNS }>

export const dayText = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
export const dayValue = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)

export const rateRowOf = (row: Pick<StoredRate, 'base' | 'quote' | 'rateDate' | 'rate' | 'source'>): RateRow => ({ base: row.base, quote: row.quote, rateDate: dayText(row.rateDate), rate: row.rate.toString(), source: row.source as RateSource })

/** The stored rows of these pairs (base, quote) from `from` − the lookback to `to`. */
export async function rowsNear(db: Reader, pairs: readonly (readonly [string, string])[], from: BusinessDate, to: BusinessDate): Promise<RateRow[]> {
  if (pairs.length === 0) return []
  const rows = await db.exchangeRate.findMany({
    where: { rateDate: { gte: dayValue(addDays(from, -LOOKBACK_DAYS)), lte: dayValue(to) }, OR: pairs.map(([base, quote]) => ({ base, quote })) },
    select: { base: true, quote: true, rateDate: true, rate: true, source: true },
  })
  return rows.map(rateRowOf)
}

/** The rate a document of `day` takes from `base` to `quote` (1 base = rate quote), or null (none near enough). */
export async function dayRate(db: Reader, base: string, quote: string, day: BusinessDate): Promise<DayRate | null> {
  if (base === quote) return dayRateFrom([], base, quote, day)
  return dayRateFrom(await rowsNear(db, pairsFor(base, quote), day, day), base, quote, day)
}

/** The rates of many days and currencies, read once: the day's rate of any pair on any day from `from` to `to`. */
export interface RateBook {
  rate(base: string, quote: string, day: BusinessDate): DayRate | null
}

/** Every stored rate from `from` − the lookback to `to`, for the day rates of those days (a list, a job, a total). */
export async function loadRateBook(db: Reader, from: BusinessDate, to: BusinessDate): Promise<RateBook> {
  const rows = (await db.exchangeRate.findMany({ where: { rateDate: { gte: dayValue(addDays(from, -LOOKBACK_DAYS)), lte: dayValue(to) } }, select: { base: true, quote: true, rateDate: true, rate: true, source: true } })).map(rateRowOf)
  return Object.freeze({ rate: (base: string, quote: string, day: BusinessDate) => dayRateFrom(rows, base, quote, day) })
}

/** Words for a missing rate: what the document waits for and where it is kept. */
export const noRateWords = (base: string, quote: string, day: BusinessDate): string =>
  `No exchange rate of ${base} to ${quote} for ${day} or the ${LOOKBACK_DAYS} days before: keep one in Finance › Settings › Currencies & rates (the ECB's daily rates, or a rate typed for the day).`

// ---- who may ----------------------------------------------------------------------------------------------------------

export function officeOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** The caller holds `permission` over this company. */
export const mayOnCompany = (context: OfficeContext, permission: Permission, companyId: string): boolean => can(actorOf(context), permission, { companyId })

/** The caller holds `permission` over every company (the tenant's rates, the daily ECB switch). */
export const mayOnEveryCompany = (context: OfficeContext, permission: Permission): boolean => can(actorOf(context), permission, {}) && grantsFor(actorOf(context), permission).some((grant) => grant.companies === 'all')

export function assertOnEveryCompany(context: OfficeContext, permission: Permission): void {
  if (!mayOnEveryCompany(context, permission)) throw new ForbiddenError('The exchange rates serve every company: they are changed only by a role over every company.')
}

// ---- refusals ------------------------------------------------------------------------------------------------------------

/** Why a currency or rate write is refused, as the issue path `refusal/<code>` (the web words each code itself). */
export const CURRENCY_REFUSALS = ['CURRENCY_ON', 'BASE_OFF', 'MANUAL_KEPT', 'MANUAL_GONE', 'ECB_ROW', 'FEED_OFF', 'ECB_UNREADABLE', 'DATABASE'] as const
export type CurrencyRefusal = (typeof CURRENCY_REFUSALS)[number]

/** A 409 in words with its refusal code. */
export const refused = (code: CurrencyRefusal, message: string): DomainError => new DomainError('conflict', message, [{ path: `refusal/${code}`, message }])

// ---- the database's refusals --------------------------------------------------------------------------------------------

const causeOf = (error: unknown) => (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown; constraint?: unknown } } } } | null)?.meta?.driverAdapterError?.cause

/**
 * The database's own refusal of a currency or rate write (…_tax_currency_w2b_guards: check_violation 'currency: …'; the
 * partial unique Currency_one_active; a rate's key twice), as a 409 in words, or null for anything else.
 */
export function currencyRefusal(error: unknown): DomainError | null {
  const cause = causeOf(error)
  const message = typeof cause?.originalMessage === 'string' ? cause.originalMessage : ''
  if (cause?.originalCode === '23514' && message.startsWith('currency: ')) {
    const words = message.slice('currency: '.length)
    return refused('DATABASE', `${words.charAt(0).toUpperCase()}${words.slice(1)}.`)
  }
  const code = (error as { code?: unknown } | null)?.code
  if (cause?.originalCode === '23505' || code === 'P2002') {
    if (/Currency_one_active/.test(message) || /Currency_one_active/.test(String((error as { meta?: { target?: unknown } }).meta?.target ?? ''))) return refused('CURRENCY_ON', "This currency is one of the company's currencies already.")
    if (/ExchangeRate/.test(message) || /key/.test(String((error as { meta?: { target?: unknown } }).meta?.target ?? ''))) return refused('MANUAL_KEPT', 'A rate of this kind is kept for that day already: correct it instead.')
  }
  return null
}

/** Runs a write and turns the database's currency refusals into 409s in words. */
export async function refusingInWords<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw currencyRefusal(error) ?? error
  }
}
