/**
 * Isomorphic data loader for the variant-matrix page.
 *
 * Runs on the server (page.tsx, fast path) and in the browser
 * (MatrixLoader, authenticated fallback). Under RBAC enforce the Next
 * server can't read the API-origin session cookie, so the SSR fetch 401s;
 * re-running in the browser lets the credentialed fetch wrapper authenticate
 * it. Never throws / never calls notFound() — returns a tagged result.
 */

import { getBackendUrl } from '@/lib/backend-url'

export interface MatrixData {
  product: any
  children: any[]
}

export type MatrixLoadResult =
  | { kind: 'ok'; data: MatrixData }
  | { kind: 'notfound' }
  | { kind: 'error'; code: number | null }

export async function loadMatrixData(id: string): Promise<MatrixLoadResult> {
  const backend = getBackendUrl()
  try {
    // EH.3 — parallel fetch; common path is product.isParent, so eagerly
    // fetching children alongside saves the ~100ms children waterfall.
    const [productRes, childrenRes] = await Promise.all([
      fetch(`${backend}/api/inventory/${id}`, { cache: 'no-store' }),
      fetch(`${backend}/api/products/${id}/children`, { cache: 'no-store' }),
    ])

    if (productRes.status === 404) return { kind: 'notfound' }
    if (!productRes.ok) return { kind: 'error', code: productRes.status }

    const product = await productRes.json()
    const childrenJson = childrenRes.ok ? await childrenRes.json() : { children: [] }
    return { kind: 'ok', data: { product, children: childrenJson.children ?? [] } }
  } catch {
    return { kind: 'error', code: null }
  }
}
