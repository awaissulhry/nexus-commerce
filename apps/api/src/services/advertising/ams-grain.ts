/**
 * BID BRAIN BB-16 — one Marketing Stream record → one delta at ad group × placement grain. Pure: no I/O.
 *
 * Design BRAIN-UPGRADES-DESIGN.md F2 / U1c and one-brain DESIGN.md §2.3, §2.6. The campaign-grain ingest
 * (ads-marketing-stream.service.ts) drops the ad group and placement Amazon sends and writes 1-day conversions into
 * 7d-named columns; that table and its readers stay exactly as they are. This module reads the same records for the
 * new table, AmazonAdsHourlyPlacement:
 *
 *   datasets   sp-traffic (impressions, clicks, cost) and sp-conversion (attributed conversions / sales / units, 1-day
 *              AND 7-day). Sponsored Brands and Display keep the campaign grain only (no SP bid brain reads them).
 *   deltas     Amazon sends every restatement as a new record holding the CHANGE (negative for invalid clicks or
 *              returns), each with its own `idempotency_id`; a redelivery repeats the id. The key below is an 8-byte
 *              hash of dataset + idempotency_id: the writer adds a record to a row only once.
 *   refused    a record that names no campaign, ad group, hour or idempotency key, carries a metric that is not a
 *              number, lies in the future or older than the 90 days kept, or changes nothing — each with its reason.
 *   arrival    ageHours = whole hours from the END of the record's hour to its arrival, bucketed (exact below 48 h,
 *              whole days below 14 days, whole weeks after): the delta-arrival log keeps one row per bucket.
 *   late       a row whose first delta arrives more than 12 hours after its hour ended may miss earlier deltas (the
 *              hour predates the grain, or the feed had a gap): it is created marked `lateStart`.
 *   sent       "arrival" is when the record left Amazon's queue: SQS's SentTimestamp (sentTimeOf), not when Nexus read
 *              it, so a queue that waited (a slow forwarder, a poller that was down) does not age the deltas.
 *
 * Amazon's placement labels are mapped to the bidding enums the rest of Nexus uses (ads-placement-math.ts); an
 * unknown label is kept under its own name ("OTHER:<label>") — never folded into a managed lane, never dropped.
 */
import { createHash } from 'node:crypto'
import { PLACEMENT_PRODUCT, PLACEMENT_REST, PLACEMENT_TOP, REPORT_LABEL_TO_PLACEMENT } from './ads-placement-math.js'

export const GRAIN_DATASETS = { 'sp-traffic': 'traffic', 'sp-conversion': 'conversion' } as const
export type GrainKind = (typeof GRAIN_DATASETS)[keyof typeof GRAIN_DATASETS]

/** Days of hourly rows kept (the weekly cleanup prunes older ones); a record older than this is refused. */
export const GRAIN_DAYS_KEPT = 90
/** A row first seen this many hours after its hour ended may miss earlier deltas. */
export const LATE_START_HOURS = 12
/** A record whose hour starts more than this far after its arrival is refused (clock or parse error). */
const FUTURE_SLACK_MS = 2 * 3_600_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export const OFF_AMAZON = 'OFF_AMAZON'
export const UNKNOWN_PLACEMENT = 'UNKNOWN'

const PLACEMENT_ALIASES: Record<string, string> = {
  ...Object.fromEntries(Object.entries(REPORT_LABEL_TO_PLACEMENT).map(([label, lane]) => [label.toLowerCase(), lane])),
  'top of search': PLACEMENT_TOP, placement_top: PLACEMENT_TOP,
  'detail page': PLACEMENT_PRODUCT, 'product pages': PLACEMENT_PRODUCT, placement_product_page: PLACEMENT_PRODUCT,
  'rest of search': PLACEMENT_REST, placement_rest_of_search: PLACEMENT_REST,
}

/** Amazon's placement label → the lane Nexus uses. Unknown labels keep their own name; a missing one is UNKNOWN. */
export function normalizeStreamPlacement(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return UNKNOWN_PLACEMENT
  const label = raw.trim().replace(/\s+/g, ' ')
  const known = PLACEMENT_ALIASES[label.toLowerCase()]
  if (known) return known
  if (/off[ -]?amazon/i.test(label)) return OFF_AMAZON
  return `OTHER:${label.slice(0, 48)}`
}

/** Whole hours from the end of the hour to the arrival, bucketed for the arrival log. */
export function ageBucketHours(windowStart: Date, arrivedAt: Date): number {
  const age = Math.max(0, Math.floor((arrivedAt.getTime() - (windowStart.getTime() + HOUR_MS)) / HOUR_MS))
  if (age < 48) return age
  if (age < 14 * 24) return Math.floor(age / 24) * 24
  return Math.floor(age / 168) * 168
}

/** SQS keeps a message at most 14 days: an older "sent" time is not a queue's. */
const SENT_MAX_AGE_MS = 14 * DAY_MS
/** A sent time this far after `now` is still taken (two clocks); later is not a sent time. */
const SENT_CLOCK_SLACK_MS = 5 * 60_000

/**
 * A message's sent time: SQS's SentTimestamp (epoch milliseconds, as a number or a string of digits) or an ISO time.
 * Null unless it is a plausible past instant (not after `now` beyond a few minutes of clock slack, not older than SQS
 * keeps a message): then the caller's own arrival time stands. Pure.
 */
export function sentTimeOf(raw: unknown, now: Date): Date | null {
  let ms: number
  if (typeof raw === 'number') ms = raw
  else if (typeof raw === 'string' && /^\d{10,16}$/.test(raw.trim())) ms = Number(raw.trim())
  else if (typeof raw === 'string' && raw.trim()) ms = Date.parse(raw.trim())
  else return null
  if (!Number.isFinite(ms)) return null
  if (ms > now.getTime() + SENT_CLOCK_SLACK_MS || ms < now.getTime() - SENT_MAX_AGE_MS) return null
  return new Date(Math.min(ms, now.getTime()))
}

/** The sent time a record carries itself (a forwarder may copy its SQS message's SentTimestamp onto each record). Pure. */
export function recordSentAt(rec: Record<string, unknown>, now: Date): Date | null {
  return sentTimeOf(rec.SentTimestamp ?? rec.sentTimestamp, now)
}

/** The dedupe key: the first 8 bytes of sha256(dataset|idempotency id), as a signed 64-bit integer. Stable. */
export function streamRecordKey(dataset: string, idempotencyId: string): bigint {
  return createHash('sha256').update(`${dataset}|${idempotencyId}`).digest().readBigInt64BE(0)
}

export interface GrainDelta {
  kind: GrainKind
  key: bigint
  profileId: string | null
  marketplace: string | null
  currencyCode: string | null
  campaignId: string
  adGroupId: string
  placement: string
  /** YYYY-MM-DD (UTC) */
  date: string
  /** 0-23 (UTC) */
  hour: number
  windowStart: Date
  ageHours: number
  /** The first delta of a row created by this record would arrive late (see LATE_START_HOURS). */
  late: boolean
  /** Some metric goes down: a correction, which can never start a row. */
  negative: boolean
  impressions: number
  clicks: number
  costMicros: bigint
  orders1d: number
  orders7d: number
  units1d: number
  units7d: number
  sales1dCents: number
  sales7dCents: number
}

export type GrainRefusal = 'notGrain' | 'malformed' | 'noIdempotencyKey' | 'tooOld' | 'zero'
export type GrainParse = { ok: true; delta: GrainDelta } | { ok: false; reason: GrainRefusal; why: string }

const idOf = (v: unknown): string | null => {
  const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v.trim() : ''
  return ID_RE.test(s) ? s : null
}
const textOf = (v: unknown): string | null => (typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' && v.trim() ? v.trim() : null)

/** A metric value: absent → 0; a number or numeric string → it; anything else → NaN (the record is malformed). */
function metric(rec: Record<string, unknown>, key: string): number {
  const v = rec[key]
  if (v == null || v === '') return 0
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && Math.abs(n) < 1e9 ? n : NaN
}

/**
 * Read one record. `marketplaceOf` maps Amazon's marketplace id to the short code (the campaign-grain ingest's own
 * mapping is passed in, so both tables agree).
 */
export function parseGrainRecord(rec: Record<string, unknown>, arrivedAt: Date, marketplaceOf: (raw: string) => string): GrainParse {
  const dataset = typeof rec.dataset_id === 'string' ? rec.dataset_id.trim().toLowerCase() : typeof rec.datasetId === 'string' ? rec.datasetId.trim().toLowerCase() : ''
  const kind = (GRAIN_DATASETS as Record<string, GrainKind | undefined>)[dataset]
  if (!kind) return { ok: false, reason: 'notGrain', why: `dataset ${dataset || '(none)'} is not sp-traffic or sp-conversion` }

  const campaignId = idOf(rec.campaign_id ?? rec.campaignId)
  const adGroupId = idOf(rec.ad_group_id ?? rec.adGroupId)
  if (!campaignId || !adGroupId) return { ok: false, reason: 'malformed', why: 'no usable campaign_id / ad_group_id' }
  const idem = textOf(rec.idempotency_id ?? rec.idempotencyId)
  if (!idem) return { ok: false, reason: 'noIdempotencyKey', why: 'no idempotency_id: a redelivery could not be told apart' }

  const rawWindow = rec.time_window_start ?? rec.timeWindowStart
  const parsed = typeof rawWindow === 'string' || typeof rawWindow === 'number' ? new Date(rawWindow) : null
  if (!parsed || Number.isNaN(parsed.getTime())) return { ok: false, reason: 'malformed', why: 'no usable time_window_start' }
  const windowStart = new Date(Math.floor(parsed.getTime() / HOUR_MS) * HOUR_MS)
  if (windowStart.getTime() > arrivedAt.getTime() + FUTURE_SLACK_MS) return { ok: false, reason: 'malformed', why: 'time_window_start is in the future' }
  const today = Math.floor(arrivedAt.getTime() / DAY_MS) * DAY_MS
  if (windowStart.getTime() < today - GRAIN_DAYS_KEPT * DAY_MS) return { ok: false, reason: 'tooOld', why: `hour older than the ${GRAIN_DAYS_KEPT} days kept` }

  const traffic = kind === 'traffic'
  const impressions = traffic ? metric(rec, 'impressions') : 0
  const clicks = traffic ? metric(rec, 'clicks') : 0
  const cost = traffic ? metric(rec, 'cost') : 0
  const orders1d = traffic ? 0 : metric(rec, 'attributed_conversions_1d')
  const orders7d = traffic ? 0 : metric(rec, 'attributed_conversions_7d')
  const units1d = traffic ? 0 : metric(rec, 'attributed_units_ordered_1d')
  const units7d = traffic ? 0 : metric(rec, 'attributed_units_ordered_7d')
  const sales1d = traffic ? 0 : metric(rec, 'attributed_sales_1d')
  const sales7d = traffic ? 0 : metric(rec, 'attributed_sales_7d')
  const values = [impressions, clicks, cost, orders1d, orders7d, units1d, units7d, sales1d, sales7d]
  if (values.some((v) => Number.isNaN(v))) return { ok: false, reason: 'malformed', why: 'a metric is not a number' }

  const delta: GrainDelta = {
    kind, key: streamRecordKey(dataset, idem),
    profileId: textOf(rec.profileId ?? rec.profile_id ?? rec.advertiser_id ?? rec.advertiserId),
    marketplace: (() => { const m = textOf(rec.marketplace ?? rec.marketplace_id); return m ? marketplaceOf(m).slice(0, 16) : null })(),
    currencyCode: textOf(rec.currency)?.slice(0, 3) ?? null,
    campaignId, adGroupId,
    placement: normalizeStreamPlacement(rec.placement),
    date: windowStart.toISOString().slice(0, 10),
    hour: windowStart.getUTCHours(),
    windowStart,
    ageHours: ageBucketHours(windowStart, arrivedAt),
    late: arrivedAt.getTime() - (windowStart.getTime() + HOUR_MS) > LATE_START_HOURS * HOUR_MS,
    negative: values.some((v) => v < 0),
    impressions: Math.round(impressions),
    clicks: Math.round(clicks),
    costMicros: BigInt(Math.round(cost * 1_000_000)),
    orders1d: Math.round(orders1d), orders7d: Math.round(orders7d),
    units1d: Math.round(units1d), units7d: Math.round(units7d),
    sales1dCents: Math.round(sales1d * 100), sales7dCents: Math.round(sales7d * 100),
  }
  const changes = delta.impressions || delta.clicks || delta.costMicros !== 0n || delta.orders1d || delta.orders7d || delta.units1d || delta.units7d || delta.sales1dCents || delta.sales7dCents
  if (!changes) return { ok: false, reason: 'zero', why: 'the record changes nothing' }
  return { ok: true, delta }
}
