/**
 * Development-only OAuth return relay. Tunnel this port, never the whole API.
 * Etsy returns to HTTPS; this sends the browser back to localhost, where the
 * API verifies its existing nonce cookie and single-use PKCE session.
 * No credentials, requests, or callback query strings are logged or persisted.
 *
 * node scripts/etsy-local-callback.mjs
 * ngrok http http://127.0.0.1:8093 --inspect=false
 */
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

const CALLBACK_PATH = '/api/cx/callback/etsy'
const CALLBACK_FIELDS = new Set(['state', 'code', 'error', 'error_description', 'error_uri'])

export function createEtsyLocalCallbackServer(apiOrigin = 'http://localhost:8091') {
  const origin = new URL(apiOrigin)
  if (!['http:', 'https:'].includes(origin.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
    || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('The Etsy development callback destination must be a loopback API origin.')
  }
  return createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Content-Type', 'text/plain; charset=utf-8')
    const raw = request.url ?? ''
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' }).end('Method not allowed.')
      return
    }
    if (!raw.startsWith(`${CALLBACK_PATH}?`)) {
      response.writeHead(404).end('Not found.')
      return
    }
    const source = new URL(raw, 'http://localhost')
    const query = source.searchParams
    const fields = [...query.keys()]
    if (fields.some(field => !CALLBACK_FIELDS.has(field) || query.getAll(field).length !== 1)
      || !/^[A-Za-z0-9_-]{43}$/.test(query.get('state') ?? '')
      || Boolean(query.get('code')) === Boolean(query.get('error'))) {
      response.writeHead(400).end('Invalid Etsy callback. Start sign-in from local Nexus.')
      return
    }
    const destination = new URL(CALLBACK_PATH, origin)
    destination.search = query.toString()
    response.writeHead(302, { Location: destination.href }).end('Returning to local Nexus.')
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createEtsyLocalCallbackServer(process.env.NEXUS_ETSY_LOCAL_API_ORIGIN)
  server.listen(8093, '127.0.0.1', () => {
    console.log(`Etsy callback relay listening on http://127.0.0.1:8093${CALLBACK_PATH}`)
  })
}
