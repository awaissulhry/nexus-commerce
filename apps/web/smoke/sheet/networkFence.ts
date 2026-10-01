import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import type { BrowserContext } from '@playwright/test'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
const local = (raw: string) => {
  const url = new URL(raw)
  return ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && LOOPBACK.has(url.hostname)
}

/** Keep evidence without URL credentials, queries, fragments or request bodies. */
function refusal(method: string, raw: string): string {
  try {
    const url = new URL(method === 'CONNECT' ? `https://${raw}` : raw)
    return `${method} ${url.origin}${url.pathname}`
  } catch { return `${method} [invalid URL]` }
}

/** Install before creating a page. Context options must also block service workers. */
export async function installSheetNetworkFence(
  context: Pick<BrowserContext, 'route' | 'routeWebSocket'>,
  blocked: string[] = [],
) {
  await context.route('**/*', async route => {
    const request = route.request()
    if (local(request.url())) return route.fallback()
    blocked.push(refusal(request.method(), request.url()))
    await route.abort('blockedbyclient')
  })
  await context.routeWebSocket('**/*', async socket => {
    if (local(socket.url())) { socket.connectToServer(); return }
    blocked.push(refusal('WEBSOCKET', socket.url()))
    await socket.close({ code: 1008, reason: 'Local sheet checks only' })
  })
  return { blocked }
}

/**
 * Chromium routes do not see redirected URLs; page-level continue also bypasses context handlers.
 * This local proxy refuses everything it receives. It has no forwarding connector.
 * Exact loopback bypasses keep the normal local web/API connection and response bytes unchanged.
 * This covers the tested HTTP(S)/WebSocket paths, not a host firewall.
 */
export async function startSheetDenyProxy() {
  const blocked: string[] = []
  const sockets = new Set<Socket>()
  const server = createServer((request, response) => {
    blocked.push(refusal(request.method ?? 'HTTP', request.url ?? ''))
    response.writeHead(403, { 'content-length': '0', connection: 'close' })
    response.end()
  })
  server.on('connect', (request, socket) => {
    blocked.push(refusal('CONNECT', request.url ?? ''))
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a loopback proxy port')
  let closing: Promise<void> | undefined
  return {
    blocked,
    proxy: { server: `http://127.0.0.1:${address.port}`, bypass: 'localhost,127.0.0.1,[::1]' },
    close: () => closing ??= new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      for (const socket of sockets) socket.destroy()
    }),
  }
}
