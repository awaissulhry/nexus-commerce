/**
 * Meta ads step 26 (2026-10-21) — create-meta-boost and set-meta-partnership-access: run an EXISTING post as an ad creative
 * (a post of the chosen Page, a feed post / Reel / carousel / active story of the chosen Instagram account or its link, a
 * creator's content or ad code — partnership ads; also on Threads through the Instagram account; profile-visit and messaging
 * buttons), copy a creator's video into the library with the creator's ad code, and manage the chosen Instagram account's
 * partnership side (permission requests, the approved-tagging list, ad codes of its own media, Collab invites). Master rows of
 * step 26 (marketing/meta-ads/change-boosts.ts and gateway/meta-boost-rules.ts hold each rule and the Meta pages it was
 * checked on). Nexus changes like every other Meta change (meta-ads-kit.ts): a preview from what Meta holds now — Meta checks a
 * boost first (validate_only on the creative edge) — an approvalId, a person approves it, it runs as that person.
 *
 * Nothing here spends money: a boost is a creative, and a creative serves only once an ad uses it (create-meta-ad, step 27).
 * The Facebook side of partnership access goes to Meta's partnership host with the system-user token (review B1); making an ad
 * code is answered in words (review A2: nobody could read it). Both tools are on both doors (review round 2: the Undo button
 * and the in-app assistant run create-meta-boost's undo); a creator's ad code is kept encrypted with its request (AD_CODE_KEPT).
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import { metaChangePreview, metaConnectionArg, metaIdArg, metaWhyArg, META_CHANGE_RULES, recordAccount, runMetaChange, type MetaDraftBuilder, type MetaRunOutcome } from './meta-ads-kit.js'
import {
  AD_CODE_KEPT, AD_FORMAT_OF, BOOST_LINK_CTAS, BOOST_SOURCES, BOOST_TOOL, boostDraft, CREATE_AD_CODE_ANSWER, MAX_CREATORS, MESSAGING_APPS,
  PARTNERSHIP_ACTIONS, PARTNERSHIP_TOOL, partnershipDraft, VISIT_DESTINATIONS,
  type BoostDraft, type BoostRequest, type PartnershipDraft, type PartnershipRequest,
} from '../../marketing/meta-ads/change-boosts.js'
import { MAX_CREATIVE_UNDO } from '../../marketing/meta-ads/change-creatives.js'
import type { MetaChangeDraft, MetaChangeRequest } from '../../marketing/meta-ads/change-draft.js'
import type { MetaChangeResult } from '../../marketing/meta-ads/write-client.js'
import { META_AD_CODE, META_CREATIVE_FEATURES, META_CREATIVE_TEXT } from '../../gateway/meta-creative-rules.js'
import { META_FB_LIST_MAX, META_FB_PARTNERS_MAX, META_TAG_APPROVAL_MAX } from '../../gateway/meta-boost-rules.js'
import { metaChosenAccount } from '../../marketing/meta-ads/live.js'

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const MEDIA_TOOL = 'create-meta-media'

// ── create-meta-boost ───────────────────────────────────────────────────────────────────────────────────────────────

function boostRequestOf(args: Record<string, unknown>): BoostRequest {
  const button = args.button as Record<string, unknown> | undefined
  return {
    action: args.action === 'undo' ? 'undo' : args.action === 'copy-creator-video' ? 'copy-creator-video' : 'create',
    name: str(args.name),
    source: (args.source as BoostRequest['source']) ?? null,
    postId: str(args.postId),
    mediaId: str(args.mediaId),
    permalink: str(args.permalink),
    adCode: str(args.adCode),
    withInstagram: typeof args.withInstagram === 'boolean' ? args.withInstagram : null,
    threads: args.threads === true,
    button: button ? { kind: button.kind as 'link' | 'messaging' | 'profile', type: str(button.type), link: str(button.link), apps: (button.apps as string[] | undefined) ?? null, visit: str(button.visit) } : null,
    identities: (args.identities as BoostRequest['identities']) ?? null,
    urlTags: str(args.urlTags),
    aiFeatures: (args.aiFeatures as string[] | undefined) ?? [],
    featureSettings: (args.featureSettings as Record<string, Record<string, unknown>> | undefined) ?? {},
    multiAdvertiser: args.multiAdvertiser === true,
    music: args.music === 'random' ? 'random' : 'off',
    creatives: (args.creatives as string[] | undefined) ?? [],
  }
}

const boostBuild = (args: Record<string, unknown>): MetaDraftBuilder => (account) => boostDraft(account, boostRequestOf(args))

/** What the change record keeps: only facts that do not move — the content a creator's code unlocked, not the code (review A3). */
function boostFinish(draft: MetaChangeDraft, done: Array<{ request: MetaChangeRequest; result: MetaChangeResult }>): MetaRunOutcome {
  const d = draft as BoostDraft & { creative: { action: string } }
  if (d.creative.action === 'undo') {
    const items = done.map(({ request }) => ({ kind: 'creative' as const, creativeId: request.objectId, deleted: true as const }))
    return { data: { deleted: items, note: 'Meta cannot bring a deleted creative back: boost the post again with create-meta-boost.' }, before: { kind: 'undo', items: items.map((i) => ({ kind: 'creative', creativeId: i.creativeId, present: true })) }, after: { kind: 'undo', items } }
  }
  // Review A3 — the change record names the content a creator's code unlocked (contentId), not the code.
  const contentId = d.boost?.contentId ?? null
  if (d.boost?.source === 'video') {
    const items = done.map(({ result }) => {
      const node = (result.node ?? {}) as { videoId?: unknown; new?: unknown }
      return { kind: 'video', source: (draft.after as { items?: Array<{ source?: string }> }).items?.[0]?.source ?? 'creator-instagram', method: 'advideos', videoId: typeof node.videoId === 'string' ? node.videoId : null, new: node.new === true ? true : node.new === false ? false : null }
    })
    return {
      data: { copied: items, note: 'The video is in the ad account\'s library for a boost of the creator\'s content (source creator-instagram-code). An upload spends nothing.' },
      before: { kind: 'video', items: [] },
      after: { kind: 'video', items },
    }
  }
  const items = done.map(({ result }) => {
    const node = (result.node ?? {}) as { creativeId?: unknown; new?: unknown; featuresOn?: unknown }
    return {
      kind: 'creative',
      creativeId: typeof node.creativeId === 'string' ? node.creativeId : null,
      name: d.boost?.name ?? '',
      new: node.new === true ? true : node.new === false ? false : null,
      source: d.boost?.source ?? null,
      featuresOn: Array.isArray(node.featuresOn) ? node.featuresOn.map(String) : [],
      ...(contentId ? { contentId } : {}),
    }
  })
  return {
    data: {
      made: items,
      details: done.map(({ request, result }) => ({ step: request.step, ...(result.node ?? {}) })),
      note: 'A boost spends nothing until an ad uses it (create-meta-ad). new: false or null means Meta answered an existing creative of the same post (or Nexus could not prove it new) — its undo never deletes it.',
    },
    before: { kind: 'create', items: [] },
    after: { kind: 'create', items },
  }
}

type Stamped = { kind?: string; items?: Array<Record<string, unknown>>; accountId?: string; adAccountId?: string }

/**
 * Undo: step 25's creative undo for the creatives THIS tool made new (while no ad uses them); a creator's video copied new
 * is taken back by create-meta-media's own undo (while no creative uses it).
 */
const boostUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as Stamped
    if (after.kind !== 'create' && after.kind !== 'video') return after
    const account = await recordAccount(after)
    return account ? { ...after, accountId: account.accountId, adAccountId: account.adAccountId } : null
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as Stamped
    if (after.kind === 'undo') return { refusal: 'Meta cannot bring a deleted creative back: boost the post again with create-meta-boost.' }
    const connection = after.accountId ? { connectionId: after.accountId } : {}
    if (after.kind === 'video') {
      const videos = (after.items ?? []).filter((i) => i.new === true && typeof i.videoId === 'string').map((i) => String(i.videoId))
      if (!videos.length) return { refusal: 'This copy made no video Nexus can prove new, and Nexus never removes a video it did not make.' }
      return { tool: MEDIA_TOOL, args: { ...connection, kind: 'undo', uploads: videos.map((videoId) => ({ kind: 'video', videoId })), why: 'undo of an earlier create-meta-boost copy-creator-video: only a video it copied new is removed, and only while no creative uses it' } }
    }
    const ids = (after.items ?? []).filter((i) => i.new === true && typeof i.creativeId === 'string').map((i) => String(i.creativeId))
    if (!ids.length) return { refusal: 'This boost made nothing new Nexus may delete: Meta answered an existing creative of the same post, or Nexus could not prove it new, and Nexus never deletes a creative it did not make.' }
    return { tool: BOOST_TOOL, args: { ...connection, action: 'undo', creatives: ids, why: 'undo of an earlier create-meta-boost: only a creative it made new is deleted, and only while no ad uses it' } }
  },
}

const createMetaBoost: AgentTool = {
  name: BOOST_TOOL,
  title: 'Boost a post on Meta',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // A boost it made new can be deleted again (while no ad uses it); a delete cannot be taken back.
  reversibility: 'partial',
  consequencesFor: (args) => (args.action === 'undo' ? { reversibility: 'none' } : { reversibility: 'partial' }),
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  // The creator's ad code is a secret argument: item 7 keeps it encrypted with the request and masked in every run record
  // and view (agents/secret-args.ts; AD_CODE_KEPT, said in the description and every preview that carries one).
  // Review round 2 — on both doors again: the Undo button and the in-app assistant run this tool.
  secretArgs: ['adCode'],
  input: z.object({
    connectionId: metaConnectionArg,
    action: z.enum(['create', 'undo', 'copy-creator-video']).optional().describe('create (default): one creative of an existing post; copy-creator-video: copy a creator\'s Instagram video into the ad account\'s video library with the creator\'s ad code (Meta\'s fix for "Instagram Video Must Be Uploaded To Facebook"); undo: delete creatives an earlier create-meta-boost made new (undo-change fills it)'),
    name: z.string().trim().min(1).max(META_CREATIVE_TEXT.name).optional().describe('create: the creative\'s name in the ad account (1 to 100 characters)'),
    source: z.enum(BOOST_SOURCES).optional().describe('create: facebook-post (a post of the chosen Page: postId), instagram-media (a feed post, Reel, carousel or active story of the chosen Instagram account: mediaId), instagram-link (the chosen Instagram account\'s post by its public link: permalink), creator-instagram-media / creator-facebook-post (a creator\'s content Meta lists for the business: mediaId / postId), creator-instagram-code / creator-facebook-code (a creator\'s content by the ad code they shared: adCode)'),
    postId: z.string().trim().regex(/^[1-9]\d{0,24}_[1-9]\d{0,24}$/, 'a post id: <Page id>_<post id>').optional().describe('facebook-post: a post of the chosen Page; creator-facebook-post: the creator\'s post (<Page id>_<post id>; meta-page-posts / meta-partnership-content list them)'),
    mediaId: z.string().trim().regex(/^[1-9]\d{0,24}$/, 'an Instagram media id: digits').optional().describe('instagram-media: the chosen Instagram account\'s media (meta-instagram-media lists it); creator-instagram-media and copy-creator-video: the creator\'s media'),
    permalink: z.string().trim().url().max(300).optional().describe('instagram-link: the post\'s public link (https://www.instagram.com/p/<code>/) — only the chosen Instagram account\'s own media'),
    adCode: z.string().trim().regex(META_AD_CODE, 'a partnership ad code: letters, digits and _ = + / -').optional().describe('creator-instagram-code, creator-facebook-code, copy-creator-video: the partnership ad code the creator shared — Nexus keeps it encrypted with this request, opened only to check and send it'),
    withInstagram: z.boolean().optional().describe('facebook-post: run on Instagram too, as the chosen Instagram account (default: true when one is chosen and Meta says the post can)'),
    threads: z.boolean().optional().describe('create: meant for Threads too — Nexus checks Threads\' rules (image, video or image carousel; no story; no partnership); Threads delivery is the ad set\'s Threads placement with the chosen Instagram account'),
    button: z.object({
      kind: z.enum(['link', 'messaging', 'profile']).describe('link: a website button; messaging: open Messenger and/or Instagram Direct; profile: a profile visit'),
      type: z.enum(BOOST_LINK_CTAS).optional().describe('link: the button (default LEARN_MORE)'),
      link: z.string().trim().url().max(1000).optional().describe('link: the public https link the button opens'),
      apps: z.array(z.enum(MESSAGING_APPS)).min(1).max(2).optional().describe('messaging: MESSENGER and/or INSTAGRAM_DIRECT (both: Meta picks per person); default MESSENGER'),
      visit: z.enum(VISIT_DESTINATIONS).optional().describe('profile: which profile it visits — facebook (the chosen Page; a Facebook post), instagram (the chosen Instagram account) or both (Meta picks; an Instagram post)'),
    }).optional().describe('create: a button added to the post (default: none — the post as it is)'),
    identities: z.enum(Object.keys(AD_FORMAT_OF) as [keyof typeof AD_FORMAT_OF, ...Array<keyof typeof AD_FORMAT_OF>]).optional().describe('a creator\'s content: which identities the partnership ad shows — both (default), first (the creator only) or auto (Meta picks; Instagram only)'),
    urlTags: z.string().trim().min(1).max(1000).optional().describe('create: url_tags added to the button\'s link (key=value&…)'),
    aiFeatures: z.array(z.enum(META_CREATIVE_FEATURES as [string, ...string[]])).max(80).optional().describe('create: the Advantage+ creative features to switch ON (every other one Meta documents is sent OFF)'),
    featureSettings: z.record(z.string(), z.record(z.string(), z.unknown())).optional().describe('create: per feature switched on, its customizations as Meta documents them'),
    multiAdvertiser: z.boolean().optional().describe('create: allow multi-advertiser ads (default false: contextual_multi_ads OPT_OUT)'),
    music: z.enum(['off', 'random']).optional().describe('create: off (default: the post keeps its own sound) or random (Meta adds a track)'),
    creatives: z.array(metaIdArg('a creative an earlier create-meta-boost made new')).min(1).max(MAX_CREATIVE_UNDO).optional().describe('undo: the creatives to delete (undo-change fills it)'),
    why: metaWhyArg,
  }),
  description:
    'Run an EXISTING post as an ad creative in the business\'s chosen Meta ad account (create-meta-ad then uses it): a post of '
    + 'the chosen Facebook Page (also on Instagram as the chosen account), a feed post, Reel, carousel or active story of the '
    + 'chosen Instagram account (by id, or by its public link), or a CREATOR\'s content — by its id when Meta\'s content '
    + 'discovery lists it for the business, or by the ad code the creator shared — as a partnership ad with this business as '
    + 'its sponsor (identities: both, first or auto). Threads: an Instagram or Facebook post runs there through the chosen '
    + 'Instagram account (no partnership, no story, image carousels only). Buttons: a link, a messaging button (Messenger, '
    + 'Instagram Direct or both) or a profile visit (Page, Instagram or both). Meta\'s eligibility is read first: copyrighted '
    + 'music, filters, IGTV and posts Meta will not promote are refused before anything is sent. Every Advantage+ creative '
    + 'feature, multi-advertiser ads, music, format automation and shop routing are sent OFF unless asked (exactly as '
    + 'create-meta-creative), the preview names each one on, and the run reads the creative back and says what Meta kept. '
    + 'Meta checks it first (validate_only). A boost SPENDS NOTHING until an ad uses it. If Meta already holds a creative of the '
    + 'same post it answers that one: nothing new is made and the undo never deletes it. ' + AD_CODE_KEPT + ' '
    + 'action copy-creator-video copies a creator\'s Instagram video into the '
    + 'library with their ad code. action undo deletes only creatives this tool made new, while no ad uses them.'
    + META_CHANGE_RULES,
  undo: boostUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, boostBuild(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, boostBuild(args), boostFinish),
}

// ── set-meta-partnership-access ─────────────────────────────────────────────────────────────────────────────────────

function partnershipRequestOf(args: Record<string, unknown>): PartnershipRequest {
  return {
    action: args.action as PartnershipRequest['action'],
    creators: ((args.creators as Array<Record<string, unknown>> | undefined) ?? []).map((c) => ({ instagramId: str(c.instagramId), username: str(c.username) })),
    mediaId: str(args.mediaId),
    accept: typeof args.accept === 'boolean' ? args.accept : null,
    pages: (args.pages as string[] | undefined) ?? [],
    enabled: typeof args.enabled === 'boolean' ? args.enabled : null,
    postIds: (args.postIds as string[] | undefined) ?? [],
  }
}

const partnershipBuild = (args: Record<string, unknown>): MetaDraftBuilder => (account) => partnershipDraft(account, partnershipRequestOf(args))

/**
 * Only what Meta made is recorded: the creators each done request named; review B1 — of a Facebook list (Meta answers per
 * item), only the Pages / posts Meta made.
 */
function partnershipFinish(draft: MetaChangeDraft, done: Array<{ request: MetaChangeRequest; result: MetaChangeResult }>): MetaRunOutcome {
  const d = draft as PartnershipDraft
  const p = d.partnership
  const before = d.before as Record<string, unknown>
  const after = d.after as Record<string, unknown>
  if (p.action === 'request' || p.action === 'revoke') {
    const made = new Set(done.map(({ request }) => request.params.creator_instagram_account))
    const keep = (list: unknown) => (Array.isArray(list) ? list.filter((c) => made.has(String((c as { instagramId?: unknown }).instagramId))) : [])
    return { data: { creators: [...made] }, before: { ...before, creators: keep(before.creators) }, after: { ...after, creators: keep(after.creators) } }
  }
  if (p.pages || p.postIds) {
    const madeIds = new Set(done.flatMap(({ result }) => ((result.node?.items ?? []) as Array<{ id?: string | null; ok?: boolean }>).filter((i) => i.ok && i.id).map((i) => String(i.id))))
    const key = p.postIds ? 'posts' : 'pages'
    const idOfRow = (row: unknown) => String((row as { pageId?: unknown; postId?: unknown }).pageId ?? (row as { postId?: unknown }).postId ?? '')
    const keep = (list: unknown) => (Array.isArray(list) ? list.filter((row) => madeIds.has(idOfRow(row))) : [])
    return { data: { action: p.action, made: [...madeIds] }, before: { ...before, [key]: keep(before[key]) }, after: { ...after, [key]: keep(after[key]) } }
  }
  return { data: { action: p.action, ...(p.creators ? { creators: p.creators } : {}), ...(p.mediaId ? { mediaId: p.mediaId } : {}) }, before, after }
}

type PartnershipStamped = { kind?: string; action?: string; instagramId?: string; pageId?: string; mediaId?: string; enabled?: unknown; creators?: Array<{ instagramId?: string }>; pages?: Array<{ pageId?: string }>; accountId?: string; adAccountId?: string }

/**
 * Undo, per action: a request ↔ a revoke (the creator accepts again), creators added to the approved-tagging list ↔ taken
 * off, an ad code made → deleted. A deleted ad code cannot come back (a new one is another code) and Meta documents no way
 * back from a Collab answer: those say so.
 */
const partnershipUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as PartnershipStamped
    const account = await recordAccount(after)
    if (!account) return null
    // The same Instagram account must still be the chosen one (else the undo would act on another).
    const chosen = await metaChosenAccount(account.accountId).catch(() => null)
    if (!chosen || (after.instagramId && chosen.instagramId !== after.instagramId) || (after.pageId && chosen.pageId !== after.pageId)) return null
    return { ...after, accountId: account.accountId, adAccountId: account.adAccountId }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as PartnershipStamped
    const connection = after.accountId ? { connectionId: after.accountId } : {}
    const creators = (after.creators ?? []).map((c) => c.instagramId).filter((id): id is string => typeof id === 'string').map((instagramId) => ({ instagramId }))
    const why = `undo of an earlier ${PARTNERSHIP_TOOL} (${after.action})`
    const pages = (after.pages ?? []).map((p) => p.pageId).filter((id): id is string => typeof id === 'string')
    const fb = (action: string, extra = '') => (pages.length ? { tool: PARTNERSHIP_TOOL, args: { ...connection, action, pages, why: `${why}${extra}` } } : { refusal: 'This change made nothing for any Page.' })
    switch (after.action) {
      // Review B1 — the Facebook side's inverses (a send ↔ a cancel, an accept → an end; an end → a new request the partner
      // accepts again; the allowlist back; creators added ↔ taken off). A rejection and an untag have none.
      case 'facebook-request': return fb('facebook-cancel')
      case 'facebook-cancel': return fb('facebook-request', ': the partner must accept again')
      case 'facebook-accept': return fb('facebook-remove')
      case 'facebook-remove': return fb('facebook-request', ': the partner must accept again')
      case 'facebook-reject': return { refusal: 'Meta has no way to take back a rejected partnership request: the partner has to ask again.' }
      case 'facebook-allowlist': return typeof after.enabled === 'boolean' ? { tool: PARTNERSHIP_TOOL, args: { ...connection, action: 'facebook-allowlist', enabled: !after.enabled, why } } : { refusal: 'This change names no allowlist state.' }
      case 'facebook-allow-creators': return fb('facebook-disallow-creators')
      case 'facebook-disallow-creators': return fb('facebook-allow-creators')
      case 'facebook-untag': return { refusal: 'Meta cannot put a removed sponsor tag back: only the creator can tag the Page again.' }
      case 'request': return creators.length ? { tool: PARTNERSHIP_TOOL, args: { ...connection, action: 'revoke', creators, why } } : { refusal: 'This change asked no creator, so there is nothing to revoke.' }
      case 'revoke': return creators.length ? { tool: PARTNERSHIP_TOOL, args: { ...connection, action: 'request', creators, why: `${why}: the creator must accept again` } } : { refusal: 'This change revoked no creator.' }
      case 'approve-creators': return creators.length ? { tool: PARTNERSHIP_TOOL, args: { ...connection, action: 'unapprove-creators', creators, why } } : { refusal: 'This change added no creator.' }
      case 'unapprove-creators': return creators.length ? { tool: PARTNERSHIP_TOOL, args: { ...connection, action: 'approve-creators', creators, why } } : { refusal: 'This change took no creator off.' }
      case 'delete-ad-code': return { refusal: 'Meta cannot bring a deleted ad code back: a new one is a different code.' }
      case 'collab-invite': return { refusal: 'Meta documents no way to take back an answer to a Collab invite: a person removes the business as collaborator in the Instagram app.' }
    }
    return { refusal: 'This change has no undo.' }
  },
}

const creatorArg = z.object({
  instagramId: z.string().trim().regex(/^[1-9]\d{0,24}$/, 'an Instagram account id: digits').optional().describe('the creator\'s Instagram account id'),
  username: z.string().trim().regex(/^@?[A-Za-z0-9._]{1,30}$/, 'an Instagram username').optional().describe('or the creator\'s Instagram username (a professional account; Nexus finds its id)'),
})

const setMetaPartnershipAccess: AgentTool = {
  name: PARTNERSHIP_TOOL,
  title: 'Change Meta partnership access',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // A request ↔ a revoke, a tag approval ↔ its removal, the Facebook inverses; a deleted code, a Collab answer, a rejected
  // Facebook request and a removed sponsor tag: none.
  reversibility: 'partial',
  consequencesFor: (args) => (['delete-ad-code', 'collab-invite', 'facebook-reject', 'facebook-untag', 'create-ad-code'].includes(String(args.action)) ? { reversibility: 'none' } : { reversibility: 'partial' }),
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: z.object({
    connectionId: metaConnectionArg,
    action: z.enum(PARTNERSHIP_ACTIONS).describe('Instagram (the chosen account): request (ask creators for account-level partnership permission), revoke, approve-creators / unapprove-creators (the approved-tagging list), delete-ad-code (the partnership ad code of its own media; create-ad-code is answered in words), collab-invite (accept or decline). Facebook (the chosen Page): facebook-request, facebook-cancel, facebook-accept, facebook-reject, facebook-remove (account-level permissions with partner Pages), facebook-allowlist (on / off), facebook-allow-creators, facebook-disallow-creators (the branded-content allowlist), facebook-untag (remove its sponsor tag from posts)'),
    creators: z.array(creatorArg).min(1).max(Math.max(MAX_CREATORS, META_TAG_APPROVAL_MAX)).optional().describe(`request, revoke: up to ${MAX_CREATORS} creators; approve-creators, unapprove-creators: up to ${META_TAG_APPROVAL_MAX}`),
    mediaId: z.string().trim().regex(/^[1-9]\d{0,24}$/, 'an Instagram media id: digits').optional().describe('delete-ad-code: a media of the chosen Instagram account; collab-invite: the invited media (meta-partnership-content view collab-invites)'),
    accept: z.boolean().optional().describe('collab-invite: true accepts, false declines'),
    pages: z.array(z.string().trim().regex(/^[1-9]\d{0,24}$/, 'a Facebook Page id: digits')).min(1).max(META_FB_LIST_MAX).optional().describe(`facebook-request … facebook-remove: up to ${META_FB_PARTNERS_MAX} partner Pages; facebook-allow-creators, facebook-disallow-creators: up to ${META_FB_LIST_MAX} creator Pages (their ids; meta-partnership-content views facebook-permissions and allowlist list them)`),
    enabled: z.boolean().optional().describe('facebook-allowlist: true — only allowlisted creator Pages may tag the Page; false — any creator allowed to make branded content may'),
    postIds: z.array(z.string().trim().regex(/^[1-9]\d{0,24}$/, 'a post id: digits')).min(1).max(META_FB_LIST_MAX).optional().describe(`facebook-untag: up to ${META_FB_LIST_MAX} branded-content posts that tag the Page (their ids, as meta-partnership-content view tagged-posts lists them)`),
    why: metaWhyArg,
  }),
  description:
    'Manage the partnership side of the business\'s chosen Instagram account on Meta: ask creators for account-level '
    + 'partnership permission or revoke it (a request reaches the creator in the Instagram app), add creators to or take them '
    + 'off the approved-tagging list (who may tag the business in the paid-partnership label; Meta changes it all or nothing), '
    + 'delete the partnership ad code of one of its OWN media (making one is answered in words: Meta answers a code only once '
    + 'and Nexus cannot show it to you later — make it in the Instagram app), and accept or decline a Collab invite. And the '
    + 'chosen Facebook Page\'s: account-level partnership permissions with partner Pages (send, cancel, accept, reject, end), '
    + 'its branded-content allowlist (on / off, creator Pages added or taken off) and its sponsor tag on posts that tag it — '
    + 'Meta answers each Page or post of a list on its own, and the run says what Meta did for each. Each creator or partner is '
    + 'another account than the business\'s own and never one another business in Nexus uses. Meta has no check for these '
    + 'changes (no validate_only): the preview is built from what Meta holds now. Nothing here spends money. Where Meta wants '
    + 'more access (Advanced access, a User token, the Page\'s own token) the run says Meta\'s own words.'
    + META_CHANGE_RULES,
  undo: partnershipUndo,
  // Review A2 — making an ad code is answered in words (nobody could read it); everything else is previewed and run.
  handler: (args, ctx) => (args.action === 'create-ad-code' ? Promise.resolve({ ok: false, error: CREATE_AD_CODE_ANSWER }) : metaChangePreview(args, ctx, partnershipBuild(args))),
  execute: (args, ctx) => (args.action === 'create-ad-code' ? Promise.resolve({ ok: false, error: CREATE_AD_CODE_ANSWER.replace(/^Not queued:/, 'Not run:') }) : runMetaChange(args, ctx, partnershipBuild(args), partnershipFinish)),
}

export const META_ADS_BOOSTS_TOOLS: AgentTool[] = [createMetaBoost, setMetaPartnershipAccess]
