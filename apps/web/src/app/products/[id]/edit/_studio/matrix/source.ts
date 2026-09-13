/**
 * MX.P — the Matrix's READ, and the ONE parse boundary between the wire and the page.
 *
 * `GET /api/products/:id/studio/matrix` does not exist yet (the backend is a later session), so this
 * module is where "live or preview" is DECIDED, once, on the probe's own status — never inferred
 * later by a consumer:
 *
 *   200            → parse HERE into a `MatrixRead` with `source: 'live'`. A body that does not carry
 *                    `coordinates` and `rows` is REFUSED with a sentence; the page shows the sentence
 *                    rather than half a Matrix. (`reference_wire_parse_boundary_rules`.)
 *   404 / 501      → `preview`: the service is not built. The caller builds `buildPreviewMatrix` from
 *                    the REAL sheet rows and the REAL scope coordinates, and the page says so on
 *                    screen (`MATRIX_COPY.previewBanner`).
 *   anything else  → `error`, with the server's own words, and the shared `SheetLoadError` on screen.
 *
 * 🔴 Pure except for `fetchMatrix` itself: no React and no AG, so the parse boundary and both
 * projections are reachable from this workspace's node-only vitest (`source.vitest.test.ts`).
 */
import { getBackendUrl } from '@/lib/backend-url'

import {
  MATRIX_CELL_KINDS,
  MATRIX_ENDPOINTS,
  type MatrixCellKind,
  type MatrixCoordinate,
  type MatrixRead,
  type MatrixRowRead,
  type MatrixWriteCell,
  type MatrixWriteResult,
} from './contract'
import type { PreviewCoordinateInput, PreviewRowInput } from './fixtures'

/* ── the read ───────────────────────────────────────────────────────────────────────────────── */

export type MatrixSource =
  | { kind: 'live'; read: MatrixRead }
  /** The service is not built. `reason` is what the probe actually saw — never a guess. */
  | { kind: 'preview'; reason: string }
  | { kind: 'error'; message: string }

export interface FetchMatrixOptions {
  accountId?: string | null
  locale?: string | null
  signal?: AbortSignal
  /** Injectable for the node test. Defaults to the global. */
  fetchImpl?: typeof fetch
  baseUrl?: string
}

/** The statuses that mean "this route is not built here", as opposed to "this read failed". */
const NOT_BUILT = new Set([404, 501])

export async function fetchMatrix(productId: string, opts: FetchMatrixOptions = {}): Promise<MatrixSource> {
  const base = opts.baseUrl ?? getBackendUrl()
  const q = new URLSearchParams()
  if (opts.accountId) q.set('accountId', opts.accountId)
  if (opts.locale) q.set('locale', opts.locale)
  const url = `${base}${MATRIX_ENDPOINTS.read(productId)}${q.toString() ? `?${q}` : ''}`
  const doFetch = opts.fetchImpl ?? fetch
  let res: Response
  try {
    res = await doFetch(url, { credentials: 'include', cache: 'no-store', signal: opts.signal })
  } catch (e) {
    /* 🔴 A transport failure is an UNKNOWN outcome, not a verdict about the route. It is NEVER
       degraded to `preview`: that would put fixture numbers on screen because the network blinked. */
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) }
  }
  if (NOT_BUILT.has(res.status)) return { kind: 'preview', reason: `The Matrix service answered HTTP ${res.status}` }
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const said = (body && typeof body === 'object' && ((body as Record<string, unknown>).message ?? (body as Record<string, unknown>).error)) || null
    return { kind: 'error', message: typeof said === 'string' ? said : `The Matrix read was refused (HTTP ${res.status})` }
  }
  const body = await res.json().catch(() => null)
  const parsed = parseMatrixRead(body, productId)
  return 'problem' in parsed ? { kind: 'error', message: parsed.problem } : { kind: 'live', read: parsed.read }
}

/**
 * The ONE boundary. Everything the page reads afterwards is typed because it passed through here.
 *
 * It refuses rather than repairs: a body with no `coordinates` or no `rows` is a contract change,
 * and a Matrix drawn from half of one would show an operator a grid whose missing columns look like
 * missing listings.
 */
export function parseMatrixRead(body: unknown, productId: string): { read: MatrixRead } | { problem: string } {
  if (!body || typeof body !== 'object') return { problem: 'The Matrix service answered something that is not a Matrix read.' }
  const b = body as Record<string, unknown>
  if (!Array.isArray(b.coordinates)) return { problem: 'The Matrix read carried no `coordinates` — nothing would say which channels this family is on, so it is refused rather than drawn empty.' }
  if (!Array.isArray(b.rows)) return { problem: 'The Matrix read carried no `rows` — refused rather than drawn as an empty family.' }
  const coordinates: MatrixCoordinate[] = []
  for (const raw of b.coordinates) {
    const c = raw as Record<string, unknown>
    if (typeof c?.key !== 'string') return { problem: 'A coordinate in the Matrix read carried no `key`.' }
    const cells = Array.isArray(c.cells) ? (c.cells as unknown[]).filter((k): k is MatrixCellKind => MATRIX_CELL_KINDS.includes(k as MatrixCellKind)) : []
    coordinates.push({
      key: c.key,
      kind: c.kind === 'region-inventory' || c.kind === 'global' ? c.kind : 'market',
      channel: typeof c.channel === 'string' ? c.channel : c.key.split(':')[0] ?? '',
      market: typeof c.market === 'string' ? c.market : c.key.split(':')[1] ?? '',
      label: typeof c.label === 'string' ? c.label : c.key,
      region: typeof c.region === 'string' ? c.region : null,
      alias: c.alias && typeof c.alias === 'object' ? (c.alias as MatrixCoordinate['alias']) : null,
      accountId: typeof c.accountId === 'string' ? c.accountId : null,
      currency: typeof c.currency === 'string' ? c.currency : 'EUR',
      connected: c.connected !== false,
      /* 🔴 `null`, never `0`. A count nobody sent has not been counted, and the strip tag must be
         able to render nothing rather than "0 listed" (the ViewChip contract's own rule). */
      listed: typeof c.listed === 'number' ? c.listed : null,
      draft: typeof c.draft === 'number' ? c.draft : null,
      cells,
      absent: Array.isArray(c.absent) ? (c.absent as MatrixCoordinate['absent']) : [],
      sharedInventoryWith: Array.isArray(c.sharedInventoryWith) ? (c.sharedInventoryWith as string[]) : null,
      inventoryOn: typeof c.inventoryOn === 'string' ? c.inventoryOn : null,
      vocabulary: {
        fulfilment: Array.isArray((c.vocabulary as Record<string, unknown> | undefined)?.fulfilment)
          ? ((c.vocabulary as Record<string, unknown>).fulfilment as MatrixCoordinate['vocabulary']['fulfilment'])
          : null,
      },
    })
  }
  const rows: MatrixRowRead[] = []
  for (const raw of b.rows) {
    const r = raw as Record<string, unknown>
    if (typeof r?.id !== 'string') return { problem: 'A row in the Matrix read carried no `id`.' }
    const stock = (r.stock ?? {}) as Record<string, unknown>
    rows.push({
      id: r.id,
      sku: typeof r.sku === 'string' ? r.sku : r.id,
      role: r.role === 'parent' ? 'parent' : 'variant',
      stock: {
        available: typeof stock.available === 'number' ? stock.available : null,
        uncounted: stock.uncounted === true,
        locations: Array.isArray(stock.locations) ? (stock.locations as MatrixRowRead['stock']['locations']) : [],
      },
      basePrice: typeof r.basePrice === 'number' ? r.basePrice : null,
      status: typeof r.status === 'string' ? r.status : '',
      cells: r.cells && typeof r.cells === 'object' ? (r.cells as MatrixRowRead['cells']) : {},
    })
  }
  return {
    read: {
      version: typeof b.version === 'number' ? b.version : 0,
      productId: typeof b.productId === 'string' ? b.productId : productId,
      source: 'live',
      generatedAt: typeof b.generatedAt === 'string' ? b.generatedAt : new Date().toISOString(),
      coordinates,
      rows,
      policies: Array.isArray(b.policies) ? (b.policies as MatrixRead['policies']) : [],
    },
  }
}

/* ── the write (live mode only; preview goes to `store.applyCells`) ────────────────────────── */

export async function patchMatrix(
  productId: string,
  cells: readonly MatrixWriteCell[],
  opts: { fetchImpl?: typeof fetch; baseUrl?: string; signal?: AbortSignal } = {},
): Promise<MatrixWriteResult> {
  const base = opts.baseUrl ?? getBackendUrl()
  const doFetch = opts.fetchImpl ?? fetch
  const res = await doFetch(`${base}${MATRIX_ENDPOINTS.write(productId)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cells }),
    signal: opts.signal,
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error((body as { message?: string } | null)?.message ?? `The Matrix write was refused (HTTP ${res.status})`)
  return (body ?? { results: [], version: 0 }) as MatrixWriteResult
}

/* ── the PREVIEW projections: real rows, real coordinates, fixture cells ────────────────────── */

/** Stable ordering (design D-MX12): Amazon · eBay · Shopify · WooCommerce · Etsy, then the rest. */
const CHANNEL_ORDER = ['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY']

const channelRank = (channel: string): number => {
  const i = CHANNEL_ORDER.indexOf(channel)
  return i === -1 ? CHANNEL_ORDER.length : i
}

/** The sheet's rows, narrowed to what the preview needs. Identity stays the sheet's. */
export function previewRowInputs(
  rows: ReadonlyArray<{ id: string; sku: string; isParent: boolean; basePrice: number | null; status: string }>,
): PreviewRowInput[] {
  return rows.map((r) => ({ id: r.id, sku: r.sku, isParent: r.isParent, basePrice: r.basePrice, status: r.status }))
}

export interface CoordinateSourceOptions {
  /** `useStudioScope().options.channels` — the CONNECTED channels and the markets each serves. */
  channels: ReadonlyArray<{ id: string; label: string; markets: string[] }>
  /** `useStudioScope().marketplaces` — every configured row, connected or not, with its accounts. */
  marketplaces: ReadonlyArray<{ channel: string; code: string; name?: string; connected?: boolean; accounts?: ReadonlyArray<{ id: string; primary: boolean }> }>
}

/**
 * The coordinates the preview shows — derived from the LIVE marketplace table, never a list here.
 *
 * 🔴 Connected FIRST, unconnected LAST, so `previewCoordinates()` (which preserves input order after
 * folding the Amazon EU region group to the front) yields design §3.3's order: Amazon (EU inventory,
 * then its markets) · eBay · Shopify · WooCommerce · Etsy · then the `Not listed` singles.
 *
 * 🔴 `connected` is a CHANNEL fact in this frame, not a market one — `studio-data.ts:120` sets it
 * from the set of channels that have an active account, so every market of a connected channel is
 * connected and every market of a channel with no account is not. Measured, not assumed; a lane that
 * read it as per-market would draw `Not listed` over markets that are simply unlisted.
 */
export function previewCoordinateInputs(opts: CoordinateSourceOptions): PreviewCoordinateInput[] {
  const connectedChannels = new Set(opts.channels.map((c) => c.id))
  const labelOf = new Map(opts.channels.map((c) => [c.id, c.label]))
  const seen = new Set<string>()
  const out: PreviewCoordinateInput[] = []
  for (const m of opts.marketplaces) {
    const key = `${m.channel}:${m.code}`
    if (seen.has(key)) continue
    seen.add(key)
    const connected = m.connected !== false && connectedChannels.has(m.channel)
    const account = m.accounts?.find((a) => a.primary) ?? m.accounts?.[0] ?? null
    out.push({
      channel: m.channel,
      market: m.code,
      label: m.name ?? `${labelOf.get(m.channel) ?? m.channel} · ${m.code}`,
      connected,
      accountId: account?.id ?? null,
    })
  }
  /* Markets keep the MARKETPLACE TABLE's own order inside a channel (design D-MX12: "markets in
     `Marketplace` order") — the sort is stable, so no tiebreak on the code. An alphabetical tiebreak
     here put the preview alias on `eBay · DE` instead of the first eBay market the table lists. */
  return out.sort((a, b) =>
    Number(b.connected) - Number(a.connected) ||
    channelRank(a.channel) - channelRank(b.channel) ||
    a.channel.localeCompare(b.channel),
  )
}
