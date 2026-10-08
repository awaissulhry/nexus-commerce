/**
 * BID BRAIN BB-16 — the Marketing Stream's Sponsored Products hours at ad group × placement grain: the writer, the read
 * helpers the bid brain loaders and the money brain use, and the retention prune.
 *
 * WRITE (ingestPlacementGrain, called by ingestMarketingStream after its campaign-grain loop, which it does not touch)
 *   One statement per record (ams-grain.ts parses it), in the record's business (the ingest already runs inside it):
 *     1. the row-count guard — a record that would CREATE a row is refused when the data day already holds
 *        NEXUS_AMS_GRAIN_MAX_ROWS_PER_DAY rows (default 10,000; about 4 × this business's estimate); a record for an
 *        existing row always applies. A correction (a negative delta) never creates a row: with nothing to correct it is
 *        refused as "no baseline", as the campaign-grain ingest refuses it.
 *     2. the row upsert adds the deltas and the record's key ONLY when the key is not already in `appliedKeys`. The check
 *        is in the ON CONFLICT … WHERE, evaluated on the locked, newest row: two deliveries of one record at once add
 *        once; two different records at once both add (no lost update). The sums are exact — never clamped.
 *     3. the arrival log adds the same deltas to the row's (kind, age bucket), only when step 2 applied.
 *   A record that changes nothing, a duplicate and every refusal write nothing (Neon cost: only changed rows).
 *   NEXUS_AMS_GRAIN_ENABLED=0 stops the writer; the campaign grain carries on as before.
 *
 * READ (loadPlacementHours)
 *   Per campaign × placement × hour, for today and the last N days (default 14) in the caller's time zone: impressions,
 *   clicks, spend, 1-day and 7-day orders and sales. Rows are keyed by Amazon's ids; the caller passes Campaign.id.
 *   A cell whose sum is negative for a moment (a correction arrived before its original) reads 0 and is counted; cells
 *   built from a late first delta are counted too, so a reader can say what it does not know.
 *
 * KEEP (cleanupOldPlacementHours): 90 days, in the weekly ads cleanup cron (clustered, once per business).
 */
import { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { isoDayIn, isKnownTimeZone } from './ads-local-day.js'
import { GRAIN_DAYS_KEPT, parseGrainRecord, type GrainDelta, type GrainRefusal } from './ams-grain.js'

export const DEFAULT_GRAIN_MAX_ROWS_PER_DAY = 10_000

/** The row-count guard's ceiling: new rows per business per data day. */
export function grainRowCap(): number {
  const raw = Number(process.env.NEXUS_AMS_GRAIN_MAX_ROWS_PER_DAY)
  return process.env.NEXUS_AMS_GRAIN_MAX_ROWS_PER_DAY != null && process.env.NEXUS_AMS_GRAIN_MAX_ROWS_PER_DAY !== '' && Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_GRAIN_MAX_ROWS_PER_DAY
}

export const grainEnabled = (): boolean => process.env.NEXUS_AMS_GRAIN_ENABLED !== '0'

export interface GrainIngestResult {
  received: number
  /** Records added to a row (created + added to an existing one). */
  applied: number
  /** Rows created. */
  created: number
  /** Records whose key the row already held: nothing added. */
  duplicates: number
  /** Corrections with no row to correct. */
  noBaseline: number
  /** Records refused by the row-count guard (they would have created a row). */
  capped: number
  malformed: number
  noIdempotencyKey: number
  tooOld: number
  zero: number
  /** Not sp-traffic / sp-conversion (Brands and Display keep the campaign grain only). */
  notGrain: number
  /** The write failed (logged); the campaign grain is not affected. */
  failed: number
}

const emptyResult = (received: number): GrainIngestResult => ({
  received, applied: 0, created: 0, duplicates: 0, noBaseline: 0, capped: 0, malformed: 0, noIdempotencyKey: 0, tooOld: 0, zero: 0, notGrain: 0, failed: 0,
})

// One warning per reason per 10 minutes per process: the live forwarder posts one record at a time, and a shape Amazon
// changed would otherwise log every record.
const WARN_EVERY_MS = 10 * 60_000
const lastWarn = new Map<string, { at: number; suppressed: number }>()
function warnOnce(reason: string, message: string, context: Record<string, unknown>, now = Date.now()): void {
  const seen = lastWarn.get(reason)
  if (seen && now - seen.at < WARN_EVERY_MS) { seen.suppressed += 1; return }
  logger.warn(message, { ...context, ...(seen?.suppressed ? { alsoSinceLastWarning: seen.suppressed } : {}) })
  lastWarn.set(reason, { at: now, suppressed: 0 })
}

type ApplyState = 'exists' | 'new' | 'no_baseline' | 'capped'

/** One record into its row and its arrival bucket, in one statement. */
async function applyDelta(d: GrainDelta, arrivedAt: Date, cap: number): Promise<{ state: ApplyState; applied: boolean; inserted: boolean }> {
  const at = arrivedAt.toISOString()
  const rows = await prisma.$queryRaw<Array<{ state: ApplyState; applied: boolean; inserted: boolean | null }>>(Prisma.sql`
    WITH cap AS (
      SELECT CASE
        WHEN EXISTS (
          SELECT 1 FROM "AmazonAdsHourlyPlacement" t
           WHERE t."campaignId" = ${d.campaignId}::text AND t."adGroupId" = ${d.adGroupId}::text AND t."placement" = ${d.placement}::text
             AND t."date" = ${d.date}::date AND t."hour" = ${d.hour}::int
        ) THEN 'exists'
        WHEN ${d.negative}::boolean THEN 'no_baseline'
        WHEN (SELECT count(*) FROM "AmazonAdsHourlyPlacement" t WHERE t."date" = ${d.date}::date) >= ${cap}::int THEN 'capped'
        ELSE 'new'
      END AS state
    ), g AS (
      INSERT INTO "AmazonAdsHourlyPlacement" AS t (
        "id", "profileId", "marketplace", "campaignId", "adGroupId", "placement", "date", "hour", "currencyCode",
        "impressions", "clicks", "costMicros", "orders1d", "orders7d", "units1d", "units7d", "sales1dCents", "sales7dCents",
        "appliedKeys", "lateStart", "firstArrivalAt", "lastArrivalAt")
      SELECT gen_random_uuid()::text, ${d.profileId}::text, ${d.marketplace}::text, ${d.campaignId}::text, ${d.adGroupId}::text,
        ${d.placement}::text, ${d.date}::date, ${d.hour}::int, ${d.currencyCode}::text,
        ${d.impressions}::int, ${d.clicks}::int, ${d.costMicros}::bigint, ${d.orders1d}::int, ${d.orders7d}::int,
        ${d.units1d}::int, ${d.units7d}::int, ${d.sales1dCents}::int, ${d.sales7dCents}::int,
        ARRAY[${d.key}::bigint], ${d.late}::boolean,
        (${at}::timestamptz AT TIME ZONE 'UTC'), (${at}::timestamptz AT TIME ZONE 'UTC')
      FROM cap WHERE cap.state IN ('exists', 'new')
      ON CONFLICT ("workspaceId", "campaignId", "adGroupId", "placement", "date", "hour") DO UPDATE SET
        "impressions"    = t."impressions" + EXCLUDED."impressions",
        "clicks"         = t."clicks" + EXCLUDED."clicks",
        "costMicros"     = t."costMicros" + EXCLUDED."costMicros",
        "orders1d"       = t."orders1d" + EXCLUDED."orders1d",
        "orders7d"       = t."orders7d" + EXCLUDED."orders7d",
        "units1d"        = t."units1d" + EXCLUDED."units1d",
        "units7d"        = t."units7d" + EXCLUDED."units7d",
        "sales1dCents"   = t."sales1dCents" + EXCLUDED."sales1dCents",
        "sales7dCents"   = t."sales7dCents" + EXCLUDED."sales7dCents",
        "appliedKeys"    = array_append(COALESCE(t."appliedKeys", '{}'::bigint[]), ${d.key}::bigint),
        "firstArrivalAt" = LEAST(t."firstArrivalAt", EXCLUDED."firstArrivalAt"),
        "lastArrivalAt"  = GREATEST(t."lastArrivalAt", EXCLUDED."lastArrivalAt"),
        "profileId"      = COALESCE(t."profileId", EXCLUDED."profileId"),
        "marketplace"    = COALESCE(t."marketplace", EXCLUDED."marketplace"),
        "currencyCode"   = COALESCE(t."currencyCode", EXCLUDED."currencyCode")
      WHERE NOT (${d.key}::bigint = ANY(COALESCE(t."appliedKeys", '{}'::bigint[])))
      RETURNING t."id", (t.xmax = 0) AS inserted
    ), a AS (
      INSERT INTO "AmazonAdsHourlyArrival" AS x (
        "id", "grainId", "date", "kind", "ageHours", "records",
        "impressions", "clicks", "costMicros", "orders1d", "orders7d", "units1d", "units7d", "sales1dCents", "sales7dCents",
        "firstAt", "lastAt")
      SELECT gen_random_uuid()::text, g."id", ${d.date}::date, ${d.kind}::text, ${d.ageHours}::int, 1,
        ${d.impressions}::int, ${d.clicks}::int, ${d.costMicros}::bigint, ${d.orders1d}::int, ${d.orders7d}::int,
        ${d.units1d}::int, ${d.units7d}::int, ${d.sales1dCents}::int, ${d.sales7dCents}::int,
        (${at}::timestamptz AT TIME ZONE 'UTC'), (${at}::timestamptz AT TIME ZONE 'UTC')
      FROM g
      ON CONFLICT ("workspaceId", "grainId", "kind", "ageHours") DO UPDATE SET
        "records"      = x."records" + 1,
        "impressions"  = x."impressions" + EXCLUDED."impressions",
        "clicks"       = x."clicks" + EXCLUDED."clicks",
        "costMicros"   = x."costMicros" + EXCLUDED."costMicros",
        "orders1d"     = x."orders1d" + EXCLUDED."orders1d",
        "orders7d"     = x."orders7d" + EXCLUDED."orders7d",
        "units1d"      = x."units1d" + EXCLUDED."units1d",
        "units7d"      = x."units7d" + EXCLUDED."units7d",
        "sales1dCents" = x."sales1dCents" + EXCLUDED."sales1dCents",
        "sales7dCents" = x."sales7dCents" + EXCLUDED."sales7dCents",
        "firstAt"      = LEAST(x."firstAt", EXCLUDED."firstAt"),
        "lastAt"       = GREATEST(x."lastAt", EXCLUDED."lastAt")
      RETURNING 1
    )
    SELECT cap.state, (g."id" IS NOT NULL) AS applied, COALESCE(g.inserted, false) AS inserted FROM cap LEFT JOIN g ON true
  `)
  const row = rows[0]
  return { state: row?.state ?? 'capped', applied: !!row?.applied, inserted: !!row?.inserted }
}

/**
 * Add a batch of Marketing Stream records to the ad group × placement grain. Runs inside the business the records were
 * routed to (the caller's). `arrivedAt` is when they reached Nexus (default now); `marketplaceOf` is the campaign-grain
 * ingest's marketplace mapping. Never throws: a failed record is counted and logged.
 */
export async function ingestPlacementGrain(
  records: ReadonlyArray<Record<string, unknown>>,
  opts: { arrivedAt?: Date; marketplaceOf: (raw: string) => string },
): Promise<GrainIngestResult | null> {
  if (!grainEnabled()) return null
  const result = emptyResult(records.length)
  const arrivedAt = opts.arrivedAt ?? new Date()
  const cap = grainRowCap()
  const refused: Partial<Record<GrainRefusal, string>> = {}
  for (const rec of records) {
    const parsed = parseGrainRecord(rec, arrivedAt, opts.marketplaceOf)
    if ('reason' in parsed) {
      result[parsed.reason] += 1
      if (parsed.reason !== 'notGrain' && parsed.reason !== 'zero') refused[parsed.reason] ??= parsed.why
      continue
    }
    const d = parsed.delta
    try {
      const out = await applyDelta(d, arrivedAt, cap)
      if (out.applied) { result.applied += 1; if (out.inserted) result.created += 1 }
      else if (out.state === 'capped') {
        result.capped += 1
        warnOnce('capped', '[BB-16] AMS grain row-count guard: a new row refused', { date: d.date, cap, campaignId: d.campaignId })
      } else if (out.state === 'no_baseline') result.noBaseline += 1
      else result.duplicates += 1
    } catch (error) {
      result.failed += 1
      warnOnce('failed', '[BB-16] AMS grain write failed', { campaignId: d.campaignId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  for (const [reason, why] of Object.entries(refused)) warnOnce(reason, '[BB-16] AMS grain record refused', { reason, why })
  return result
}

/** The non-zero counts of a grain result, for one log line ("applied=1 duplicates=2"). Pure. */
export function grainSummary(r: GrainIngestResult): string {
  const parts = Object.entries(r).filter(([k, v]) => k !== 'received' && typeof v === 'number' && v !== 0).map(([k, v]) => `${k}=${v}`)
  return parts.length ? parts.join(' ') : 'nothing'
}

// ── read ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PlacementHourCell {
  /** Campaign.id */
  campaignId: string
  placement: string
  /** YYYY-MM-DD in the read's time zone. */
  day: string
  /** 0-23 in the read's time zone. */
  hour: number
  impressions: number
  clicks: number
  /** Cents (may carry a fraction: Amazon bills in micros). */
  spendCents: number
  orders1d: number
  orders7d: number
  sales1dCents: number
  sales7dCents: number
  /** Built from a row whose first delta arrived late: earlier deltas may be missing. */
  lateStart: boolean
}

export interface PlacementHoursRead {
  timeZone: string
  /** Today in the read's time zone. */
  today: string
  /** Every day read, oldest first, today last. */
  days: string[]
  cells: PlacementHourCell[]
  /** The newest delta that reached these campaigns (null when none). */
  lastArrivalAt: Date | null
  lateStartCells: number
  /** Cells whose sum was below 0 for a moment (read as 0). */
  negativeCells: number
  /** Campaigns asked for that have no Amazon campaign id (nothing can be read for them). */
  unlinked: string[]
}

export const MAX_PAST_DAYS = 60
const DAY_MS = 86_400_000
const shiftDay = (day: string, by: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS).toISOString().slice(0, 10)

const formatters = new Map<string, Intl.DateTimeFormat>()
function localHour(instant: Date, timeZone: string): { day: string; hour: number } {
  let f = formatters.get(timeZone)
  if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }); formatters.set(timeZone, f) }
  const parts = f.formatToParts(instant)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 }
}

type GroupRow = {
  campaignId: string; placement: string; date: Date; hour: number
  impressions: bigint; clicks: bigint; costMicros: bigint; orders1d: bigint; orders7d: bigint; sales1dCents: bigint; sales7dCents: bigint
  lateStart: boolean; lastArrivalAt: Date | null
}

/**
 * Hourly spend, clicks and orders per campaign × placement × hour for today and the `pastDays` days before it (default
 * 14, at most 60), in `timeZone` (default UTC; an unknown zone reads as UTC). Several ad groups of one campaign are summed.
 */
export async function loadPlacementHours(input: { campaignIds: readonly string[]; now: Date; timeZone?: string | null; pastDays?: number }): Promise<PlacementHoursRead> {
  const timeZone = isKnownTimeZone(input.timeZone) ? input.timeZone.trim() : 'UTC'
  const pastDays = Math.max(0, Math.min(MAX_PAST_DAYS, Math.floor(input.pastDays ?? 14)))
  const today = isoDayIn(input.now, timeZone)
  const days = Array.from({ length: pastDays + 1 }, (_, i) => shiftDay(today, i - pastDays))
  const out: PlacementHoursRead = { timeZone, today, days, cells: [], lastArrivalAt: null, lateStartCells: 0, negativeCells: 0, unlinked: [] }
  const ids = [...new Set(input.campaignIds)]
  if (!ids.length) return out

  const campaigns = await prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, externalCampaignId: true } })
  const localOf = new Map<string, string[]>()
  for (const c of campaigns) if (c.externalCampaignId) localOf.set(c.externalCampaignId, [...(localOf.get(c.externalCampaignId) ?? []), c.id])
  const linked = new Set([...localOf.values()].flat())
  out.unlinked = ids.filter((id) => !linked.has(id))
  if (!localOf.size) return out

  // A local day spans two UTC dates; read one more on each side and keep the hours that fall inside.
  const rows = await prisma.$queryRaw<GroupRow[]>(Prisma.sql`
    SELECT "campaignId", "placement", "date", "hour",
           sum("impressions")::bigint AS impressions, sum("clicks")::bigint AS clicks, sum("costMicros")::bigint AS "costMicros",
           sum("orders1d")::bigint AS "orders1d", sum("orders7d")::bigint AS "orders7d",
           sum("sales1dCents")::bigint AS "sales1dCents", sum("sales7dCents")::bigint AS "sales7dCents",
           bool_or("lateStart") AS "lateStart", max("lastArrivalAt") AS "lastArrivalAt"
      FROM "AmazonAdsHourlyPlacement"
     WHERE "campaignId" IN (${Prisma.join([...localOf.keys()])})
       AND "date" >= ${shiftDay(days[0], -1)}::date AND "date" <= ${shiftDay(today, 1)}::date
     GROUP BY "campaignId", "placement", "date", "hour"`)

  const inWindow = new Set(days)
  const cells = new Map<string, PlacementHourCell>()
  for (const r of rows) {
    const instant = new Date(r.date.getTime() + Number(r.hour) * 3_600_000)
    const { day, hour } = localHour(instant, timeZone)
    if (!inWindow.has(day)) continue
    if (r.lastArrivalAt && (!out.lastArrivalAt || r.lastArrivalAt > out.lastArrivalAt)) out.lastArrivalAt = r.lastArrivalAt
    for (const campaignId of localOf.get(r.campaignId) ?? []) {
      const k = `${campaignId}|${r.placement}|${day}|${hour}`
      const c = cells.get(k) ?? { campaignId, placement: r.placement, day, hour, impressions: 0, clicks: 0, spendCents: 0, orders1d: 0, orders7d: 0, sales1dCents: 0, sales7dCents: 0, lateStart: false }
      c.impressions += Number(r.impressions); c.clicks += Number(r.clicks); c.spendCents += Number(r.costMicros) / 10_000
      c.orders1d += Number(r.orders1d); c.orders7d += Number(r.orders7d); c.sales1dCents += Number(r.sales1dCents); c.sales7dCents += Number(r.sales7dCents)
      c.lateStart ||= r.lateStart
      cells.set(k, c)
    }
  }
  for (const c of cells.values()) {
    const keys = ['impressions', 'clicks', 'spendCents', 'orders1d', 'orders7d', 'sales1dCents', 'sales7dCents'] as const
    if (keys.some((key) => c[key] < 0)) { out.negativeCells += 1; for (const key of keys) c[key] = Math.max(0, c[key]) }
    if (c.lateStart) out.lateStartCells += 1
    out.cells.push(c)
  }
  out.cells.sort((a, b) => a.day.localeCompare(b.day) || a.hour - b.hour || a.campaignId.localeCompare(b.campaignId) || a.placement.localeCompare(b.placement))
  return out
}

export type PlacementHourTotals = Pick<PlacementHourCell, 'impressions' | 'clicks' | 'spendCents' | 'orders1d' | 'orders7d' | 'sales1dCents' | 'sales7dCents'>

/** Sum cells by a key of the caller's choice (e.g. campaign × hour for an hour curve, or day for today vs the past). Pure. */
export function rollUpPlacementHours(cells: readonly PlacementHourCell[], keyOf: (c: PlacementHourCell) => string): Map<string, PlacementHourTotals> {
  const out = new Map<string, PlacementHourTotals>()
  for (const c of cells) {
    const k = keyOf(c)
    const t = out.get(k) ?? { impressions: 0, clicks: 0, spendCents: 0, orders1d: 0, orders7d: 0, sales1dCents: 0, sales7dCents: 0 }
    t.impressions += c.impressions; t.clicks += c.clicks; t.spendCents += c.spendCents
    t.orders1d += c.orders1d; t.orders7d += c.orders7d; t.sales1dCents += c.sales1dCents; t.sales7dCents += c.sales7dCents
    out.set(k, t)
  }
  return out
}

// ── keep ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Prune both tables to the last `daysToKeep` days. Runs in the weekly ads cleanup cron (clustered, once per business). */
export async function cleanupOldPlacementHours(daysToKeep = GRAIN_DAYS_KEPT, now = new Date()): Promise<{ deletedRows: number; deletedArrivals: number; cutoffDate: string }> {
  const cutoff = new Date(now.getTime() - daysToKeep * DAY_MS)
  cutoff.setUTCHours(0, 0, 0, 0)
  const arrivals = await prisma.amazonAdsHourlyArrival.deleteMany({ where: { date: { lt: cutoff } } })
  const rows = await prisma.amazonAdsHourlyPlacement.deleteMany({ where: { date: { lt: cutoff } } })
  return { deletedRows: rows.count, deletedArrivals: arrivals.count, cutoffDate: cutoff.toISOString().slice(0, 10) }
}
