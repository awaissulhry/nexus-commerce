/**
 * MX.P — the Matrix's READ, and the ONE parse boundary between the wire and the page.
 *
 * "Live or not" is DECIDED here, once, on the read's own status — never inferred later by a consumer:
 *
 *   200            → parse HERE into a `MatrixRead` with `source: 'live'`. A body that does not carry
 *                    `coordinates` and `rows` is REFUSED with a sentence; the page shows the sentence
 *                    rather than half a Matrix. (`reference_wire_parse_boundary_rules`.)
 *   anything else  → `error`, with the server's own words, and the shared `SheetLoadError` on screen.
 *
 * 🔴 Preview mode is gone (Owner 2026-10-08): a 404 used to paint fixture cells on the real rows. The read answers 404 for
 * a product it cannot find (`studio-matrix.routes.ts`), so that drew made-up numbers for a real product; now every failed
 * read is the load-error state, and no number on the page is one the server did not send.
 *
 * 🔴 Pure except for `fetchMatrix` itself: no React and no AG, so the parse boundary is reachable from this workspace's
 * node-only vitest (`source.vitest.test.ts`).
 */
import { getBackendUrl } from '@/lib/backend-url'

import {
  MATRIX_CELL_KINDS,
  MATRIX_ENDPOINTS,
  type MatrixCellKind,
  type MatrixCoordinate,
  type MatrixLocation,
  type MatrixRead,
  type MatrixRowRead,
  type MatrixWriteCell,
  type MatrixWriteRequest,
  type MatrixWriteResult,
} from './contract'
import { parseFbaInbound, parseFbaPlans } from './fba/sendToFba'

/* ── the read ───────────────────────────────────────────────────────────────────────────────── */

export type MatrixSource =
  | { kind: 'live'; read: MatrixRead }
  | { kind: 'error'; message: string }

export interface FetchMatrixOptions {
  accountId?: string | null
  locale?: string | null
  signal?: AbortSignal
  /** Injectable for the node test. Defaults to the global. */
  fetchImpl?: typeof fetch
  baseUrl?: string
}

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
    /* 🔴 A transport failure is an UNKNOWN outcome: the load-error state, never a picture of cells. */
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) }
  }
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
  /** Shared stock by SKU: the lending business, when the SKU sells from its stock; anything malformed reads as own stock. */
  const poolSourceOf = (raw: unknown): MatrixRowRead['stock']['source'] => {
    const s = raw as Record<string, unknown> | null | undefined
    return s && s.kind === 'pool' && typeof s.grantId === 'string' && typeof s.lenderName === 'string'
      ? { kind: 'pool', grantId: s.grantId, lenderName: s.lenderName } : null
  }
  /** The FBA qty column: absent on the wire = not read (`undefined`); `null` = no FBA stock row; anything malformed reads as not read. */
  const fbaOf = (raw: unknown): MatrixRowRead['fba'] => {
    if (raw === null) return null
    const f = raw as Record<string, unknown> | undefined
    if (!f || typeof f !== 'object' || typeof f.units !== 'number' || !Number.isFinite(f.units)) return undefined
    const locations = Array.isArray(f.locations)
      ? (f.locations as Array<Record<string, unknown>>).filter((l) => typeof l?.code === 'string' && typeof l?.units === 'number').map((l) => ({ code: l.code as string, units: l.units as number }))
      : []
    return { units: f.units, locations, updatedAt: typeof f.updatedAt === 'string' ? f.updatedAt : null }
  }
  /** The Case column (Step 3): absent on the wire = not read (`undefined`); `null` = no case pack; a malformed one reads as not read. */
  const packOf = (raw: unknown): MatrixRowRead['pack'] => {
    if (raw === null) return null
    const p = raw as Record<string, unknown> | undefined
    if (!p || typeof p !== 'object') return undefined
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null)
    const owner = (v: unknown): 'AMAZON' | 'SELLER' | null => (v === 'AMAZON' || v === 'SELLER' ? v : null)
    // Several case sizes per SKU (Owner 2026-10-08): a size without whole units per case is dropped; biggest first.
    const sizes = (Array.isArray(p.sizes) ? p.sizes as Array<Record<string, unknown>> : []).flatMap((z) => {
      const units = num(z?.unitsPerCase)
      return units !== null && Number.isInteger(units) && units >= 1
        ? [{ unitsPerCase: units, caseLengthCm: num(z.caseLengthCm), caseWidthCm: num(z.caseWidthCm), caseHeightCm: num(z.caseHeightCm), caseWeightKg: num(z.caseWeightKg) }]
        : []
    }).sort((x, y) => y.unitsPerCase - x.unitsPerCase)
    return { sizes, fbaPrepOwner: owner(p.fbaPrepOwner), fbaLabelOwner: owner(p.fbaLabelOwner) }
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
        source: poolSourceOf(stock.source),
      },
      fba: fbaOf(r.fba),
      pack: packOf(r.pack),
      // Send to FBA (Step 4): Amazon's inbound + the units in open Nexus plans ("+N" in the FBA qty cell).
      fbaInbound: parseFbaInbound(r.fbaInbound),
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
      ...(Array.isArray(b.locations) ? { locations: locationsOf(b.locations) } : {}),
      // Send to FBA (Step 4): this family's open plans (absent on an older server).
      ...(Array.isArray(b.fbaPlans) ? { fbaPlans: parseFbaPlans(b.fbaPlans) } : {}),
    },
  }
}

/** "Sells from" (Step 2): the business's warehouses; a malformed entry is dropped (absent on an older server). */
function locationsOf(raw: unknown[]): MatrixLocation[] {
  return raw.flatMap((x) => {
    const l = x as Record<string, unknown> | null
    if (!l || typeof l.code !== 'string' || !l.code.trim()) return []
    return [{ code: l.code, name: typeof l.name === 'string' ? l.name : l.code, active: l.active !== false, ...(l.isDefault === true ? { isDefault: true } : {}) }]
  })
}

/* ── the write ────────────────────────────────────────────────────────────────────────────────── */

/**
 * `accountId` is the account the READ used (`fetchMatrix`'s), so the server resolves the same listings it showed; each
 * cell's `expectedListingId` (with `expectedVersion`) makes a write onto a different listing a conflict, never a hit.
 */
export async function patchMatrix(
  productId: string,
  cells: readonly MatrixWriteCell[],
  opts: { accountId?: string | null; fetchImpl?: typeof fetch; baseUrl?: string; signal?: AbortSignal } = {},
): Promise<MatrixWriteResult> {
  const base = opts.baseUrl ?? getBackendUrl()
  const doFetch = opts.fetchImpl ?? fetch
  const request: MatrixWriteRequest = { cells: [...cells], ...(opts.accountId ? { accountId: opts.accountId } : {}) }
  const res = await doFetch(`${base}${MATRIX_ENDPOINTS.write(productId)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal: opts.signal,
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error((body as { message?: string } | null)?.message ?? `The Matrix write was refused (HTTP ${res.status})`)
  return (body ?? { results: [], version: 0 }) as MatrixWriteResult
}

/* ── "Sells from" for every product: the market default (Step 2) ───────────────────────────── */

/** `POST /api/stock/sync-control/market-sources` — one market's warehouses, in sale order, for every product of the business. */
export interface MarketSourcesRequest {
  channel: string
  /** A market code, or `EU` for Amazon's EU group (the only way to name an Amazon EU market). */
  marketplace: string
  /** In sale order; `[]` removes the market's list (each warehouse's routes decide again). */
  codes: readonly string[]
  dryRun?: boolean
}

/** What the route answers: the list now per market (`before`), the listings that follow it and the products that keep their own. */
export interface MarketSourcesAnswer {
  channel: string
  marketplace: string
  markets: string[]
  codes: string[]
  before: Record<string, string[]>
  listings: number
  products: number
  exceptions: number
  dryRun?: boolean
  noop?: boolean
  recascadeQueued?: number
}

/** Posts (or dry-runs) a market's default. A refusal throws with the server's own sentence. */
export async function postMarketSources(
  body: MarketSourcesRequest,
  opts: { fetchImpl?: typeof fetch; baseUrl?: string; signal?: AbortSignal } = {},
): Promise<MarketSourcesAnswer> {
  const base = opts.baseUrl ?? getBackendUrl()
  const doFetch = opts.fetchImpl ?? fetch
  const res = await doFetch(`${base}/api/stock/sync-control/market-sources`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, codes: [...body.codes] }),
    signal: opts.signal,
  })
  const answer = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok || !answer) {
    const said = answer && (typeof answer.error === 'string' ? answer.error : typeof answer.message === 'string' ? answer.message : null)
    throw new Error(said ?? `The default was not saved (HTTP ${res.status})`)
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string') : [])
  const before: Record<string, string[]> = {}
  if (answer.before && typeof answer.before === 'object') for (const [m, codes] of Object.entries(answer.before as Record<string, unknown>)) before[m] = list(codes)
  return {
    channel: typeof answer.channel === 'string' ? answer.channel : body.channel,
    marketplace: typeof answer.marketplace === 'string' ? answer.marketplace : body.marketplace,
    markets: list(answer.markets),
    codes: list(answer.codes),
    before,
    listings: num(answer.listings),
    products: num(answer.products),
    exceptions: num(answer.exceptions),
    ...(answer.dryRun === true ? { dryRun: true } : {}),
    ...(answer.noop === true ? { noop: true } : {}),
    ...(typeof answer.recascadeQueued === 'number' ? { recascadeQueued: answer.recascadeQueued } : {}),
  }
}

/** The market list before a save (the group's first market: every EU market holds the same list). */
export const listBefore = (a: Pick<MarketSourcesAnswer, 'before' | 'markets'>): string[] => a.before[a.markets[0] ?? ''] ?? Object.values(a.before)[0] ?? []
