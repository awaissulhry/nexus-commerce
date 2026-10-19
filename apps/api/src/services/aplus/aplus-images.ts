/**
 * Amazon A+ content (2026-10-19) — the new photos of an A+ document: read and measured when the request is made, sent to
 * Amazon only when the approved request runs.
 *
 * Inspect (the dry run and the gate's re-check; reads only): each new image names a Nexus photo (`da_…` library item,
 * `pi_…` product photo) or an https link. Each source is fetched once, by the one public-address fetch (`fetchPhoto`,
 * images/photo-from-url.service.ts — https only, public hosts, bounded time and bytes). A photo must be JPEG or PNG, at
 * most 5 MB (a warning above 2 MB, the size some Amazon guides give), and at least the image position's minimum size.
 * Its crop is the one given (inside the photo, at least the minimum, in the minimum's shape within 1 %) or else the
 * largest centred crop in that shape (`computeCrop`): Amazon checks the crop, not the file, against the module's size
 * and shape.
 *
 * Upload (execute only): refused unless the Amazon publish mode is live — the storage POST below does not pass the
 * gateway's publish mode. Each distinct photo is fetched again and must still be the bytes a person approved (sha256);
 * then its upload destination comes through the gateway (Uploads API, createUploadDestinationForResource), and the bytes
 * go as a multipart POST to Amazon's pre-signed storage URL: every query parameter of the URL as a form field, in its
 * order, and the file last. That POST is the one direct send of the A+ tools (gateway-exempt, a pre-signed upload).
 * The URL, its headers and its form fields carry a signature and a policy: never logged, stored or returned.
 */
import { createHash } from 'node:crypto'
import imageSize from 'image-size'
import prisma from '../../db.js'
import { getAmazonPublishMode } from '../amazon-publish-gate.service.js'
import { factHash } from '../agents/tool-types.js'
import { fetchPhoto } from '../images/photo-from-url.service.js'
import { AplusError, createUploadDestination, type AplusDocument, type AplusModule, type AplusTarget } from './aplus-client.js'
import { payloadKeyOf, type CheckedAplusDocument, type CropSpec, type ImageSlot, type ImageSource, type ImageUse } from './aplus-modules.js'

export const APLUS_IMAGE_TYPES = ['image/jpeg', 'image/png'] as const
/** Above this a photo is refused. */
export const APLUS_IMAGE_MAX_BYTES = 5 * 1024 * 1024
/** Above this a photo is sent with a warning (Amazon publishes no limit; some of its guides say 2 MB). */
export const APLUS_IMAGE_WARN_BYTES = 2 * 1024 * 1024
/** The most new photos one request reads and uploads. */
export const APLUS_MAX_NEW_IMAGES = 40

type NewSource = Exclude<ImageSource, { kind: 'amazon' }>

/** A new photo of a document as inspected: what it is, how big, and the crop that is sent with it. */
export interface InspectedImage {
  key: string
  source: NewSource
  /** How problems name the position: "Module 2 columns[1].imageColumn.image". */
  label: string
  mimeType: 'image/jpeg' | 'image/png'
  bytes: number
  width: number
  height: number
  /** sha256 of the bytes, lowercase hex: the photo a person approves. */
  contentHash: string
  crop: CropSpec
  warning: string | null
}

/** A new photo that cannot be used (or that changed since it was approved), said to a person. */
export class AplusImageError extends Error {
  constructor(message: string, readonly key: string | null) {
    super(message)
    this.name = 'AplusImageError'
  }
}

/** Shape tolerance of a given crop: within 1 % of the slot's width : height. */
const RATIO_TOLERANCE = 0.01
const UPLOAD_TIMEOUT_MS = 60_000
const STORAGE_OPERATION = 'aplus.imageStorageUpload'

/**
 * The largest crop of a width × height photo in the slot's shape, centred; null when the photo is smaller than the slot
 * (then no crop in its shape reaches the minimum). Whole pixels, never below the minimum.
 */
export function computeCrop(width: number, height: number, slot: ImageSlot): CropSpec | null {
  if (width < slot.minWidth || height < slot.minHeight) return null
  // Integer arithmetic: wider than the slot → full height; else full width.
  const wider = width * slot.minHeight > height * slot.minWidth
  const w = wider ? Math.floor((height * slot.minWidth) / slot.minHeight) : width
  const h = wider ? height : Math.floor((width * slot.minHeight) / slot.minWidth)
  return { width: w, height: h, x: Math.floor((width - w) / 2), y: Math.floor((height - h) / 2) }
}

const labelOf = (use: Pick<ImageUse, 'module' | 'path'>) => `Module ${use.module + 1} ${use.path}`
const sourceKey = (source: NewSource) => (source.kind === 'asset' ? `asset:${source.assetId}` : `url:${source.url}`)
const sourceText = (source: NewSource) => (source.kind === 'asset' ? source.assetId : source.url)
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)
const TYPE_NAME: Record<string, string> = { 'image/webp': 'a WebP', 'image/gif': 'a GIF' }

interface ReadPhoto { buffer: Buffer; mimeType: 'image/jpeg' | 'image/png'; bytes: number; width: number; height: number; contentHash: string }

/** The address of a Nexus photo in this business (the database client is scoped to it), or why there is none. */
async function addressOf(source: NewSource): Promise<{ url: string } | { problem: string }> {
  if (source.kind === 'url') return { url: source.url }
  const id = source.assetId.slice(3)
  if (source.assetId.startsWith('da_')) {
    const asset = await prisma.digitalAsset.findFirst({ where: { id }, select: { url: true, type: true } })
    if (!asset) return { problem: `there is no library item ${source.assetId} in this business (image-library lists them)` }
    if (asset.type !== 'image') return { problem: `library item ${source.assetId} is a ${asset.type}, not a photo` }
    return { url: asset.url }
  }
  const photo = await prisma.productImage.findFirst({ where: { id, product: { deletedAt: null } }, select: { url: true } })
  if (!photo) return { problem: `there is no product photo ${source.assetId} in this business` }
  return { url: photo.url }
}

/** Fetch one source and measure it, or say why it cannot go into an A+ document. */
async function readPhoto(source: NewSource): Promise<ReadPhoto | { problem: string }> {
  const address = await addressOf(source)
  if ('problem' in address) return address
  let fetched: Awaited<ReturnType<typeof fetchPhoto>>
  try {
    fetched = await fetchPhoto(address.url, APLUS_IMAGE_MAX_BYTES)
  } catch (error) {
    return { problem: lowerFirst(error instanceof Error ? error.message : String(error)).replace(/\.$/, '') }
  }
  const mimeType = fetched.mimeType as ReadPhoto['mimeType']
  if (!(APLUS_IMAGE_TYPES as readonly string[]).includes(mimeType)) {
    return { problem: `the photo is ${TYPE_NAME[fetched.mimeType] ?? fetched.mimeType}; Amazon A+ takes JPEG or PNG only` }
  }
  if (fetched.buffer.byteLength > APLUS_IMAGE_MAX_BYTES) {
    return { problem: `the photo is ${megabytes(fetched.buffer.byteLength)}; Amazon A+ takes at most ${megabytes(APLUS_IMAGE_MAX_BYTES)}` }
  }
  let size: { width?: number; height?: number; type?: string }
  try { size = imageSize(fetched.buffer) } catch { size = {} }
  const looks = size.type === 'jpg' ? 'image/jpeg' : size.type === 'png' ? 'image/png' : null
  if (!size.width || !size.height || looks !== mimeType) return { problem: 'the file could not be read as a JPEG or PNG photo' }
  return {
    buffer: fetched.buffer, mimeType, bytes: fetched.buffer.byteLength, width: size.width, height: size.height,
    contentHash: createHash('sha256').update(fetched.buffer).digest('hex'),
  }
}

/** Why a crop the person gave cannot be sent, or null. */
function givenCropProblem(crop: CropSpec, photo: { width: number; height: number }, slot: ImageSlot): string | null {
  if (crop.x + crop.width > photo.width || crop.y + crop.height > photo.height) {
    return `the crop ${crop.width}×${crop.height} at ${crop.x},${crop.y} reaches outside the photo (${photo.width}×${photo.height})`
  }
  if (crop.width < slot.minWidth || crop.height < slot.minHeight) return `the crop is ${crop.width}×${crop.height}; Amazon needs at least ${slot.minWidth}×${slot.minHeight}`
  const shape = (crop.width / crop.height) / (slot.minWidth / slot.minHeight)
  if (Math.abs(shape - 1) > RATIO_TOLERANCE) {
    return `the crop ${crop.width}×${crop.height} is not the shape Amazon needs here (${slot.minWidth}:${slot.minHeight}); leave imageCropSpecification out and Nexus crops it`
  }
  return null
}

/**
 * Read and measure every new photo of a document (the images at Amazon are left as they are). Reads only: each source
 * once, nothing stored, nothing sent to Amazon. Every image that cannot be used is a problem sentence.
 */
export async function inspectAplusImages(uses: readonly ImageUse[]): Promise<{ images: InspectedImage[]; problems: string[] }> {
  const fresh = uses.filter((use): use is ImageUse & { source: NewSource } => use.source.kind !== 'amazon')
  const sources = new Map<string, NewSource>()
  for (const use of fresh) sources.set(sourceKey(use.source), use.source)
  if (sources.size > APLUS_MAX_NEW_IMAGES) {
    return { images: [], problems: [`The document has ${sources.size} new photos; Nexus uploads at most ${APLUS_MAX_NEW_IMAGES} in one request.`] }
  }
  const read = new Map<string, ReadPhoto | { problem: string }>()
  for (const [key, source] of sources) read.set(key, await readPhoto(source))

  const images: InspectedImage[] = []
  const problems: string[] = []
  for (const use of fresh) {
    const label = labelOf(use)
    const photo = read.get(sourceKey(use.source))!
    if ('problem' in photo) { problems.push(`${label}: ${photo.problem}.`); continue }
    let crop: CropSpec | null
    if (use.crop) {
      const wrong = givenCropProblem(use.crop, photo, use.slot)
      if (wrong) { problems.push(`${label}: ${wrong}.`); continue }
      crop = use.crop
    } else {
      crop = computeCrop(photo.width, photo.height, use.slot)
      if (!crop) { problems.push(`${label}: the photo is ${photo.width}×${photo.height}; Amazon needs at least ${use.slot.minWidth}×${use.slot.minHeight}.`); continue }
    }
    images.push({
      key: use.key, source: use.source, label, mimeType: photo.mimeType, bytes: photo.bytes, width: photo.width, height: photo.height,
      contentHash: photo.contentHash, crop,
      warning: photo.bytes > APLUS_IMAGE_WARN_BYTES ? `${label}: the photo is ${megabytes(photo.bytes)}, over the 2 MB some Amazon guides give for A+ images; Amazon may refuse it.` : null,
    })
  }
  return { images, problems }
}

const urlOf = (value: string): URL | null => {
  try { return new URL(value) } catch { return null }
}

/** POST the bytes to Amazon's pre-signed storage URL. Nothing about the URL, its headers or its fields leaves this function. */
async function postToStorage(destination: { url: string; headers: Record<string, string> }, photo: ReadPhoto, label: string): Promise<void> {
  const target = urlOf(destination.url)
  if (!target || target.protocol !== 'https:' || !/(^|\.)amazonaws\.com$/.test(target.hostname)) {
    throw new AplusError('unexpected', `Amazon gave an upload address outside its storage for ${label}; Nexus sends no photo there, and nothing was created.`, 0, STORAGE_OPERATION)
  }
  const form = new FormData()
  for (const [name, value] of target.searchParams) form.append(name, value)
  form.append('file', new Blob([new Uint8Array(photo.buffer)], { type: photo.mimeType }), photo.mimeType === 'image/png' ? 'aplus.png' : 'aplus.jpg')
  // The form sets its own content-type (multipart, with its boundary). A Content-MD5 header would be checked against the
  // whole multipart body, not the photo; a POST policy that wants the photo's MD5 names it as a form field (above).
  const headers = Object.fromEntries(Object.entries(destination.headers).filter(([name]) => !['content-type', 'content-md5'].includes(name.toLowerCase())))
  let res: Response
  try {
    // gateway-exempt: pre-signed A+ image upload to Amazon's storage (POST policy from createUploadDestinationForResource); the upload destination itself goes through the gateway
    res = await fetch(`${target.origin}${target.pathname}`, { method: 'POST', headers, body: form, redirect: 'error', signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) })
  } catch {
    throw new AplusError('unavailable', `Amazon's image storage did not answer for ${label}; nothing was created.`, 0, STORAGE_OPERATION)
  }
  if (!res.ok) throw new AplusError('unavailable', `Amazon's image storage refused ${label} (HTTP ${res.status}); nothing was created.`, res.status, STORAGE_OPERATION)
}

/**
 * Upload the approved new photos to Amazon (execute only): one upload per distinct photo, each still the bytes a person
 * approved. Returns each photo's uploadDestinationId by its contentHash. Throws `AplusError('refused')` before anything
 * is fetched or sent when the Amazon publish mode is not live, and `AplusImageError` when a photo changed or cannot be
 * read any more.
 */
export async function uploadAplusImages(target: AplusTarget, images: readonly InspectedImage[]): Promise<Record<string, string>> {
  const mode = getAmazonPublishMode()
  if (mode !== 'live') {
    throw new AplusError('refused', `Amazon publishing is ${mode} on this server (not live), so no photo was uploaded to Amazon.`, 0, 'uploads.createUploadDestinationForResource')
  }
  const uploaded: Record<string, string> = {}
  for (const image of images) {
    if (uploaded[image.contentHash]) continue
    const photo = await readPhoto(image.source)
    if ('problem' in photo) throw new AplusImageError(`${image.label}: ${photo.problem}; nothing was uploaded for it.`, image.key)
    if (photo.contentHash !== image.contentHash) {
      throw new AplusImageError(`${image.label}: the photo at ${sourceText(image.source)} changed since it was approved; ask again so a person approves the photo as it is now.`, image.key)
    }
    const contentMD5 = createHash('md5').update(photo.buffer).digest('base64')
    const destination = await createUploadDestination(target, { contentMD5, contentType: photo.mimeType })
    await postToStorage(destination, photo, image.label)
    uploaded[image.contentHash] = destination.uploadDestinationId
  }
  return uploaded
}

// ── Placing images into the document ─────────────────────────────────────────────────────────────────

/** 'columns[1].imageColumn.image' → ['columns', 1, 'imageColumn', 'image'] */
function segmentsOf(path: string): Array<string | number> {
  return [...path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((m) => (m[2] !== undefined ? Number(m[2]) : m[1]))
}

/** The modules with every new image position replaced by `place(use, image)`; the images at Amazon stay as they are. */
function withNewImages(doc: CheckedAplusDocument, images: readonly InspectedImage[], place: (use: ImageUse, image: InspectedImage) => unknown): AplusModule[] {
  const modules = structuredClone(doc.modules) as AplusModule[]
  const byKey = new Map(images.map((image) => [image.key, image]))
  for (const use of doc.images) {
    if (use.source.kind === 'amazon') continue
    const image = byKey.get(use.key)
    if (!image) throw new AplusImageError(`${labelOf(use)}: the photo was not inspected; ask again.`, use.key)
    const module = modules[use.module]
    const segments = segmentsOf(use.path)
    let parent: any = module[payloadKeyOf(module.contentModuleType)]
    for (const segment of segments.slice(0, -1)) parent = parent?.[segment]
    if (!parent || typeof parent !== 'object') throw new AplusImageError(`${labelOf(use)}: the image position is not in the document.`, use.key)
    parent[segments[segments.length - 1]] = place(use, image)
  }
  return modules
}

const pixels = (value: number) => ({ value, units: 'pixels' as const })
const amazonCrop = (crop: CropSpec) => ({
  size: { width: pixels(crop.width), height: pixels(crop.height) },
  offset: { x: pixels(crop.x), y: pixels(crop.y) },
})

/** The document Amazon receives: every new photo as its uploadDestinationId with its crop and alt text. */
export function finalizeAplusDocument(doc: CheckedAplusDocument, images: readonly InspectedImage[], uploaded: Readonly<Record<string, string>>): AplusDocument {
  const contentModuleList = withNewImages(doc, images, (use, image) => {
    const uploadDestinationId = uploaded[image.contentHash]
    if (!uploadDestinationId) throw new AplusImageError(`${image.label}: the photo was not uploaded to Amazon; nothing was created.`, image.key)
    return { uploadDestinationId, imageCropSpecification: amazonCrop(image.crop), altText: use.altText }
  })
  return { name: doc.name, contentType: doc.contentType, locale: doc.locale, contentModuleList }
}

/**
 * What a person approves, as one hash: the document with each new photo as { contentHash, crop, altText } (the bytes,
 * not their address). The same request asked again gives the same hash; another photo, crop or text does not.
 */
export function planHashOf(doc: CheckedAplusDocument, images: readonly InspectedImage[]): string {
  const contentModuleList = withNewImages(doc, images, (use, image) => ({ contentHash: image.contentHash, crop: image.crop, altText: use.altText }))
  return factHash({ name: doc.name, contentType: doc.contentType, locale: doc.locale, contentModuleList })
}

/** The new photos as the preview shows them: the module (counted from 1, as the preview's module lines), place, source, size and crop. */
export function imagesPreview(images: readonly InspectedImage[]): Array<{ key: string; module: number; place: string; source: string; mimeType: string; bytes: number; width: number; height: number; crop: CropSpec; contentHash: string }> {
  return images.map((image) => {
    const colon = image.key.indexOf(':')
    return {
      key: image.key,
      module: Number(image.key.slice(0, colon)) + 1,
      place: image.key.slice(colon + 1),
      source: image.source.kind === 'asset' ? `photo ${image.source.assetId}` : `link ${image.source.url}`,
      mimeType: image.mimeType,
      bytes: image.bytes,
      width: image.width,
      height: image.height,
      crop: image.crop,
      contentHash: image.contentHash,
    }
  })
}
