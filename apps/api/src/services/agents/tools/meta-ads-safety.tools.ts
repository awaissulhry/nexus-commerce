/**
 * Meta ads step 16 (2026-10-21) — Claude's read tools for brand safety and webhooks. Read only: nothing here changes Meta,
 * and the gateway lets only GET through.
 *
 *   meta-brand-safety  publisher block lists, content block lists, publisher / content / adjacent-content delivery reports
 *                      of an ad set and their dates, the content found in them, Meta's partner-publisher list (master
 *                      AS-018, BS-009, BS-010, BS-015, BS-018, BS-021, BS-023, BS-024, BS-027, BS-030, BS-033–041). D6:
 *                      these need a Meta capability grant; when Meta refuses, the answer says so and names the no-grant
 *                      controls.
 *   meta-webhooks      the app's webhook subscriptions, the apps connected to the chosen ad account and Page, the ad
 *                      account's alert subscriptions (AA-033, WH-006, WH-009 read, WH-011, WH-055)
 * The live reads are marketing/meta-ads/live-safety.ts. Money: an alert's threshold on spend, budgets, bids or costs is in
 * minor units (cents) of the account currency and needs the ad-spend money permission.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolResult } from '../tool-types.js'
import {
  ADJACENT_PLATFORMS, ADJACENT_POSITIONS, CONTENT_PLATFORM_EDGES, FOLLOWER_BUCKETS, liveSafety, liveWebhooks, PDR_PLATFORMS, PDR_POSITIONS, PDR_SORTS,
  PUBLISHER_STATUSES, SAFETY_VIEWS, WEBHOOK_VIEWS, type SafetyView, type WebhookView,
} from '../../marketing/meta-ads/live-safety.js'
import { afterArg, connectionArg, dayArg, guardedMeta, idArg, lowerArg } from './meta-ads-partners.tools.js'

const lowerEnum = <T extends readonly [string, ...string[]]>(values: T, what: string) => z.preprocess(lowerArg, z.enum(values)).optional().describe(`${what}: ${values.join(', ')}`)
const PLATFORMS = [...new Set([...PDR_PLATFORMS, ...ADJACENT_PLATFORMS])] as unknown as readonly [string, ...string[]]
const POSITIONS = [...new Set([...PDR_POSITIONS, ...ADJACENT_POSITIONS])] as unknown as readonly [string, ...string[]]

const metaBrandSafety: AgentTool = {
  name: 'meta-brand-safety',
  title: 'Meta brand safety',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  input: z.object({
    view: z.preprocess(lowerArg, z.enum(SAFETY_VIEWS)).describe(SAFETY_VIEWS.join(' | ')),
    blockListId: idArg('block-list: the publisher block list (from view block-lists)'),
    items: z.boolean().optional().describe('block-list: also the blocked web and app publishers (at most 500 of each shown)'),
    contentBlockListId: idArg('content-block-list: the content block list (from view content-block-lists)'),
    content: lowerEnum(Object.keys(CONTENT_PLATFORM_EDGES) as [string, ...string[]], 'content-block-list: also list its posts on'),
    adSetId: idArg('publisher-report, content-report, adjacent-report: an ad set of the chosen ad account'),
    platform: lowerEnum(PLATFORMS, 'the reports and date ranges, partner-publishers: the platform (publisher reports: audience_network, facebook, instagram; adjacent: facebook, instagram, threads; partner-publishers: audience_network, facebook)'),
    position: lowerEnum(POSITIONS, 'the placement (publisher reports: instream_video, facebook_reels_overlay, an_classic, rewarded_video; content reports: instream_video, facebook_reels_overlay; adjacent: feed, reels)'),
    sortBy: z.string().trim().regex(/^[a-z_]{3,40}$/).optional().describe(`publisher-report: ${PDR_SORTS.join(', ')} (an_classic and rewarded_video only); partner-publishers: Meta's sort field`),
    nameContains: z.string().trim().min(1).max(100).optional().describe('publisher-report: only publishers whose name holds these letters'),
    publisherStatus: lowerEnum(PUBLISHER_STATUSES, 'publisher-report (instream_video): partner publishers or not'),
    from: dayArg('publisher-report: first day (with to) / partner-publishers: added on or after'),
    to: dayArg('publisher-report: last day (with from) / partner-publishers: added on or before'),
    datetime: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:00$/).optional().describe('content-report, adjacent-report: one hour, YYYY-MM-DDTHH:00, Pacific Time (default: the latest)'),
    videoId: idArg('content-lookup: a video found in a content report (content_id)'),
    pageId: idArg('content-lookup: a Page found in a content report (creator_id)'),
    search: z.string().trim().min(1).max(100).optional().describe('partner-publishers: words in the URL, username or creator name'),
    blueVerified: lowerEnum(['yes', 'no', 'all'] as const, 'partner-publishers (facebook): verified Pages only, or not'),
    followerCount: z.enum(FOLLOWER_BUCKETS).optional().describe(`partner-publishers (facebook): ${FOLLOWER_BUCKETS.join(', ')}`),
    appCategory: z.string().trim().min(1).max(100).optional().describe('partner-publishers (audience_network): app store category holds'),
    limit: z.number().int().min(1).max(500).optional().describe('rows per page (default 100; content-report at least 25)'),
    after: afterArg,
    connectionId: connectionArg,
  }),
  description:
    'Brand safety of the business\'s chosen Meta ad account, live from Meta. block-lists, block-list: publisher block '
    + 'lists of the account (items, owner, last change; who it is shared with, people\'s roles for someone who may see the '
    + 'team, the ad accounts it was applied to). content-block-lists, content-block-list: the business portfolio\'s '
    + 'content block lists, their Facebook / Instagram / Threads posts and the ad accounts using them. publisher-report-dates, '
    + 'publisher-report: where an ad set\'s ads ran, by publisher, with estimated impressions; content-report-dates, '
    + 'content-report: the posts and videos they ran in or next to, by hour (last 15 days); content-lookup: one video or Page '
    + 'found there; adjacent-report-dates, adjacent-report: the posts above and below the ads in Feed and Reels. '
    + 'partner-publishers, partner-publishers-dates: Meta\'s list of partner publishers per placement. Meta cannot yet list '
    + 'the content block lists of one ad account or check one post (planned, view account-content-block-lists); the CSV '
    + 'export comes with step 39, Nexus brand-safety changes (view content-block-list-file). These reads need a capability grant from Meta '
    + '(block lists, content block lists, delivery reports, Feed verification): when Meta has not granted it, the answer '
    + 'says so plainly and names the controls that need no grant (inventory filter, placements, excluded publisher '
    + 'categories). Only the chosen ad account, its portfolio and its own ad sets; another business\'s ad account or Page is '
    + 'its id and a flag only. Read only: block-list changes are set-meta-block-list (a later step).',
  async handler(args, ctx): Promise<ToolResult> {
    const a = args as Record<string, unknown>
    const str = (k: string) => (typeof a[k] === 'string' ? a[k] as string : null)
    return guardedMeta(() => liveSafety({
      connectionId: str('connectionId'), view: a.view as SafetyView, blockListId: str('blockListId'), items: a.items === true,
      contentBlockListId: str('contentBlockListId'), content: (str('content') as keyof typeof CONTENT_PLATFORM_EDGES | null), adSetId: str('adSetId'),
      platform: str('platform'), position: str('position'), sortBy: str('sortBy'), nameContains: str('nameContains'), publisherStatus: str('publisherStatus'),
      from: str('from'), to: str('to'), datetime: str('datetime'), videoId: str('videoId'), pageId: str('pageId'), search: str('search'),
      blueVerified: str('blueVerified'), followerCount: str('followerCount'), appCategory: str('appCategory'),
      limit: typeof a.limit === 'number' ? a.limit : undefined, after: str('after'),
    }, !!ctx?.can?.(F.usersManage)))
  },
}

const ADSPEND = FIELDS.financialsAdspendView

const metaWebhooks: AgentTool = {
  name: 'meta-webhooks',
  title: 'Meta webhooks and alerts',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  restrictedFields: { thresholdCents: ADSPEND, valueCents: ADSPEND },
  input: z.object({
    view: z.preprocess(lowerArg, z.enum(WEBHOOK_VIEWS)).default('all').describe(`${WEBHOOK_VIEWS.join(' | ')} (default all)`),
    subscriptionId: idArg('alerts: one alert subscription'),
    after: afterArg,
    connectionId: connectionArg,
  }),
  description:
    'How Meta\'s webhooks are set up for the business, live from Meta. app: the business\'s Meta app\'s webhook '
    + 'subscriptions (object, fields, active, the callback shown by its origin only) — read with the app\'s own token; '
    + 'ad-account: the apps connected to the chosen ad account (events reach an app only when both are set up; isNexusApp '
    + 'marks the business\'s own); page: the apps and fields subscribed on the chosen Facebook Page (Meta answers this only to '
    + 'a Page token: when it refuses, the answer says so); alerts: the ad account\'s alert subscriptions made by this app '
    + '(new objects, a field changing, a number crossing a threshold or reaching a milestone, with their filters; amounts '
    + 'in minor units of the account currency). all (default): each part, one refused part never hiding the others. Never a '
    + 'verify token, secret or token. Read only: subscribing and connecting are set-meta-webhooks (which also removes the app '
    + 'from the Page), alerts set-meta-alert-subscription and remove-meta-alert-subscription — or the Owner sets them up in '
    + 'Meta\'s App Dashboard (Webhooks of the app; callback https://<the API>/webhooks/meta/<app id>); the app is installed on '
    + 'a Page in Meta Business Suite › All Tools › Business Apps, or with the Graph API Explorer and a Page token. This read '
    + 'shows the result either way.',
  async handler(args): Promise<ToolResult> {
    const a = args as Record<string, unknown>
    return guardedMeta(() => liveWebhooks({
      connectionId: typeof a.connectionId === 'string' ? a.connectionId : null, view: (a.view ?? 'all') as WebhookView,
      subscriptionId: typeof a.subscriptionId === 'string' ? a.subscriptionId : null, after: typeof a.after === 'string' ? a.after : null,
    }))
  },
}

export const META_ADS_SAFETY_TOOLS: AgentTool[] = [metaBrandSafety, metaWebhooks]
