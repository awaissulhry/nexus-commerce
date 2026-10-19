/**
 * Amazon A+ content (2026-10-19) — the new photos of an A+ document: the crop math, what is refused in words (too small,
 * not JPEG or PNG, over 5 MB, a crop outside the photo or in the wrong shape), the upload only in live publish mode,
 * the storage POST (contentMD5, the URL's query as form fields in order, the file last, origin + path, no redirects),
 * a photo that changed since it was approved, and the finished document. The photo fetch, the database, the gateway
 * and the storage POST are mocked (sharp makes the photos): nothing leaves the machine.
 */
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: { digitalAsset: { findFirst: vi.fn() }, productImage: { findFirst: vi.fn() }, marketplace: { findFirst: vi.fn() } } }))
vi.mock('../images/photo-from-url.service.js', () => ({ fetchPhoto: vi.fn() }))
vi.mock('../amazon-publish-gate.service.js')
vi.mock('../../lib/amazon-sp-client.js')
vi.mock('../gateway/amazon-sdk.js', () => ({ amazonSellerFetch: vi.fn() }))

import prisma from '../../db.js'
import { fetchPhoto } from '../images/photo-from-url.service.js'
import { getAmazonPublishMode } from '../amazon-publish-gate.service.js'
import { amazonSellerFetch } from '../gateway/amazon-sdk.js'
import { AplusError } from './aplus-client.js'
import { checkAplusDocument, payloadKeyOf, type ImageUse } from './aplus-modules.js'
import {
  APLUS_IMAGE_MAX_BYTES, APLUS_MAX_NEW_IMAGES, AplusImageError, computeCrop, finalizeAplusDocument, imagesPreview,
  inspectAplusImages, planHashOf, uploadAplusImages, type InspectedImage,
} from './aplus-images.js'

const T = { accountId: 'acct-1', marketplaceId: 'APJ6JRA9NG5V4' }
const MB = 1024 * 1024
const photos = new Map<string, { buffer: Buffer; mimeType: string; unbounded?: boolean }>()
const sha256 = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex')
const make = (width: number, height: number, format: 'jpeg' | 'png' | 'webp') =>
  sharp({ create: { width, height, channels: 3, background: { r: 180, g: 40, b: 40 } } })[format]().toBuffer()

let JPEG_1600x1200: Buffer
let PNG_2000x1200: Buffer
let JPEG_800x500: Buffer
let WEBP_1600x1200: Buffer

beforeAll(async () => {
  ;[JPEG_1600x1200, PNG_2000x1200, JPEG_800x500, WEBP_1600x1200] = await Promise.all([make(1600, 1200, 'jpeg'), make(2000, 1200, 'png'), make(800, 500, 'jpeg'), make(1600, 1200, 'webp')])
})

const fetchPhotoMock = vi.mocked(fetchPhoto)
const gatewayMock = vi.mocked(amazonSellerFetch)
const findAsset = prisma.digitalAsset.findFirst as unknown as ReturnType<typeof vi.fn>
const findProductImage = prisma.productImage.findFirst as unknown as ReturnType<typeof vi.fn>
const UPLOAD_URL = 'https://aplus-media.s3.amazonaws.com/?x-amz-date=20261019T060000Z&x-amz-signature=SIGNATURE&key=sc%2Fphoto.jpg&acl=private&policy=POLICY'

beforeEach(() => {
  photos.clear()
  fetchPhotoMock.mockReset()
  // As the real fetchPhoto: the declared type, the byte cap of the caller, the sha256.
  fetchPhotoMock.mockImplementation(async (link: string, maxBytes?: number) => {
    const photo = photos.get(link)
    if (!photo) throw Object.assign(new Error('The link answered HTTP 404.'), { name: 'PhotoUrlError' })
    if (!photo.unbounded && maxBytes !== undefined && photo.buffer.byteLength > maxBytes) throw Object.assign(new Error(`The photo is larger than ${maxBytes / MB} MB.`), { name: 'PhotoUrlError' })
    return { buffer: photo.buffer, mimeType: photo.mimeType, bytes: photo.buffer.byteLength, contentHash: sha256(photo.buffer), host: new URL(link).hostname, url: link }
  })
  findAsset.mockReset()
  findProductImage.mockReset()
  gatewayMock.mockReset()
  gatewayMock.mockImplementation(async () => new Response(JSON.stringify({ payload: { uploadDestinationId: `aplus-media/sc/${gatewayMock.mock.calls.length}.jpg`, url: UPLOAD_URL, headers: { 'Content-Type': 'image/jpeg', 'x-amz-meta-owner': 'OWNER' } } }), { status: 201 }))
  vi.mocked(getAmazonPublishMode).mockReset()
  vi.mocked(getAmazonPublishMode).mockReturnValue('live')
})
afterEach(() => vi.unstubAllGlobals())

const use = (over: Partial<ImageUse> & Pick<ImageUse, 'source'>): ImageUse => ({
  key: `${over.module ?? 0}:${over.path ?? 'image'}`, module: 0, path: 'image', slot: { minWidth: 800, minHeight: 600 }, altText: 'A photo', crop: null, ...over,
})
const link = (name: string) => `https://photos.example.test/${name}`

describe('computeCrop', () => {
  it('is the largest centred crop in the slot\'s shape, in whole pixels, never below the slot', () => {
    expect(computeCrop(1600, 1200, { minWidth: 800, minHeight: 600 })).toEqual({ width: 1600, height: 1200, x: 0, y: 0 })
    expect(computeCrop(2000, 1200, { minWidth: 800, minHeight: 600 })).toEqual({ width: 1600, height: 1200, x: 200, y: 0 })
    expect(computeCrop(1464, 1000, { minWidth: 1464, minHeight: 600 })).toEqual({ width: 1464, height: 600, x: 0, y: 200 })
    expect(computeCrop(970, 600, { minWidth: 970, minHeight: 600 })).toEqual({ width: 970, height: 600, x: 0, y: 0 })
    expect(computeCrop(1001, 333, { minWidth: 300, minHeight: 100 })).toEqual({ width: 999, height: 333, x: 1, y: 0 })
    expect(computeCrop(799, 2000, { minWidth: 800, minHeight: 600 })).toBeNull()
    expect(computeCrop(4000, 599, { minWidth: 800, minHeight: 600 })).toBeNull()
  })
})

describe('inspectAplusImages', () => {
  it('reads a library item, a product photo and a link, each once; measures them and crops them to the slot', async () => {
    findAsset.mockResolvedValue({ url: link('library.jpg'), type: 'image' })
    findProductImage.mockResolvedValue({ url: link('product.png') })
    photos.set(link('library.jpg'), { buffer: JPEG_1600x1200, mimeType: 'image/jpeg' })
    photos.set(link('product.png'), { buffer: PNG_2000x1200, mimeType: 'image/png' })
    photos.set(link('direct.jpg'), { buffer: JPEG_1600x1200, mimeType: 'image/jpeg' })
    const uses = [
      use({ source: { kind: 'asset', assetId: 'da_lib1' } }),
      use({ module: 1, path: 'columns[0].imageColumn.image', slot: { minWidth: 300, minHeight: 225 }, source: { kind: 'asset', assetId: 'da_lib1' } }),
      use({ module: 2, path: 'desktopImage', slot: { minWidth: 1464, minHeight: 600 }, source: { kind: 'asset', assetId: 'pi_prod1' } }),
      use({ module: 2, path: 'mobileImage', slot: { minWidth: 600, minHeight: 450 }, source: { kind: 'url', url: link('direct.jpg') } }),
      use({ module: 3, path: 'image', source: { kind: 'amazon', uploadDestinationId: 'aplus-media/old.png' }, crop: { width: 800, height: 600, x: 0, y: 0 } }),
    ]
    const { images, problems } = await inspectAplusImages(uses)
    expect(problems).toEqual([])
    expect(fetchPhotoMock.mock.calls).toEqual([[link('library.jpg'), APLUS_IMAGE_MAX_BYTES], [link('product.png'), APLUS_IMAGE_MAX_BYTES], [link('direct.jpg'), APLUS_IMAGE_MAX_BYTES]])
    expect(findAsset).toHaveBeenCalledWith({ where: { id: 'lib1' }, select: { url: true, type: true } })
    expect(findProductImage).toHaveBeenCalledWith({ where: { id: 'prod1', product: { deletedAt: null } }, select: { url: true } })
    expect(images.map((i) => [i.key, i.mimeType, i.width, i.height, i.crop])).toEqual([
      ['0:image', 'image/jpeg', 1600, 1200, { width: 1600, height: 1200, x: 0, y: 0 }],
      ['1:columns[0].imageColumn.image', 'image/jpeg', 1600, 1200, { width: 1600, height: 1200, x: 0, y: 0 }],
      ['2:desktopImage', 'image/png', 2000, 1200, { width: 2000, height: 819, x: 0, y: 190 }],
      ['2:mobileImage', 'image/jpeg', 1600, 1200, { width: 1600, height: 1200, x: 0, y: 0 }],
    ])
    expect(images[0]).toEqual({
      key: '0:image', source: { kind: 'asset', assetId: 'da_lib1' }, label: 'Module 1 image', mimeType: 'image/jpeg', bytes: JPEG_1600x1200.byteLength,
      width: 1600, height: 1200, contentHash: sha256(JPEG_1600x1200), crop: { width: 1600, height: 1200, x: 0, y: 0 }, warning: null,
    })
  })

  it('refuses in words: too small, WebP, over 5 MB, a missing photo, a library item that is not a photo', async () => {
    photos.set(link('small.jpg'), { buffer: JPEG_800x500, mimeType: 'image/jpeg' })
    photos.set(link('photo.webp'), { buffer: WEBP_1600x1200, mimeType: 'image/webp' })
    photos.set(link('huge.png'), { buffer: Buffer.concat([PNG_2000x1200, Buffer.alloc(6 * MB)]), mimeType: 'image/png' })
    photos.set(link('huge-unbounded.png'), { buffer: Buffer.concat([PNG_2000x1200, Buffer.alloc(6 * MB)]), mimeType: 'image/png', unbounded: true })
    findAsset.mockImplementation(async ({ where }: { where: { id: string } }) => (where.id === 'clip' ? { url: link('clip.mp4'), type: 'video' } : null))
    const { images, problems } = await inspectAplusImages([
      use({ path: 'block.image', slot: { minWidth: 970, minHeight: 600 }, source: { kind: 'url', url: link('small.jpg') } }),
      use({ module: 1, source: { kind: 'url', url: link('photo.webp') } }),
      use({ module: 2, source: { kind: 'url', url: link('huge.png') } }),
      use({ module: 3, source: { kind: 'url', url: link('huge-unbounded.png') } }),
      use({ module: 4, source: { kind: 'url', url: link('gone.jpg') } }),
      use({ module: 5, source: { kind: 'asset', assetId: 'da_clip' } }),
      use({ module: 6, source: { kind: 'asset', assetId: 'da_missing' } }),
    ])
    expect(images).toEqual([])
    expect(problems).toEqual([
      'Module 1 block.image: the photo is 800×500; Amazon needs at least 970×600.',
      'Module 2 image: the photo is a WebP; Amazon A+ takes JPEG or PNG only.',
      'Module 3 image: the photo is larger than 5 MB.',
      `Module 4 image: the photo is ${((PNG_2000x1200.byteLength + 6 * MB) / MB).toFixed(1)} MB; Amazon A+ takes at most 5.0 MB.`,
      'Module 5 image: the link answered HTTP 404.',
      'Module 6 image: library item da_clip is a video, not a photo.',
      'Module 7 image: there is no library item da_missing in this business (image-library lists them).',
    ])
  })

  it('a given crop must lie inside the photo, reach the slot and keep its shape; over 2 MB is a warning', async () => {
    photos.set(link('a.jpg'), { buffer: JPEG_1600x1200, mimeType: 'image/jpeg' })
    photos.set(link('big.jpg'), { buffer: Buffer.concat([JPEG_1600x1200, Buffer.alloc(3 * MB)]), mimeType: 'image/jpeg' })
    const source = { kind: 'url' as const, url: link('a.jpg') }
    const { images, problems } = await inspectAplusImages([
      use({ source, crop: { width: 1200, height: 900, x: 100, y: 50 } }),
      use({ module: 1, source, crop: { width: 1200, height: 900, x: 500, y: 0 } }),
      use({ module: 2, source, crop: { width: 640, height: 480, x: 0, y: 0 } }),
      use({ module: 3, source, crop: { width: 1200, height: 800, x: 0, y: 0 } }),
      use({ module: 4, source: { kind: 'url', url: link('big.jpg') } }),
    ])
    expect(problems).toEqual([
      'Module 2 image: the crop 1200×900 at 500,0 reaches outside the photo (1600×1200).',
      'Module 3 image: the crop is 640×480; Amazon needs at least 800×600.',
      'Module 4 image: the crop 1200×800 is not the shape Amazon needs here (800:600); leave imageCropSpecification out and Nexus crops it.',
    ])
    expect(images.map((i) => [i.key, i.crop, i.warning])).toEqual([
      ['0:image', { width: 1200, height: 900, x: 100, y: 50 }, null],
      ['4:image', { width: 1600, height: 1200, x: 0, y: 0 }, `Module 5 image: the photo is ${((JPEG_1600x1200.byteLength + 3 * MB) / MB).toFixed(1)} MB, over the 2 MB some Amazon guides give for A+ images; Amazon may refuse it.`],
    ])
  })

  it(`reads nothing when a document has more than ${APLUS_MAX_NEW_IMAGES} new photos`, async () => {
    const uses = Array.from({ length: APLUS_MAX_NEW_IMAGES + 1 }, (_, i) => use({ module: i, source: { kind: 'url', url: link(`${i}.jpg`) } }))
    expect(await inspectAplusImages(uses)).toEqual({ images: [], problems: [`The document has ${APLUS_MAX_NEW_IMAGES + 1} new photos; Nexus uploads at most ${APLUS_MAX_NEW_IMAGES} in one request.`] })
    expect(fetchPhotoMock).not.toHaveBeenCalled()
  })
})

describe('uploadAplusImages', () => {
  const inspected = async (...uses: ImageUse[]) => {
    const { images, problems } = await inspectAplusImages(uses)
    expect(problems).toEqual([])
    fetchPhotoMock.mockClear()
    return images
  }
  const storage = (status = 204) => {
    const post = vi.fn(async (..._args: [string, RequestInit]) => new Response(null, { status }))
    vi.stubGlobal('fetch', post)
    return post
  }

  it('is refused, with nothing fetched or sent, unless the Amazon publish mode is live', async () => {
    photos.set(link('a.jpg'), { buffer: JPEG_1600x1200, mimeType: 'image/jpeg' })
    const images = await inspected(use({ source: { kind: 'url', url: link('a.jpg') } }))
    const post = storage()
    for (const mode of ['gated', 'dry-run', 'sandbox'] as const) {
      vi.mocked(getAmazonPublishMode).mockReturnValue(mode)
      const error = await uploadAplusImages(T, images).then(() => null, (e: unknown) => e as AplusError)
      expect(error).toBeInstanceOf(AplusError)
      expect(error).toMatchObject({ code: 'refused', message: `Amazon publishing is ${mode} on this server (not live), so no photo was uploaded to Amazon.` })
    }
    expect(fetchPhotoMock).not.toHaveBeenCalled()
    expect(gatewayMock).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it('live: the destination through the gateway with the base64 MD5, then a multipart POST of the URL\'s fields in order and the file last', async () => {
    photos.set(link('a.jpg'), { buffer: JPEG_1600x1200, mimeType: 'image/jpeg' })
    const images = await inspected(use({ source: { kind: 'url', url: link('a.jpg') } }))
    const post = storage()
    const uploaded = await uploadAplusImages(T, images)
    expect(uploaded).toEqual({ [sha256(JPEG_1600x1200)]: 'aplus-media/sc/1.jpg' })

    expect(gatewayMock).toHaveBeenCalledTimes(1)
    const call = gatewayMock.mock.calls[0][0] as { accountId: string; method: string; path: string; operation: string }
    expect(call).toMatchObject({ accountId: 'acct-1', method: 'POST', operation: 'uploads.createUploadDestinationForResource' })
    const query = new URLSearchParams(call.path.split('?')[1])
    expect(query.get('contentMD5')).toBe(createHash('md5').update(JPEG_1600x1200).digest('base64'))
    expect(query.get('contentType')).toBe('image/jpeg')
    expect(query.get('marketplaceIds')).toBe('APJ6JRA9NG5V4')

    expect(post).toHaveBeenCalledTimes(1)
    const [target, init] = post.mock.calls[0]
    expect(target).toBe('https://aplus-media.s3.amazonaws.com/')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'x-amz-meta-owner': 'OWNER' } })
    expect(init.signal).toBeInstanceOf(AbortSignal)
    const form = init.body as FormData
    expect([...form.keys()]).toEqual(['x-amz-date', 'x-amz-signature', 'key', 'acl', 'policy', 'file'])
    expect(form.get('key')).toBe('sc/photo.jpg')
    const file = form.get('file') as Blob
    expect(file.type).toBe('image/jpeg')
    expect(Buffer.from(await file.arrayBuffer()).equals(JPEG_1600x1200)).toBe(true)
  })

  it('the same bytes are uploaded once, whatever positions and sources use them', async () => {
    findAsset.mockResolvedValue({ url: link('same.jpg'), type: 'image' })
    photos.set(link('same.jpg'), { buffer: JPEG_1600x1200, mimeType: 'image/jpeg' })
    photos.set(link('copy.jpg'), { buffer: JPEG_1600x1200, mimeType: 'image/jpeg' })
    const images = await inspected(
      use({ source: { kind: 'asset', assetId: 'da_same' } }),
      use({ module: 1, source: { kind: 'asset', assetId: 'da_same' } }),
      use({ module: 2, source: { kind: 'url', url: link('copy.jpg') } }),
    )
    const post = storage()
    expect(Object.keys(await uploadAplusImages(T, images))).toEqual([sha256(JPEG_1600x1200)])
    expect(gatewayMock).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('refuses a photo that changed since it was approved, before anything is sent for it', async () => {
    photos.set(link('a.jpg'), { buffer: JPEG_1600x1200, mimeType: 'image/jpeg' })
    const images = await inspected(use({ source: { kind: 'url', url: link('a.jpg') } }))
    photos.set(link('a.jpg'), { buffer: PNG_2000x1200, mimeType: 'image/png' })
    const post = storage()
    const error = await uploadAplusImages(T, images).then(() => null, (e: unknown) => e as AplusImageError)
    expect(error).toBeInstanceOf(AplusImageError)
    expect(error).toMatchObject({ key: '0:image', message: `Module 1 image: the photo at ${link('a.jpg')} changed since it was approved; ask again so a person approves the photo as it is now.` })
    expect(gatewayMock).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it('sends nothing to an upload address outside Amazon\'s storage, and never says the address', async () => {
    photos.set(link('a.jpg'), { buffer: JPEG_1600x1200, mimeType: 'image/jpeg' })
    const images = await inspected(use({ source: { kind: 'url', url: link('a.jpg') } }))
    const post = storage()
    for (const url of ['https://aplus-media.s3.amazonaws.com.evil.test/?policy=POLICY', 'http://aplus-media.s3.amazonaws.com/?policy=POLICY', 'not a url']) {
      gatewayMock.mockResolvedValueOnce(new Response(JSON.stringify({ payload: { uploadDestinationId: 'x', url, headers: {} } }), { status: 201 }))
      const error = await uploadAplusImages(T, images).then(() => null, (e: unknown) => e as AplusError)
      expect(error).toMatchObject({ code: 'unexpected', message: 'Amazon gave an upload address outside its storage for Module 1 image; Nexus sends no photo there, and nothing was created.' })
      expect(error!.message).not.toMatch(/POLICY|evil|http:/)
    }
    expect(post).not.toHaveBeenCalled()
  })

  it('a storage answer that is not 2xx, or none, is unavailable, without the address or its fields', async () => {
    photos.set(link('a.jpg'), { buffer: JPEG_1600x1200, mimeType: 'image/jpeg' })
    const images = await inspected(use({ source: { kind: 'url', url: link('a.jpg') } }))
    storage(403)
    const refused = await uploadAplusImages(T, images).then(() => null, (e: unknown) => e as AplusError)
    expect(refused).toMatchObject({ code: 'unavailable', status: 403, message: "Amazon's image storage refused Module 1 image (HTTP 403); nothing was created." })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError(`fetch failed: ${UPLOAD_URL}`) }))
    const silent = await uploadAplusImages(T, images).then(() => null, (e: unknown) => e as AplusError)
    expect(silent).toMatchObject({ code: 'unavailable', message: "Amazon's image storage did not answer for Module 1 image; nothing was created." })
    for (const error of [refused!, silent!]) expect(error.message).not.toMatch(/SIGNATURE|POLICY|amazonaws/)
  })
})

describe('the finished document', () => {
  const AT_AMAZON = { uploadDestinationId: 'aplus-media/old.png', imageCropSpecification: { size: { width: { value: 800, units: 'pixels' }, height: { value: 600, units: 'pixels' } }, offset: { x: { value: 0, units: 'pixels' }, y: { value: 0, units: 'pixels' } } }, altText: 'Old photo' }
  const checked = () => {
    const result = checkAplusDocument({
      name: 'Giacca', contentType: 'EBC', locale: 'it-IT', modules: [
        { contentModuleType: 'PREMIUM_IMAGE_TEXT', premiumImageText: { positionType: 'LEFT', headline: { value: 'Old' }, image: AT_AMAZON } },
        { contentModuleType: 'PREMIUM_FOUR_COLUMN_IMAGES', premiumFourColumnImages: { columns: [1, 2, 3].map((position) => ({ imageColumn: { position, image: { assetId: 'da_lib1', altText: `Column ${position}` } } })) } },
      ],
    })
    expect(result.ok).toBe(true)
    return (result as Extract<typeof result, { ok: true }>).doc
  }

  it('finalizeAplusDocument places each upload id with its crop and alt text; images at Amazon stay as they are', async () => {
    findAsset.mockResolvedValue({ url: link('library.jpg'), type: 'image' })
    photos.set(link('library.jpg'), { buffer: PNG_2000x1200, mimeType: 'image/png' })
    const doc = checked()
    const { images } = await inspectAplusImages(doc.images)
    const final = finalizeAplusDocument(doc, images, { [sha256(PNG_2000x1200)]: 'aplus-media/sc/new.png' })
    expect(final.name).toBe('Giacca')
    expect(final.contentModuleList[0]).toEqual(doc.modules[0])
    const columns = (final.contentModuleList[1][payloadKeyOf('PREMIUM_FOUR_COLUMN_IMAGES')] as { columns: Array<{ imageColumn: { image: unknown } }> }).columns
    expect(columns.map((c) => c.imageColumn.image)).toEqual([1, 2, 3].map((position) => ({
      uploadDestinationId: 'aplus-media/sc/new.png',
      imageCropSpecification: { size: { width: { value: 1600, units: 'pixels' }, height: { value: 1200, units: 'pixels' } }, offset: { x: { value: 200, units: 'pixels' }, y: { value: 0, units: 'pixels' } } },
      altText: `Column ${position}`,
    })))
    expect(JSON.stringify(final)).not.toContain('da_lib1')
    // The checked document itself is not changed.
    expect(JSON.stringify(doc.modules)).toContain('da_lib1')
    expect(() => finalizeAplusDocument(doc, images, {})).toThrow(AplusImageError)
  })

  it('planHashOf is the same for the same request and changes with the photo, its crop or its text', async () => {
    findAsset.mockResolvedValue({ url: link('library.jpg'), type: 'image' })
    photos.set(link('library.jpg'), { buffer: PNG_2000x1200, mimeType: 'image/png' })
    const doc = checked()
    const { images } = await inspectAplusImages(doc.images)
    const again = await inspectAplusImages(checked().images)
    expect(planHashOf(doc, images)).toBe(planHashOf(checked(), again.images))
    expect(planHashOf(doc, images)).toMatch(/^[0-9a-f]{16}$/)
    const otherPhoto: InspectedImage[] = images.map((i) => ({ ...i, contentHash: 'f'.repeat(64) }))
    const otherCrop: InspectedImage[] = images.map((i, k) => (k === 0 ? { ...i, crop: { ...i.crop, x: 0 } } : i))
    const otherText = { ...doc, images: doc.images.map((u) => ({ ...u, altText: `${u.altText}!` })) }
    for (const changed of [planHashOf(doc, otherPhoto), planHashOf(doc, otherCrop), planHashOf(otherText, images)]) expect(changed).not.toBe(planHashOf(doc, images))
  })

  it('imagesPreview shows each new photo by module (from 1), place and source', async () => {
    findAsset.mockResolvedValue({ url: link('library.jpg'), type: 'image' })
    photos.set(link('library.jpg'), { buffer: PNG_2000x1200, mimeType: 'image/png' })
    const { images } = await inspectAplusImages(checked().images)
    expect(imagesPreview(images)[0]).toEqual({
      key: '1:columns[0].imageColumn.image', module: 2, place: 'columns[0].imageColumn.image', source: 'photo da_lib1', mimeType: 'image/png',
      bytes: PNG_2000x1200.byteLength, width: 2000, height: 1200, crop: { width: 1600, height: 1200, x: 200, y: 0 }, contentHash: sha256(PNG_2000x1200),
    })
  })
})
