// The browser's API calls (`<origin>/backend/api/…`) as an EXTERNAL REWRITE: `next start` proxies them straight to the
// API, with no route handler in between. In production that is Railway's private network (`NEXUS_API_PROXY_TARGET`).
//
// Why: they used to go through the `/backend/[...path]` route handler, which stays alive for the whole request. Live-update
// streams (EventSource) stay open for as long as a tab is open, so that handler ran for hours per tab — the paused-site
// incident of 2026-09-27. The proxy cuts a request that sends no bytes for `experimental.proxyTimeout` (next.config.js,
// 5 min) and passes request bodies up to `proxyClientMaxBodySize` (512 MB); live streams ping every ≤ 25 s, and
// EventSource reconnects by itself.
//
// Kept on the route handler, deliberately: `/backend/api/cx/…`, the channel-connect OAuth return, because the handler
// rewrites that cookie's `Path=/api/cx/callback` to the `/backend` path the browser sees. Rare and short.
//
// CommonJS so the CommonJS `next.config.js` can require it and a Vitest test can import it.

/** Where the API lives: the same resolution the route handler uses (`api-proxy.ts` + `getBackendUrl`). */
function apiTarget(env) {
  const raw = env.NEXUS_API_PROXY_TARGET || env.NEXT_PUBLIC_API_URL || 'https://nexusapi-production-b7bb.up.railway.app'
  const url = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`
  return url.replace(/\/+$/, '')
}

/**
 * The `beforeFiles` rewrites (they win over the route handler). Empty unless business profiles are on — without them the
 * browser calls the API directly and `/backend` is unused (the route handler answers 404, as before).
 */
function backendRewrites(env) {
  if (env.NEXT_PUBLIC_WORKSPACES_ENABLED !== '1') return []
  return [{ source: '/backend/api/:path((?!cx(?:/|$)).*)', destination: `${apiTarget(env)}/api/:path` }]
}

module.exports = { apiTarget, backendRewrites }
