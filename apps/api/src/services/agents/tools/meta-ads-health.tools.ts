/**
 * Meta ads step 5 (2026-10-21) — Claude's reads of the chosen Meta ad account's HEALTH and CHANGE HISTORY
 * (marketing/meta-ads/live-health.ts). Read only: nothing here changes Meta, and the gateway lets only GET through.
 *
 *   meta-account-health  summary (no Meta call: the watchdog's Meta check with its details — connection, token, daily
 *                        read, the account's status as last read, problem objects as last read, throttles, API version);
 *                        live: account (status, disable reason in words, failed delivery checks), problems (one sweep:
 *                        step 6's delivery problems, what Meta is still processing, Pages near their ad limit), payment
 *                        (trouble before the ads stop), signals (flagged custom conversions, unavailable pixels), page
 *                        (the chosen Page's integrity: violations, restrictions, Meta's next steps), connection (the token
 *                        now, Meta's usage, the version, throttles in words) — master ACC-021, ACC-034, ACC-042, LG-006,
 *                        LG-007, LG-010, LG-011, LG-013, LG-019, LG-023, EN-062
 *   meta-activity-log    the change history of the account, a campaign (with its ad sets and ads), an ad set or an ad:
 *                        days, Meta's categories, the account's own events, review and policy events, event types, made
 *                        by Nexus or by others, one actor — LG-001, LG-002, LG-004, LG-005
 * Who made a change: Nexus's own system user (and the chosen Page) by name, anyone else by Meta's id (live-health.ts
 * "PEOPLE"). Money: only the details of budget, bid, spending-limit and billing events (metaRaw), for a person who may see
 * ad spend.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolResult } from '../tool-types.js'
import {
  activityLog, ACTIVITY_CATEGORIES, ACTIVITY_EVENT_TYPES, ACTIVITY_MADE_BY, ACTIVITY_SCOPES, ACTIVITY_TOPICS, HEALTH_VIEWS, healthView,
  type ActivityInput, type HealthView,
} from '../../marketing/meta-ads/live-health.js'
import { connectionArg, guarded, lower, metaIdArg } from './meta-ads-read.tools.js'

const ADSPEND = FIELDS.financialsAdspendView
/** meta-activity-log's money key: the details of budget, bid, spending-limit and billing events. */
const META_ACTIVITY_MONEY = { metaRaw: ADSPEND } as const

const upper = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const utcDay = (what: string) => z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(`${what} (YYYY-MM-DD, UTC)`)

const READ_LINE = 'Read only: Meta is never changed here (a change is a set-meta-… tool a person approves). Only the business\'s chosen ad account, its own campaigns, ad sets and ads, and its chosen Page are read; an asset another business in Nexus uses is its id and a flag only.'

// ── meta-account-health ─────────────────────────────────────────────────────────────────────────────────────────────

const metaAccountHealth: AgentTool = {
  name: 'meta-account-health',
  title: 'Meta account health',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  input: z.object({
    view: z.preprocess(lower, z.enum(HEALTH_VIEWS)).default('summary').describe(HEALTH_VIEWS.join(' | ')),
    includePausedByParent: z.boolean().optional().describe('problems: also list ads that do not run because their campaign or ad set is paused'),
    hours: z.number().int().min(1).max(168).optional().describe('connection: the hours of the call ledger read for throttles (default 24, at most 168)'),
    days: z.number().int().min(1).max(90).optional().describe('payment: the days of billing events read for failed charges (default 30, at most 90)'),
    maxRows: z.number().int().min(1).max(500).optional().describe('problems and signals: at most this many rows per list (default 200, at most 500)'),
    connectionId: connectionArg,
  }),
  description:
    'Is the business\'s Meta ad account healthy, and what stops its ads? view summary (default, no Meta call): Nexus\'s own '
    + 'records — the connection and its token (last check, expiry, permissions), the daily read (last success, a token Meta '
    + 'refused), the ad account\'s status and disable reason as the last read saw them, in words with what to do, its failed '
    + 'delivery checks and problem objects as last read, Meta\'s throttles in the last 24 hours and the API version — the same '
    + 'facts platform-health-checks judges daily (check meta-ads). LIVE views: account — status, disable reason and what it '
    + 'means (Meta runs ads only in status 1, 8 and 9), failed delivery checks (reading them runs Meta\'s checks); problems — '
    + 'one sweep of every campaign, ad set and ad that does not deliver, with Meta\'s issues and review feedback, what Meta is '
    + 'still processing, and Pages near their ad limit (like Meta\'s own ads_get_errors, plus the account); payment — payment '
    + 'trouble before the ads stop (an unsettled or grace-period account, no payment method, ads waiting for billing, failed '
    + 'or declined charges); signals — custom conversions Meta flagged and pixels it marks unavailable; page — the chosen '
    + 'Facebook Page\'s integrity (status, violations, restrictions, Meta\'s next steps); connection — the token now, Meta\'s '
    + 'usage of each rate limit, a version warning, and every Meta throttle in the call ledger in words with what Nexus does. '
    + 'Meta cannot fix any of these by API: appeals, Account Quality and payments are in Meta Business Suite and Ads Manager. '
    + READ_LINE,
  async handler(args): Promise<ToolResult> {
    return guarded(() => healthView({
      connectionId: str(args.connectionId),
      view: (args.view ?? 'summary') as HealthView,
      includePausedByParent: args.includePausedByParent === true,
      hours: args.hours as number | undefined,
      days: args.days as number | undefined,
      maxRows: args.maxRows as number | undefined,
    }))
  },
}

// ── meta-activity-log ───────────────────────────────────────────────────────────────────────────────────────────────

const metaActivityLog: AgentTool = {
  name: 'meta-activity-log',
  title: 'Meta change history',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  restrictedFields: META_ACTIVITY_MONEY,
  input: z.object({
    scope: z.preprocess(lower, z.enum(ACTIVITY_SCOPES)).default('account').describe('account (default) | campaign | adset | ad — whose history'),
    id: metaIdArg('campaign, adset, ad: its Meta id (one of the chosen ad account\'s)'),
    from: utcDay('first day (default: 6 days before to)'),
    to: utcDay('last day (default: today)'),
    category: z.preprocess(upper, z.enum(ACTIVITY_CATEGORIES)).optional().describe(`Meta's own category filter: ${ACTIVITY_CATEGORIES.join(', ')}`),
    topic: z.preprocess(lower, z.enum(ACTIVITY_TOPICS)).optional().describe('all (default) | account (status, people, spending limits and their hits) | review (review, appeals, first delivery, learning)'),
    eventTypes: z.array(z.enum(ACTIVITY_EVENT_TYPES)).max(50).optional().describe('only these Meta event types (e.g. update_ad_set_budget, ad_review_declined)'),
    madeBy: z.preprocess(lower, z.enum(ACTIVITY_MADE_BY)).optional().describe('anyone (default) | nexus (Nexus\'s system user or app) | others'),
    actorId: metaIdArg('only the changes of this actor: a Meta id from an earlier answer\'s by.actorId (Meta\'s own filter)'),
    withChildren: z.boolean().optional().describe('campaign: its ad sets\' and ads\' changes too (default true)'),
    maxRows: z.number().int().min(1).max(500).optional().describe('at most this many events (default 100, at most 500)'),
    connectionId: connectionArg,
  }),
  description:
    'The change history of the business\'s Meta ad account ("campaign history" in Ads Manager), read live: scope account '
    + '(default), or one campaign (with its ad sets and ads), ad set or ad of the chosen account (checked to be its own before '
    + 'any read). Each event: when (UTC and the account\'s time zone), what (Meta\'s type and words), on which object, who '
    + '(Nexus\'s own system user or app by name; anyone else by Meta\'s id — meta-account-access view people names the '
    + 'people on the account), and the details Meta gives (old and new status, name, schedule …; budget, bid, spending-limit '
    + 'and billing details only for a person who may see ad spend). Filters: the days (Meta keeps one week by default, Nexus '
    + 'always sends them), Meta\'s category, topic account (status changes, people added or removed, spending limits changed '
    + 'or reached, lifetime budgets spent) or review (approved and rejected ads, audience appeals, first delivery, learning), '
    + 'event types, made by Nexus or others, one actor. whyItStopped explains spending limits reached, budgets spent, ended '
    + 'campaigns, status changes and rejections in words. Meta documents no object filter on the account log (only in its '
    + 'SDK): when Meta refuses it, Nexus reads the account\'s log of those days once and keeps that object\'s events; and as Meta '
    + 'may ignore a filter it does not know, every answer is checked against the days, the actor and the object (filterCheck '
    + 'counts what Meta returned outside them; Meta\'s category cannot be checked from its answer). Billing '
    + 'events with amounts: meta-billing view events. ' + READ_LINE,
  async handler(args): Promise<ToolResult> {
    return guarded(() => activityLog({
      connectionId: str(args.connectionId),
      scope: (args.scope ?? 'account') as ActivityInput['scope'],
      id: str(args.id),
      from: str(args.from),
      to: str(args.to),
      category: str(args.category),
      topic: (args.topic ?? null) as ActivityInput['topic'],
      eventTypes: args.eventTypes as string[] | undefined,
      madeBy: (args.madeBy ?? null) as ActivityInput['madeBy'],
      actorId: str(args.actorId),
      withChildren: typeof args.withChildren === 'boolean' ? args.withChildren : null,
      maxRows: args.maxRows as number | undefined,
    }))
  },
}

export const META_ADS_HEALTH_TOOLS: AgentTool[] = [metaAccountHealth, metaActivityLog]
