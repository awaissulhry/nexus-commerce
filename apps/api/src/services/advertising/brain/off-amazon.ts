/**
 * ONE BRAIN AB-18 — the off-Amazon lane (design 2026-10-08-ads-one-brain/DESIGN.md §2.13, §2.4 step 4, §6 "Off-Amazon
 * limit", §9 "unverified API surfaces"). Pure: no database — brain/off-amazon-read.ts loads the rows, the `ads-brain`
 * money view shows the result (brain/budget-read.ts).
 *
 * Since 2026-08-10 Sponsored Products campaigns may also serve in creator content off Amazon, enrolled by default; placement %
 * does not apply there, Amazon's dynamic bidding does; the only controls are a campaign setting ("Increase reach" / "Limit
 * off-Amazon spend") and creator exclusions (INDUSTRY-2026-10.md [API-16], [API-17]: third-party sources).
 *
 *   verified    what Nexus could verify in its own Amazon Ads client, its types, docs and fixtures (OFF_AMAZON_CAPABILITY):
 *               report   the daily placement report (spCampaigns grouped by campaignPlacement; ads-reports.service.ts
 *                        ingestPlacementRows) keeps every placement label Amazon sends, as it came; the Marketing Stream
 *                        grain (BB-16, ams-grain.ts) maps a label naming off Amazon to OFF_AMAZON. COULD NOT VERIFY which
 *                        label, if any, Amazon gives off-Amazon placements in either: no Amazon type, doc or fixture in Nexus
 *                        names one. So a label that names off Amazon counts as the lane (normalizeStreamPlacement: one
 *                        classifier for both sources), a label Nexus does not know is listed under its own name and never
 *                        counted, and no such row is "none reported" — never "no spend".
 *               setting  COULD NOT VERIFY: Nexus's client has no field for "Limit off-Amazon spend" / "Increase reach" in the
 *                        campaign shapes it reads and writes (V3CampaignSettings, CampaignPatch, CreateCampaignInput: POST
 *                        /sp/campaigns/list, PUT and POST /sp/campaigns), and no doc or fixture names one. So the brain can
 *                        neither read, ask for nor write it: its judgement is a line for the Owner (Amazon's console), never
 *                        a request, and the lever takes OFF or OBSERVE only (brain/levers.ts).
 *   share       per product: the off-Amazon spend over the spend of every placement of its own campaigns in the settled
 *               window (OFF_AMAZON_WINDOW_DAYS, ads-settled-window.ts: the placement report's sales are 7-day attributed);
 *               per campaign the same. A shared campaign (D2: no product's brain owns it) and one the Owner excluded are
 *               listed with their own figures and never summed into the product's.
 *   judgement   §2.13 "its ACoS stays above the band top for 14 days", at the offAmazon lever's level — OFF judges nothing,
 *               EXCLUDED is left, LOCKED gets a recommendation against the Owner's own value, NOT_ENROLLED is judged as at
 *               the default (OBSERVE). Over the product's summed campaigns: the lane's ACoS over the window and in each
 *               7-day half against the band top (a half with spend and no sales is above; a half with no spend is not),
 *               past a spend gate of one order's worth at the band top (the product's ad order value × the band top), so
 *               a few clicks never decide:
 *                 no_report        no placement row for its campaigns in the window: could not measure
 *                 none_reported    placement rows, none naming off Amazon (could not verify the label: not "no spend")
 *                 no_band          no ACoS goal in the ads strategy: the band top is unknown
 *                 too_little       off-Amazon spend below the gate, or no ad order in the window to price one order
 *                 in_band          its ACoS at or below the band top
 *                 above_band       above the band top over the window, not in both halves yet
 *                 limit_suggested  above in both halves and over the window: the line for the Owner names the campaigns
 *                                  where it is above, to set "Limit off-Amazon spend" in Amazon's console
 *
 * Money: `why`, the figures and the gate name amounts or percents of spend; the view puts them under `money` keys (the
 * ads-brain tool hides those without the ad-spend permission). `ownerLine` names no amount.
 */
import { normalizeStreamPlacement, OFF_AMAZON } from '../ams-grain.js'
import { money } from './budget-envelope.js'

/** The settled window the lane is judged over, in days, and its halves ("stays above for 14 days", §2.13). */
export const OFF_AMAZON_WINDOW_DAYS = 14
export const OFF_AMAZON_HALF_DAYS = 7

/** What Nexus could verify about the off-Amazon lane in its own Amazon Ads client, types, docs and fixtures. */
export const OFF_AMAZON_CAPABILITY = {
  report: {
    read: 'placement report',
    how: 'the daily placement report (spCampaigns grouped by campaignPlacement) keeps every placement label Amazon sends, as it came, and the Marketing Stream hours map a label naming off Amazon to OFF_AMAZON. Could not verify which label Amazon gives off-Amazon placements: no Amazon Ads type, doc or fixture in Nexus names one. A label naming off Amazon counts as the lane; a label Nexus does not know is listed under its own name and never counted; no such row is "none reported", never "no spend".',
  },
  setting: {
    read: 'none',
    write: 'none',
    how: 'could not verify: Nexus\'s Amazon Ads client has no field for "Limit off-Amazon spend" / "Increase reach" in the campaign shapes it reads and writes (POST /sp/campaigns/list, PUT and POST /sp/campaigns), and no doc or fixture names one. The brain cannot read, ask for or write it: its judgement is a line for the Owner, who sets it in Amazon\'s console (the campaign\'s settings).',
  },
} as const

export const OFF_AMAZON_VERDICTS = ['off', 'excluded', 'no_report', 'none_reported', 'no_band', 'too_little', 'in_band', 'above_band', 'limit_suggested'] as const
export type OffAmazonVerdict = (typeof OFF_AMAZON_VERDICTS)[number]

/** One placement report row of one campaign on one day (minor units of the market's currency). */
export interface PlacementRow { campaignId: string; day: string; label: string; costCents: number; salesCents: number; orders: number; clicks: number }
export interface LaneCampaign { campaignId: string; name: string; owner: 'product' | 'shared'; excluded: boolean }
/** What the Marketing Stream hours (OFF_AMAZON, BB-16) saw on the summed campaigns in the window: a second witness. */
export interface StreamWitness { costCents: number; salesCents: number; orders: number; hours: number }
/** The offAmazon lever as the brain's settings resolve it for the product (settings.ts LeverSettings). */
export interface OffAmazonLever { effective: string; lock: { value: unknown; by?: string | null } | null }

export interface OffAmazonInput {
  productId: string
  name: string | null
  market: string
  currency: string
  /** The settled window, inclusive days (YYYY-MM-DD). */
  window: { from: string; to: string }
  campaigns: readonly LaneCampaign[]
  rows: readonly PlacementRow[]
  stream: StreamWitness | null
  /** The product's band top (a fraction: 0.25 = 25 %) and its words; null: no ACoS goal. */
  bandTop: { hi: number; words: string } | null
  lever: OffAmazonLever
}

export interface LaneTotals {
  spendCents: number
  offSpendCents: number
  offSalesCents: number
  offOrders: number
  offClicks: number
  /** Off-Amazon spend, % of every placement's spend; null: no spend at all. */
  sharePct: number | null
  /** Off-Amazon ACoS, %; null: no off-Amazon spend, or spend with no sales (`offNoSales`). */
  offAcosPct: number | null
  offNoSales: boolean
}

export interface LaneHalf { from: string; to: string; offSpendCents: number; offSalesCents: number; offAcosPct: number | null; above: boolean }

export interface OffAmazonLane {
  productId: string
  name: string | null
  market: string
  currency: string
  window: { from: string; to: string; days: number }
  status: 'no_report' | 'none_reported' | 'measured'
  /** Every placement label seen on the product's campaigns, with the lane it counts in (OTHER:<label>: never counted). */
  labels: Array<{ label: string; lane: string }>
  /** The summed campaigns: the product's own, not excluded. */
  product: LaneTotals & { campaigns: number; orders: number; salesCents: number }
  halves: [LaneHalf, LaneHalf]
  campaigns: Array<LaneTotals & { campaignId: string; name: string; owner: 'product' | 'shared'; excluded: boolean; summed: boolean; above: boolean | null }>
  stream: StreamWitness | null
  lever: { effective: string; lockValue: unknown }
  verdict: OffAmazonVerdict
  /** One order's worth at the band top (the spend gate); null: no band, or no order to price one. */
  gateCents: number | null
  /** The campaigns to limit (summed, off-Amazon ACoS above the band top), most off-Amazon spend first; empty unless limit_suggested. */
  limit: Array<{ campaignId: string; name: string }>
  /** The verdict in words, with its amounts (money). */
  why: string
  /** The line for the Owner, without amounts; null when there is nothing for him. */
  ownerLine: string | null
}

const DAY_MS = 86_400_000
const round2 = (x: number) => Math.round(x * 100) / 100
const pct = (x: number | null) => (x == null ? 'none' : `${round2(x)} %`)
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1

/** The lane a placement label counts in: the managed lanes, OFF_AMAZON, UNKNOWN, or OTHER:<label> (never counted). */
export const laneOf = (label: string): string => normalizeStreamPlacement(label)
export const isOffAmazon = (label: string): boolean => laneOf(label) === OFF_AMAZON

function totals(rows: readonly PlacementRow[]): LaneTotals & { orders: number; salesCents: number } {
  let spendCents = 0, salesCents = 0, orders = 0, offSpendCents = 0, offSalesCents = 0, offOrders = 0, offClicks = 0
  for (const r of rows) {
    spendCents += r.costCents; salesCents += r.salesCents; orders += r.orders
    if (isOffAmazon(r.label)) { offSpendCents += r.costCents; offSalesCents += r.salesCents; offOrders += r.orders; offClicks += r.clicks }
  }
  return {
    spendCents, salesCents, orders, offSpendCents, offSalesCents, offOrders, offClicks,
    sharePct: spendCents > 0 ? round2((offSpendCents / spendCents) * 100) : null,
    offAcosPct: offSpendCents > 0 && offSalesCents > 0 ? round2((offSpendCents / offSalesCents) * 100) : null,
    offNoSales: offSpendCents > 0 && offSalesCents <= 0,
  }
}

/** Above the band top: spend with no sales is above; no spend is not. */
const aboveTop = (t: Pick<LaneTotals, 'offSpendCents' | 'offSalesCents'>, hi: number) =>
  t.offSpendCents > 0 && (t.offSalesCents <= 0 || t.offSpendCents / t.offSalesCents > hi)

function half(rows: readonly PlacementRow[], from: string, to: string, hi: number | null): LaneHalf {
  const t = totals(rows.filter((r) => r.day >= from && r.day <= to))
  return { from, to, offSpendCents: t.offSpendCents, offSalesCents: t.offSalesCents, offAcosPct: t.offAcosPct, above: hi != null && aboveTop(t, hi) }
}

const names = (list: ReadonlyArray<{ name: string }>) => {
  const shown = list.slice(0, 5).map((c) => `"${c.name}"`).join(', ')
  return list.length > 5 ? `${shown} and ${list.length - 5} more` : shown
}

/** The off-Amazon lane of one product in one market: its share, its halves, the verdict and the line for the Owner. Pure. */
export function decideOffAmazon(input: OffAmazonInput): OffAmazonLane {
  const { window, currency } = input
  const days = daysBetween(window.from, window.to)
  const inWindow = input.rows.filter((r) => r.day >= window.from && r.day <= window.to)
  const byCampaign = new Map<string, PlacementRow[]>()
  for (const r of inWindow) byCampaign.set(r.campaignId, [...(byCampaign.get(r.campaignId) ?? []), r])
  const summed = input.campaigns.filter((c) => c.owner === 'product' && !c.excluded)
  const summedIds = new Set(summed.map((c) => c.campaignId))
  const summedRows = inWindow.filter((r) => summedIds.has(r.campaignId))
  const product = { ...totals(summedRows), campaigns: summed.length }
  const hi = input.bandTop?.hi ?? null
  const firstTo = addDays(window.from, OFF_AMAZON_HALF_DAYS - 1)
  const halves: [LaneHalf, LaneHalf] = [half(summedRows, window.from, firstTo, hi), half(summedRows, addDays(firstTo, 1), window.to, hi)]
  const labels = [...new Set(inWindow.map((r) => r.label))].sort().map((label) => ({ label, lane: laneOf(label) }))
  const offSeen = summedRows.some((r) => isOffAmazon(r.label))
  const status: OffAmazonLane['status'] = !summedRows.length ? 'no_report' : offSeen ? 'measured' : 'none_reported'
  const campaigns = input.campaigns.map((c) => {
    const t = totals(byCampaign.get(c.campaignId) ?? [])
    const { orders: _o, salesCents: _s, ...lane } = t
    return { campaignId: c.campaignId, name: c.name, owner: c.owner, excluded: c.excluded, summed: summedIds.has(c.campaignId), ...lane, above: hi == null || t.offSpendCents <= 0 ? null : aboveTop(t, hi) }
  })
  const aov = product.orders > 0 ? product.salesCents / product.orders : null
  const gateCents = hi != null && aov != null ? Math.max(1, Math.round(aov * hi)) : null
  const label = `${input.name ?? input.productId} (${input.market})`
  const span = `${window.from} to ${window.to}`
  const acosWords = product.offNoSales ? 'spend with no sales' : `ACoS ${pct(product.offAcosPct)}`
  const lockValue = input.lever.lock ? input.lever.lock.value ?? null : null

  let verdict: OffAmazonVerdict
  let why: string
  if (input.lever.effective === 'OFF') {
    verdict = 'off'
    why = `the off-Amazon lever is OFF for ${label}: the brain shows the lane and judges nothing`
  } else if (input.lever.effective === 'EXCLUDED') {
    verdict = 'excluded'
    why = `the Owner excluded ${label} from the brain: it shows the lane and judges nothing`
  } else if (status === 'no_report') {
    verdict = 'no_report'
    why = `could not measure: no placement report row for the ${summed.length} campaign${summed.length === 1 ? '' : 's'} of ${label} from ${span}`
  } else if (status === 'none_reported') {
    verdict = 'none_reported'
    why = `none reported: the placement report names no off-Amazon placement on ${label}'s campaigns from ${span} — Nexus could not verify the label Amazon gives it, so this is not "no spend"`
  } else if (hi == null) {
    verdict = 'no_band'
    why = `no ACoS goal in the ads strategy for ${label}: the band top is unknown, so the off-Amazon lane (${money(product.offSpendCents, currency)}, ${pct(product.sharePct)} of spend, ${acosWords}) is not judged`
  } else if (product.offSpendCents <= 0 || gateCents == null || product.offSpendCents < gateCents) {
    verdict = 'too_little'
    why = product.offSpendCents <= 0 ? `no off-Amazon spend on ${label}'s campaigns from ${span}`
      : gateCents == null ? `off-Amazon spend ${money(product.offSpendCents, currency)} from ${span}, but no ad order in the window to price one order: the brain does not judge it yet`
        : `off-Amazon spend ${money(product.offSpendCents, currency)} from ${span} is below one order's worth at the band top (${money(gateCents, currency)}): too little to judge`
  } else if (!aboveTop(product, hi)) {
    verdict = 'in_band'
    why = `off-Amazon ${acosWords} from ${span} is within the band top (${pct(hi * 100)}; ${input.bandTop!.words}); ${pct(product.sharePct)} of spend`
  } else if (!(halves[0].above && halves[1].above)) {
    verdict = 'above_band'
    why = `off-Amazon ${acosWords} from ${span} is above the band top (${pct(hi * 100)}), but not in both weeks (${halves.map((h) => `${h.from}: ${h.offSpendCents <= 0 ? 'no spend' : h.offSalesCents <= 0 ? 'spend with no sales' : pct(h.offAcosPct)}`).join('; ')}): the brain watches it`
  } else {
    verdict = 'limit_suggested'
    why = `off-Amazon ${acosWords} from ${span} stayed above the band top (${pct(hi * 100)}) in both weeks (${halves.map((h) => (h.offSalesCents <= 0 ? 'spend with no sales' : pct(h.offAcosPct))).join(', ')}), past one order's worth (${money(gateCents, currency)}): ${money(product.offSpendCents, currency)}, ${pct(product.sharePct)} of spend`
  }
  const limit = verdict === 'limit_suggested'
    ? campaigns.filter((c) => c.summed && c.above).sort((a, b) => b.offSpendCents - a.offSpendCents || a.name.localeCompare(b.name)).map((c) => ({ campaignId: c.campaignId, name: c.name }))
    : []
  let ownerLine: string | null = null
  if (verdict === 'limit_suggested' && limit.length) {
    const head = `Off-Amazon placements of ${label} stayed above the band top for ${days} settled days`
    const cannot = 'Nexus could not verify an Amazon Ads API setting for it, so the brain cannot ask for it or write it'
    if (input.lever.effective !== 'LOCKED') ownerLine = `${head}: set "Limit off-Amazon spend" in Amazon's console on ${names(limit)}. ${cannot}.`
    else if (lockValue === 'LIMIT') ownerLine = `${head}; your lock holds the off-Amazon setting at LIMIT: check in Amazon's console that "Limit off-Amazon spend" is set on ${names(limit)} (Nexus cannot read it).`
    else ownerLine = `${head}: a recommendation against your lock (${lockValue === 'INCREASE_REACH' ? '"Increase reach"' : 'the setting as it is'}) — "Limit off-Amazon spend" on ${names(limit)} in Amazon's console; nothing changes unless you change it. ${cannot}.`
  }
  if (input.lever.effective === 'NOT_ENROLLED' && verdict !== 'off' && verdict !== 'excluded') why = `${why} (not enrolled: decided as at the default level, OBSERVE)`
  return {
    productId: input.productId, name: input.name, market: input.market, currency,
    window: { from: window.from, to: window.to, days },
    status, labels, product, halves, campaigns, stream: input.stream,
    lever: { effective: input.lever.effective, lockValue },
    verdict, gateCents, limit, why, ownerLine,
  }
}

/**
 * The lane as the money view shows it: verdict, status, labels, the campaigns' names and the line for the Owner visible;
 * every amount, ACoS, share and the sentence naming them under `money`. Pure.
 */
export function offAmazonView(lane: OffAmazonLane) {
  const fig = (t: LaneTotals) => ({ spendCents: t.spendCents, offSpendCents: t.offSpendCents, offSalesCents: t.offSalesCents, offOrders: t.offOrders, offClicks: t.offClicks, sharePct: t.sharePct, offAcosPct: t.offAcosPct, offNoSales: t.offNoSales })
  return {
    window: lane.window, status: lane.status, verdict: lane.verdict,
    lever: lane.lever, labels: lane.labels,
    limit: lane.limit, ownerLine: lane.ownerLine,
    campaigns: lane.campaigns.map((c) => ({ campaignId: c.campaignId, name: c.name, owner: c.owner, excluded: c.excluded, summed: c.summed, above: c.above, money: fig(c) })),
    ...(lane.stream ? { stream: { hours: lane.stream.hours, money: { costCents: lane.stream.costCents, salesCents: lane.stream.salesCents, orders: lane.stream.orders } } } : {}),
    capability: OFF_AMAZON_CAPABILITY,
    money: {
      currency: lane.currency, ...fig(lane.product), campaigns: lane.product.campaigns,
      halves: lane.halves, gateCents: lane.gateCents, why: lane.why,
    },
  }
}

/** A product's share in the market's money view: the status and, under `money`, the figures. Pure. */
export function offAmazonShare(lane: Pick<OffAmazonLane, 'status' | 'product' | 'currency'>) {
  return {
    status: lane.status,
    money: { currency: lane.currency, spendCents: lane.product.spendCents, offSpendCents: lane.product.offSpendCents, sharePct: lane.product.sharePct, offAcosPct: lane.product.offAcosPct, offNoSales: lane.product.offNoSales },
  }
}
