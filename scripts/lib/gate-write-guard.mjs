/**
 * The open-gesture gate's WRITE GUARD, as pure functions — A-43 / R-45 (2026-09-23).
 *
 * ## Why it moved out of `check-editor-open.mjs`
 *
 * Measured 2026-09-23 (U2): with business profiles ON the studio talks to its API through the page's
 * OWN origin — `<origin>/backend/api/…` (`apps/web/src/lib/backend-url.ts`) — and the old guard only
 * aborted a non-GET whose host was `EDITOR_API` (`127.0.0.1:8091`) and whose path began `/api/`. So a
 * fill-down regression's `PATCH /backend/api/products/bulk` would NOT have been aborted (it would have
 * reached the database the gate points at) and would NOT have been counted. The header's promise —
 * "the gate cannot damage the database it is pointed at" — had silently become false.
 *
 * A guard that can be wrong about which host is "the API" is the wrong shape. So:
 *   · A WRITE is a non-GET/HEAD/OPTIONS whose PATH is an API path — `/api/…` or `/backend/api/…` —
 *     on ANY host. Host-agnostic on purpose: a write to an unexpected backend is still a write, and
 *     the old rule let one to a foreign host straight through (the wire control only reported it).
 *   · Next's dev tooling (`/__nextjs_original-stack-frames`), server actions (page paths) and assets
 *     are not API paths and pass untouched — the original reason the guard classified by path.
 *   · The two formula endpoints are POST-shaped READS; the column-preference save is the one write the
 *     gate's own reveal may make (its window lives in the gate). Both are recognised on either path.
 *
 * `apiKeyOf` names the BACKEND a request reached, for the wire control: `loopback:8091` for a direct
 * call, `loopback:3000/backend` for the page's proxy. A page on the proxy is attributed through its
 * origin; the runner discriminates which database that proxy reaches before any gate runs.
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

/** `loopback:3000` / `api.example.com:443` — the host part of a key. `null` for an unparsable URL. */
export function hostKey(url) {
  try {
    const x = new URL(url)
    const port = x.port || (x.protocol === 'https:' ? '443' : '80')
    return `${LOOPBACK.has(x.hostname) ? 'loopback' : x.hostname}:${port}`
  } catch { return null }
}

/** `{ proxied, apiPath }` for an API request, else `null`. `apiPath` always starts `/api/`. */
export function apiPathOf(url) {
  let path
  try { path = new URL(url).pathname } catch { return null }
  const m = /^(\/backend)?(\/api\/.*)$/.exec(path)
  return m ? { proxied: !!m[1], apiPath: m[2] } : null
}

/** The backend key of an API request (`loopback:3000/backend`), or `null` when it is not an API call. */
export function apiKeyOf(url) {
  const api = apiPathOf(url)
  const host = hostKey(url)
  if (!api || !host) return null
  return api.proxied ? `${host}/backend` : host
}

/** The key the gate EXPECTS, from its configured API base (`EDITOR_API`): `…:3000/backend` or `…:8091`. */
export function expectedApiKey(apiBase) {
  const host = hostKey(apiBase)
  if (!host) return null
  let path = ''
  try { path = new URL(apiBase).pathname.replace(/\/+$/, '') } catch { return null }
  return path === '/backend' ? `${host}/backend` : host
}

const isReadMethod = (method) => method === 'GET' || method === 'HEAD' || method === 'OPTIONS'

/** A POST-shaped READ the sheet needs to paint its ƒ marks. */
export function isFormulaRead(url) {
  const api = apiPathOf(url)
  return !!api && /^\/api\/pim\/formulas\/(batch|preview)$/.test(api.apiPath)
}

/** The column-preference save (`/api/saved-views`) — a preference, not product data. */
export function isPreferenceWrite(url) {
  const api = apiPathOf(url)
  return !!api && /^\/api\/saved-views(\/|$)/.test(api.apiPath)
}

/** 🔴 Is this request a WRITE the gate must abort and count? Host-agnostic; see the header. */
export function isApiWrite(method, url) {
  if (isReadMethod(String(method).toUpperCase())) return false
  if (!apiPathOf(url)) return false
  if (isFormulaRead(url)) return false
  return true
}
