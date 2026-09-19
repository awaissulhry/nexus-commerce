/**
 * P0.3 (docs/channel-connections/FINAL-PLAN.md, S14) — the operator-webhook sender refuses every
 * non-public destination, checks the address it really connects to, follows no redirect and caps
 * what it reads and stores.
 *
 * One real local HTTP server receives every positive control. Each refusal is proven twice: the
 * sender says why, AND the server counted 0 requests (the same server that counts 1 on the control).
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { lookup as dnsLookup } from 'node:dns'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  WEBHOOK_ERROR_MAX_CHARS,
  capWebhookError,
  deliverWebhook,
  guardedLookup,
  isPublicAddress,
  webhookUrlProblem,
} from './outbound-webhook.js'

const hits: Array<{ path: string; signature: string | undefined; body: string }> = []
let server: Server
let port = 0

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = ''
    request.on('data', (c) => { body += c })
    request.on('end', () => {
      hits.push({ path: request.url ?? '', signature: request.headers['x-nexus-signature'] as string | undefined, body })
      if (request.url === '/ok') { response.writeHead(200).end('fine'); return }
      if (request.url === '/redirect') {
        response.writeHead(302, { Location: `http://hooks.example.test:${port}/second` }).end(); return
      }
      if (request.url === '/big') { response.writeHead(500).end('x'.repeat(1_000_000)); return }
      if (request.url === '/slow') return // never answers
      response.writeHead(404).end('nope')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)) })
beforeEach(() => { hits.length = 0 })

/** A resolver that answers every name with the given addresses (stands in for DNS). */
const resolvesTo = (...addresses: string[]): typeof dnsLookup =>
  ((_host: string, _options: unknown, callback: (e: null, a: Array<{ address: string; family: number }>) => void) =>
    callback(null, addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })))) as never

/** The test seam that lets the positive control reach 127.0.0.1 over http. */
const controlTransport = { resolve: resolvesTo('127.0.0.1'), isAllowed: () => true, allowHttp: true }
const send = (url: string, options = {}) =>
  deliverWebhook({ url, body: '{"event":"TEST"}', headers: { 'Content-Type': 'application/json', 'X-Nexus-Signature': 'sha256=abc' } }, options)

describe('P0.3 — which addresses are public', () => {
  it.each([
    '127.0.0.1', '127.9.9.9', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '64:ff9b::a00:1', 'fd00::1', 'fc00::1',
    'fe80::1', 'ff02::1', '2002:7f00:1::1', '2001:db8::1', 'not-an-ip', '',
  ])('%s is NOT public', (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })
  it.each(['8.8.8.8', '93.184.216.34', '1.1.1.1', '::ffff:8.8.8.8', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e'])(
    '%s is public (positive control)', (address) => {
      expect(isPublicAddress(address)).toBe(true)
    })
})

describe('P0.3 — which URLs may receive a webhook', () => {
  it.each([
    ['http://hooks.example.com/x', 'HTTPS'],
    ['ftp://hooks.example.com/x', 'HTTPS'],
    ['not a url', 'valid'],
    ['https://user:pw@hooks.example.com/x', 'user name'],
    ['https://localhost/x', 'public'],
    ['https://LOCALHOST./x', 'public'],
    ['https://api.localhost/x', 'public'],
    ['https://printer.local/x', 'public'],
    ['https://postgres.railway.internal/x', 'public'],
    ['https://router.home.arpa/x', 'public'],
    ['https://redis:6379/x', 'public'],
    ['https://127.0.0.1/x', 'public'],
    ['https://2130706433/x', 'public'], // 127.0.0.1 written as one number
    ['https://0x7f.0.0.1/x', 'public'], // 127.0.0.1 in hex
    ['https://[::1]/x', 'public'],
    ['https://[::ffff:127.0.0.1]/x', 'public'],
    ['https://10.1.2.3/x', 'public'],
    ['https://169.254.169.254/latest/meta-data', 'public'],
  ])('%s is refused', (url, why) => {
    expect(webhookUrlProblem(url)).toMatch(new RegExp(why, 'i'))
  })
  it.each(['https://hooks.example.com/nexus', 'https://93.184.216.34/hook', 'https://[2606:4700:4700::1111]/h'])(
    '%s is accepted (positive control)', (url) => {
      expect(webhookUrlProblem(url)).toBeNull()
    })
})

describe('P0.3 — the connect-time lookup', () => {
  const run = (addresses: string[], all: boolean) => new Promise<{ error: NodeJS.ErrnoException | null; answer: unknown }>(
    (resolve) => guardedLookup({ resolve: resolvesTo(...addresses) })('hooks.example.test', { all }, (error, answer) => resolve({ error, answer })),
  )
  it('refuses a name that resolves to a private address', async () => {
    expect((await run(['10.0.0.5'], false)).error?.code).toBe('EWEBHOOK_PRIVATE_ADDRESS')
  })
  it('refuses when ANY answer is private, not only the first', async () => {
    expect((await run(['93.184.216.34', '127.0.0.1'], true)).error?.code).toBe('EWEBHOOK_PRIVATE_ADDRESS')
  })
  it('passes public answers through in both shapes (positive control)', async () => {
    expect(await run(['93.184.216.34'], false)).toEqual({ error: null, answer: '93.184.216.34' })
    expect((await run(['93.184.216.34', '8.8.8.8'], true)).answer).toHaveLength(2)
  })
})

describe('P0.3 — delivery', () => {
  it('positive control: the local server receives the body and the signature', async () => {
    const result = await send(`http://hooks.example.test:${port}/ok`, controlTransport)
    expect(result).toMatchObject({ ok: true, status: 200, error: null })
    expect(hits).toEqual([{ path: '/ok', signature: 'sha256=abc', body: '{"event":"TEST"}' }])
  })
  it('a test fire to 127.0.0.1 is refused and the server gets 0 requests', async () => {
    for (const url of [`https://127.0.0.1:${port}/ok`, `http://127.0.0.1:${port}/ok`, `https://localhost:${port}/ok`, `https://[::1]:${port}/ok`]) {
      const result = await send(url)
      expect(result.ok, url).toBe(false)
      expect(result.status, url).toBe(0)
    }
    expect(hits).toHaveLength(0)
  })
  it('a public-looking name that resolves to 127.0.0.1 is refused at connect time (DNS rebinding)', async () => {
    // Same URL shape as the positive control; only the address check is the real one.
    const result = await send(`https://hooks.example.test:${port}/ok`, { resolve: resolvesTo('127.0.0.1') })
    expect(result).toMatchObject({ ok: false, status: 0 })
    expect(result.error).toMatch(/public internet address/)
    expect(hits).toHaveLength(0)
  })
  it('does not follow a redirect', async () => {
    const result = await send(`http://hooks.example.test:${port}/redirect`, controlTransport)
    expect(result).toMatchObject({ ok: false, status: 302 })
    expect(result.error).toMatch(/Redirects are not followed/)
    expect(hits.map((h) => h.path)).toEqual(['/redirect'])
  })
  it('reads at most 1 KB of a reply and keeps at most 500 characters', async () => {
    const result = await send(`http://hooks.example.test:${port}/big`, controlTransport)
    expect(result).toMatchObject({ ok: false, status: 500 })
    expect(result.error!.length).toBeLessThanOrEqual(WEBHOOK_ERROR_MAX_CHARS)
  })
  it('gives up after the deadline', async () => {
    const result = await send(`http://hooks.example.test:${port}/slow`, { ...controlTransport, timeoutMs: 300 })
    expect(result).toMatchObject({ ok: false, status: 0 })
    expect(result.error).toMatch(/No answer within/)
  })
  it('caps any stored error text', () => {
    expect(capWebhookError('y'.repeat(10_000))!.length).toBe(WEBHOOK_ERROR_MAX_CHARS)
    expect(capWebhookError('short')).toBe('short')
    expect(capWebhookError(null)).toBeNull()
  })
})
