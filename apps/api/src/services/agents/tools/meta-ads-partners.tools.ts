/**
 * Meta ads step 16 (2026-10-21) — Claude's read tools for partnership content and research (Facebook + Instagram). Read
 * only: nothing here changes Meta, and the gateway lets only GET through.
 *
 *   meta-partnership-content  the brand's partnership content (search, look-up, organic insights), Instagram and Facebook
 *                             partnership-ad permissions, approved creators, the Facebook brand allowlist and branded
 *                             posts, a creator's Instagram id, Collab invites and collaborative media, Creator Marketplace
 *                             (master MD-130, MD-131, CR-340, CR-341, CR-345, CR-347, CR-353, CR-356, CR-358, CR-361,
 *                             IN-093, AU-080, OT-006, OT-007, OT-025, OT-027, OT-036)
 *   meta-ad-library           Meta's Ad Library (other advertisers' ads, EU transparency), another Instagram professional
 *                             account's public numbers, hashtag search, another Page's public posts (OT-001–004,
 *                             OT-038–040)
 * The live reads are marketing/meta-ads/live-partners.ts. No money in these answers.
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolResult } from '../tool-types.js'
import { MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import { MetaReadError } from '../../marketing/meta-ads/errors.js'
import {
  AD_ELIGIBILITIES, AD_USAGES, CONTENT_KINDS, CONTENT_MEDIA_TYPES, CONTENT_PLATFORMS, CONTENT_POST_TYPES, FB_PERMISSION_STATUS,
  LIBRARY_AD_TYPES, LIBRARY_MEDIA, LIBRARY_PLATFORMS, LIBRARY_STATUSES, LIBRARY_VIEWS, liveLibrary, livePartnership, PARTNERSHIP_VIEWS,
  type CreatorFilters, type LibraryView, type PartnershipView,
} from '../../marketing/meta-ads/live-partners.js'

/** A refusal in words (Meta's own sentence, or Nexus's check before any call) is an answer, not a crash. */
export async function guardedMeta(work: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { ok: true, data: await work() }
  } catch (err) {
    if (err instanceof MetaLiveRefusal || err instanceof MetaReadError) return { ok: false, error: err.message }
    throw err
  }
}

export const lowerArg = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v)
export const upperArg = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : v)
export const connectionArg = z.string().trim().min(1).max(64).optional().describe('the Meta connection (from meta-connection); default: this business\'s one')
export const dayArg = (what: string) => z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(`${what} (YYYY-MM-DD)`)
export const idArg = (what: string) => z.string().trim().regex(/^\d{1,25}$/).optional().describe(`${what} (Meta's id, digits only)`)
export const afterArg = z.string().trim().min(1).max(500).optional().describe('the nextAfter of the answer before (the next page)')
const ids = (what: string, max: number) => z.array(z.string().trim().regex(/^\d{1,25}$/)).max(max).optional().describe(`${what} (Meta ids, digits; at most ${max})`)
const enums = <T extends readonly [string, ...string[]]>(values: T, max: number, what: string) => z.array(z.preprocess(upperArg, z.enum(values))).max(max).optional().describe(`${what}: ${values.join(', ')}`)
const country = z.string().trim().regex(/^[A-Za-z]{2}$/).transform((c) => c.toUpperCase())
const countries = (what: string, max = 50) => z.array(country).max(max).optional().describe(`${what} (ISO 3166-1 alpha-2 codes, e.g. IT, DE; at most ${max})`)
const username = (what: string) => z.string().trim().min(1).max(31).optional().describe(`${what} (an Instagram username, with or without @)`)

// ── meta-partnership-content ──────────────────────────────────────────────────────────────────────────────────────────

const FOLLOWER_MIN = [0, 10000, 25000, 50000, 75000, 100000, 250000, 1000000] as const
const FOLLOWER_MAX = [10000, 25000, 50000, 75000, 100000, 250000, 1000000] as const
const ENGAGED_MIN = [0, 2000, 10000, 50000, 100000] as const
const ENGAGED_MAX = [2000, 10000, 50000, 100000] as const
const AGE_BUCKETS = ['18_to_24', '25_to_34', '35_to_44', '45_to_54', '55_to_64', '65_and_above'] as const
const INTERESTS = [
  'ANIMALS_AND_PETS', 'BOOKS_AND_LITERATURE', 'BUSINESS_FINANCE_AND_ECONOMICS', 'EDUCATION_AND_LEARNING', 'BEAUTY', 'FASHION', 'FITNESS_AND_WORKOUTS',
  'FOOD_AND_DRINK', 'GAMES_PUZZLES_AND_PLAY', 'HISTORY_AND_PHILOSOPHY', 'HOLIDAYS_AND_CELEBRATIONS', 'HOME_AND_GARDEN', 'MUSIC_AND_AUDIO', 'PERFORMING_ARTS',
  'SCIENCE_AND_TECH', 'SPORTS', 'TV_AND_MOVIES', 'TRAVEL_AND_LEISURE_ACTIVITIES', 'VEHICLES_AND_TRANSPORTATION', 'VISUAL_ARTS_ARCHITECTURE_AND_CRAFTS',
] as const
const oneOf = <T extends readonly number[]>(values: T, what: string) => z.number().int().refine((n) => (values as readonly number[]).includes(n), { message: `one of ${values.join(', ')}` }).optional().describe(`${what}: ${values.join(', ')}`)
const lowerEnum = <T extends readonly [string, ...string[]]>(values: T, what: string) => z.preprocess(lowerArg, z.enum(values)).optional().describe(`${what}: ${values.join(', ')}`)
const lowerEnums = <T extends readonly [string, ...string[]]>(values: T, max: number, what: string) => z.array(z.preprocess(lowerArg, z.enum(values))).max(max).optional().describe(`${what}: ${values.join(', ')}`)

const creatorFilters = z.object({
  countries: countries('creators based in these countries', 25),
  states: z.array(z.string().trim().regex(/^[A-Za-z-]{2,6}$/)).max(50).optional().describe('creators in these state / region ISO codes (needs exactly one country)'),
  minFollowers: oneOf(FOLLOWER_MIN, 'at least this many followers'),
  maxFollowers: oneOf(FOLLOWER_MAX, 'at most this many followers'),
  interests: enums(INTERESTS, 5, 'creators in these categories (at most 5)'),
  minEngagedAccounts: oneOf(ENGAGED_MIN, 'at least this many engaged accounts'),
  maxEngagedAccounts: oneOf(ENGAGED_MAX, 'at most this many engaged accounts'),
  audienceAgeBuckets: lowerEnums(AGE_BUCKETS, 6, 'creators whose audience is mostly in these age ranges'),
  audienceGender: lowerEnums(['male', 'female'] as const, 2, 'creators whose audience is mostly this gender'),
  audienceCountries: countries('creators whose audience is mostly in these countries', 25),
  audienceStates: z.array(z.string().trim().regex(/^[A-Za-z-]{2,6}$/)).max(50).optional().describe('creators whose audience is mostly in these state / region codes (needs exactly one audience country)'),
  audienceDevices: lowerEnums(['ios', 'android'] as const, 2, 'creators whose audience mostly uses these devices'),
  query: z.string().trim().min(1).max(100).optional().describe('free-text search (usernames, content words, e.g. motorcycle)'),
  similarTo: z.array(z.string().trim().regex(/^@?[A-Za-z0-9._]{1,30}$/)).max(5).optional().describe('creators similar to these onboarded creators (usernames, at most 5; not with query)'),
  recommendation: lowerEnum(['most_relevant_for_me', 'high_ad_performance', 'most_ads_experience', 'similar_brands', 'similar_audience', 'interested_in_collaboration'] as const, 'Meta\'s recommendation set'),
  platform: lowerEnum(['instagram', 'facebook', 'both', 'any'] as const, 'where the creators publish (default instagram)'),
  pageName: z.string().trim().min(1).max(100).optional().describe('a creator by Facebook Page name (Meta\'s single best match)'),
  languages: z.array(z.string().trim().regex(/^[a-z]{2}$/)).max(10).optional().describe('creators who post in these languages (ISO 639-1, e.g. it; at most 10)'),
  latestPostActivity: lowerEnum(['last_7_days', 'last_30_days', 'last_90_days'] as const, 'creators who posted within'),
  followerGrowth: lowerEnum(['top_10_percent', 'top_30_percent', 'top_50_percent'] as const, 'creators with this follower growth in the last 30 days'),
  verified: z.boolean().optional().describe('only verified (or only not verified) accounts'),
  featuredInPaidAds: z.boolean().optional().describe('creators who were (or were not) in paid ads'),
  hasPortfolio: z.boolean().optional().describe('creators with (or without) a published portfolio'),
  excludeMessaged: z.boolean().optional().describe('leave out creators the brand already messaged'),
}).strict()

const metaPartnershipContent: AgentTool = {
  name: 'meta-partnership-content',
  title: 'Meta partnership content',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  // Item 7 — creators' ad codes asked about are never written to the run record.
  secretArgs: ['adCodes'],
  input: z.object({
    view: z.preprocess(lowerArg, z.enum(PARTNERSHIP_VIEWS)).describe(PARTNERSHIP_VIEWS.join(' | ')),
    platforms: enums(CONTENT_PLATFORMS, 2, 'search: only content on'),
    mediaTypes: enums(CONTENT_MEDIA_TYPES, 4, 'search: only these media types'),
    postTypes: enums(CONTENT_POST_TYPES, 3, 'search: only these post types'),
    contentTypes: enums(CONTENT_KINDS, 6, 'search: only these kinds of partnership content'),
    eligibility: enums(AD_ELIGIBILITIES, 4, 'search: only content with this ad eligibility'),
    usage: enums(AD_USAGES, 3, 'search: only content with this ad usage'),
    countries: countries('search: only content from creators in these countries'),
    from: dayArg('search: published on or after (with to) / tagged-posts: first day'),
    to: dayArg('search: published on or before (with from) / tagged-posts: the day after the last'),
    search: z.string().trim().min(1).max(100).optional().describe('search: words in the caption'),
    sortBy: z.preprocess(upperArg, z.enum(['RECOMMENDED', 'DATE'])).optional().describe('search: RECOMMENDED (default) | DATE'),
    recommendedOnly: z.boolean().optional().describe('search: only content Meta recommends for a partnership ad'),
    partnerPageIds: ids('search: only content of these partner Facebook Pages / facebook-permissions: only these partner Pages', 50),
    partnerInstagramIds: ids('search: only content of these partner Instagram accounts', 50),
    insights: z.boolean().optional().describe('search, lookup: add each post\'s organic numbers (likes, comments, views, reach, shares, interactions, saves)'),
    contentIds: z.array(z.string().trim().regex(/^\d{1,25}(_\d{1,25})?$/)).max(50).optional().describe('lookup, content-insights: Instagram media or Facebook post ids (at most 50)'),
    permalinks: z.array(z.string().trim().url().max(500)).max(50).optional().describe('lookup: Instagram or Facebook post links (at most 50)'),
    adCodes: z.array(z.string().trim().min(1).max(200)).max(50).optional().describe('lookup: partnership ad codes creators shared (at most 50)'),
    creatorUsername: username('instagram-permissions: only this creator'),
    statuses: z.array(z.preprocess(upperArg, z.enum(Object.keys(FB_PERMISSION_STATUS) as [string, ...string[]]))).max(6).optional().describe(`facebook-permissions: only these statuses: ${Object.keys(FB_PERMISSION_STATUS).join(', ')}`),
    direction: lowerEnum(['sent', 'received'] as const, 'facebook-permissions: requests the Page sent or received'),
    userIds: ids('tag-approvals: creators\' Instagram user ids to check', 100),
    creatorPageIds: ids('tagged-posts: only posts by these creator Pages', 50),
    username: username('creator-id, creators: the creator'),
    mediaId: idArg('collab-media: one collaborative post'),
    customAudienceId: idArg('creators: creators whose followers overlap this saved audience of the chosen ad account (view creator-marketplace lists them)'),
    creatorFilters: creatorFilters.optional().describe('creators: Meta\'s Creator Marketplace filters (not with username)'),
    limit: z.number().int().min(1).max(1000).optional().describe('rows per page (search, lookup ≤ 50; facebook-permissions ≤ 1000; tagged-posts ≤ 500; others ≤ 100)'),
    offset: z.number().int().min(0).max(1_000_000).optional().describe('facebook-permissions, tagged-posts: rows to skip (Meta pages these by offset)'),
    after: afterArg,
    connectionId: connectionArg,
  }),
  description:
    'Partnership content and creators of the business\'s chosen Facebook Page and Instagram account, live from Meta. '
    + 'search: partnership content that tags the brand on Facebook and Instagram at once (branded content, product tags, '
    + 'affiliate, Collab, tags, reposts) with ad eligibility and why not, permission, ad code, usage, and with insights '
    + 'the organic numbers; lookup: by content id, link or ad code; content-insights: organic likes, comments, views, '
    + 'reach, shares and saves of named content. instagram-permissions and facebook-permissions: partnership-ad '
    + 'permissions with creators, pending ones too; tag-approvals: whether creators may tag the brand in the paid-'
    + 'partnership label (Meta needs Advanced Access there); allowlist: whether only allowlisted creators may tag the '
    + 'Page, and who is on it; tagged-posts: Facebook branded-content posts that tag the Page; creator-id: a creator\'s '
    + 'Instagram id by username; collab-invites and collab-media: Instagram Collab invites and accepted collaborations; '
    + 'creator-marketplace: the brand\'s Creator Marketplace standing and the saved audiences it may match; creators: '
    + 'find creators (filters, a username, or followers overlapping a saved audience). Creator Marketplace needs Meta\'s '
    + 'App Review (Standard access answers test data only); where Meta wants a Page or person\'s token or a review, the '
    + 'answer says so in plain words. A Page or Instagram account another business in Nexus uses is its id and a flag only. '
    + 'Read only: asking permissions, accepting or declining invites and changing the allowlist are set-meta-partnership-access.',
  async handler(args): Promise<ToolResult> {
    const a = args as Record<string, unknown>
    const str = (k: string) => (typeof a[k] === 'string' ? a[k] as string : null)
    const arr = (k: string) => (Array.isArray(a[k]) ? a[k] as string[] : undefined)
    return guardedMeta(() => livePartnership({
      connectionId: str('connectionId'), view: a.view as PartnershipView,
      platforms: arr('platforms'), mediaTypes: arr('mediaTypes'), postTypes: arr('postTypes'), contentTypes: arr('contentTypes'),
      eligibility: arr('eligibility'), usage: arr('usage'), countries: arr('countries'), from: str('from'), to: str('to'), search: str('search'),
      sortBy: str('sortBy'), recommendedOnly: a.recommendedOnly === true, partnerPageIds: arr('partnerPageIds'), partnerInstagramIds: arr('partnerInstagramIds'),
      insights: a.insights === true, contentIds: arr('contentIds'), permalinks: arr('permalinks'), adCodes: arr('adCodes'),
      creatorUsername: str('creatorUsername'), statuses: arr('statuses'), direction: str('direction'), userIds: arr('userIds'), creatorPageIds: arr('creatorPageIds'),
      username: str('username'), mediaId: str('mediaId'), customAudienceId: str('customAudienceId'), creatorFilters: a.creatorFilters as CreatorFilters | undefined,
      limit: typeof a.limit === 'number' ? a.limit : undefined, offset: typeof a.offset === 'number' ? a.offset : undefined, after: str('after'),
    }))
  },
}

// ── meta-ad-library ───────────────────────────────────────────────────────────────────────────────────────────────────

const metaAdLibrary: AgentTool = {
  name: 'meta-ad-library',
  title: 'Meta Ad Library and research',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  input: z.object({
    view: z.preprocess(lowerArg, z.enum(LIBRARY_VIEWS)).describe(LIBRARY_VIEWS.join(' | ')),
    searchTerms: z.string().trim().min(1).max(100).optional().describe('search: words in the ads (a space means AND; Meta does not translate — search in the market\'s language, e.g. Italian for IT)'),
    exactPhrase: z.boolean().optional().describe('search: the words as one exact phrase'),
    pageIds: ids('search: all ads of these Facebook Pages', 10),
    countries: z.array(z.union([country, z.literal('ALL')])).min(1).max(50).optional().describe('search (required): the countries the ads reached (ISO codes, or ALL); Meta returns a non-political ad only when it reached the EU'),
    status: z.preprocess(upperArg, z.enum(LIBRARY_STATUSES)).optional().describe(`search: ${LIBRARY_STATUSES.join(' | ')} (Meta's default ACTIVE)`),
    from: dayArg('search: delivered on or after'),
    to: dayArg('search: delivered on or before'),
    languages: z.array(z.string().trim().regex(/^[a-z]{2,3}$/)).max(20).optional().describe('search: ads in these languages (ISO 639-1, e.g. it, de)'),
    mediaType: z.preprocess(upperArg, z.enum(LIBRARY_MEDIA)).optional().describe(`search: ${LIBRARY_MEDIA.join(' | ')}`),
    platforms: enums(LIBRARY_PLATFORMS, 8, 'search: ads on'),
    adType: z.preprocess(upperArg, z.enum(LIBRARY_AD_TYPES)).optional().describe(`search: ${LIBRARY_AD_TYPES.join(' | ')} (political and social-issue ads are not searched)`),
    username: username('instagram-account: the professional account to look up'),
    mediaLimit: z.number().int().min(1).max(25).optional().describe('instagram-account: its latest posts (default 12)'),
    hashtag: z.string().trim().min(1).max(101).optional().describe('hashtag: the hashtag, with or without #'),
    hashtagId: idArg('hashtag: the hashtag\'s id (from an answer before)'),
    order: lowerEnum(['top', 'recent'] as const, 'hashtag: top (default) or most recent posts'),
    pageId: idArg('page-posts: the Facebook Page'),
    limit: z.number().int().min(1).max(100).optional().describe('rows per page (default 25)'),
    after: afterArg,
    connectionId: connectionArg,
  }),
  description:
    'Research outside the business, live from Meta. search: Meta\'s Ad Library — other advertisers\' ads by words or by '
    + 'up to 10 Pages, in the countries they reached: texts, link titles, dates, platforms, languages and, for ads '
    + 'delivered to the EU or UK, Meta\'s EU transparency data (EU reach, reach by age, country and gender, targeted ages, '
    + 'gender and locations, payer and beneficiary), with a link to the ad in the public Ad Library. Meta answers a '
    + 'non-political ad only when it reached the EU; spend and impressions are public for political ads only (not '
    + 'searched); Meta\'s Ad Library API needs the app\'s Ad Library access (the answer says so when missing). '
    + 'instagram-account: another Instagram professional account\'s public numbers (followers, posts) and latest posts, '
    + 'through the business\'s own Instagram account. hashtag: public Instagram posts with a hashtag (top or recent; Meta '
    + 'allows 30 different hashtags per 7 days; needs Meta\'s Instagram Public Content Access review); recent-hashtags: '
    + 'the ones used. page-posts: another Facebook Page\'s public posts (needs Page Public Content Access). A Page or '
    + 'Instagram account another business in Nexus uses is never shown here (its id and a flag only). Read only.',
  async handler(args): Promise<ToolResult> {
    const a = args as Record<string, unknown>
    const str = (k: string) => (typeof a[k] === 'string' ? a[k] as string : null)
    const arr = (k: string) => (Array.isArray(a[k]) ? a[k] as string[] : undefined)
    return guardedMeta(() => liveLibrary({
      connectionId: str('connectionId'), view: a.view as LibraryView,
      searchTerms: str('searchTerms'), exactPhrase: a.exactPhrase === true, pageIds: arr('pageIds'), countries: arr('countries'), status: str('status'),
      from: str('from'), to: str('to'), languages: arr('languages'), mediaType: str('mediaType'), platforms: arr('platforms'), adType: str('adType'),
      username: str('username'), mediaLimit: typeof a.mediaLimit === 'number' ? a.mediaLimit : undefined, hashtag: str('hashtag'), hashtagId: str('hashtagId'),
      order: a.order === 'recent' ? 'recent' : 'top', pageId: str('pageId'), limit: typeof a.limit === 'number' ? a.limit : undefined, after: str('after'),
    }))
  },
}

export const META_ADS_PARTNERS_TOOLS: AgentTool[] = [metaPartnershipContent, metaAdLibrary]
