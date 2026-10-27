/**
 * Negative Targeting page (NREAD, 2026-10-11) — the shapes, ids, links, window and small pure helpers of the waste
 * reads (`/api/advertising/waste/*`, the MCP tool `ad-waste`). No database and no clock here: read.ts loads the facts,
 * test.ts / verb.ts / owner.ts decide each row, and this file holds what every one of them shares.
 *
 *   rows      one row per OUR keyword or target (`kw:<AdTarget.id>`) and per SHOPPER'S search term in one ad group
 *             (`term:<market>|<external ad group id>|<term key>`: Amazon's search-term report names ad groups by their
 *             EXTERNAL id, so the row id does too — a local id there would join nothing)
 *   window    late-order safe: clicks and spend from `since` to `clicksThrough` (3 days ago), orders and sales from `since`
 *             to today (a late order can only save a row); days a place was out of stock are left out of the clicks and
 *             spend only (an order on such a day still counts: only what can save a row is kept)
 *   money     cents of the row's currency under WASTE_MONEY keys; the route strips them without financials.adspend.view
 *   links     hrefs WITHOUT the business prefix (/w/<id>): the web puts it in front, as for every ads link the API gives
 */
import { FIELDS } from '@nexus/shared/permissions'

export const DAY_MS = 86_400_000

/** The page's default window (PLAN §2): 60 days. The ads strategy's negate group may name 30 or 90. */
export const WASTE_WINDOW_DAYS = 60
/** Clicks and spend count up to this many days ago; orders up to today (the Owner's late-order-safe rule). */
export const CLICK_LAG_DAYS = 3
/** Days read back (d90, a 90-day strategy window, 8 weeks of spark). Amazon search terms are kept 90 days here. */
export const READ_DAYS = 93
/** The 90-day line every row carries. */
export const D90_DAYS = 90
/** Spend per week, oldest first. */
export const SPARK_WEEKS = 8
/** No test asks fewer clicks than this (Amazon's own advice and the industry floor, 5-neg-industry.md §5). */
export const MIN_CLICKS_FLOOR = 20
/** A search term wastes past 1.5 target CPAs; our keyword past 2 (a keyword sums many terms). PLAN §2. */
export const TERM_CPA_BAR = 1.5
export const KEYWORD_CPA_BAR = 2
/** No target ACoS anywhere: a fixed bar in minor units of the row's currency (PLAN §2 "a fixed bar per scope"). */
export const FIXED_TERM_SPEND_BAR_CENTS = 1500
export const FIXED_KEYWORD_SPEND_BAR_CENTS = 3000
/** Never stop in a place younger than this, nor a term harvested more recently than that (PLAN §2 never-list). */
export const PLACE_MIN_AGE_DAYS = 14
export const HARVEST_QUIET_DAYS = 30
/** How far back the last change is read. */
export const LAST_CHANGE_DAYS = 30
/** Rows per page. */
export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 200
/** `/rows/ids` answers at most this many ids. */
export const MAX_IDS = 5000

export interface Ref { id: string; name: string; href?: string }

/** The tools whose requests this page decides (a pause, its release, a negative, its removal), alone or in a change plan. */
export const WASTE_TOOLS = ['pause-ads', 'enable-ads', 'add-negative-targets', 'retire-negatives', 'create-negative-keyword'] as const

export type RowKind = 'KEYWORD' | 'TARGET' | 'TERM'
export type Match = 'EXACT' | 'PHRASE' | 'BROAD' | 'AUTO' | 'ASIN' | 'CATEGORY'
/** TURNED_ON_ELSEWHERE: kept paused (NWRITE's hold), but Amazon serves it — someone switched it on outside Nexus. */
export type RowState = 'RUNNING' | 'PAUSED' | 'KEPT_PAUSED' | 'TURNED_ON_ELSEWHERE' | 'NEGATED' | 'PROTECTED'
export type OwnerKind = 'BRAIN' | 'RULE' | 'HARVEST' | 'PERSON' | 'CLAUDE' | 'NONE'
export const OWNER_KINDS: readonly OwnerKind[] = ['BRAIN', 'RULE', 'HARVEST', 'PERSON', 'CLAUDE', 'NONE']
export interface Owner { kind: OwnerKind; name: string; id: string | null }
export type VerbAction = 'PAUSE' | 'NEGATE_EXACT' | 'NEGATE_PHRASE' | 'NEGATE_ASIN' | 'REMOVE_NEGATIVE'
export interface Verb {
  action: VerbAction
  where: 'adGroup' | 'campaign'
  held: null | { label: string; reason: string }
  /** REMOVE_NEGATIVE: the negative's own row (neg:<id>) the fix removes. */
  targetRowId?: string
}

export interface RowTest {
  met: boolean
  /** Who set the bar: a rule, the ads strategy; null = the page's default test (PLAN §2). */
  by: Ref | null
  /** The test in words, with no money in them (the money sits under its keys). */
  sentence: string
  windowDays: number
  clicksNeeded: number
  spendBarCents: number | null
  xCpaBar: number | null
  /** HONEST 15 — false: the row is listed only for an ask (askOnly), the test never ran on it; absent: it was judged. */
  judged?: false
  /** HONEST 18c — the last day whose clicks and spend the window counts (YYYY-MM-DD, 3 days ago): "60 days to 24 Oct". */
  settledThrough?: string
}

export interface RowNumbers {
  impressions: number
  clicks: number
  orders: number
  spendCents: number
  salesCents: number
  acosPct: number | null
  cpcCents: number | null
  /** Spend ÷ the product's target cost per order; null without one. */
  xCpa: number | null
}

export interface WasteRow {
  id: string
  kind: RowKind
  text: string
  match: Match
  channel: 'AMAZON'
  market: string
  currency: string
  portfolio: Ref | null
  campaign: Ref
  adGroup: Ref
  product: Ref | null
  /** Product families the campaign advertises (2+ = shared: `product` is null). */
  productCount: number
  /** TERM: the keyword or target that bought it (most clicks in the window). */
  via: Ref | null
  state: RowState
  owner: Owner
  verb: Verb
  test: RowTest
  /** null: Amazon reported nothing for this keyword in the read window ("no data" is not "0 orders"). */
  d: RowNumbers | null
  d90: { clicks: number; orders: number; spendCents: number } | null
  spark: number[]
  stockOutDays: number
  /** What waits for a person: one ask (approval or rule card) may cover several rows (`rows`). */
  waiting: null | {
    approvalId: string; by: Ref; at: string; expiresAt: string | null; rows: number
    /** NFIX — the ask is a change plan: its steps (decided whole) and how many are not on this page. */
    plan?: { steps: number; offPage: number }
    /**
     * HONEST 10 — the ask's OWN change at this row, never the row's verb: its action, the negative's match (our keyword's
     * own for a pause), where it lands (a negative's ad group or whole campaign; null for a pause), its words, and for a
     * pause whether it keeps it paused. Absent on an older answer.
     */
    action?: VerbAction
    match?: Match | null
    level?: 'AD_GROUP' | 'CAMPAIGN' | null
    text?: string | null
    keepPaused?: boolean
    /** HONEST 18d — a removal: whether Amazon holds the negative (false: it changes Nexus only, nothing is archived). */
    atAmazon?: boolean
    /** HONEST 11 — how many of this page's changes the ask holds, in every market (1: one change, which may still cover several rows). */
    changes?: number
  }
  skipped: null | { until: string; by: string | null; at: string | null }
  /**
   * TERM: other live ad groups where the term spent in the window (to its settled day), not blocked there now; KEYWORD:
   * where its text did (HONEST 18b: spend, never impressions alone).
   */
  stillServesIn: number
  /**
   * HONEST 13 — a NEGATED term: the standing negative that blocks it here (its own words, match and level — never the
   * match of the keyword that bought the term). Absent on every other row.
   */
  blockedBy?: { rowId: string; text: string; match: 'EXACT' | 'PHRASE' | 'ASIN'; level: 'AD_GROUP' | 'CAMPAIGN'; campaign: Ref; adGroup: Ref | null; owner: Owner }
  lastChange: null | { action: string; at: string; by: Ref; changeId: string | null }
  /**
   * NFIX (2026-10-11) — a row that is listed ONLY because something waits on it here (the Brain's, a rule's, Claude's or a
   * person's ask): a negative that would land where the term has no row of its own (a phrase piece, a term the place never
   * bought, a paused place), a negative removal, a pause in a place that does not run. It shows under "Waiting" only and
   * counts only there (the tile counts every ask it lists: no count without a list). Absent on every other row.
   */
  askOnly?: true
  /**
   * Step 4 — a PROTECTED row only: every protected term that keeps it safe (the page names the first),
   * each with its match, scope and why, and `then`: the hold its verb keeps once they are all removed (protect.ts).
   */
  protection?: RowProtection
  /**
   * Step 4 — "Remove protection and stop" on this row, still finishing on the server: WAITING (its negative is sent once
   * the protection is removed) or REFUSED (the protection went, the negative did not: `why`, in plain words). Absent else.
   */
  followUp?: { status: 'WAITING' | 'REFUSED'; why: string | null; at: string }
  /** A clash the Owner should see (the Clashes tile lists exactly these rows), with why in plain words; null: none. */
  clash: null | {
    kind: ClashKind
    label: string
    /** NEG_OVER_OWN_KEYWORD: the standing negative that blocks our keyword (the fix removes it). */
    negative?: { rowId: string; text: string; match: 'EXACT' | 'PHRASE' | 'ASIN'; level: 'AD_GROUP' | 'CAMPAIGN'; campaign: Ref; adGroup: Ref | null; owner: Owner }
  }
}

/** Step 4 — one protected term (AdKeywordProtection) that keeps a row safe, as the row shows it. */
export interface RowProtectionTerm {
  id: string
  term: string
  match: 'EXACT' | 'PREFIX' | 'CONTAINS'
  /** null: every market. */
  market: string | null
  /** null: every campaign. */
  campaign: Ref | null
  reason: string | null
}
export interface RowProtection {
  terms: RowProtectionTerm[]
  /** The hold the row's verb keeps once every term is removed; null: the verb runs. */
  then: { label: string; reason: string } | null
}

/**
 * TURNED_ON — kept paused, but switched on outside Nexus · NEG_OVER_OWN_KEYWORD — a negative in our own live keyword's place
 * that blocks now every search it can serve (negativeClashesWith; never the Owner's funnel) · BLOCKS_SOLD — a negative that
 * blocks now a search term which sold in this place in the window (never a funnel negative: it hands the sale on purpose).
 */
export type ClashKind = 'TURNED_ON' | 'NEG_OVER_OWN_KEYWORD' | 'BLOCKS_SOLD'
export const CLASH_LABELS: Readonly<Record<ClashKind, string>> = {
  TURNED_ON: 'Turned on outside Nexus',
  NEG_OVER_OWN_KEYWORD: 'Negative over our own keyword',
  BLOCKS_SOLD: 'Blocks a term that sold here',
}

export interface WasteTotals {
  wasting: number
  /** The wasting rows' spend, when they share one currency; null when they bill in several (see the split and the note). */
  wastingSpendCents: number | null
  /** The one currency of the wasting rows (else of every row); null when several, or none. */
  currency: string | null
  /** The wasting spend per currency (never added across currencies). */
  wastingSpendByCurrency: Record<string, number>
  /** Why the spend is not one number (several currencies); null when it is. */
  wastingSpendNote: string | null
  /** HONEST 18c — the windows (days) of the rows the wasting spend sums, lowest first: one, or several (30, 60, 90). */
  wastingWindows?: number[]
  keywords: number
  terms: number
  waiting: number
  keptPaused: number
  /** Kept paused, but switched on outside Nexus (S8): shown where the Owner looks. */
  turnedOn: number
  negated: number
  clashes: number
  skipped: number
  /** Step 4 — wasting rows a protected term keeps safe: exactly what show=protected answers (isKeptSafe). */
  protected: number
}

export interface WasteCriteria {
  sentence: string
  source: 'rule' | 'strategy' | 'default'
  windowDays: number
  /** Clicks and spend count to this day (YYYY-MM-DD). */
  settledThrough: string
  /** Orders count to this day. */
  ordersThrough: string
}

/**
 * The money keys of every waste answer (stripped for a person without financials.adspend.view, the route). Step 4: a
 * stop's effect (effect.ts) keeps its money under beforePerDayCents, afterCents and savedCents; a reach (reach.ts) under
 * spendCents and salesCents.
 */
export const WASTE_MONEY: Readonly<Record<string, string>> = Object.fromEntries(
  ['spendCents', 'salesCents', 'acosPct', 'cpcCents', 'xCpa', 'spendBarCents', 'wastingSpendCents', 'wastingSpendByCurrency', 'spendBeforeCents', 'spark', 'beforePerDayCents', 'afterCents', 'savedCents']
    .map((k) => [k, FIELDS.financialsAdspendView]),
)

// ── Ids ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export const keywordRowId = (targetId: string) => `kw:${targetId}`
export const negRowId = (targetId: string) => `neg:${targetId}`
export const termRowId = (market: string, externalAdGroupId: string, key: string) => `term:${market}|${externalAdGroupId}|${key}`

export type ParsedRowId =
  | { kind: 'kw'; targetId: string }
  | { kind: 'neg'; targetId: string }
  | { kind: 'term'; market: string; externalAdGroupId: string; termKey: string }

/** A row id back to its parts; null when it is none of the three forms. A term may itself hold '|': split on the first two. */
export function parseRowId(id: string): ParsedRowId | null {
  const s = String(id ?? '').trim()
  if (s.startsWith('kw:') && s.length > 3) return { kind: 'kw', targetId: s.slice(3) }
  if (s.startsWith('neg:') && s.length > 4) return { kind: 'neg', targetId: s.slice(4) }
  if (s.startsWith('term:')) {
    const rest = s.slice(5)
    const a = rest.indexOf('|')
    const b = a < 0 ? -1 : rest.indexOf('|', a + 1)
    if (a <= 0 || b <= a + 1 || b === rest.length - 1) return null
    return { kind: 'term', market: rest.slice(0, a), externalAdGroupId: rest.slice(a + 1, b), termKey: rest.slice(b + 1) }
  }
  return null
}

// ── Terms and matches ───────────────────────────────────────────────────────────────────────────────────────────

export const isAsinText = (s: string): boolean => /^b0[a-z0-9]{8}$/i.test(s.trim())
/** A search term as stored and compared: lower case, single spaces; an ASIN lower case (the brain's negTermKey). */
export const termKeyOf = (s: string): string => (isAsinText(s) ? s.trim().toLowerCase() : String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim())

const AUTO_GROUPS = new Set(['SEARCH_CLOSE_MATCH', 'SEARCH_LOOSE_MATCH', 'PRODUCT_SUBSTITUTES', 'PRODUCT_COMPLEMENTS', 'SEARCH_RELATED_TO_YOUR_BRAND', 'SEARCH_RELATED_TO_YOUR_LANDING_PAGES', 'QUERY_HIGH_REL_MATCHES', 'QUERY_BROAD_REL_MATCHES', 'ASIN_SUBSTITUTE_RELATED', 'ASIN_ACCESSORY_RELATED'])

/**
 * Our keyword or target: its row kind and match, or null for what this page does not judge (audiences, unknown kinds).
 * The stored match type has six spellings (negatives.service.ts): one leading underscore and NEGATIVE_ are stripped.
 */
export function targetMatch(kind: string | null | undefined, expressionType: string | null | undefined): { rowKind: 'KEYWORD' | 'TARGET'; match: Match } | null {
  const k = String(kind ?? '').toUpperCase()
  const e = String(expressionType ?? '').trim().toUpperCase().replace(/^_+/, '').replace(/^NEGATIVE_/, '')
  if (k === 'KEYWORD') return e === 'EXACT' || e === 'PHRASE' || e === 'BROAD' ? { rowKind: 'KEYWORD', match: e } : null
  if (k === 'AUTO' || AUTO_GROUPS.has(e)) return { rowKind: 'TARGET', match: 'AUTO' }
  if (k === 'PRODUCT') return { rowKind: 'TARGET', match: e === 'PRODUCT_SIMILAR' ? 'AUTO' : 'ASIN' }
  if (k === 'PRODUCT_CATEGORY' || k === 'CATEGORY') return { rowKind: 'TARGET', match: 'CATEGORY' }
  return null
}

/** A negative's match: EXACT, PHRASE or ASIN (a negative product target); null for anything else. */
export function negativeMatch(kind: string | null | undefined, expressionType: string | null | undefined): 'EXACT' | 'PHRASE' | 'ASIN' | null {
  if (String(kind ?? '').toUpperCase() === 'PRODUCT') return 'ASIN'
  const e = String(expressionType ?? '').trim().toUpperCase().replace(/^_+/, '').replace(/^NEGATIVE_/, '')
  if (e === 'EXACT') return 'EXACT'
  if (e === 'PHRASE') return 'PHRASE'
  if (e === 'PRODUCT_EXACT' || e === 'ASIN') return 'ASIN'
  return null
}

const padded = (s: string) => ` ${s} `
/** Does a standing negative (its text, its match) block this search term? Exact: the same text; phrase: its words in order inside; ASIN: the same ASIN. */
export function negativeBlocksTerm(term: string, negative: { text: string; match: 'EXACT' | 'PHRASE' | 'ASIN' }): boolean {
  const n = termKeyOf(negative.text)
  if (!n || !term) return false
  if (negative.match === 'PHRASE') return padded(term).includes(padded(n))
  return n === term
}

/**
 * HONEST 5 — is this standing negative a CLASH with our keyword or product target: does it block EVERY search ours can
 * serve? Our EXACT keyword: a negative exact of its words, or a negative phrase its words hold (whole, in order). Our
 * PHRASE keyword: a negative phrase its words hold. Our product target: a negative product of the same ASIN. Never a
 * broad keyword, an auto or category target, nor a negative product over a keyword: a negative exact over our phrase or
 * broad keyword, and a negative phrase over our broad one, block only some of its searches (the Owner's funnel).
 */
export function negativeClashesWith(ours: { text: string; match: Match }, negative: { text: string; match: 'EXACT' | 'PHRASE' | 'ASIN' }): boolean {
  const key = termKeyOf(ours.text)
  if (!key) return false
  if (ours.match === 'ASIN') return negative.match === 'ASIN' && isAsinText(key) && negativeBlocksTerm(key, negative)
  if (negative.match === 'ASIN') return false
  if (ours.match === 'EXACT') return negativeBlocksTerm(key, negative)
  if (ours.match === 'PHRASE') return negative.match === 'PHRASE' && negativeBlocksTerm(key, negative)
  return false
}

/**
 * HONEST 5 — the Owner's funnel (his saved rule, 2026-10-09): a negative of our own keyword's very words in its place,
 * narrower than it — a negative exact over our phrase or broad keyword, a negative phrase over our broad one. It hands
 * those searches to the narrower keyword's place on purpose: never a clash.
 */
export function isFunnelNegative(ours: { text: string; match: Match }, negative: { text: string; match: 'EXACT' | 'PHRASE' | 'ASIN' }): boolean {
  const key = termKeyOf(ours.text)
  if (!key || key !== termKeyOf(negative.text)) return false
  return (negative.match === 'EXACT' && (ours.match === 'PHRASE' || ours.match === 'BROAD')) || (negative.match === 'PHRASE' && ours.match === 'BROAD')
}

// ── The window ──────────────────────────────────────────────────────────────────────────────────────────────────

const dayStart = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS
export const isoDay = (d: Date | number) => new Date(typeof d === 'number' ? d : d.getTime()).toISOString().slice(0, 10)

export interface WasteWindow {
  windowDays: number
  /** First day counted (00:00 UTC). */
  since: Date
  /** Last day whose clicks and spend count (00:00 UTC). */
  clicksThrough: Date
  /** Last day whose orders count: today (00:00 UTC). */
  ordersThrough: Date
}

/** The late-order-safe window of `windowDays`, ending CLICK_LAG_DAYS ago for clicks and today for orders. */
export function wasteWindow(now: Date, windowDays: number = WASTE_WINDOW_DAYS): WasteWindow {
  const today = dayStart(now.getTime())
  const clicksThrough = today - CLICK_LAG_DAYS * DAY_MS
  const since = clicksThrough - (Math.max(1, Math.round(windowDays)) - 1) * DAY_MS
  return { windowDays: Math.max(1, Math.round(windowDays)), since: new Date(since), clicksThrough: new Date(clicksThrough), ordersThrough: new Date(today) }
}

/** One day of a row's evidence. */
export interface DayEvidence { day: number; impressions: number; clicks: number; spendCents: number; orders: number; salesCents: number }

/** Day index (days since the epoch) of a date. */
export const dayIndex = (d: Date | number) => Math.floor((typeof d === 'number' ? d : d.getTime()) / DAY_MS)

/**
 * A row's numbers over a window: clicks, impressions and spend from `since` to `clicksThrough` with the out-of-stock days
 * left out; orders and sales from `since` to today, every day (a late order, or one on a day out of stock, can only save
 * the row). `stockOutDays`: the days left out.
 */
export function windowNumbers(days: readonly DayEvidence[], w: WasteWindow, outOfStock: ReadonlySet<number> = new Set()): { n: Omit<RowNumbers, 'xCpa'>; stockOutDays: number } {
  const from = dayIndex(w.since)
  const clicksTo = dayIndex(w.clicksThrough)
  const ordersTo = dayIndex(w.ordersThrough)
  let impressions = 0, clicks = 0, spendCents = 0, orders = 0, salesCents = 0
  for (const d of days) {
    if (d.day < from || d.day > ordersTo) continue
    orders += d.orders
    salesCents += d.salesCents
    if (d.day > clicksTo || outOfStock.has(d.day)) continue
    impressions += d.impressions
    clicks += d.clicks
    spendCents += d.spendCents
  }
  let stockOutDays = 0
  for (const day of outOfStock) if (day >= from && day <= clicksTo) stockOutDays++
  return {
    n: {
      impressions, clicks, orders, spendCents, salesCents,
      acosPct: salesCents > 0 ? Math.round((spendCents / salesCents) * 1000) / 10 : null,
      cpcCents: clicks > 0 ? Math.round(spendCents / clicks) : null,
    },
    stockOutDays,
  }
}

/** Spend per week over the last SPARK_WEEKS weeks ending today, oldest first. */
export function sparkOf(days: readonly DayEvidence[], now: Date): number[] {
  const to = dayIndex(now)
  const out = new Array<number>(SPARK_WEEKS).fill(0)
  for (const d of days) {
    const back = to - d.day
    if (back < 0 || back >= SPARK_WEEKS * 7) continue
    out[SPARK_WEEKS - 1 - Math.floor(back / 7)] += d.spendCents
  }
  return out
}

/**
 * The days a place counts as out of stock: half or more of its advertised products (SKUs) had an open stock-out that
 * day (StockoutEvent, any warehouse, the place's market or none). Leaving a day out only takes clicks and spend away
 * from the waste test, so a doubtful day errs towards "not the keyword's fault".
 */
export function outOfStockDays(
  productIds: readonly string[],
  events: ReadonlyArray<{ productId: string; startedAt: Date; endedAt: Date | null }>,
  fromDay: number,
  toDay: number,
): Set<number> {
  const out = new Set<number>()
  const ids = [...new Set(productIds)]
  if (!ids.length) return out
  const need = Math.ceil(ids.length / 2)
  const byProduct = new Map<string, Array<{ s: number; e: number }>>()
  for (const ev of events) {
    if (!ids.includes(ev.productId)) continue
    const s = dayIndex(ev.startedAt)
    const e = ev.endedAt ? dayIndex(ev.endedAt) : toDay
    byProduct.set(ev.productId, [...(byProduct.get(ev.productId) ?? []), { s, e }])
  }
  if (byProduct.size < need) return out
  for (let day = fromDay; day <= toDay; day++) {
    let n = 0
    for (const spans of byProduct.values()) if (spans.some((x) => x.s <= day && x.e >= day)) n++
    if (n >= need) out.add(day)
  }
  return out
}

// ── Links ───────────────────────────────────────────────────────────────────────────────────────────────────────

const enc = encodeURIComponent
export const portfolioHref = (externalPortfolioId: string) => `/marketing/ads/portfolios/${enc(externalPortfolioId)}`
export const campaignHref = (campaignId: string) => `/marketing/ads/campaigns/${enc(campaignId)}`
export type AdGroupTab = 'targets' | 'search-terms' | 'ad-group-negative-keywords'
export const adGroupHref = (campaignId: string, adGroupId: string, tab?: AdGroupTab, focus?: string | null) =>
  `/marketing/ads/campaigns/${enc(campaignId)}/ad-groups/${enc(adGroupId)}${tab ? `?tab=${tab}${focus ? `&focus=${enc(focus)}` : ''}` : ''}`
export const productHref = (productId: string) => `/products/${enc(productId)}`

// ── Delivery and undo of a recorded change ──────────────────────────────────────────────────────────────────────

export type Delivery = 'WAITING' | 'SENT' | 'LIVE' | 'UNDONE' | 'FAILED' | 'CANCELLED' | 'REFUSED'

/** An action-log row's delivery, in the page's words (amazonResponseStatus; an undone change is UNDONE). */
export function deliveryOf(status: string | null | undefined, rolledBackAt: Date | null | undefined): Delivery {
  if (rolledBackAt) return 'UNDONE'
  const s = String(status ?? '').toUpperCase()
  if (s === 'SUCCESS' || s === 'APPLIED') return 'LIVE'
  if (s === 'FAILED') return 'FAILED'
  if (s === 'REFUSED' || s === 'DENIED' || s === 'BLOCKED') return 'REFUSED'
  if (s === 'SKIPPED' || s === 'CANCELLED' || s === 'SUPERSEDED') return 'CANCELLED'
  return 'SENT'
}

// ── Filters, order, pages ───────────────────────────────────────────────────────────────────────────────────────

export type ShowFilter = 'wasting' | 'waiting' | 'skipped' | 'turned-on' | 'clashes' | 'protected' | 'all'
export type KindFilter = 'keyword' | 'term' | 'all'
export const SORT_KEYS = ['spend', 'clicks', 'orders', 'xCpa', 'text', 'where', 'product', 'owner', 'state'] as const
export type SortKey = (typeof SORT_KEYS)[number]

/** The rows a Wasting tile counts: the test met, still running (a protected one shows its held verb), not skipped. */
export const isWasting = (r: Pick<WasteRow, 'test' | 'state' | 'skipped'>) => r.test.met && (r.state === 'RUNNING' || r.state === 'PROTECTED') && !r.skipped
/** Step 4 — the Protected tile: a wasting row that a protected term keeps safe (the test met, PROTECTED, not skipped). */
export const isKeptSafe = (r: Pick<WasteRow, 'test' | 'state' | 'skipped'>) => r.test.met && r.state === 'PROTECTED' && !r.skipped

export function showMatches(r: WasteRow, show: ShowFilter): boolean {
  // A row listed only for what waits on it shows under Waiting, never as a keyword or term "with numbers" (All).
  if (r.askOnly) return show === 'waiting' && r.waiting != null
  if (show === 'wasting') return isWasting(r)
  if (show === 'waiting') return r.waiting != null
  if (show === 'skipped') return r.skipped != null
  if (show === 'turned-on') return r.state === 'TURNED_ON_ELSEWHERE'
  if (show === 'clashes') return r.clash != null
  if (show === 'protected') return isKeptSafe(r)
  return true
}

export const kindMatches = (r: Pick<WasteRow, 'kind'>, kind: KindFilter) => kind === 'all' || (kind === 'term' ? r.kind === 'TERM' : r.kind !== 'TERM')

/** `owner`: a kind (any case) or an owner's id (a rule's id, brain, …); empty: every row. */
export function ownerMatches(o: Owner, filter: string | null | undefined): boolean {
  const f = String(filter ?? '').trim()
  if (!f) return true
  const up = f.toUpperCase()
  if ((OWNER_KINDS as readonly string[]).includes(up)) return o.kind === up
  return o.id === f
}

/** Free text over the words, the campaign, the ad group, the portfolio and the product. */
export function textMatches(r: Pick<WasteRow, 'text' | 'campaign' | 'adGroup' | 'portfolio' | 'product'>, q: string | null | undefined): boolean {
  const s = String(q ?? '').trim().toLowerCase()
  if (!s) return true
  return [r.text, r.campaign.name, r.adGroup.name, r.portfolio?.name, r.product?.name].some((x) => (x ?? '').toLowerCase().includes(s))
}

/**
 * The rows' order. `sort` = a key, with '-' in front for descending. A person who does not see ad spend may not order
 * by a money key (the order would give the ranking away): the route turns those into `where`.
 */
export function compareRows(sort: string | null | undefined): (a: WasteRow, b: WasteRow) => number {
  const raw = String(sort ?? '-spend').trim() || '-spend'
  const desc = raw.startsWith('-')
  const key = (desc ? raw.slice(1) : raw) as SortKey
  const where = (r: WasteRow) => `${r.portfolio?.name ?? ''} ${r.campaign.name} ${r.adGroup.name}`
  const byName = (a: WasteRow, b: WasteRow) => where(a).localeCompare(where(b)) || a.text.localeCompare(b.text) || a.id.localeCompare(b.id)
  const num = (f: (r: WasteRow) => number | null | undefined) => (a: WasteRow, b: WasteRow) => {
    const x = f(a) ?? -Infinity
    const y = f(b) ?? -Infinity
    return x === y ? 0 : x < y ? -1 : 1
  }
  const str = (f: (r: WasteRow) => string) => (a: WasteRow, b: WasteRow) => f(a).localeCompare(f(b))
  const base: Record<SortKey, (a: WasteRow, b: WasteRow) => number> = {
    spend: num((r) => r.d?.spendCents),
    clicks: num((r) => r.d?.clicks),
    orders: num((r) => r.d?.orders),
    xCpa: num((r) => r.d?.xCpa),
    text: str((r) => r.text),
    where: str(where),
    product: str((r) => r.product?.name ?? (r.productCount > 1 ? `~${r.productCount}` : '~')),
    owner: str((r) => r.owner.name),
    state: str((r) => r.state),
  }
  const cmp = base[(SORT_KEYS as readonly string[]).includes(key) ? key : 'spend']
  return (a, b) => (desc ? -cmp(a, b) : cmp(a, b)) || byName(a, b)
}

/** A money sort key, for a person who may not order by it. */
export const isMoneySort = (sort: string | null | undefined) => ['spend', 'xcpa'].includes(String(sort ?? '').replace(/^-/, '').toLowerCase())

export function pageOf<T>(rows: readonly T[], page: number | null | undefined, pageSize: number | null | undefined): { rows: T[]; page: number; pageSize: number } {
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.round(pageSize ?? DEFAULT_PAGE_SIZE)))
  const p = Math.max(1, Math.round(page ?? 1))
  return { rows: rows.slice((p - 1) * size, p * size), page: p, pageSize: size }
}

/**
 * The tiles, from the SAME rows the table pages (Bid audit M1): each tile counts what its own `show` would answer, over
 * the scope and the text and owner filters; `keywords` and `terms` split the rows of the current `show` (the
 * All · Keywords · Search terms switch). `negated` counts standing negatives in the scope (read.ts gives it); `clashes`
 * counts the rows with a clash (show=clashes).
 * `wastingSpendCents` counts each euro once: a wasting term bought by a wasting keyword is inside that keyword's spend.
 */
/** Each ask's row count over these rows (waiting.rows): the page decides per ask, "2 places" where it covers two. */
export function withAskCounts<T extends Pick<WasteRow, 'waiting'>>(rows: readonly T[]): T[] {
  const n = new Map<string, number>()
  for (const r of rows) if (r.waiting) n.set(r.waiting.approvalId, (n.get(r.waiting.approvalId) ?? 0) + 1)
  return rows.map((r) => (r.waiting ? { ...r, waiting: { ...r.waiting, rows: n.get(r.waiting.approvalId) ?? 1 } } : r))
}

export function totalsOf(rows: readonly WasteRow[], show: ShowFilter, extra: { negated: number }): WasteTotals {
  let wasting = 0, keptPaused = 0, turnedOn = 0, skipped = 0, keywords = 0, terms = 0, keptSafe = 0
  // Waiting counts asks (an approval or a rule card), not rows: one ask may cover several places.
  const asks = new Set<string>()
  const byCurrency: Record<string, number> = {}
  const windows = new Set<number>()
  // A search term's spend is part of the keyword that bought it: when that keyword's row wastes too, the money is
  // counted once (on the keyword), never twice.
  const wastingKeywords = new Set(rows.filter((r) => r.kind !== 'TERM' && isWasting(r)).map((r) => r.id.slice(3)))
  for (const r of rows) {
    // A row listed only for its ask counts that ask (and the kind split under Waiting), nothing else.
    if (r.askOnly) {
      if (r.waiting) asks.add(r.waiting.approvalId)
      if (showMatches(r, show)) { if (r.kind === 'TERM') terms++; else keywords++ }
      continue
    }
    if (isWasting(r)) {
      wasting++
      if (!(r.kind === 'TERM' && r.via && wastingKeywords.has(r.via.id))) {
        byCurrency[r.currency] = (byCurrency[r.currency] ?? 0) + (r.d?.spendCents ?? 0)
        // HONEST 18c — the tile says the window of the rows it sums, never the market's default alone.
        windows.add(r.test.windowDays)
      }
    }
    if (r.waiting) asks.add(r.waiting.approvalId)
    if (r.state === 'KEPT_PAUSED') keptPaused++
    if (r.state === 'TURNED_ON_ELSEWHERE') turnedOn++
    if (r.skipped) skipped++
    if (isKeptSafe(r)) keptSafe++
    if (showMatches(r, show)) { if (r.kind === 'TERM') terms++; else keywords++ }
  }
  // Money is never added across currencies: several → the split, and a null total with its reason.
  const currencies = Object.keys(byCurrency).sort()
  const rowCurrencies = [...new Set(rows.map((r) => r.currency))]
  const several = currencies.length > 1
  return {
    wasting, wastingSpendCents: several ? null : (currencies.length ? byCurrency[currencies[0]] : 0),
    currency: currencies.length === 1 ? currencies[0] : currencies.length === 0 && rowCurrencies.length === 1 ? rowCurrencies[0] : null,
    wastingSpendByCurrency: byCurrency,
    wastingSpendNote: several ? `The wasting spend is in ${currencies.length} currencies (${currencies.join(', ')}): see it per currency; it is never added up.` : null,
    wastingWindows: [...windows].sort((a, b) => a - b),
    // The Clashes tile counts exactly the rows show=clashes answers (Bid audit M1).
    keywords, terms, waiting: asks.size, keptPaused, turnedOn, negated: extra.negated, clashes: rows.filter((r) => r.clash != null).length, skipped,
    // Step 4 — the Protected tile counts exactly the rows show=protected answers.
    protected: keptSafe,
  }
}

// ── Words for the Owner: Rome times, no raw ids, no tool names ───────────────────────────────────────────────────

const ROME = 'Europe/Rome'
const dayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: ROME, day: 'numeric', month: 'short', year: 'numeric' })
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: ROME, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
/** A day as the Owner reads it, in Rome: "4 Oct 2026". */
export const romeDay = (d: Date | number | string) => dayFmt.format(new Date(d))
/** A moment as the Owner reads it, in Rome: "4 Oct 2026 00:42". */
export const romeTime = (d: Date | number | string) => `${dayFmt.format(new Date(d))} ${timeFmt.format(new Date(d))}`

/** Tool and parameter names a writer may have stored in its words, and what the Owner calls them. */
const TOOL_WORDS: ReadonlyArray<[RegExp, string]> = [
  [/\benable-ads\b/g, 'Turn on'], [/\bpause-ads\b/g, 'Pause'], [/\barchive-ads\b/g, 'Archive'],
  [/\badd-negative-targets\b/g, 'Add negatives'], [/\bcreate-negative-keyword\b/g, 'Add a negative'], [/\bretire-negatives\b/g, 'Remove negatives'],
  [/\bundo-(?:ad-)?change\b/g, 'Undo'], [/\bsubmit-change-plan\b/g, 'a change plan'], [/\bapprove-?\w*\b(?=\s+tool)/g, 'approve'],
  [/\brelease(?:Kept|Keep)Paused\b/g, 'a release'], [/\bkeepPaused\b/g, 'keep paused'], [/\bkeepUntil\b/g, 'keep until'],
  [/\bincludePeoplesPauses\b/g, "a person's pause"],
]

/**
 * Words a writer stored (a refusal, a note), made fit for the Owner: a raw person id reads "a person", an automation's
 * id "an automation", a UTC time reads in Rome, and tool or parameter names read as the page's own words.
 */
export function plainWords(text: string | null | undefined): string | null {
  if (text == null) return null
  let t = String(text)
  t = t.replace(/\(?\buser:[A-Za-z0-9_-]+\)?/g, (m) => (m.startsWith('(') ? '' : 'a person'))
  t = t.replace(/\bautomation:[A-Za-z0-9:_-]+/g, 'an automation')
  t = t.replace(/\b(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?\s*(?:Z|UTC)\b/g, (_m, d: string, hm: string) => romeTime(`${d}T${hm}:00Z`))
  for (const [re, words] of TOOL_WORDS) t = t.replace(re, words)
  return t.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:])/g, '$1').trim()
}
