/**
 * SD creatives (2026-10-20) — what Nexus checks before it asks Amazon for a Sponsored Display creative, from Amazon's own
 * rules (the SD 3.0 spec and its creatives guide). Pure: no read, no write. Amazon checks again and has the last word;
 * its own refusal reaches the person in its words.
 *
 *   headline      not empty, at most 50 characters, none of < > # ^ !, no emoji, and — longer than 10 characters — at most
 *                 half of it in capitals
 *   brand logo    an IMAGE asset of at least 600 × 100 pixels, at most 1 MB, JPEG or PNG
 *   custom image  an IMAGE asset of at least 1200 × 628, at most 5 MB, JPEG, PNG or GIF; the same asset and version in
 *                 its two crops: rectangular (1.91 : 1, at least 1200 × 628) and square (at least 628 × 628)
 *   crops         inside the image
 *   type          an IMAGE ad group's creative shows no video; a VIDEO ad group's creative must have a video (one asset
 *                 per video list: Amazon takes one)
 */
import { computeCrop } from '../../aplus/aplus-images.js'
import type { SdCreativeProperties, SdCreativeType, SdCrop, SdImage, SdPolicyViolation } from './sd-creatives.client.js'

export const SD_HEADLINE_MAX = 50
/** Characters Amazon names as not allowed in a headline. */
const HEADLINE_FORBIDDEN = ['<', '>', '#', '^', '!']
/** Above this length, at most half of a headline may be capitals. */
const CAPITALS_FROM = 10

/** Why Amazon would refuse this headline, in a sentence; null when it passes Amazon's written rules. */
export function sdHeadlineProblem(headline: string): string | null {
  const text = headline.trim()
  if (!text) return 'a headline cannot be empty: leave it out, or give null to remove it'
  const length = [...text].length
  if (length > SD_HEADLINE_MAX) return `the headline is ${length} characters; Amazon takes at most ${SD_HEADLINE_MAX}`
  const forbidden = HEADLINE_FORBIDDEN.filter((c) => text.includes(c))
  if (forbidden.length) return `the headline holds ${forbidden.map((c) => `"${c}"`).join(', ')}, which Amazon does not allow in a headline (none of < > # ^ !)`
  if (/\p{Extended_Pictographic}/u.test(text)) return 'the headline holds an emoji, which Amazon does not allow'
  if (length > CAPITALS_FROM) {
    const visible = [...text].filter((c) => c.trim())
    const capitals = visible.filter((c) => c !== c.toLowerCase() && c === c.toUpperCase()).length
    if (capitals * 2 > visible.length) return `${capitals} of the headline's ${visible.length} characters are capitals; Amazon allows at most half in a headline longer than ${CAPITALS_FROM} characters`
  }
  return null
}

/** The pixel and file limits of each image of a creative. */
export interface SdImageSpec {
  label: string
  minWidth: number
  minHeight: number
  maxBytes: number
  /** Amazon's contentType / extension words for the file types it takes. */
  types: readonly string[]
}

const MB = 1024 * 1024
export const SD_LOGO_SPEC: SdImageSpec = { label: 'brand logo', minWidth: 600, minHeight: 100, maxBytes: 1 * MB, types: ['jpeg', 'jpg', 'png'] }
export const SD_CUSTOM_IMAGE_SPEC: SdImageSpec = { label: 'custom image', minWidth: 1200, minHeight: 628, maxBytes: 5 * MB, types: ['jpeg', 'jpg', 'png', 'gif'] }
/** The two crops of a custom image: the smallest Amazon takes, in the shape it shows. */
export const SD_RECT_CROP = { minWidth: 1200, minHeight: 628 }
export const SD_SQUARE_CROP = { minWidth: 628, minHeight: 628 }
/** An image of a creative's image lists (squareImages, …): Amazon writes no size for them, so only the file is held. */
const LIST_IMAGE_SPEC: SdImageSpec = { ...SD_CUSTOM_IMAGE_SPEC, label: 'creative image', minWidth: 0, minHeight: 0 }

/** An asset as these rules read it (ads-assets.client.ts AdsAsset). */
export interface SdAssetFacts {
  assetId: string
  version: string | null
  assetType: string | null
  status: string | null
  width: number | null
  height: number | null
  bytes: number | null
  contentType: string | null
  extension: string | null
}

const megabytes = (bytes: number) => `${(bytes / MB).toFixed(1)} MB`
/** An asset type as a person names it: "an image", "a video". */
const kindWords = (assetType: string) => (assetType === 'IMAGE' ? 'an image' : assetType === 'VIDEO' ? 'a video' : `a ${assetType.toLowerCase()}`)
/** `image/png` and `png` alike. */
const fileType = (asset: Pick<SdAssetFacts, 'contentType' | 'extension'>): string | null => {
  const said = (asset.extension ?? asset.contentType ?? '').trim().toLowerCase()
  return said ? said.replace(/^image\//, '') : null
}

/** Why this asset cannot be this image of a creative; null when it can (what Nexus does not know is left to Amazon). */
export function sdImageAssetProblem(asset: SdAssetFacts, spec: SdImageSpec): string | null {
  const name = `asset ${asset.assetId}`
  if (asset.assetType && asset.assetType !== 'IMAGE') return `${name} is ${kindWords(asset.assetType)}, not an image: a ${spec.label} is an image`
  if (asset.status === 'PROCESSING') return `Amazon is still processing ${name}; ask again in a few minutes`
  if (asset.status && asset.status !== 'ACTIVE') return `${name} is ${asset.status.toLowerCase()} in the library; a ${spec.label} must be an active asset`
  const type = fileType(asset)
  if (type && !spec.types.includes(type)) return `${name} is a ${type.toUpperCase()} file; a ${spec.label} is ${spec.types.filter((t) => t !== 'jpg').map((t) => t.toUpperCase()).join(', ')}`
  if (asset.width != null && asset.height != null && (asset.width < spec.minWidth || asset.height < spec.minHeight)) {
    return `${name} is ${asset.width} × ${asset.height} pixels; a ${spec.label} must be at least ${spec.minWidth} × ${spec.minHeight}`
  }
  if (asset.bytes != null && asset.bytes > spec.maxBytes) return `${name} is ${megabytes(asset.bytes)}; a ${spec.label} may be at most ${megabytes(spec.maxBytes)}`
  return null
}

/** Why this video asset cannot be the video of a creative; null when it can. */
export function sdVideoAssetProblem(asset: SdAssetFacts): string | null {
  const name = `asset ${asset.assetId}`
  if (asset.assetType && asset.assetType !== 'VIDEO') return `${name} is ${kindWords(asset.assetType)}, not a video`
  if (asset.status === 'PROCESSING') return `Amazon is still processing ${name}; ask again in a few minutes`
  if (asset.status && asset.status !== 'ACTIVE') return `${name} is ${asset.status.toLowerCase()} in the library; a video must be an active asset`
  return null
}

/** Why this crop cannot be sent; null when it can. `image` unknown: only the minimum is checked. */
export function sdCropProblem(crop: SdCrop, label: string, min: { minWidth: number; minHeight: number }, image: { width: number | null; height: number | null }): string | null {
  if (crop.width < min.minWidth || crop.height < min.minHeight) return `the ${label} crop is ${crop.width} × ${crop.height}; Amazon needs at least ${min.minWidth} × ${min.minHeight}`
  if (image.width != null && image.height != null && (crop.left + crop.width > image.width || crop.top + crop.height > image.height)) {
    return `the ${label} crop ${crop.width} × ${crop.height} at ${crop.left},${crop.top} reaches outside the image (${image.width} × ${image.height})`
  }
  return null
}

/** The largest centred crop of an image in the shape of `min` (null when the image is smaller, or its size unknown). */
export function sdDefaultCrop(image: { width: number | null; height: number | null }, min: { minWidth: number; minHeight: number }): SdCrop | null {
  if (image.width == null || image.height == null) return null
  const crop = computeCrop(image.width, image.height, min)
  return crop ? { left: crop.x, top: crop.y, width: crop.width, height: crop.height } : null
}

const VIDEO_KEYS = ['video', 'squareVideos', 'horizontalVideos', 'verticalVideos'] as const
const IMAGE_LIST_KEYS = ['squareImages', 'horizontalImages', 'verticalImages'] as const

/** Why these properties cannot be a creative of an ad group of this creativeType (or at all); null when they can. */
export function sdPropertiesProblem(properties: SdCreativeProperties, creativeType: SdCreativeType): string | null {
  const keys = Object.keys(properties)
  if (!keys.length) return 'a creative needs at least one of headline, brandLogo, customImage or video'
  const hasVideo = VIDEO_KEYS.some((k) => k in properties)
  if (creativeType === 'IMAGE' && hasVideo) return 'the ad group\'s creative type is IMAGE: its creative shows a headline, a logo and images, never a video (an ad group\'s creative type is set when it is made)'
  if (creativeType === 'VIDEO' && !hasVideo) return 'the ad group\'s creative type is VIDEO: Amazon needs a video asset in its creative'
  for (const key of ['squareVideos', 'horizontalVideos', 'verticalVideos'] as const) {
    if ((properties[key]?.length ?? 0) > 1) return `${key} holds ${properties[key]!.length} videos; Amazon takes one`
  }
  if (properties.video && VIDEO_KEYS.some((k) => k !== 'video' && k in properties)) return 'give either video or the videos of one shape (squareVideos, horizontalVideos, verticalVideos), not both'
  const rect = properties.rectCustomImage, square = properties.squareCustomImage
  if (!!rect !== !!square) return 'a custom image is sent in its two crops together (rectCustomImage and squareCustomImage)'
  if (rect && square && (rect.assetId !== square.assetId || rect.assetVersion !== square.assetVersion)) {
    return 'the rectangular and square custom image must be the same asset and version (Amazon\'s rule)'
  }
  if (typeof properties.headline === 'string') {
    const problem = sdHeadlineProblem(properties.headline)
    if (problem) return problem
  }
  for (const key of IMAGE_LIST_KEYS) if ((properties[key]?.length ?? 0) > 10) return `${key} holds more than 10 images`
  return null
}

/** One place of a creative that names an asset: what it is used as, the asset and version, and its crop. */
export interface SdAssetUse { place: string; kind: 'logo' | 'rect' | 'square' | 'image' | 'video'; assetId: string; assetVersion: string; crop: SdCrop | null }

/** Every asset these properties name, one entry per place. */
export function sdAssetUses(properties: SdCreativeProperties): SdAssetUse[] {
  const out: SdAssetUse[] = []
  const image = (place: string, kind: SdAssetUse['kind'], i: SdImage | undefined) => {
    if (i) out.push({ place, kind, assetId: i.assetId, assetVersion: i.assetVersion, crop: i.croppingCoordinates ?? null })
  }
  image('brandLogo', 'logo', properties.brandLogo)
  image('rectCustomImage', 'rect', properties.rectCustomImage)
  image('squareCustomImage', 'square', properties.squareCustomImage)
  for (const key of IMAGE_LIST_KEYS) (properties[key] ?? []).forEach((i, n) => image(`${key}[${n}]`, 'image', i))
  if (properties.video) out.push({ place: 'video', kind: 'video', assetId: properties.video.assetId, assetVersion: properties.video.assetVersion, crop: null })
  for (const key of ['squareVideos', 'horizontalVideos', 'verticalVideos'] as const) {
    ;(properties[key] ?? []).forEach((v, n) => out.push({ place: `${key}[${n}]`, kind: 'video', assetId: v.assetId, assetVersion: v.assetVersion, crop: null }))
  }
  return out
}

/**
 * Why this asset cannot be used in this place of a creative; null when it can. A logo's or custom image's file is held to
 * its spec, each crop to its minimum (a logo's to the image only); an image of a list and a video to their kind.
 */
export function sdAssetUseProblem(use: SdAssetUse, asset: SdAssetFacts): string | null {
  const problem = use.kind === 'video'
    ? sdVideoAssetProblem(asset)
    : sdImageAssetProblem(asset, use.kind === 'logo' ? SD_LOGO_SPEC : use.kind === 'image' ? LIST_IMAGE_SPEC : SD_CUSTOM_IMAGE_SPEC)
  if (problem) return `${use.place}: ${problem}`
  if (!use.crop) return null
  const min = use.kind === 'rect' ? SD_RECT_CROP : use.kind === 'square' ? SD_SQUARE_CROP : { minWidth: 1, minHeight: 1 }
  const crop = sdCropProblem(use.crop, use.place, min, asset)
  return crop ? `${use.place}: ${crop}` : null
}

// ── In words ────────────────────────────────────────────────────────────────────────────────────────

const cropWords = (c: SdCrop | undefined) => (c ? `, crop ${c.width} × ${c.height} at ${c.left},${c.top}` : '')
const imageWords = (i: SdImage | undefined) => (i ? `asset ${i.assetId} (${i.assetVersion}${cropWords(i.croppingCoordinates)})` : null)

/** One creative's properties in the few words a preview's from → to shows, per part. */
export function sdPropertiesWords(p: SdCreativeProperties | null): Record<string, string | null> {
  if (!p) return { headline: null, brandLogo: null, customImage: null, video: null }
  const custom = p.rectCustomImage
    ? `asset ${p.rectCustomImage.assetId} (${p.rectCustomImage.assetVersion}; rectangular${cropWords(p.rectCustomImage.croppingCoordinates)}; square${cropWords(p.squareCustomImage?.croppingCoordinates)})`
    : null
  const images = IMAGE_LIST_KEYS.map((k) => (p[k]?.length ? `${p[k]!.length} ${k}` : null)).filter(Boolean)
  const videos = [p.video ? `asset ${p.video.assetId} (${p.video.assetVersion})` : null, ...(['squareVideos', 'horizontalVideos', 'verticalVideos'] as const).map((k) => (p[k]?.length ? `${k}: asset ${p[k]![0].assetId} (${p[k]![0].assetVersion})` : null))].filter(Boolean)
  return {
    headline: typeof p.headline === 'string' ? `"${p.headline}"` : null,
    brandLogo: imageWords(p.brandLogo),
    customImage: [custom, ...images].filter(Boolean).join('; ') || null,
    video: videos.join('; ') || null,
  }
}

/** Amazon's moderation status in the words a person reads. */
export function sdModerationWords(status: string | null | undefined, eta?: string | null): string {
  switch ((status ?? '').toUpperCase()) {
    case 'APPROVED': return 'approved: Amazon passed this creative'
    case 'PENDING_REVIEW': return `in review at Amazon${eta ? ` (expected by ${eta})` : ''}: it cannot be changed until Amazon approves or rejects it`
    case 'REJECTED': return 'rejected by Amazon: see the reasons; change what they name (set-ad-creative op update) and Amazon reviews it again'
    default: return status ? `Amazon says ${status}` : 'Amazon gave no moderation status'
  }
}

/** One policy a creative broke, in a sentence: the policy, its link, and the parts Amazon names. */
export function sdViolationWords(v: SdPolicyViolation): string {
  const parts: string[] = []
  for (const h of v.violatingHeadlineContents ?? []) {
    const texts = (h.textEvidence ?? []).map((e) => e.violatingText).filter((t): t is string => !!t)
    parts.push(`headline${h.reviewedText ? ` "${h.reviewedText}"` : ''}${texts.length ? `: ${texts.map((t) => `"${t}"`).join(', ')}` : ''}`)
  }
  for (const l of v.violatingBrandLogoContents ?? []) parts.push(`brand logo${l.reviewedImageUrl ? ` ${l.reviewedImageUrl}` : ''}`)
  for (const c of v.violatingCustomImageContents ?? []) parts.push(`custom image${c.reviewedImageUrl ? ` ${c.reviewedImageUrl}` : ''}`)
  for (const vid of v.violatingVideoContents ?? []) {
    const at = (vid.videoEvidences ?? []).map((e) => e.violatingVideoPosition).filter((p): p is { start?: number; end?: number } => !!p).map((p) => `${p.start ?? '?'}–${p.end ?? '?'}`)
    parts.push(`video${vid.reviewedVideoUrl ? ` ${vid.reviewedVideoUrl}` : ''}${at.length ? ` at ${at.join(', ')}` : ''}`)
  }
  const policy = v.policyDescription?.trim() || 'a policy Amazon did not name'
  return `${policy}${v.policyLinkUrl ? ` (${v.policyLinkUrl})` : ''}${parts.length ? ` — ${parts.join('; ')}` : ''}`
}
