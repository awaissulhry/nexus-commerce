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
 *     3. the arrival log adds the same deltas to the row's (kind, age bucket), only when step 2 applied. Its own guard:
 *        past NEXUS_AMS_GRAIN_MAX_ARRIVALS_PER_DAY bucket rows on the data day (default 40,000) a NEW bucket is not made
 *        (the delta still lands in its row; an existing bucket still adds) — the log is a learning aid, the row is the data.
 *   The day's counts (rows, buckets) are read ONCE per business, data day and process (one count, re-read every 10
 *   minutes so other processes' rows are seen) and counted on in memory: no count(*) per record (that was O(n²) a day).
 *   A cap never drops quietly: the day is marked in AmazonAdsGrainCap (per business, day and kind: rows / arrivals, with
 *   at least how many it refused — the first refusal at once, the rest added at most every 10 minutes per process), and
 *   loadPlacementHours returns the capped days, so a reader can tell an incomplete day from a quiet one.
 *   `arrivedAt`: when the record left Amazon's queue — a record's own SQS SentTimestamp, else the caller's (the SQS
 *   poller passes its message's SentTimestamp), else now — so the arrival ages leave out the time it waited in a queue.
 *   A record that changes nothing, a duplicate and every refusal write nothing (Neon cost: only changed rows).
 *   NEXUS_AMS_GRAIN_ENABLED=0 stops the writer; the campaign grain carries on as before. Nothing it does throws.
 *
 * READ (loadPlacementHours)
 *   Per campaign × placement × hour, for today and the last N days (default 14) in the caller's time zone: impressions,
 *   clicks, spend, 1-day and 7-day orders and sales. Rows are keyed by Amazon's ids; the caller passes Campaign.id.
 *   A cell whose sum is negative for a moment (a correction arrived before its original) reads 0 and is counted; cells
 *   built from a late first delta are counted too, so a reader can say what it does not know.
 *
 * KEEP (cleanupOldPlacementHours): 90 days, in the weekly ads cleanup cron (clustered, once per business), deleted in
 * chunks of PRUNE_CHUNK_ROWS rows (one short statement each, never one long transaction over a quarter's rows).
 */
import { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { workspaceContext } from '../../lib/workspace-context.js'
import { isoDayIn, isKnownTimeZone } from './ads-local-day.js'
import { GRAIN_DAYS_KEPT, parseGrainRecord, recordSentAt, type GrainDelta, type GrainRefusal } from './ams-grain.js'

export const DEFAULT_GRAIN_MAX_ROWS_PER_DAY = 10_000
/** About four arrival buckets per row (traffic and conversion, a few ages each). */
export const DEFAULT_GRAIN_MAX_ARRIVALS_PER_DAY = 40_000

const envCap = (name: string, fallback: number): number => {
  const v = process.env[name]
  const raw = Number(v)
  return v != null && v !== '' && Number.isInteger(raw) && raw >= 0 ? raw : fallback
}

/** The row-count guard's ceiling: new rows per business per data day. */
export function grainRowCap(): number {
  return envCap('NEXUS_AMS_GRAIN_MAX_ROWS_PER_DAY', DEFAULT_GRAIN_MAX_ROWS_PER_DAY)
}

/** The arrival log's ceiling: new (row, kind, age) buckets per business per data day. */
export function grainArrivalCap(): number {
  return envCap('NEXUS_AMS_GRAIN_MAX_ARRIVALS_PER_DAY', DEFAULT_GRAIN_MAX_ARRIVALS_PER_DAY)
}

// ── the day's counts, read once and counted on in memory ─────────────────────────────────────────────────────────────

/** A day's counts are read again after this long (another process may have added rows meanwhile). */
export const DAY_COUNT_REREAD_MS = 10 * 60_000
interface DayCount { rows: number; arrivals: number; readAt: number }
const dayCounts = new Map<string, DayCount>()
const dayCountReads = new Map<string, Promise<DayCount>>()
const businessKey = (): string => workspaceContext()?.workspaceId ?? '(no business)'

/** One business's grain rows and arrival buckets of one data day: from memory, read once per process every 10 minutes. */
async function dayCountOf(date: string, now: number): Promise<DayCount> {
  const key = `${businessKey()}|${date}`
  const known = dayCounts.get(key)
  if (known && now - known.readAt < DAY_COUNT_REREAD_MS) return known
  let reading = dayCountReads.get(key)
  if (!reading) {
    reading = prisma.$queryRaw<Array<{ rows: number; arrivals: number }>>(Prisma.sql`
      SELECT (SELECT count(*) FROM "AmazonAdsHourlyPlacement" WHERE "date" = ${date}::date)::int AS rows,
             (SELECT count(*) FROM "AmazonAdsHourlyArrival" WHERE "date" = ${date}::date)::int AS arrivals`)
      .then(([r]) => {
        const c: DayCount = { rows: Number(r?.rows ?? 0), arrivals: Number(r?.arrivals ?? 0), readAt: now }
        dayCounts.set(key, c)
        return c
      })
      .finally(() => dayCountReads.delete(key))
    dayCountReads.set(key, reading)
  }
  return reading
}

/** Tests: forget every remembered day count and pending cap mark of this process. */
export function forgetGrainDayCounts(): void {
  dayCounts.clear()
  dayCountReads.clear()
  capMarks.clear()
}

// ── the capped-day marks ─────────────────────────────────────────────────────────────────────────────────────────────

export type GrainCapKind = 'rows' | 'arrivals'
/** A day's mark gains the refusals counted in this process at most this often (the first refusal is marked at once). */
export const CAP_MARK_EVERY_MS = 10 * 60_000
interface CapMark { business: string; date: string; kind: GrainCapKind; cap: number; pending: number; firstAt: Date; lastAt: Date; flushedAt: number | null }
const capMarks = new Map<string, CapMark>()

function noteCapped(date: string, kind: GrainCapKind, cap: number, at: Date): void {
  const business = businessKey()
  const key = `${business}|${date}|${kind}`
  const m = capMarks.get(key)
  if (m) { m.pending += 1; m.cap = cap; if (at < m.firstAt) m.firstAt = at; if (at > m.lastAt) m.lastAt = at; return }
  capMarks.set(key, { business, date, kind, cap, pending: 1, firstAt: at, lastAt: at, flushedAt: null })
}

/** Write this business's due marks (one small upsert each); a failed write keeps its count for the next try. Never throws. */
async function flushCapMarks(now: number): Promise<void> {
  const business = businessKey()
  for (const m of capMarks.values()) {
    if (m.business !== business || m.pending === 0) continue
    if (m.flushedAt != null && now - m.flushedAt < CAP_MARK_EVERY_MS) continue
    const n = m.pending
    try {
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO "AmazonAdsGrainCap" AS x ("id", "date", "kind", "cap", "refused", "firstAt", "lastAt")
        VALUES (gen_random_uuid()::text, ${m.date}::date, ${m.kind}::text, ${m.cap}::int, ${n}::int,
                (${m.firstAt.toISOString()}::timestamptz AT TIME ZONE 'UTC'), (${m.lastAt.toISOString()}::timestamptz AT TIME ZONE 'UTC'))
        ON CONFLICT ("workspaceId", "date", "kind") DO UPDATE SET
          "refused" = x."refused" + EXCLUDED."refused",
          "cap"     = EXCLUDED."cap",
          "firstAt" = LEAST(x."firstAt", EXCLUDED."firstAt"),
          "lastAt"  = GREATEST(x."lastAt", EXCLUDED."lastAt")`)
      m.pending -= n
      m.flushedAt = now
    } catch (error) {
      warnOnce('capMark', '[BB-16] AMS grain: the capped-day mark could not be written (kept for the next batch)', { date: m.date, kind: m.kind, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/** The days of a range (UTC data days) on which the grain refused records at a ceiling, per kind, for readers. */
export async function grainCappedDays(range: { from: string; to: string }): Promise<Array<{ date: string; kind: GrainCapKind; cap: number; refusedAtLeast: number }>> {
  const rows = await prisma.amazonAdsGrainCap.findMany({
    where: { date: { gte: new Date(`${range.from}T00:00:00Z`), lte: new Date(`${range.to}T00:00:00Z`) } },
    select: { date: true, kind: true, cap: true, refused: true },
    orderBy: [{ date: 'asc' }, { kind: 'asc' }],
  })
  return rows.map((r) => ({ date: r.date.toISOString().slice(0, 10), kind: r.kind === 'arrivals' ? 'arrivals' : 'rows', cap: r.cap, refusedAtLeast: r.refused }))
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
  /** Records added to their row whose arrival bucket the arrival log's guard left out. */
  arrivalsCapped: number
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
  received, applied: 0, created: 0, duplicates: 0, noBaseline: 0, capped: 0, arrivalsCapped: 0, malformed: 0, noIdempotencyKey: 0, tooOld: 0, zero: 0, notGrain: 0, failed: 0,
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

/**
 * One record into its row and its arrival bucket, in one statement. `rowsOpen` / `arrivalsOpen`: the day is below the
 * row / bucket ceilings (the caller's count). With the buckets closed an existing bucket still adds; no new one is made.
 */
async function applyDelta(d: GrainDelta, arrivedAt: Date, open: { rowsOpen: boolean; arrivalsOpen: boolean }): Promise<{ state: ApplyState; applied: boolean; inserted: boolean; arrival: 'created' | 'added' | 'capped' | null }> {
  const at = arrivedAt.toISOString()
  const rows = await prisma.$queryRaw<Array<{ state: ApplyState; applied: boolean; inserted: boolean | null; arrivalCreated: boolean | null; arrivalAdded: boolean | null }>>(Prisma.sql`
    WITH cap AS (
      SELECT CASE
        WHEN EXISTS (
          SELECT 1 FROM "AmazonAdsHourlyPlacement" t
           WHERE t."campaignId" = ${d.campaignId}::text AND t."adGroupId" = ${d.adGroupId}::text AND t."placement" = ${d.placement}::text
             AND t."date" = ${d.date}::date AND t."hour" = ${d.hour}::int
        ) THEN 'exists'
        WHEN ${d.negative}::boolean THEN 'no_baseline'
        WHEN NOT ${open.rowsOpen}::boolean THEN 'capped'
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
      FROM g WHERE ${open.arrivalsOpen}::boolean
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
      RETURNING (x.xmax = 0) AS inserted
    ), u AS (
      -- The bucket ceiling reached: an existing bucket still adds; no new bucket is made.
      UPDATE "AmazonAdsHourlyArrival" AS x SET
        "records"      = x."records" + 1,
        "impressions"  = x."impressions" + ${d.impressions}::int,
        "clicks"       = x."clicks" + ${d.clicks}::int,
        "costMicros"   = x."costMicros" + ${d.costMicros}::bigint,
        "orders1d"     = x."orders1d" + ${d.orders1d}::int,
        "orders7d"     = x."orders7d" + ${d.orders7d}::int,
        "units1d"      = x."units1d" + ${d.units1d}::int,
        "units7d"      = x."units7d" + ${d.units7d}::int,
        "sales1dCents" = x."sales1dCents" + ${d.sales1dCents}::int,
        "sales7dCents" = x."sales7dCents" + ${d.sales7dCents}::int,
        "firstAt"      = LEAST(x."firstAt", (${at}::timestamptz AT TIME ZONE 'UTC')),
        "lastAt"       = GREATEST(x."lastAt", (${at}::timestamptz AT TIME ZONE 'UTC'))
      FROM g
      WHERE NOT ${open.arrivalsOpen}::boolean AND x."grainId" = g."id" AND x."kind" = ${d.kind}::text AND x."ageHours" = ${d.ageHours}::int
      RETURNING 1
    )
    SELECT cap.state, (g."id" IS NOT NULL) AS applied, COALESCE(g.inserted, false) AS inserted,
           (SELECT bool_or(a.inserted) FROM a) AS "arrivalCreated", EXISTS (SELECT 1 FROM a) OR EXISTS (SELECT 1 FROM u) AS "arrivalAdded"
      FROM cap LEFT JOIN g ON true
  `)
  const row = rows[0]
  const applied = !!row?.applied
  const arrival = !applied ? null : row?.arrivalCreated ? 'created' : row?.arrivalAdded ? 'added' : 'capped'
  return { state: row?.state ?? 'capped', applied, inserted: !!row?.inserted, arrival }
}

/**
 * Add a batch of Marketing Stream records to the ad group × placement grain. Runs inside the business the records were
 * routed to (the caller's). `arrivedAt` is when they left Amazon's queue (the SQS message's SentTimestamp; default now) —
 * a record's own SentTimestamp wins; `marketplaceOf` is the campaign-grain ingest's marketplace mapping. Never throws: a
 * failed record is counted and logged.
 */
export async function ingestPlacementGrain(
  records: ReadonlyArray<Record<string, unknown>>,
  opts: { arrivedAt?: Date; marketplaceOf: (raw: string) => string },
): Promise<GrainIngestResult | null> {
  if (!grainEnabled()) return null
  const result = emptyResult(records.length)
  const now = new Date()
  const batchArrivedAt = opts.arrivedAt ?? now
  const cap = grainRowCap()
  const arrivalCap = grainArrivalCap()
  const refused: Partial<Record<GrainRefusal, string>> = {}
  for (const rec of records) {
    const arrivedAt = recordSentAt(rec, now) ?? batchArrivedAt
    const parsed = parseGrainRecord(rec, arrivedAt, opts.marketplaceOf)
    if ('reason' in parsed) {
      result[parsed.reason] += 1
      if (parsed.reason !== 'notGrain' && parsed.reason !== 'zero') refused[parsed.reason] ??= parsed.why
      continue
    }
    const d = parsed.delta
    try {
      const day = await dayCountOf(d.date, now.getTime())
      const out = await applyDelta(d, arrivedAt, { rowsOpen: day.rows < cap, arrivalsOpen: day.arrivals < arrivalCap })
      if (out.inserted) day.rows += 1
      if (out.arrival === 'created') day.arrivals += 1
      if (out.applied) {
        result.applied += 1
        if (out.inserted) result.created += 1
        if (out.arrival === 'capped') {
          result.arrivalsCapped += 1
          noteCapped(d.date, 'arrivals', arrivalCap, arrivedAt)
          warnOnce('arrivalsCapped', '[BB-16] AMS grain arrival-log guard: a new bucket left out (the row took its delta)', { date: d.date, cap: arrivalCap })
        }
      } else if (out.state === 'capped') {
        result.capped += 1
        noteCapped(d.date, 'rows', cap, arrivedAt)
        warnOnce('capped', '[BB-16] AMS grain row-count guard: a new row refused (the day is marked capped)', { date: d.date, cap, campaignId: d.campaignId })
      } else if (out.state === 'no_baseline') result.noBaseline += 1
      else result.duplicates += 1
    } catch (error) {
      result.failed += 1
      warnOnce('failed', '[BB-16] AMS grain write failed', { campaignId: d.campaignId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  if (capMarks.size) await flushCapMarks(Date.now())
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
  /**
   * BB-16 follow-up — the UTC data days read on which the ingest refused records at a ceiling (grainCappedDays): kind
   * `rows`, the day's grain is incomplete; `arrivals`, its rows are whole and only the arrival log is short.
   */
  cappedDays: Array<{ date: string; kind: GrainCapKind; cap: number; refusedAtLeast: number }>
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
  const out: PlacementHoursRead = { timeZone, today, days, cells: [], lastArrivalAt: null, lateStartCells: 0, negativeCells: 0, unlinked: [], cappedDays: [] }
  const ids = [...new Set(input.campaignIds)]
  if (!ids.length) return out
  out.cappedDays = await grainCappedDays({ from: shiftDay(days[0], -1), to: shiftDay(today, 1) })

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

/** Rows one prune statement deletes at most: a short statement each, never one long transaction over a quarter's rows. */
export const PRUNE_CHUNK_ROWS = 5_000
/** A prune stops after this many chunks (the next weekly run carries on): a bound on one run, never an endless loop. */
export const PRUNE_MAX_CHUNKS = 400

/** Delete a table's rows older than `cutoff` (a UTC day), `chunk` rows per statement; how many went. */
async function pruneInChunks(table: 'AmazonAdsHourlyArrival' | 'AmazonAdsHourlyPlacement', cutoff: string, chunk: number): Promise<number> {
  const name = Prisma.raw(`"${table}"`)
  let total = 0
  for (let i = 0; i < PRUNE_MAX_CHUNKS; i++) {
    const n = await prisma.$executeRaw(Prisma.sql`
      DELETE FROM ${name} WHERE "id" IN (SELECT "id" FROM ${name} WHERE "date" < ${cutoff}::date LIMIT ${chunk}::int)`)
    total += n
    if (n < chunk) break
  }
  return total
}

/**
 * Prune both tables (and the capped-day marks) to the last `daysToKeep` days, in chunks of `chunk` rows. Runs in the
 * weekly ads cleanup cron (clustered, once per business): the cron is unchanged.
 */
export async function cleanupOldPlacementHours(daysToKeep = GRAIN_DAYS_KEPT, now = new Date(), opts: { chunk?: number } = {}): Promise<{ deletedRows: number; deletedArrivals: number; cutoffDate: string }> {
  const cutoff = new Date(now.getTime() - daysToKeep * DAY_MS)
  cutoff.setUTCHours(0, 0, 0, 0)
  const cutoffDate = cutoff.toISOString().slice(0, 10)
  const chunk = Math.max(1, Math.floor(opts.chunk ?? PRUNE_CHUNK_ROWS))
  const deletedArrivals = await pruneInChunks('AmazonAdsHourlyArrival', cutoffDate, chunk)
  const deletedRows = await pruneInChunks('AmazonAdsHourlyPlacement', cutoffDate, chunk)
  await prisma.amazonAdsGrainCap.deleteMany({ where: { date: { lt: cutoff } } })
  return { deletedRows, deletedArrivals, cutoffDate }
}
