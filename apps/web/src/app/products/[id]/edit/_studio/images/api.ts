/**
 * PES.7 — the images tab's backend client.
 *
 * 🔴 Every call here goes to the FASTIFY backend, never to the Next server. On Vercel the two are
 * different origins; a bare `fetch('/api/…')` from this tab hits the Next route table, which has
 * no images routes, and 404s in production while working in local dev. `getBackendUrl()` is the
 * only correct base.
 *
 * ⚠ In local dev `NEXT_PUBLIC_API_URL` is usually unset, so this talks to the PRODUCTION API —
 * reads are prod reads and WRITES ARE REAL (reference_local_dev_hits_prod_api). Verification
 * writes go to the XAVIA test family only.
 *
 * Every mutation returns a discriminated result rather than throwing: the surfaces here report a
 * failure in place (the tile that refused, the row that did not save), and an exception that
 * unwinds to a boundary cannot say WHICH tile refused.
 */
import { getBackendUrl } from '@/lib/backend-url'

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string }

function url(path: string): string {
  return `${getBackendUrl()}${path}`
}

/**
 * The server's own words when it refuses. Never reworded — the operator acts on the real reason.
 *
 * 🔴 `message` wins over `error`, and the order matters. These routes answer with BOTH: a machine
 * code in `error` and a human sentence in `message`. Preferring the code showed the operator
 * "GENERATION_FAILED" while discarding *"models/imagen-3.0-generate-002 is not found for API
 * version v1beta"* — the one sentence that says what is actually wrong and who can fix it. A code
 * is a token for a log; a message is for the person reading the screen.
 *
 * The code is still appended when it adds something the sentence does not already say, because
 * `ASSET_NOT_FOUND` next to a vague sentence is worth having when someone files a bug.
 */
async function readError(res: Response): Promise<string> {
  try {
    const body = await res.json() as { error?: string; message?: string }
    const message = typeof body?.message === 'string' ? body.message.trim() : ''
    const code = typeof body?.error === 'string' ? body.error.trim() : ''
    if (message && code && !message.includes(code)) return `${message} (${code})`
    if (message) return message
    if (code) return code
    return `Request failed (${res.status})`
  } catch {
    return `Request failed (${res.status})`
  }
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url(path), { signal, credentials: 'include', cache: 'no-store' })
    if (!res.ok) return { ok: false, status: res.status, message: await readError(res) }
    return { ok: true, data: await res.json() as T }
  } catch (err) {
    if (signal?.aborted) return { ok: false, status: 0, message: 'aborted' }
    return { ok: false, status: 0, message: networkMessage(err) }
  }
}

/**
 * A network failure in words an operator can act on.
 *
 * The browser's own text is "Failed to fetch", which says nothing about what to do — measured when
 * the shared API went down mid-session and that string was what the matrix showed. Same rule as
 * `readError`, one level down: the message is for the person reading the screen. The raw cause is
 * kept in parentheses because it is what a bug report needs.
 */
function networkMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return `The server could not be reached — the request was not sent, so nothing changed. (${raw})`
}

export async function apiSend<T>(
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE' | 'PUT',
  body?: unknown,
): Promise<ApiResult<T>> {
  try {
    const isForm = body instanceof FormData
    const res = await fetch(url(path), {
      method, credentials: 'include',
      headers: isForm || body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: isForm ? body : body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) return { ok: false, status: res.status, message: await readError(res) }
    // 204 and empty bodies are success with nothing to parse.
    const text = await res.text()
    return { ok: true, data: (text ? JSON.parse(text) : null) as T }
  } catch (err) {
    return { ok: false, status: 0, message: networkMessage(err) }
  }
}

/* ── the endpoints this tab uses, named once ─────────────────────────────────────────────── */

export const routes = {
  workspace: (productId: string) => `/api/products/${productId}/images-workspace`,
  masterImages: (productId: string) => `/api/products/${productId}/images`,
  masterImage: (productId: string, imageId: string) => `/api/products/${productId}/images/${imageId}`,
  reorder: (productId: string) => `/api/products/${productId}/images/reorder`,
  primary: (productId: string, imageId: string) => `/api/products/${productId}/images/${imageId}/primary`,
  applyToChildren: (productId: string) => `/api/products/${productId}/images/apply-to-children`,
  duplicateGroups: (productId: string) => `/api/products/${productId}/images/duplicate-groups`,
  derive: (productId: string, imageId: string) => `/api/products/${productId}/images/${imageId}/derive`,
  autoEnhance: (productId: string, imageId: string) => `/api/products/${productId}/images/${imageId}/auto-enhance`,
  analyze: (productId: string, imageId: string) => `/api/products/${productId}/images/${imageId}/analyze`,
  pushToDam: (productId: string, imageId: string) => `/api/products/${productId}/images/${imageId}/push-to-dam`,
  importFromDam: (productId: string) => `/api/products/${productId}/images/import-from-dam`,
  generateLifestyle: (productId: string) => `/api/products/${productId}/images/generate-lifestyle`,
  videos: (productId: string) => `/api/products/${productId}/videos`,
  bulkSave: (productId: string) => `/api/products/${productId}/images-workspace/bulk-save`,

  /* Amazon publish — preflight, gate, submission. */
  amazonValidate: (productId: string, marketplace: string, activeAxis?: string | null) =>
    `/api/products/${productId}/amazon-images/validate?marketplace=${encodeURIComponent(marketplace)}`
    + (activeAxis ? `&activeAxis=${encodeURIComponent(activeAxis)}` : ''),
  amazonStale: (productId: string, marketplace: string) =>
    `/api/products/${productId}/amazon-images/stale?marketplace=${encodeURIComponent(marketplace)}`,
  amazonPublish: (productId: string) => `/api/products/${productId}/amazon-images/publish`,
  ebayPublish: (productId: string) => `/api/products/${productId}/ebay-images/publish`,
  shopifyPublish: (productId: string) => `/api/products/${productId}/shopify-images/publish`,
  /** The SERVER's publish gate. Never re-derive the mode in the browser. */
  publishReadiness: () => `/api/listings/publish-readiness`,
} as const
