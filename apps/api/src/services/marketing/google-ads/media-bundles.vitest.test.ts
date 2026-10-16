/**
 * Google Ads programme 2 G14b (2026-10-16) — an HTML5 ad's ZIP as Google's specification takes it (support.google.com/
 * google-ads/answer/1722096): one HTML document with its ad.size tag of a listed size, at most 40 files of the listed
 * types, at most 600 KB; the link fetched through the one public-address fetch only; the sizes of uploaded image ads.
 */
import { deflateRawSync } from 'node:zlib'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('../../net/safe-fetch.js', async (importActual) => ({
  ...(await importActual<typeof import('../../net/safe-fetch.js')>()),
  safeFetch: h.fetch,
}))

import { SafeFetchError } from '../../net/safe-fetch.js'
import { DISPLAY_AD_SIZES, displaySizeProblem, inspectHtml5Zip, prepareMediaBundle, zipEntries } from './media-bundles.js'

/** A ZIP of these files (deflated unless `stored`), as a ZIP writer makes it: local headers, central directory, end record. */
function zip(files: Array<[string, string]>, o: { stored?: boolean; encrypted?: boolean } = {}): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of files) {
    const raw = Buffer.from(text, 'utf8')
    const data = o.stored ? raw : deflateRawSync(raw)
    const n = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(o.encrypted ? 1 : 0, 6); local.writeUInt16LE(o.stored ? 0 : 8, 8)
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(o.encrypted ? 1 : 0, 8); central.writeUInt16LE(o.stored ? 0 : 8, 10)
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42)
    locals.push(local, n, data)
    centrals.push(central, n)
    offset += 30 + n.length + data.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}
const HTML = (size = 'width=300,height=250') => `<!DOCTYPE html><html><head><meta name="ad.size" content="${size}"></head><body><img src="a.png"></body></html>`

describe('inspectHtml5Zip', () => {
  it('a good ZIP: its one HTML document, its files and its ad size (deflated or stored)', () => {
    expect(inspectHtml5Zip(zip([['index.html', HTML()], ['a.png', 'x'], ['css/', ''], ['css/s.css', 'b{}']]))).toEqual({ files: 3, html: 'index.html', width: 300, height: 250 })
    expect(inspectHtml5Zip(zip([['ad.htm', HTML('width=728,height=90')]], { stored: true }))).toMatchObject({ width: 728, height: 90 })
    expect(zipEntries(zip([['index.html', HTML()]]))).toMatchObject([{ name: 'index.html', method: 8 }])
  })

  it('refuses what Google refuses, every problem at once', () => {
    const problems = (b: Buffer) => { const r = inspectHtml5Zip(b); return 'problems' in r ? r.problems.join(' | ') : 'not refused' }
    expect(problems(Buffer.from('not a zip at all, just text'))).toMatch(/not a ZIP file/)
    const two = problems(zip([['index.html', HTML()], ['b.html', HTML()], ['run.exe', 'x']]))
    expect(two).toMatch(/"run\.exe": Google takes HTML, CSS, JS, GIF, PNG, JPG, JPEG and SVG files only/)
    expect(two).toMatch(/2 HTML documents: Google takes ONE/)
    expect(problems(zip([['a.png', 'x']]))).toMatch(/no HTML document/)
    expect(problems(zip(Array.from({ length: 41 }, (_, i): [string, string] => [i ? `${i}.png` : 'index.html', i ? 'x' : HTML()])))).toMatch(/41 files: Google takes at most 40/)
    expect(problems(zip([['index.html', '<html><head></head></html>']]))).toMatch(/has no size tag/)
    expect(problems(zip([['index.html', HTML('width=301,height=250')]]))).toMatch(/301×250: Google takes uploaded display ads of 200×200/)
    expect(problems(zip([['index.html', HTML()]], { encrypted: true }))).toMatch(/encrypted/)
    expect(problems(Buffer.alloc(600 * 1024 + 1))).toMatch(/600 KB/)
  })

  it('the sizes of uploaded display ads (the main table and Poland\'s billboards)', () => {
    expect(DISPLAY_AD_SIZES).toContain('300x250')
    expect(DISPLAY_AD_SIZES).toContain('750x300')
    expect(displaySizeProblem('x', 300, 250)).toBeNull()
    expect(displaySizeProblem('x', 1200, 628)).toMatch(/1200×628: Google takes/)
    expect(displaySizeProblem('x', null, 250)).toMatch(/could not read/)
  })
})

describe('prepareMediaBundle', () => {
  beforeEach(() => h.fetch.mockReset())

  it('fetches only an https link, through the public-address fetch (600 KB cap, redirects checked), and gives the ZIP base64 with its fingerprint', async () => {
    const body = zip([['index.html', HTML()]])
    h.fetch.mockResolvedValue({ buffer: body, contentType: 'application/zip', url: new URL('https://cdn.example/ads/banner%20A.zip') })
    const got = await prepareMediaBundle('https://cdn.example/ads/banner%20A.zip')
    expect(h.fetch).toHaveBeenCalledWith('https://cdn.example/ads/banner%20A.zip', { maxBytes: 600 * 1024, timeoutMs: 15_000, maxRedirects: 3, httpsOnly: true })
    expect(got).toMatchObject({ label: 'banner A', bytes: body.length, files: 1, width: 300, height: 250, data: body.toString('base64') })
    expect((got as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(await prepareMediaBundle('http://cdn.example/a.zip')).toEqual({ problem: 'cdn.example: only an https:// link is fetched' })
    expect(h.fetch).toHaveBeenCalledTimes(1)
  })

  it('says why a link gives no ZIP: too large, refused, an HTTP error, a broken ZIP', async () => {
    h.fetch.mockRejectedValueOnce(new SafeFetchError('Source exceeds 1 MB', 'too_large'))
    expect(await prepareMediaBundle('https://cdn.example/a.zip')).toEqual({ problem: expect.stringMatching(/larger than 600 KB/) })
    h.fetch.mockRejectedValueOnce(new SafeFetchError('Source URL must resolve to a public internet address', 'refused'))
    expect(await prepareMediaBundle('https://intranet.example/a.zip')).toEqual({ problem: expect.stringMatching(/public internet address/) })
    h.fetch.mockRejectedValueOnce(new SafeFetchError('Source returned HTTP 404', 'status', 404))
    expect(await prepareMediaBundle('https://cdn.example/a.zip')).toEqual({ problem: expect.stringMatching(/HTTP 404/) })
    h.fetch.mockResolvedValueOnce({ buffer: Buffer.from('<html>'), contentType: 'text/html', url: new URL('https://cdn.example/a.zip') })
    expect(await prepareMediaBundle('https://cdn.example/a.zip')).toEqual({ problem: expect.stringMatching(/not a ZIP file/) })
  })
})
