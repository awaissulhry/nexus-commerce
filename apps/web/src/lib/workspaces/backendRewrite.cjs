// The browser's API calls (`<origin>/backend/api/…`) as a Vercel EXTERNAL REWRITE — a plain reverse proxy that runs no
// function (2026-09-27).
//
// Why: they used to go through the `/backend/[...path]` route handler, a Node function that stays alive for the whole
// request. Live-update streams (EventSource) stay open for as long as a tab is open, so that function ran for hours;
// the Hobby team used 331% of its "Fluid Provisioned Memory" (360 GB-hours) and Vercel paused the site. A rewrite to an
// external origin is proxied by Vercel's network (no function, no provisioned memory); Vercel cuts a proxied request
// after 120 s, and EventSource reconnects by itself.
//
// Kept on the function, deliberately: `/backend/api/cx/…`, the channel-connect OAuth return, because the function
// rewrites that cookie's `Path=/api/cx/callback` to the `/backend` path the browser sees. Rare and short.
//
// CommonJS so the CommonJS `next.config.js` can require it and a Vitest test can import it.

/** Where the API lives: the same resolution the function proxy uses (`api-proxy.ts` + `getBackendUrl`). */
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

/** Upstream caching stays off for API answers, whatever the project's rewrite-caching default is. */
function backendHeaders(env) {
  if (env.NEXT_PUBLIC_WORKSPACES_ENABLED !== '1') return []
  return [{ source: '/backend/api/:path*', headers: [{ key: 'x-vercel-enable-rewrite-caching', value: '0' }] }]
}

module.exports = { apiTarget, backendRewrites, backendHeaders }
