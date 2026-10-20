/**
 * SD creatives (2026-10-20) — the look of a Sponsored Display ad, through Amazon's SD 3.0 creatives API.
 *
 *   GET  /sd/creatives                 the creatives of ad groups (one per ad group): type, headline, brand logo, custom
 *                                      image(s), video(s), backgrounds, and Amazon's moderation status
 *   GET  /sd/moderation/creatives      the moderation of each: status, when Amazon expects to finish, and every policy
 *                                      it broke with the text, image or video part that broke it (`language` required)
 *   POST /sd/creatives                 a creative for an ad group that has none (207: `[{ code, description, creativeId }]`)
 *   PUT  /sd/creatives                 a creative's new properties (207, the same items). Amazon refuses a creative in
 *                                      PENDING_REVIEW; a change of headline or logo sends it back to PENDING_REVIEW
 *   POST /sd/creatives/preview         the HTML Amazon renders for a creative in one slot size (a read: changes nothing)
 *   GET  /sd/adGroups                  only for each ad group's creativeType (IMAGE | VIDEO): what its creative may hold
 *
 * The bodies take Amazon's int64 ids as JSON numbers (amazonIntId refuses one that would change). Every call goes through
 * the Ads client's `liveCall` (the channel gateway); sandbox sends nothing and reads nothing. Amazon allows one creative
 * call a second: the client's 429 back-off paces a burst. A create whose answer is lost (5xx, no answer) is never sent
 * again blindly: Amazon is read back first, and the creative found there is the one made (CC-25's rule).
 */
import { randomUUID } from 'node:crypto'
import { logger } from '../../../utils/logger.js'
import { adsMode, amazonIntId, createOutcomeUnknown, liveCall, sbSdItemsResult, sdCreateResult, SBSD_ANSWER_NOT_UNDERSTOOD, type AdsMode, type ClientContext } from '../ads-api-client.js'

export type SdCreativeType = 'IMAGE' | 'VIDEO'
export const SD_CREATIVE_TYPES: readonly SdCreativeType[] = ['IMAGE', 'VIDEO']

/** A crop of an image asset, in pixels of the image (Amazon's croppingCoordinates). */
export interface SdCrop { top: number; left: number; width: number; height: number }
/** An image of a creative: an asset of the Creative Asset Library, one of its versions, and an optional crop. */
export interface SdImage { assetId: string; assetVersion: string; croppingCoordinates?: SdCrop }
/** A video of a creative. `originalAsset…` are Amazon's own (a translated video's source), never sent back. */
export interface SdVideo { assetId: string; assetVersion: string; originalAssetId?: string; originalAssetVersion?: string }

/** Amazon's CreativeProperties: any combination of headline, logo, custom images, videos and backgrounds. */
export interface SdCreativeProperties {
  headline?: string
  /** Amazon's own (the headline before a translation), never sent back. */
  originalHeadline?: string
  hasTermsAndConditions?: boolean
  brandLogo?: SdImage
  rectCustomImage?: SdImage
  squareCustomImage?: SdImage
  squareImages?: SdImage[]
  horizontalImages?: SdImage[]
  verticalImages?: SdImage[]
  video?: SdVideo
  squareVideos?: SdVideo[]
  horizontalVideos?: SdVideo[]
  verticalVideos?: SdVideo[]
  backgrounds?: Array<{ color?: string }>
}

export type SdModerationStatus = 'APPROVED' | 'PENDING_REVIEW' | 'REJECTED' | string

export interface SdCreative {
  creativeId: string
  /** Amazon's ad group id. */
  adGroupId: string
  creativeType: SdCreativeType | null
  properties: SdCreativeProperties
  moderationStatus: SdModerationStatus | null
}

/** One policy a creative broke, with the parts that broke it, as Amazon says them. */
export interface SdPolicyViolation {
  policyDescription?: string
  policyLinkUrl?: string
  violatingHeadlineContents?: Array<{ reviewedText?: string; textEvidence?: Array<{ violatingText?: string; violatingTextPosition?: { start?: number; end?: number } }> }>
  violatingBrandLogoContents?: Array<{ reviewedImageUrl?: string; imageEvidences?: unknown[] }>
  violatingCustomImageContents?: Array<{ reviewedImageUrl?: string; imageEvidences?: unknown[] }>
  violatingVideoContents?: Array<{ reviewedVideoUrl?: string; videoEvidences?: Array<{ violatingVideoPosition?: { start?: number; end?: number } }> }>
}

export interface SdCreativeModeration {
  creativeId: string
  creativeType: SdCreativeType | null
  moderationStatus: SdModerationStatus | null
  etaForModeration: string | null
  policyViolations: SdPolicyViolation[]
}

/** The languages Amazon writes moderation in (the spec's Locale). */
export const SD_MODERATION_LANGUAGES = [
  'en-US', 'es-MX', 'zh-CN', 'es-ES', 'it-IT', 'fr-FR', 'fr-CA', 'de-DE', 'ja-JP', 'ko-KR', 'en-GB', 'en-CA', 'hi-IN', 'en-IN',
  'en-DE', 'en-ES', 'en-FR', 'en-IT', 'en-JP', 'en-AE', 'ar-AE',
] as const
export type SdModerationLanguage = (typeof SD_MODERATION_LANGUAGES)[number]

/** English moderation for a market: Amazon's `en-<market>` where it has one (UK: en-GB), else en-US. */
export function sdModerationLanguageFor(market: string | null | undefined): SdModerationLanguage {
  const code = (market ?? '').trim().toUpperCase()
  const own = `en-${code === 'UK' ? 'GB' : code}`
  return (SD_MODERATION_LANGUAGES as readonly string[]).includes(own) ? (own as SdModerationLanguage) : 'en-US'
}

/** Ids per filter, comma-joined in the query string. */
const FILTER_CHUNK = 50
/** Amazon's page size for these lists (`count`, at most 100). */
const PAGE = 100
/** Pages read per filter chunk: 2,000 creatives, far above one per ad group. */
const MAX_PAGES = 20

const str = (v: unknown): string | null => (v == null || String(v) === '' ? null : String(v))
const typeOf = (v: unknown): SdCreativeType | null => (v === 'IMAGE' || v === 'VIDEO' ? v : null)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** GET one SD 3.0 list, every page, for the ids of one filter (`adGroupIdFilter` or `creativeIdFilter`). */
async function sdPages<T>(ctx: ClientContext, resource: string, filter: { name: string; ids: string[] }, extra: Record<string, string> = {}): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < filter.ids.length; i += FILTER_CHUNK) {
    const chunk = filter.ids.slice(i, i + FILTER_CHUNK)
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ ...extra, [filter.name]: chunk.join(','), startIndex: String(page * PAGE), count: String(PAGE) })
      const res = await liveCall<T[]>({
        profileId: ctx.profileId, region: ctx.region, method: 'GET', path: `${resource}?${query.toString()}`,
        contentType: 'application/json', acceptHeader: 'application/json',
      })
      const items = Array.isArray(res) ? res : []
      out.push(...items)
      if (items.length < PAGE) break
    }
  }
  return out
}

function filterOf(opts: { externalAdGroupIds?: readonly string[]; creativeIds?: readonly string[] }): { name: string; ids: string[] } | null {
  if (opts.creativeIds?.length) return { name: 'creativeIdFilter', ids: [...new Set(opts.creativeIds)] }
  if (opts.externalAdGroupIds?.length) return { name: 'adGroupIdFilter', ids: [...new Set(opts.externalAdGroupIds)] }
  return null
}

/** Amazon's creative, as Nexus keeps reading it. */
export function sdCreativeOf(raw: unknown): SdCreative | null {
  const r = obj(raw)
  const creativeId = str(r.creativeId)
  const adGroupId = str(r.adGroupId)
  if (!creativeId || !adGroupId) return null
  return { creativeId, adGroupId, creativeType: typeOf(r.creativeType), properties: obj(r.properties) as SdCreativeProperties, moderationStatus: str(r.moderationStatus) }
}

/**
 * The creatives of these ad groups (Amazon's ids), or of these creatives. Nothing named → nothing read (an unfiltered GET
 * would read every creative of the account). Sandbox: none.
 */
export async function listSdCreatives(ctx: ClientContext, opts: { externalAdGroupIds?: readonly string[]; creativeIds?: readonly string[] }): Promise<SdCreative[]> {
  if (adsMode() === 'sandbox') return []
  const filter = filterOf(opts)
  if (!filter) return []
  return (await sdPages<unknown>(ctx, '/sd/creatives', filter)).map(sdCreativeOf).filter((c): c is SdCreative => c !== null)
}

/** The moderation of the creatives of these ad groups (or of these creatives), in `language`. Sandbox: none. */
export async function listSdCreativeModerations(
  ctx: ClientContext,
  opts: { externalAdGroupIds?: readonly string[]; creativeIds?: readonly string[]; language: SdModerationLanguage },
): Promise<SdCreativeModeration[]> {
  if (adsMode() === 'sandbox') return []
  const filter = filterOf(opts)
  if (!filter) return []
  const raw = await sdPages<unknown>(ctx, '/sd/moderation/creatives', filter, { language: opts.language })
  const out: SdCreativeModeration[] = []
  for (const item of raw) {
    const r = obj(item)
    const creativeId = str(r.creativeId)
    if (!creativeId) continue
    out.push({
      creativeId, creativeType: typeOf(r.creativeType), moderationStatus: str(r.moderationStatus), etaForModeration: str(r.etaForModeration),
      policyViolations: Array.isArray(r.policyViolations) ? (r.policyViolations as SdPolicyViolation[]) : [],
    })
  }
  return out
}

/**
 * Each ad group's creativeType at Amazon (IMAGE | VIDEO; null when Amazon states none — Amazon then uses IMAGE), by
 * Amazon's ad group id. Sandbox: none.
 */
export async function listSdAdGroupCreativeTypes(ctx: ClientContext, externalAdGroupIds: readonly string[]): Promise<Map<string, SdCreativeType | null>> {
  const out = new Map<string, SdCreativeType | null>()
  if (adsMode() === 'sandbox' || !externalAdGroupIds.length) return out
  const raw = await sdPages<unknown>(ctx, '/sd/adGroups', { name: 'adGroupIdFilter', ids: [...new Set(externalAdGroupIds)] })
  for (const item of raw) {
    const r = obj(item)
    const id = str(r.adGroupId)
    if (id) out.set(id, typeOf(r.creativeType))
  }
  return out
}

// ── Writes ──────────────────────────────────────────────────────────────────────────────────────────

const imageOut = (i: SdImage | undefined): SdImage | undefined =>
  i ? { assetId: i.assetId, assetVersion: i.assetVersion, ...(i.croppingCoordinates ? { croppingCoordinates: { ...i.croppingCoordinates } } : {}) } : undefined
const videoOut = (v: SdVideo | undefined): SdVideo | undefined => (v ? { assetId: v.assetId, assetVersion: v.assetVersion } : undefined)

/**
 * The properties as they are sent: Amazon's own read-only fields (`originalHeadline`, a video's `originalAsset…`) left
 * out, and nothing empty. The same function makes what Nexus compares, so a creative read back equals the one sent.
 */
export function sendableSdProperties(p: SdCreativeProperties): SdCreativeProperties {
  const out: SdCreativeProperties = {}
  if (typeof p.headline === 'string') out.headline = p.headline
  if (typeof p.hasTermsAndConditions === 'boolean') out.hasTermsAndConditions = p.hasTermsAndConditions
  for (const key of ['brandLogo', 'rectCustomImage', 'squareCustomImage'] as const) {
    const image = imageOut(p[key])
    if (image) out[key] = image
  }
  for (const key of ['squareImages', 'horizontalImages', 'verticalImages'] as const) {
    const list = (p[key] ?? []).map(imageOut).filter((i): i is SdImage => !!i)
    if (list.length) out[key] = list
  }
  const video = videoOut(p.video)
  if (video) out.video = video
  for (const key of ['squareVideos', 'horizontalVideos', 'verticalVideos'] as const) {
    const list = (p[key] ?? []).map(videoOut).filter((v): v is SdVideo => !!v)
    if (list.length) out[key] = list
  }
  const backgrounds = (p.backgrounds ?? []).filter((b) => typeof b?.color === 'string').map((b) => ({ color: b.color }))
  if (backgrounds.length) out.backgrounds = backgrounds
  return out
}

/** What a creative write sends, built apart from the call so its shape is testable without a network. */
export interface SdCreativeRequest {
  method: 'POST' | 'PUT'
  path: '/sd/creatives'
  body: Array<Record<string, unknown>>
}

/** SD 3.0 `createCreatives` — `[{ adGroupId (int64), creativeType, properties, consentToTranslate? }]`. */
export function sdCreativeCreateRequest(input: { externalAdGroupId: string; creativeType: SdCreativeType; properties: SdCreativeProperties; consentToTranslate?: boolean }): SdCreativeRequest {
  return {
    method: 'POST',
    path: '/sd/creatives',
    body: [{
      adGroupId: amazonIntId(input.externalAdGroupId), creativeType: input.creativeType, properties: sendableSdProperties(input.properties),
      ...(input.consentToTranslate === true ? { consentToTranslate: true } : {}),
    }],
  }
}

/** SD 3.0 `updateCreatives` — `[{ creativeId (int64), creativeType, properties }]`: the creative's whole new properties. */
export function sdCreativeUpdateRequest(input: { creativeId: string; creativeType: SdCreativeType; properties: SdCreativeProperties }): SdCreativeRequest {
  return { method: 'PUT', path: '/sd/creatives', body: [{ creativeId: amazonIntId(input.creativeId), creativeType: input.creativeType, properties: sendableSdProperties(input.properties) }] }
}

/**
 * Amazon's answer to one creative write (207, `[{ code, description, creativeId }]`): a create is made when it carries the
 * new id (sdCreateResult, as every SD create reads it); an update when every item says SUCCESS. Otherwise Amazon's code
 * and description.
 */
export function sdCreativeResult(response: unknown, method: SdCreativeRequest['method']): { ok: boolean; creativeId: string | null; error: string | null } {
  if (method === 'POST') {
    const made = sdCreateResult(response, 'creativeId')
    return { ok: made.externalId != null, creativeId: made.externalId, error: made.error }
  }
  const parsed = sbSdItemsResult(response)
  if (!parsed.ok) return { ok: false, creativeId: null, error: parsed.error }
  const first = (Array.isArray(response) ? response[0] : response) as Record<string, unknown> | undefined
  const creativeId = str(first?.creativeId)
  return creativeId ? { ok: true, creativeId, error: null } : { ok: false, creativeId: null, error: SBSD_ANSWER_NOT_UNDERSTOOD }
}

/** Amazon's code and words from a call it refused (a thrown Ads error: `statusCode` and the body Amazon sent). */
export function sdAmazonErrorWords(error: unknown): string {
  const e = error as { statusCode?: unknown; body?: unknown; message?: unknown } | null
  const status = typeof e?.statusCode === 'number' ? e.statusCode : null
  let said: string | null = null
  if (typeof e?.body === 'string' && e.body.trim()) {
    try {
      const body = JSON.parse(e.body) as Record<string, unknown>
      const words = [body.code, body.details ?? body.description ?? body.message].filter((v) => typeof v === 'string' && v.trim()).join(' — ')
      said = words || e.body.trim()
    } catch {
      said = e.body.trim()
    }
  }
  const text = said ?? (typeof e?.message === 'string' ? e.message : String(error))
  return `${status ? `Amazon answered HTTP ${status}: ` : ''}${text}`.slice(0, 400)
}

export interface SdCreativeWriteResult {
  ok: boolean
  mode: AdsMode
  creativeId: string | null
  error: string | null
  /** A create whose answer was lost, found on Amazon by reading the ad group back. */
  recoveredByReadBack?: true
}

/**
 * Send one creative write. Sandbox sends nothing (a create gets a sandbox id). A create is sent once: when Amazon's answer
 * is lost, the ad group is read back, and a creative there is the one this create made (an ad group holds one).
 */
export async function sendSdCreativeWrite(ctx: ClientContext, request: SdCreativeRequest, opts: { externalAdGroupId: string }): Promise<SdCreativeWriteResult> {
  const updatedId = request.method === 'PUT' ? str(request.body[0]?.creativeId) : null
  if (adsMode() === 'sandbox') {
    logger.info('[ADS-SANDBOX] sd creative', { profileId: ctx.profileId, method: request.method, body: request.body })
    return { ok: true, mode: 'sandbox', creativeId: updatedId ?? `sandbox-creative-${randomUUID().slice(0, 8)}`, error: null }
  }
  try {
    const response = await liveCall<unknown>({
      ...ctx, method: request.method, path: request.path, body: request.body, contentType: 'application/json', acceptHeader: 'application/json',
      ...(request.method === 'POST' ? { noServerErrorRetry: true } : {}),
    })
    return { ...sdCreativeResult(response, request.method), mode: 'live' }
  } catch (error) {
    if (request.method === 'POST' && createOutcomeUnknown(error)) {
      const found = await listSdCreatives(ctx, { externalAdGroupIds: [opts.externalAdGroupId] }).catch(() => null)
      if (found?.length) {
        logger.warn('[SD-CREATIVES] create answered without confirmation, found on Amazon by read-back — linked, not sent again', { externalAdGroupId: opts.externalAdGroupId })
        return { ok: true, mode: 'live', creativeId: found[0].creativeId, error: null, recoveredByReadBack: true }
      }
      return { ok: false, mode: 'live', creativeId: null, error: `Amazon did not confirm the creative (${sdAmazonErrorWords(error)}), and it is not on the ad group. It was not sent again: ask again to try.` }
    }
    return { ok: false, mode: 'live', creativeId: null, error: sdAmazonErrorWords(error) }
  }
}

// ── Preview ─────────────────────────────────────────────────────────────────────────────────────────

/** The slot sizes Amazon renders an SD creative in (the spec's CreativePreviewConfiguration), `<width>x<height>`. */
export const SD_PREVIEW_SIZES = ['300x250', '650x130', '245x250', '414x125', '600x160', '600x300', '728x90', '980x55', '320x50', '970x250', '270x150', '160x600', '300x600'] as const
export type SdPreviewSize = (typeof SD_PREVIEW_SIZES)[number]

export interface SdPreviewInput {
  creativeType: SdCreativeType
  properties: SdCreativeProperties
  size: SdPreviewSize
  asin: string
  isMobile: boolean
  isOnAmazon: boolean
}

/** SD 3.0 `getCreativePreview` body (POST /sd/creatives/preview). Pure. */
export function sdCreativePreviewBody(input: SdPreviewInput): Record<string, unknown> {
  const [width, height] = input.size.split('x').map(Number)
  return {
    creative: { creativeType: input.creativeType, properties: sendableSdProperties(input.properties) },
    previewConfiguration: { size: { width, height }, products: [{ asin: input.asin }], isMobile: input.isMobile, isOnAmazon: input.isOnAmazon },
  }
}

/** The HTML Amazon renders for a creative (a read). Sandbox: null (nothing is asked). */
export async function previewSdCreative(ctx: ClientContext, input: SdPreviewInput): Promise<{ previewHtml: string; previewHtmls: string[] } | null> {
  if (adsMode() === 'sandbox') return null
  const res = await liveCall<{ previewHtml?: unknown; previewHtmls?: unknown }>({
    ...ctx, method: 'POST', path: '/sd/creatives/preview', body: sdCreativePreviewBody(input), contentType: 'application/json', acceptHeader: 'application/json',
  })
  return {
    previewHtml: typeof res?.previewHtml === 'string' ? res.previewHtml : '',
    previewHtmls: Array.isArray(res?.previewHtmls) ? res.previewHtmls.filter((h): h is string => typeof h === 'string') : [],
  }
}
