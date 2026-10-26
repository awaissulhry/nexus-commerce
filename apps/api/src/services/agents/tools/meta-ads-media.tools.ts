/**
 * Meta ads step 10 (2026-10-21) — Claude's reads of Meta media, Page posts, Instagram media, previews and Instant
 * Experiences. Read only: nothing here changes Meta, and the gateway lets only GET through. Every read is of the
 * business's CHOSEN ad account, its business portfolio, its chosen Facebook Page or its chosen Instagram account
 * (marketing/meta-ads/live-media.ts); a caller never names a Graph field or path.
 *
 *   meta-media-library        images and videos of the ad account (and which creatives use an image), one video (status,
 *                             details, thumbnails, captions), video-ads uploads, playables, the portfolio's media
 *                             library, folders and tags, the system user's folders, website assets, a campaign's video
 *                             groups, the Page's live videos and playlists (master MD-001…MD-039, MD-901, MD-902)
 *   meta-page-posts           the chosen Page's posts (all — visitors' too —, published, ad posts with dark posts), one post
 *                             (boostability, attachments), its sponsors and dynamic posts, the post and Instagram media
 *                             behind an ad, Page and post insights (MD-101…MD-106, MD-903, MD-904, EN-001, EN-016,
 *                             EN-926, IN-092)
 *   meta-instagram-media      Instagram accounts (portfolio, the Page's), media with carousel cards, stories, one media
 *                             (boostability, the ads that boost or boosted it), a publish container's status, the publishing quota, events,
 *                             a video's Instagram check, media and account insights (MD-118…MD-137, CR-260, IN-091)
 *   meta-ad-preview           previews of an ad, a creative or an unsaved spec per placement, Advantage+ features,
 *                             language and catalog variations, an Instant Experience, an ad's share link (CR-035…CR-038,
 *                             CR-403, CR-446, CR-462, CR-494, AD-010, AD-011)
 *   meta-instant-experiences  the chosen Page's Instant Experiences, one of them, their parts, a template's parts
 *                             (CR-486, CR-489, CR-490)
 * No answer holds money (organic counts and media only).
 * Live-probe fixes (2026-10-26): the Page's posts, insights and Instant Experience list go with the chosen Page's own token
 * (gateway/meta-page-reads.ts); visitor posts are not asked (Meta: not on the New Pages Experience); the media-library
 * and template reads Meta refuses to this app are said in words (LIVE-PROBES MD-101, MD-106, IN-092, CR-489, CR-490, ST10-03).
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolResult } from '../tool-types.js'
import { connectionArg, dayArg, guarded, lower, metaIdArg } from './meta-ads-read.tools.js'
import {
  AD_FORMATS, BROADCAST_STATUSES, CREATIVE_FEATURES, IG_ACCOUNT_BREAKDOWNS, IG_ACCOUNT_METRICS, IG_MEDIA_BREAKDOWNS, IG_MEDIA_METRICS, IG_METRIC_TYPES,
  IG_TIMEFRAMES, INSTAGRAM_VIEWS, IX_TEMPLATES, IX_VIEWS, liveInstagram, liveInstantExperiences, liveMedia, livePagePosts, livePreview, MEDIA_VIEWS,
  PAGE_BREAKDOWNS, PAGE_METRICS, PAGE_PERIODS, POST_METRICS, POST_VIEWS, PREVIEW_CTAS, PREVIEW_VIEWS, SPEC_KINDS,
  type InstagramInput, type IxInput, type MediaInput, type PostsInput, type PreviewInput,
} from '../../marketing/meta-ads/live-media.js'

const maxRowsArg = (dflt: number) => z.number().int().min(1).max(500).optional().describe(`at most this many rows (default ${dflt}, at most 500)`)
const postIdArg = z.string().trim().regex(/^\d{1,25}_\d{1,25}$/).optional().describe('a post of the chosen Page, as the posts views give it (<Page id>_<post id>)')
const urlArg = (what: string) => z.string().trim().max(2000).regex(/^https?:\/\/[^\s"'<>]+$/).describe(what)
const hashArg = (what: string) => z.string().trim().regex(/^[A-Za-z0-9]{1,64}$/).describe(what)
const uniq = <T extends string>(...lists: ReadonlyArray<readonly T[]>) => [...new Set(lists.flat())] as [T, ...T[]]

/** The args as given (zod has checked them); empty strings and absent values are null. */
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

// ── meta-media-library ───────────────────────────────────────────────────────────────────────────────────────────

const metaMediaLibrary: AgentTool = {
  name: 'meta-media-library',
  title: 'Meta media library',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  input: z.object({
    view: z.preprocess(lower, z.enum(MEDIA_VIEWS)).describe(MEDIA_VIEWS.join(' | ')),
    hashes: z.array(hashArg('an image hash')).max(50).optional().describe('images: only these image hashes (to see which creatives and ads use them)'),
    name: z.string().trim().min(1).max(100).optional().describe('images: Meta\'s name filter; videos: Meta\'s title filter'),
    minWidth: z.number().int().min(1).max(20000).optional().describe('images: at least this many pixels wide'),
    minHeight: z.number().int().min(1).max(20000).optional().describe('images: at least this many pixels high'),
    minSeconds: z.number().int().min(1).max(86400).optional().describe('videos: at least this long (seconds)'),
    maxSeconds: z.number().int().min(1).max(86400).optional().describe('videos: at most this long (seconds)'),
    videoId: metaIdArg('video: a video of the chosen ad account\'s library or of the chosen Page (from view videos)'),
    folderId: metaIdArg('business-images, business-videos, business-creatives: only this folder of the portfolio (from view folders)'),
    link: urlArg('website-assets: the landing page (a full address)').optional(),
    campaignId: metaIdArg('campaign-videos: a campaign of the chosen ad account'),
    playlistId: metaIdArg('playlist-videos: a playlist of the chosen Page (from view playlists)'),
    broadcastStatus: z.array(z.enum(BROADCAST_STATUSES)).max(BROADCAST_STATUSES.length).optional().describe('live-videos: only these states (VOD: finished broadcasts that can be boosted)'),
    from: dayArg('video-ads: changed since; campaign-videos: from'),
    to: dayArg('video-ads: changed until; campaign-videos: to'),
    maxRows: maxRowsArg(100),
    connectionId: connectionArg,
  }),
  description:
    'Images and videos Meta holds for the business, read LIVE. view images: the chosen ad account\'s image library (hash, '
    + 'size, status, permanent link; usedByCreatives and usedInAds say what uses each, e.g. before a swap; hashes narrows it). '
    + 'videos: its video library (length, status in words, Instagram-eligible). video (videoId): one video — upload and '
    + 'processing status (a creative may use it only when ready), details, thumbnails, captions. video-ads: videos sent '
    + 'through Meta\'s video-ads upload. playables: HTML5 assets (app ads only). business-images, business-videos, '
    + 'business-creatives (folderId): the business portfolio\'s media library; folders, tags: its folders and tags (Nexus '
    + 'does not change them here; a person can in Business Settings › Media library). When another business in Nexus reads '
    + 'an ad account of the same portfolio, the portfolio is its id only and nothing of it is read. my-folders: the folders '
    + 'the system user may use. website-assets (link): what Meta pulls from a landing page by itself for Advantage+ creative; asset-urls: the '
    + 'addresses it pulls from. campaign-videos (campaignId): a campaign\'s video groups (Meta lists the portfolio\'s library, '
    + 'folders, tags, the system user\'s folders, website assets, asset-urls and video groups in its reference, but answers '
    + 'this app that they do not exist: the answer then says so, with what to use instead). live-videos, playlists, '
    + 'playlist-videos: the chosen Page\'s live broadcasts (a finished one can be boosted) and video playlists. Only the '
    + 'chosen ad account, its portfolio and the chosen Page are read. Uploading images and videos, making a folder and '
    + 'taking back an upload are create-meta-media (a request a person approves). Read only.',
  async handler(args): Promise<ToolResult> {
    return guarded(() => liveMedia({
      connectionId: str(args.connectionId),
      view: args.view as MediaInput['view'],
      hashes: args.hashes as string[] | undefined,
      name: str(args.name),
      minWidth: args.minWidth as number | undefined,
      minHeight: args.minHeight as number | undefined,
      minSeconds: args.minSeconds as number | undefined,
      maxSeconds: args.maxSeconds as number | undefined,
      videoId: str(args.videoId),
      folderId: str(args.folderId),
      link: str(args.link),
      campaignId: str(args.campaignId),
      playlistId: str(args.playlistId),
      broadcastStatus: args.broadcastStatus as string[] | undefined,
      from: str(args.from),
      to: str(args.to),
      maxRows: args.maxRows as number | undefined,
    }))
  },
}

// ── meta-page-posts ──────────────────────────────────────────────────────────────────────────────────────────────

const metaPagePosts: AgentTool = {
  name: 'meta-page-posts',
  title: 'Meta Page posts',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  input: z.object({
    view: z.preprocess(lower, z.enum(POST_VIEWS)).describe(POST_VIEWS.join(' | ')),
    postId: postIdArg,
    adId: metaIdArg('ad-post: an ad of the chosen ad account'),
    creativeId: metaIdArg('ad-post: a creative of the chosen ad account (instead of adId)'),
    includeHidden: z.boolean().optional().describe('feed, published: also hidden posts'),
    showExpired: z.boolean().optional().describe('feed, published: also expired posts'),
    includeInlineCreated: z.boolean().optional().describe('ads-posts: with the dark posts creatives made inline (default true)'),
    excludeDynamic: z.boolean().optional().describe('ads-posts: without catalog (dynamic) ad posts'),
    from: dayArg('ads-posts, page-insights, post-insights: from'),
    to: dayArg('ads-posts, page-insights, post-insights: to'),
    metrics: z.array(z.enum(uniq(PAGE_METRICS, POST_METRICS))).max(20).optional().describe('page-insights: page_… metrics; post-insights: post_… metrics (default: views, reach, engagement and follows)'),
    period: z.preprocess(lower, z.enum(PAGE_PERIODS)).optional().describe('page-insights, post-insights: day | week | days_28 | month | lifetime | total_over_range'),
    breakdown: z.preprocess(lower, z.enum(PAGE_BREAKDOWNS)).optional().describe('page-insights, post-insights: is_from_ads | is_from_followers (for the media-view metrics)'),
    maxRows: maxRowsArg(50),
    connectionId: connectionArg,
  }),
  description:
    'The business\'s chosen Facebook Page\'s posts, read LIVE. view feed: every post — published, unpublished (dark) and '
    + 'scheduled (isPublished says which; Meta answers about 600 ranked posts a year), and the posts other people wrote on '
    + 'the Page, e.g. complaints and questions (postedBy: someone else — who wrote it is never copied: open its link). '
    + 'published: published only. ads-posts: the Page\'s ad posts with the dark posts creatives made inline. visitor: Meta '
    + 'does not answer visitor posts for a Page on the New Pages Experience, so nothing is asked (they are in feed). post (postId): one post — whether and where it can be boosted (promotableId is the id '
    + 'an ad takes, not always the post id), its photo, video, link and title (attachments, every card). post-sponsors: '
    + 'paid-partner brands tagged on it; post-dynamic: catalog ad posts made from it. ad-post (adId or creativeId): the '
    + 'Facebook post and Instagram media behind one of the chosen account\'s ads. page-insights, post-insights: Meta\'s '
    + 'organic numbers (views, reach, clicks, reactions, follows; retired metrics are not offered). Only the chosen Page '
    + 'is read: another Page\'s post is refused before any call. The feed, published and ad posts, catalog-ad posts and '
    + 'the insights go with the chosen Page\'s own token (Meta answers them to no other); when Meta refuses one, the answer '
    + 'says what the Page needs (the system user needs the Page assigned with the task). Read only.',
  async handler(args): Promise<ToolResult> {
    return guarded(() => livePagePosts({
      connectionId: str(args.connectionId),
      view: args.view as PostsInput['view'],
      postId: str(args.postId),
      adId: str(args.adId),
      creativeId: str(args.creativeId),
      includeHidden: args.includeHidden === true,
      showExpired: args.showExpired === true,
      includeInlineCreated: args.includeInlineCreated as boolean | undefined,
      excludeDynamic: args.excludeDynamic === true,
      from: str(args.from),
      to: str(args.to),
      metrics: args.metrics as string[] | undefined,
      period: str(args.period),
      breakdown: str(args.breakdown),
      maxRows: args.maxRows as number | undefined,
    }))
  },
}

// ── meta-instagram-media ─────────────────────────────────────────────────────────────────────────────────────────

const metaInstagramMedia: AgentTool = {
  name: 'meta-instagram-media',
  title: 'Meta Instagram media',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  input: z.object({
    view: z.preprocess(lower, z.enum(INSTAGRAM_VIEWS)).describe(INSTAGRAM_VIEWS.join(' | ')),
    mediaId: metaIdArg('media-detail, media-insights: a media of the chosen Instagram account (from view media or stories)'),
    videoId: metaIdArg('video-check: a video of the chosen ad account\'s library or of the chosen Page'),
    from: dayArg('media, account-insights: from'),
    to: dayArg('media, account-insights: to'),
    metrics: z.array(z.enum(uniq(IG_MEDIA_METRICS, IG_ACCOUNT_METRICS))).max(20).optional().describe('media-insights (only those of the media\'s kind: a story has replies and navigation, no likes or saves) or account-insights; default: views, reach and interactions'),
    breakdown: z.enum(uniq(IG_MEDIA_BREAKDOWNS, IG_ACCOUNT_BREAKDOWNS)).optional().describe('media-insights: action_type (profile_activity) or story_navigation_action_type (navigation); account-insights: media_product_type, follow_type, follower_type, contact_button_type, or age / city / country / gender for the demographics'),
    metricType: z.enum(IG_METRIC_TYPES).optional().describe('account-insights: total_value (default) or time_series'),
    timeframe: z.enum(IG_TIMEFRAMES).optional().describe('account-insights demographics: this_month (default) or this_week (Meta retired the others in v20)'),
    maxRows: maxRowsArg(50),
    connectionId: connectionArg,
  }),
  description:
    'The business\'s chosen Instagram account, read LIVE. view accounts: the Instagram accounts of the chosen ad account\'s '
    + 'business portfolio, the one connected to the chosen Page and its Page-backed one (one another business in Nexus uses '
    + 'is its id only). media: posts, reels and carousels with their cards, likes and comment counts (newest first; '
    + 'from / to). stories: the live stories (24 hours). media-detail (mediaId): one media — whether it can be boosted and '
    + 'why not (copyrighted music, filters), the ads that boost or boosted it (active or not), its copyright check. media-insights, '
    + 'account-insights: Meta\'s organic numbers (views, reach, likes, saves, shares, follows, demographics; impressions '
    + 'are retired; only the metrics a media\'s kind has — a story has no likes), to pick posts to boost. quota: posts '
    + 'published through the API in 24 hours against Meta\'s limit (the state of a publish container Nexus made is in '
    + 'create-meta-instagram-post\'s answer). upcoming-events: events a reminder ad can point to. '
    + 'video-check (videoId): whether a video meets Instagram\'s ad rules. Only the chosen Instagram account is read: '
    + 'another account\'s media is refused. Publishing is create-meta-instagram-post, boosting create-meta-boost. Read only.',
  async handler(args): Promise<ToolResult> {
    return guarded(() => liveInstagram({
      connectionId: str(args.connectionId),
      view: args.view as InstagramInput['view'],
      mediaId: str(args.mediaId),
      videoId: str(args.videoId),
      from: str(args.from),
      to: str(args.to),
      metrics: args.metrics as string[] | undefined,
      breakdown: str(args.breakdown),
      metricType: str(args.metricType),
      timeframe: str(args.timeframe),
      maxRows: args.maxRows as number | undefined,
    }))
  },
}

// ── meta-ad-preview ──────────────────────────────────────────────────────────────────────────────────────────────

const specArg = z.object({
  kind: z.enum(SPEC_KINDS).describe('image | video | carousel | page-post (a post of the chosen Page) | instagram-post (a media of the chosen Instagram account) | multi-language'),
  link: urlArg('where the ad leads (image, video, carousel; a call to action of an instagram-post)').optional(),
  message: z.string().trim().max(2200).optional().describe('the primary text'),
  headline: z.string().trim().max(255).optional().describe('the headline'),
  description: z.string().trim().max(255).optional().describe('the description under the headline'),
  callToAction: z.enum(PREVIEW_CTAS).optional().describe('the button'),
  imageHash: hashArg('an image of the chosen ad account\'s library (meta-media-library view images); a video\'s thumbnail').optional(),
  imageUrl: urlArg('an image address Meta fetches instead of a hash (never a Meta image link)').optional(),
  videoId: metaIdArg('video, multi-language: a video of the chosen ad account\'s library or of the chosen Page'),
  cards: z.array(z.object({
    link: urlArg('where the card leads'),
    headline: z.string().trim().max(255).optional().describe('the card\'s headline'),
    description: z.string().trim().max(255).optional().describe('the card\'s description'),
    imageHash: hashArg('the card\'s image hash').optional(),
    imageUrl: urlArg('the card\'s image address').optional(),
  })).max(10).optional().describe('carousel: 2 to 10 cards'),
  postId: postIdArg,
  instagramMediaId: metaIdArg('instagram-post: a media of the chosen Instagram account'),
  languages: z.array(z.object({
    label: z.string().trim().regex(/^[a-z0-9_]{1,30}$/).describe('the language\'s label (e.g. italian); assetLabel previews it'),
    locales: z.array(z.number().int().min(1).max(10000)).min(1).max(50).describe('Meta\'s locale keys this version is shown to'),
    isDefault: z.boolean().optional().describe('exactly one language is the default (shown when no locale matches)'),
    message: z.string().trim().min(1).max(2200).describe('the primary text in this language'),
    headline: z.string().trim().min(1).max(255).describe('the headline in this language'),
    description: z.string().trim().max(255).optional().describe('the description in this language'),
    link: urlArg('where this language\'s ad leads'),
  })).max(10).optional().describe('multi-language: 2 to 10 language versions'),
  withInstagram: z.boolean().optional().describe('show it as the chosen Instagram account too (default true when one is chosen)'),
})

const metaAdPreview: AgentTool = {
  name: 'meta-ad-preview',
  title: 'Meta ad preview',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  // Review A2 — Claude's door only: the in-app chat keeps each tool result in the run's steps, and a preview link is
  // public, so it is never stored. Through the MCP door a read's run keeps only its mode, never its answer.
  surfaces: ['mcp'],
  input: z.object({
    view: z.preprocess(lower, z.enum(PREVIEW_VIEWS)).describe(PREVIEW_VIEWS.join(' | ')),
    adId: metaIdArg('ad, share-link: an ad of the chosen ad account'),
    creativeId: metaIdArg('creative: a creative of the chosen ad account'),
    canvasId: metaIdArg('instant-experience: an Instant Experience of the chosen Page'),
    adFormats: z.array(z.enum(AD_FORMATS)).max(10).optional().describe('the placements to preview, one preview each (default MOBILE_FEED_STANDARD), e.g. INSTAGRAM_STANDARD, INSTAGRAM_STORY, INSTAGRAM_REELS, FACEBOOK_REELS_MOBILE, DESKTOP_FEED_STANDARD'),
    creativeFeature: z.enum(CREATIVE_FEATURES).optional().describe('ad, creative, spec: preview one Advantage+ creative feature (eligible, pending or ineligible)'),
    assetLabel: z.string().trim().regex(/^[A-Za-z0-9_-]{1,50}$/).optional().describe('one variation of a multi-language or asset-customization ad, by its label'),
    productItemIds: z.array(z.string().trim().regex(/^\d{1,25}$/)).max(10).optional().describe('catalog ads: preview with these product item ids (several: a carousel); Meta renders them with the creative\'s own catalog — Nexus checks them against the business\'s catalog from the catalog step on'),
    language: z.string().trim().regex(/^[a-z]{2,3}_[A-Z]{2}$/).optional().describe('catalog ads: preview in this language (e.g. fr_XX)'),
    country: z.string().trim().regex(/^[A-Z]{2}$/).optional().describe('catalog ads: preview for this country (e.g. FR)'),
    spec: specArg.optional().describe('spec: the unsaved creative, built from the chosen Page and Instagram account and the account\'s own media'),
    connectionId: connectionArg,
  }),
  description:
    'See an ad before or after it runs, as Meta renders it, read LIVE. view ad (adId), creative (creativeId): an ad or '
    + 'creative of the chosen ad account; spec: an unsaved creative (image, video, carousel, a Page post, an Instagram '
    + 'post, or a multi-language ad) built only from the chosen Page, Instagram account and the account\'s own images and '
    + 'videos. One preview per placement (adFormats, up to 10); creativeFeature previews an Advantage+ feature (eligible, '
    + 'pending — ask again — or ineligible: Meta will not apply it); assetLabel one language or variation; productItemIds, '
    + 'language and country a catalog ad. instant-experience (canvasId): an Instant Experience of the chosen Page. '
    + 'share-link (adId): the ad\'s shareable preview link. Each answer is a link (and Meta\'s iframe) valid 24 hours: '
    + 'PUBLIC — anyone with it can open it, so it goes to the person only; Nexus never stores or logs it. Nexus previews '
    + 'through the chosen ad account only (Meta\'s account-less preview names no account Nexus can check, and answers the '
    + 'same). Not every creative renders on every placement, and some formats name placements Meta has retired (Messenger '
    + 'stories, Instant Articles): Meta says so per placement. Offered to Claude only, never in the in-app chat. Read only.',
  async handler(args): Promise<ToolResult> {
    return guarded(() => livePreview({
      connectionId: str(args.connectionId),
      view: args.view as PreviewInput['view'],
      adId: str(args.adId),
      creativeId: str(args.creativeId),
      canvasId: str(args.canvasId),
      adFormats: args.adFormats as string[] | undefined,
      creativeFeature: str(args.creativeFeature),
      assetLabel: str(args.assetLabel),
      productItemIds: args.productItemIds as string[] | undefined,
      language: str(args.language),
      country: str(args.country),
      spec: (args.spec as PreviewInput['spec']) ?? null,
    }))
  },
}

// ── meta-instant-experiences ─────────────────────────────────────────────────────────────────────────────────────

const metaInstantExperiences: AgentTool = {
  name: 'meta-instant-experiences',
  title: 'Meta Instant Experiences',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  input: z.object({
    view: z.preprocess(lower, z.enum(IX_VIEWS)).describe(IX_VIEWS.join(' | ')),
    canvasId: metaIdArg('one: an Instant Experience of the chosen Page (from view list)'),
    template: z.enum(Object.keys(IX_TEMPLATES) as [keyof typeof IX_TEMPLATES, ...Array<keyof typeof IX_TEMPLATES>]).optional()
      .describe(`template: ${Object.keys(IX_TEMPLATES).join(' | ')}`),
    published: z.boolean().optional().describe('list: only published (true) or unpublished (false) ones'),
    hidden: z.boolean().optional().describe('list: only hidden (true) or visible (false) ones'),
    maxRows: maxRowsArg(50),
    connectionId: connectionArg,
  }),
  description:
    'Instant Experiences (full-screen pages an ad opens) of the business\'s chosen Facebook Page, read LIVE. view list: '
    + 'every one with name, link and whether it is published or hidden (an unpublished one can still be changed and may be '
    + 'left behind by an unfinished builder; Meta lets no published one change). one (canvasId): one with its parts. '
    + 'elements: the parts made on the Page. template: which parts one of Meta\'s templates takes (get-new-customers, '
    + 'showcase-your-business, sell-products-without-catalog, sell-products-lifestyle, sell-products-grid; the AR template '
    + 'is Ads Manager only). meta-ad-preview view instant-experience shows one. create-meta-instant-experience makes one '
    + '(always unpublished); set-meta-instant-experience edits, publishes or hides it. The list goes with the chosen Page\'s own token (Meta answers it to no other). Meta refuses the '
    + 'template read to the business\'s token (insufficient permissions): the answer then says so. Read only.',
  async handler(args): Promise<ToolResult> {
    return guarded(() => liveInstantExperiences({
      connectionId: str(args.connectionId),
      view: args.view as IxInput['view'],
      canvasId: str(args.canvasId),
      template: (args.template as IxInput['template']) ?? null,
      published: args.published as boolean | undefined,
      hidden: args.hidden as boolean | undefined,
      maxRows: args.maxRows as number | undefined,
    }))
  },
}

export const META_ADS_MEDIA_TOOLS: AgentTool[] = [metaMediaLibrary, metaPagePosts, metaInstagramMedia, metaAdPreview, metaInstantExperiences]
