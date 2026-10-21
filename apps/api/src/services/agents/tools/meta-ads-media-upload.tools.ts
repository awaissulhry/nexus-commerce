/**
 * Meta ads step 23 (2026-10-21) — create-meta-media: put an image, a video or a folder into the business's chosen Meta ad
 * account and its portfolio's media library, and take back what such an upload made new (master rows BM-058, MD-003,
 * MD-004, MD-006, MD-010…017, MD-020, MD-021, MD-024, MD-026, MD-029; marketing/meta-ads/change-media.ts holds each row's
 * rule and the Meta pages it was checked on). A Nexus change like every other Meta change (meta-ads-kit.ts): a preview
 * from what Meta and Nexus hold now (Meta has no check for an upload: the preview says so), an approvalId, a person
 * approves it, it runs as that person, and its undo takes back only what it made new.
 *
 * Nothing here spends money. The image bytes it sends are never stored, logged or shown (the gateway's ledger keeps their
 * length only); a video is never relayed: Meta fetches it from its public link.
 *
 * Step 22 (lane C1, remove-meta-ads-items) will delete images and videos on a person's explicit ask with the same two
 * DELETE rules (gateway/meta-media-rules.ts); until then this tool's undo (kind undo) is the only removal, and it removes
 * nothing an upload of this business did not make new.
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import { metaChangePreview, metaConnectionArg, metaIdArg, metaWhyArg, META_CHANGE_RULES, recordAccount, runMetaChange, type MetaDraftBuilder, type MetaRunOutcome } from './meta-ads-kit.js'
import {
  libraryVideos, MAX_IMAGES, MAX_UNDO, MEDIA_KINDS, MEDIA_TOOL, mediaDraft, mediaPlainAnswer, VIDEO_METHODS, videoCaptions,
  type MediaDraft, type MediaKind, type MediaRecordItem, type MediaUploadRequest, type UploadRef, type VideoSource,
} from '../../marketing/meta-ads/change-media.js'
import type { MetaChangeDraft, MetaChangeRequest } from '../../marketing/meta-ads/change-draft.js'
import type { MetaChangeResult } from '../../marketing/meta-ads/write-client.js'
import { META_CAPTIONS_MAX_BYTES, META_MEDIA_TEXT } from '../../gateway/meta-media-rules.js'
import { metaReadOne } from '../../marketing/meta-ads/read-client.js'

const libraryIdArg = (what: string) => z.string().trim().regex(/^(da|pi)_[A-Za-z0-9_-]{1,64}$/, 'an image-library id: da_… or pi_…').describe(what)
const httpsArg = (what: string) => z.string().trim().max(2000).regex(/^https:\/\/[^\s"'<>]+$/, 'an https:// link').describe(what)
const hashArg = z.string().trim().regex(/^[A-Za-z0-9]{1,64}$/, 'an image hash').describe('the image\'s hash (Meta\'s, as the upload answered it)')
const textArg = (max: number, what: string) => z.string().trim().min(1).max(max).optional().describe(what)
const localeArg = (what: string) => z.string().trim().regex(/^[a-z]{2}_[A-Z]{2}$/, 'a locale as Meta writes it (it_IT, en_US)').describe(what)

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** The request as the drafts read it (zod has checked the args). */
function requestOf(args: Record<string, unknown>): MediaUploadRequest {
  const video = args.video as Record<string, unknown> | undefined
  const folder = args.folder as Record<string, unknown> | undefined
  const captions = args.captions as Record<string, unknown> | undefined
  return {
    kind: args.kind as MediaUploadRequest['kind'],
    images: ((args.images as Array<Record<string, unknown>> | undefined) ?? []).map((i) => ({ libraryImageId: str(i.libraryImageId), imageUrl: str(i.imageUrl) })),
    ...(video ? {
      video: {
        libraryVideoId: str(video.libraryVideoId), videoUrl: str(video.videoUrl), instagramMediaId: str(video.instagramMediaId),
        method: (video.method as VideoSource['method']) ?? null, name: str(video.name), title: str(video.title), description: str(video.description),
        swapAudioAssetId: str(video.swapAudioAssetId),
      },
    } : {}),
    ...(folder ? { folder: { name: String(folder.name ?? ''), description: str(folder.description), parentFolderId: str(folder.parentFolderId) } } : {}),
    ...(captions ? { captions: { videoId: String(captions.videoId ?? ''), locale: String(captions.locale ?? ''), srt: String(captions.srt ?? ''), fileName: str(captions.fileName), defaultLocale: str(captions.defaultLocale) } } : {}),
    uploads: ((args.uploads as UploadRef[] | undefined) ?? []).map((u): UploadRef => (u.kind === 'image'
      ? { kind: 'image', hash: u.hash }
      : u.kind === 'video' ? { kind: 'video', videoId: u.videoId } : { kind: 'captions', videoId: u.videoId, locale: u.locale, ...(u.restoreDefault ? { restoreDefault: u.restoreDefault } : {}) })),
  }
}

const build = (args: Record<string, unknown>): MetaDraftBuilder => (account) => mediaDraft(account, requestOf(args))

/** What a done upload request made, as recorded (only facts that do not move with time; undo reads them). */
function recordItem(draft: MediaDraft, request: MetaChangeRequest, result: MetaChangeResult): MediaRecordItem | (UploadRef & { removed: true }) | null {
  const node = result.node ?? {}
  const source = draft.media.byStep.get(request.step)?.source ?? ''
  const isNew = node.new === true ? true : node.new === false ? false : null
  switch (draft.media.kind) {
    case 'image': return typeof node.hash === 'string' ? { kind: 'image', source, hash: node.hash, new: isNew } : null
    case 'video': return typeof node.videoId === 'string' ? { kind: 'video', source, videoId: node.videoId, method: request.edge === 'video_ads' ? 'video_ads' : 'advideos', new: isNew } : null
    case 'folder': return typeof node.folderId === 'string' ? { kind: 'folder', folderId: node.folderId, name: typeof node.name === 'string' ? node.name : source, portfolioId: request.objectId } : null
    // Meta takes a caption locale once (482): an upload Meta took is always new.
    case 'captions': return { kind: 'captions', videoId: request.objectId, locale: draft.media.byStep.get(request.step)?.label ?? '', new: true, setDefault: draft.media.captions?.setDefault ?? null, defaultBefore: draft.media.captions?.defaultBefore ?? null }
    case 'undo': {
      if (request.params.hash) return { kind: 'image', hash: request.params.hash, removed: true }
      if (request.params.locales_to_delete) return { kind: 'captions', videoId: request.objectId, locale: (JSON.parse(request.params.locales_to_delete) as string[])[0], removed: true }
      return { kind: 'video', videoId: request.params.video_id, removed: true }
    }
  }
}

function finish(draft: MetaChangeDraft, done: Array<{ request: MetaChangeRequest; result: MetaChangeResult }>): MetaRunOutcome {
  const media = draft as MediaDraft
  const items = done.map(({ request, result }) => recordItem(media, request, result)).filter((i): i is NonNullable<typeof i> => !!i)
  const doneSteps = new Set(done.map(({ request }) => request.step))
  const before = draft.before as { kind: string; items: Array<Record<string, unknown>> }
  const notes: Record<MediaUploadRequest['kind'], string> = {
    image: 'A creative uses an image by its hash (image_hash). new: false or null means the picture was already there or Nexus could not prove it was not — its undo never removes it.',
    video: 'A creative may use the video only once Meta says it is ready (meta-media-library view video reads its status).',
    folder: 'Meta has no API to rename or delete a folder: it stays.',
    captions: 'The captions show on the video wherever its ads run; Nexus did not keep the file.',
    undo: 'Meta cannot put a removed file back: upload it again (create-meta-media).',
  }
  return {
    data: {
      kind: media.media.kind,
      [media.media.kind === 'undo' ? 'removed' : 'made']: items,
      ...(done.length ? { details: done.map(({ request, result }) => ({ step: request.step, ...(result.node ?? {}) })) } : {}),
      note: notes[media.media.kind],
    },
    before: { kind: before.kind, items: before.items.filter((_, i) => doneSteps.has(i + 1)) },
    after: { kind: media.media.kind, items },
  }
}

// ── undo ────────────────────────────────────────────────────────────────────────────────────────────────────────────

type Stamped = { kind?: string; items?: Array<Record<string, unknown>>; accountId?: string; adAccountId?: string }
const newUploads = (after: Stamped): UploadRef[] => (after.items ?? []).flatMap((item): UploadRef[] => {
  if (item.new !== true) return []
  if (item.kind === 'image' && typeof item.hash === 'string') return [{ kind: 'image', hash: item.hash }]
  if (item.kind === 'video' && typeof item.videoId === 'string') return [{ kind: 'video', videoId: item.videoId }]
  if (item.kind === 'captions' && typeof item.videoId === 'string' && typeof item.locale === 'string') {
    // The default goes back only when this upload set one and Nexus read the one before it.
    const restore = item.setDefault && typeof item.defaultBefore === 'string' ? item.defaultBefore : null
    return [{ kind: 'captions', videoId: item.videoId, locale: item.locale, ...(restore ? { restoreDefault: restore } : {}) }]
  }
  return []
})

/**
 * Undo: an upload's NEW images and videos come out of the ad account's library again, and the caption locale it added comes
 * off its video (kind undo, through this same tool: a person approves it, and it removes only what a create-meta-media
 * change of this business made new). A folder has no undo (Meta cannot delete one); a removal has none (Meta cannot put a
 * file back).
 */
const mediaUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as Stamped
    if (after.kind !== 'image' && after.kind !== 'video' && after.kind !== 'captions') return after
    const account = await recordAccount(after)
    if (!account) return null
    const act = `act_${account.adAccountId}`
    const uploads = newUploads(after)
    const hashes = uploads.flatMap((u) => (u.kind === 'image' ? [u.hash] : []))
    const present = new Set<string>()
    if (hashes.length) {
      const read = await metaReadOne<{ data?: Array<{ hash?: unknown; status?: unknown }> }>({ connectionId: account.target.connectionId }, { operation: 'media.undoRead', path: `${act}/adimages`, query: { hashes, fields: 'hash,status' } })
      for (const row of read.body.data ?? []) if (typeof row.hash === 'string' && row.status !== 'DELETED') present.add(`image:${row.hash}`)
    }
    if (uploads.some((u) => u.kind === 'video')) {
      // Review B3 — a video-ads upload is read on act_<id>/video_ads too (libraryVideos reads both edges).
      const library = await libraryVideos(account.target.connectionId, account.adAccountId)
      for (const id of library.ids) present.add(`video:${id}`)
    }
    for (const upload of uploads) {
      if (upload.kind === 'captions' && (await videoCaptions(account.target.connectionId, upload.videoId)).locales.has(upload.locale)) present.add(`captions:${upload.videoId}:${upload.locale}`)
    }
    const keyOfItem = (item: Record<string, unknown>) => (item.kind === 'image' ? `image:${String(item.hash)}` : item.kind === 'video' ? `video:${String(item.videoId)}` : `captions:${String(item.videoId)}:${String(item.locale)}`)
    const gone = (item: Record<string, unknown>) => item.new === true && !present.has(keyOfItem(item))
    return { ...after, items: (after.items ?? []).map((item) => (gone(item) ? { ...item, gone: true } : item)), accountId: account.accountId, adAccountId: account.adAccountId }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as Stamped
    if (after.kind === 'folder') return { refusal: 'Meta has no API to delete or rename a media-library folder, so Nexus cannot take this one back (a person can in Business Settings › Media library).' }
    if (after.kind === 'undo') return { refusal: 'Meta cannot put a removed image, video or caption back: upload it again with create-meta-media (an image gets the same hash).' }
    const uploads = newUploads(after)
    if (!uploads.length) {
      return { refusal: 'This upload made nothing new that Nexus may take back: what it sent was already in the ad account (or Nexus could not prove it was not), and Nexus never removes a file it did not create.' }
    }
    return {
      tool: MEDIA_TOOL,
      args: {
        ...(after.accountId ? { connectionId: after.accountId } : {}),
        kind: 'undo',
        uploads,
        why: 'undo of an earlier Meta upload: only what it made new comes out of the ad account\'s library or off its video (an image or video a creative uses stays)',
      },
    }
  },
}

// ── the tool ────────────────────────────────────────────────────────────────────────────────────────────────────────

const createMetaMedia: AgentTool = {
  name: MEDIA_TOOL,
  title: 'Upload Meta media',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // An image, video or caption it made new can be taken back (while no creative uses it); a folder or a removal cannot be.
  reversibility: 'partial',
  consequencesFor: (args) => (args.kind === 'folder' || args.kind === 'undo' ? { reversibility: 'none' } : args.kind === 'image' || args.kind === 'video' || args.kind === 'captions' ? { reversibility: 'partial' } : null),
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: z.object({
    connectionId: metaConnectionArg,
    kind: z.enum(MEDIA_KINDS).describe('image | video | folder | captions | undo (take back what an earlier upload made new); thumbnail, playable: Nexus answers why it uploads none'),
    images: z.array(z.object({
      libraryImageId: libraryIdArg('an image of this business\'s Nexus image library: da_… (a library file) or pi_… (a product photo), as image-library lists them').optional(),
      imageUrl: httpsArg('or a public https:// link to a JPG or PNG (Nexus fetches it through its safe public fetch)').optional(),
    })).min(1).max(MAX_IMAGES).optional().describe(`kind image: up to ${MAX_IMAGES} images, each a JPG or PNG of at most 8 MB`),
    copyFromAccount: z.object({
      sourceAccountId: metaIdArg('the other ad account (digits, no act_)'),
      hash: hashArg,
    }).optional().describe('kind image: copy an image from another ad account — Nexus refuses it in words (one ad account per business)'),
    video: z.object({
      libraryVideoId: libraryIdArg('a video of this business\'s Nexus image library (da_…, type video): Meta fetches it from its link').optional(),
      videoUrl: httpsArg('or a public https:// link to the video: Meta fetches it (no sign-in, no expiring signature); Nexus fetches nothing').optional(),
      instagramMediaId: metaIdArg('or a video (a Reel or a post) of the business\'s chosen Instagram account (meta-instagram-media lists them)').optional(),
      method: z.enum(VIDEO_METHODS).optional().describe('advideos (default: Meta fetches the link onto the ad account), video_ads (Meta\'s v26 video-ads upload of the same link: start, link, finish), chunked (answered: Nexus sends no video bytes)'),
      name: textArg(META_MEDIA_TEXT.name, 'advideos: its name in the library'),
      title: textArg(META_MEDIA_TEXT.title, 'advideos: its title (at most 254 UTF-8 bytes: Meta counts some characters as more than one)'),
      description: textArg(META_MEDIA_TEXT.description, 'advideos: its description'),
      swapAudioAssetId: metaIdArg('with instagramMediaId: swap the Reel\'s copyrighted music for this Meta Sound Collection audio (Meta\'s id)').optional(),
    }).optional().describe('kind video: one video'),
    folder: z.object({
      name: z.string().trim().min(1).max(META_MEDIA_TEXT.folderName).describe('the folder\'s name'),
      description: textArg(META_MEDIA_TEXT.folderDescription, 'its description'),
      parentFolderId: metaIdArg('inside this folder of the portfolio (meta-media-library view folders lists them)').optional(),
    }).optional().describe('kind folder: a folder in the business portfolio\'s media library'),
    captions: z.object({
      videoId: metaIdArg('a video of the chosen ad account\'s library (meta-media-library view videos lists them)'),
      locale: localeArg('the captions\' locale (it_IT, en_US): Meta takes each locale once per video'),
      srt: z.string().min(1).max(META_CAPTIONS_MAX_BYTES).describe('the caption file\'s text, SubRip (.srt): numbered blocks, each a time line (00:00:01,000 --> 00:00:04,000) and its text; UTF-8, at most 200 KB'),
      fileName: z.string().trim().min(1).max(40).optional().describe('the file name before .<locale>.srt (letters, digits, - and _); default: captions'),
      defaultLocale: z.string().trim().regex(/^([a-z]{2}_[A-Z]{2}|none)$/, 'a locale or none').optional().describe('the video\'s default caption from now: this locale, another it already has, or none'),
    }).optional().describe('kind captions: an SRT caption file onto a video of the chosen ad account\'s library'),
    uploads: z.array(z.object({
      kind: z.enum(['image', 'video', 'captions']).describe('image, video or captions'),
      hash: hashArg.optional(),
      videoId: metaIdArg('the video\'s id').optional(),
      locale: localeArg('captions: the locale the upload added').optional(),
      restoreDefault: z.string().trim().regex(/^([a-z]{2}_[A-Z]{2}|none)$/).optional().describe('captions: the default caption to put back (the one the upload replaced)'),
    }).refine((u) => (u.kind === 'image'
      ? !!u.hash && !u.videoId && !u.locale && !u.restoreDefault
      : u.kind === 'video' ? !!u.videoId && !u.hash && !u.locale && !u.restoreDefault : !!u.videoId && !!u.locale && !u.hash), 'an image names its hash, a video its videoId, a caption its videoId and locale')).min(1).max(MAX_UNDO).optional().describe('kind undo: the images (by hash), videos (by id) and captions (video and locale) an earlier create-meta-media upload made new — undo-change fills it'),
    why: metaWhyArg,
  }),
  description:
    'Put media into the business\'s chosen Meta ad account (and folders into its business portfolio\'s media library), '
    + 'for creatives to use. kind image: up to 5 JPG or PNG images (at most 8 MB each) from Nexus\'s image library '
    + '(libraryImageId da_… / pi_…) or a public https link Nexus fetches through its safe public fetch; Meta answers each '
    + 'image\'s hash (a creative takes the hash). Copying an image from another ad account is refused: Nexus works with one ad '
    + 'account per business. kind video: one video — by its public link (a video of Nexus\'s library, or a link you give): Meta '
    + 'fetches it itself, Nexus relays no byte (method advideos, or video_ads: Meta\'s v26 video-ads upload of the same link) — '
    + 'or a video of the business\'s chosen Instagram account (instagramMediaId), optionally with its copyrighted music '
    + 'swapped for Meta Sound Collection audio (swapAudioAssetId). The run reads the video\'s processing status (ready, '
    + 'processing, error); if Meta refuses the business\'s system user, the answer says how the Owner uploads it in Meta\'s '
    + 'screens. kind folder: a folder (name, description, parent) in the portfolio\'s media library — not when another Nexus '
    + 'business uses an ad account of the same portfolio; Meta cannot delete a folder, so it stays. kind undo: takes back '
    + 'only what an earlier upload of this business made new (an image or a video while no creative uses it, a caption '
    + 'locale); undo-change asks for it. kind captions: an SRT text you give (UTF-8, at most 200 KB) and its locale onto a '
    + 'video of the chosen ad account\'s library, optionally its default caption (Meta takes each locale once; its undo '
    + 'takes the locale off again). thumbnail and playable are answered in words: Meta takes a custom thumbnail only for a '
    + 'video associated with a Page (it comes with the Page step; a creative sets its video\'s thumbnail itself), and Nexus '
    + 'holds no HTML5 playable files. An upload SPENDS NOTHING (it is used only once a creative and an ad use it) and Meta '
    + 'has no check for it (no validate_only on these edges): the preview says so. Image bytes and caption files are never '
    + 'stored or logged.'
    + META_CHANGE_RULES,
  undo: mediaUndo,
  handler: (args, ctx) => {
    const answer = mediaPlainAnswer(args.kind as MediaKind, { video: args.video as VideoSource | undefined, copyFrom: args.copyFromAccount })
    if (answer) return Promise.resolve({ ok: false, error: answer })
    return metaChangePreview(args, ctx, build(args))
  },
  execute: (args, ctx) => {
    const answer = mediaPlainAnswer(args.kind as MediaKind, { video: args.video as VideoSource | undefined, copyFrom: args.copyFromAccount })
    if (answer) return Promise.resolve({ ok: false, error: `Not run: ${answer}` })
    return runMetaChange(args, ctx, build(args), finish)
  },
}

export const META_ADS_MEDIA_UPLOAD_TOOLS: AgentTool[] = [createMetaMedia]
