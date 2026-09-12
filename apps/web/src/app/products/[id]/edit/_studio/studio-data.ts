/**
 * PES.1 — the frame's data read. Isomorphic, and deliberately small.
 *
 * TWO fetches: the product's identity, and the marketplace table the scope bar is derived from.
 * It does NOT load attributes, children, listings, parent/siblings or images — the old edit page
 * blocks on five such calls before its first paint, and a frame that only draws a name, a SKU and
 * a row of chips has no business waiting for any of them. Each tab loads its own.
 *
 * It runs in BOTH contexts for the same reason `edit-data.ts` does: under RBAC enforce the Next
 * server cannot read the API-origin session cookie, so the server pass returns 401 and the client
 * re-runs the identical call where the credentialed fetch wrapper authenticates it
 * (reference_rbac_enforce_ssr). It never throws and never calls `notFound()` — it returns a tagged
 * result and each caller reacts in its own context.
 */

import { getBackendUrl } from '@/lib/backend-url'

import { flattenGrouped } from './scopes'
import type { MarketplaceLite, StudioFamily, StudioProduct } from './types'

export interface StudioData {
  product: StudioProduct
  /** Set only when the product is a variation. `null` on a parent or a standalone product. */
  family: StudioFamily | null
  marketplaces: MarketplaceLite[]
  /**
   * True when the marketplace table could not be read but the product could.
   *
   * The frame still renders — you can look at a product with no scope bar — and the bar says why
   * it is empty instead of implying the catalogue sells nowhere.
   */
  marketplacesFailed: boolean
}

export type StudioLoadResult =
  | { kind: 'ok'; data: StudioData }
  | { kind: 'notfound' }
  | { kind: 'error'; code: number | null }

function toStudioProduct(raw: unknown): StudioProduct | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  if (typeof p.id !== 'string' || typeof p.sku !== 'string') return null
  return {
    id: p.id,
    sku: p.sku,
    name: typeof p.name === 'string' ? p.name : null,
    status: typeof p.status === 'string' ? p.status : null,
    isParent: p.isParent === true,
    parentId: typeof p.parentId === 'string' ? p.parentId : null,
    productType: typeof p.productType === 'string' ? p.productType : null,
    asin: typeof p.amazonAsin === 'string' && p.amazonAsin ? p.amazonAsin : null,
  }
}

/**
 * Transport ceiling for the frame's own reads.
 *
 * `fetch` has no default timeout, and the local-API pool starvation measured on 2026-09-01 produced
 * requests that stayed **permanently pending** — so "it will arrive eventually" is not a safe
 * assumption. Without a bound, one hung read means `loadStudioData` never resolves: on the client
 * the frame renders a skeleton forever, and on the SERVER pass it holds the whole route open.
 *
 * This is a transport bound, not a performance target — it sits far above any healthy read of a
 * single product row. Timing out is SOFT: it returns `{ kind: 'error', code: null }`, which is the
 * result the client pass already retries, so a slow-but-alive backend degrades to "retried", never
 * to "broken". Deliberately much tighter than the readiness CEILING_MS in contracts.tsx, because
 * this reads an identity row rather than computing a per-market readiness score.
 */
const LOAD_TIMEOUT_MS = 30_000

export async function loadStudioData(id: string): Promise<StudioLoadResult> {
  const backend = getBackendUrl()
  try {
    // Settled, not `all`: an unreadable marketplace table must not turn a perfectly readable
    // product into a page that cannot render.
    const [productRes, marketsRes, connectionsRes] = await Promise.allSettled([
      fetch(`${backend}/api/products/${encodeURIComponent(id)}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
      }),
      fetch(`${backend}/api/marketplaces/grouped`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
      }),
      fetch(`${backend}/api/connections?all=true`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
      }),
    ])

    if (productRes.status === 'rejected') return { kind: 'error', code: null }
    if (productRes.value.status === 404) return { kind: 'notfound' }
    if (!productRes.value.ok) return { kind: 'error', code: productRes.value.status }

    const product = toStudioProduct(await productRes.value.json())
    if (!product) return { kind: 'error', code: null }

    let marketplaces: MarketplaceLite[] = []
    let marketplacesFailed = true
    if (marketsRes.status === 'fulfilled' && marketsRes.value.ok) {
      marketplaces = flattenGrouped(await marketsRes.value.json())
      marketplacesFailed = false
    }
    // A seeded marketplace never proves a connected account. Shared content languages remain
    // available even when connection discovery fails; no channel scope is invented on failure.
    const connected = new Set<string>()
    const accountsByChannel = new Map<string, NonNullable<MarketplaceLite['accounts']>>()
    if (connectionsRes.status === 'fulfilled' && connectionsRes.value.ok) {
      const data = await connectionsRes.value.json()
      for (const c of data.connections ?? []) if (c.isActive && c.isManagedBy !== 'pending') {
        connected.add(c.channel)
        accountsByChannel.set(c.channel, [...(accountsByChannel.get(c.channel) ?? []), { id: c.id, label: c.accountLabel || c.storeName || c.sellerName || c.channel, primary: !!c.isPrimary }])
      }
    } else marketplacesFailed = true
    marketplaces = marketplaces.map(m => ({ ...m, connected: connected.has(m.channel), accounts: accountsByChannel.get(m.channel) ?? [] }))

    // One extra call, and ONLY for a variation. A parent pays nothing for this.
    let family: StudioFamily | null = null
    if (product.parentId) {
      try {
        const parentRes = await fetch(`${backend}/api/products/${encodeURIComponent(product.parentId)}`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
        })
        if (parentRes.ok) {
          const parent = toStudioProduct(await parentRes.json())
          if (parent) {
            family = {
              parentId: parent.id,
              parentSku: parent.sku,
              parentName: parent.name,
              parentAsin: parent.asin,
            }
          }
        }
      } catch {
        // A missing parent must not cost the operator the product they asked for; the header simply
        // shows the plain `Variation` pill with no link.
      }
    }

    return { kind: 'ok', data: { product, family, marketplaces, marketplacesFailed } }
  } catch {
    // Transport failure (DNS, cold start, reset) — a soft failure the client pass can retry.
    return { kind: 'error', code: null }
  }
}
