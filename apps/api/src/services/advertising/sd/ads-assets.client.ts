/**
 * SD creatives (2026-10-20) — the account's Creative Asset Library (Amazon Ads "Creative assets" 3.0): the images and
 * videos a creative is made from. A Sponsored Display creative names an asset by its id and version
 * (`amzn1.assetlibrary.asset1.…`); Nexus had no client for the library before (the SB builder borrows a logo id from an
 * existing SB ad, ads-create.service.ts resolveSbTemplate).
 *
 *   POST /assets/search     the account's assets: text (name, tags, ASINs), type and sub-type filters, newest first
 *   GET  /assets            one asset with its versions (size, type, status, Amazon's spec checks and moderation)
 *   POST /assets/upload     an upload location: a pre-signed storage URL, valid 15 minutes, for one file
 *   PUT  <upload location>  the file itself — the one send outside the gateway (gateway-exempt: a pre-signed upload)
 *   POST /assets/register   the uploaded file as an asset of the account (IMAGE with one sub-type) → assetId, versionId
 *
 * Every call but the PUT goes through the Ads client's `liveCall` (the channel gateway). Sandbox sends nothing and reads
 * nothing. The upload location carries a signature: it is never logged or returned by this file, and it is sent only
 * to register the file it was made for.
 */
import { randomUUID } from 'node:crypto'
import { logger } from '../../../utils/logger.js'
import { adsMode, liveCall, type AdsMode, type ClientContext } from '../ads-api-client.js'

const GET_MIME = 'application/vnd.creativeassetsgetresponse.v3+json'
const SEARCH_MIME = 'application/vnd.creativeassetssearchassetsresponse.v3+json'
const UPLOAD_MIME = 'application/vnd.creativeassetsuploadresponse.v3+json'
const REGISTER_MIME = 'application/vnd.creativeassetsregisterresponse.v3+json'
const PUT_TIMEOUT_MS = 60_000

export type AdsAssetType = 'IMAGE' | 'VIDEO'
/** The image sub-types Amazon registers (a video's is BACKGROUND_VIDEO). */
export const ADS_IMAGE_SUB_TYPES = ['LOGO', 'PRODUCT_IMAGE', 'LIFESTYLE_IMAGE', 'OTHER_IMAGE'] as const
export type AdsImageSubType = (typeof ADS_IMAGE_SUB_TYPES)[number]

/** One asset (one version of it), as Nexus reads it from the library. */
export interface AdsAsset {
  assetId: string
  version: string | null
  name: string | null
  assetType: string | null
  subTypes: string[]
  /** ACTIVE | PROCESSING | ARCHIVED. */
  status: string | null
  width: number | null
  height: number | null
  bytes: number | null
  contentType: string | null
  extension: string | null
  createdAt: string | null
  tags: string[]
  /** Where the file can be seen, when Amazon gives an address that carries no signature. */
  url: string | null
  /** Amazon's own checks per ad program that failed, in its words. */
  failedSpecChecks: string[]
  /** Amazon's moderation per policy (e.g. `{ Logo: 'APPROVED' }`), when it says. */
  moderation: Record<string, string> | null
}

const str = (v: unknown): string | null => (v == null || String(v) === '' ? null : String(v))
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const time = (v: unknown): string | null => {
  const n = num(v)
  return n == null ? null : new Date(n).toISOString()
}
/** An address without a query string (a pre-signed one carries its signature there). */
const plainUrl = (v: unknown): string | null => {
  const s = str(v)
  return s && /^https:\/\//.test(s) && !s.includes('?') ? s : null
}

/** Amazon's spec checks that failed (`[{ specProgramName, specifications: [{ isPassed, failureReason, … }] }]`), in words. */
function failedChecks(v: unknown): string[] {
  const out: string[] = []
  for (const program of Array.isArray(v) ? v : []) {
    const p = obj(program)
    for (const spec of Array.isArray(p.specifications) ? p.specifications : []) {
      const s = obj(spec)
      if (s.isPassed === true) continue
      const words = [str(p.specProgramName), str(s.failureReason) ?? str(s.stringId), s.actualValue != null ? `(it is ${String(s.actualValue)})` : null].filter(Boolean).join(': ')
      if (words) out.push(words)
    }
  }
  return out
}

function assetOf(raw: unknown, fallback: { assetId?: string | null } = {}): AdsAsset | null {
  const r = obj(raw)
  const identifier = obj(r.assetIdentifier)
  const assetId = str(r.assetId) ?? str(identifier.assetId) ?? fallback.assetId ?? null
  if (!assetId) return null
  const file = obj(r.fileMetadata)
  const storage = obj(r.storageLocationUrls)
  const moderation = obj(r.moderationPolicyMap)
  return {
    assetId,
    version: str(r.version) ?? str(identifier.version),
    name: str(r.name),
    assetType: str(r.assetType),
    subTypes: strings(r.assetSubTypes),
    status: str(r.status) ?? str(r.assetStatus),
    width: num(file.width) ?? num(file.resolutionWidth),
    height: num(file.height) ?? num(file.resolutionHeight),
    bytes: num(file.fileSize),
    contentType: str(file.contentType),
    extension: str(file.extension),
    createdAt: time(r.creationTime),
    tags: strings(r.tags),
    url: plainUrl(storage.defaultUrl) ?? plainUrl(r.url),
    failedSpecChecks: failedChecks(r.failedSpecChecks),
    moderation: Object.keys(moderation).length ? Object.fromEntries(Object.entries(moderation).map(([k, v]) => [k, String(v)])) : null,
  }
}

export interface AdsAssetSearch {
  text?: string
  assetType?: AdsAssetType
  subTypes?: readonly string[]
  pageSize: number
  /** Amazon's token of the page before. */
  token?: string
}

/** The search body (caSearchRequestCommon), newest first. Pure. */
export function adsAssetSearchBody(input: AdsAssetSearch): Record<string, unknown> {
  const valueFilters = [
    ...(input.assetType ? [{ valueField: 'ASSET_TYPE', values: [input.assetType] }] : []),
    ...(input.subTypes?.length ? [{ valueField: 'ASSET_SUB_TYPE', values: [...input.subTypes] }] : []),
  ]
  return {
    ...(input.text ? { text: input.text } : {}),
    ...(valueFilters.length ? { filterCriteria: { valueFilters } } : {}),
    sortCriteria: { field: 'CREATED_TIME', order: 'DESC' },
    pageCriteria: { size: input.pageSize, ...(input.token ? { identifier: { token: input.token } } : {}) },
  }
}

/** The account's assets, one Amazon page. Sandbox: none. */
export async function searchAdsAssets(ctx: ClientContext, input: AdsAssetSearch): Promise<{ assets: AdsAsset[]; total: number | null; token: string | null }> {
  if (adsMode() === 'sandbox') return { assets: [], total: 0, token: null }
  const res = await liveCall<{ totalRecords?: unknown; assetList?: unknown; token?: unknown }>({
    ...ctx, method: 'POST', path: '/assets/search', body: adsAssetSearchBody(input), contentType: 'application/json', acceptHeader: SEARCH_MIME,
  })
  const assets = (Array.isArray(res?.assetList) ? res.assetList : []).map((a) => assetOf(a)).filter((a): a is AdsAsset => a !== null)
  return { assets, total: num(res?.totalRecords), token: str(res?.token) }
}

/**
 * One asset: the version asked for, else its newest, with every version Amazon lists. Null when Amazon answers with no
 * version of it. Sandbox: null.
 */
export async function getAdsAsset(ctx: ClientContext, assetId: string, version?: string | null): Promise<{ asset: AdsAsset; versions: string[] } | null> {
  if (adsMode() === 'sandbox') return null
  const query = new URLSearchParams({ assetId, ...(version ? { version } : {}) })
  const res = await liveCall<{ assetGlobal?: unknown; assetVersionList?: unknown }>({
    ...ctx, method: 'GET', path: `/assets?${query.toString()}`, acceptHeader: GET_MIME,
  })
  const global = obj(res?.assetGlobal)
  const list = (Array.isArray(res?.assetVersionList) ? res.assetVersionList : [])
    .map((v) => assetOf(v, { assetId }))
    .filter((a): a is AdsAsset => a !== null)
    .map((a) => ({ ...a, assetType: a.assetType ?? str(global.assetType) }))
  if (!list.length) return null
  const picked = (version ? list.find((a) => a.version === version) : null)
    ?? [...list].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0]
  return { asset: picked, versions: list.map((a) => a.version).filter((v): v is string => !!v) }
}

// ── Upload ──────────────────────────────────────────────────────────────────────────────────────────

export interface AdsImageUpload {
  /** `<word characters>.png|.jpg` — Amazon's own pattern for the file name. */
  fileName: string
  /** The asset's name in the library. */
  name: string
  subType: AdsImageSubType
  bytes: Buffer
  mimeType: 'image/jpeg' | 'image/png'
  tags?: readonly string[]
}

/** The register body (registerAsset) for an uploaded image. Pure. */
export function adsAssetRegisterBody(uploadUrl: string, input: Pick<AdsImageUpload, 'name' | 'subType' | 'tags'>): Record<string, unknown> {
  return {
    url: uploadUrl,
    name: input.name,
    assetType: 'IMAGE',
    assetSubTypeList: [input.subType],
    ...(input.tags?.length ? { tags: [...input.tags] } : {}),
    // The sub-type the person chose stays: without it Amazon may file a logo as another kind of image.
    skipAssetSubTypesDetection: true,
  }
}

/** Amazon's storage only: an https address on amazonaws.com. */
function storageUrlProblem(url: string): string | null {
  let target: URL
  try { target = new URL(url) } catch { return 'Amazon gave no upload address Nexus can read' }
  if (target.protocol !== 'https:' || !/(^|\.)amazonaws\.com$/.test(target.hostname)) return 'Amazon gave an upload address outside its storage'
  return null
}

/** The file to Amazon's pre-signed upload location (PUT). Nothing about the address leaves this function. */
async function putToStorage(url: string, input: AdsImageUpload): Promise<void> {
  const problem = storageUrlProblem(url)
  if (problem) throw new Error(`${problem}; Nexus sends no file there, and nothing was added to the library.`)
  let res: Response
  try {
    // gateway-exempt: pre-signed upload of a creative asset to Amazon's storage (the location from POST /assets/upload, which goes through the gateway)
    res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': input.mimeType }, body: new Uint8Array(input.bytes), redirect: 'error', signal: AbortSignal.timeout(PUT_TIMEOUT_MS) })
  } catch {
    throw new Error("Amazon's asset storage did not answer; nothing was added to the library.")
  }
  if (!res.ok) throw new Error(`Amazon's asset storage refused the file (HTTP ${res.status}); nothing was added to the library.`)
}

export interface AdsAssetUploadResult {
  mode: AdsMode
  assetId: string
  versionId: string
  /** Amazon's spec checks the new asset failed, in its words (it is registered anyway). */
  failedSpecChecks: string[]
}

/**
 * One image into the account's library: an upload location, the file, the registration. Sandbox: nothing is sent and a
 * sandbox id comes back. A failure throws with Amazon's words; a failure after the file was stored names that it was not
 * registered (Amazon keeps an unregistered upload nowhere a creative can use).
 */
export async function uploadAdsImageAsset(ctx: ClientContext, input: AdsImageUpload): Promise<AdsAssetUploadResult> {
  if (adsMode() === 'sandbox') {
    logger.info('[ADS-SANDBOX] creative asset upload', { profileId: ctx.profileId, fileName: input.fileName, subType: input.subType, bytes: input.bytes.byteLength })
    return { mode: 'sandbox', assetId: `sandbox-asset-${randomUUID().slice(0, 8)}`, versionId: 'version_v1', failedSpecChecks: [] }
  }
  const location = await liveCall<{ url?: unknown }>({
    ...ctx, method: 'POST', path: '/assets/upload', body: { fileName: input.fileName }, contentType: 'application/json', acceptHeader: UPLOAD_MIME,
  })
  const url = str(location?.url)
  if (!url) throw new Error('Amazon answered without an upload location; nothing was uploaded.')
  await putToStorage(url, input)
  const registered = await liveCall<{ assetId?: unknown; versionId?: unknown; failedSpecChecks?: unknown }>({
    ...ctx, method: 'POST', path: '/assets/register', body: adsAssetRegisterBody(url, input), contentType: 'application/json', acceptHeader: REGISTER_MIME,
  })
  const assetId = str(registered?.assetId)
  if (!assetId) throw new Error('Amazon stored the file but answered the registration without an asset id, so Nexus cannot confirm the asset exists. Search the library with ad-assets before uploading it again.')
  return { mode: 'live', assetId, versionId: str(registered?.versionId) ?? 'version_v1', failedSpecChecks: failedChecks(registered?.failedSpecChecks) }
}
