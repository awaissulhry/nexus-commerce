/**
 * Publish history — the rules behind one run's detail (sheet publish parity, step 4; plan
 * docs/sheet-publish-parity/PLAN.md, item 4). Pure, so the drawer, the tests and the list read one rule.
 *
 * Words: a run's pill comes from the design system's publish vocabulary (`publishStatus.ts`). Product sheet runs
 * carry a publish status the vocabulary knows; the older sources (flat-file uploads, photo runs) carry their own raw
 * status ("DONE", "FATAL"), so they are labelled by the plain `state` the server derived — never by the raw word.
 */
import type { HistoryKind, HistoryProduct, HistoryProductResult, HistoryRun, HistoryRunDetail, HistoryState } from '@nexus/shared/publication-history'
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
  'listing-action': 'Selling change',
}

export const KIND_LABEL: Readonly<Record<HistoryKind, string>> = {
  update: 'Update', create: 'New listing', photos: 'Photos', end: 'End listing', pause: 'Pause offer', resume: 'Resume offer', relist: 'Relist',
  full_update: 'Full update', delete: 'Delete listing',
}

/** "a", "a and b", "a, b and c". */
export function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? ''
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

/**
 * "Update · 3 fields", "New listing", "Photos". One Publish of several parts (build shape v2: content and selling
 * changes in one click, `kinds`) is ONE run and names every part, in send order: "Resume offer, Update and End listing".
 */
export function runChangeLabel(run: Pick<HistoryRun, 'kind' | 'fieldCount'> & { kinds?: HistoryRun['kinds'] }): string {
  const kinds = [...new Set(run.kinds ?? [])]
  if (kinds.length > 1) return listWords(kinds.map(kind => KIND_LABEL[kind]))
  const label = KIND_LABEL[run.kind]
  return run.kind === 'update' && run.fieldCount != null ? `${label} · ${plural(run.fieldCount, 'field')}` : label
}

// ── Undo of a selling change ─────────────────────────────────────────────────────────────────────────────────────

/**
 * What putting a selling change back means (build shape v2, D-M2 A: the reverse is PREPARED, never run at once).
 *  - `resume`: a Pause offer made listings Inactive → "Resume these 3…" sets their Status back to Active and opens
 *    Publish; nothing is sent until the person publishes.
 *  - `relist`: an End listing ended them → "Relist…", the same way (eBay gives a relisted item a new item number).
 *  - `none`: a Delete listing → "Cannot be undone": the listing is gone from the channel.
 */
export interface RunUndo {
  /** The run (or the part of a Publish) this puts back. */
  run: HistoryRun
  kind: 'resume' | 'relist' | 'none'
  /** The button's words, or the note's for `none`. */
  label: string
  /** One sentence: what happens when it is pressed (or why it cannot be). */
  hint: string
  /** The listings whose change the channel accepted — the only ones there is something to put back on. */
  listingIds: string[]
}

const UNDO_OF: Partial<Record<HistoryKind, RunUndo['kind']>> = { pause: 'resume', end: 'relist', delete: 'none' }

const accepted = (p: Pick<HistoryProduct, 'result'>) => p.result === 'ACCEPTED' || p.result === 'VERIFIED'

/**
 * The Undo of each selling part of a run: the run itself when it is one selling change, else every part of a Publish
 * (`children`) whose kind can be put back, with ITS products (`HistoryProduct.runId`). Only listings the channel
 * accepted count: a pause that failed paused nothing. A part with nothing accepted offers nothing. Resume and Relist
 * are offered on the listings that changed; a Delete only says it cannot be undone.
 */
export function runUndos(detail: Pick<HistoryRunDetail, 'run' | 'children'>, products: readonly HistoryProduct[]): RunUndo[] {
  const parts = detail.children?.length ? detail.children : [detail.run]
  const out: RunUndo[] = []
  for (const part of parts) {
    const kind = UNDO_OF[part.kind]
    if (!kind) continue
    const own = detail.children?.length ? products.filter(p => p.runId === part.id) : products
    const listingIds = [...new Set(own.filter(accepted).map(p => p.listingId).filter((id): id is string => !!id))]
    if (!listingIds.length) continue
    const n = listingIds.length
    const where = runDestination(part)
    if (kind === 'resume') {
      out.push({ run: part, kind, listingIds,
        label: n === 1 ? 'Resume this listing…' : `Resume these ${n}…`,
        hint: `Sets Status to Active on ${plural(n, 'listing')} on ${where} and opens Publish. Nothing is sent until you publish.` })
    } else if (kind === 'relist') {
      out.push({ run: part, kind, listingIds, label: 'Relist…',
        hint: `Sets Status to Active on ${plural(n, 'ended listing')} on ${where} and opens Publish. Nothing is sent until you publish.${part.channel === 'EBAY' ? ' eBay gives a relisted item a new item number.' : ''}` })
    } else {
      out.push({ run: part, kind, listingIds: [], label: 'Cannot be undone',
        // Simplify (Owner 2026-10-04): a deleted listing reads Not listed; Status Active + Publish lists it again.
        hint: `${plural(n, 'listing was', 'listings were')} deleted on ${where} and ${n === 1 ? 'reads' : 'read'} Not listed. To list ${n === 1 ? 'it' : 'them'} again, set ${n === 1 ? 'its' : 'their'} Status to Active and Publish.` })
    }
  }
  return out
}

// ── "Show in sheet" lands on the field ───────────────────────────────────────────────────────────────────────────

/**
 * The channel's names for the field a product's result points at, in the order the sheet should try them: the
 * server's column key when it knows one, then every attribute the channel named, then the first field label. The SHEET
 * maps a name to its own column (`publishColumnLookup`, sheet/channel/publishColumn.tsx) — only it knows its columns.
 */
export function sheetFieldHints(product: Pick<HistoryProduct, 'columnKey' | 'columnHint' | 'fieldLabel'>): string[] {
  const names = [product.columnKey, ...product.columnHint, product.fieldLabel]
  return [...new Set(names.map(name => name?.trim() ?? '').filter(Boolean))]
}

/**
 * "Show in sheet" from the history: the row and the field names to land on. The Activity tab cannot reach the sheet's
 * grid (another tab, mounted after the switch), so it leaves this ONE request and switches tab; the sheet takes it
 * once its grid is ready, maps the names to a column and lands there with the engine's `landOnCell`. One request at
 * a time; a request older than `SHEET_LANDING_TTL_MS` is dropped (the person did something else since).
 */
export interface SheetLandingRequest {
  rowId: string
  /** Field names as the channel named them (`sheetFieldHints`); [] = land on the row. */
  fieldNames: string[]
  /** Destination the row belongs to: a sheet showing another one leaves the request alone. */
  channel: string
  marketplace: string | null
  at: number
}

export const SHEET_LANDING_TTL_MS = 30_000
let pendingLanding: SheetLandingRequest | null = null

export function requestSheetLanding(request: Omit<SheetLandingRequest, 'at'>, now: number = Date.now()): void {
  pendingLanding = { ...request, at: now }
}

/**
 * The waiting request for this sheet, taken once (a second call answers null). `destination` = the sheet's channel and
 * market: a request for another destination stays for the sheet it belongs to.
 */
export function takeSheetLanding(destination: { channel: string; marketplace: string | null }, now: number = Date.now()): SheetLandingRequest | null {
  const request = pendingLanding
  if (!request) return null
  if (now - request.at > SHEET_LANDING_TTL_MS) { pendingLanding = null; return null }
  if (request.channel !== destination.channel || (request.marketplace ?? null) !== (destination.marketplace ?? null)) return null
  pendingLanding = null
  return request
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
