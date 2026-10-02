/**
 * MCP full control L11 (decision d6) — the link rules of a photo fetched from the web (`fetchPhoto`), through the real
 * public-address fetch (`net/safe-fetch.ts`): https only, on every redirect hop too; no private or local hosts; a photo
 * only (the declared type AND the file's own first bytes); at most 15 MB.
 *
 * No real network: DNS answers and every page are planted below, and `http(s).get` is faked from them, logging what was
 * requested — so "refused" also means "nothing was requested from it". Every host is invented (example.test).
 */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({
  dns: new Map<string, string[]>(),
  pages: new Map<string, { status: number; headers?: Record<string, string>; body?: Buffer }>(),
  requested: [] as string[],
}))

function fakeGet(url: URL, options: { lookup?: (...args: any[]) => void }, callback: (response: any) => void) {
  const request = Object.assign(new EventEmitter(), { destroy(error?: Error) { if (error) queueMicrotask(() => request.emit('error', error)) } })
  options.lookup?.(url.hostname, {}, () => undefined)
  net.requested.push(url.toString())
  queueMicrotask(() => {
    const p = net.pages.get(url.toString()) ?? { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('not found') }
    callback(Object.assign(Readable.from(p.body ? [p.body] : []), { statusCode: p.status, headers: p.headers ?? {} }))
  })
  return request
}
vi.mock('node:dns/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:dns/promises')>()
  const lookup = async (hostname: string) => {
    const answers = net.dns.get(hostname) ?? (/^[\d.]+$|:/.test(hostname) ? [hostname] : undefined)
    if (!answers) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' })
    return answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
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

import { fetchPhoto, PhotoUrlError } from './photo-from-url.service.js'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)])
const refusal = async (link: string) => {
  const error = await fetchPhoto(link).then(() => null, (e: unknown) => e)
  expect(error).toBeInstanceOf(PhotoUrlError)
  return error as PhotoUrlError
}

beforeEach(() => {
  net.dns.clear(); net.pages.clear(); net.requested.length = 0
  net.dns.set('photos.example.test', ['93.184.216.34'])
  net.dns.set('cdn.example.test', ['93.184.216.35'])
  net.dns.set('intranet.example.test', ['10.0.0.5'])
})

describe('fetchPhoto — the link rules', () => {
  it('fetches a photo over https from a public host: type, size, content hash and host', async () => {
    net.pages.set('https://photos.example.test/jacket.png', { status: 200, headers: { 'content-type': 'image/png' }, body: PNG })
    const photo = await fetchPhoto('https://photos.example.test/jacket.png')
    expect(photo).toMatchObject({ mimeType: 'image/png', bytes: PNG.byteLength, host: 'photos.example.test', url: 'https://photos.example.test/jacket.png' })
    expect(photo.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses an http link, and requests nothing', async () => {
    net.pages.set('http://photos.example.test/jacket.png', { status: 200, headers: { 'content-type': 'image/png' }, body: PNG })
    expect((await refusal('http://photos.example.test/jacket.png')).message).toContain('https://')
    expect(net.requested).toEqual([])
  })

  it('refuses a redirect to an http address before requesting it', async () => {
    net.pages.set('https://photos.example.test/moved.png', { status: 302, headers: { location: 'http://cdn.example.test/jacket.png' } })
    net.pages.set('http://cdn.example.test/jacket.png', { status: 200, headers: { 'content-type': 'image/png' }, body: PNG })
    expect((await refusal('https://photos.example.test/moved.png')).statusCode).toBe(400)
    expect(net.requested).toEqual(['https://photos.example.test/moved.png'])
  })

  it('refuses a private or local host, and requests nothing', async () => {
    for (const link of ['https://intranet.example.test/a.png', 'https://127.0.0.1/a.png', 'https://169.254.169.254/latest/meta-data']) {
      expect((await refusal(link)).statusCode).toBe(400)
    }
    expect(net.requested).toEqual([])
  })

  it('refuses what is not a photo: another type, or bytes that are not the type they claim', async () => {
    net.pages.set('https://photos.example.test/page', { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html></html>') })
    net.pages.set('https://photos.example.test/fake.png', { status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from('<svg onload="x"></svg>') })
    net.pages.set('https://photos.example.test/a.svg', { status: 200, headers: { 'content-type': 'image/svg+xml' }, body: Buffer.from('<svg></svg>') })
    expect((await refusal('https://photos.example.test/page')).message).toContain('not a photo')
    expect((await refusal('https://photos.example.test/fake.png')).message).toContain('is not one')
    expect((await refusal('https://photos.example.test/a.svg')).message).toContain('not a photo')
  })

  it('refuses a file over the size cap (413) and says an error answer (502)', async () => {
    net.pages.set('https://photos.example.test/huge.png', { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(16 * 1024 * 1024) }, body: PNG })
    expect((await refusal('https://photos.example.test/huge.png')).statusCode).toBe(413)
    expect((await refusal('https://photos.example.test/missing.png')).statusCode).toBe(502)
  })
})
