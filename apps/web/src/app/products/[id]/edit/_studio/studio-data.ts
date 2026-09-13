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
import { connectionHealth } from './presence/connection'

import { flattenGrouped, primaryLanguageFrom } from './scopes'
import type { MarketplaceLite, StudioFamily, StudioProduct } from './types'

export interface StudioData {
  product: StudioProduct
  /** Set only when the product is a variation. `null` on a parent or a standalone product. */
  family: StudioFamily | null
  primaryLanguage: string | null
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
    ...(p.deletedAt === null || typeof p.deletedAt === 'string' ? { deletedAt: p.deletedAt } : {}),
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
    let primaryLanguage: string | null = null
    let marketplacesFailed = true
    if (marketsRes.status === 'fulfilled' && marketsRes.value.ok) {
      const grouped = await marketsRes.value.json()
      marketplaces = flattenGrouped(grouped)
      primaryLanguage = primaryLanguageFrom(grouped)
      marketplacesFailed = primaryLanguage === null
    }
    // Keep revoked/disconnected accounts in the scope inventory. A failed read is unknown.
    const accountsByChannel = new Map<string, NonNullable<MarketplaceLite['accounts']>>()
    let connectionsRead = false
    if (connectionsRes.status === 'fulfilled' && connectionsRes.value.ok) {
      try {
        const data: unknown = await connectionsRes.value.json()
        if (!data || typeof data !== 'object' || !Array.isArray((data as { connections?: unknown }).connections)) throw new Error('Connections not reported')
        const connections = (data as { connections: unknown[] }).connections
        for (const raw of connections) {
          if (!raw || typeof raw !== 'object') throw new Error('Connection not reported')
          const c = raw as Record<string, unknown>
          if (typeof c.id !== 'string' || typeof c.channel !== 'string') throw new Error('Connection identity not reported')
          if (c.isManagedBy === 'pending') continue
          const labels = [c.accountLabel, c.storeName, c.sellerName]
          const label = labels.find((v): v is string => typeof v === 'string' && v.trim().length > 0)
          const health = connectionHealth(c, Date.now())
          accountsByChannel.set(c.channel, [...(accountsByChannel.get(c.channel) ?? []), {
            id: c.id, label: label == null ? c.id : label, primary: c.isPrimary === true, health,
          }])
        }
        connectionsRead = true
      } catch { accountsByChannel.clear() }
    }
    if (!connectionsRead) marketplacesFailed = true
    marketplaces = marketplaces.map(m => {
      const accounts = accountsByChannel.get(m.channel) ?? []
      if (!connectionsRead) return { ...m, connectionHealth: null }
      const healthy = accounts.find(a => a.health?.state === 'connected')
      return { ...m, connected: healthy != null, accounts,
        connectionHealth: healthy?.health ?? accounts[0]?.health ?? null }
    })

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

    return { kind: 'ok', data: { product, family, marketplaces, primaryLanguage, marketplacesFailed } }
  } catch {
    // Transport failure (DNS, cold start, reset) — a soft failure the client pass can retry.
    return { kind: 'error', code: null }
  }
}
