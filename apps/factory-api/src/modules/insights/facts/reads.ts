import type { Prisma } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { eachDay } from '@nexus/factory-domain/calendars/dates'
import { grantsFor, holds, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { levelFor, measureOf, type Measure } from '@nexus/factory-domain/insights/kpis/measures'
import { convertMinor } from '@nexus/factory-domain/money/currency/convert'
import { EURO } from '@nexus/factory-domain/money/currency/currencies'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { loadRateBook } from '../../../platform/currency/service'
import { factCompanies, type DayFact, type FactNumber } from './rows'
import { SOURCES } from './sources'

/**
 * The one read of the facts (B-W2b-428; ANA-070): every reader of a measure — a KPI's value (kpis/value.ts), Today's key
 * numbers, the facts list — sums it here, over periods (buckets of days) and a place (a company, a site, a line), within the
 * records the person reaches:
 *
 *   - the measure's own permission (its records' list) and money grain, or no value (NO_ACCESS, NEEDS_GRAIN), never 0;
 *   - the facts in the person's company and site scope (scopeWhere on the fact's companyId and, for site measures, siteId);
 *   - a person whose grant is limited to some customers reads a customer-bound measure (orders, shipments) LIVE: the same
 *     source the facts are rebuilt with, over their own records (`live: true`), since facts keep no customer;
 *   - money of several companies' currencies counts in the euro at each day's rate (`converted`); a day with no rate, or
 *     records a rebuild left out for want of a rate (the measure's `unconverted` count), make the period MIXED_CURRENCIES;
 *   - a FLOW measure sums the period's days; a BALANCE measure takes each place's last day of the period that has a fact;
 *   - `asOf` is the oldest rebuild among the facts read (now, when live); NOT_BUILT when the period has no fact at all.
 */

export interface Bucket {
  readonly from: BusinessDate
  readonly to: BusinessDate
}

export interface Place {
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
  readonly lineId?: string | undefined
}

export const MEASURE_PROBLEMS = ['NO_ACCESS', 'NEEDS_GRAIN', 'NOT_BUILT', 'MIXED_CURRENCIES'] as const
export type MeasureProblem = (typeof MEASURE_PROBLEMS)[number]

export interface MeasureReading {
  /** Per bucket: the sum (minor units for money), or null when it cannot be counted. */
  readonly values: (Decimal | null)[]
  readonly currency: string | null
  /** Currencies counted in `currency` at each day's rate. */
  readonly converted: string[]
  readonly asOf: Date | null
  readonly live: boolean
  /** Days of the buckets up to today that have no fact (not rebuilt yet). */
  readonly missingDays: number
  readonly problem: MeasureProblem | null
}

/** A fact after a turn as a plain row (from the table, or collected live). */
interface Row {
  readonly companyId: string
  readonly siteId: string | null
  readonly lineId: string | null
  readonly day: BusinessDate
  readonly amount: Decimal
  readonly currency: string | null
  readonly rebuiltAt: Date | null
}

const empty = (buckets: readonly Bucket[], problem: MeasureProblem): MeasureReading => ({ values: buckets.map(() => null), currency: null, converted: [], asOf: null, live: false, missingDays: 0, problem })

const amountOf = (number: FactNumber | { value?: unknown; priceAmount?: number | null; costAmount?: number | null; marginAmount?: number | null }): Decimal => {
  const row = number as { value?: unknown; priceAmount?: number | null; costAmount?: number | null; marginAmount?: number | null }
  if (row.value !== null && row.value !== undefined) return new Dec(String(row.value))
  return new Dec(row.priceAmount ?? row.costAmount ?? row.marginAmount ?? 0)
}

/** A person limited to some customers for this measure's list: the facts (no customer) cannot answer for them. */
const readsLive = (actor: Actor, measure: Measure): boolean => measure.partyScoped && grantsFor(actor, measure.permission).some((grant) => grant.parties !== 'all')

async function factRows(caller: CommandCaller, actor: Actor, measure: Measure, from: BusinessDate, to: BusinessDate, place: Place): Promise<Row[]> {
  const level = levelFor(measure, place)
  const scope = scopeWhere(actor, measure.permission, { company: 'companyId', ...(measure.levels.includes('COMPANY') ? {} : { site: 'siteId' }) }) as Prisma.FactDailyWhereInput
  const levelWhere: Prisma.FactDailyWhereInput = level === 'COMPANY' ? { siteId: null, lineId: null } : level === 'SITE' ? { siteId: { not: null }, lineId: null } : { lineId: place.lineId! }
  const rows = await caller.withClient((db) =>
    db.factDaily.findMany({
      where: {
        AND: [
          scope,
          levelWhere,
          { measureKey: measure.key, day: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) } },
          place.companyId ? { companyId: place.companyId } : {},
          place.siteId && level !== 'COMPANY' ? { siteId: place.siteId } : {},
        ],
      },
      select: { companyId: true, siteId: true, lineId: true, day: true, value: true, priceAmount: true, costAmount: true, marginAmount: true, currency: true, rebuiltAt: true },
    }),
  )
  return rows.map((row) => ({ companyId: row.companyId, siteId: row.siteId, lineId: row.lineId, day: row.day.toISOString().slice(0, 10), amount: amountOf(row), currency: row.currency, rebuiltAt: row.rebuiltAt }))
}

/** The same rows, collected now from the person's own records by the measure's source (never written). */
async function liveRows(caller: CommandCaller, actor: Actor, measure: Measure, from: BusinessDate, to: BusinessDate, place: Place): Promise<Row[]> {
  const where = scopeWhere(actor, measure.permission, { company: 'companyId', party: 'partyId' })
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const companies = (await factCompanies(db, place.companyId ? [place.companyId] : undefined)).filter((company) => grantsFor(actor, measure.permission).some((grant) => grant.companies === 'all' || grant.companies.includes(company.id)))
    const rates = await loadRateBook(db, from, to)
    const rows: Row[] = []
    for (const company of companies) {
      const collected = await SOURCES[measure.source](db, { company, from, to, now, rates, where })
      for (const fact of collected.daily.filter((entry: DayFact) => entry.measureKey === measure.key)) {
        rows.push({ companyId: fact.companyId, siteId: fact.siteId, lineId: fact.lineId, day: fact.day, amount: amountOf(fact.number), currency: 'value' in fact.number ? null : company.currency, rebuiltAt: null })
      }
    }
    return rows
  })
}

/** Reads some measures over buckets of days at a place, as one person (see the module comment). */
export async function readMeasures(caller: CommandCaller, actor: Actor, measureKeys: readonly string[], buckets: readonly Bucket[], place: Place = {}): Promise<Map<string, MeasureReading>> {
  const out = new Map<string, MeasureReading>()
  if (buckets.length === 0) {
    for (const key of measureKeys) out.set(key, { values: [], currency: null, converted: [], asOf: null, live: false, missingDays: 0, problem: null })
    return out
  }
  const from = buckets.map((bucket) => bucket.from).sort()[0]!
  const to = buckets.map((bucket) => bucket.to).sort().at(-1)!
  const today = businessDate(serverClock.now())
  const grains = heldGrains(actor)
  for (const key of measureKeys) {
    const measure = measureOf(key)
    if (!measure || !holds(actor, measure.permission)) {
      out.set(key, empty(buckets, 'NO_ACCESS'))
      continue
    }
    if (measure.grain && !grains.has(measure.grain)) {
      out.set(key, empty(buckets, 'NEEDS_GRAIN'))
      continue
    }
    const live = readsLive(actor, measure)
    const read = (entry: Measure) => (live ? liveRows(caller, actor, entry, from, to < today ? to : today, place) : factRows(caller, actor, entry, from, to, place))
    const rows = await read(measure)
    const unconverted = measure.unconverted ? await read(measureOf(measure.unconverted)!) : []
    out.set(key, await sumRows(caller, measure, rows, unconverted, buckets, today, live, levelFor(measure, place) === 'LINE'))
  }
  return out
}

async function sumRows(caller: CommandCaller, measure: Measure, rows: readonly Row[], unconverted: readonly Row[], buckets: readonly Bucket[], today: BusinessDate, live: boolean, lines: boolean): Promise<MeasureReading> {
  const asked = new Set(buckets.flatMap((bucket) => eachDay(bucket.from, bucket.to < today ? bucket.to : today)))
  const seen = new Set(rows.map((row) => row.day))
  const missingDays = [...asked].filter((day) => !seen.has(day)).length
  if (rows.length === 0 && !live) return { values: buckets.map(() => null), currency: null, converted: [], asOf: null, live, missingDays, problem: 'NOT_BUILT' }
  const currencies = [...new Set(rows.flatMap((row) => (row.currency ? [row.currency] : [])))].sort()
  let currency: string | null = currencies[0] ?? null
  let counted = rows as Row[]
  let converted: string[] = []
  let unratedDays = new Set<string>()
  if (measure.unit === 'MONEY' && currencies.length > 1) {
    const days = rows.map((row) => row.day).sort()
    const book = await caller.withClient((db) => loadRateBook(db, days[0]!, days.at(-1)!))
    currency = EURO
    converted = currencies.filter((code) => code !== EURO)
    counted = []
    for (const row of rows) {
      if (row.currency === EURO || row.amount.isZero()) {
        counted.push({ ...row, currency: EURO })
        continue
      }
      const rate = book.rate(EURO, row.currency!, row.day)
      if (!rate) {
        unratedDays.add(row.day)
        continue
      }
      counted.push({ ...row, currency: EURO, amount: new Dec(convertMinor(Number.parseInt(row.amount.toFixed(0), 10), row.currency!, EURO, rate)) })
    }
  }
  for (const row of unconverted) if (row.amount.gt(0)) unratedDays = new Set([...unratedDays, row.day])
  const inBucket = (bucket: Bucket) => (row: Row) => row.day >= bucket.from && row.day <= bucket.to
  let mixed = false
  const values = buckets.map((bucket) => {
    if ([...unratedDays].some((day) => day >= bucket.from && day <= bucket.to)) {
      mixed = true
      return null
    }
    const mine = counted.filter(inBucket(bucket))
    // A company or site keeps a row for every day rebuilt (zeros too): a period without one was never rebuilt. A line keeps
    // rows only for what it counted, so its quiet periods are 0.
    if (mine.length === 0 && !lines && !live && !rows.some(inBucket(bucket))) return null
    if (measure.kind === 'FLOW') return mine.reduce((total, row) => total.plus(row.amount), new Dec(0))
    // BALANCE: each place's last day of the period that has a fact.
    const last = new Map<string, Row>()
    for (const row of mine) {
      const place = `${row.companyId}|${row.siteId ?? ''}|${row.lineId ?? ''}`
      const before = last.get(place)
      if (!before || row.day > before.day) last.set(place, row)
    }
    return [...last.values()].reduce((total, row) => total.plus(row.amount), new Dec(0))
  })
  const stamps = rows.flatMap((row) => (row.rebuiltAt ? [row.rebuiltAt.getTime()] : []))
  return {
    values,
    currency: measure.unit === 'MONEY' ? currency : null,
    converted,
    asOf: live ? serverClock.now() : stamps.length > 0 ? new Date(Math.min(...stamps)) : null,
    live,
    missingDays,
    problem: mixed ? 'MIXED_CURRENCIES' : null,
  }
}

/** A reading's freshness: facts older than this are stale (design: tiles turn "stale" after 3 hours). */
export const STALE_AFTER_MS = 3 * 60 * 60_000
export const isStale = (asOf: Date | null, now: Date = serverClock.now()): boolean => asOf !== null && now.getTime() - asOf.getTime() > STALE_AFTER_MS
