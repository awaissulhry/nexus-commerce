/**
 * Meta ads step 44 (master IN-102) — the Meta anomaly signal behind detect-anomalies: unusual swings in the business's
 * OWN Meta numbers, from what Nexus's daily read stored (MetaAdsDailyMetric, the ad account's own days through
 * read.service.ts metaAdsOverview). No Meta call. Meta has no public API for its anomaly signal: it is a tool of Meta's
 * own ads MCP only (`ads_insights_anomaly_signal`, "Detect unusual patterns or deviations in ad performance that warrant
 * investigation" — checked 2026-10-21 in developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/
 * ads-mcp-server/ads-mcp-server-tools-comprehensive-reporting.md; master IN-102 VERIFIED "no endpoint").
 *
 *   day breaks   each read day of the checked days (default the last 7, ending yesterday in the account's time zone)
 *                against the read days before them (up to 56): spend, click-through rate, cost per purchase and ROAS.
 *                A day is a break when it lies 2 standard deviations or more from the earlier days' mean AND moved at
 *                least 20 % from it (severity as the Insights anomalies, IH.9: 2.25 attention, 3 critical); a metric
 *                with fewer than 14 earlier days to compare is not checked, and says so
 *   shifts       the checked days together against the earlier days together (ratios from the sums): a move of 25 % or
 *                more with enough volume on both sides (attention; 50 % or more: critical)
 *   Meta said    what Meta itself pushed in those days through a verified webhook (step 30's notices): creative fatigue,
 *                the ad account's status, an object with a problem — once per subject, newest first
 *
 * The rules each answer keeps (the same as the daily read's pages): a day Nexus did not read is never a zero — it is
 * named and left out; the last 28 days are provisional (Meta restates late purchases), so a cost-per-purchase rise or a
 * ROAS fall there is said with that caution; money stays under money keys (spendCents, costPerPurchaseCents, roas) and
 * never in a sentence; spend moving is "changed" (neither better nor worse by itself).
 */
import prisma from '../../../db.js'
import { AD_ACCOUNT_STATUS_WORDS } from '../../cx/connectors/meta/discovery.js'
import { addDays } from './dates.js'
import { metaAdsOverview, type MetaAdsDay } from './read.service.js'

/** How many days are checked by default, and at most. */
export const META_ANOMALY_DAYS = 7
export const META_ANOMALY_MAX_DAYS = 14
/** The history a checked day is compared with: up to this many read days right before the checked days. */
export const META_ANOMALY_HISTORY_DAYS = 56
/** Fewer earlier days than this to compare with: the metric is not checked. */
export const META_ANOMALY_MIN_HISTORY = 14
const DAY_Z = 2
const DAY_MIN_MOVE = 0.2
const SHIFT_MOVE = 0.25
const SHIFT_CRITICAL = 0.5
/** A day's click-through rate is judged only with this many impressions; a shift needs ten times as many on each side. */
const CTR_MIN_IMPRESSIONS = 500
/** A shift of cost per purchase or ROAS needs this many purchases on each side. */
const SHIFT_MIN_PURCHASES = 3
/** Meta's own pushes read as signals (channel-alerts kinds of step 30). */
export const META_SIGNAL_NOTICES = ['meta-ads-creative-fatigue', 'meta-ads-account-status', 'meta-ads-object-issue'] as const
const NOTICE_CAP = 20

export type MetaAnomalyMetric = 'spend' | 'ctr' | 'costPerPurchase' | 'roas'
export type MetaAnomalySeverity = 'info' | 'attention' | 'critical'

type ReadDay = Extract<MetaAdsDay, { read: true }>

interface MetricSpec {
  /** The answer's key for the value (a money key where the value is money). */
  key: 'spendCents' | 'ctr' | 'costPerPurchaseCents' | 'roas'
  words: string
  /** Which way is worse; null: neither by itself (spend). */
  worse: 'up' | 'down' | null
  /** Built on Meta's purchases (late purchases still restate the last days). */
  purchases: boolean
  /** A day's value, or null when the day has too little to judge it. */
  day: (d: ReadDay) => number | null
  /** The value of several days together (from the sums), or null when they have too little to judge it. */
  window: (s: Sums, daysRead: number) => number | null
}

interface Sums { spendCents: number; impressions: number; clicks: number; purchases: number; purchaseValueCents: number }

const METRICS: Readonly<Record<MetaAnomalyMetric, MetricSpec>> = {
  spend: {
    key: 'spendCents', words: 'spend', worse: null, purchases: false,
    day: (d) => d.spendCents,
    window: (s, n) => (n > 0 ? Math.round(s.spendCents / n) : null),
  },
  ctr: {
    key: 'ctr', words: 'click-through rate', worse: 'down', purchases: false,
    day: (d) => (d.impressions >= CTR_MIN_IMPRESSIONS ? d.ctr : null),
    window: (s) => (s.impressions >= CTR_MIN_IMPRESSIONS * 10 ? s.clicks / s.impressions : null),
  },
  costPerPurchase: {
    key: 'costPerPurchaseCents', words: 'cost per purchase', worse: 'up', purchases: true,
    day: (d) => (d.purchases > 0 ? d.costPerPurchaseCents : null),
    window: (s) => (s.purchases >= SHIFT_MIN_PURCHASES ? Math.round(s.spendCents / s.purchases) : null),
  },
  roas: {
    key: 'roas', words: 'ROAS', worse: 'down', purchases: true,
    // A day that spent and sold nothing is a ROAS of 0 — the break a stopped purchase tracking shows.
    day: (d) => (d.spendCents > 0 ? d.roas : null),
    window: (s) => (s.spendCents > 0 && s.purchases >= SHIFT_MIN_PURCHASES ? s.purchaseValueCents / s.spendCents : null),
  },
}
export const META_ANOMALY_METRICS = Object.keys(METRICS) as MetaAnomalyMetric[]

export interface MetaAnomaly {
  /** day: one day against the earlier days; shift: the checked days together against the earlier days together. */
  kind: 'day' | 'shift'
  metric: MetaAnomalyMetric
  direction: 'up' | 'down'
  /** worse | better | changed (spend moving is neither by itself). */
  reads: 'worse' | 'better' | 'changed'
  severity: MetaAnomalySeverity
  /** day: the day (the account's own). */
  date?: string
  /** shift: the checked days' first and last day. */
  from?: string
  to?: string
  /** day: standard deviations from the earlier days' mean. */
  zScore?: number
  /** How far it moved from what the earlier days make usual, in % (rounded). */
  changePct: number
  /** The value, under its own key (spendCents, ctr, costPerPurchaseCents or roas). */
  observed: Record<string, number>
  /** What the earlier days make usual, under the same key. */
  usual: Record<string, number>
  /** Inside the last 28 days, which Meta can still restate. */
  provisional: boolean
  /** In words, with no amount. */
  sentence: string
}

export interface MetaSaid {
  at: string
  kind: (typeof META_SIGNAL_NOTICES)[number]
  severity: string
  title: string
  body: string | null
}

export interface MetaAnomalySignal {
  connected: boolean
  adAccountId: string | null
  currency: string | null
  timeZone: string | null
  /** account_status in words when it is not Active (null: active or not read yet). */
  accountStatus?: string
  checked: { from: string; to: string; daysRead: number; notRead: string[] } | null
  history: { from: string; to: string; daysRead: number } | null
  anomalies: MetaAnomaly[]
  metaSaid: MetaSaid[]
  /** Metrics not checked, and why. */
  notChecked: string[]
  dataAsOf: string | null
  sentence: string
}

const ORDER: Record<MetaAnomalySeverity, number> = { critical: 0, attention: 1, info: 2 }
const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places
const valueOf = (metric: MetaAnomalyMetric, v: number) => (metric === 'ctr' ? round(v, 5) : metric === 'roas' ? round(v, 3) : Math.round(v))

function stats(values: number[]): { mean: number; std: number } {
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  return { mean, std: Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length) }
}

/** IH.9's thresholds (insights-anomalies.service.ts severityFor). */
function daySeverity(z: number): MetaAnomalySeverity {
  const abs = Math.abs(z)
  return abs >= 3 ? 'critical' : abs >= 2.25 ? 'attention' : 'info'
}

function readsOf(spec: MetricSpec, direction: 'up' | 'down'): MetaAnomaly['reads'] {
  return spec.worse === null ? 'changed' : spec.worse === direction ? 'worse' : 'better'
}

const sumOf = (days: ReadDay[]): Sums => days.reduce((s, d) => ({
  spendCents: s.spendCents + d.spendCents, impressions: s.impressions + d.impressions, clicks: s.clicks + d.clicks,
  purchases: s.purchases + d.purchases, purchaseValueCents: s.purchaseValueCents + d.purchaseValueCents,
}), { spendCents: 0, impressions: 0, clicks: 0, purchases: 0, purchaseValueCents: 0 })

const CAUTION = ' Meta still adds late purchases to its last 28 days, so this can ease as they come in.'

/**
 * PURE — the breaks in a run of the account's days: `history` the days before the checked days (oldest first), `checked`
 * the checked days. Unread days are left out of every comparison (never a zero).
 */
export function metaAnomaliesOf(history: MetaAdsDay[], checked: MetaAdsDay[]): { anomalies: MetaAnomaly[]; notChecked: string[] } {
  const earlier = history.filter((d): d is ReadDay => d.read)
  const recent = checked.filter((d): d is ReadDay => d.read)
  const anomalies: MetaAnomaly[] = []
  const notChecked: string[] = []
  if (!recent.length) return { anomalies, notChecked: ['every metric: Nexus has read none of the checked days yet'] }
  for (const metric of META_ANOMALY_METRICS) {
    const spec = METRICS[metric]
    const reference = earlier.map(spec.day).filter((v): v is number => v !== null && Number.isFinite(v))
    if (reference.length < META_ANOMALY_MIN_HISTORY) {
      notChecked.push(`${spec.words}: ${reference.length} earlier day${reference.length === 1 ? '' : 's'} to compare with (${META_ANOMALY_MIN_HISTORY} needed${spec.purchases ? ', each with a purchase or spend' : metric === 'ctr' ? `, each with ${CTR_MIN_IMPRESSIONS} impressions` : ''})`)
      continue
    }
    const { mean, std } = stats(reference)
    // Day breaks.
    for (const day of recent) {
      const v = spec.day(day)
      if (v === null || !Number.isFinite(v) || std === 0) continue
      const z = (v - mean) / std
      const move = mean !== 0 ? (v - mean) / Math.abs(mean) : v === 0 ? 0 : Infinity
      if (Math.abs(z) < DAY_Z || Math.abs(move) < DAY_MIN_MOVE) continue
      const direction = z > 0 ? 'up' : 'down'
      const reads = readsOf(spec, direction)
      const caution = spec.purchases && day.provisional && reads === 'worse' ? CAUTION : ''
      anomalies.push({
        kind: 'day', metric, direction, reads, severity: daySeverity(z), date: day.date, zScore: round(z, 1),
        changePct: Number.isFinite(move) ? Math.round(move * 100) : 100,
        observed: { [spec.key]: valueOf(metric, v) }, usual: { [spec.key]: valueOf(metric, mean) }, provisional: day.provisional,
        sentence: `${capital(spec.words)} on ${day.date} was far ${direction === 'up' ? 'above' : 'below'} the account's usual day (${Math.abs(round(z, 1))} standard deviations; ${reads}).${caution}`,
      })
    }
    // The checked days together against the earlier days together.
    const now = spec.window(sumOf(recent), recent.length)
    const before = spec.window(sumOf(earlier), earlier.length)
    if (now === null || before === null || !Number.isFinite(now) || !Number.isFinite(before) || before === 0) continue
    const move = (now - before) / Math.abs(before)
    if (Math.abs(move) < SHIFT_MOVE) continue
    const direction = move > 0 ? 'up' : 'down'
    const reads = readsOf(spec, direction)
    const provisional = recent.some((d) => d.provisional)
    const from = recent[0].date
    const to = recent[recent.length - 1].date
    anomalies.push({
      kind: 'shift', metric, direction, reads, severity: Math.abs(move) >= SHIFT_CRITICAL ? 'critical' : 'attention', from, to,
      changePct: Math.round(move * 100),
      observed: { [spec.key]: valueOf(metric, now) }, usual: { [spec.key]: valueOf(metric, before) }, provisional,
      sentence: `${capital(spec.words)}${metric === 'spend' ? ' per day' : ''} from ${from} to ${to} is ${Math.abs(Math.round(move * 100))} % ${direction === 'up' ? 'higher' : 'lower'} than in the ${earlier.length} read days before (${reads}).${spec.purchases && provisional && reads === 'worse' ? CAUTION : ''}`,
    })
  }
  anomalies.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || Math.abs(b.zScore ?? 0) - Math.abs(a.zScore ?? 0) || Math.abs(b.changePct) - Math.abs(a.changePct))
  return { anomalies, notChecked }
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
const cap = (text: string | null, n: number) => (text == null ? null : text.length > n ? `${text.slice(0, n - 1)}…` : text)

/** Meta's own pushes about this ad account since `since`, once per subject (a notice goes to each owner), newest first. */
async function metaSaidSince(adAccountId: string, since: Date): Promise<MetaSaid[]> {
  const rows = await prisma.notification.findMany({
    where: { type: { in: [...META_SIGNAL_NOTICES] }, createdAt: { gte: since }, entityId: { startsWith: `${adAccountId}~` } },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: { type: true, severity: true, title: true, body: true, entityId: true, createdAt: true },
  })
  const seen = new Set<string>()
  const out: MetaSaid[] = []
  for (const row of rows) {
    const subject = `${row.type}|${row.entityId}`
    if (seen.has(subject)) continue
    seen.add(subject)
    out.push({ at: row.createdAt.toISOString(), kind: row.type as MetaSaid['kind'], severity: row.severity, title: cap(row.title, 200)!, body: cap(row.body, 400) })
    if (out.length >= NOTICE_CAP) break
  }
  return out
}

function sentenceOf(s: Pick<MetaAnomalySignal, 'anomalies' | 'metaSaid' | 'checked' | 'notChecked' | 'accountStatus'>): string {
  const parts: string[] = []
  if (s.accountStatus) parts.push(`The ad account is ${s.accountStatus.toLowerCase()} at Meta.`)
  const worse = s.anomalies.filter((a) => a.reads === 'worse').length
  if (!s.anomalies.length) parts.push(s.checked?.daysRead ? `No unusual swing in the ${s.checked.daysRead} checked day${s.checked.daysRead === 1 ? '' : 's'} against the account's own history.` : 'Nothing could be compared yet.')
  else parts.push(`${s.anomalies.length} unusual swing${s.anomalies.length === 1 ? '' : 's'} against the account's own history${worse ? ` (${worse} for the worse)` : ''}.`)
  if (s.checked?.notRead.length) parts.push(`${s.checked.notRead.length} checked day${s.checked.notRead.length === 1 ? ' was' : 's were'} not read by Nexus yet (left out, never counted as zero).`)
  if (s.metaSaid.length) parts.push(`Meta itself reported ${s.metaSaid.length} thing${s.metaSaid.length === 1 ? '' : 's'} in those days (metaSaid).`)
  if (s.notChecked.length) parts.push('Some metrics could not be checked (notChecked).')
  parts.push('Computed by Nexus from its daily read (no Meta call); meta-ads-overview shows the days, meta-ads-live today\'s numbers.')
  return parts.join(' ')
}

/**
 * The signal for the business's chosen Meta ad account: its last `days` days (ending the account's yesterday) against the
 * up to 56 days before them, and Meta's own pushes in those days. Throws MetaAdsReadError for an unknown connection.
 */
export async function metaAnomalySignal(input: { connectionId?: string | null; days?: number | null }, now: Date = new Date()): Promise<MetaAnomalySignal> {
  const checkedDays = Math.min(META_ANOMALY_MAX_DAYS, Math.max(1, Math.trunc(Number(input.days)) || META_ANOMALY_DAYS))
  const overview = await metaAdsOverview({ connectionId: input.connectionId ?? null, days: checkedDays + META_ANOMALY_HISTORY_DAYS }, now)
  const empty = { anomalies: [], metaSaid: [], notChecked: [], checked: null, history: null, currency: overview.currency, timeZone: overview.timeZone, dataAsOf: overview.dataAsOf }
  if (!overview.connection) {
    return { ...empty, connected: false, adAccountId: null, sentence: 'Meta is not connected for this business: there are no Meta numbers to check. A person connects it in Settings › Channels › Meta.' }
  }
  if (!overview.account) {
    return { ...empty, connected: true, adAccountId: null, sentence: 'No Meta ad account is chosen for this business yet, so Nexus reads no Meta numbers. A person chooses one in Settings › Channels › Meta.' }
  }
  const days = overview.days
  const history = days.slice(0, Math.max(0, days.length - checkedDays))
  const checked = days.slice(-checkedDays)
  const { anomalies, notChecked } = metaAnomaliesOf(history, checked)
  const status = overview.account.accountStatus
  const accountStatus = status !== null && status !== 1 ? AD_ACCOUNT_STATUS_WORDS[status] ?? `Status ${status}` : undefined
  const from = checked[0]?.date ?? overview.window.to
  const metaSaid = await metaSaidSince(overview.account.adAccountId, new Date(`${addDays(from, -1)}T00:00:00.000Z`))
  const out = {
    connected: true,
    adAccountId: overview.account.adAccountId,
    currency: overview.currency,
    timeZone: overview.timeZone,
    ...(accountStatus ? { accountStatus } : {}),
    checked: checked.length ? { from, to: checked[checked.length - 1].date, daysRead: checked.filter((d) => d.read).length, notRead: checked.filter((d) => !d.read).map((d) => d.date) } : null,
    history: history.length ? { from: history[0].date, to: history[history.length - 1].date, daysRead: history.filter((d) => d.read).length } : null,
    anomalies,
    metaSaid,
    notChecked,
    dataAsOf: overview.dataAsOf,
  }
  return { ...out, sentence: sentenceOf(out) }
}
