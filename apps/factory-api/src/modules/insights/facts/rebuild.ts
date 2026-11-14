import type { Prisma } from '@nexus/factory-db'
import { daysFrom, plusDays } from '@nexus/factory-domain/calendars/dates'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, isBusinessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { MEASURE_SOURCES, measuresOfSource, type MeasureSource } from '@nexus/factory-domain/insights/kpis/measures'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { loadRateBook } from '../../../platform/currency/service'
import { dailyKey, factCompanies, hourlyKey, type Collected, type FactCompany, type Reader } from './rows'
import { SOURCES } from './sources'

/**
 * Rebuilding the facts from the records (B-W2b-428; ANA-069 reporting projections "rebuildable from the ledgers"): for each
 * company, its sources read the days (outside any transaction: reads only), then ONE command per call takes a lock per
 * company, deletes those days' facts of those sources' measures and writes what was read, every row stamped with the
 * command's time (rebuiltAt). Safe to run twice, or at once from the hour's rebuild, an event and a person: the lock makes
 * them one after the other and each writes the whole range again. Days are cut at each place's midnight (a site's day on its
 * clock); nothing is written for a day or hour that has not begun.
 *
 *   by the hour      today and yesterday of every company (cron insights.factsHourly)
 *   by night         the 35 days before (cron insights.factsNightly): corrections and late postings of older days
 *   after an event   the event's company, its day, only the sources the event changes (handler insights.facts; at most
 *                    every 5 minutes per company, day and source — the hour's rebuild catches the rest)
 *   by a person      POST /insights/facts/rebuild: up to 93 days of every company, or of one
 */

export const REBUILD_MAX_DAYS = 93
/** The facts of the last minute are left to the next rebuild (the database's clock may run a little behind the server's). */
const SETTLE_MS = 60_000

export const REBUILD_TRIGGERS = ['HOURLY', 'NIGHTLY', 'EVENT', 'PERSON'] as const
export type RebuildTrigger = (typeof REBUILD_TRIGGERS)[number]

export interface RebuildRequest {
  readonly from: BusinessDate
  readonly to: BusinessDate
  readonly companyIds?: readonly string[]
  readonly sources?: readonly MeasureSource[]
  readonly trigger: RebuildTrigger
  readonly idempotencyKey?: string | null | undefined
  readonly causationId?: string
}

export interface RebuildOutcome {
  readonly from: BusinessDate
  readonly to: BusinessDate
  readonly sources: MeasureSource[]
  readonly rebuiltAt: string
  readonly companies: { readonly companyId: string; readonly daily: number; readonly hourly: number }[]
}

/** What the sources read for one company and some days. */
export async function collectFacts(db: Reader, company: FactCompany, from: BusinessDate, to: BusinessDate, sources: readonly MeasureSource[], now: Date): Promise<Collected> {
  const rates = await loadRateBook(db, from, to)
  const collected: Collected = { daily: [], hourly: [] }
  for (const source of sources) {
    const part = await SOURCES[source](db, { company, from, to, now, rates })
    collected.daily.push(...part.daily)
    collected.hourly.push(...part.hourly)
  }
  return collected
}

const atMidnight = (day: BusinessDate) => new Date(`${day}T00:00:00.000Z`)

/** Writes the facts read, in the command: per company, a lock, then its days' facts of those measures deleted and written. */
async function writeFacts(tools: CommandTools, parts: readonly { company: FactCompany; collected: Collected }[], request: { from: BusinessDate; to: BusinessDate; sources: readonly MeasureSource[]; trigger: RebuildTrigger }) {
  const measureKeys = request.sources.flatMap((source) => measuresOfSource(source).map((measure) => measure.key))
  const days = { gte: atMidnight(request.from), lte: atMidnight(request.to) }
  const out: { companyId: string; daily: number; hourly: number }[] = []
  const tenantId = 'tenantId' in tools.context ? tools.context.tenantId : ''
  // The database refuses a fact of a day that has not begun on its own clock (each place's zone). When the app's clock runs
  // ahead of it (a test world moved on, a clock drift), those days wait for a later rebuild instead of failing the command.
  const [{ now: databaseNow }] = await tools.tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`
  for (const { company, collected: read } of parts) {
    const zoneOf = (siteId: string | null) => company.sites.find((site) => site.id === siteId)?.timezone ?? company.timezone
    const begun = (fact: { day: BusinessDate; siteId: string | null }) => fact.day <= businessDate(databaseNow, zoneOf(fact.siteId))
    const collected: Collected = { daily: read.daily.filter(begun), hourly: read.hourly.filter((fact) => begun(fact) && fact.hourStart <= databaseNow) }
    await tools.tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.facts', ${tenantId}::text, ${company.id}::text), 0))`
    await tools.tx.factDaily.deleteMany({ where: { companyId: company.id, day: days, measureKey: { in: measureKeys } } })
    await tools.tx.factHourly.deleteMany({ where: { companyId: company.id, day: days, measureKey: { in: measureKeys } } })
    const currencyOf = (number: object) => ('value' in number ? {} : { currency: company.currency })
    if (collected.daily.length > 0) {
      await tools.tx.factDaily.createMany({
        data: collected.daily.map((fact) => ({ id: newId(), companyId: fact.companyId, siteId: fact.siteId, lineId: fact.lineId, day: atMidnight(fact.day), measureKey: fact.measureKey, key: dailyKey(fact), ...fact.number, ...currencyOf(fact.number), rebuiltAt: tools.now }) satisfies Prisma.FactDailyCreateManyInput),
      })
    }
    if (collected.hourly.length > 0) {
      await tools.tx.factHourly.createMany({
        data: collected.hourly.map((fact) => ({ id: newId(), companyId: fact.companyId, siteId: fact.siteId, lineId: fact.lineId, hourStart: fact.hourStart, day: atMidnight(fact.day), measureKey: fact.measureKey, key: hourlyKey(fact), ...fact.number, ...currencyOf(fact.number), rebuiltAt: tools.now }) satisfies Prisma.FactHourlyCreateManyInput),
      })
    }
    // Counts and days only: the facts' numbers stay in their tables (money never in an audit row here).
    tools.audit({ action: 'insights.factsRebuilt', recordType: 'Company', recordId: company.id, companyId: company.id, after: { from: request.from, to: request.to, sources: [...request.sources], daily: collected.daily.length, hourly: collected.hourly.length, trigger: request.trigger } })
    tools.emit({ type: 'facts.rebuilt', subject: company.id, companyId: company.id, payload: { companyId: company.id, from: request.from, to: request.to, sources: [...request.sources], daily: collected.daily.length, hourly: collected.hourly.length, trigger: request.trigger } })
    out.push({ companyId: company.id, daily: collected.daily.length, hourly: collected.hourly.length })
  }
  return out
}

/** Checks a range a person asks for: real days, in order, at most 93 days, not after today. */
export function checkRange(from: BusinessDate, to: BusinessDate, today: BusinessDate): void {
  if (!isBusinessDate(from) || !isBusinessDate(to)) throw new ValidationError('Give the first and last day as YYYY-MM-DD.', [{ path: 'body/from', message: 'Expected a calendar day.' }])
  if (to < from) throw new ValidationError('The last day comes after the first.', [{ path: 'body/to', message: 'Not before the first day.' }])
  if (to > plusDays(today, 1)) throw new ValidationError('Days that have not begun have no figures yet.', [{ path: 'body/to', message: 'Today at the latest.' }])
  if (daysFrom(from, to) + 1 > REBUILD_MAX_DAYS) throw new ValidationError(`At most ${REBUILD_MAX_DAYS} days at a time.`, [{ path: 'body/from', message: `At most ${REBUILD_MAX_DAYS} days.` }])
}

/** Rebuilds the facts of some days: every company of the tenant (or those named), every source (or those named). */
export async function rebuildFacts(caller: CommandCaller, request: RebuildRequest): Promise<RebuildOutcome> {
  const now = new Date(serverClock.now().getTime() - SETTLE_MS)
  const sources = request.sources ? MEASURE_SOURCES.filter((source) => request.sources!.includes(source)) : [...MEASURE_SOURCES]
  const parts = await caller.withClient(async (db) => {
    const companies = await factCompanies(db, request.companyIds)
    const read: { company: FactCompany; collected: Collected }[] = []
    for (const company of companies) read.push({ company, collected: await collectFacts(db, company, request.from, request.to, sources, now) })
    return read
  })
  if (parts.length === 0) return { from: request.from, to: request.to, sources, rebuiltAt: serverClock.now().toISOString(), companies: [] }
  const { result } = await command(
    caller,
    {
      name: 'insights.factsRebuild',
      input: { from: request.from, to: request.to, companyIds: request.companyIds ?? null, sources, trigger: request.trigger },
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      ...(request.causationId ? { causationId: request.causationId } : {}),
    },
    async (tools) => ({ rebuiltAt: tools.now.toISOString(), companies: await writeFacts(tools, parts, { from: request.from, to: request.to, sources, trigger: request.trigger }) }),
  )
  return { from: request.from, to: request.to, sources, ...result }
}
