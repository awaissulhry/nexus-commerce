/**
 * Isomorphic data loader for the product edit page.
 *
 * Runs in BOTH contexts:
 *   - server (page.tsx) for the fast SSR path, and
 *   - browser (ProductEditLoader) for the authenticated fallback.
 *
 * Why the fallback exists: under RBAC enforce mode (S3, live 2026-07-03)
 * the Next.js server cannot read the API-origin (railway.app) session
 * cookie, so the server-side fetches here return 401. Re-running the exact
 * same loader in the browser lets the credentialed global fetch wrapper
 * attach the session + CSRF header, so per-user RBAC is still enforced —
 * the data is only ever returned for a user actually permitted to see it.
 *
 * The loader NEVER throws and NEVER calls notFound() — it returns a tagged
 * result so each caller can react in its own context (server vs client).
 */

import { getBackendUrl } from '@/lib/backend-url'

export interface EditData {
  product: any
  marketplaces: Record<string, any>
  childrenList: any[]
  parentProduct: any | null
  siblings: any[]
}

export type EditLoadResult =
  | { kind: 'ok'; data: EditData }
  | { kind: 'notfound' }
  | { kind: 'error'; code: number | null }

export async function loadEditData(id: string): Promise<EditLoadResult> {
  const backend = getBackendUrl()
  try {
    const [productRes, marketplacesRes, childrenRes] = await Promise.all([
      fetch(`${backend}/api/products/${id}`, { cache: 'no-store' }),
      fetch(`${backend}/api/marketplaces/grouped`, { cache: 'no-store' }),
      fetch(`${backend}/api/products/${id}/children`, { cache: 'no-store' }),
    ])

    if (productRes.status === 404) return { kind: 'notfound' }
    if (!productRes.ok) return { kind: 'error', code: productRes.status }

    const product = await productRes.json()
    const marketplaces = marketplacesRes.ok ? await marketplacesRes.json() : {}
    const childrenJson = childrenRes.ok ? await childrenRes.json() : { children: [] }
    const childrenList = childrenJson.children ?? []

    // When this product is a variant (child), fetch the family context so the
    // client can surface per-channel parent IDs (Amazon ASIN, eBay item ID…).
    let parentProduct: any = null
    let siblings: any[] = []
    if (product.parentId) {
      const [parentRes, siblingsRes] = await Promise.all([
        fetch(`${backend}/api/products/${product.parentId}`, { cache: 'no-store' }),
        fetch(`${backend}/api/products/${product.parentId}/children`, { cache: 'no-store' }),
      ])
      if (parentRes.ok) parentProduct = await parentRes.json()
      if (siblingsRes.ok) {
        const json = await siblingsRes.json()
        siblings = json.children ?? []
      }
    }

    return { kind: 'ok', data: { product, marketplaces, childrenList, parentProduct, siblings } }
  } catch {
    // Network/transport error (DNS, cold-start, reset) — treat as a soft
    // failure so the caller can retry client-side rather than 500 the page.
    return { kind: 'error', code: null }
  }
}
