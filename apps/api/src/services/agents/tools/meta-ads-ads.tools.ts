/**
 * Meta ads step 27 (2026-10-21) — create-meta-ad and set-meta-ad: make an ad in an ad set of the business's chosen Meta ad
 * account (from an existing creative, or with a new creative made inline by step 25's builder — every silent feature OFF
 * unless asked; a website ad's "message us" footer; a multi-media ad; the flexible format; a persona; pixel tracking; a
 * conversion domain; its own schedule; an engagement audience), born PAUSED unless asked to start, and take back an ad it
 * made that never ran; rename an ad, swap its creative, change its labels and its own schedule (master rows of step 27;
 * marketing/meta-ads/change-ads.ts and gateway/meta-ad-rules.ts hold each rule and the Meta pages it was checked on). Nexus
 * changes like every other Meta change (meta-ads-kit.ts): a preview from what Meta holds now — Meta checks a new ad first
 * (validate_only with its synchronous integrity review, and its recommendations when asked) — an approvalId, a person
 * approves it, it runs as that person.
 *
 * Not here (C2-PAGE-TOKEN): Instant Experiences (create-meta-instant-experience, set-meta-instant-experience — master CR-473 …
 * CR-485, CR-488, CR-491 … CR-493) are Page writes that need the Page's own token; lane C4's step 36 (#714) builds that
 * gateway mode, and lane C2 builds both tools on it once it is merged (a tool that could only answer in words is not
 * registered: nothing unused stays). An ad may already USE a published Instant Experience: its link
 * https://fb.com/canvas_doc/<id> in the creative, checked to be the chosen Page's (step 25's judge).
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import { metaChangePreview, metaConnectionArg, metaIdArg, metaWhyArg, META_CHANGE_RULES, recordAccount, runMetaChange, type MetaDraftBuilder, type MetaRunOutcome } from './meta-ads-kit.js'
import {
  AD_SET_FIELDS, AD_TOOL, adDraft, adStateOf, MAX_AD_UNDO, MESSAGE_FOOTERS, SET_AD_TOOL, setAdDraft,
  type AdDraft, type AdRequest, type SetAdRequest,
} from '../../marketing/meta-ads/change-ads.js'
import type { CreativeRequest } from '../../marketing/meta-ads/change-creatives.js'
import type { MetaChangeDraft, MetaChangeRequest } from '../../marketing/meta-ads/change-draft.js'
import type { MetaChangeResult } from '../../marketing/meta-ads/write-client.js'
import { META_CREATIVE_FEATURES, META_CREATIVE_TEXT, META_FORMAT_AUTOMATION_FORMATS, META_FORMAT_DATA_SOURCES } from '../../gateway/meta-creative-rules.js'
import { META_AD_NAME_MAX, META_AD_TRACKING_ACTIONS, META_AD_TRACKING_MAX } from '../../gateway/meta-ad-rules.js'
import { metaReadOne } from '../../marketing/meta-ads/read-client.js'

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const spec = (what: string) => z.record(z.string(), z.unknown()).optional().describe(what)
const when = z.string().trim().datetime({ offset: true })

// ── create-meta-ad ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The inline creative as step 25's builder reads it (create-meta-creative's arguments; its name defaults to the ad's). */
function creativeOf(raw: Record<string, unknown> | undefined, adName: string | null): CreativeRequest | null {
  if (!raw) return null
  const partner = raw.partner as Record<string, unknown> | undefined
  return {
    action: 'create',
    name: str(raw.name) ?? adName,
    story: (raw.story as Record<string, unknown> | undefined) ?? null,
    postId: str(raw.postId),
    assetFeed: (raw.assetFeed as Record<string, unknown> | undefined) ?? null,
    parts: (raw.parts as Record<string, unknown> | undefined) ?? null,
    withInstagram: typeof raw.withInstagram === 'boolean' ? raw.withInstagram : null,
    aiFeatures: (raw.aiFeatures as string[] | undefined) ?? [],
    featureSettings: (raw.featureSettings as Record<string, Record<string, unknown>> | undefined) ?? {},
    multiAdvertiser: raw.multiAdvertiser === true,
    music: raw.music === 'random' ? 'random' : 'off',
    formatAutomation: (raw.formatAutomation as CreativeRequest['formatAutomation']) ?? [],
    autoProductTags: raw.autoProductTags === true,
    carouselAutoOrder: raw.carouselAutoOrder === true,
    partner: partner ? { pageId: str(partner.pageId), instagramId: str(partner.instagramId), mainIdentity: partner.mainIdentity === 'creator' ? 'creator' : 'brand' } : null,
  }
}

function requestOf(args: Record<string, unknown>): AdRequest {
  const persona = args.persona as Record<string, unknown> | undefined
  return {
    action: args.action === 'undo' ? 'undo' : 'create',
    name: str(args.name),
    adSetId: str(args.adSetId),
    creativeId: str(args.creativeId),
    creative: creativeOf(args.creative as Record<string, unknown> | undefined, str(args.name)),
    messageFooter: (args.messageFooter as AdRequest['messageFooter']) ?? null,
    activate: args.activate === true,
    labels: (args.labels as string[] | undefined) ?? null,
    tracking: (args.tracking as AdRequest['tracking']) ?? null,
    conversionDomain: str(args.conversionDomain),
    scheduleStart: str(args.scheduleStart),
    scheduleEnd: str(args.scheduleEnd),
    engagementAudience: args.engagementAudience === true,
    displaySequence: typeof args.displaySequence === 'number' ? args.displaySequence : null,
    priority: typeof args.priority === 'number' ? args.priority : null,
    flexibleGroups: (args.flexibleGroups as Array<Record<string, unknown>> | undefined) ?? null,
    persona: persona ? { ageMin: persona.ageMin as number | undefined, ageMax: persona.ageMax as number | undefined, genders: persona.genders as number[] | undefined } : null,
    recommendations: args.recommendations === true,
    ads: (args.ads as string[] | undefined) ?? [],
  }
}

const build = (args: Record<string, unknown>): MetaDraftBuilder => (account) => adDraft(account, requestOf(args))

/** What the run recorded: the ad it made and, for an inline creative, whether Meta made that creative NEW (only then its undo deletes it). */
function createFinish(draft: MetaChangeDraft, done: Array<{ request: MetaChangeRequest; result: MetaChangeResult }>): MetaRunOutcome {
  const d = draft as AdDraft
  if (d.ad.action === 'undo') {
    const ids = new Set(done.map(({ request }) => request.objectId))
    const items = ((d.after as { items?: Array<Record<string, unknown>> }).items ?? []).filter((i) => ids.has(String(i.kind === 'ad' ? i.adId : i.creativeId)))
    return { data: { deleted: items, note: 'Meta cannot bring a deleted ad back: make it again with create-meta-ad.' }, before: { kind: 'undo', items: items.map((i) => ({ kind: i.kind, ...(i.kind === 'ad' ? { adId: i.adId } : { creativeId: i.creativeId }), present: true })) }, after: { kind: 'undo', items } }
  }
  const items: Array<Record<string, unknown>> = []
  for (const { result } of done) {
    const node = (result.node ?? {}) as { adId?: unknown; status?: unknown; adset_id?: unknown; creativeId?: unknown; inlineCreative?: { creativeId?: unknown; new?: unknown; featuresOn?: unknown; name?: unknown } }
    const adId = typeof node.adId === 'string' ? node.adId : null
    items.push({ kind: 'ad', adId, adSetId: typeof node.adset_id === 'string' ? node.adset_id : null, name: d.ad.name ?? '', status: typeof node.status === 'string' ? node.status : null, creativeId: typeof node.creativeId === 'string' ? node.creativeId : null })
    const inline = node.inlineCreative
    if (inline && typeof inline.creativeId === 'string') {
      items.push({ kind: 'creative', creativeId: inline.creativeId, adId, name: typeof inline.name === 'string' ? inline.name : null, new: inline.new === true ? true : inline.new === false ? false : null, inline: true, featuresOn: Array.isArray(inline.featuresOn) ? inline.featuresOn.map(String) : [] })
    }
  }
  return {
    data: {
      made: items,
      details: done.map(({ request, result }) => ({ step: request.step, ...(result.node ?? {}) })),
      note: 'A new ad goes to Meta\'s review first. Its undo deletes it only while it has never run (then its inline creative too, when Meta made it new and no other ad uses it); an ad that has run is archived instead (set-meta-status).',
    },
    before: { kind: 'create', items: [] },
    after: { kind: 'create', items },
  }
}

type Stamped = { kind?: string; items?: Array<Record<string, unknown>>; accountId?: string; adAccountId?: string }

/** Undo of a create: the ads it made are deleted through this same tool — only while they never ran (the draft reads that first). */
const createUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as Stamped
    if (after.kind !== 'create') return after
    const account = await recordAccount(after)
    return account ? { ...after, accountId: account.accountId, adAccountId: account.adAccountId } : null
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as Stamped
    if (after.kind === 'undo') return { refusal: 'Meta cannot bring a deleted ad back: make it again with create-meta-ad.' }
    const ads = (after.items ?? []).filter((i) => i.kind === 'ad' && typeof i.adId === 'string').map((i) => String(i.adId))
    if (!ads.length) return { refusal: 'This change recorded no ad Meta made, so there is nothing to take back.' }
    return { tool: AD_TOOL, args: { ...(after.accountId ? { connectionId: after.accountId } : {}), action: 'undo', ads, why: 'undo of an earlier create-meta-ad: only an ad it made and that never ran is deleted (an ad that ran is archived instead)' } }
  },
}

const creativeArg = z.object({
  name: z.string().trim().min(1).max(META_CREATIVE_TEXT.name).optional().describe('the creative\'s name in the ad account (default: the ad\'s name, cut to 100 characters)'),
  story: spec('Meta\'s object_story_spec WITHOUT page_id and instagram_user_id (Nexus fills the chosen Page and Instagram account): link_data, photo_data, video_data, text_data — as create-meta-creative story'),
  postId: z.string().trim().regex(/^\d{1,25}_\d{1,25}$/, 'a post id: <Page id>_<post id>').optional().describe('or an existing post of the chosen Page'),
  assetFeed: spec('Meta\'s asset_feed_spec (Dynamic Creative, placement or language versions, …) WITHOUT audios and message_extensions (messageFooter)'),
  parts: spec('the creative\'s other keys as create-meta-creative parts — e.g. media_sourcing_spec for a multi-media ad: images [{hash, source "multi_media", opt_in_status opt_out|opt_in, text_customizations, destination_customizations, placement_customizations, image_crops, creative_audience_pairing_persona}], videos [{video_id, …}], titles / bodies / descriptions (up to 10 media)'),
  withInstagram: z.boolean().optional().describe('run on Instagram too, as the chosen Instagram account (default: when one is chosen)'),
  aiFeatures: z.array(z.enum(META_CREATIVE_FEATURES as [string, ...string[]])).max(80).optional().describe('the Advantage+ creative features to switch ON (every other one is sent OFF); one generated with AI keeps the ad PAUSED'),
  featureSettings: z.record(z.string(), z.record(z.string(), z.unknown())).optional().describe('per feature switched on, its customizations (as create-meta-creative)'),
  multiAdvertiser: z.boolean().optional().describe('allow multi-advertiser ads (default false)'),
  music: z.enum(['off', 'random']).optional().describe('off (default) or random'),
  formatAutomation: z.array(z.object({
    format: z.enum(META_FORMAT_AUTOMATION_FORMATS).describe('the format Meta may turn the creative into'),
    dataSources: z.array(z.enum(META_FORMAT_DATA_SOURCES.filter((s) => s !== 'none') as [string, ...string[]])).min(1).max(4).describe('where Meta takes the extra media from'),
  })).max(6).optional().describe('format automation switched ON (every other format is sent off)'),
  autoProductTags: z.boolean().optional().describe('let Meta tag catalog products on a static image (default false)'),
  carouselAutoOrder: z.boolean().optional().describe('let Meta reorder a carousel\'s cards (default false)'),
  partner: z.object({
    pageId: metaIdArg('the partner\'s (creator\'s) Facebook Page').optional(),
    instagramId: metaIdArg('the partner\'s (creator\'s) Instagram account').optional(),
    mainIdentity: z.enum(['brand', 'creator']).describe('brand: this business runs the ad; creator: the partner runs it, this business is the sponsor'),
  }).optional().describe('a partnership ad'),
})

const flexibleGroupArg = z.object({
  images: z.array(z.object({ hash: z.string().trim().regex(/^[A-Za-z0-9]{1,64}$/, 'an image hash').describe('an image of the ad account\'s library (create-meta-media answers its hash)') })).max(10).optional().describe('the group\'s images'),
  videos: z.array(z.object({ video_id: metaIdArg('a video of the ad account\'s library') })).max(10).optional().describe('the group\'s videos'),
  texts: z.array(z.object({ text: z.string().min(1).max(META_CREATIVE_TEXT.description).describe('the text'), text_type: z.enum(['primary_text', 'headline', 'description']).describe('what the text is') })).max(15).optional().describe('the group\'s texts (at most 5 of a type)'),
  call_to_action: z.object({ type: z.string().trim().regex(/^[A-Z_]{2,40}$/).describe('Meta\'s button, e.g. LEARN_MORE, SHOP_NOW (one type for every group)'), value: z.object({ link: z.string().trim().url().max(1000).describe('the https link') }).describe('where it goes') }).optional().describe('the group\'s button'),
})

const createMetaAd: AgentTool = {
  name: AD_TOOL,
  title: 'Create Meta ad',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // An ad it made that never ran can be deleted again; one that ran stays (archive); a delete cannot be taken back.
  reversibility: 'partial',
  consequencesFor: (args) => (args.action === 'undo' ? { reversibility: 'none' } : { reversibility: 'partial' }),
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: z.object({
    connectionId: metaConnectionArg,
    action: z.enum(['create', 'undo']).optional().describe('create (default): one new ad; undo: delete ads an earlier create-meta-ad made, only while they never ran (undo-change fills it)'),
    name: z.string().trim().min(1).max(META_AD_NAME_MAX).optional().describe(`create: the ad's name (1 to ${META_AD_NAME_MAX} characters)`),
    adSetId: metaIdArg('create: the ad set it goes in (meta-ad-sets lists them; build one first with create-meta-ad-set)').optional(),
    creativeId: metaIdArg('create: an existing creative of the ad account (create-meta-creative or create-meta-boost made it)').optional(),
    creative: creativeArg.optional().describe('create: or a NEW creative made with the ad (create-meta-creative\'s arguments): every silent feature OFF unless asked'),
    messageFooter: z.enum(MESSAGE_FOOTERS).optional().describe('create, new creative of a WEBSITE ad (website button such as LEARN_MORE): a "message us" footer — whatsapp, messenger or instagram_message (Meta takes it only inline on a new ad)'),
    activate: z.boolean().optional().describe('create: true makes the ad ACTIVE (SPENDS MONEY once Meta approves it while its ad set and campaign are on); default false: PAUSED. Never with a feature generated with AI'),
    labels: z.array(z.string().trim().min(1).max(META_CREATIVE_TEXT.label)).max(50).optional().describe('create: labels of the ad (a new name makes the label)'),
    tracking: z.array(z.object({
      pixelId: metaIdArg('a pixel of the chosen ad account (meta-pixels lists them)'),
      action: z.enum(META_AD_TRACKING_ACTIONS).optional().describe('offsite_conversion (default) or leadgen_quality_conversion (down-funnel lead quality)'),
    })).min(1).max(META_AD_TRACKING_MAX).optional().describe('create: pixel tracking added to Meta\'s defaults (the ad set\'s promoted pixel is tracked anyway)'),
    conversionDomain: z.string().trim().max(253).optional().describe('create: where conversions happen — the first and second level of the creative\'s link domain, e.g. example.com (required by Meta when the campaign shares data with a pixel)'),
    scheduleStart: when.optional().describe('create: the ad\'s own start (ISO time with offset); sales and app-promotion campaigns only'),
    scheduleEnd: when.optional().describe('create: the ad\'s own end; sales and app-promotion campaigns only'),
    engagementAudience: z.boolean().optional().describe('create: true also makes a custom audience of the people who engage with the ad (it stays when the ad is taken back)'),
    displaySequence: z.number().int().min(0).max(999_999_999).optional().describe('create: Meta\'s display_sequence ("the sequence of the ad within the same campaign": Meta explains no effect) — only when asked'),
    priority: z.number().int().min(0).max(999_999_999).optional().describe('create: Meta\'s priority (Meta explains no effect) — only when asked'),
    flexibleGroups: z.array(flexibleGroupArg).min(1).max(10).optional().describe('create: the flexible ad format (sales and app-promotion campaigns): groups of images, videos and texts, Meta picks the format per person'),
    persona: z.object({
      ageMin: z.number().int().min(18).max(65).optional().describe('youngest age'),
      ageMax: z.number().int().min(18).max(65).optional().describe('oldest age'),
      genders: z.array(z.union([z.literal(1), z.literal(2)])).min(1).max(2).optional().describe('1 men, 2 women'),
    }).optional().describe('create: an age and gender persona paired with the whole ad (creative audience pairing; the ad set must have it switched on)'),
    recommendations: z.boolean().optional().describe('create: also ask Meta\'s recommendations with its check (read-only words in the preview)'),
    ads: z.array(metaIdArg('an ad an earlier create-meta-ad made')).min(1).max(MAX_AD_UNDO).optional().describe('undo: the ads to delete (undo-change fills it)'),
    why: metaWhyArg,
  }),
  description:
    'Make ONE ad in an ad set of the business\'s chosen Meta ad account. Give the ad set (adSetId — build it first with '
    + 'create-meta-ad-set: Meta documents no shape for an ad set made inside an ad) and ONE creative: an existing creative of '
    + 'the account (creativeId) or a new one made with the ad (creative: create-meta-creative\'s arguments, every Advantage+ '
    + 'feature, multi-advertiser ads, music, format automation, shop routing and product tags OFF unless asked — a multi-media '
    + 'ad through parts.media_sourcing_spec). Options: a "message us" footer on a website ad (messageFooter), the flexible ad '
    + 'format (flexibleGroups), a persona, labels, pixel tracking, a conversion domain, the ad\'s own start / end (sales and '
    + 'app-promotion campaigns), an engagement audience, Meta\'s display_sequence / priority (passed on only when asked: Meta '
    + 'explains no effect). The ad is created PAUSED: it SPENDS NOTHING until a person switches it on (set-meta-status). '
    + 'activate true makes it ACTIVE — SPENDS MONEY once Meta approves it while its ad set and campaign are on (the preview '
    + 'says which are on now); never for a creative with a feature generated with AI (Meta: create PAUSED, preview, then '
    + 'switch on). Read first: the ad set (Meta takes 50 ads per ad set, ONE in a Dynamic Creative ad set; an EU ad set needs '
    + 'its payer and beneficiary — or the account\'s defaults), its campaign (no political or social-issue ads), the creative '
    + 'and the pixels. Meta checks it first (validate_only with its synchronous integrity review). Many ads: one request per '
    + 'ad (Meta\'s background ad requests are a batch Nexus never sends — not all or nothing). Catalog and product-set parts '
    + 'come with the catalog rule. action undo deletes only ads this tool made that never ran (and their inline creative it '
    + 'made new, when no other ad uses it); an ad that ran stays — archive it with set-meta-status.'
    + META_CHANGE_RULES,
  undo: createUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, build(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, build(args), createFinish),
}

// ── set-meta-ad ─────────────────────────────────────────────────────────────────────────────────────────────────────

const setBuild = (args: Record<string, unknown>): MetaDraftBuilder => (account) => setAdDraft(account, {
  adId: String(args.adId ?? ''),
  name: str(args.name),
  creativeId: str(args.creativeId),
  labels: (args.labels as string[] | undefined) ?? null,
  addLabels: (args.addLabels as string[] | undefined) ?? null,
  scheduleStart: str(args.scheduleStart),
  scheduleEnd: str(args.scheduleEnd),
  clearSchedule: (args.clearSchedule as SetAdRequest['clearSchedule']) ?? null,
} satisfies SetAdRequest)

/** Only what Meta made is recorded: the update's keys and the labels added. */
function setFinish(draft: MetaChangeDraft, done: Array<{ request: MetaChangeRequest; result: MetaChangeResult }>): MetaRunOutcome {
  const before = draft.before as Record<string, unknown>
  const after = draft.after as Record<string, unknown>
  const ops = new Set(done.map(({ request }) => request.operation))
  const updated = ops.has('ad.update')
  const made = {
    kind: 'set', adId: after.adId,
    ...(updated && 'name' in after ? { name: after.name } : {}),
    ...(updated && 'creativeId' in after ? { creativeId: after.creativeId } : {}),
    ...(updated && 'scheduleStart' in after ? { scheduleStart: after.scheduleStart } : {}),
    ...(updated && 'scheduleEnd' in after ? { scheduleEnd: after.scheduleEnd } : {}),
    ...((updated || ops.has('ad.addLabels')) && 'labels' in after ? { labels: after.labels } : {}),
  }
  return { data: { ad: made }, before, after: made }
}

/**
 * Undo: the old name, creative (a swap back: Meta reviews it again), labels and own schedule go back. `current` reads the ad
 * LIVE and answers only the keys the change wrote: when a later change moved one of them, the compare-and-swap refuses the
 * undo (it would overwrite that change).
 */
const setUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as Stamped & { adId?: unknown }
    const account = await recordAccount(after)
    if (!account || typeof after.adId !== 'string') return null
    let state: ReturnType<typeof adStateOf>
    try {
      state = adStateOf(after.adId, (await metaReadOne<Record<string, unknown>>({ connectionId: account.target.connectionId }, { operation: 'ad.undoRead', path: after.adId, query: { fields: AD_SET_FIELDS } })).body)
    } catch {
      return null
    }
    return {
      kind: after.kind, adId: after.adId,
      ...('name' in after ? { name: state.name } : {}),
      ...('creativeId' in after ? { creativeId: state.creativeId } : {}),
      ...('scheduleStart' in after ? { scheduleStart: state.scheduleStart } : {}),
      ...('scheduleEnd' in after ? { scheduleEnd: state.scheduleEnd } : {}),
      ...('labels' in after ? { labels: [...state.labels].sort() } : {}),
      accountId: account.accountId, adAccountId: account.adAccountId,
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as { name?: unknown; creativeId?: unknown; labels?: unknown; scheduleStart?: unknown; scheduleEnd?: unknown }
    const after = (change.after ?? {}) as Stamped & { adId?: unknown }
    const args: Record<string, unknown> = {}
    const clear: string[] = []
    if ('name' in after && typeof before.name === 'string') args.name = before.name
    if ('creativeId' in after && typeof before.creativeId === 'string') args.creativeId = before.creativeId
    if ('labels' in after && Array.isArray(before.labels)) args.labels = before.labels
    for (const [key, word] of [['scheduleStart', 'start'], ['scheduleEnd', 'end']] as const) {
      if (!(key in after)) continue
      if (typeof before[key] === 'string') args[key] = before[key]
      else clear.push(word)
    }
    if (clear.length) args.clearSchedule = clear
    if (!Object.keys(args).length) return { refusal: 'Nothing to put back: this change recorded nothing Nexus can write back.' }
    return { tool: SET_AD_TOOL, args: { ...(after.accountId ? { connectionId: after.accountId } : {}), adId: String(after.adId ?? ''), ...args, why: 'undo of an earlier set-meta-ad: what it changed goes back' } }
  },
}

const labelArg = z.string().trim().min(1).max(META_CREATIVE_TEXT.label).describe('a label name')

const setMetaAd: AgentTool = {
  name: SET_AD_TOOL,
  title: 'Change Meta ad',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // The old name, creative, labels and schedule go back (a creative swap back is reviewed again).
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: z.object({
    connectionId: metaConnectionArg,
    adId: metaIdArg('the ad (meta-ad-details lists them)'),
    name: z.string().trim().min(1).max(META_AD_NAME_MAX).optional().describe(`its new name (1 to ${META_AD_NAME_MAX} characters; the only change Meta allows on an archived ad)`),
    creativeId: metaIdArg('another creative of the ad account to show (a new look: make it with create-meta-creative first) — the ad goes back to Meta\'s review').optional(),
    labels: z.array(labelArg).max(50).optional().describe('the whole label list from now ([] removes them all)'),
    addLabels: z.array(labelArg).min(1).max(50).optional().describe('labels to add'),
    scheduleStart: when.optional().describe('the ad\'s own start (ISO time with offset); sales and app-promotion campaigns only'),
    scheduleEnd: when.optional().describe('the ad\'s own end; sales and app-promotion campaigns only'),
    clearSchedule: z.array(z.enum(['start', 'end'])).min(1).max(2).optional().describe('clear the ad\'s own start and/or end: it then follows its campaign\'s schedule'),
    why: metaWhyArg,
  }),
  description:
    'Change an ad of the business\'s chosen Meta ad account: its name, the creative it shows (a swap to another creative of '
    + 'the account — a new look is a new creative made with create-meta-creative first; the swap sends the ad back to Meta\'s '
    + 'review, and a creative with a feature generated with AI goes only onto a PAUSED ad), its labels (the whole list, or '
    + 'labels added) and its own start / end time (sales and app-promotion campaigns; cleared, it follows the campaign). Its '
    + 'ad set never changes (Meta: copy it instead). Status is set-meta-status. Meta has no check for an ad\'s update (no '
    + 'validate_only): the preview is built from the ad as it is now. A schedule change on an ACTIVE ad SPENDS MONEY (it may '
    + 'run at other times). Its undo puts back what it changed, after reading the ad live.'
    + META_CHANGE_RULES,
  undo: setUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, setBuild(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, setBuild(args), setFinish),
}

export const META_ADS_ADS_TOOLS: AgentTool[] = [createMetaAd, setMetaAd]
