/**
 * Google Ads changes, programme 2 G6 (2026-10-15) — an image for a Google Ads image asset (`prepareImage`), through the
 * real photo fetch (images/photo-from-url.service.ts → net/safe-fetch.ts): https only, public hosts only, a picture
 * only (declared type AND first bytes), then Google's own rules: JPG, PNG or GIF, at most 5120 KB; width and height read
 * from the file. A library image is read from this business's own rows.
 *
 * No real network: DNS answers and every page are planted below and `https.get` is faked from them, logging what was
 * requested — so "refused" also means "nothing was requested". Every host is invented (example.test).
 */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({
  dns: new Map<string, string[]>(),
  pages: new Map<string, { status: number; headers?: Record<string, string>; body?: Buffer }>(),
  requested: [] as string[],
  rows: { digitalAsset: null as null | { url: string; label: string | null }, productImage: null as null | { url: string; alt: string | null } },
  where: [] as unknown[],
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
vi.mock('../../../db.js', () => ({
  default: {
    digitalAsset: { findFirst: vi.fn(async (q: unknown) => { net.where.push(q); return net.rows.digitalAsset }) },
    productImage: { findFirst: vi.fn(async (q: unknown) => { net.where.push(q); return net.rows.productImage }) },
  },
}))

import { GOOGLE_IMAGE_MAX_BYTES, prepareImage } from './asset-images.js'

const picture = (width: number, height: number, format: 'png' | 'jpeg' | 'webp') =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } } })[format]().toBuffer()
const page = (body: Buffer, type: string) => ({ status: 200, headers: { 'content-type': type }, body })

beforeEach(() => {
  net.dns.clear(); net.pages.clear(); net.requested.length = 0; net.where.length = 0
  net.rows.digitalAsset = null; net.rows.productImage = null
  net.dns.set('cdn.example.test', ['93.184.216.34'])
  net.dns.set('intranet.example.test', ['10.0.0.5'])
})

describe('prepareImage — an image Google Ads can take', () => {
  it('an https PNG from a public host: its bytes base64, size read from the file, fingerprint, a name from the file', async () => {
    const png = await picture(1200, 628, 'png')
    net.pages.set('https://cdn.example.test/img/winter-jacket.png', page(png, 'image/png'))
    const got = await prepareImage({ imageUrl: 'https://cdn.example.test/img/winter-jacket.png' })
    expect(got).toMatchObject({ source: 'https://cdn.example.test/img/winter-jacket.png', label: 'winter-jacket', mimeType: 'image/png', bytes: png.byteLength, width: 1200, height: 628 })
    if ('problem' in got) throw new Error(got.problem)
    expect(Buffer.from(got.data, 'base64').equals(png)).toBe(true)
    expect(got.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('an http link, a private host, a page that is not a picture: refused, and nothing is requested from a refused host', async () => {
    const png = await picture(300, 300, 'png')
    net.pages.set('http://cdn.example.test/a.png', page(png, 'image/png'))
    expect(await prepareImage({ imageUrl: 'http://cdn.example.test/a.png' })).toEqual({ problem: expect.stringContaining('https://') })
    expect(await prepareImage({ imageUrl: 'https://intranet.example.test/a.png' })).toEqual({ problem: expect.stringMatching(/^the link: /) })
    expect(await prepareImage({ imageUrl: 'https://127.0.0.1/a.png' })).toEqual({ problem: expect.stringMatching(/^the link: /) })
    expect(net.requested).toEqual([])
    net.pages.set('https://cdn.example.test/page', page(Buffer.from('<html></html>'), 'text/html'))
    expect(await prepareImage({ imageUrl: 'https://cdn.example.test/page' })).toEqual({ problem: expect.stringContaining('not a photo') })
  })

  it('Google\'s file rules: WebP is refused; more than 5120 KB is refused', async () => {
    net.pages.set('https://cdn.example.test/a.webp', page(await picture(300, 300, 'webp'), 'image/webp'))
    expect(await prepareImage({ imageUrl: 'https://cdn.example.test/a.webp' })).toEqual({ problem: 'https://cdn.example.test/a.webp is image/webp: Google takes JPG, PNG or GIF images' })
    const big = Buffer.concat([await picture(300, 300, 'png'), Buffer.alloc(GOOGLE_IMAGE_MAX_BYTES, 1)])
    net.pages.set('https://cdn.example.test/big.png', page(big, 'image/png'))
    expect(await prepareImage({ imageUrl: 'https://cdn.example.test/big.png' })).toEqual({ problem: expect.stringMatching(/KB: Google takes at most 5120 KB$/) })
  })

  it('a library image: this business\'s row (da_ a library file, pi_ a product photo), fetched by the same rules', async () => {
    const jpg = await picture(1200, 1200, 'jpeg')
    net.pages.set('https://cdn.example.test/lib/1.jpg', page(jpg, 'image/jpeg'))
    net.rows.digitalAsset = { url: 'https://cdn.example.test/lib/1.jpg', label: 'Logo square' }
    expect(await prepareImage({ libraryImageId: 'da_abc' })).toMatchObject({ source: 'da_abc', label: 'Logo square', mimeType: 'image/jpeg', width: 1200, height: 1200 })
    expect(net.where[0]).toEqual({ where: { id: 'abc', type: 'image' }, select: { url: true, label: true } })
    net.rows.productImage = { url: 'https://cdn.example.test/lib/1.jpg', alt: null }
    expect(await prepareImage({ libraryImageId: 'pi_p1' })).toMatchObject({ source: 'pi_p1', label: '1' })
    net.rows.digitalAsset = null
    expect(await prepareImage({ libraryImageId: 'da_gone' })).toEqual({ problem: expect.stringContaining('is not an image of this business\'s image library') })
    expect(await prepareImage({ libraryImageId: 'zz_1' })).toEqual({ problem: expect.stringContaining('is not an image-library id') })
  })

  it('one source: an image link or a library id, not both, not neither', async () => {
    expect(await prepareImage({})).toEqual({ problem: 'give imageUrl or libraryImageId (one of them)' })
    expect(await prepareImage({ imageUrl: 'https://cdn.example.test/a.png', libraryImageId: 'da_1' })).toEqual({ problem: 'give imageUrl or libraryImageId (one of them)' })
    expect(net.requested).toEqual([])
  })
})
