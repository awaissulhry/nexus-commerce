import { resolveAllowedOrigin } from './cors-origins.js'

// Header set for an SSE response. SSE handlers write headers straight to
// reply.raw, so @fastify/cors never runs for them — without an explicit
// Access-Control-Allow-Origin the browser blocks the cross-origin
// EventSource (web on Vercel → API on Railway). This rebuilds the CORS
// headers the cors plugin would have added, validated against the same
// allow-list, plus the standard event-stream headers.
export function sseResponseHeaders(
  originHeader: string | undefined,
  overrides?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // Proxies must not buffer the stream (Cloudflare honours this;
    // Railway's Envoy passes it through).
    'X-Accel-Buffering': 'no',
    ...overrides,
  }
  const allowed = resolveAllowedOrigin(originHeader)
  if (allowed) {
    headers['Access-Control-Allow-Origin'] = allowed
    headers['Access-Control-Allow-Credentials'] = 'true'
    headers['Vary'] = 'Origin'
  }
  return headers
}
