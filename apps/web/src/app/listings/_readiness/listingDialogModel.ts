/**
 * The Listing window's words, links and decisions (step 5 of docs/listings/LISTINGS-LIVE-LAYER-PLAN-2026-10-25.md; it
 * replaced the Fix window of the readiness rebuild, docs/listings/READINESS-REBUILD-2026-10-23.md §2). Pure, so the node
 * tests reach them; `ListingDialog.tsx` and `ListingDialogTabs.tsx` only draw what these say. Not `listingDialog.ts`,
 * which macOS (case-insensitive) would take for `ListingDialog.tsx` and TypeScript then drop from the program.
 *
 * Readiness labels and tones come from `readinessMeta(state, 'scope')`; the channel's selling words from the DS
 * (`SELLING_STATE_WORD`, Owner 2026-10-04); a publish's words from `publicationStatusMeta`. Nothing here decides a state —
 * it only says what the API answered.
 */
import type {
  ReadinessChannelListing,
  ReadinessChannelSection,
  ReadinessChip,
  ReadinessDestination,
  ReadinessDetail,
  ReadinessLive,
  ReadinessLiveSummary,
  ReadinessProblemKind,
  ReadinessPublishOutcome,
  ReadinessScopeState,
  ReadinessStateCounts,
  ReadinessSyncAttempt,
} from '@nexus/shared/listing-readiness'
import { readinessMeta, SCOPE_READINESS_STATES, type ReadinessTone } from '@/design-system/grid/renderers/readiness'
import { publicationStatusMeta, publishFullTime, publishResultMeta } from '@/design-system/grid/renderers/publishStatus'
import { SELLING_STATE_WORD } from '@/design-system/grid/renderers/sellingStatus'
import type { Tone } from '@/design-system/primitives/tone'
import { browserWorkspaceId, workspaceHref } from '@/lib/workspaces/paths'
import { liveMark, liveTotals, problemParts, stateParts as liveStateParts } from './liveMarks'
import { channelLabel, worstChip } from './marketChips'
import { relativeTime } from './relativeTime'
import type { ReadinessDataRow } from './readinessRows'

/* ── Readiness (the Fix window's words, kept) ────────────────────────────────────────────────────────────────────── */

/** Why a problem is a problem, as the tag on it says. */
export const PROBLEM_KIND_LABELS: Record<ReadinessProblemKind, string> = {
  required: 'Required',
  translation: 'Translation',
  setup: 'Setup',
  rule: 'Rule',
  check: 'Check',
}

/** An unknown kind is named as it came, never dressed up as one of ours. */
export function problemKindLabel(kind: ReadinessProblemKind): string {
  return PROBLEM_KIND_LABELS[kind] ?? String(kind)
}

const count = (n: number) => n.toLocaleString('en')

/** "1 product" / "20 products": the window shows ONE destination, where a listing is a product. */
export function listingWords(n: number): string {
  return `${count(n)} ${n === 1 ? 'product' : 'products'}`
}

/** "and 30 more" when the API sent fewer listings than the problem touches; null when it sent them all. */
export function moreWords(shown: number, total: number): string | null {
  const more = total - shown
  return more > 0 ? `and ${count(more)} more` : null
}

/** "Required by Amazon category JACKET, eBay item specifics"; null when nobody is named. */
export function requiredByWords(requiredBy: readonly string[]): string | null {
  const names = requiredBy.map((name) => name.trim()).filter(Boolean)
  return names.length ? `Required by ${names.join(', ')}` : null
}

/** A bare studio path, inside the current business (`/w/<id>/…`), like `issueHref.ts`. */
export function inBusiness(href: string, workspaceId: string | null = browserWorkspaceId()): string {
  return workspaceHref(workspaceId, href)
}

/** Paging is the page's, not a filter: the window asks for one product on one destination. */
/** Not filters: paging, and the page's order (step 4) — the window never orders, and a live sort is the page's own. */
const NOT_FILTERS = new Set(['page', 'pageSize', 'sort', 'dir'])

/**
 * `catalog-transfer/readiness/detail?…` for `transferApi`: the page's filters, then the product, family and destination.
 * The window's own three keys win over a filter of the same name.
 */
export function detailPath(query: Record<string, string>, target: { productId: string; family: boolean; destinationKey: string }): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) if (!NOT_FILTERS.has(key) && value !== '') params.set(key, value)
  params.set('productId', target.productId)
  params.set('family', target.family ? '1' : '0')
  params.set('destination', target.destinationKey)
  return `catalog-transfer/readiness/detail?${params}`
}

export interface StatePart { state: ReadinessScopeState; count: number; label: string; tone: ReadinessTone; text: string }

/** Listings by state, worst first, only the states that have any: "3 blocked", "17 ready" (the DS words, lower case). */
export function stateParts(counts: ReadinessStateCounts): StatePart[] {
  return SCOPE_READINESS_STATES
    .filter((state) => (counts[state] ?? 0) > 0)
    .map((state) => {
      const meta = readinessMeta(state, 'scope')
      return { state, count: counts[state], label: meta.label, tone: meta.tone, text: `${count(counts[state])} ${meta.label.toLowerCase()}` }
    })
}

/** The summary's line for one destination: "21 products, all blocked", or "21 products: 18 blocked · 3 ready". */
export function stateLine(counts: ReadinessStateCounts): string {
  const parts = stateParts(counts)
  const total = listingTotal(counts)
  const products = `${count(total)} ${total === 1 ? 'product' : 'products'}`
  if (parts.length === 1) return total === 1 ? `${products}, ${parts[0].label.toLowerCase()}` : `${products}, all ${parts[0].label.toLowerCase()}`
  return `${products}: ${parts.map((part) => part.text).join(' · ')}`
}

/** Listings in the counts. */
export function listingTotal(counts: ReadinessStateCounts): number {
  return SCOPE_READINESS_STATES.reduce((sum, state) => sum + (counts[state] ?? 0), 0)
}

/** "GALE-JACKET · Amazon DE". */
export function windowTitle(name: string, destinationLabel: string): string {
  return `${name} · ${destinationLabel}`
}

/**
 * The product's name for the title: the caller's, else the product itself among the listings the problems name, else
 * its own listing's SKU on the channel, else plain words. Never another product's name.
 */
export function productTitle(
  productName: string | null | undefined,
  detail: (Pick<ReadinessDetail, 'productId' | 'problems'> & { channel?: Pick<ReadinessChannelSection, 'listings'> | null }) | null,
  family: boolean,
): string {
  if (productName?.trim()) return productName.trim()
  for (const problem of detail?.problems ?? []) {
    const self = problem.products.find((product) => product.id === detail?.productId)
    if (self) return self.name?.trim() || self.sku
  }
  const own = detail?.channel?.listings.find((listing) => listing.productId === detail.productId)
  if (own?.sku) return own.sku
  return family ? 'This family' : 'This product'
}

/**
 * What the Readiness tab says when there is nothing in the list. "Nothing to fix" only when the check says Ready; a
 * state that was never measured, or one that is not set up, says so; a Blocked or Warnings state without problem
 * details says that the details did not come, rather than "nothing to fix" under a red pill.
 */
export function emptyWords(state: ReadinessScopeState, destinationLabel: string): { title: string; description: string | null } {
  const meta = readinessMeta(state, 'scope')
  if (state === 'ready') return { title: `Nothing to fix on ${destinationLabel}`, description: null }
  if (state === 'notComputed' || state === 'absent') return { title: `${meta.label} on ${destinationLabel}`, description: `${meta.hint}.` }
  return { title: `${meta.label} on ${destinationLabel}`, description: 'The check named no fields here. Open the studio to see its checks.' }
}

/* ── Tabs ────────────────────────────────────────────────────────────────────────────────────────────────────────── */

export type ListingTab = 'readiness' | 'channel' | 'price' | 'history'
export const LISTING_TABS: readonly ListingTab[] = ['readiness', 'channel', 'price', 'history']

/**
 * The tabs the window shows. Without what the channel says (`channel` absent from an older API, null on Shared and
 * for a person without `listings.view`) the window is the Fix window it replaced: Readiness only.
 */
export function windowTabs(detail: { channel?: ReadinessChannelSection | null } | null | undefined): ListingTab[] {
  return detail?.channel ? [...LISTING_TABS] : ['readiness']
}

/** The tab on show: the one asked for when the window has it, else Readiness. */
export function shownTab(asked: ListingTab | null | undefined, tabs: readonly ListingTab[]): ListingTab {
  return asked && tabs.includes(asked) ? asked : 'readiness'
}

/** A ▲ chip (a problem on the channel) opens On the channel; every other chip opens Readiness. */
export function tabForChip(chip: Pick<ReadinessChip, 'live'> | null | undefined): ListingTab {
  return liveMark(chip?.live) === 'problem' ? 'channel' : 'readiness'
}

/** "Readiness", "On Amazon", "Price & stock", "History". */
export function tabLabel(tab: ListingTab, channel: string): string {
  switch (tab) {
    case 'readiness': return 'Readiness'
    case 'channel': return `On ${channelLabel(channel)}`
    case 'price': return 'Price & stock'
    case 'history': return 'History'
  }
}

/** The tab's number: Readiness its problems; On the channel its open messages and suppressions; the others none. */
export function tabCount(tab: ListingTab, detail: Pick<ReadinessDetail, 'problems'> & { channel?: ReadinessChannelSection | null }): number | null {
  if (tab === 'readiness') return detail.problems.length || null
  if (tab !== 'channel' || !detail.channel) return null
  const n = detail.channel.listings.reduce((sum, listing) => sum + listing.messages.length + listing.suppressions.length, 0)
  return n || null
}

/* ── Prev / Next over the grid's rows in view ───────────────────────────────────────────────────────────────────── */

/** One row of the grid as shown now: its AG row id and its data. */
export interface ViewRow { id: string; data: ReadinessDataRow }

/** The rows the window can walk: rows in view with at least one chip, in the grid's order, once each. */
export function navIds(rows: readonly ViewRow[]): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const row of rows) {
    if (row.data.chips.length === 0 || seen.has(row.id)) continue
    seen.add(row.id)
    ids.push(row.id)
  }
  return ids
}

/** Where Open (and Prev / Next) opens a row: the next step's destination, else a ▲ chip, else the chip needing attention first. */
export function openDestination(row: Pick<ReadinessDataRow, 'nextStep' | 'chips'>): string | null {
  return row.nextStep?.destinationKey
    ?? row.chips.find((chip) => liveMark(chip.live) === 'problem')?.destinationKey
    ?? worstChip(row.chips)?.destinationKey
    ?? null
}

/** Why Open is held on a row, or null when it opens. */
export function openHeldReason(row: Pick<ReadinessDataRow, 'chips'>): string | null {
  return row.chips.length === 0 ? 'Nothing to open: this product has no listing here.' : null
}

/**
 * Prev / Next moved to another row: the same destination when that row has it (the person reads "Amazon DE" row after
 * row), else where Open would open it. Null when the row has no chip at all.
 */
export function destinationForRow(row: Pick<ReadinessDataRow, 'nextStep' | 'chips'>, keep: string | null | undefined): string | null {
  if (keep && row.chips.some((chip) => chip.destinationKey === keep)) return keep
  return openDestination(row)
}

/* ── The header ─────────────────────────────────────────────────────────────────────────────────────────────────── */

/** "Synced with Amazon 1 h ago" (the oldest sync of the listings here); "Not synced with Amazon yet" when none was. */
export function syncedWords(lastSyncedAt: string | null | undefined, channel: string, now: number = Date.now()): string {
  const word = channelLabel(channel)
  return lastSyncedAt ? `Synced with ${word} ${relativeTime(lastSyncedAt, now)}` : `Not synced with ${word} yet`
}

/** The live state of the destination in the DS words: "Mixed (18 Active · 2 Not listed)", "20 Active", "Active". */
export function statusSentence(summary: ReadinessLiveSummary): string {
  const totals = liveTotals([summary])
  const parts = totals ? liveStateParts(totals) : []
  const word = SELLING_STATE_WORD[summary.state] ?? summary.state
  if (summary.state === 'mixed') return parts.length ? `${word} (${parts.join(' · ')})` : word
  return summary.listed + summary.notListed > 1 && parts.length ? parts.join(' · ') : word
}

/** The problems on the channel: "1 Suppressed · 1 Push failed"; null when there are none. */
export function problemSentence(summary: ReadinessLiveSummary): string | null {
  const totals = liveTotals([summary])
  const parts = totals ? problemParts(totals) : []
  return parts.length ? parts.join(' · ') : null
}

/** What the channel calls its id: "ASIN" ("Parent ASIN" for a family), "Item ID", "Product ID", "Listing ID". */
export function channelIdLabel(channel: string, family: boolean): string {
  switch (channel.toUpperCase()) {
    case 'AMAZON': return family ? 'Parent ASIN' : 'ASIN'
    case 'EBAY': return 'Item ID'
    case 'SHOPIFY': return 'Product ID'
    case 'ETSY': return 'Listing ID'
    default: return 'Channel ID'
  }
}

/* ── Pushes and reads ───────────────────────────────────────────────────────────────────────────────────────────── */

export interface OutcomeMeta { label: string; tone: Tone }

/**
 * What became of a push, in the window's words. A push attempt's own outcomes (`ChannelPublishAttempt.outcome`) first:
 * `success` means the channel took it (Accepted — never "live"); `gated`, `rate-limited` and `circuit-open` never left
 * Nexus. Anything else is a publish status (`publicationStatusMeta`), shown as itself when unknown.
 */
export function pushOutcomeMeta(outcome: string | null | undefined): OutcomeMeta {
  switch ((outcome ?? '').trim().toLowerCase()) {
    case 'success': return { label: 'Accepted', tone: 'info' }
    case 'failed': return { label: 'Failed', tone: 'danger' }
    case 'gated': return { label: 'Not sent: publishing is off', tone: 'neutral' }
    case 'rate-limited': return { label: 'Not sent: rate limit', tone: 'warning' }
    case 'circuit-open': return { label: 'Not sent: the channel is paused', tone: 'warning' }
    case 'timeout': return { label: 'No answer in time', tone: 'warning' }
  }
  const meta = publicationStatusMeta(outcome)
  return { label: meta.label, tone: meta.tone }
}

/** The newest push among the listings, with its SKU; null when Nexus never pushed here. */
export function lastPushOf(listings: readonly ReadinessChannelListing[]): (NonNullable<ReadinessChannelListing['lastPublish']> & { sku: string }) | null {
  let newest: (NonNullable<ReadinessChannelListing['lastPublish']> & { sku: string }) | null = null
  for (const listing of listings) {
    const push = listing.lastPublish
    if (!push) continue
    if (!newest || Date.parse(push.at) > Date.parse(newest.at)) newest = { ...push, sku: listing.sku }
  }
  return newest
}

/**
 * A listing's own result in its last publish (`ReadinessChannelListing.lastPublish.outcome`, step 3): the DS words for
 * one product in a publish — SUBMITTED reads Waiting (the channel has not answered), ACCEPTED is never "live", UNKNOWN
 * says so.
 */
export function publishOutcomeMeta(outcome: ReadinessPublishOutcome | string | null | undefined): OutcomeMeta {
  const meta = publishResultMeta(outcome)
  return { label: meta.label, tone: meta.tone }
}

/** "Failed 25 Oct, 10:42": the last publish of a listing. */
export function pushWords(push: { at: string; outcome: ReadinessPublishOutcome | string }, now: number = Date.now()): string {
  return `${publishOutcomeMeta(push.outcome).label} ${publishFullTime(push.at, now)}`
}

/** A sync attempt (`SyncAttempt`, a read from the channel) in words. */
export function readOutcomeMeta(status: string | null | undefined): OutcomeMeta {
  switch ((status ?? '').trim().toUpperCase()) {
    case 'SUCCESS': return { label: 'Read', tone: 'success' }
    case 'IN_PROGRESS': return { label: 'Reading', tone: 'info' }
    case 'FAILED': return { label: 'Failed', tone: 'danger' }
    case 'TIMEOUT': return { label: 'No answer in time', tone: 'warning' }
    case 'NOT_IMPLEMENTED': return { label: 'Not read: not supported on this channel', tone: 'neutral' }
    default: return { label: (status ?? '').trim() || '—', tone: 'neutral' }
  }
}

export interface SyncAttemptRow { id: string; attemptedAt: string; status: string; source: string | null; durationMs: number | null; error: string | null }

/** The reads the window's data already carries (`ReadinessChannelListing.syncAttempts`, the newest 10), as History rows. */
export function syncAttemptRows(listingId: string, attempts: readonly ReadinessSyncAttempt[]): SyncAttemptRow[] {
  return attempts.map((a, i) => ({ id: `${listingId}:${i}`, attemptedAt: a.at, status: a.status, source: a.source, durationMs: a.durationMs, error: a.error }))
}
export interface PublishAttemptRow { id: string; attemptedAt: string; mode: string; outcome: string; errorMessage: string | null; errorCode: string | null }

export interface HistoryRow { id: string; at: string; what: string; result: OutcomeMeta; message: string | null }

const MODE_WORDS: Record<string, string> = { 'dry-run': 'dry run', sandbox: 'sandbox', gated: 'publishing off' }

/** One listing's pushes (`publish-attempts`) and reads (`sync-history`), newest first. */
export function historyRows(reads: readonly SyncAttemptRow[], pushes: readonly PublishAttemptRow[], channel: string): HistoryRow[] {
  const word = channelLabel(channel)
  const rows: HistoryRow[] = [
    ...pushes.map((push) => {
      const mode = MODE_WORDS[push.mode] ?? null
      return {
        id: `push:${push.id}`,
        at: push.attemptedAt,
        what: `Push to ${word}${mode ? ` (${mode})` : ''}`,
        result: pushOutcomeMeta(push.outcome),
        message: [push.errorCode, push.errorMessage].filter((part) => part && part.trim()).join(' ') || null,
      }
    }),
    ...reads.map((read) => ({
      id: `read:${read.id}`,
      at: read.attemptedAt,
      what: `Read from ${word}${read.source && read.source !== 'manual' ? ` (${read.source})` : ''}`,
      result: readOutcomeMeta(read.status),
      message: read.error?.trim() || null,
    })),
  ]
  return rows.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0) || a.id.localeCompare(b.id))
}

/* ── Price & stock ──────────────────────────────────────────────────────────────────────────────────────────────── */

/** Marketplaces that share one Amazon EU merchant quantity per SKU (the API's `AMAZON_EU_SHARED_MARKETS`). */
export const AMAZON_EU_SHARED_MARKETS: readonly string[] = ['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'PL', 'SE', 'IE']

/** Why the quantity reads as it does, or null. FBA first: Amazon's number, never Nexus's to change. */
export function quantityNote(channel: string, marketplace: string, fulfillment: ReadinessLive['fulfillment']): string | null {
  if (channel.toUpperCase() !== 'AMAZON') return null
  if (fulfillment === 'FBA') return 'Amazon manages this quantity (FBA). Nexus never changes it.'
  if (AMAZON_EU_SHARED_MARKETS.includes(marketplace.toUpperCase())) {
    return `Amazon EU keeps one quantity per SKU for ${AMAZON_EU_SHARED_MARKETS.join(' ')}: it is the same number on each of them.`
  }
  return null
}

/** The channels that never report a value back: what the window shows there is what Nexus last sent. */
export function sentOnlyNote(channel: string, field: 'price' | 'quantity'): string | null {
  const ch = channel.toUpperCase()
  if (field === 'price' && (ch === 'EBAY' || ch === 'ETSY')) return `As sent by Nexus: ${channelLabel(channel)} does not report its price back.`
  if (field === 'quantity' && ch === 'ETSY') return 'As sent by Nexus: Etsy does not report its quantity back.'
  return null
}

/** "49.90 EUR", "49.90" without a currency, "—" without a price. */
export function moneyWords(value: number | null | undefined, currency: string | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const amount = value.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return currency ? `${amount} ${currency}` : amount
}

/** A listing's price with its sale: "49.90 EUR (sale 39.90 EUR)". */
export function priceWords(live: Pick<ReadinessLive, 'price' | 'salePrice' | 'currency'>): string {
  const base = moneyWords(live.price, live.currency)
  return live.salePrice != null && Number.isFinite(live.salePrice) ? `${base} (sale ${moneyWords(live.salePrice, live.currency)})` : base
}

/** "Pin price…": what the person typed, as a price, or the sentence that says why not. */
export function parsePinPrice(text: string): { ok: true; value: number } | { ok: false; reason: string } {
  const cleaned = text.trim().replace(/\s/g, '').replace(',', '.')
  if (!cleaned) return { ok: false, reason: 'Type a price.' }
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return { ok: false, reason: 'Type a price like 49.90 (two decimals at most).' }
  const value = Number(cleaned)
  // The price door refuses 0 too.
  if (!(value > 0)) return { ok: false, reason: 'The price must be above 0.' }
  return { ok: true, value }
}

/** The PATCH body of "Pin price…": a typed price is a pin through the price door (`expectedVersion` is added by the save line). */
export function pinPriceBody(value: number): { priceOverride: number } {
  return { priceOverride: value }
}

/** The PATCH body of "Follow master": the listing follows the master price by its rule again (the same as `priceOverride: null`). */
export function followMasterBody(): { followMasterPrice: true } {
  return { followMasterPrice: true }
}

/**
 * The two price edits the window offers: Pin always; Follow master only when the listing does not follow it now. Before
 * the listing's own read lands, what the window's data says (`ReadinessLive.followsMasterPrice`, step 4) decides; the
 * read wins once it is there.
 */
export function priceActions(listing: { followMasterPrice?: boolean | null } | null | undefined, live?: Pick<ReadinessLive, 'followsMasterPrice'> | null): { pin: boolean; follow: boolean } {
  const follows = listing ? listing.followMasterPrice : live?.followsMasterPrice
  if (follows === undefined || follows === null) return { pin: false, follow: false }
  return { pin: true, follow: follows === false }
}

/** How the listing's price is decided, in words. */
export function pricingWords(listing: { followMasterPrice?: boolean | null; pricingRule?: string | null }, ruleLabel: string): string {
  return listing.followMasterPrice === false ? 'Pinned: its own price, not the master' : `Follows the master price (${ruleLabel})`
}

/* ── Which listing the per-listing tabs show ────────────────────────────────────────────────────────────────────── */

const hasLiveProblem = (live: ReadinessLive) => live.suppressed || live.channelErrorCount > 0 || live.outOfSync.length > 0 || (live.syncStatus ?? '').toUpperCase() === 'FAILED'

/** The listing Price & stock and History open on: the one asked for, else the first with a problem, else the first. */
export function initialFocus(listings: readonly Pick<ReadinessChannelListing, 'live'>[], asked?: string | null): string | null {
  if (asked && listings.some((listing) => listing.live.listingId === asked)) return asked
  return (listings.find((listing) => hasLiveProblem(listing.live)) ?? listings[0])?.live.listingId ?? null
}

/* ── The footer's links ─────────────────────────────────────────────────────────────────────────────────────────── */

/** The API calls log, for one listing (`/sync-logs/api-calls` reads `listingId` and `since`). */
export function syncActivityHref(listingId: string): string {
  return `/sync-logs/api-calls?${new URLSearchParams({ listingId, since: '30d' })}`
}

/**
 * Sales on this destination (`/insights/products` reads `channels` and `markets`; it has no product filter, so it lists
 * every product there). Null where Insights has no such channel (Shared, Etsy).
 */
export function salesHref(destination: Pick<ReadinessDestination, 'channel' | 'marketplace'>): string | null {
  const channel = destination.channel.toUpperCase()
  if (!['AMAZON', 'EBAY', 'SHOPIFY'].includes(channel)) return null
  const params = new URLSearchParams({ channels: channel })
  const market = destination.marketplace.toUpperCase()
  if (market && market !== 'GLOBAL') params.set('markets', market)
  return `/insights/products?${params}`
}

/** The studio's Matrix on this destination: buffer, quantity, fulfilment and rules are written there (with Undo). */
export function matrixHref(productId: string, destination: Pick<ReadinessDestination, 'channel' | 'marketplace' | 'accountId' | 'aliasKey'>): string {
  const params = new URLSearchParams({ tab: 'matrix' })
  if (destination.channel && destination.channel !== 'SHARED') {
    params.set('scope', destination.channel)
    if (destination.marketplace) params.set('market', destination.marketplace)
    if (destination.accountId) params.set('account', destination.accountId)
    if (destination.aliasKey) params.set('alias', destination.aliasKey)
  }
  return `/products/${encodeURIComponent(productId)}/edit/studio?${params}`
}

/**
 * The Publish window's starting destination, as its option key (`publicationScopeKey`: channel, market, account, alias
 * id or null). Null on Shared: there is nothing to publish to.
 */
export function publishStartKey(destination: Pick<ReadinessDestination, 'channel' | 'marketplace' | 'accountId' | 'aliasKey'>): string | null {
  if (!destination.channel || destination.channel === 'SHARED') return null
  return JSON.stringify([destination.channel, destination.marketplace, destination.accountId, destination.aliasKey || null])
}

/* ── Writes ─────────────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The API's own refusal when a write answers 403 ("Access denied (listings.edit)"), so the button that sent it is held
 * with it; null for any other answer.
 */
export function refusalText(status: number, json: unknown): string | null {
  if (status !== 403) return null
  const body = (json && typeof json === 'object' ? json : {}) as { error?: unknown; required?: unknown }
  const error = typeof body.error === 'string' && body.error.trim() ? body.error.trim() : 'Access denied'
  return typeof body.required === 'string' && body.required ? `${error} (${body.required})` : error
}

/** An answer's error sentence. */
export function errorText(status: number, json: unknown): string {
  const body = (json && typeof json === 'object' ? json : {}) as { error?: unknown; detail?: unknown }
  if (typeof body.error === 'string' && body.error.trim()) return body.error.trim()
  if (typeof body.detail === 'string' && body.detail.trim()) return body.detail.trim()
  return `Request failed (${status})`
}

/** The confirm before "Diagnose with AI…" (it costs money, one listing at a time). */
export function diagnoseConfirm(sku: string, place: string) {
  return {
    level: 'confirm' as const,
    title: `Diagnose ${sku} on ${place} with AI?`,
    confirmLabel: 'Diagnose (costs money)',
    consequences: [
      'Nexus sends this listing’s suppression and its details to the AI provider and shows the answer here.',
      'Each diagnosis costs money; it is logged under AI usage.',
      'Nothing changes on the channel or in Nexus.',
    ],
  }
}

/** The confirm before "Mark resolved in Nexus". */
export function resolveConfirm(sku: string, place: string, channel: string) {
  return {
    level: 'confirm' as const,
    title: `Mark the suppression of ${sku} on ${place} resolved in Nexus?`,
    confirmLabel: 'Mark resolved',
    consequences: [
      `${channelLabel(channel)} is not told: this changes Nexus only.`,
      'Nexus closes its record of this suppression and shows the listing as Active until the channel reports it again.',
    ],
  }
}

/** The confirm before "Follow master". */
export function followConfirm(sku: string, place: string) {
  return {
    level: 'confirm' as const,
    title: `Follow the master price on ${sku} · ${place}?`,
    confirmLabel: 'Follow master',
    consequences: [
      'The listing’s own price is dropped; its price is worked out from the master price by its rule again.',
      'Nexus sends the new price to the channel in about 30 seconds.',
    ],
  }
}
