/**
 * Meta step 22 — the live state a delete (remove-meta-ads-items) stands on, read from Meta now (GET through the gateway):
 *   - each campaign, ad set or ad named: its account, kind, name and status (a DELETED one is read by its own id: Meta keeps
 *     it readable), and EVERY ad set and ad under it — archived ones included (edges list every status but DELETED) —
 *     with what each delivers now; an ad set's campaign and its budget (a campaign budget's share moves to the other ad
 *     sets), and those other ad sets; an ad's ad set's sequence and dynamic creative flag (Meta refuses those ads alone);
 *   - each creative named: its account, kind and status, and the account's ads that use it (one look at the account's
 *     ads, at most 500, every status but DELETED) — with each ad's creative's videos when a video or its captions are named;
 *   - each image named by its hash: the chosen ad account's library entry (status, the creatives Meta says use it) and the
 *     status of those creatives;
 *   - the chosen ad account's video library (at most 500) for each video named, and the caption languages of a video;
 *   - the chosen Page's Instant Experience parts (at most 500, by each part's own id) for each part named.
 * Built on step 6's reads (live-objects.ts listPaged, the list statuses) and step 17's account and kind check (the fields
 * only a kind has: services/meta/meta-kinds.ts) — never a copy. Nothing here stores anything; an object of another ad
 * account, another kind or another Page is a problem in words, never read further.
 *
 * Checked 2026-10-21 (developers.facebook.com/documentation/ads-commerce/marketing-api/…, `.md`): reference/ad-image.md
 * (AdImage `creatives` "A list of ad creative IDs that this ad image is being used in", `status` ACTIVE | INTERNAL |
 * DELETED); reference/ad-account/adimages.md (read filter `hashes`); reference/ad-account/advideos.md ("Ad account library
 * video ID"); reference/ad-creative.md (`status` ACTIVE | IN_PROCESS | WITH_ISSUES | DELETED); reference/adgroup.md ("You
 * cannot delete ads in ad set with creative_sequence settings"); error-reference.md 1340029 ("deletion of Dynamic
 * Creative Ad is not allowed. Please proceed by deleting parent Ad Set"); best-practices/manage-your-ad-object-status.md
 * (DELETED objects are read by their own id; an edge refuses a DELETED filter); graph-api/reference/video/captions
 * (VideoCaption `locale`); guides/instant-experiences.md (page/canvas_elements).
 */
import { metaAdAccountId, metaObjectId } from '../../cx/connectors/meta/discovery.js'
import { META_KIND_FIELDS } from '../../meta/meta-kinds.js'
import { MetaReadError } from './errors.js'
import { AD_LIST_STATUSES, ADSET_LIST_STATUSES, listPaged, MAX_ROWS } from './live-objects.js'
import { metaReadOne } from './read-client.js'
import type { MetaSettingsTarget } from './live-settings.js'

type Row = Record<string, unknown>
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const idText = (v: unknown): string | null => ((typeof v === 'string' || typeof v === 'number') && /^\d{1,25}$/.test(String(v)) ? String(v) : null)
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
/** A list Meta answers as an array or as {data: [...]}. */
const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : Array.isArray(obj(v)?.data) ? obj(v)!.data as unknown[] : [])
const positive = (v: unknown): boolean => { const n = Number(v); return v !== null && v !== undefined && v !== '' && Number.isFinite(n) && n > 0 }

export type RemoveObjectKind = 'campaign' | 'adset' | 'ad'
export const REMOVE_WORD: Readonly<Record<RemoveObjectKind | 'creative', string>> = { campaign: 'campaign', adset: 'ad set', ad: 'ad', creative: 'creative' }

/** Ad sets and ads that go with a campaign or an ad set, and the most read under one object. */
export interface RemoveChild { kind: 'adset' | 'ad'; id: string; name: string | null; status: string | null; effectiveStatus: string | null; creativeId: string | null }
export const MAX_CHILDREN = MAX_ROWS

/** One campaign, ad set or ad as Meta has it now. */
export interface RemoveObject {
  kind: RemoveObjectKind
  id: string
  name: string | null
  status: string | null
  effectiveStatus: string | null
  /** An ad set's or an ad's campaign; an ad's ad set. */
  campaignId: string | null
  adSetId: string | null
  /** An ad's creative. */
  creativeId: string | null
  /** Meta refuses to delete this ad on its own (in words), or null. */
  undeletable: string | null
  /** Every ad set (a campaign's) and ad (a campaign's or an ad set's) under it now, every status but DELETED. */
  children: RemoveChild[]
  /** More under it than Nexus reads at once (MAX_CHILDREN per list). */
  childrenMore: boolean
  /** An ad set under a campaign budget: its campaign, and the campaign's other ad sets (not deleted). */
  campaignBudget: { campaignId: string; name: string | null; otherAdSets: Array<{ id: string; effectiveStatus: string | null }>; more: boolean } | null
  /** A campaign's smart_promotion_type when it marks a legacy Advantage+ shopping or app campaign (else null). */
  legacy: string | null
}

/** smart_promotion_type of a legacy Advantage+ shopping / app campaign (change-campaign-settings.ts reads the same). */
const LEGACY_PROMOTION = new Set(['AUTOMATED_SHOPPING_ADS', 'SMART_APP_PROMOTION'])

/** The fields of one read, per kind: its account, its kind's own two fields, its name and status, its parents. */
export const REMOVE_FIELDS: Readonly<Record<RemoveObjectKind, string>> = {
  campaign: `id,account_id,name,status,${META_KIND_FIELDS.campaign.join(',')},smart_promotion_type`,
  adset: `id,account_id,name,status,${META_KIND_FIELDS.adset.join(',')},effective_status,campaign_id,campaign{id,name,daily_budget,lifetime_budget}`,
  ad: `id,account_id,name,status,effective_status,${META_KIND_FIELDS.ad[0]},campaign_id,creative{id},adset{id,creative_sequence,is_dynamic_creative}`,
}

/** What the reads found: the objects by `kind:id`, and every problem in words (the change is then refused). */
export interface RemoveObjects { objects: Map<string, RemoveObject>; problems: string[] }

const article = (word: string) => (/^[aeiou]/.test(word) ? 'an' : 'a')

/** A read's failure in words: Meta does not know it, it is another kind, or it could not be read. */
function readProblem(err: MetaReadError, id: string, word: string): string {
  if (err.failure.notFound) return `Meta does not find ${word} ${id} (or the system user cannot see it): nothing to delete.`
  if (/nonexisting field/i.test(err.message)) return `${id} is not ${article(word)} ${word} (Meta: ${err.message}); name its kind as meta-ads-live shows it.`
  return `Nexus could not read ${word} ${id} from Meta: ${err.message}`
}

/** The ad sets or ads under an object (every status but DELETED), at most MAX_CHILDREN. */
async function childrenOf(target: MetaSettingsTarget, id: string, edge: 'adsets' | 'ads'): Promise<{ rows: RemoveChild[]; more: boolean }> {
  const read = await listPaged(target.connectionId, `remove.read.${edge}`, `${id}/${edge}`, {
    fields: edge === 'ads' ? 'id,name,status,effective_status,creative{id}' : 'id,name,status,effective_status',
    effective_status: [...(edge === 'ads' ? AD_LIST_STATUSES : ADSET_LIST_STATUSES)],
  }, MAX_CHILDREN)
  return {
    rows: read.rows.flatMap((r) => { const child = idText(r.id); return child ? [{ kind: edge === 'ads' ? 'ad' as const : 'adset' as const, id: child, name: text(r.name), status: text(r.status), effectiveStatus: text(r.effective_status), creativeId: idText(obj(r.creative)?.id) }] : [] }),
    more: read.more,
  }
}

/**
 * Each campaign, ad set or ad, read one by one (Meta's v26 has no read of several ids at once, facts F1 X6), then what goes
 * with it. A lost token or Meta's "slow down" ends the reading (the next items would get the same answer).
 */
export async function liveRemoveObjects(target: MetaSettingsTarget, items: ReadonlyArray<{ kind: RemoveObjectKind; id: string }>): Promise<RemoveObjects> {
  const objects = new Map<string, RemoveObject>()
  const problems: string[] = []
  for (const item of items) {
    const key = `${item.kind}:${item.id}`
    if (objects.has(key)) continue
    const word = REMOVE_WORD[item.kind]
    const what = `${word} ${item.id}`
    try {
      const body = (await metaReadOne({ connectionId: target.connectionId }, { operation: `remove.read.${item.kind}`, path: item.id, query: { fields: REMOVE_FIELDS[item.kind] } })).body as Row
      if (metaAdAccountId(body.account_id) !== target.adAccountId) { problems.push(`${what} is not of the Meta ad account this business chose: Nexus deletes nothing in another account.`); continue }
      if (META_KIND_FIELDS[item.kind].some((f) => body[f] === undefined || body[f] === null || body[f] === '')) { problems.push(`${item.id} is not ${article(word)} ${word} (Meta answered without ${article(word)} ${word}'s own fields); name its kind as meta-ads-live shows it.`); continue }
      const status = text(body.status)
      const adSet = obj(body.adset)
      const campaign = obj(body.campaign)
      const object: RemoveObject = {
        kind: item.kind, id: item.id, name: text(body.name), status, effectiveStatus: text(body.effective_status),
        campaignId: item.kind === 'campaign' ? null : idText(body.campaign_id) ?? idText(campaign?.id),
        adSetId: item.kind === 'ad' ? idText(body.adset_id) ?? idText(adSet?.id) : null,
        creativeId: item.kind === 'ad' ? idText(obj(body.creative)?.id) : null,
        undeletable: null, children: [], childrenMore: false, campaignBudget: null,
        legacy: item.kind === 'campaign' && LEGACY_PROMOTION.has(text(body.smart_promotion_type) ?? '') ? text(body.smart_promotion_type) : null,
      }
      if (status !== 'DELETED') {
        if (item.kind === 'ad') {
          const set = object.adSetId ? `its ad set (${object.adSetId})` : 'its ad set'
          if (listOf(adSet?.creative_sequence).length > 0) {
            object.undeletable = `Meta refuses to delete an ad of an ad set that shows its ads in a sequence (reference/adgroup.md): pause the ad with set-meta-status, or delete ${set} here with all its ads.`
          } else if (adSet?.is_dynamic_creative === true || adSet?.is_dynamic_creative === 'true') {
            object.undeletable = `Meta refuses to delete a dynamic creative ad on its own (error 1340029: "please proceed by deleting parent Ad Set"): delete ${set} here with all its ads, or pause the ad with set-meta-status.`
          }
        }
        const edges: Array<'adsets' | 'ads'> = item.kind === 'campaign' ? ['adsets', 'ads'] : item.kind === 'adset' ? ['ads'] : []
        for (const edge of edges) {
          const read = await childrenOf(target, item.id, edge)
          object.children.push(...read.rows)
          object.childrenMore ||= read.more
        }
        // An ad set under a campaign budget (daily or lifetime on the campaign): Meta spreads it over the other ad sets.
        if (item.kind === 'adset' && campaign && (positive(campaign.daily_budget) || positive(campaign.lifetime_budget)) && object.campaignId) {
          const siblings = await childrenOf(target, object.campaignId, 'adsets')
          object.campaignBudget = {
            campaignId: object.campaignId, name: text(campaign.name),
            otherAdSets: siblings.rows.filter((s) => s.id !== item.id).map((s) => ({ id: s.id, effectiveStatus: s.effectiveStatus })), more: siblings.more,
          }
        }
      }
      objects.set(key, object)
    } catch (err) {
      if (!(err instanceof MetaReadError)) throw err
      problems.push(readProblem(err, item.id, word))
      if (err.failure.authLost || err.failure.throttled) break
    }
  }
  return { objects, problems }
}

// ── creatives ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface RemoveCreative { id: string; name: string | null; status: string | null; objectType: string | null }

/** Each creative named: of the chosen ad account and a creative (its account_id, object_type and status). */
export async function liveRemoveCreatives(target: MetaSettingsTarget, ids: readonly string[]): Promise<{ creatives: Map<string, RemoveCreative>; problems: string[] }> {
  const creatives = new Map<string, RemoveCreative>()
  const problems: string[] = []
  for (const id of ids) {
    if (creatives.has(id)) continue
    try {
      const body = (await metaReadOne({ connectionId: target.connectionId }, { operation: 'remove.read.creative', path: id, query: { fields: `id,account_id,name,${META_KIND_FIELDS.creative.join(',')}` } })).body as Row
      if (metaAdAccountId(body.account_id) !== target.adAccountId) { problems.push(`creative ${id} is not of the Meta ad account this business chose: Nexus deletes nothing in another account.`); continue }
      if (!text(body.object_type) || !text(body.status)) { problems.push(`${id} is not a creative (Meta answered without a creative's own fields).`); continue }
      creatives.set(id, { id, name: text(body.name), status: text(body.status), objectType: text(body.object_type) })
    } catch (err) {
      if (!(err instanceof MetaReadError)) throw err
      problems.push(readProblem(err, id, 'creative'))
      if (err.failure.authLost || err.failure.throttled) break
    }
  }
  return { creatives, problems }
}

/** An ad that uses a creative or shows a video (every status but DELETED). */
export interface CreativeUser { id: string; name: string | null; effectiveStatus: string | null }

/** The account's ads by the creative each uses and by the videos that creative shows; `more` when it has more than 500. */
export interface AdsUsing { byCreative: Map<string, CreativeUser[]>; byVideo: Map<string, CreativeUser[]> | null; more: boolean }

/**
 * Review B1 — the creative fields that name a video (reference/ad-creative.md): `video_id` ("Facebook object ID for video
 * in this ad"), `object_story_spec.video_data.video_id` and `asset_feed_spec.videos` (each {video_id, …}).
 */
export const CREATIVE_VIDEO_FIELDS = 'creative{id,video_id,object_story_spec{video_data{video_id}},asset_feed_spec{videos}}'

/** The video ids a creative (as `CREATIVE_VIDEO_FIELDS` reads it) shows. */
export function videosOfCreative(creative: Row | null): string[] {
  if (!creative) return []
  const ids = [
    idText(creative.video_id),
    idText(obj(obj(creative.object_story_spec)?.video_data)?.video_id),
    ...listOf(obj(creative.asset_feed_spec)?.videos).map((v) => idText(obj(v)?.video_id)),
  ]
  return [...new Set(ids.filter((v): v is string => !!v))]
}

/**
 * The chosen ad account's ads by the creative each uses (and, `withVideos`, by the videos that creative shows) — ONE look at
 * the account's ads (every status but DELETED, at most 500; `more` when the account has more). Meta documents no filter by
 * creative on act_<id>/ads (step 6, CR-007), and neither a creative nor a video has a list of its ads: this is the one way
 * to know. A creative no ad uses is not seen here.
 */
export async function liveAdsByCreative(target: MetaSettingsTarget, withVideos = false): Promise<AdsUsing> {
  const read = await listPaged(target.connectionId, 'remove.read.accountAds', `act_${target.adAccountId}/ads`, {
    fields: `id,account_id,name,effective_status,${withVideos ? CREATIVE_VIDEO_FIELDS : 'creative{id}'}`, effective_status: [...AD_LIST_STATUSES],
  }, MAX_ROWS)
  const byCreative = new Map<string, CreativeUser[]>()
  const byVideo = withVideos ? new Map<string, CreativeUser[]>() : null
  for (const r of read.rows) {
    if (r.account_id !== undefined && metaAdAccountId(r.account_id) !== target.adAccountId) continue
    const creative = obj(r.creative)
    const creativeId = idText(creative?.id)
    const id = idText(r.id)
    if (!id) continue
    const user = { id, name: text(r.name), effectiveStatus: text(r.effective_status) }
    if (creativeId) byCreative.set(creativeId, [...(byCreative.get(creativeId) ?? []), user])
    if (byVideo) for (const v of videosOfCreative(creative)) byVideo.set(v, [...(byVideo.get(v) ?? []), user])
  }
  return { byCreative, byVideo, more: read.more }
}

// ── the library: images, videos, captions ────────────────────────────────────────────────────────────────────────

export interface RemoveImage { hash: string; name: string | null; status: string | null; creatives: string[] }

/** The images of the chosen ad account's library with these hashes (one read, `hashes` filter); a hash not answered is absent. */
export async function liveRemoveImages(target: MetaSettingsTarget, hashes: readonly string[]): Promise<Map<string, RemoveImage>> {
  const read = await listPaged(target.connectionId, 'remove.read.images', `act_${target.adAccountId}/adimages`, { fields: 'id,hash,name,status,creatives', hashes: [...hashes] }, MAX_ROWS)
  const images = new Map<string, RemoveImage>()
  for (const r of read.rows) {
    const hash = text(r.hash)
    if (!hash || !hashes.includes(hash)) continue
    const creatives = listOf(r.creatives).map((c) => idText(obj(c)?.id ?? c)).filter((c): c is string => !!c)
    images.set(hash, { hash, name: text(r.name), status: text(r.status), creatives: [...new Set(creatives)] })
  }
  return images
}

/** A creative's status (to tell a creative Meta still lists on an image from one already deleted), or null when unread. */
export async function liveCreativeStatus(target: MetaSettingsTarget, id: string): Promise<{ status: string | null; ours: boolean } | null> {
  try {
    const body = (await metaReadOne({ connectionId: target.connectionId }, { operation: 'remove.read.imageCreative', path: id, query: { fields: 'id,account_id,status,object_type' } })).body as Row
    return { status: text(body.status), ours: metaAdAccountId(body.account_id) === target.adAccountId }
  } catch (err) {
    if (err instanceof MetaReadError) return null
    throw err
  }
}

/** The chosen ad account's video library (its first 500 videos: id, description, when made). */
export async function liveVideoLibrary(target: MetaSettingsTarget): Promise<{ videos: Map<string, { description: string | null; createdTime: string | null }>; more: boolean }> {
  const read = await listPaged(target.connectionId, 'remove.read.videos', `act_${target.adAccountId}/advideos`, { fields: 'id,description,created_time' }, MAX_ROWS)
  const videos = new Map<string, { description: string | null; createdTime: string | null }>()
  for (const r of read.rows) {
    const id = idText(r.id)
    if (id) videos.set(id, { description: text(r.description), createdTime: text(r.created_time) })
  }
  return { videos, more: read.more }
}

/** A video's caption languages (VideoCaption `locale`), or Meta's words when they could not be read. */
export async function liveVideoCaptions(target: MetaSettingsTarget, videoId: string): Promise<{ locales: string[] } | { unread: string }> {
  try {
    const read = await listPaged(target.connectionId, 'remove.read.captions', `${videoId}/captions`, { fields: 'locale' }, 100)
    return { locales: [...new Set(read.rows.map((r) => text(r.locale)).filter((l): l is string => !!l))] }
  } catch (err) {
    if (err instanceof MetaReadError) return { unread: err.message }
    throw err
  }
}

// ── Instant Experience parts ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The chosen Page's Instant Experience parts (its first 500), by each part's OWN id (the row's `id`; review A6: never an id
 * inside it — LIVE-PROBES CR-487). A Page read may need the Page's own token: Meta's words then say so.
 */
export async function livePageCanvasElements(target: MetaSettingsTarget, pageId: string): Promise<{ ids: Set<string>; more: boolean }> {
  const read = await listPaged(target.connectionId, 'remove.read.canvasElements', `${pageId}/canvas_elements`, { fields: 'id' }, MAX_ROWS)
  const ids = new Set<string>()
  for (const r of read.rows) { const id = metaObjectId(r.id); if (id) ids.add(id) }
  return { ids, more: read.more }
}
