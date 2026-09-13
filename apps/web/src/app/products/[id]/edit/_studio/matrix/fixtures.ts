/**
 * MX — PREVIEW fixtures: deterministic Matrix cells on REAL rows, until the Matrix service exists.
 *
 * The page's identity column, axis values, images and row order come from the sheet and the family read
 * (real). Only the CELLS are fixtures — generated from a stable hash of `sku + coordinate`, so a reload
 * paints the same picture and a screenshot can be compared to itself. The page states this on screen
 * (`MATRIX_COPY.previewBanner`) and `MatrixRead.source === 'preview'` is how every consumer knows.
 *
 * 🔴 PREVIEW-ONLY knowledge lives here and nowhere else: the EU shared-market set mirrors
 * `apps/api/src/services/amazon-eu-quantity-guard.ts:24` so the preview can group the region the way the live
 * read will; the live read carries `region` and `sharedInventoryWith` from the server and this list is not
 * consulted. The same for currencies. Nothing in this file may be imported by a live-mode path.
 */
import {
  INVENTORY_CELL_KINDS,
  MATRIX_COPY,
  type CoordinateKey,
  type FulfilmentMethod,
  type ListingState,
  type MatrixCellKind,
  type MatrixCells,
  type MatrixCoordinate,
  type MatrixRead,
  type MatrixRowRead,
  type QueueState,
  type SyncCell,
} from './contract'

/** Mirrors the guard's set. Preview only. */
export const PREVIEW_AMAZON_EU_MARKETS: readonly string[] = ['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'PL', 'SE', 'IE']
const PREVIEW_CURRENCY: Readonly<Record<string, string>> = { UK: 'GBP', PL: 'PLN', SE: 'SEK', TR: 'TRY', US: 'USD' }

/** What the page knows about its rows without the service: the sheet's rows, narrowed. */
export interface PreviewRowInput {
  id: string
  sku: string
  isParent: boolean
  basePrice: number | null
  status: string
}

/** What the page knows about its coordinates without the service: the scope options + connected accounts. */
export interface PreviewCoordinateInput {
  channel: string
  market: string
  label: string
  connected: boolean
  accountId: string | null
}

/* ── a stable hash so the fixture is the same on every load ─────────────────────────────────── */

export function hashOf(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
const pick = <T,>(h: number, xs: readonly T[]): T => xs[h % xs.length]!

/* ── coordinates ────────────────────────────────────────────────────────────────────────────── */

const channelLabel = (channel: string): string =>
  ({ AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', ETSY: 'Etsy', WOOCOMMERCE: 'WooCommerce' } as Record<string, string>)[channel] ?? channel

const ALL_CELLS: readonly MatrixCellKind[] = ['listing', 'fulfilment', 'syncMode', 'syncQty', 'syncBuffer', 'syncState', 'price', 'salePrice']

/**
 * The coordinate list the preview shows: one group per connected channel × market, the Amazon EU markets
 * folded onto ONE region-inventory group, one preview alias on the first eBay market (labelled so).
 * Unconnected coordinates are kept, with no cells, so the absence is visible (design §3.1 rule 6).
 */
export function previewCoordinates(inputs: readonly PreviewCoordinateInput[]): MatrixCoordinate[] {
  const out: MatrixCoordinate[] = []
  const amazonEu = inputs.filter(c => c.channel === 'AMAZON' && c.connected && PREVIEW_AMAZON_EU_MARKETS.includes(c.market)).map(c => c.market)
  if (amazonEu.length > 0) {
    out.push({
      key: 'AMAZON:EU', kind: 'region-inventory', channel: 'AMAZON', market: 'EU',
      label: `Amazon EU · Inventory · ${amazonEu.join(' ')}`, region: 'EU', alias: null,
      accountId: inputs.find(c => c.channel === 'AMAZON' && c.accountId)?.accountId ?? null,
      currency: 'EUR', connected: true, listed: null, draft: null,
      cells: INVENTORY_CELL_KINDS, absent: [], sharedInventoryWith: amazonEu, inventoryOn: null,
      vocabulary: { fulfilment: ['FBA', 'FBM'] },
    })
  }
  for (const c of inputs) {
    const key = `${c.channel}:${c.market}`
    const global = c.market === 'GLOBAL'
    const inEu = c.channel === 'AMAZON' && PREVIEW_AMAZON_EU_MARKETS.includes(c.market) && amazonEu.includes(c.market)
    const currency = PREVIEW_CURRENCY[c.market] ?? 'EUR'
    const absent: Array<{ cell: MatrixCellKind; reason: string }> = []
    let cells: MatrixCellKind[] = [...ALL_CELLS]
    if (c.channel === 'EBAY') { cells = cells.filter(k => k !== 'salePrice'); absent.push({ cell: 'salePrice', reason: MATRIX_COPY.absentSaleEbay }) }
    if (c.channel !== 'AMAZON' && c.channel !== 'EBAY') { cells = cells.filter(k => k !== 'fulfilment'); absent.push({ cell: 'fulfilment', reason: MATRIX_COPY.absentFulfilment(channelLabel(c.channel)) }) }
    if (inEu) cells = cells.filter(k => !INVENTORY_CELL_KINDS.includes(k))
    const label = global ? channelLabel(c.channel) : `${channelLabel(c.channel)} · ${c.market}`
    out.push({
      key, kind: global ? 'global' : 'market', channel: c.channel, market: c.market, label,
      region: c.channel === 'AMAZON' ? (inEu ? 'EU' : c.market === 'UK' ? 'UK' : null) : null, alias: null,
      accountId: c.accountId, currency, connected: c.connected, listed: null, draft: null,
      cells: c.connected ? cells : [], absent, sharedInventoryWith: null, inventoryOn: inEu ? 'AMAZON:EU' : null,
      vocabulary: { fulfilment: c.channel === 'AMAZON' ? ['FBA', 'FBM'] : c.channel === 'EBAY' ? ['FBM', 'MCF'] : null },
    })
    /* One preview alias on the first connected eBay market, so the alias-as-coordinate rule is visible. */
    if (c.channel === 'EBAY' && c.connected && !out.some(o => o.alias)) {
      out.push({ ...out[out.length - 1]!, key: `${key}#preview-alias`, label: `${label} ②`, alias: { id: 'preview-alias', label: 'Preview alias', position: 1 } })
    }
  }
  return out
}

/* ── cells ──────────────────────────────────────────────────────────────────────────────────── */

const LISTING_STATES: readonly ListingState[] = ['listed', 'listed', 'listed', 'listed', 'listed', 'listed', 'draft', 'needs-value', 'suppressed']
const QUEUE: readonly QueueState[] = ['sent', 'sent', 'sent', 'sent', 'queued', 'failed', 'sent', 'dead']

function fixtureSync(h: number, pool: number, fba: boolean, paused: boolean): SyncCell {
  if (fba) return { kind: 'FBA_EXCLUDED', via: null, mode: 'FOLLOW', intended: null, held: null, buffer: 0, poolAvailable: pool, routedLocations: ['IT-MAIN'], fbaAtAmazon: 3 + (h % 14), oversold: false }
  const pinned = h % 5 === 0
  const buffer = h % 7 === 0 ? 2 : 0
  const held = pinned ? 4 + (h % 9) : Math.max(0, pool - buffer)
  const base: SyncCell = { kind: pinned ? 'PINNED' : 'FOLLOW', via: null, mode: pinned ? 'PINNED' : 'FOLLOW', intended: pinned ? held : Math.max(0, pool - buffer), held, buffer, poolAvailable: pool, routedLocations: ['IT-MAIN'], fbaAtAmazon: null, oversold: false }
  if (paused) return { ...base, kind: 'PAUSED', via: h % 3 === 0 ? 'POLICY' : 'LISTING', intended: null }
  if (h % 11 === 0) return { ...base, kind: 'UNCOUNTED', intended: null, poolAvailable: null, routedLocations: [] }
  return base
}

function fixtureCells(row: PreviewRowInput, coord: MatrixCoordinate, pool: number): MatrixCells {
  const h = hashOf(`${row.sku}|${coord.key}`)
  const parent = row.isParent
  const serves = (k: MatrixCellKind) => coord.cells.includes(k)
  const fbaRow = coord.channel === 'AMAZON' && h % 5 !== 1 && !parent
  const paused = coord.channel !== 'AMAZON' && coord.channel !== 'EBAY' ? true : h % 13 === 0
  const method: FulfilmentMethod | null = coord.channel === 'AMAZON' ? (fbaRow ? 'FBA' : 'FBM') : coord.channel === 'EBAY' ? 'FBM' : null
  const listingState: ListingState = parent ? 'listed' : coord.alias ? 'listed' : pick(h >>> 3, LISTING_STATES)
  const price = coord.alias ? 0 : coord.market === 'DE' ? 99 : (row.basePrice ?? 105)
  const source = coord.alias ? 'override' : coord.market === 'DE' ? 'override' : h % 17 === 0 ? 'formula' : 'master'
  const sync = serves('syncMode') ? fixtureSync(h, pool, fbaRow, paused) : null
  const writable: MatrixCells['writable'] = {}
  const blocked: MatrixCells['writeBlockedReason'] = {}
  for (const k of coord.cells) {
    if (k === 'listing' || k === 'syncState') continue
    if (parent && k !== 'price' && k !== 'salePrice') { writable[k] = false; blocked[k] = 'Set on the variants — the parent has no listing of its own'; continue }
    if (fbaRow && INVENTORY_CELL_KINDS.includes(k) && k !== 'fulfilment') { writable[k] = false; blocked[k] = MATRIX_COPY.amazonManaged; continue }
    if (k === 'syncBuffer' && sync?.mode === 'PINNED') { writable[k] = false; blocked[k] = 'A pinned listing ignores its buffer — set it to Follow first'; continue }
    if (k === 'price' && source === 'formula') { writable[k] = false; blocked[k] = 'A formula owns this cell — edit the formula'; continue }
    writable[k] = true
  }
  return {
    listingId: `${row.id}:${coord.key}`, version: 1 + (h % 4),
    listing: serves('listing') ? { state: listingState, externalId: parent ? (coord.channel === 'AMAZON' ? 'B0F7J163XJ' : coord.channel === 'EBAY' ? '257584954808' : null) : null, detail: parent ? '1 listing' : listingState === 'listed' && coord.channel === 'AMAZON' && h % 6 === 0 ? 'not buyable' : null, published: listingState === 'listed' } : null,
    fulfilment: serves('fulfilment') ? { method, source: h % 4 === 0 ? 'derived' : 'set', guard: coord.channel === 'AMAZON' ? (fbaRow ? 'FBA' : h % 19 === 0 ? 'FBA' : 'FBM') : 'FBM', reported: coord.channel === 'AMAZON' && h % 23 === 0 ? 'MFN' : null } : null,
    sync,
    queue: serves('syncState') ? (sync?.kind === 'PAUSED' ? { state: 'paused', at: null, reason: null, syncType: null, via: sync.via } : sync?.kind === 'FBA_EXCLUDED' ? { state: 'never', at: null, reason: null, syncType: null, via: null } : { state: pick(h >>> 5, QUEUE), at: new Date(Date.UTC(2026, 8, 13, 5, (h % 50), 0)).toISOString(), reason: pick(h >>> 5, QUEUE) === 'failed' ? 'eBay: 25002 — the item is not active on this site' : pick(h >>> 5, QUEUE) === 'dead' ? 'MAX_RETRIES_EXCEEDED after 3 attempts' : null, syncType: 'QUANTITY_UPDATE', via: null }) : null,
    price: serves('price') ? { value: parent ? null : price, currency: coord.currency, source, formula: source === 'formula' ? '= $basePrice * 0.95' : null, clamped: null } : null,
    sale: serves('salePrice') ? (h % 9 === 0 && !parent ? { value: 89, start: '2026-09-12', end: '2026-09-30' } : { value: null, start: null, end: null }) : null,
    writable, writeBlockedReason: blocked,
  }
}

/** The whole preview read for a family. Pure; the same input always yields the same picture. */
export function buildPreviewMatrix(productId: string, rows: readonly PreviewRowInput[], coordinateInputs: readonly PreviewCoordinateInput[]): MatrixRead {
  const coordinates = previewCoordinates(coordinateInputs)
  const outRows: MatrixRowRead[] = rows.map(row => {
    const pool = row.isParent ? 0 : 6 + (hashOf(row.sku) % 30)
    const cells: Record<CoordinateKey, MatrixCells> = {}
    for (const c of coordinates) if (c.connected) cells[c.key] = fixtureCells(row, c, pool)
    return {
      id: row.id, sku: row.sku, role: row.isParent ? 'parent' : 'variant',
      stock: row.isParent ? { available: null, uncounted: false, locations: [] } : { available: pool, uncounted: false, locations: [{ code: 'IT-MAIN', available: pool }] },
      basePrice: row.basePrice, status: row.status, cells,
    }
  })
  const parent = outRows.find(r => r.role === 'parent')
  if (parent) parent.stock = { available: outRows.filter(r => r.role === 'variant').reduce((n, r) => n + (r.stock.available ?? 0), 0), uncounted: false, locations: [{ code: 'IT-MAIN', available: outRows.filter(r => r.role === 'variant').reduce((n, r) => n + (r.stock.available ?? 0), 0) }] }
  for (const c of coordinates) {
    if (!c.connected) continue
    const cells = outRows.filter(r => r.role === 'variant').map(r => r.cells[c.key]?.listing?.state)
    c.listed = cells.filter(s => s === 'listed').length
    c.draft = cells.filter(s => s === 'draft').length
  }
  return { version: 0, productId, source: 'preview', generatedAt: new Date(0).toISOString(), coordinates, rows: outRows, policies: [] }
}
