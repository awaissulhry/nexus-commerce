import type { ServerResponse } from 'node:http'
import type { FastifyInstance } from 'fastify'
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
    // no-transform: the web's `next start` gzips proxied answers unless told not to, and a gzipped stream holds every
    // event back until the stream ends (measured 2026-09-29).
    'Cache-Control': 'no-cache, no-transform',
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

/**
 * End every open event stream when the server starts closing.
 *
 * An SSE handler never returns (it awaits a promise that never settles), so
 * `app.close()` waited on each open stream until the 30-second shutdown deadline,
 * then exited 1 without closing Redis or the database. Ending the stream closes it
 * cleanly; the browser's EventSource reconnects to a replica that is still serving.
 *
 * Streams are recognised by the request's `Accept: text/event-stream`, which every
 * EventSource sends; handlers write their headers straight to `reply.raw`.
 */
export function endEventStreamsOnClose(app: FastifyInstance): void {
  const open = new Set<ServerResponse>()
  app.addHook('onRequest', async (request, reply) => {
    if (!request.headers.accept?.includes('text/event-stream')) return
    const response = reply.raw
    open.add(response)
    response.once('close', () => open.delete(response))
  })
  app.addHook('preClose', async () => {
    for (const response of open) response.end()
  })
}
