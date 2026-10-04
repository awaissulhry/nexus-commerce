/**
 * Publish history — the rules behind one run's detail (sheet publish parity, step 4; plan
 * docs/sheet-publish-parity/PLAN.md, item 4). Pure, so the drawer, the tests and the list read one rule.
 *
 * Words: a run's pill comes from the design system's publish vocabulary (`publishStatus.ts`). Product sheet runs
 * carry a publish status the vocabulary knows; the older sources (flat-file uploads, photo runs) carry their own raw
 * status ("DONE", "FATAL"), so they are labelled by the plain `state` the server derived — never by the raw word.
 */
import type { HistoryProduct, HistoryProductResult, HistoryRun, HistoryState } from '@nexus/shared/publication-history'
import type { StudioPublishChange } from '@nexus/shared/studio-publication'
import { channelLabel } from '@nexus/shared/channel-label'
import { publicationStatusMeta, publishResultMeta, publishFullTime, toCsv, type CsvColumn, type PublishStatusMeta } from '@/design-system/grid'
import { getBackendUrl } from '@/lib/backend-url'
import { studioRowId } from '@/app/products/[id]/edit/_studio/sheet/channel/types'

/** A state's pill for the sources whose raw status the vocabulary does not know. One existing entry per state. */
const STATE_STATUS: Record<HistoryState, string> = {
  in_progress: 'SUBMITTED',
  succeeded: 'ACCEPTED',
  partial: 'PARTIAL',
  failed: 'FAILED',
  needs_check: 'UNVERIFIED',
}

/** The run's pill. A run a person marked as checked still has no result: it stays "Result unknown". */
export function runStatusMeta(run: Pick<HistoryRun, 'source' | 'status' | 'state' | 'checkedAt'>): PublishStatusMeta {
  if (run.state === 'needs_check') return publicationStatusMeta('UNVERIFIED')
  if (run.source === 'studio') {
    const meta = publicationStatusMeta(run.status)
    // A status the vocabulary does not know must not show a raw word: fall back to the state.
    if (!meta.hint.startsWith('Unrecognised')) return meta
  }
  return publicationStatusMeta(STATE_STATUS[run.state])
}

/** "eBay IT", "Amazon DE", "Shopify" (a market-less store). */
export function runDestination(run: Pick<HistoryRun, 'channel' | 'marketplace'>): string {
  const market = run.marketplace && run.marketplace !== 'GLOBAL' ? ` ${run.marketplace}` : ''
  return `${channelLabel(run.channel)}${market}`
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** What the run is about, in the sentence: "products", or "photos" for a photo run. */
const subject = (run: Pick<HistoryRun, 'kind'>, n: number) => run.kind === 'photos' ? `photos of ${plural(n, 'product')}` : plural(n, 'product')

/**
 * The one plain sentence under the pill: what happened, with the counts that matter. Never claims more than the
 * counts say: accepted is not "live", and a run without an answer says so.
 */
export function runHeadline(run: HistoryRun, checkedByName: string | null = run.checkedBy): string {
  const where = runDestination(run)
  const c = run.counts
  const n = run.productCount
  const done = c.accepted + c.verified
  const notSent = c.notSent
  const failed = c.failed
  if (run.state === 'needs_check') {
    if (run.checkedAt) {
      const who = checkedByName ? ` by ${checkedByName}` : ''
      return `${where} never confirmed the result. Marked as checked${who} on ${publishFullTime(run.checkedAt)}.`
    }
    return `${where} has not confirmed the result. It may have arrived. Check the listing on ${channelLabel(run.channel)} before you publish again.`
  }
  if (run.state === 'in_progress') {
    return n > 0 ? `${where} is still working on ${subject(run, n)}. This updates by itself.` : `${where} is still working on this publish. This updates by itself.`
  }
  if (run.state === 'failed') {
    if (n > 0 && notSent === n) return `Nothing was sent to ${where}. A check failed before sending, so nothing changed on the channel.`
    if (n > 0 && failed + notSent === n) return `${where} refused all ${subject(run, n)}. Nothing was accepted.`
    return `${where} refused this publish.${run.message ? ` ${run.message}` : ''}`
  }
  if (run.state === 'partial') {
    const parts = [`${failed + notSent} of ${subject(run, n)} failed on ${where}.`]
    if (done > 0) parts.push(`${done} ${done === 1 ? 'was' : 'were'} accepted.`)
    if (c.skipped > 0) parts.push(`${c.skipped} ${c.skipped === 1 ? 'was' : 'were'} skipped.`)
    if (c.waiting + c.unknown > 0) parts.push(`${c.waiting + c.unknown} still ${c.waiting + c.unknown === 1 ? 'has' : 'have'} no answer.`)
    return parts.join(' ')
  }
  // succeeded
  if (n === 0) return `${where} accepted this publish.`
  const verb = c.verified === n ? 'verified' : 'accepted'
  const all = done === n ? `All ${subject(run, n)} were ${verb} on ${where}.` : `${done} of ${subject(run, n)} were ${verb} on ${where}.`
  return c.skipped > 0 ? `${all} ${c.skipped} ${c.skipped === 1 ? 'was' : 'were'} skipped.` : all
}

/** "Product sheet", "Old Amazon flat file", … — where the run was started. */
export const SOURCE_LABEL: Record<HistoryRun['source'], string> = {
  studio: 'Product sheet',
  'amazon-flat-file': 'Amazon flat file (old page)',
  'ebay-flat-file': 'eBay flat file (old page)',
  photos: 'Photos',
}

const KIND_LABEL: Record<HistoryRun['kind'], string> = {
  update: 'Update', create: 'New listing', photos: 'Photos', end: 'End listing', pause: 'Pause selling', resume: 'Resume selling', relist: 'Relist',
}

/** "Update · 3 fields", "New listing", "Photos". */
export function runChangeLabel(run: Pick<HistoryRun, 'kind' | 'fieldCount'>): string {
  const label = KIND_LABEL[run.kind]
  return run.kind === 'update' && run.fieldCount != null ? `${label} · ${plural(run.fieldCount, 'field')}` : label
}

// ── Actions ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RunActionContext {
  /** The viewer holds `products.publish`. */
  canPublish: boolean
  /** The surface can open a new review with the failed products ticked (the studio passes a handler). */
  canOpenReview: boolean
}

export interface RunActionVisibility {
  /** Ask the channel again now (read only). Product sheet runs that still wait for an answer. */
  checkNow: boolean
  /** D3: record that a person checked a run the channel never confirmed. */
  markChecked: boolean
  /** "Publish failed products again…" — opens a NEW review; never re-sends a stored request. */
  publishAgain: boolean
  /** The run has failed products, but this surface cannot open the review yet: say so instead of a dead button. */
  publishAgainUnavailable: boolean
  /** Download the per-product results as CSV. */
  download: boolean
  /** Copy the failed SKUs. */
  copyFailed: boolean
}

const failedCount = (run: Pick<HistoryRun, 'counts'>) => run.counts.failed + run.counts.notSent

/**
 * Which actions a run offers. Only product sheet runs can be checked again or marked: the older sources have no
 * route that reads the channel again. Every action that writes or reads the channel needs `products.publish`.
 */
export function runActionVisibility(run: HistoryRun, ctx: RunActionContext, products: readonly HistoryProduct[] = []): RunActionVisibility {
  const studio = run.source === 'studio'
  const waiting = run.state === 'in_progress' || run.state === 'needs_check'
  const hasFailed = failedCount(run) > 0 || products.some(p => p.result === 'FAILED' || p.result === 'NOT_SENT')
  const settled = run.state === 'succeeded' || run.state === 'partial' || run.state === 'failed'
  const againPossible = studio && settled && hasFailed && ctx.canPublish
  return {
    checkNow: studio && waiting && !run.checkedAt && ctx.canPublish,
    markChecked: studio && run.state === 'needs_check' && !run.checkedAt && ctx.canPublish,
    publishAgain: againPossible && ctx.canOpenReview,
    publishAgainUnavailable: againPossible && !ctx.canOpenReview,
    download: products.length > 0,
    copyFailed: products.some(p => p.result === 'FAILED' || p.result === 'NOT_SENT'),
  }
}

// ── Products ─────────────────────────────────────────────────────────────────────────────────────────────────────

const RESULT_ORDER: Record<HistoryProductResult, number> = { FAILED: 0, NOT_SENT: 1, UNKNOWN: 2, WAITING: 3, ACCEPTED: 4, VERIFIED: 4, SKIPPED: 5 }

/** Failed first, then not sent, unknown, waiting, then the rest; each group by SKU. The server orders the same way. */
export function orderProducts(products: readonly HistoryProduct[]): HistoryProduct[] {
  return [...products].sort((a, b) => (RESULT_ORDER[a.result] - RESULT_ORDER[b.result]) || a.sku.localeCompare(b.sku))
}

/**
 * The products as the drawer shows them. A run that needs a check (the sweep gave up, or a person marked it) will
 * hear nothing more: its products' "Waiting" would promise an answer that is not coming, so they read "Result unknown".
 */
export function productsAsShown(run: Pick<HistoryRun, 'state'>, products: readonly HistoryProduct[]): HistoryProduct[] {
  if (run.state !== 'needs_check') return [...products]
  return products.map(p => (p.result === 'WAITING' ? { ...p, result: 'UNKNOWN' } : p))
}

export type ProductFilter = 'all' | 'failed' | 'accepted' | 'waiting'

const FILTER_RESULTS: Record<Exclude<ProductFilter, 'all'>, ReadonlySet<HistoryProductResult>> = {
  failed: new Set(['FAILED', 'NOT_SENT']),
  accepted: new Set(['ACCEPTED', 'VERIFIED']),
  waiting: new Set(['WAITING', 'UNKNOWN']),
}

export function filterProducts(products: readonly HistoryProduct[], filter: ProductFilter): HistoryProduct[] {
  return filter === 'all' ? [...products] : products.filter(p => FILTER_RESULTS[filter].has(p.result))
}

export function productFilterCounts(products: readonly HistoryProduct[]): Record<ProductFilter, number> {
  return {
    all: products.length,
    failed: filterProducts(products, 'failed').length,
    accepted: filterProducts(products, 'accepted').length,
    waiting: filterProducts(products, 'waiting').length,
  }
}

export function failedSkus(products: readonly HistoryProduct[]): string[] {
  return orderProducts(products).filter(p => p.result === 'FAILED' || p.result === 'NOT_SENT').map(p => p.sku)
}

/** The fields the publish carried for a product, in words. `$create` = a complete new listing. */
export function sentFieldsText(product: Pick<HistoryProduct, 'sentFields'>): string {
  if (product.sentFields.includes('$create')) return 'Complete new listing'
  return product.sentFields.length ? product.sentFields.join(', ') : 'Not recorded'
}

/** The CSV the drawer downloads: one row per product, the words a person reads, nothing raw. */
export function resultsCsvColumns(run: HistoryRun): CsvColumn<HistoryProduct>[] {
  return [
    { header: 'SKU', value: p => p.sku },
    { header: 'Variation', value: p => p.variationLabel ?? '' },
    { header: 'Result', value: p => publishResultMeta(p.result).label },
    { header: 'Channel message', value: p => p.message ?? '' },
    { header: 'Field', value: p => p.fieldLabel ?? '' },
    { header: 'Fields sent', value: p => sentFieldsText(p) },
    { header: 'Listing on channel', value: p => p.externalId ?? '' },
    { header: 'Destination', value: () => runDestination(run) },
    { header: 'Started', value: () => run.startedAt },
  ]
}

export function resultsCsv(run: HistoryRun, products: readonly HistoryProduct[]): string {
  return toCsv(orderProducts(products), resultsCsvColumns(run))
}

/** `publish-ebay-it-2026-10-02.csv`. */
export function resultsFileName(run: Pick<HistoryRun, 'channel' | 'marketplace' | 'startedAt'>): string {
  const day = run.startedAt.slice(0, 10)
  const where = [run.channel, run.marketplace].filter(Boolean).join('-').toLowerCase()
  return `publish-${where}-${day}.csv`
}

/**
 * The studio sheet's row id for a product of this run, or null when it cannot be known. Rows are `studioRowId(alias,
 * product)`: the primary listing (`aliasKey ''`) is `primary:<productId>`, an extra listing uses its own key. A source
 * that never recorded its listing (`aliasKey` null: the old flat-file pages, photo runs) lands on the sheet without a
 * row rather than on a guessed one.
 */
export function sheetRowIdOf(run: Pick<HistoryRun, 'aliasKey'>, product: Pick<HistoryProduct, 'productId'>): string | null {
  if (!product.productId || run.aliasKey == null) return null
  return studioRowId(run.aliasKey === '' ? null : run.aliasKey, product.productId)
}

/** "Primary listing", the extra listing's name, or nothing when the source never recorded which listing it was. */
export function runListingLabel(run: Pick<HistoryRun, 'aliasKey' | 'aliasLabel'>): string | null {
  if (run.aliasLabel) return run.aliasLabel
  return run.aliasKey === '' ? 'Primary listing' : null
}

// ── What was sent ────────────────────────────────────────────────────────────────────────────────────────────────

/** The read-only status word of a sent change, the same words the Publish dialog uses. */
export function changeStatusText(change: Pick<StudioPublishChange, 'status'>): string {
  return change.status === 'SAME' ? 'No send needed' : change.status === 'CANNOT_COMPARE' ? 'Cannot compare' : change.status === 'DIFFERS' ? 'Differs on channel' : 'Changed in Nexus'
}

// ── The deep link ────────────────────────────────────────────────────────────────────────────────────────────────

export interface HistoryDeepLink {
  /** `publishes` | `all` when the URL names a view; null = the tab's default. */
  view: 'publishes' | 'all' | null
  run: string | null
  sku: string | null
}

/** `?tab=activity&view=publishes&run=<id>[&sku=<sku>]`. A run or a SKU implies the Publishes view. */
export function parseHistoryDeepLink(search: URLSearchParams | string): HistoryDeepLink {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  const clean = (value: string | null) => (value && value.trim() ? value.trim() : null)
  const run = clean(params.get('run'))
  const sku = run ? clean(params.get('sku')) : null
  const raw = clean(params.get('view'))
  const view = raw === 'publishes' || raw === 'all' ? raw : run ? 'publishes' : null
  return { view, run, sku }
}

/** The query keys of the deep link, for writing it: `undefined` removes a key. */
export function historyDeepLinkPatch(link: Partial<HistoryDeepLink>): Record<string, string | undefined> {
  return { view: link.view ?? undefined, run: link.run ?? undefined, sku: link.run && link.sku ? link.sku : undefined }
}

// ── The server ───────────────────────────────────────────────────────────────────────────────────────────────────

export class HistoryRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

/** One JSON request to the API (the app's fetch adds the session, the business and the CSRF token). */
export async function historyRequest<T>(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal }): Promise<T> {
  const method = init?.method ?? 'GET'
  const response = await fetch(`${getBackendUrl()}${path}`, {
    method, credentials: 'include', cache: 'no-store', signal: init?.signal,
    ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init?.body ?? {}) } : {}),
  })
  const data = await response.json().catch(() => null) as { message?: string; error?: string } | null
  if (!response.ok) {
    const words = typeof data?.message === 'string' && data.message ? data.message : typeof data?.error === 'string' && !/^[A-Z_]+$/.test(data.error) ? data.error : null
    throw new HistoryRequestError(words ?? `The request failed (${response.status}).`, response.status)
  }
  if (data == null) throw new HistoryRequestError('The server answered with nothing.', response.status)
  return data as T
}
