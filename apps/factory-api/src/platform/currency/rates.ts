import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { CURRENCIES_MANAGE, CURRENCIES_VIEW } from '@nexus/factory-domain/money/currency/permissions'
import { addDays, farFromEcb, manualRateProblem, normalRate, rateKey, rateWords } from '@nexus/factory-domain/money/currency/rates'
import { command, type CommandCaller } from '../../core/command'
import { actorOf } from '../../core/context'
import { serverClock } from '../../core/time'
import { dayRateView, type DayRateView } from './currencies'
import { assertOnEveryCompany, dayRate, dayText, dayValue, mayOnEveryCompany, noRateWords, officeOf, RATE_COLUMNS, refused, refusingInWords, type Reader, type StoredRate } from './store'

/**
 * The rates table (B-W2b-389; PLT-133; design finance.settings "Currencies & rates": daily ECB rates, manual override per
 * date): the tenant's rates per day (one table for every company), the ECB's and the manual one side by side with the rate
 * that day's documents take. Reads: currencies.view (any company). A manual rate of a day is kept, corrected or removed
 * (the day then falls back to the ECB's) by currencies.manage over every company, ONE command each (a correction or a
 * removal names the row's version); ECB rows are never changed (the database refuses it too). No future day.
 *
 *   GET    /exchange-rates?quote&source&from&to          the days (newest first), each base/quote with both rates
 *   GET    /exchange-rates/day?base&quote&day            the rate a document of that day takes, or why none
 *   PUT    /exchange-rates/manual {base?, quote, day, rate, version?}    a manual rate of a day kept or corrected
 *   DELETE /exchange-rates/manual/:rateId?version=       a manual rate removed
 */

/** A row of the table: one base, quote and day. */
export interface RateDayView {
  readonly key: string
  readonly base: string
  readonly quote: string
  readonly day: BusinessDate
  readonly ecb: { readonly id: string; readonly rate: string } | null
  readonly manual: { readonly id: string; readonly rate: string; readonly version: number; readonly overriddenBy: { readonly id: string; readonly name: string } | null; readonly updatedAt: string } | null
  /** The rate that day's documents take, and from where. */
  readonly rate: string
  readonly source: 'ECB' | 'MANUAL'
  readonly words: string
  /** The manual rate is more than 5 % away from the ECB's of the day (a typing slip is likely). */
  readonly farFromEcb: boolean
}

const MAX_DAYS = 400
const MAX_ROWS = 5000

function mayView(caller: CommandCaller) {
  const context = officeOf(caller)
  if (!can(actorOf(context), CURRENCIES_VIEW, {})) throw new ForbiddenError()
  return context
}

async function namesOf(db: Reader, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const users = await db.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, displayName: true } })
  return new Map(users.map((user) => [user.id, user.displayName]))
}

function daysOf(rows: readonly StoredRate[], names: ReadonlyMap<string, string>): RateDayView[] {
  const groups = new Map<string, { base: string; quote: string; day: BusinessDate; ecb: StoredRate | null; manual: StoredRate | null }>()
  for (const row of rows) {
    const day = dayText(row.rateDate)
    const key = `${row.base}:${row.quote}:${day}`
    const group = groups.get(key) ?? { base: row.base, quote: row.quote, day, ecb: null, manual: null }
    if (row.source === 'ECB') group.ecb = row
    else group.manual = row
    groups.set(key, group)
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const effective = (group.manual ?? group.ecb)!
      const rate = effective.rate.toString()
      return {
        key,
        base: group.base,
        quote: group.quote,
        day: group.day,
        ecb: group.ecb ? { id: group.ecb.id, rate: group.ecb.rate.toString() } : null,
        manual: group.manual
          ? { id: group.manual.id, rate: group.manual.rate.toString(), version: group.manual.version, overriddenBy: group.manual.overriddenById ? { id: group.manual.overriddenById, name: names.get(group.manual.overriddenById) ?? '—' } : null, updatedAt: toUtcIso(group.manual.updatedAt) }
          : null,
        rate,
        source: group.manual ? ('MANUAL' as const) : ('ECB' as const),
        words: rateWords({ base: group.base, quote: group.quote, rate }),
        farFromEcb: group.manual ? farFromEcb(group.manual.rate.toString(), group.ecb?.rate.toString() ?? null) : false,
      }
    })
    .sort((a, b) => (a.day === b.day ? (a.quote === b.quote ? a.base.localeCompare(b.base) : a.quote.localeCompare(b.quote)) : b.day.localeCompare(a.day)))
}

export interface RatesQuery {
  readonly quote?: string | undefined
  readonly source?: 'ECB' | 'MANUAL' | undefined
  readonly from?: string | undefined
  readonly to?: string | undefined
}

/** GET /exchange-rates: the days from `from` (default 30 days ago) to `to` (default today), newest first. */
export async function listRates(caller: CommandCaller, query: RatesQuery): Promise<{ days: RateDayView[]; from: BusinessDate; to: BusinessDate; today: BusinessDate; truncated: boolean; canManage: boolean }> {
  const context = mayView(caller)
  const today = businessDate(serverClock.now())
  const to = query.to ?? today
  const from = query.from ?? addDays(to, -30)
  if (from > to) throw new ValidationError('The first day comes before the last.', [{ path: 'querystring/from', message: 'On or before the last day.' }])
  if (addDays(from, MAX_DAYS) < to) throw new ValidationError(`At most ${MAX_DAYS} days at a time.`, [{ path: 'querystring/from', message: `At most ${MAX_DAYS} days before the last day.` }])
  const where: Prisma.ExchangeRateWhereInput = { rateDate: { gte: dayValue(from), lte: dayValue(to) }, ...(query.quote ? { OR: [{ quote: query.quote }, { base: query.quote }] } : {}) }
  return caller.withClient(async (db) => {
    const rows = await db.exchangeRate.findMany({ where, select: RATE_COLUMNS, orderBy: [{ rateDate: 'desc' }, { quote: 'asc' }, { source: 'asc' }, { id: 'asc' }], take: MAX_ROWS + 1 })
    const page = rows.slice(0, MAX_ROWS)
    const names = await namesOf(db, page.flatMap((row) => (row.overriddenById ? [row.overriddenById] : [])))
    const days = daysOf(page, names).filter((entry) => (query.source ? entry.source === query.source || (query.source === 'MANUAL' && entry.manual !== null) : true))
    return { days, from, to, today, truncated: rows.length > MAX_ROWS, canManage: mayOnEveryCompany(context, CURRENCIES_MANAGE) }
  })
}

/** GET /exchange-rates/day: the rate a document of the day takes (base default EUR, day default today). */
export async function rateOfDay(caller: CommandCaller, query: { readonly base?: string | undefined; readonly quote: string; readonly day?: string | undefined }): Promise<{ rate: DayRateView | null; waits: string | null; day: BusinessDate }> {
  mayView(caller)
  const day = query.day ?? businessDate(serverClock.now())
  const base = query.base ?? 'EUR'
  const rate = await caller.withClient((db) => dayRate(db, base, query.quote, day))
  return { rate: rate ? dayRateView(rate) : null, waits: rate ? null : noRateWords(base, query.quote, day), day }
}

async function dayRowOf(db: Reader, base: string, quote: string, day: BusinessDate): Promise<RateDayView> {
  const rows = await db.exchangeRate.findMany({ where: { base, quote, rateDate: dayValue(day) }, select: RATE_COLUMNS })
  return daysOf(rows, await namesOf(db, rows.flatMap((row) => (row.overriddenById ? [row.overriddenById] : []))))[0]!
}

/** PUT /exchange-rates/manual: keeps (or corrects, with the row's version) the manual rate of a day. */
export async function setManualRate(caller: CommandCaller, body: { readonly base?: string | undefined; readonly quote: string; readonly day: string; readonly rate: string; readonly version?: number | undefined }, idempotencyKey?: string): Promise<{ day: RateDayView }> {
  const context = officeOf(caller)
  assertOnEveryCompany(context, CURRENCIES_MANAGE)
  const base = (body.base ?? 'EUR').trim().toUpperCase()
  const quote = body.quote.trim().toUpperCase()
  const today = businessDate(serverClock.now())
  const problem = manualRateProblem({ base, quote, day: body.day, rate: body.rate }, today)
  if (problem) throw new ValidationError(problem.message, [{ path: `body/${problem.path}`, message: problem.message }])
  const rate = normalRate(body.rate)!
  const key = rateKey({ base, quote, rateDate: body.day, source: 'MANUAL' })
  const existing = await caller.withClient((db) => db.exchangeRate.findFirst({ where: { key }, select: RATE_COLUMNS }))
  if (existing && body.version === undefined) throw refused('MANUAL_KEPT', `A manual rate of ${base} to ${quote} for ${body.day} is kept already (${rateWords({ base, quote, rate: existing.rate.toString() })}): correct that one.`)
  if (!existing && body.version !== undefined) throw refused('MANUAL_GONE', 'That manual rate is not kept any more: reload the rates.')
  const { result } = await refusingInWords(() =>
    command(caller, { name: 'currency.setManualRate', idempotencyKey, input: { base, quote, day: body.day, rate }, ...(existing ? { record: { type: 'ExchangeRate' as const, id: existing.id, expectedVersion: body.version } } : {}) }, async (tools) => {
      const { tx, now } = tools
      const actorId = context.actorId
      let id: string
      if (existing) {
        id = existing.id
        await tx.exchangeRate.update({ where: { id }, data: { rate, overriddenById: actorId, updatedAt: now }, select: { id: true } })
      } else {
        id = newId()
        await tx.exchangeRate.create({ data: { id, base, quote, rateDate: dayValue(body.day), rate, source: 'MANUAL', overriddenById: actorId, key, createdAt: now, updatedAt: now, createdById: actorId }, select: { id: true } })
      }
      tools.audit({ recordType: 'ExchangeRate', recordId: id, companyId: null, before: existing ? { rate: existing.rate.toString() } : null, after: { base, quote, day: body.day, source: 'MANUAL', rate, words: rateWords({ base, quote, rate }) } })
      tools.emit({ type: 'currency.rates_changed', subject: id, companyId: null, payload: { action: 'MANUAL_SET', days: [body.day], quote, rows: 1 } })
      return dayRowOf(tx, base, quote, body.day)
    }),
  )
  return { day: result }
}

/** DELETE /exchange-rates/manual/:rateId?version=: the day falls back to the ECB's rate. */
export async function removeManualRate(caller: CommandCaller, rateId: string, query: { readonly version: number }, idempotencyKey?: string): Promise<{ day: RateDayView | null }> {
  const context = officeOf(caller)
  assertOnEveryCompany(context, CURRENCIES_MANAGE)
  const row = isUuid(rateId) ? await caller.withClient((db) => db.exchangeRate.findUnique({ where: { id: rateId }, select: RATE_COLUMNS })) : null
  if (!row) throw new NotFoundError('Rate not found.')
  if (row.source !== 'MANUAL') throw refused('ECB_ROW', "This is the ECB's rate of the day: it is kept as the ECB published it. Type a manual rate for the day instead.")
  const day = dayText(row.rateDate)
  const { result } = await refusingInWords(() =>
    command(caller, { name: 'currency.removeManualRate', idempotencyKey, input: { rateId }, record: { type: 'ExchangeRate', id: rateId, expectedVersion: query.version } }, async (tools) => {
      const { tx } = tools
      await tx.exchangeRate.delete({ where: { id: rateId }, select: { id: true } })
      tools.audit({ recordType: 'ExchangeRate', recordId: rateId, companyId: null, before: { base: row.base, quote: row.quote, day, source: 'MANUAL', rate: row.rate.toString() }, after: null })
      tools.emit({ type: 'currency.rates_changed', subject: rateId, companyId: null, payload: { action: 'MANUAL_REMOVED', days: [day], quote: row.quote, rows: 1 } })
      const left = await tx.exchangeRate.count({ where: { base: row.base, quote: row.quote, rateDate: row.rateDate } })
      return left > 0 ? dayRowOf(tx, row.base, row.quote, day) : null
    }),
  )
  return { day: result }
}
