/**
 * Meta ads changes, step 22 — remove-meta-ads-items: DELETE, on the person's explicit ask only, campaigns, ad sets, ads,
 * creatives, images (by their hash) and videos of the business's chosen Meta ad account, caption languages of one of its
 * videos, and parts of an Instant Experience of its chosen Page (master rows CMP-050, CMP-051 answered, AS-036, AD-045,
 * AD-046, CR-012, CR-487, MD-007, MD-019, MD-027). A Nexus change like every other Meta change (meta-ads-kit.ts): a preview
 * from the live state, an approvalId, a person approves it, it runs as that person request by request.
 *
 * Explicit ask only: `confirmDelete: true` is required (the caller sets it only when the person asked to DELETE — never to
 * pause, archive or stop), and the description says so; a stop for a while is set-meta-status (pause) or a lower bid.
 * Reversibility 'none', no undo: Meta keeps nothing to restore — a DELETED campaign, ad set, ad or creative never changes
 * again (only its name; best-practices/manage-your-ad-object-status.md), an image or video comes back only by uploading its
 * file again (reference/ad-image.md, ad-account/advideos.md), caption languages only by uploading their SRT again, an
 * Instant Experience part only by making it again.
 *
 * CMP-051 (Meta's bulk delete, DELETE act_<id>/campaigns with delete_strategy, before_date, object_count: reference/
 * ad-account/campaigns.md "Deleting", checked 2026-10-21; facts F1 M3b-04: "Nexus: never use the bulk form") is never
 * sent: with DELETE_ANY or DELETE_OLDEST Meta picks which campaigns die; with DELETE_ARCHIVED_BEFORE Meta does not say which
 * date it compares ("delete campaigns before this date") and a call may stop partway (it answers
 * objects_left_to_delete_count) — so no preview could name exactly what goes. Its job — clearing old archived campaigns —
 * is done here by name: meta-campaigns lists the archived ones, and up to 50 go in one request, each listed with
 * everything under it.
 * AD-046 (many ads at once: Meta's batch, not all-or-nothing) is the same request: up to 50 items, each its own request.
 * Meta's own MCP has no delete tool (its CLI deletes one object without a preview); this one lists every child that goes,
 * refuses where Meta would, and answers step by step.
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool } from '../tool-types.js'
import { metaChangePreview, metaConnectionArg, metaIdArg, metaWhyArg, META_CHANGE_RULES, runMetaChange, type MetaDraftBuilder } from './meta-ads-kit.js'
import { metaChosenAccount, MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import { MetaReadError } from '../../marketing/meta-ads/errors.js'
import {
  liveAdsByCreative, liveCreativeStatus, livePageCanvasElements, liveRemoveCreatives, liveRemoveImages, liveRemoveObjects, liveVideoCaptions, liveVideoLibrary,
  type RemoveObjectKind,
} from '../../marketing/meta-ads/live-remove.js'
import { MAX_IMAGE_CREATIVES, metaRemoveDraft, REMOVE_KINDS, type RemoveItem, type RemoveLive, type RemoveRecord } from '../../marketing/meta-ads/change-remove.js'
import { recordStatusReadBack } from '../../marketing/meta-ads/store.js'
import { META_CAPTION_LOCALE, META_IMAGE_HASH, MAX_CAPTION_LOCALES } from '../../gateway/meta-remove-rules.js'

/**
 * The most items one request deletes — Meta's own batch limit (a Graph batch takes 50 operations, facts F1 X6). At Meta's
 * Limited access tier an ad account takes about 20 changes per 5 minutes: the kit sends them in order and stops when Meta
 * says to slow down, and the answer lists what was not sent.
 */
const MAX_ITEMS = 50
const OBJECT_KINDS: readonly RemoveObjectKind[] = ['campaign', 'adset', 'ad']

/** The items as asked, each with exactly what its kind takes — or why not. */
function itemsOf(args: Record<string, unknown>): RemoveItem[] | { refusal: string } {
  const raw = (Array.isArray(args.items) ? args.items : []) as RemoveItem[]
  for (const [n, i] of raw.entries()) {
    const at = `item ${n + 1} (${i.kind})`
    if (i.kind === 'image') {
      if (!i.hash || i.id || i.locales) return { refusal: `${at}: an image is named by its hash only (meta-media-library view images shows it).` }
    } else if (i.kind === 'captions') {
      if (!i.id || !i.locales?.length || i.hash) return { refusal: `${at}: caption languages are named by the video's id and the locales to delete (meta-media-library view video shows them).` }
    } else if (!i.id || i.hash || i.locales) {
      return { refusal: `${at}: name it by its Meta id only.` }
    }
  }
  return raw
}

/** Reads what the items stand on (live-remove.ts), then the draft (change-remove.ts). */
const buildRemove = (args: Record<string, unknown>): MetaDraftBuilder => async (account) => {
  const items = itemsOf(args)
  if ('refusal' in items) return items
  const target = account.target
  try {
    const objectItems = items.filter((i): i is RemoveItem & { kind: RemoveObjectKind; id: string } => (OBJECT_KINDS as readonly string[]).includes(i.kind) && !!i.id)
    const objects = objectItems.length ? await liveRemoveObjects(target, objectItems) : { objects: new Map(), problems: [] }
    const creativeIds = items.filter((i) => i.kind === 'creative').map((i) => i.id!)
    const creatives = creativeIds.length ? await liveRemoveCreatives(target, creativeIds) : { creatives: new Map(), problems: [] }
    const aliveCreatives = [...creatives.creatives.values()].filter((c) => c.status !== 'DELETED')
    // One look at the account's ads: which use a named creative, and (review B1) which show a named video.
    const withVideos = items.some((i) => i.kind === 'video' || i.kind === 'captions')
    const adsByCreative = aliveCreatives.length || withVideos ? await liveAdsByCreative(target, withVideos) : null
    const hashes = items.filter((i) => i.kind === 'image').map((i) => i.hash!)
    const images = hashes.length ? await liveRemoveImages(target, [...new Set(hashes)]) : new Map()
    // The creatives Meta lists on an image that this request does not name: their status now (a deleted one is no user).
    const imageCreatives = new Map<string, { status: string | null; ours: boolean } | null>()
    for (const image of images.values()) {
      const others = image.creatives.filter((c: string) => !creativeIds.includes(c))
      if (others.length > MAX_IMAGE_CREATIVES) continue
      for (const c of others) if (!imageCreatives.has(c)) imageCreatives.set(c, await liveCreativeStatus(target, c))
    }
    const videoIds = items.filter((i) => i.kind === 'video' || i.kind === 'captions').map((i) => i.id!)
    const library = videoIds.length ? await liveVideoLibrary(target) : null
    const captions = new Map<string, { locales: string[] } | { unread: string }>()
    for (const i of items.filter((x) => x.kind === 'captions')) {
      if (library?.videos.has(i.id!) && !captions.has(i.id!)) captions.set(i.id!, await liveVideoCaptions(target, i.id!))
    }
    let page: RemoveLive['page'] = null
    if (items.some((i) => i.kind === 'canvaselement')) {
      const pageId = (await metaChosenAccount(account.accountId)).pageId
      if (pageId) {
        try {
          const listed = await livePageCanvasElements(target, pageId)
          page = { pageId, has: listed.ids, more: listed.more }
        } catch (err) {
          if (!(err instanceof MetaReadError)) throw err
          page = { unread: err.message }
        }
      }
    }
    return metaRemoveDraft({ items }, {
      adAccountId: account.adAccountId,
      objects: objects.objects,
      creatives: creatives.creatives,
      adsByCreative,
      images,
      imageCreatives,
      library: library ? { has: new Set(videoIds.filter((id) => library.videos.has(id))), more: library.more } : null,
      captions,
      page,
      problems: [...objects.problems, ...creatives.problems],
    })
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refusal: err.message }
    throw err
  }
}

const removeMetaAdsItems: AgentTool = {
  name: 'remove-meta-ads-items',
  title: 'Delete Meta ads items (for good)',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // No undo: Meta keeps nothing to restore (see the header) — a deletion is final.
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: z.object({
    connectionId: metaConnectionArg,
    items: z.array(z.object({
      kind: z.enum(REMOVE_KINDS).describe('campaign, adset, ad, creative, image (by its hash), video (out of the ad account\'s library), captions (caption languages of a video) or canvaselement (a part of an Instant Experience of the chosen Page)'),
      id: metaIdArg('its id (every kind but image; for captions the video\'s id)').optional(),
      hash: z.string().trim().regex(META_IMAGE_HASH, 'an image hash is letters and digits').optional().describe('image only: its hash in the ad account\'s library (meta-media-library view images)'),
      locales: z.array(z.string().trim().regex(META_CAPTION_LOCALE, 'a caption language as Meta names it, e.g. en_US')).min(1).max(MAX_CAPTION_LOCALES).optional()
        .describe('captions only: the caption languages to delete (en_US, it_IT …; meta-media-library view video lists them)'),
    })).min(1).max(MAX_ITEMS).describe(`what to delete, at most ${MAX_ITEMS} (at most 10 images and videos: the library takes one change every 30 s); each is its own request, in order`),
    confirmDelete: z.literal(true).describe('true, set ONLY because the person explicitly asked to DELETE exactly these (not to pause, archive or stop them)'),
    why: metaWhyArg,
  }),
  description:
    'DELETE for good — only when the person explicitly asked to DELETE (confirmDelete true): campaigns, ad sets, ads, '
    + 'creatives, images (by hash) and videos of the business\'s chosen Meta ad account, caption languages of one of its '
    + 'videos, parts of an Instant Experience of its chosen Page. Never for a pause, an archive or "stop": to stop something '
    + 'for a while lower its bids (set-meta-ad-set) or pause it (set-meta-status); archive (set-meta-status) only what is '
    + 'meant for good. Deleting is FINAL, no undo: a deleted campaign, ad set, ad or creative never comes back, a campaign '
    + 'takes all its ad sets and ads with it, an ad set its ads. The preview lists EVERY ad set and ad that goes with a '
    + 'campaign or ad set (archived ones too), says what stops delivering, and that an ad set\'s share of a campaign budget '
    + 'moves to the other ad sets (the total stays). Refused in words, nothing deleted: an ad of a sequenced ad set, a '
    + 'dynamic creative ad alone (delete its ad set), a creative an ad uses, an image a creative uses or a video an ad '
    + 'shows unless those go in the same request, anything not of the chosen account or Page. Deleting caption languages '
    + 'names the ads that show the video (they change at once). Already deleted: skipped. At most 50 items (10 images '
    + 'and videos), each its own request in order; one that stands on another (a creative after its ads) goes only if that '
    + 'one happened. Meta\'s bulk campaign delete is never sent (Meta picks which die, or does not say which date it '
    + 'compares and may stop partway): list the archived campaigns (meta-campaigns) and name them here.'
    + META_CHANGE_RULES,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildRemove(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildRemove(args), (draft, done) => {
    const before = draft.before as RemoveRecord
    // Each request recorded one item, in the same order (change-remove.ts): the done ones are what was deleted.
    const byStep = new Map(draft.requests.map((r, i) => [r.step, before.items[i]]))
    const deleted = done.map((d) => byStep.get(d.request.step)).filter((i): i is RemoveRecord['items'][number] => !!i)
    return {
      data: { deleted: deleted.map((i) => ({ kind: i.kind, id: i.id, ...(i.locales ? { locales: i.locales } : {}) })), noUndo: 'A deletion on Meta is final: nothing here can be put back.' },
      before: { op: 'remove', items: deleted } satisfies RemoveRecord,
      after: { op: 'remove', items: deleted.map((i) => ({ kind: i.kind, id: i.id, ...(i.locales ? { locales: i.locales } : {}), status: 'DELETED' })) } satisfies RemoveRecord,
      // Review A5 — a partial run says there is no undo, never "Undo puts back only what Meta made".
      noUndo: 'A deletion on Meta is final: there is no undo, also for what Meta did delete.',
    }
  }, async (account, done) => {
    const objects = done.filter((d) => (OBJECT_KINDS as readonly string[]).includes(d.request.kind) && d.request.operation === `${d.request.kind}.delete`)
    const rows = objects.length
      ? await recordStatusReadBack(account.adAccountId, objects.map((d) => ({ kind: d.request.kind, id: d.request.objectId, status: 'DELETED', effectiveStatus: 'DELETED' })))
      : 0
    return rows
      ? 'Nexus\'s Meta pages show the deleted campaigns, ad sets and ads as deleted now; what went with them shows after the next daily read.'
      : 'Nexus\'s Meta pages show it after the next daily read; meta-ads-live and meta-media-library show it now.'
  }),
}

export const META_ADS_REMOVE_TOOLS: AgentTool[] = [removeMetaAdsItems]
