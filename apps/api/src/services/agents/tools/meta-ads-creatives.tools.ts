/**
 * Meta ads step 25 (2026-10-21) — create-meta-creative and set-meta-creative: make a creative of the business's chosen Meta
 * ad account (every format Meta's creative edge takes: image, photo, text, video, carousel, collection, Dynamic Creative,
 * placement and language customization, messaging, profile-visit, call, lead, reminder, Threads through Instagram,
 * partnership, Advantage+ catalog parts) with every silent feature sent OFF unless asked, take back a creative it made new,
 * and rename / relabel a creative (master rows of step 25; marketing/meta-ads/change-creatives.ts and
 * gateway/meta-creative-rules.ts hold each rule and the Meta pages it was checked on). Nexus changes like every other Meta
 * change (meta-ads-kit.ts): a preview from what Meta holds now — Meta checks a new creative first (validate_only) — an
 * approvalId, a person approves it, it runs as that person, and its undo takes back only what it made new.
 *
 * Nothing here spends money: a creative serves only once an ad uses it (create-meta-ad, step 27).
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import { metaChangePreview, metaConnectionArg, metaIdArg, metaWhyArg, META_CHANGE_RULES, recordAccount, runMetaChange, type MetaDraftBuilder, type MetaRunOutcome } from './meta-ads-kit.js'
import {
  CREATIVE_TOOL, creativeDraft, MAX_CREATIVE_UNDO, SET_CREATIVE_TOOL, setCreativeDraft, WELCOME_FLOWS_ANSWER,
  type CreativeDraft, type CreativeRecordItem, type CreativeRequest, type SetCreativeRequest,
} from '../../marketing/meta-ads/change-creatives.js'
import type { MetaChangeDraft, MetaChangeRequest } from '../../marketing/meta-ads/change-draft.js'
import type { MetaChangeResult } from '../../marketing/meta-ads/write-client.js'
import { META_CREATIVE_FEATURES, META_CREATIVE_TEXT, META_FORMAT_AUTOMATION_FORMATS, META_FORMAT_DATA_SOURCES } from '../../gateway/meta-creative-rules.js'
import { metaReadOne } from '../../marketing/meta-ads/read-client.js'

const spec = (what: string) => z.record(z.string(), z.unknown()).optional().describe(what)
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** The request as the drafts read it (zod has checked the args). */
function requestOf(args: Record<string, unknown>): CreativeRequest {
  const partner = args.partner as Record<string, unknown> | undefined
  return {
    action: args.action === 'undo' ? 'undo' : args.action === 'welcome-flow' ? 'welcome-flow' : 'create',
    name: str(args.name),
    story: (args.story as Record<string, unknown> | undefined) ?? null,
    postId: str(args.postId),
    assetFeed: (args.assetFeed as Record<string, unknown> | undefined) ?? null,
    parts: (args.parts as Record<string, unknown> | undefined) ?? null,
    withInstagram: typeof args.withInstagram === 'boolean' ? args.withInstagram : null,
    aiFeatures: (args.aiFeatures as string[] | undefined) ?? [],
    featureSettings: (args.featureSettings as Record<string, Record<string, unknown>> | undefined) ?? {},
    multiAdvertiser: args.multiAdvertiser === true,
    music: args.music === 'random' ? 'random' : 'off',
    formatAutomation: (args.formatAutomation as CreativeRequest['formatAutomation']) ?? [],
    shopDestination: args.shopDestination === true,
    autoProductTags: args.autoProductTags === true,
    productTags: (args.productTags as CreativeRequest['productTags']) ?? null,
    carouselAutoOrder: args.carouselAutoOrder === true,
    partner: partner ? { pageId: str(partner.pageId), instagramId: str(partner.instagramId), mainIdentity: partner.mainIdentity === 'creator' ? 'creator' : 'brand' } : null,
    async: args.async === true,
    creatives: (args.creatives as string[] | undefined) ?? [],
  }
}

const build = (args: Record<string, unknown>): MetaDraftBuilder => (account) => creativeDraft(account, requestOf(args))

function createFinish(draft: MetaChangeDraft, done: Array<{ request: MetaChangeRequest; result: MetaChangeResult }>): MetaRunOutcome {
  const d = draft as CreativeDraft
  if (d.creative.action === 'undo') {
    const items = done.map(({ request }) => ({ kind: 'creative' as const, creativeId: request.objectId, deleted: true as const }))
    return { data: { deleted: items, note: 'Meta cannot bring a deleted creative back: make it again with create-meta-creative.' }, before: { kind: 'undo', items: items.map((i) => ({ kind: 'creative', creativeId: i.creativeId, present: true })) }, after: { kind: 'undo', items } }
  }
  const items: CreativeRecordItem[] = done.map(({ result }) => {
    const node = (result.node ?? {}) as { creativeId?: unknown; new?: unknown; jobId?: unknown; featuresOn?: unknown }
    return {
      kind: 'creative',
      creativeId: typeof node.creativeId === 'string' ? node.creativeId : null,
      name: d.creative.name ?? '',
      new: node.new === true ? true : node.new === false ? false : null,
      ...(typeof node.jobId === 'string' ? { jobId: node.jobId } : {}),
      featuresOn: Array.isArray(node.featuresOn) ? node.featuresOn.map(String) : [],
    }
  })
  return {
    data: {
      made: items,
      details: done.map(({ request, result }) => ({ step: request.step, ...(result.node ?? {}) })),
      note: 'A creative spends nothing until an ad uses it (create-meta-ad). new: false or null means Meta answered an existing creative or Nexus could not prove it new — its undo never deletes it.',
    },
    before: { kind: 'create', items: [] },
    after: { kind: 'create', items },
  }
}

// ── undo ────────────────────────────────────────────────────────────────────────────────────────────────────────────

type Stamped = { kind?: string; items?: Array<Record<string, unknown>>; accountId?: string; adAccountId?: string }

/** Undo of a create: the creatives it made NEW are deleted (while no ad uses them), through this same tool. */
const createUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as Stamped
    if (after.kind !== 'create') return after
    const account = await recordAccount(after)
    return account ? { ...after, accountId: account.accountId, adAccountId: account.adAccountId } : null
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as Stamped
    if (after.kind === 'undo') return { refusal: 'Meta cannot bring a deleted creative back: make it again with create-meta-creative.' }
    const ids = (after.items ?? []).filter((i) => i.new === true && typeof i.creativeId === 'string').map((i) => String(i.creativeId))
    if (!ids.length) return { refusal: 'This create made nothing new Nexus may delete: Meta answered an existing creative (a duplicate), or Nexus could not prove the creative new, and Nexus never deletes a creative it did not make.' }
    return {
      tool: CREATIVE_TOOL,
      args: { ...(after.accountId ? { connectionId: after.accountId } : {}), action: 'undo', creatives: ids, why: 'undo of an earlier create-meta-creative: only a creative it made new is deleted, and only while no ad uses it' },
    }
  },
}

const createMetaCreative: AgentTool = {
  name: CREATIVE_TOOL,
  title: 'Create Meta creative',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // A creative it made new can be deleted again (while no ad uses it); a delete cannot be taken back.
  reversibility: 'partial',
  consequencesFor: (args) => (args.action === 'undo' || args.action === 'welcome-flow' ? { reversibility: 'none' } : { reversibility: 'partial' }),
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: z.object({
    connectionId: metaConnectionArg,
    action: z.enum(['create', 'undo', 'welcome-flow']).optional().describe('create (default): one new creative; undo: delete creatives an earlier create-meta-creative made new (undo-change fills it); welcome-flow: Nexus answers where a Page welcome-message flow is made (set-meta-messaging-setup)'),
    name: z.string().trim().min(1).max(META_CREATIVE_TEXT.name).optional().describe('create: the creative\'s name in the ad account (1 to 100 characters)'),
    story: spec('create: Meta\'s object_story_spec WITHOUT page_id and instagram_user_id (Nexus fills the business\'s chosen Page and Instagram account): link_data (image or link ad, carousel child_attachments 2–10, collection collection_thumbnails, messaging page_welcome_message), photo_data, video_data (video_id of the account\'s library), text_data or template_data (Advantage+ catalog); images by image_hash from create-meta-media or picture / url / image_url (a public https link Meta fetches)'),
    postId: z.string().trim().regex(/^\d{1,25}_\d{1,25}$/, 'a post id: <Page id>_<post id>').optional().describe('create: or an existing post of the chosen Page (object_story_id, meta-page-posts lists them)'),
    assetFeed: spec('create: Meta\'s asset_feed_spec (Dynamic Creative, placement or language customization, multi-destination messaging, profile visits, call ads, reminders, promo codes) WITHOUT audios (music is its own argument)'),
    parts: spec('create: the creative\'s other keys, as Meta names them: url_tags, adlabels, call_to_action (with postId), ad_disclaimer_spec, portrait_customizations, platform_customizations, branded_content (testimonial), creative_sourcing_spec (site links; associated_product_set_id for product extensions), media_sourcing_spec, marketing_message_structured_spec, product_set_id (an Advantage+ catalog creative, with story.template_data), product_data (catalog items under the ad: [{product_id, product_source MANUAL, product_decision ACCEPT}]), recommender_settings, template_url_spec, categorization_criteria, category_media_source, object_type. Every product set and catalog item must be of a catalog of the chosen ad account\'s business portfolio (or a client catalog whose owner is no other business in Nexus)'),
    withInstagram: z.boolean().optional().describe('create: run on Instagram too, as the chosen Instagram account (default: true when one is chosen)'),
    aiFeatures: z.array(z.enum(META_CREATIVE_FEATURES as [string, ...string[]])).max(80).optional().describe('create: the Advantage+ creative features to switch ON (every other one Meta documents is sent OFF)'),
    featureSettings: z.record(z.string(), z.record(z.string(), z.unknown())).optional().describe('create: per feature switched on, its customizations as Meta documents them (adapt_to_placement: aspect_ratio_config {ar_4_5|ar_9_16: {adapt: {enroll_status}}}, image_crop_style, showcase_card_display; text_optimizations / enhance_cta: text_extraction {enroll_status}), e.g. {"adapt_to_placement":{"aspect_ratio_config":{"ar_9_16":{"adapt":{"enroll_status":"OPT_OUT"}}}}}'),
    multiAdvertiser: z.boolean().optional().describe('create: allow multi-advertiser ads (default false: contextual_multi_ads OPT_OUT)'),
    music: z.enum(['off', 'random']).optional().describe('create: off (default) or random (Meta adds a track of its choice)'),
    formatAutomation: z.array(z.object({
      format: z.enum(META_FORMAT_AUTOMATION_FORMATS).describe('the format Meta may turn the creative into'),
      dataSources: z.array(z.enum(META_FORMAT_DATA_SOURCES.filter((s) => s !== 'none') as [string, ...string[]])).min(1).max(4).describe('where Meta takes the extra media from'),
    })).max(6).optional().describe('create: format automation switched ON (every other format is sent with data_source none)'),
    shopDestination: z.boolean().optional().describe('create: shop routing (WEBSITE_AND_SHOP) — answered in words: every Meta ad sends people to the business\'s own shop, on the product\'s page, never to a Facebook or Instagram shop Meta picks (the Owner\'s rule); a website creative is sent WEBSITE_AND_SHOP_OPT_OUT'),
    autoProductTags: z.boolean().optional().describe('create: let Meta tag catalog products on a static image by itself (default false: sent opt_out)'),
    productTags: z.array(z.object({
      productId: z.string().trim().regex(/^\d{1,20}$/, 'a catalog item id (digits)').describe('the catalog item (meta-catalog-items lists them)'),
      x: z.number().min(0).max(1).describe('its place across the media, 0 (left) to 1 (right)'),
      y: z.number().min(0).max(1).describe('its place down the media, 0 (top) to 1 (bottom)'),
    })).min(1).max(10).optional().describe('create: catalog items tagged by hand on the media (Instagram product tags; Meta\'s automatic tagging is then off — not with autoProductTags)'),
    carouselAutoOrder: z.boolean().optional().describe('create: let Meta reorder a carousel\'s cards (multi_share_optimized; default false: the cards stay in your order)'),
    partner: z.object({
      pageId: metaIdArg('the partner\'s (creator\'s) Facebook Page').optional(),
      instagramId: metaIdArg('the partner\'s (creator\'s) Instagram account').optional(),
      mainIdentity: z.enum(['brand', 'creator']).describe('brand: this business runs the ad, the partner is named; creator: the partner runs it, this business is the sponsor'),
    }).optional().describe('create: a partnership ad (Meta asks the partner\'s permission itself)'),
    async: z.boolean().optional().describe('create: make it as Meta\'s asynchronous job (asyncadcreatives; Meta has no check for that edge)'),
    creatives: z.array(metaIdArg('a creative an earlier create-meta-creative made new')).min(1).max(MAX_CREATIVE_UNDO).optional().describe('undo: the creatives to delete (undo-change fills it)'),
    why: metaWhyArg,
  }),
  description:
    'Make ONE creative in the business\'s chosen Meta ad account — what an ad shows (create-meta-ad uses it). It runs as the '
    + 'chosen Facebook Page and Instagram account (Nexus fills them; withInstagram false: Facebook only). Give story '
    + '(Meta\'s object_story_spec without page_id: link_data for an image or link ad, a carousel of 2–10 cards or a '
    + 'collection; photo_data; text_data; video_data with a video of the account\'s library; template_data for Advantage+ '
    + 'catalog), or postId (a post of the chosen Page); assetFeed for Dynamic Creative, placement or language versions, '
    + 'multi-destination messaging, profile visits, call ads, reminders or promo codes; parts for the other keys. Images '
    + 'by their hash (create-meta-media) or a public https link Meta fetches. Every Advantage+ creative feature Meta '
    + 'documents is sent OFF unless named in aiFeatures; multi-advertiser ads, music, format automation and shop routing '
    + 'are OFF unless asked — the preview names each one switched on, and the run reads the creative back and says what '
    + 'Meta kept (Meta drops an ineligible opt-in silently). Each silent key goes only where Meta documents it for the kind '
    + 'of creative (website, catalog, messaging, lead, call, event, Instant Experience, existing post…). Automatic product tags '
    + 'on a static image and the reordering of carousel cards are OFF unless asked (autoProductTags, carouselAutoOrder); '
    + 'productTags tags catalog items by hand instead. A product set (product_set_id, product extensions) or catalog item '
    + '(productTags, product_data) must be of a catalog of the chosen ad account\'s business portfolio, or a client catalog '
    + 'whose owner is no other business in Nexus — checked before the preview and again before it is sent. A '
    + 'feature generated with AI means the ad using it must start '
    + 'PAUSED and be previewed (meta-ad-preview) first. A partnership ad names its partner (partner); Meta asks the '
    + 'partner\'s permission itself. Refused in words: political ads (banned in the EU), WhatsApp Status identities (not in '
    + 'the EU), app links (Nexus has no app), retailer_item_ids (advertiser product ids the catalog rule cannot check), catalog promo-code sources, polls (gone in '
    + 'v26), Threads ids (Threads runs through Instagram), shop routing (every ad sends people to the business\'s own shop), saved Page welcome flows '
    + '(set-meta-messaging-setup makes them). A creative SPENDS NOTHING (it serves only once an ad uses it) and '
    + 'cannot be changed once made: a new look is a new creative swapped onto the ad, which sends an ACTIVE ad back to '
    + 'review. Meta checks it first (validate_only). If Meta already holds the same creative it answers that one: then '
    + 'nothing new is made and the undo never deletes it. action undo deletes only creatives this tool made new, while no '
    + 'ad uses them (undo-change asks for it).'
    + META_CHANGE_RULES,
  undo: createUndo,
  handler: (args, ctx) => (args.action === 'welcome-flow' ? Promise.resolve({ ok: false, error: WELCOME_FLOWS_ANSWER }) : metaChangePreview(args, ctx, build(args))),
  execute: (args, ctx) => (args.action === 'welcome-flow' ? Promise.resolve({ ok: false, error: `Not run: ${WELCOME_FLOWS_ANSWER}` }) : runMetaChange(args, ctx, build(args), createFinish)),
}

// ── set-meta-creative ───────────────────────────────────────────────────────────────────────────────────────────────

const setBuild = (args: Record<string, unknown>): MetaDraftBuilder => (account) => setCreativeDraft(account, {
  creativeId: String(args.creativeId ?? ''),
  name: str(args.name),
  status: args.status === 'ACTIVE' ? 'ACTIVE' : null,
  labels: (args.labels as string[] | undefined) ?? null,
  addLabels: (args.addLabels as string[] | undefined) ?? null,
} satisfies SetCreativeRequest)

function setFinish(draft: MetaChangeDraft, done: Array<{ request: MetaChangeRequest; result: MetaChangeResult }>): MetaRunOutcome {
  const before = draft.before as Record<string, unknown>
  const after = draft.after as Record<string, unknown>
  const ops = new Set(done.map(({ request }) => request.operation))
  // Only what Meta made is recorded: the update (name, status, the whole label list) and the labels added.
  const made = {
    kind: 'set', creativeId: after.creativeId,
    ...(ops.has('creative.update') && 'name' in after ? { name: after.name } : {}),
    ...(ops.has('creative.update') && 'status' in after ? { status: after.status } : {}),
    // Review A3 — labels kept sorted, as the undo's live read reads them (the compare-and-swap compares the two).
    ...((ops.has('creative.update') || ops.has('creative.addLabels')) && Array.isArray(after.labels) ? { labels: [...(after.labels as string[])].sort() } : {}),
  }
  return { data: { creative: made }, before, after: made }
}

/**
 * Undo: the old name and the old label list go back; a review state Meta set cannot be written back. Review A3 — `current`
 * reads the creative LIVE (its name, status and labels) and answers only the keys the change wrote: when a later change
 * moved one of them, the compare-and-swap refuses the undo (it would overwrite that change).
 */
const setUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as Stamped & { creativeId?: unknown; name?: unknown; status?: unknown; labels?: unknown }
    const account = await recordAccount(after)
    if (!account || typeof after.creativeId !== 'string') return null
    let live: { name?: unknown; status?: unknown; adlabels?: { data?: Array<{ name?: unknown }> } | Array<{ name?: unknown }> }
    try {
      live = (await metaReadOne<typeof live>({ connectionId: account.target.connectionId }, { operation: 'creative.undoRead', path: after.creativeId, query: { fields: 'id,name,status,adlabels{name}' } })).body
    } catch {
      return null
    }
    const rows = Array.isArray(live.adlabels) ? live.adlabels : live.adlabels?.data ?? []
    const labels = rows.map((l) => (typeof l?.name === 'string' ? l.name : '')).filter(Boolean).sort()
    return {
      kind: after.kind, creativeId: after.creativeId,
      ...('name' in after ? { name: typeof live.name === 'string' ? live.name : null } : {}),
      ...('status' in after ? { status: typeof live.status === 'string' ? live.status : null } : {}),
      ...('labels' in after ? { labels } : {}),
      accountId: account.accountId, adAccountId: account.adAccountId,
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as { name?: unknown; labels?: unknown; status?: unknown }
    const after = (change.after ?? {}) as Stamped & { creativeId?: unknown; name?: unknown; labels?: unknown; status?: unknown }
    const args: Record<string, unknown> = {}
    if ('name' in after && typeof before.name === 'string') args.name = before.name
    if ('labels' in after && Array.isArray(before.labels)) args.labels = before.labels
    if (!Object.keys(args).length) {
      return { refusal: 'Nothing to put back: this change set the creative\'s status, and Meta sets its review states (IN_PROCESS, WITH_ISSUES) itself — Nexus cannot write one back.' }
    }
    return {
      tool: SET_CREATIVE_TOOL,
      args: { ...(after.accountId ? { connectionId: after.accountId } : {}), creativeId: String(after.creativeId ?? ''), ...args, why: 'undo of an earlier set-meta-creative: the old name and labels go back' },
    }
  },
}

const labelArg = z.string().trim().min(1).max(META_CREATIVE_TEXT.label).describe('a label name')

const setMetaCreative: AgentTool = {
  name: SET_CREATIVE_TOOL,
  title: 'Change Meta creative',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // The old name and labels go back; a review state Meta set cannot be written back.
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: z.object({
    connectionId: metaConnectionArg,
    creativeId: metaIdArg('the creative (meta-ad-details view creatives lists them)'),
    name: z.string().trim().min(1).max(META_CREATIVE_TEXT.name).optional().describe('its new name (1 to 100 characters)'),
    status: z.enum(['ACTIVE']).optional().describe('ACTIVE (the only status Nexus writes; deleting is its own explicit step, and Meta sets its review states itself)'),
    labels: z.array(labelArg).max(50).optional().describe('the whole label list from now (replaces the labels it has; [] removes them all)'),
    addLabels: z.array(labelArg).min(1).max(50).optional().describe('labels to add (a new name makes the label in the ad account)'),
    why: metaWhyArg,
  }),
  description:
    'Rename a creative of the business\'s chosen Meta ad account, set its labels (the whole list, or labels added) or set '
    + 'it ACTIVE — all Meta lets change on a creative: everything else is fixed once made (a new look is a new creative, '
    + 'create-meta-creative, swapped onto the ad). Meta has no check for these changes (no validate_only on POST '
    + '/<creative id> or its adlabels edge): the preview is built from the creative as it is now. Nothing spends and no ad '
    + 'goes back to review. Its undo puts the old name and labels back; deleting a creative is its own explicit step.'
    + META_CHANGE_RULES,
  undo: setUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, setBuild(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, setBuild(args), setFinish),
}

export const META_ADS_CREATIVES_TOOLS: AgentTool[] = [createMetaCreative, setMetaCreative]
