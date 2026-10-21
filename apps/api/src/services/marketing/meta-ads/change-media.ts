/**
 * Meta step 23 (2026-10-21) — create-meta-media as drafts (master rows BM-058, MD-003, MD-004, MD-006, MD-010…017,
 * MD-020, MD-021, MD-024, MD-026, MD-029; facts F1 M5-01…M5-10; Owner decision D3 B): put an image, a video or a folder
 * into the business's chosen Meta ad account / its portfolio's media library, and take back what such an upload made new.
 * Each draft is built from the request and what Meta holds NOW (reads only, through the gateway); the requests carry their
 * own senders (write client → gateway: the write allow-list in gateway/meta-media-rules.ts, the chosen-account checks).
 *
 *   image   bytes (MD-003) of an image Nexus ALREADY holds for this business (its image library `da_…` or a product
 *           photo `pi_…`, image-library lists them; row-level security keeps every other business's out) or of a public
 *           https link a person gives — fetched only through Nexus's one public-address fetch (images/photo-from-url
 *           fetchPhoto → net/safe-fetch: https on every hop, public addresses only, bounded time and bytes), never a local
 *           path. JPG or PNG, at most 8 MB (Meta's creative-edge cap, F1 M5-01; Meta states none for `bytes`). MD-004 (a
 *           multipart file on the same edge) gives the same AdImage and hash: covered by MD-003. Meta gives the SAME hash
 *           to the same bytes, so "was it new?" is read before the upload: the library is asked for the image's MD5 (Meta's
 *           hash IS the MD5 of the file in every example Nexus has seen — UNVERIFIED, LIVE-PROBES MD-003a); new only when
 *           Meta's hash equals that MD5 and the library did not hold it. Otherwise "not proven new" — its undo never
 *           deletes it. MD-006 (copy_from another ad account) is refused in words: Nexus works with ONE ad account per
 *           business and cannot prove another account is this business's own.
 *   video   D3 B, in the Owner's order: (1) Meta fetches a public https link itself — a video of the business's Nexus
 *           library (its link) or one a person gives — `file_url` on POST /act_<id>/advideos (MD-010; Nexus fetches and
 *           relays nothing), or the same link through Meta's v26 video-ads upload (MD-015…017: start, the link as the
 *           `file_url` header on rupload.facebook.com, finish); (2) a video of the business's chosen Instagram account
 *           (`source_instagram_media_id`, MD-020), optionally with its music swapped for Meta Sound Collection audio
 *           (`selected_audio_spec`, MD-021, polled with `replace_audio_status`); (3) when Meta refuses the system user,
 *           the answer says how the Owner uploads it in Meta's screens. Meta's upload returns before processing ends: the
 *           run polls `status.video_status` (M5-08) and says ready / processing / error. MD-011…014 (chunked bytes) are a
 *           plain answer: Nexus holds its videos as files at public links (its media library takes images and videos,
 *           stored at Cloudinary links — routes/assets.routes.ts UPLOAD_VIDEO_MIME_TYPES), so Meta fetches them; no video
 *           byte travels through Nexus.
 *   folder  BM-058: a folder in the business portfolio's media library (POST /<portfolio>/creative_folders: name,
 *           description, parent_folder_id — SDK business.py; the reference's Creating section is empty, RECHECK BM-058:
 *           Meta's answer decides, LIVE-PROBES BM-058). Refused when another Nexus business uses an ad account of the same
 *           portfolio (step 10's PORTFOLIO_TAKEN). Meta has no update or delete for a folder: it stays (no undo).
 *   undo    takes back what an earlier create-meta-media upload of this business made NEW in this ad account — and only
 *           that (its change record says so; an image that was already there is never deleted): an image by its hash
 *           (DELETE /act_<id>/adimages hash, only while no creative uses it — M5-03), a video by its id (DELETE
 *           /act_<id>/advideos video_id — M5-09; review A1: only while no creative of the account uses it, read first; review
 *           B3: the library is read on advideos AND video_ads), a caption locale by `locales_to_delete`. Every removal goes
 *           through step 22's rules (gateway meta-remove-rules.ts: image.delete, video.remove, captions.delete, which also
 *           confirm a video by the chosen account's advideos list); only the default caption put back after a caption
 *           locale came off is step 23's own call (video.captions.default). Meta cannot put a removed file back: re-upload it.
 *   captions MD-026 (review B1: "User has advertiser access on account that owns the video", docs/graph-api/reference/video/
 *           captions): an SRT text the person gives (UTF-8, at most 200 KB, SubRip's shape) and its locale, onto a video of the
 *           chosen account's library — POST /<video id>/captions with `captions_file` (`<name>.<locale>.srt`, a multipart
 *           file part the gateway itself encodes: MetaWriteRule.file) and `default_locale` (a locale or none). Meta takes a
 *           locale once (482), so an upload is always new; Meta has no DELETE there: its undo is `locales_to_delete` on the
 *           same edge, then the default put back by a call of its own when Nexus read it before (MD-027, MD-027d).
 * Plain answers (no call): MD-024 thumbnails only for a video associated with a Page ("Thumbnails can only be created on
 * Videos that have been associated with a Page"; it comes with step 24's Page step; a creative sets its video's thumbnail
 * itself), MD-029 Nexus holds no HTML5 playable files.
 *
 * Nothing here spends money: an image, a video or a folder is used only once a creative and an ad use it. Meta has no check
 * (validate_only) on any of these edges (reference/ad-account/adimages, advideos, video_ads guide, business/creative_folders
 * list no execution_options): the preview says so.
 */
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import prisma from '../../../db.js'
import { fetchPhoto, PhotoUrlError } from '../../images/photo-from-url.service.js'
import { libraryImageLink } from '../google-ads/asset-images.js'
import { META_CAPTIONS_FILE_NAME, META_IMAGE_MAX_BYTES, META_LOCALE, META_MEDIA_LIST_MAX, META_MEDIA_TEXT, metaFileUrlProblem, metaLinkSecretProblem, metaMediaTextProblem, metaSrtProblem } from '../../gateway/meta-media-rules.js'
import { changeLines, plural, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import type { MetaChangeAccount } from './change-account.js'
import { metaSendChange, metaSendRupload, MetaWriteError, META_UNKNOWN_OUTCOME, type MetaChangeResult, type MetaWriteTarget } from './write-client.js'
import { localFailure } from './errors.js'
import { metaReadOne } from './read-client.js'
import { metaChosenAccount, MetaLiveRefusal } from './live.js'
import { ownMedia, videoStatusText } from './live-media.js'
import { fieldRefused, listPaged } from './live-objects.js'
import { takenIds } from './taken.js'

export const MEDIA_KINDS = ['image', 'video', 'folder', 'undo', 'thumbnail', 'captions', 'playable'] as const
export type MediaKind = typeof MEDIA_KINDS[number]
export const VIDEO_METHODS = ['advideos', 'video_ads', 'chunked'] as const
export type VideoMethod = typeof VIDEO_METHODS[number]
/** At most this many images per request: each is fetched and checked at the preview, the re-check and the run. */
export const MAX_IMAGES = 5
/** At most this many uploads taken back per request. */
export const MAX_UNDO = 10
/** Meta's ads guide takes JPG and PNG images. */
export const META_IMAGE_TYPES = ['image/jpeg', 'image/png'] as const
export const MEDIA_TOOL = 'create-meta-media'

// ── plain answers (no call) ─────────────────────────────────────────────────────────────────────────────────────────

/** MD-024 — checked 2026-10-21: developers.facebook.com/docs/graph-api/reference/video/thumbnails (F1 M5-10). */
export const THUMBNAIL_ANSWER = 'Meta takes a custom video thumbnail (POST /<video id>/thumbnails) only for a video associated with a Facebook Page ("Thumbnails can only be created on Videos that have been associated with a Page"), so this upload comes with Nexus\'s Page step (step 24). For an ad you do not need it: the creative sets its video\'s thumbnail itself (video_data image_hash) — upload the picture with kind image and use its hash in the creative.'
/** MD-029 — checked 2026-10-21: reference/ad-account/adplayables.md; routes/assets.routes.ts (Nexus's library takes images and videos only). */
export const PLAYABLE_ANSWER = 'Nexus holds no HTML5 playable files (its media library takes images and videos only), so it uploads no playable.'
/** MD-011…MD-014 — checked 2026-10-21: reference/ad-account/advideos.md (upload_phase start, transfer, finish, cancel; RECHECK: the sequence is documented nowhere). */
export const CHUNKED_ANSWER = 'Meta\'s chunked upload (advideos upload_phase start, transfer, finish, cancel) sends a video\'s bytes from the sender\'s own disk in pieces. Nexus holds its videos as files at public https links (its media library), so Meta fetches them itself and no video byte travels through Nexus: use method advideos (Meta fetches the link) or video_ads (Meta\'s resumable upload of the same link).'
/** MD-006 — reference/ad-image.md "Copying Images": the token's user must read the source account; Nexus: one ad account per business. */
export const COPY_ANSWER = 'Nexus works with ONE Meta ad account per business — the one chosen in Settings › Channels › Meta — and cannot prove another ad account is this business\'s own (an account another business chose is never touched), so it copies no image between ad accounts. Upload the same picture from Nexus\'s image library instead: Meta gives the same picture the same hash in this account.'
/** D3 B step 3 — when Meta refuses the system user's video upload. */
export const OWNER_UPLOAD_STEPS = 'Meta did not let the business\'s system user upload this video (its v26 guide: system users cannot yet upload videos to business accounts). The Owner uploads it in Meta\'s own screens instead: Meta Business Suite › All tools › Media library (or Ads Manager › the ad account\'s media) › Upload › the video file. It then shows in meta-media-library view videos with its id, ready for a creative.'

// ── timing (tests set sleep to resolve at once) ─────────────────────────────────────────────────────────────────────

/** How the run waits for Meta's video processing: at most `polls` reads, `pollMs` apart. */
export const __mediaTiming = {
  pollMs: 5_000,
  polls: 6,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}

// ── the request and its record ──────────────────────────────────────────────────────────────────────────────────────

export interface ImageSource { libraryImageId?: string | null; imageUrl?: string | null }
export interface VideoSource {
  libraryVideoId?: string | null
  videoUrl?: string | null
  instagramMediaId?: string | null
  method?: VideoMethod | null
  name?: string | null
  title?: string | null
  description?: string | null
  swapAudioAssetId?: string | null
}
/**
 * What an undo takes back: an image by its hash, a video by its id, a caption locale of a video (with the default
 * locale to put back, when the upload set one and Nexus read the one before).
 */
export type UploadRef =
  | { kind: 'image'; hash: string }
  | { kind: 'video'; videoId: string }
  | { kind: 'captions'; videoId: string; locale: string; restoreDefault?: string | null }
export interface CaptionsSource { videoId: string; locale: string; srt: string; fileName?: string | null; defaultLocale?: string | null }
export interface MediaUploadRequest {
  kind: 'image' | 'video' | 'folder' | 'captions' | 'undo'
  images?: ImageSource[]
  video?: VideoSource
  folder?: { name: string; description?: string | null; parentFolderId?: string | null }
  captions?: CaptionsSource
  uploads?: UploadRef[]
}

/** One upload as recorded (AgentChange after; undo reads it). Only facts that do not move with time. */
export type MediaRecordItem =
  | { kind: 'image'; source: string; hash: string; new: boolean | null }
  | { kind: 'video'; source: string; videoId: string; method: 'advideos' | 'video_ads'; new: boolean | null }
  | { kind: 'folder'; folderId: string; name: string; portfolioId: string }
  | { kind: 'captions'; videoId: string; locale: string; new: true; setDefault: string | null; defaultBefore: string | null }
export interface MediaRecord { kind: 'image' | 'video' | 'folder' | 'captions' | 'undo'; items: Array<MediaRecordItem | (UploadRef & { removed?: true; present?: true })> }

/** The draft, with what the run's finish needs about each request (never recorded as is). */
export interface MediaDraft extends MetaChangeDraft {
  media: {
    kind: MediaUploadRequest['kind']
    byStep: Map<number, { source: string; label: string }>
    /** Captions: the default the upload sets, and the one before it (null when Nexus could not read it). */
    captions?: { setDefault: string | null; defaultBefore: string | null }
  }
}

// ── images ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PreparedMetaImage {
  source: string
  label: string
  mimeType: typeof META_IMAGE_TYPES[number]
  bytes: number
  width: number
  height: number
  sha256: string
  md5: string
  /**
   * The file itself — held as bytes only (review A6, memory): its Base64 is made at send time, one image at a time, and
   * never stored, logged, shown or hashed for the plan (the plan holds its sha256).
   */
  buffer: Buffer
}

const fileNameOf = (link: string): string | null => {
  try {
    const last = new URL(link).pathname.split('/').filter(Boolean).pop() ?? ''
    return decodeURIComponent(last).replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 80) || null
  } catch { return null }
}

/**
 * An image ready for Meta, or why not (nothing was sent to Meta): a library image of THIS business (google-ads
 * asset-images.ts libraryImageLink: the business's rows only) or a public https link, fetched only through fetchPhoto
 * (the one public-address fetch), at most 8 MB, JPG or PNG by its own bytes, width and height read from the file.
 */
export async function prepareMetaImage(source: ImageSource): Promise<PreparedMetaImage | { problem: string }> {
  let url = source.imageUrl?.trim() || null
  const libraryId = source.libraryImageId?.trim() || null
  if (!!url === !!libraryId) return { problem: 'give libraryImageId or imageUrl (one of them) for each image' }
  if (url) {
    // Review A3 — like a video's link: a link with a key, a signature or a sign-in in its query is refused (it would be
    // recorded and shown), and the link recorded is the one given, in the URL parser's one spelling.
    let parsed: URL
    try { parsed = new URL(url) } catch { return { problem: 'the link is not a web address' } }
    const secret = metaLinkSecretProblem(parsed)
    if (secret) return { problem: `the link ${secret}` }
    url = parsed.href
  }
  let link = url!
  let label: string | null = null
  if (libraryId) {
    const found = await libraryImageLink(libraryId)
    if ('problem' in found) return found
    link = found.url
    label = found.label
  }
  let fetched: Awaited<ReturnType<typeof fetchPhoto>>
  try {
    fetched = await fetchPhoto(link, META_IMAGE_MAX_BYTES)
  } catch (err) {
    if (err instanceof PhotoUrlError) return { problem: `${libraryId ?? 'the link'}: ${err.message.replace(/\.$/, '')}` }
    throw err
  }
  // The place said and recorded: the library id or the link given — never where a redirect went (it may carry a signature).
  const where = libraryId ?? url!
  if (!(META_IMAGE_TYPES as readonly string[]).includes(fetched.mimeType)) return { problem: `${where} is ${fetched.mimeType}: Meta's ads take JPG or PNG images` }
  if (fetched.bytes > META_IMAGE_MAX_BYTES) return { problem: `${where} is ${Math.ceil(fetched.bytes / 1024)} KB: Nexus sends Meta images of at most 8 MB` }
  let width = 0
  let height = 0
  try {
    const meta = await sharp(fetched.buffer).metadata()
    width = meta.width ?? 0
    height = meta.height ?? 0
  } catch { /* not readable: said below */ }
  if (!width || !height) return { problem: `${where}: Nexus could not read the image's width and height` }
  return {
    source: where,
    label: (label ?? fileNameOf(url ?? link) ?? 'image').slice(0, 100),
    mimeType: fetched.mimeType as PreparedMetaImage['mimeType'],
    bytes: fetched.bytes,
    width,
    height,
    sha256: fetched.contentHash,
    md5: createHash('md5').update(fetched.buffer).digest('hex'),
    buffer: fetched.buffer,
  }
}

/** The one image Meta's upload answer names (`images: {<name>: {hash, …}}`), or null. */
export function uploadedImageOf(node: Record<string, unknown> | null): { hash: string; name: string | null; width: number | null; height: number | null } | null {
  const images = node?.images
  if (!images || typeof images !== 'object' || Array.isArray(images)) return null
  const entries = Object.values(images as Record<string, unknown>).filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
  if (entries.length !== 1 || typeof entries[0].hash !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(entries[0].hash)) return null
  const n = (v: unknown) => (typeof v === 'number' ? v : null)
  return { hash: entries[0].hash, name: typeof entries[0].name === 'string' ? entries[0].name : null, width: n(entries[0].width), height: n(entries[0].height) }
}

const nowSec = () => Math.floor(Date.now() / 1000)
/** A Meta time (ISO with an offset) in seconds, or null. */
const secondsOf = (value: unknown): number | null => {
  const t = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(t) ? Math.floor(t / 1000) : null
}
/** Meta's clock and Nexus's differ by a little: an object made in this window before the send counts as made by it. */
const CLOCK_SLACK_SEC = 60

/** Was the image NEW? Proven only when Meta's hash is the file's MD5 and the library did not hold that hash before. */
async function imageWasNew(target: MetaWriteTarget, act: string, image: PreparedMetaImage, hash: string, foundBefore: boolean | null, sentAt: number): Promise<boolean | null> {
  if (hash === image.md5 && foundBefore !== null) return !foundBefore
  // Not proven new; an image older than this send was certainly there before (never deleted by an undo either way).
  try {
    const read = await metaReadOne<{ data?: Array<{ hash?: unknown; created_time?: unknown }> }>({ connectionId: target.connectionId }, { operation: 'media.imageRead', path: `${act}/adimages`, query: { hashes: [hash], fields: 'hash,created_time' } })
    const created = secondsOf(read.body.data?.find((row) => row.hash === hash)?.created_time)
    return created !== null && created < sentAt - CLOCK_SLACK_SEC ? false : null
  } catch {
    return null
  }
}

function sendImage(act: string, image: PreparedMetaImage, foundBefore: boolean | null) {
  return async (target: MetaWriteTarget): Promise<MetaChangeResult> => {
    const operation = 'media.imageUpload'
    // Exactly the approved picture (the plan holds its sha256): checked again before its Base64 is made, here, alone.
    if (createHash('sha256').update(image.buffer).digest('hex') !== image.sha256) {
      throw new MetaWriteError(localFailure(`"${image.label}" is not the picture that was approved; nothing was sent.`, 'IMAGE_MOVED'), operation, 'not_sent')
    }
    const sentAt = nowSec()
    const result = await metaSendChange(target, { objectId: act, kind: 'adaccount', params: { bytes: image.buffer.toString('base64') }, operation, edge: 'adimages', timeoutMs: 120_000 })
    const uploaded = uploadedImageOf(result.node)
    if (!uploaded) {
      throw new MetaWriteError(localFailure(`Meta answered the upload of "${image.label}" without one image hash, so Nexus cannot say what it made. ${META_UNKNOWN_OUTCOME}`, 'NO_HASH'), operation, 'unknown')
    }
    const isNew = await imageWasNew(target, act, image, uploaded.hash, foundBefore, sentAt)
    return { node: { hash: uploaded.hash, new: isNew, width: uploaded.width ?? image.width, height: uploaded.height ?? image.height }, readBack: 'same-request', waitedMs: result.waitedMs }
  }
}

const newWords = (isNew: unknown) => (isNew === true
  ? 'new in the ad account (its undo may remove it while no creative uses it)'
  : isNew === false
    ? 'already in the ad account (the same picture has the same hash; its undo never removes it)'
    : 'not proven new (its undo never removes it)')

async function imageDraft(account: MetaChangeAccount, sources: ImageSource[]): Promise<MediaDraft | { refusal: string }> {
  if (!sources.length) return { refusal: 'Name at least one image (libraryImageId or imageUrl).' }
  if (sources.length > MAX_IMAGES) return { refusal: `At most ${MAX_IMAGES} images per request.` }
  const act = `act_${account.adAccountId}`
  const prepared: PreparedMetaImage[] = []
  const problems: string[] = []
  for (const source of sources) {
    const image = await prepareMetaImage(source)
    if ('problem' in image) problems.push(`${image.problem}.`)
    else prepared.push(image)
  }
  if (problems.length) return { refusal: `Nothing was asked of Meta: ${problems.join(' ')}` }
  const seen = new Set<string>()
  for (const image of prepared) {
    if (seen.has(image.sha256)) return { refusal: `Nothing was asked of Meta: ${image.source} is the same picture as another image of this request; name each picture once.` }
    seen.add(image.sha256)
  }
  // "Was it new?" — the library asked for each image's MD5 before anything is sent (one read each; MD-003a).
  const before: Array<boolean | null> = []
  for (const image of prepared) {
    const read = await metaReadOne<{ data?: Array<{ hash?: unknown }> }>({ connectionId: account.target.connectionId }, { operation: 'media.imageCheck', path: `${act}/adimages`, query: { hashes: [image.md5], fields: 'hash' } })
    before.push(Array.isArray(read.body.data) ? read.body.data.some((row) => row.hash === image.md5) : null)
  }
  const byStep = new Map<number, { source: string; label: string }>()
  const requests: MetaChangeRequest[] = prepared.map((image, i) => {
    const label = `Upload image "${image.label}" (${image.source}; ${image.width}×${image.height}, ${Math.ceil(image.bytes / 1024)} KB) to ad account ${act}`
    byStep.set(i + 1, { source: image.source, label: image.label })
    return {
      step: i + 1, label, kind: 'ad', objectKind: 'adaccount', objectId: act,
      // A custom sender (review A6): the plan holds the picture's sha256, never its Base64; the sender sends `bytes` = the
      // Base64 of exactly these bytes, made at send time.
      params: { bytes_sha256: image.sha256 },
      check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false,
      operation: 'media.imageUpload', edge: 'adimages',
      send: sendImage(act, image, before[i]),
      doneSentence: (result) => `${label}: Meta made it; hash ${String(result.node?.hash ?? '?')}, ${newWords(result.node?.new)}.`,
    }
  })
  const { changes, more } = changeLines(prepared.map((image, i) => [`Image "${image.label}" (${image.source})`, before[i] === true ? 'already in the ad account (same picture)' : before[i] === false ? 'not in the ad account' : 'not read', 'uploaded (Meta answers its hash)']))
  const warnings = [
    'Meta has no check for an upload (its adimages, advideos and video_ads edges and the portfolio\'s creative_folders list no validate_only): the preview is built from the file itself and the ad account as it is now.',
    'An uploaded image spends nothing: it is used only once a creative and an ad use it (a creative takes it by its hash).',
    'Its undo removes only an image this upload made new, and only while no creative uses it (Meta deletes an image only then).',
    ...prepared.filter((_, i) => before[i] === true).map((image) => `"${image.label}" is already in the ad account's library (same picture): uploading it again changes nothing and gives the same hash.`),
  ]
  return {
    summary: `Meta: upload ${plural(prepared.length, 'image')} to ad account ${act} (an upload spends nothing).`,
    changes, totals: { images: prepared.length, requests: requests.length, ...(more ? { moreLines: more } : {}) },
    warnings, spendsMoney: [], skipped: [], requests,
    stands: { kind: 'image', adAccountId: account.adAccountId, images: prepared.map((image) => ({ source: image.source, sha256: image.sha256, bytes: image.bytes })) },
    before: { kind: 'image', items: prepared.map((image, i) => ({ kind: 'image', source: image.source, inLibrary: before[i] })) },
    after: { kind: 'image', items: prepared.map((image) => ({ kind: 'image', source: image.source })) },
    media: { kind: 'image', byStep },
  }
}

// ── videos ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The link of a library VIDEO of THIS business (`da_…` of type video; row-level security keeps every other out), or why not. */
export async function libraryVideoLink(id: string): Promise<{ url: string; label: string | null } | { problem: string }> {
  const ref = id.trim()
  if (!ref.startsWith('da_')) return { problem: `library video "${ref}" is not an image-library file id (da_…)` }
  const row = await prisma.digitalAsset.findFirst({ where: { id: ref.slice(3), type: 'video' }, select: { url: true, label: true } })
  return row ? { url: row.url, label: row.label || null } : { problem: `library video ${ref} is not a video of this business's image library (image-library lists them with type video)` }
}

/** What Meta answers of a video while it works: its status in words, and the music swap's state. */
export interface VideoState { videoId: string; createdAt: number | null; statusText: string | null; videoStatus: string | null; uploading: string | null; replaceAudioStatus: string | null }

const VIDEO_FIELDS = 'id,created_time,status'
const SWAP_FIELDS = 'id,created_time,status,replace_audio_status,selected_audio_spec'

/** A video as Meta answers it (GET /<video id>), in the shape the run reads. */
function videoStateOf(videoId: string, body: Record<string, unknown>): VideoState {
  const status = body.status && typeof body.status === 'object' ? body.status as Record<string, unknown> : null
  const uploading = status?.uploading_phase && typeof status.uploading_phase === 'object' ? (status.uploading_phase as Record<string, unknown>).status : null
  return {
    videoId,
    createdAt: secondsOf(body.created_time),
    statusText: videoStatusText(body.status),
    videoStatus: typeof status?.video_status === 'string' ? status.video_status : null,
    uploading: typeof uploading === 'string' ? uploading : null,
    replaceAudioStatus: typeof body.replace_audio_status === 'string' ? body.replace_audio_status : null,
  }
}

async function readVideo(target: MetaWriteTarget, videoId: string, fields: string): Promise<VideoState | null> {
  try {
    const read = await metaReadOne<Record<string, unknown>>({ connectionId: target.connectionId }, { operation: 'media.videoStatus', path: videoId, query: { fields } })
    return videoStateOf(videoId, read.body)
  } catch {
    return null
  }
}

/**
 * Poll until `done` says so or the polls run out (M5-08: a creative may use a video only once Meta says ready). `first`:
 * what the upload's own read-back already said (no read spent on it when it is done already).
 */
async function pollVideo(target: MetaWriteTarget, videoId: string, fields: string, done: (state: VideoState) => boolean, first: VideoState | null = null): Promise<VideoState | null> {
  let state: VideoState | null = first
  if (state && done(state)) return state
  for (let i = 0; i < __mediaTiming.polls; i++) {
    await __mediaTiming.sleep(__mediaTiming.pollMs)
    state = (await readVideo(target, videoId, fields)) ?? state
    if (state && done(state)) return state
  }
  return state
}

const settled = (state: VideoState) => state.videoStatus !== 'processing' || state.uploading === 'error'
/**
 * Review B6 — the music swap is over only on SUCCESSFUL or a word that says it failed; any other word (one Meta does not
 * document) counts as still running until the polls run out (OCC 2026-06-01 names only SUCCESSFUL).
 */
const swapSettled = (state: VideoState) => !!state.replaceAudioStatus && /^(SUCCESSFUL|SUCCESS|FAILED|FAILURE|ERROR|CANCELLED|CANCELED|REJECTED)$/i.test(state.replaceAudioStatus)

/** D3 B step 3: Meta refused the system user's video upload as such — the Owner uploads it in Meta's screens. */
function ownerUploads(err: unknown): unknown {
  if (err instanceof MetaWriteError && err.outcome === 'refused' && (err.failure.permissionDenied || /not (yet )?supported|business account|system user|permission/i.test(err.message))) {
    return new MetaWriteError({ ...err.failure, sentence: `${err.message} ${OWNER_UPLOAD_STEPS}` }, err.operation, err.outcome)
  }
  return err
}

const videoNode = (state: VideoState | null, videoId: string, isNew: boolean | null) => ({
  videoId, new: isNew, statusText: state?.statusText ?? 'Nexus could not read its status yet (meta-media-library view video reads it)', replaceAudioStatus: state?.replaceAudioStatus ?? null,
})

/** advideos: Meta fetches the link (MD-010), or brings in the chosen Instagram account's video (MD-020, MD-021). */
function sendAdVideo(act: string, params: Record<string, string>, swap: boolean) {
  return async (target: MetaWriteTarget): Promise<MetaChangeResult> => {
    const operation = 'media.videoUpload'
    const sentAt = nowSec()
    let result: MetaChangeResult
    try {
      result = await metaSendChange(target, { objectId: act, kind: 'adaccount', params, operation, edge: 'advideos', readBackFields: swap ? SWAP_FIELDS : VIDEO_FIELDS, timeoutMs: 120_000 })
    } catch (err) {
      throw ownerUploads(err)
    }
    const id = result.node && (typeof result.node.id === 'string' || typeof result.node.id === 'number') ? String(result.node.id) : null
    if (!id || !/^\d{1,20}$/.test(id)) throw new MetaWriteError(localFailure(`Meta answered the video upload without a video id, so Nexus cannot say what it made. ${META_UNKNOWN_OUTCOME}`, 'NO_VIDEO_ID'), operation, 'unknown')
    const first = result.node && result.node.status && typeof result.node.status === 'object' ? videoStateOf(id, result.node) : null
    const state = await pollVideo(target, id, swap ? SWAP_FIELDS : VIDEO_FIELDS, swap ? (s) => settled(s) && swapSettled(s) : settled, first)
    // A new upload is a new video object: made by this send when Meta's clock says so (within its small slack).
    const createdAt = state?.createdAt ?? secondsOf(result.node?.created_time)
    const isNew = createdAt === null ? null : createdAt >= sentAt - CLOCK_SLACK_SEC
    return { node: videoNode(state, id, isNew), readBack: 'second-read', waitedMs: result.waitedMs }
  }
}

/** video_ads: start → Meta fetches the link on its upload host → finish (MD-015…017); the link only, never a byte. */
function sendVideoAds(act: string, fileUrl: string) {
  return async (target: MetaWriteTarget): Promise<MetaChangeResult> => {
    let start: MetaChangeResult
    try {
      start = await metaSendChange(target, { objectId: act, kind: 'adaccount', params: { upload_phase: 'start' }, operation: 'media.videoAdsStart', edge: 'video_ads' })
    } catch (err) {
      throw ownerUploads(err)
    }
    const videoId = start.node && (typeof start.node.video_id === 'string' || typeof start.node.video_id === 'number') ? String(start.node.video_id) : null
    if (!videoId || !/^\d{1,20}$/.test(videoId)) throw new MetaWriteError(localFailure('Meta started no upload session it named (no video id); nothing was added to the ad account.', 'NO_VIDEO_ID'), 'media.videoAdsStart', 'refused')
    const left = `The upload Meta started (video ${videoId}) is left unfinished and expires; nothing was added to the ad account's library.`
    try {
      await metaSendRupload(target, { videoId, fileUrl, operation: 'media.videoAdsUpload' })
    } catch (err) {
      if (err instanceof MetaWriteError) throw ownerUploads(new MetaWriteError({ ...err.failure, sentence: `${err.message} ${left}` }, err.operation, err.outcome))
      throw err
    }
    // Meta fetches the file; finish once its uploading phase is complete (or the polls ran out: Meta's answer to finish decides).
    const fetched = await pollVideo(target, videoId, 'id,status', (s) => s.uploading === 'complete' || s.uploading === 'error' || s.videoStatus === 'error' || s.videoStatus === 'expired')
    if (fetched && (fetched.uploading === 'error' || fetched.videoStatus === 'error' || fetched.videoStatus === 'expired')) {
      throw new MetaWriteError(localFailure(`Meta could not fetch the video from its link (${fetched.statusText ?? fetched.videoStatus ?? 'upload error'}). ${left}`, 'UPLOAD_FAILED'), 'media.videoAdsUpload', 'refused')
    }
    let finish: MetaChangeResult
    try {
      finish = await metaSendChange(target, { objectId: act, kind: 'adaccount', params: { upload_phase: 'finish', video_id: videoId }, operation: 'media.videoAdsFinish', edge: 'video_ads' })
    } catch (err) {
      if (err instanceof MetaWriteError && err.outcome === 'refused') throw new MetaWriteError({ ...err.failure, sentence: `${err.message} ${left}` }, err.operation, err.outcome)
      throw err
    }
    const state = await pollVideo(target, videoId, VIDEO_FIELDS, settled)
    // A video-ads upload is always a new video: Meta named its id at the start of THIS change.
    return { node: videoNode(state, videoId, true), readBack: 'second-read', waitedMs: start.waitedMs + finish.waitedMs }
  }
}

async function videoDraft(account: MetaChangeAccount, video: VideoSource): Promise<MediaDraft | { refusal: string }> {
  const sources = [video.libraryVideoId, video.videoUrl, video.instagramMediaId].filter((v) => typeof v === 'string' && v.trim())
  if (sources.length !== 1) return { refusal: 'Name the video by exactly one of libraryVideoId (Nexus\'s library), videoUrl (a public https link) or instagramMediaId (the chosen Instagram account\'s video).' }
  const method: 'advideos' | 'video_ads' = video.method === 'video_ads' ? 'video_ads' : 'advideos'
  if (video.swapAudioAssetId && !video.instagramMediaId) return { refusal: 'Meta swaps the music only of an Instagram Reel brought in with instagramMediaId (its 2026-06-01 change): name the Reel.' }
  // Review B4 — Meta's video-ads finish takes only the video (guide; SDK create_video_ad's title is not on its finish):
  // a name, title or description is refused there in words, never dropped.
  if (method === 'video_ads' && (video.name || video.title || video.description)) {
    return { refusal: 'Meta\'s video_ads finish takes only the video: a name, title or description is not sent there. Use method advideos for a name, a title or a description.' }
  }
  // Review A6 — step 23's own text check (no bidirectional control, at least one visible character; a title in bytes).
  const textProblem = (video.name ? metaMediaTextProblem(video.name, META_MEDIA_TEXT.name, 'name') : null)
    ?? (video.title ? metaMediaTextProblem(video.title, META_MEDIA_TEXT.title, 'title', 'bytes') : null)
    ?? (video.description ? metaMediaTextProblem(video.description, META_MEDIA_TEXT.description, 'description') : null)
  if (textProblem) return { refusal: `Nothing was asked of Meta: ${textProblem}.` }
  const act = `act_${account.adAccountId}`
  const text = { ...(video.name ? { name: video.name } : {}), ...(video.title ? { title: video.title } : {}), ...(video.description ? { description: video.description } : {}) }
  let source: string
  let label: string
  let params: Record<string, string>
  let url: string | null = null
  if (video.instagramMediaId) {
    if (method === 'video_ads') return { refusal: 'Meta\'s video-ads upload takes a file or a link, not an Instagram media: bring an Instagram video in with method advideos.' }
    const chosen = await metaChosenAccount(account.accountId)
    const media = await ownMedia(chosen, video.instagramMediaId)
    source = `instagram:${media.mediaId}`
    label = `Instagram media ${media.mediaId}`
    params = {
      source_instagram_media_id: media.mediaId, ...text,
      ...(video.swapAudioAssetId ? { selected_audio_spec: JSON.stringify({ audio_asset_id: video.swapAudioAssetId }) } : {}),
    }
  } else {
    if (video.libraryVideoId) {
      const found = await libraryVideoLink(video.libraryVideoId)
      if ('problem' in found) return { refusal: `Nothing was asked of Meta: ${found.problem}.` }
      url = found.url
      source = video.libraryVideoId.trim()
      label = (found.label ?? 'video').slice(0, 100)
    } else {
      url = video.videoUrl!.trim()
      source = url
      label = fileNameOf(url) ?? 'video'
    }
    try { url = new URL(url).href } catch { return { refusal: `Nothing was asked of Meta: ${source} is not a link.` } }
    const problem = metaFileUrlProblem(url)
    if (problem) return { refusal: `Nothing was asked of Meta: ${source}: ${problem}.` }
    params = method === 'advideos' ? { file_url: url, ...text } : { upload_phase: 'start', file_url: url }
  }
  const host = url ? new URL(url).hostname : null
  const stepLabel = video.instagramMediaId
    ? `Bring ${label} into the video library of ad account ${act}${video.swapAudioAssetId ? ` with its music swapped for Meta Sound Collection audio ${video.swapAudioAssetId}` : ''}`
    : `Upload video "${label}" (${source}) to ad account ${act}: Meta fetches it from ${host}${method === 'video_ads' ? ' through its video-ads upload (start, the link, finish)' : ''}`
  const swap = !!video.swapAudioAssetId
  const request: MetaChangeRequest = {
    step: 1, label: stepLabel, kind: 'ad', objectKind: 'adaccount', objectId: act,
    // A custom sender: `params` are the keys its calls send (the plan Nexus compares) — for video_ads, the start's
    // upload_phase and the link the upload host gets as its file_url header (meta-media-rules.ts), then the finish.
    params,
    check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false,
    // Each edge spelled as it is (step 21's rule: no request builder computes its edge).
    ...(method === 'video_ads' ? { operation: 'media.videoAds', edge: 'video_ads' as const } : { operation: 'media.videoUpload', edge: 'advideos' as const }),
    send: method === 'video_ads' ? sendVideoAds(act, url!) : sendAdVideo(act, params, swap),
    doneSentence: (result) => `${stepLabel}: Meta made it; video ${String(result.node?.videoId ?? '?')}, ${String(result.node?.statusText ?? '')}${result.node?.replaceAudioStatus ? `; music swap: ${String(result.node.replaceAudioStatus)}` : ''}; ${newWords(result.node?.new)}.`,
  }
  const warnings = [
    'Meta has no check for an upload (its adimages, advideos and video_ads edges list no validate_only): the preview is built from the link and the ad account as it is now.',
    'An uploaded video spends nothing: it is used only once a creative and an ad use it, and only when Meta says it is ready (the run reads its status).',
    ...(url ? ['Meta fetches the file from its link itself (it must be public: no sign-in, no expiring signature): Nexus sends no byte of it. If Meta refuses the business\'s system user (its v26 guide: system users cannot yet upload videos to business accounts), the answer says how the Owner uploads it in Meta\'s screens.'] : []),
    ...(swap ? ['Meta swaps the Reel\'s copyrighted music for the Meta Sound Collection audio named (its 2026-06-01 change): the original Instagram post is not touched; the run reads replace_audio_status, and a creative should use the video only once it says SUCCESSFUL.'] : []),
    'Its undo removes the video from the ad account\'s library (DELETE advideos video_id) only when this upload made it new.',
  ]
  const { changes } = changeLines([[stepLabel, 'not in the ad account\'s video library', 'uploaded (Meta answers its video id)']])
  return {
    summary: `Meta: ${video.instagramMediaId ? 'bring an Instagram video into' : 'upload a video to'} ad account ${act} (an upload spends nothing).`,
    changes, totals: { videos: 1, requests: 1 }, warnings, spendsMoney: [], skipped: [], requests: [request],
    stands: { kind: 'video', adAccountId: account.adAccountId, source, method, url, swap: video.swapAudioAssetId ?? null },
    before: { kind: 'video', items: [{ kind: 'video', source }] },
    after: { kind: 'video', items: [{ kind: 'video', source, method }] },
    media: { kind: 'video', byStep: new Map([[1, { source, label }]]) },
  }
}

// ── folders ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export const FOLDER_TAKEN = 'Another business in Nexus uses an ad account of this Meta business portfolio, so Nexus makes no folder in the portfolio\'s media library (it would be that business\'s too). A person can in Business Settings › Media library.'

async function folderDraft(account: MetaChangeAccount, folder: NonNullable<MediaUploadRequest['folder']>): Promise<MediaDraft | { refusal: string }> {
  const chosen = await metaChosenAccount(account.accountId)
  const portfolio = chosen.businessId
  if (!portfolio) return { refusal: 'The chosen ad account names no business portfolio, so Nexus makes no folder in a portfolio\'s media library.' }
  if ((await takenIds('PORTFOLIO', [portfolio])).has(portfolio)) return { refusal: FOLDER_TAKEN }
  // Review A6 — step 23's own text check.
  const textProblem = metaMediaTextProblem(folder.name.trim(), META_MEDIA_TEXT.folderName, 'the folder\'s name')
    ?? (folder.description?.trim() ? metaMediaTextProblem(folder.description.trim(), META_MEDIA_TEXT.folderDescription, 'its description') : null)
  if (textProblem) return { refusal: `Nothing was asked of Meta: ${textProblem}.` }
  // Review A5 — the same reach as the gateway's check (META_MEDIA_LIST_MAX), failing closed past it.
  const read = await listPaged(account.target.connectionId, 'media.folders', `${portfolio}/creative_folders`, { fields: 'id,name,parent_folder_id' }, META_MEDIA_LIST_MAX)
  const parent = folder.parentFolderId?.trim() || null
  if (parent && !read.rows.some((row) => String(row.id ?? '') === parent)) {
    return { refusal: `Nothing was asked of Meta: folder ${parent} is not one of the portfolio's media-library folders${read.more ? ` Nexus can read (it reads the first ${META_MEDIA_LIST_MAX})` : ''} (meta-media-library view folders lists them).` }
  }
  const name = folder.name.trim()
  const twin = read.rows.some((row) => typeof row.name === 'string' && row.name.trim().toLowerCase() === name.toLowerCase() && (String(row.parent_folder_id ?? '') || null) === parent)
  const label = `Create folder "${name}"${parent ? ` inside folder ${parent}` : ''} in the business portfolio's media library`
  const params: Record<string, string> = { name, ...(folder.description?.trim() ? { description: folder.description.trim() } : {}), ...(parent ? { parent_folder_id: parent } : {}) }
  const request: MetaChangeRequest = {
    step: 1, label, kind: 'ad', objectKind: 'business', objectId: portfolio, params,
    check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false,
    operation: 'media.folderCreate', edge: 'creative_folders',
    send: async (target) => {
      const result = await metaSendChange(target, { objectId: portfolio, kind: 'business', params, operation: 'media.folderCreate', edge: 'creative_folders', readBackFields: 'id,name,creation_time' })
      const id = result.node && (typeof result.node.id === 'string' || typeof result.node.id === 'number') ? String(result.node.id) : null
      if (!id) throw new MetaWriteError(localFailure(`Meta answered the folder without an id, so Nexus cannot say what it made. ${META_UNKNOWN_OUTCOME}`, 'NO_FOLDER_ID'), 'media.folderCreate', 'unknown')
      return { node: { folderId: id, name: typeof result.node?.name === 'string' ? result.node.name : name }, readBack: result.readBack, waitedMs: result.waitedMs }
    },
    doneSentence: (result) => `${label}: Meta made it; folder ${String(result.node?.folderId ?? '?')}.`,
  }
  return {
    summary: `Meta: ${label.charAt(0).toLowerCase()}${label.slice(1)} (a folder spends nothing).`,
    changes: changeLines([[label, 'no such folder', 'created']]).changes,
    totals: { folders: 1, requests: 1 },
    warnings: [
      'Meta has no check for a folder (its creative_folders edge lists no validate_only), and its reference documents no create parameters: Nexus sends the name, description and parent folder Meta\'s own SDK names, and Meta\'s answer decides.',
      'Meta has no API to rename or delete a media-library folder: it stays (no undo). A person can in Business Settings › Media library.',
      ...(twin ? [`The portfolio already has a folder named "${name}" there: Meta may make a second one.`] : []),
    ],
    spendsMoney: [], skipped: [], requests: [request],
    stands: { kind: 'folder', portfolioId: portfolio, parent, name, twin },
    before: { kind: 'folder', items: [] },
    after: { kind: 'folder', items: [{ kind: 'folder', name, portfolioId: portfolio }] },
    media: { kind: 'folder', byStep: new Map([[1, { source: portfolio, label: name }]]) },
  }
}

// ── a video of the chosen account's library (captions, undo) ───────────────────────────────────────────────────────

/**
 * Review A2 / B3 — the chosen ad account's library videos: listed on act_<id>/advideos or act_<id>/video_ads (a video-ads
 * upload; whether advideos lists one is LIVE-PROBE MD-019u), each read up to META_MEDIA_LIST_MAX like the gateway's own
 * check. `complete`: both lists were read to their end (else an id not seen is not confirmed).
 */
export async function libraryVideos(connectionId: string, adAccountId: string): Promise<{ ids: Set<string>; complete: boolean }> {
  const ids = new Set<string>()
  let complete = true
  for (const edge of ['advideos', 'video_ads']) {
    const read = await listPaged(connectionId, `media.${edge === 'advideos' ? 'videoLibrary' : 'videoAdsLibrary'}`, `act_${adAccountId}/${edge}`, { fields: 'id' }, META_MEDIA_LIST_MAX)
    for (const row of read.rows) ids.add(String(row.id ?? ''))
    if (read.more) complete = false
  }
  return { ids, complete }
}

/** Does any value under a `video_id` key, at any depth of this creative, name the video? */
function namesVideo(value: unknown, videoId: string, depth = 0): boolean {
  if (depth > 12 || !value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some((v) => namesVideo(v, videoId, depth + 1))
  return Object.entries(value as Record<string, unknown>).some(([key, v]) => (key === 'video_id' && String(v) === videoId) || namesVideo(v, videoId, depth + 1))
}

/**
 * Review A1 — the creatives of the chosen ad account that use a video (its `video_id`, the `object_story_spec` video data,
 * the `asset_feed_spec` videos), read up to META_MEDIA_LIST_MAX; `complete` false: more creatives than that (not confirmed).
 */
async function creativesUsingVideos(connectionId: string, act: string, videoIds: string[]): Promise<{ by: Map<string, string[]>; complete: boolean }> {
  const read = await listPaged(connectionId, 'media.videoUse', `${act}/adcreatives`, { fields: 'id,video_id,object_story_spec,asset_feed_spec' }, META_MEDIA_LIST_MAX)
  const by = new Map<string, string[]>(videoIds.map((id) => [id, []]))
  for (const row of read.rows) {
    for (const id of videoIds) if (namesVideo(row, id)) by.get(id)!.push(String(row.id ?? '?'))
  }
  return { by, complete: !read.more }
}

/**
 * A video's caption locales and its default one, as Meta answers them now. VideoCaption's reference documents `locale`,
 * `is_default`, `is_auto_generated`, `create_time`, `locale_name` and `uri`; when Meta still refuses `is_default`, the
 * locales are read alone and the default is unknown (null: the undo then cannot put a default back, and says so).
 */
export async function videoCaptions(connectionId: string, videoId: string): Promise<{ locales: Set<string>; defaultLocale: string | null; defaultKnown: boolean }> {
  const read = async (fields: string) => listPaged(connectionId, 'media.videoCaptions', `${videoId}/captions`, { fields }, 100)
  let rows: Array<Record<string, unknown>>
  let defaultKnown = true
  try {
    rows = (await read('locale,is_default')).rows
  } catch (err) {
    if (!fieldRefused(err)) throw err
    rows = (await read('locale')).rows
    defaultKnown = false
  }
  const locales = new Set(rows.map((r) => (typeof r.locale === 'string' ? r.locale : '')).filter(Boolean))
  const marked = rows.find((r) => r.is_default === true)
  return { locales, defaultLocale: defaultKnown ? (typeof marked?.locale === 'string' ? marked.locale : 'none') : null, defaultKnown }
}

// ── captions (MD-026) ──────────────────────────────────────────────────────────────────────────────────────────────

async function captionsDraft(account: MetaChangeAccount, captions: CaptionsSource): Promise<MediaDraft | { refusal: string }> {
  const videoId = captions.videoId.trim()
  const locale = captions.locale.trim()
  if (!/^\d{1,20}$/.test(videoId)) return { refusal: 'Name the video by its id (digits; meta-media-library view videos lists them).' }
  if (!META_LOCALE.test(locale)) return { refusal: 'Name the caption locale as Meta writes it (it_IT, en_US).' }
  const srt = captions.srt.replace(/\r\n?/g, '\n')
  const srtProblem = metaSrtProblem(srt)
  if (srtProblem) return { refusal: `Nothing was asked of Meta: ${srtProblem}.` }
  const base = (captions.fileName?.trim() || 'captions').toLowerCase().replace(/\.srt$/, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+/, '').slice(0, 40) || 'captions'
  const fileName = `${base}.${locale}.srt`
  if (!META_CAPTIONS_FILE_NAME.test(fileName)) return { refusal: `Nothing was asked of Meta: ${fileName} is not a caption file name Meta takes (<name>.<locale>.srt).` }
  const library = await libraryVideos(account.target.connectionId, account.adAccountId)
  if (!library.ids.has(videoId)) {
    return { refusal: `Nothing was asked of Meta: video ${videoId} is not one Nexus can confirm in the chosen ad account's video library${library.complete ? '' : ` (it reads the first ${META_MEDIA_LIST_MAX} of advideos and of video_ads)`}.` }
  }
  const now = await videoCaptions(account.target.connectionId, videoId)
  // Meta takes a locale once (482: "contain locales that had been applied to video"): an upload here is always new.
  if (now.locales.has(locale)) return { refusal: `Nothing was asked of Meta: video ${videoId} already has captions in ${locale}, and Meta takes a locale only once. Take those back first (the undo of the upload that added them), or upload another locale.` }
  const setDefault = captions.defaultLocale?.trim() || null
  if (setDefault && setDefault !== 'none' && setDefault !== locale && !now.locales.has(setDefault)) {
    return { refusal: `Nothing was asked of Meta: the default caption locale is none, ${locale} (this file) or one the video already has (${[...now.locales].join(', ') || 'none yet'}).` }
  }
  const label = `Add ${locale} captions (${fileName}, ${Math.ceil(Buffer.byteLength(srt, 'utf8') / 1024)} KB) to video ${videoId} of ad account act_${account.adAccountId}${setDefault ? `; default caption: ${setDefault}` : ''}`
  const params: Record<string, string> = { captions_file: srt, captions_file_name: fileName, ...(setDefault ? { default_locale: setDefault } : {}) }
  const request: MetaChangeRequest = {
    step: 1, label, kind: 'ad', objectKind: 'video', objectId: videoId, params,
    check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false,
    operation: 'media.captionsUpload', edge: 'captions',
    doneSentence: () => `${label}: Meta took it.`,
  }
  return {
    summary: `Meta: add ${locale} captions to video ${videoId} (captions spend nothing).`,
    changes: changeLines([[`Video ${videoId} captions`, [...now.locales].join(', ') || 'none', [...now.locales, locale].join(', ')], ...(setDefault ? [[`Video ${videoId} default caption`, now.defaultKnown ? now.defaultLocale : 'not read', setDefault] as [string, unknown, unknown]] : [])]).changes,
    totals: { captions: 1, requests: 1 },
    warnings: [
      'Meta has no check for captions (its captions edge lists no validate_only): the preview is built from the file and the video as they are now.',
      'Captions spend nothing. The caption text is kept only with this request (its approval, the run that asked for it, or its change-plan step: the text the person approves), never in the change record, the call ledger or logs.',
      `Its undo takes the ${locale} captions off the video again (Meta's locales_to_delete; Meta has no delete on this edge)${setDefault ? (now.defaultKnown ? ` and puts the default caption back to ${now.defaultLocale}` : ', but Nexus could not read the default caption before, so the undo cannot put it back') : ''}.`,
    ],
    spendsMoney: [], skipped: [], requests: [request],
    stands: { kind: 'captions', videoId, locale, fileName, srtSha256: createHash('sha256').update(srt).digest('hex'), locales: [...now.locales].sort(), defaultLocale: now.defaultLocale, setDefault },
    before: { kind: 'captions', items: [{ kind: 'captions', videoId, locales: [...now.locales].sort(), defaultLocale: now.defaultLocale }] },
    after: { kind: 'captions', items: [] },
    media: { kind: 'captions', byStep: new Map([[1, { source: videoId, label: locale }]]), captions: { setDefault, defaultBefore: now.defaultKnown ? now.defaultLocale : null } },
  }
}

// ── undo: take back what an upload made new ─────────────────────────────────────────────────────────────────────────

const keyOf = (u: UploadRef) => (u.kind === 'image' ? `image:${u.hash}` : u.kind === 'video' ? `video:${u.videoId}` : `captions:${u.videoId}:${u.locale}`)

/**
 * The change record of THIS business that made this upload NEW in this ad account (an earlier create-meta-media change,
 * not undone), or null. A caption's default to put back must be the one that record kept. Row-level security: another
 * business's records are never read.
 */
async function recordOf(ref: UploadRef, adAccountId: string): Promise<string | null> {
  const item = ref.kind === 'image' ? { kind: 'image', hash: ref.hash, new: true }
    : ref.kind === 'video' ? { kind: 'video', videoId: ref.videoId, new: true }
      : { kind: 'captions', videoId: ref.videoId, locale: ref.locale, new: true }
  const rows = await prisma.agentChange.findMany({
    where: { toolName: MEDIA_TOOL, undoneAt: null, after: { path: ['items'], array_contains: [item] } },
    select: { id: true, after: true },
    take: 20,
  })
  const row = rows.find((r) => {
    const after = r.after as { adAccountId?: unknown; items?: Array<Record<string, unknown>> } | null
    if (after?.adAccountId !== adAccountId) return false
    if (ref.kind !== 'captions' || !ref.restoreDefault) return true
    // The default put back is only the one the upload replaced (its record says so).
    return (after.items ?? []).some((i) => i.kind === 'captions' && i.videoId === ref.videoId && i.locale === ref.locale && i.setDefault && i.defaultBefore === ref.restoreDefault)
  })
  return row?.id ?? null
}

async function undoDraft(account: MetaChangeAccount, uploads: UploadRef[]): Promise<MediaDraft | { refusal: string }> {
  if (!uploads.length) return { refusal: 'Name the uploads to take back (each image by its hash, each video by its id, each caption by its video and locale).' }
  if (uploads.length > MAX_UNDO) return { refusal: `At most ${MAX_UNDO} uploads per request.` }
  if (uploads.some((u) => (u.kind === 'image' ? !u.hash : !u.videoId || (u.kind === 'captions' && !META_LOCALE.test(u.locale ?? ''))))) return { refusal: 'Name each image by its hash, each video by its videoId and each caption by its videoId and locale.' }
  if (new Set(uploads.map(keyOf)).size !== uploads.length) return { refusal: 'Name each upload once.' }
  const act = `act_${account.adAccountId}`
  const refusals: string[] = []
  for (const upload of uploads) {
    if (!(await recordOf(upload, account.adAccountId))) {
      refusals.push(`${upload.kind === 'image' ? `image ${upload.hash}` : upload.kind === 'video' ? `video ${upload.videoId}` : `the ${upload.locale} captions of video ${upload.videoId}${upload.restoreDefault ? ` (with default ${upload.restoreDefault})` : ''}`} is not one a create-meta-media upload of this business made new in ad account ${act} (Nexus removes only that: never a file it did not create, and never one that was already there).`)
    }
  }
  if (refusals.length) return { refusal: `Nothing was asked of Meta: ${refusals.join(' ')}` }
  const hashes = uploads.flatMap((u) => (u.kind === 'image' ? [u.hash] : []))
  const images = new Map<string, { used: string[] }>()
  if (hashes.length) {
    const read = await metaReadOne<{ data?: Array<Record<string, unknown>> }>({ connectionId: account.target.connectionId }, { operation: 'media.imageUse', path: `${act}/adimages`, query: { hashes, fields: 'hash,status,creatives,is_associated_creatives_in_adgroups' } })
    for (const row of read.body.data ?? []) {
      if (typeof row.hash !== 'string' || row.status === 'DELETED') continue
      const creatives = Array.isArray(row.creatives) ? row.creatives.map((c) => String(c)) : []
      images.set(row.hash, { used: creatives.length ? creatives : row.is_associated_creatives_in_adgroups === true ? ['an ad'] : [] })
    }
  }
  const videoIds = uploads.flatMap((u) => (u.kind === 'video' ? [u.videoId] : []))
  const captionVideos = [...new Set(uploads.flatMap((u) => (u.kind === 'captions' ? [u.videoId] : [])))]
  // Review A2 / B3 — the library read on both edges (advideos and video_ads), failing closed past META_MEDIA_LIST_MAX.
  const library = videoIds.length || captionVideos.length ? await libraryVideos(account.target.connectionId, account.adAccountId) : null
  // Review A1 — one read of the account's creatives: a video a creative uses stays (an ad would lose its video).
  const use = videoIds.length ? await creativesUsingVideos(account.target.connectionId, act, videoIds) : null
  const captionsNow = new Map<string, Set<string>>()
  for (const videoId of captionVideos) {
    if (library?.ids.has(videoId)) captionsNow.set(videoId, (await videoCaptions(account.target.connectionId, videoId)).locales)
  }
  const skipped: string[] = []
  const going: UploadRef[] = []
  const notInLibrary = (videoId: string) => `Video ${videoId} is not in the ad account's video library${library?.complete ? '' : ` Nexus can read (the first ${META_MEDIA_LIST_MAX} of advideos and of video_ads)`} any more.`
  for (const upload of uploads) {
    if (upload.kind === 'image') {
      const image = images.get(upload.hash)
      if (!image) { skipped.push(`Image ${upload.hash} is no longer in the ad account's library.`); continue }
      // M5-03 — "You can only delete ad images not currently being used in an ad creative."
      if (image.used.length) { skipped.push(`Image ${upload.hash} stays: ${image.used.length === 1 && image.used[0] === 'an ad' ? 'an ad uses it' : `creative${image.used.length === 1 ? '' : 's'} ${image.used.slice(0, 5).join(', ')} use${image.used.length === 1 ? 's' : ''} it`}, and Meta deletes an image only while no creative uses it.`); continue }
    } else if (upload.kind === 'video') {
      if (!library?.ids.has(upload.videoId)) { skipped.push(notInLibrary(upload.videoId)); continue }
      const users = use?.by.get(upload.videoId) ?? []
      if (users.length) { skipped.push(`Video ${upload.videoId} stays: creative${users.length === 1 ? '' : 's'} ${users.slice(0, 5).join(', ')} use${users.length === 1 ? 's' : ''} it, and an ad would lose its video.`); continue }
      if (!use?.complete) { skipped.push(`Video ${upload.videoId} stays: the ad account has more than ${META_MEDIA_LIST_MAX} creatives, so Nexus cannot confirm no ad uses it.`); continue }
    } else {
      if (!library?.ids.has(upload.videoId)) { skipped.push(notInLibrary(upload.videoId)); continue }
      if (!captionsNow.get(upload.videoId)?.has(upload.locale)) { skipped.push(`Video ${upload.videoId} has no ${upload.locale} captions any more.`); continue }
    }
    going.push(upload)
  }
  if (!going.length) return { refusal: `Nothing to take back: ${skipped.join(' ')}` }
  const requests: MetaChangeRequest[] = going.map((upload, i) => {
    if (upload.kind === 'captions') {
      const label = `Take the ${upload.locale} captions (added by Nexus) off video ${upload.videoId} of ad account ${act}`
      // Step 22's captions.delete: the language alone (its default caption goes back in a request of its own, below).
      return {
        step: i + 1, label, kind: 'ad', objectKind: 'video', objectId: upload.videoId,
        params: { locales_to_delete: JSON.stringify([upload.locale]) },
        check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false,
        operation: 'media.captionsRemove', edge: 'captions',
        doneSentence: () => `${label}: Meta took it.`,
      }
    }
    const label = upload.kind === 'image' ? `Remove image ${upload.hash} (uploaded new by Nexus) from ad account ${act}` : `Remove video ${upload.videoId} (uploaded by Nexus) from ad account ${act}`
    return {
      step: i + 1, label, kind: 'ad', objectKind: 'adaccount', objectId: act,
      params: upload.kind === 'image' ? { hash: upload.hash } : { video_id: upload.videoId },
      check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false,
      ...(upload.kind === 'image' ? { operation: 'media.imageRemove', edge: 'adimages' as const } : { operation: 'media.videoRemove', edge: 'advideos' as const }), method: 'DELETE',
      doneSentence: () => `${label}: Meta removed it.`,
    }
  })
  // The default caption an upload replaced goes back only after its language came off (step 22's needs), last.
  going.forEach((upload, i) => {
    if (upload.kind !== 'captions' || !upload.restoreDefault) return
    const label = `Put the default caption of video ${upload.videoId} back to ${upload.restoreDefault}`
    requests.push({
      step: requests.length + 1, label, kind: 'ad', objectKind: 'video', objectId: upload.videoId,
      params: { default_locale: upload.restoreDefault },
      check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false,
      operation: 'media.captionsDefault', edge: 'captions', needs: [i + 1],
      doneSentence: () => `${label}: Meta took it.`,
    })
  })
  const lineOf = (u: UploadRef): [string, unknown, unknown] => (u.kind === 'captions' ? [`Video ${u.videoId} ${u.locale} captions`, 'on the video', 'taken off'] : [u.kind === 'image' ? `Image ${u.hash}` : `Video ${u.videoId}`, 'in the ad account\'s library', 'removed'])
  return {
    summary: `Meta: take back ${plural(going.length, 'upload')} Nexus made new in ad account ${act}.`,
    changes: changeLines(going.map(lineOf)).changes,
    totals: { remove: going.length, requests: requests.length, ...(skipped.length ? { stays: skipped.length } : {}) },
    warnings: [
      'Meta has no check for a removal (its adimages, advideos and captions edges list no validate_only), and a removal cannot be put back by Nexus: upload the file again (an image gets the same hash).',
      ...(videoIds.length ? ['A video a creative of this account uses stays (Nexus reads the creatives first): an ad would lose its video. Meta may still refuse a removal it does not allow.'] : []),
      'A removal spends nothing.',
    ],
    spendsMoney: [], skipped, requests,
    stands: { kind: 'undo', adAccountId: account.adAccountId, going: going.map(keyOf), skipped: uploads.filter((u) => !going.includes(u)).map(keyOf) },
    before: { kind: 'undo', items: going.map((u) => ({ ...u, present: true as const })) },
    after: { kind: 'undo', items: going.map((u) => ({ ...u, removed: true as const })) },
    media: { kind: 'undo', byStep: new Map(going.map((u, i) => [i + 1, { source: keyOf(u), label: keyOf(u) }])) },
  }
}

// ── the one entry ───────────────────────────────────────────────────────────────────────────────────────────────────

/** A plain answer for a kind or a method Nexus does not send (no call), or null. */
export function mediaPlainAnswer(kind: MediaKind, request: { video?: VideoSource | null; copyFrom?: unknown }): string | null {
  if (kind === 'thumbnail') return THUMBNAIL_ANSWER
  if (kind === 'playable') return PLAYABLE_ANSWER
  if (kind === 'video' && request.video?.method === 'chunked') return CHUNKED_ANSWER
  if (kind === 'image' && request.copyFrom) return COPY_ANSWER
  return null
}

/** The draft of one create-meta-media request, from what Meta and Nexus hold now (reads only). */
export async function mediaDraft(account: MetaChangeAccount, request: MediaUploadRequest): Promise<MediaDraft | { refusal: string }> {
  try {
    switch (request.kind) {
      case 'image': return await imageDraft(account, request.images ?? [])
      case 'video': return request.video ? await videoDraft(account, request.video) : { refusal: 'Name the video (video.libraryVideoId, video.videoUrl or video.instagramMediaId).' }
      case 'folder': return request.folder?.name?.trim() ? await folderDraft(account, request.folder) : { refusal: 'Name the folder (folder.name).' }
      case 'captions': return request.captions ? await captionsDraft(account, request.captions) : { refusal: 'Name the video, the locale and the SRT text (captions.videoId, captions.locale, captions.srt).' }
      case 'undo': return await undoDraft(account, request.uploads ?? [])
    }
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refusal: err.message }
    throw err
  }
}
