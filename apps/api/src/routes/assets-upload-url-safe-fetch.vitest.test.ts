/**
 * MCP full control P2 (plan 09, finding 1) — "Add from link" in the asset library may only fetch PUBLIC addresses.
 *
 * `POST /api/assets/upload-url` fetched any http(s) address the caller typed and followed redirects, so anyone with
 * assets.manage could make the server read loopback, private-network or cloud-metadata addresses (SSRF). The route
 * now uses the shared safe fetcher (services/net/safe-fetch.ts): the host must RESOLVE to a public address, the
 * connection is pinned to that answer, only ports 80/443, and every redirect hop is checked the same way.
 *
 * No real network: DNS answers and every page are planted below. Both transports are faked from the same pages and
 * write the same log of what was requested — the platform `fetch` (what the route used before) and `http(s).get`
 * (what the safe fetcher uses) — so "nothing private was requested" means the same thing for either. Every host and
 * address is invented (example.test names; public-looking addresses only ever reach the fakes).
 */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({
  dns: new Map<string, string[]>(),
  pages: new Map<string, { status: number; headers?: Record<string, string>; body?: string }>(),
  requested: [] as Array<{ url: string; pinned?: string }>,
}))
const store = vi.hoisted(() => ({ upload: null as any, created: [] as any[] }))

function page(url: string) {
  return net.pages.get(url) ?? { status: 404, headers: { 'content-type': 'text/plain' }, body: 'not found' }
}

// The platform fetch the route used before the fix: it follows redirects, as `redirect: 'follow'` asked.
async function fakeFetch(input: string | URL): Promise<Response> {
  let url = new URL(String(input))
  for (let hop = 0; hop < 10; hop++) {
    net.requested.push({ url: url.toString() })
    const p = page(url.toString())
    if (p.status >= 300 && p.status < 400 && p.headers?.location) { url = new URL(p.headers.location, url); continue }
    return new Response(p.body ?? '', { status: p.status, headers: p.headers })
  }
  throw new Error('too many redirects')
}

// `http(s).get` as the safe fetcher calls it; the address it would connect to comes from its pinned `lookup`.
function fakeGet(url: URL, options: { lookup?: (...args: any[]) => void }, callback: (response: any) => void) {
  const request = Object.assign(new EventEmitter(), {
    destroy(error?: Error) { if (error) queueMicrotask(() => request.emit('error', error)) },
  })
  let pinned: string | undefined
  options.lookup?.(url.hostname, {}, (_error: unknown, address: string) => { pinned = address })
  net.requested.push({ url: url.toString(), pinned })
  queueMicrotask(() => {
    const p = page(url.toString())
    const response = Object.assign(Readable.from(p.body ? [Buffer.from(p.body)] : []), { statusCode: p.status, headers: p.headers ?? {} })
    callback(response)
  })
  return request
}

vi.mock('node:dns/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:dns/promises')>()
  const lookup = async (hostname: string) => {
    const answers = net.dns.get(hostname) ?? (/^[\d.]+$|:/.test(hostname) ? [hostname] : undefined)
    if (!answers) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' })
    return answers.map(address => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
  return { ...real, default: { ...real, lookup }, lookup }
})
vi.mock('node:http', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:http')>()
  return { ...real, default: { ...real, get: fakeGet }, get: fakeGet }
})
vi.mock('node:https', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:https')>()
  return { ...real, default: { ...real, get: fakeGet }, get: fakeGet }
})
vi.mock('../db.js', () => ({
  default: {
    digitalAsset: {
      findUnique: vi.fn(async () => null),
      aggregate: vi.fn(async () => ({ _sum: { sizeBytes: 0 } })),
      create: vi.fn(async ({ data }: any) => { store.created.push(data); return { id: 'asset-1', ...data } }),
    },
    assetFolder: { findUnique: vi.fn(async () => null) },
  },
}))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }),
    resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { get connection() { return null } },
  }
})
vi.mock('../services/cloudinary.service.js', () => ({
  isCloudinaryConfigured: () => true,
  uploadBufferToCloudinary: vi.fn(async (buffer: Buffer) => {
    store.upload = buffer
    return { url: 'https://cdn.storage.example.test/asset.jpg', publicId: 'asset', width: 1600, height: 1600, bytes: buffer.length, format: 'jpg' }
  }),
}))

import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { fetchCatalogSource } from '../services/pim/catalog-source-fetch.js'

const PUBLIC_IP = '93.184.216.34'
let app: FastifyInstance
const upload = (url: string) => app.inject({ method: 'POST', url: '/api/assets/upload-url', payload: { url } })

describe('POST /api/assets/upload-url fetches public addresses only', () => {
  beforeAll(async () => {
    vi.stubGlobal('fetch', fakeFetch)
    app = Fastify()
    app.addHook('preHandler', (_request, _reply, done) => {
      withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, done)
    })
    const { default: assetsRoutes } = await import('./assets.routes.js')
    await app.register(assetsRoutes, { prefix: '/api' })
    await app.ready()
  }, 120_000)
  afterAll(async () => { await app?.close(); vi.unstubAllGlobals() })
  beforeEach(() => {
    net.requested.length = 0
    store.upload = null
    store.created.length = 0
    net.dns.clear()
    net.pages.clear()
    net.dns.set('cdn.example.test', [PUBLIC_IP])
    net.dns.set('drive.example.test', [PUBLIC_IP])
    net.dns.set('localhost', ['127.0.0.1', '::1'])
    net.dns.set('intranet.example.test', ['192.168.1.20'])
    net.pages.set('https://cdn.example.test/photo.jpg', { status: 200, headers: { 'content-type': 'image/jpeg' }, body: 'JPEG' })
    for (const url of ['http://127.0.0.1/photo.jpg', 'http://localhost/photo.jpg', 'http://10.1.2.3/photo.jpg',
      'http://169.254.169.254/latest/meta-data/photo.jpg', 'http://intranet.example.test/photo.jpg', 'http://[::1]/photo.jpg',
      'http://cdn.example.test:8080/photo.jpg']) {
      net.pages.set(url, { status: 200, headers: { 'content-type': 'image/jpeg' }, body: 'SECRET' })
    }
  })

  it.each([
    ['a loopback address', 'http://127.0.0.1/photo.jpg'],
    ['localhost', 'http://localhost/photo.jpg'],
    ['an IPv6 loopback address', 'http://[::1]/photo.jpg'],
    ['a private-network address', 'http://10.1.2.3/photo.jpg'],
    ['the cloud metadata address', 'http://169.254.169.254/latest/meta-data/photo.jpg'],
    ['a name that resolves to a private address', 'http://intranet.example.test/photo.jpg'],
    ['a public name on a custom port', 'http://cdn.example.test:8080/photo.jpg'],
  ])('refuses %s and requests nothing', async (_label, url) => {
    const res = await upload(url)
    expect(res.statusCode, res.body).toBe(400)
    expect(net.requested).toEqual([])
    expect(store.upload).toBeNull()
  })

  it('refuses a public link that redirects to a private address, and never requests the private one', async () => {
    net.pages.set('https://cdn.example.test/moved.jpg', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/photo.jpg' } })
    const res = await upload('https://cdn.example.test/moved.jpg')
    expect(res.statusCode, res.body).toBe(400)
    expect(net.requested.map(r => r.url)).toEqual(['https://cdn.example.test/moved.jpg'])
    expect(store.upload).toBeNull()
  })

  it('fetches a public link, connects to the address it checked, and stores the file', async () => {
    const res = await upload('https://cdn.example.test/photo.jpg')
    expect(res.statusCode, res.body).toBe(201)
    expect(net.requested).toEqual([{ url: 'https://cdn.example.test/photo.jpg', pinned: PUBLIC_IP }])
    expect(String(store.upload)).toBe('JPEG')
    expect(store.created[0]).toMatchObject({ mimeType: 'image/jpeg', originalFilename: 'photo.jpg' })
  })

  it('still follows a public redirect to a public address (direct-download links)', async () => {
    net.pages.set('https://drive.example.test/uc?id=TEST-FILE-1', { status: 302, headers: { location: 'https://cdn.example.test/photo.jpg' } })
    const res = await upload('https://drive.example.test/uc?id=TEST-FILE-1')
    expect(res.statusCode, res.body).toBe(201)
    expect(net.requested.map(r => r.url)).toEqual(['https://drive.example.test/uc?id=TEST-FILE-1', 'https://cdn.example.test/photo.jpg'])
    expect(String(store.upload)).toBe('JPEG')
  })
})

describe('the catalog source fetch keeps its rules on the shared fetcher', () => {
  beforeEach(() => {
    net.requested.length = 0
    net.dns.clear()
    net.pages.clear()
    net.dns.set('supplier.example.test', [PUBLIC_IP])
  })

  it('fetches a public file, pinned to the checked address', async () => {
    net.pages.set('https://supplier.example.test/feed/catalog.csv', { status: 200, headers: { 'content-type': 'text/csv' }, body: 'sku,name' })
    const source = await fetchCatalogSource('https://supplier.example.test/feed/catalog.csv')
    expect({ text: String(source.buffer), filename: source.filename }).toEqual({ text: 'sku,name', filename: 'catalog.csv' })
    expect(net.requested).toEqual([{ url: 'https://supplier.example.test/feed/catalog.csv', pinned: PUBLIC_IP }])
  })

  it('still refuses every redirect, with the same message, and requests only the first address', async () => {
    net.pages.set('https://supplier.example.test/feed.csv', { status: 302, headers: { location: 'https://supplier.example.test/other.csv' } })
    await expect(fetchCatalogSource('https://supplier.example.test/feed.csv')).rejects.toThrow('Source returned HTTP 302; redirects are not followed')
    expect(net.requested.map(r => r.url)).toEqual(['https://supplier.example.test/feed.csv'])
  })

  it('still refuses private addresses and files over 10 MB', async () => {
    await expect(fetchCatalogSource('http://192.168.0.10/feed.csv')).rejects.toThrow('Source URL must resolve to a public internet address')
    net.pages.set('https://supplier.example.test/big.csv', { status: 200, headers: { 'content-length': String(11 * 1024 * 1024) }, body: 'x' })
    await expect(fetchCatalogSource('https://supplier.example.test/big.csv')).rejects.toThrow('Source exceeds 10 MB')
  })
})
