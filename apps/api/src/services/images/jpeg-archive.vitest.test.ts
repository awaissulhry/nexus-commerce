import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Images rebuild P4d — the shared JPEG ZIP engine (Amazon ZIP on the Media page, and the studio's safety export): its
 * limits and its all-or-nothing rule. Only the download is replaced; sharp and JSZip are real.
 */
const state = vi.hoisted(() => ({ fetched: [] as string[], slow: new Set<string>(), fail: new Set<string>() }))
vi.mock('../pim/catalog-source-fetch.js', () => ({
  fetchCatalogSource: async (url: string) => {
    state.fetched.push(url)
    if (state.fail.has(url)) throw new Error('Source URL must resolve to a public internet address')
    if (state.slow.has(url)) await new Promise(resolve => setTimeout(resolve, 5_000))
    const sharp = (await import('sharp')).default
    return { buffer: await sharp({ create: { width: 40, height: 30, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer() }
  },
}))

import JSZip from 'jszip'
import sharp from 'sharp'
import { buildJpegArchive } from './jpeg-archive.js'

const words = { tooLong: 'Too long.', tooBig: (mb: number) => `Over ${mb} MB.`, nothingSaved: 'Nothing saved.' }
const files = [
  { name: 'B0FXAAAAA1.MAIN.jpg', url: 'https://cdn.example/a.png', label: 'a (B0FXAAAAA1 MAIN)' },
  { name: 'B0FXAAAAA2.MAIN.jpg', url: 'https://cdn.example/a.png', label: 'a (B0FXAAAAA2 MAIN)' },
  { name: 'B0FXAAAAA1.PT01.jpg', url: 'https://cdn.example/b.png', label: 'b (B0FXAAAAA1 PT01)' },
]
beforeEach(() => { state.fetched.length = 0; state.slow.clear(); state.fail.clear() })

describe('JPEG ZIP engine (P4d)', () => {
  it('downloads each address once and writes every file as an upright JPEG on white', async () => {
    const zip = await JSZip.loadAsync(await buildJpegArchive(files, words))
    expect(Object.keys(zip.files)).toEqual(files.map(f => f.name))
    expect([...state.fetched].sort()).toEqual(['https://cdn.example/a.png', 'https://cdn.example/b.png'])
    const image = sharp(await zip.file('B0FXAAAAA1.MAIN.jpg')!.async('nodebuffer'))
    expect((await image.metadata()).format).toBe('jpeg')
    // The transparent source is flattened on white, as Amazon asks.
    expect((await image.stats()).channels.map(c => Math.round(c.mean))).toEqual([255, 255, 255])
  })
  it('one failed photo stops the whole ZIP and names it', async () => {
    state.fail.add('https://cdn.example/b.png')
    await expect(buildJpegArchive(files, words)).rejects.toMatchObject({ statusCode: 422, message: 'b (B0FXAAAAA1 PT01): Source URL must resolve to a public internet address. Nothing saved.' })
  })
  it('the deadline also stops a download in progress, so the server answers before a proxy gives up', async () => {
    state.slow.add('https://cdn.example/b.png')
    const started = Date.now()
    await expect(buildJpegArchive(files, words, { deadlineMs: 200 })).rejects.toMatchObject({ statusCode: 422, message: 'Too long.' })
    expect(Date.now() - started).toBeLessThan(2_000)
  })
  it('counts a photo once per file it fills, and stops past the size limit', async () => {
    const zip = await JSZip.loadAsync(await buildJpegArchive(files, words))
    // The ZIP's photo bytes: "a" fills two files, so it counts twice.
    const total = (await Promise.all(files.map(async f => (await zip.file(f.name)!.async('uint8array')).length))).reduce((a, b) => a + b, 0)
    await expect(buildJpegArchive(files, words, { maxBytes: total })).resolves.toBeInstanceOf(Buffer)
    await expect(buildJpegArchive(files, words, { maxBytes: total - 1 })).rejects.toMatchObject({ statusCode: 422, message: 'Over 0 MB.' })
  })
})
