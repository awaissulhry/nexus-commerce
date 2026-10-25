/**
 * MCP full control A2 (docs/mcp-full-control/sections/01-ads.md §3, §6 step 2) — Claude's advertising reads.
 *
 *   ads-overview        per market: totals for a window and the window before it, each day (the last 3 provisional),
 *                       the campaigns that spent most, the Amazon Ads connection's posture, the account's automation
 *                       dial and the data pipeline's health
 *   ad-campaigns        the campaigns with their settings, guards and window metrics
 *   ad-targets          the targets (keywords, product and auto targets) with their bids and window metrics
 *   ad-purchased-products  Sponsored Display: what shoppers bought after an ad (another product than the advertised one)
 *   ad-search-terms     the search terms that spent with no order, and the ones that convert (a first look: a converting
 *                       term is harvested through harvest-candidates and apply-harvest, the Keyword Harvest page's engine)
 *   ad-changes          what changed on the account, who changed it, whether it reached Amazon, and its undo handle
 *   ad-recommendations  the engines' recommendations and the rules' pending suggestions; W4-9 — and the autopilot plans'
 *                       waiting decisions (the A.I. Bids tab) and the Keyword Tracker's waiting bid proposals
 *
 * Every read answers from Nexus's own stored data, through the services the Ads pages use (no marketplace call, no
 * gateway, no queue). Each returns the ids the change tools take (Nexus campaign / ad group / target ids, Amazon's
 * campaign and ad group ids, the search term), `dataAsOf` (the newest day of data behind it) and, where it sums a
 * window, `window.provisionalFrom`: Amazon restates the last 3 days for up to 72 hours. Amounts are minor units of
 * the campaign's own currency, named beside them, never converted. Lists page with a cursor (≤ 100 rows a page).
 *
 * Money (spend, sales, bids, budgets, ACoS, the prose that quotes them) sits only under the keys the money filter
 * strips (lib/auth/financial-fields.ts and AD_MONEY below), so a person without `financials.adspend.view` gets the
 * same answer minus exactly those keys. No cursor carries a money value.
 *
 * Automation reads (the full list of rules and engines, their activity) belong to the automation part (R); the
 * overview gives only the account dial and a count per mode.
 *
 * A13 — `ads-overview` and `ad-campaigns` take `channel: amazon | ebay`. eBay reads go through
 * services/marketing/ebay-ads-read.service.ts (the eBay console's own reads, moved out of its routes), and every eBay
 * campaign names its OWN account (EbayCampaign.channelConnectionId), the one a later change must go to.
 *
 * T4 — `ebay-ad-details` opens eBay campaigns as their page does (ebayCampaignDetail): the promoted listings with
 * their ad rate and break-even, the ad groups, and the keywords with bid and metrics, under the ids the eBay change
 * tools take (ebayCampaignId, ebayItemId, ebayAdGroupId, ebayKeywordId).
 *
 * Google Ads step 1a (plan-3 §3.3) — `ads-overview` and `ad-campaigns` also take `channel: google`: the Google Ads
 * account a person chose for the business (`accountId` = its Google connection), read per account, never per market,
 * through services/marketing/google-ads/read.service.ts (the Google Ads tab's own reads). Read only: no Nexus tool
 * changes Google Ads (`writes.mode: none`). A day Nexus has not read has no numbers (never 0); amounts are minor units
 * of the account's currency.
 *
 * Google Ads step 1b (PLAN-1B §8) — `google-ad-details` opens the rest of the Google Ads page with a `view`: ad groups,
 * keywords, negatives, search terms and the brand split, asset groups, products, what Google does on its own, Google's
 * recommendations, the alerts and the disapprovals — each the page's own read service (google-ads/read-detail,
 * read-search-terms, read-acts and alerts services), never a query of its own. Still read only.
 *
 * Meta ads step 44 — `ad-changes` also takes `channel: meta`: the changes Nexus made on Meta, from the Meta change kit's
 * own records (AgentChange of every Meta change tool: what it replaced and wrote, stamped with the Meta ad account), with
 * who decided it, the plan step it ran as, and whether undo-change can still put it back. Changes made outside Nexus (Ads
 * Manager, Meta's own rules, another tool) are Meta's history: meta-activity-log reads it live.
 */

import { adProductOf, isLifetimeBudget, SPONSORED_DISPLAY } from '@nexus/shared/ads-ad-product'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import {
  DEFAULT_PAGE_SIZE,
  InvalidCursorError,
  MAX_CURSOR_LENGTH,
  MAX_PAGE_SIZE,
  cursorScope,
  decodeCursor,
  encodeCursor,
  fitPage,
  pageSize,
  type CursorPosition,
  type SortValue,
} from '../../../lib/pagination/cursor.js'
import { resolveRange } from '../../ads-core/date-range.js'
import { listAmazonCampaigns } from '../../advertising/ads-campaign-list.service.js'
import { reportFreshness } from '../../advertising/ads-report-runner.service.js'
import { reportSummary } from '../../advertising/ads-report-summary.service.js'
import { getAutomationState } from '../../advertising/ads-automation-state.service.js'
import { getEngineLevers } from '../../advertising/ads-control-room.service.js'
import { pipelineHealth } from '../../advertising/ads-pipeline-health.service.js'
import { dataVintageByMarket, type MarketVintage } from '../../advertising/ads-report-settle.service.js'
import { primeSettledWindow } from '../../advertising/ads-settled-facts.js'
import { SD_ATTRIBUTION_NOTE, sdMetricsByLocalId, sdMetricsOf, sdPurchasedProducts, type SdPurchasedLine } from '../../advertising/sd/sd-report-reads.service.js'
import { adsProfileFor } from '../../advertising/ads-profile-resolver.js'
import { getBidGrid, type BidTargetRow } from '../../advertising/bid-grid.service.js'
import { previewHarvest, type HarvestCandidate } from '../../advertising/ads-harvest.service.js'
import { strategyMarket } from '../../advertising/ads-strategy/bids.js'
import { resolveCampaignOwnership } from '../../advertising/brain/ownership.js'
import { candidateIdOf, normTerm } from '../../advertising/harvest/ids.js'
import { bidsNotAtAmazon, listChanges, type ChangeRow, type ChangeSource } from '../../advertising/ads-changes.service.js'
// Imported where it is used: loading the recommendations engine registers rule-action handlers (bid optimiser,
// pacing, top-of-search) — a side effect the tool registry must not have in every process that lists tools.
import type { Recommendation } from '../../advertising/ads-recommendations.service.js'
import { familyOfRow } from '../../advertising/ads-suggestions.service.js'
import {
  adGroupCampaignId,
  adGroupExternalIds,
  adGroupsByExternalId,
  adGroupsOfCampaign,
  pendingRuleSuggestions,
} from '../../advertising/ads-entity-lookup.service.js'
import { campaignCurrency } from './ads-tool-guards.js'
import {
  ebayAdsActions,
  ebayPendingProposals,
  ebayAdsCampaigns,
  ebayAdsSummary,
  ebayAdsTrend,
  ebayCampaignAccounts,
  ebayCampaignCensus,
  ebayCampaignDetail,
  ebayMarketCurrencies,
  ebayPerformanceAsOf,
  type EbayCampaignAccount,
  type EbayCampaignDetail,
} from '../../marketing/ebay-ads-read.service.js'
import { EBAY_MANAGED_STATUSES } from '../../ads-core/campaign-status.js'
// The eBay dashboard (its spend-ceiling check) is imported where it is used: its module graph opens the eBay account
// services, which the tool registry must not load in every process that lists tools.
import { checkMarketingWriteGate } from '../../marketing/marketing-write-gate.js'
import { EBAY_MARKETPLACE_SHORT } from '../../ads-core/ebay-marketplace.js'
import { marketCurrency, marketCurrencyRows } from '../../pim/market-currency.js'
import {
  GoogleAdsReadError,
  googleAdsAccount,
  googleAdsCampaignList,
  googleAdsOverview,
  type GoogleAccount,
  type GoogleAdsMetrics,
} from '../../marketing/google-ads/read.service.js'
import { campaignTypeText } from '../../marketing/google-ads/mappers.js'
import {
  googleAdsAdGroups,
  googleAdsAssetGroups,
  googleAdsDisapprovals,
  googleAdsKeywords,
  googleAdsNegatives,
  googleAdsProducts,
} from '../../marketing/google-ads/read-detail.service.js'
import { googleAdsBrandSplit, googleAdsSearchTerms } from '../../marketing/google-ads/read-search-terms.service.js'
import { googleAdsActsOnItsOwn, googleAdsRecommendations } from '../../marketing/google-ads/read-acts.service.js'
// The alerts service is imported where it is used: it also raises the bell's notifications, whose module graph the tool
// registry must not load in every process that lists tools.
import type { googleAdsAlerts } from '../../marketing/google-ads/alerts.service.js'
import { sdExpressionInWords, sdTacticInWords } from '../../advertising/sd/sd-expression-words.js'
import { NO_APPROVAL_VIA, type AgentTool, type ToolResult } from '../tool-types.js'

const ADSPEND = FIELDS.financialsAdspendView

/**
 * Money keys of these tools' output that the shared registry does not name (it already names spendCents, salesCents,
 * acos, roas, bidCents, suppressedFromBidCents, budgetCents and — Google Ads step 1a — conversionValueCents,
 * avgCpcCents, costPerConversionCents, …). Prose that quotes amounts (`detail`, `why`, `note`,
 * `deliveryError`, `evidence`) is money too: it is stripped whole rather than half-read.
 */
const AD_MONEY = {
  dailyBudgetCents: ADSPEND,
  minBidCents: ADSPEND,
  maxBidCents: ADSPEND,
  minBudgetCents: ADSPEND,
  maxBudgetCents: ADSPEND,
  budgetBaselineCents: ADSPEND,
  // D11 — a campaign's CPC ceiling (a multiple of each target's average cost per click) caps its bids: money.
  cpcCeiling: ADSPEND,
  targetAcos: ADSPEND,
  placementsPct: ADSPEND,
  placementPct: ADSPEND,
  cpcCents: ADSPEND,
  effectiveMaxCpcCents: ADSPEND,
  impactCents: ADSPEND,
  // W4-9 — a Keyword Tracker proposal's bid times its targets.
  commitmentCents: ADSPEND,
  proposedBidCents: ADSPEND,
  // Honest writes — the bid Amazon still has while Nexus's copy waits to be sent or failed (ad-targets bidNotAtAmazon).
  amazonBidCents: ADSPEND,
  proposedBudgetCents: ADSPEND,
  proposedChange: ADSPEND,
  fromAmount: ADSPEND,
  toAmount: ADSPEND,
  detail: ADSPEND,
  why: ADSPEND,
  note: ADSPEND,
  evidence: ADSPEND,
  deliveryError: ADSPEND,
  // eBay pacing (A13): spend against the monthly ceilings and yesterday's CPC fees against the budgets.
  monthToDateCents: ADSPEND,
  capCents: ADSPEND,
  usedPct: ADSPEND,
  projectedCents: ADSPEND,
  yesterdayFeesCents: ADSPEND,
  utilizationPct: ADSPEND,
  // eBay listings whose ad rate is above break-even, quoted with both rates.
  rateSamples: ADSPEND,
  // eBay change log and proposals: what a write replaced and wrote (rates, budgets), a proposal's estimate.
  replaced: ADSPEND,
  wrote: ADSPEND,
  estimatedImpact: ADSPEND,
  // BB-13 — how much more the settled copy of a day sold than its first copy: a ratio of ad sales.
  salesGapPct: ADSPEND,
} as const

/** Amazon restates the last 3 days of a report for up to 72 hours. */
const PROVISIONAL_DAYS = 3
const PROVISIONAL_NOTE = 'Amazon restates the last 3 days for up to 72 hours: figures on or after provisionalFrom may still change.'
const MAX_DAYS = 90
/** The most campaigns the Amazon list service returns in one read (ads-campaign-list.service.ts). */
const CAMPAIGN_READ_CAP = 500
const TOP_CAMPAIGNS = 5

const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const lower = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : value)
const iso = (at: Date | string | null | undefined) => (at == null ? null : at instanceof Date ? at.toISOString() : String(at))
const day = (at: Date | null | undefined) => (at ? at.toISOString().slice(0, 10) : null)
const num = (value: unknown): number => {
  const n = Number(typeof value === 'object' && value !== null ? String(value) : value)
  return Number.isFinite(n) ? n : 0
}
/** A Decimal / string / number of currency units, as minor units; null stays null. */
const unitsToMinor = (value: unknown): number | null => (value == null ? null : Math.round(num(value) * 100))
const ratio = (top: number, bottom: number) => (bottom > 0 ? top / bottom : null)

function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** A window of `days` complete days ending yesterday (Rome), as the Ads pages resolve it (AM-16), with the provisional tail named. */
function windowOf(days: number) {
  const range = resolveRange({ windowDays: days })
  return {
    range,
    window: {
      from: range.sinceStr,
      to: range.untilStr,
      days: range.days,
      provisionalFrom: addDays(range.untilStr, -(PROVISIONAL_DAYS - 1)),
      note: PROVISIONAL_NOTE,
    },
  }
}

// ── Arguments ──────────────────────────────────────────────────────────────────────────────────────

const daysArg = (fallback: number, what: string) =>
  z.coerce.number().int().min(1).max(MAX_DAYS).default(fallback)
    .describe(`${what}: the last N complete days, ending yesterday — today has no daily report yet (default ${fallback}, max ${MAX_DAYS})`)
const marketArg = z.string().trim().toUpperCase().min(2).max(20).optional()
  .describe('only this marketplace: an Amazon code (IT, DE, FR, ES, UK); for eBay EBAY_IT, EBAY_DE, EBAY_FR, EBAY_ES, EBAY_GB or the short code')
const campaignArg = z.string().trim().min(1).max(64).optional()
  .describe('only this campaign: its Nexus id (campaignId in ad-campaigns)')
const CHANNELS = ['amazon', 'ebay'] as const
type AdChannel = (typeof CHANNELS)[number]
const channelArg = z.preprocess(lower, z.enum(CHANNELS)).default('amazon')
  .describe('amazon (default) or ebay (Promoted Listings)')
/** Meta ads step 44 — ad-changes also lists the changes Nexus made on Meta (the kit's records); the other reads stay as they are. */
const CHANGE_CHANNELS = ['amazon', 'ebay', 'meta'] as const
const changeChannelArg = z.preprocess(lower, z.enum(CHANGE_CHANNELS)).default('amazon')
  .describe('amazon (default), ebay (Promoted Listings) or meta (the changes Nexus made on Meta)')
/** Google Ads step 1a — the reads that also take google (ads-overview, ad-campaigns); the others stay amazon | ebay. */
const READ_CHANNELS = ['amazon', 'ebay', 'google'] as const
type ReadChannel = (typeof READ_CHANNELS)[number]
const readChannelArg = z.preprocess(lower, z.enum(READ_CHANNELS)).default('amazon')
  .describe('amazon (default), ebay (Promoted Listings) or google (Google Ads)')
const googleAccountArg = z.string().trim().min(1).max(64).optional()
  .describe('Google only: the Google account to read, by its connectionId (channel-connections); default the business\'s chosen Google Ads account')
const limitArg = z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional()
  .describe(`rows per page (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE})`)
const cursorArg = z.string().min(1).max(MAX_CURSOR_LENGTH).optional()
  .describe('nextCursor from the previous page, with the same filters; omit it for the first page')

const PAGING = ' Returns { items, nextCursor, total }; a page can hold fewer rows than limit to stay within a size limit: follow nextCursor for the rest.'
const MONEY_WORDS = ' Amounts are minor units (cents) of each campaign\'s own currency, named beside them and never converted;'
  + ' a person without the ad-spend money permission gets the same answer without the amounts.'

// ── Paging helpers ─────────────────────────────────────────────────────────────────────────────────

/** A cursor belongs to one tool, one business and one set of filters (the page size may change between pages). */
function scopeOf(tool: string, args: Record<string, unknown>): string {
  const { limit: _limit, cursor: _cursor, ...filters } = args
  return cursorScope(tool, { business: workspaceIdForQuery(), ...filters })
}

/** A bad cursor is a wrongly made call, said the way call-tool.ts says one; anything else is a real failure. */
async function listTool(name: string, work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof InvalidCursorError) return { ok: false, error: `${name} was called wrongly — cursor: ${error.message}` }
    throw error
  }
}

function compareValues(a: SortValue[], b: SortValue[], desc: readonly boolean[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? null
    const y = b[i] ?? null
    if (x === y) continue
    // null sorts last in either direction
    if (x === null) return 1
    if (y === null) return -1
    const order = x < y ? -1 : 1
    return desc[i] ? -order : order
  }
  return 0
}

/**
 * A keyset page over rows read whole (a service answers the full list): sorted by the position's values (none of them
 * money) and then the id, strictly after the cursor's row. No row comes twice and none is skipped.
 */
function keysetPage<T>(rows: T[], positionOf: (row: T) => CursorPosition, size: number, scope: string, cursor: string | undefined, desc: readonly boolean[] = []) {
  const keyed = rows.map((row) => ({ row, at: positionOf(row) }))
  const compare = (a: CursorPosition, b: CursorPosition) => compareValues(a.values, b.values, desc) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  keyed.sort((a, b) => compare(a.at, b.at))
  const start = decodeCursor(scope, cursor)
  const rest = start ? keyed.filter((k) => compare(k.at, start) > 0) : keyed
  const items = rest.slice(0, size).map((k) => k.row)
  const last = items.at(-1)
  const page = { items, nextCursor: rest.length > size && last !== undefined ? encodeCursor(scope, positionOf(last)) : null, total: rows.length }
  return { ...fitPage(page, scope, positionOf), total: rows.length }
}

/** A short, fixed-length id for a row whose natural key is long text (a search term, a recommendation). */
const shortId = (key: string) => createHash('sha256').update(key).digest('base64url').slice(0, 22)

/**
 * A page of a RANKED list the service computes live (by money, which no cursor may carry): the cursor names the last
 * row's id and its place. The next page starts right after that row in the freshly computed list, or at its old place
 * when it is gone. A row that moves in the ranking between two pages may come twice or not at all.
 */
function rankedPage<T>(rows: T[], idOf: (row: T) => string, size: number, scope: string, cursor: string | undefined) {
  const at = decodeCursor(scope, cursor)
  let start = 0
  if (at) {
    const found = rows.findIndex((row) => idOf(row) === at.id)
    const place = typeof at.values[0] === 'number' ? at.values[0] : -1
    start = found >= 0 ? found + 1 : Math.min(Math.max(place + 1, 0), rows.length)
  }
  const indexed = rows.map((row, index) => ({ row, index }))
  const slice = indexed.slice(start, start + size + 1)
  const items = slice.slice(0, size)
  const positionOf = (item: { row: T; index: number }): CursorPosition => ({ values: [item.index], id: idOf(item.row) })
  const last = items.at(-1)
  const page = { items, nextCursor: slice.length > size && last ? encodeCursor(scope, positionOf(last)) : null }
  const fitted = fitPage(page, scope, positionOf)
  return { items: fitted.items.map((item) => item.row), nextCursor: fitted.nextCursor, cut: fitted.cut, total: rows.length }
}

function moreHint(shown: number, total: number | null, cut: number, narrowBy: string): string {
  const count = total == null ? 'More rows may match' : `${total} rows match`
  const trimmed = cut ? ` (cut from ${shown + cut} to stay within the size limit)` : ''
  return `${count}; this page has ${shown}${trimmed}. To narrow, add ${narrowBy}; to go on, call again with cursor set to nextCursor.`
}

// ── Campaign lookups ───────────────────────────────────────────────────────────────────────────────

const CAMPAIGN_SELECT = {
  id: true,
  name: true,
  marketplace: true,
  externalCampaignId: true,
  dailyBudgetCurrency: true,
  status: true,
  // W4-11 — which ad product a target's campaign is (Nexus also sends SB/SD keyword and target bids).
  adProduct: true,
  type: true,
} as const

type CampaignRef = { id: string; name: string; marketplace: string | null; externalCampaignId: string | null; dailyBudgetCurrency: string; status: string; adProduct: string | null; type: unknown }

/** The campaign a scope names, in this business (row-level security), or null: another business's id is not found. */
async function campaignById(id: string): Promise<CampaignRef | null> {
  return prisma.campaign.findFirst({ where: { id }, select: CAMPAIGN_SELECT }) as Promise<CampaignRef | null>
}

/** Campaigns by Nexus id and by Amazon id, in one read. */
async function campaignIndex(ids: string[], externalIds: string[]) {
  const wanted = [...new Set(ids.filter(Boolean))]
  const external = [...new Set(externalIds.filter(Boolean))]
  const rows = wanted.length || external.length
    ? await prisma.campaign.findMany({
        where: { OR: [...(wanted.length ? [{ id: { in: wanted } }] : []), ...(external.length ? [{ externalCampaignId: { in: external } }] : [])] },
        select: CAMPAIGN_SELECT,
      }) as CampaignRef[]
    : []
  return {
    byId: new Map(rows.map((c) => [c.id, c])),
    byExternal: new Map(rows.filter((c) => c.externalCampaignId).map((c) => [c.externalCampaignId as string, c])),
  }
}

const campaignOut = (c: CampaignRef | undefined | null) =>
  c
    ? { campaignId: c.id, externalCampaignId: c.externalCampaignId, campaignName: c.name, market: c.marketplace, currency: campaignCurrency(c) }
    : { campaignId: null, externalCampaignId: null, campaignName: null, market: null, currency: null }

/** The newest day of campaign performance, per market and overall (the report pipeline's own freshness read). */
async function performanceAsOf(markets: string[] = []) {
  const fresh = await reportFreshness({ reportId: 'campaign', marketplaces: markets })
  return { lastDay: fresh.lastDay, byMarket: new Map(fresh.byMarket.map((m) => [m.marketplace, m.lastDay])) }
}

// ── ads-overview ───────────────────────────────────────────────────────────────────────────────────

const OVERVIEW_METRICS = ['impressions', 'clicks', 'orders', 'cost', 'sales', 'acos', 'roas']

interface Totals { impressions: number; clicks: number; orders: number; spendCents: number; salesCents: number; acos: number | null; roas: number | null }

function totalsOf(read: (id: string) => number | null): Totals {
  const spendCents = Math.round((read('cost') ?? 0) * 100)
  const salesCents = Math.round((read('sales') ?? 0) * 100)
  return {
    impressions: read('impressions') ?? 0,
    clicks: read('clicks') ?? 0,
    orders: read('orders') ?? 0,
    spendCents,
    salesCents,
    acos: ratio(spendCents, salesCents),
    roas: ratio(salesCents, spendCents),
  }
}

/**
 * Count of levers per mode, the engines on Auto, and every engine in one of the plain groups the Control Room shows.
 * The full list is `automations` (R).
 *
 * 7a (review 8.2) — `writingOnTheirOwn` named every engine on Auto, the breaker and write delivery included, and
 * engines with nothing set up. It now names only the engines that change Amazon on their own; `enginesOnAuto` keeps
 * the old list, and `engineGroups` places every engine, so none drops out of sight.
 */
function automationSummary(state: Awaited<ReturnType<typeof getAutomationState>>, levers: Awaited<ReturnType<typeof getEngineLevers>>) {
  const byMode: Record<string, number> = { AUTO: 0, PROPOSE: 0, OBSERVE: 0, OFF: 0 }
  for (const lever of levers.levers) byMode[lever.mode] = (byMode[lever.mode] ?? 0) + 1
  const ACTIVITY: Record<string, string> = { 'never-ran': 'has never run', idle: 'ran and changed nothing in 7 days', acted: 'changed something in 7 days' }
  const inGroup = (group: string) => levers.levers.filter((lever) => lever.exposure.group === group).map((lever) => ({
    name: lever.name,
    mode: lever.mode,
    why: lever.modeReason,
    ...(lever.exposure.start ? { start: lever.exposure.start } : {}),
    lastWeek: `${ACTIVITY[lever.activity]} (${lever.writes7d} changes, ${lever.runs7d} runs)`,
  }))
  return {
    autonomy: state.autonomy,
    halted: state.halted,
    haltedAt: state.haltedAt,
    haltReason: state.haltReason,
    effectivelyStopped: state.effectivelyStopped,
    degraded: state.degraded,
    engines: byMode,
    enginesOnAuto: levers.levers.filter((lever) => lever.mode === 'AUTO').map((lever) => lever.name),
    writingOnTheirOwn: levers.levers.filter((lever) => lever.exposure.group === 'acts').map((lever) => lever.name),
    engineGroups: {
      changesAmazonOnItsOwn: inGroup('acts'),
      readyNothingSetUp: inGroup('ready'),
      offByServerSwitch: inGroup('server-off'),
      heldBackInNexus: inGroup('held'),
      neverChangesAmazonByItself: inGroup('never'),
      ...(levers.levers.some((lever) => lever.exposure.group === 'unknown') ? { couldNotBeRead: inGroup('unknown') } : {}),
    },
    warnings: levers.levers.filter((lever) => lever.warning).map((lever) => `${lever.name}: ${lever.warning}`).slice(0, 10),
  }
}

/** BB-13 — a market's settled days and the first-copy gap, in the words ads-overview gives. */
function vintageOf(v: MarketVintage | undefined) {
  if (!v) return null
  const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`
  const why = 'Amazon adds a click\'s purchase to its day for 7 days, 14 for Brands and Display'
  const notReread = v.unsettled.notReread
    ? ` ${days(v.unsettled.notReread)} of this window before it ${v.unsettled.notReread === 1 ? 'has' : 'have'} no settled copy yet: still being re-read (the first re-read takes 2-3 nights), or older than the 60 days the re-read reaches.`
    : ''
  return {
    settledThrough: v.settledThrough,
    stillFillingFrom: v.stillFillingFrom,
    unsettledDays: v.unsettled,
    note: v.settledThrough
      ? `The newest settled day is ${v.settledThrough}; ${days(v.unsettled.stillFilling)} of this window after it ${v.unsettled.stillFilling === 1 ? 'is' : 'are'} still filling (${why}).${notReread}`
      : `No day holds a settled copy yet: every day of this window may still gain sales (${why}).`,
    gap: v.measured
      ? {
          days: v.measured.days,
          campaignDays: v.measured.campaignDays,
          firstCopy: v.measured.firstCopy,
          settled: v.measured.settled,
          salesGapPct: v.measured.salesGapPct,
          ordersGapPct: v.measured.ordersGapPct,
          meaning: 'Over the window\'s settled campaign days: what Nexus first stored (asked the next morning) against the settled copy. A positive gap is sales and orders that arrived late.',
        }
      : null,
  }
}

/** W4-1 — also the figures of report-ads-run (ads-manager.tools.ts): a report states the numbers this read states. */
export async function amazonOverview(args: { market?: string; days: number }) {
  const { range, window } = windowOf(args.days)
  const campaigns = await prisma.campaign.findMany({
    where: args.market ? { marketplace: args.market } : {},
    select: { id: true, marketplace: true, status: true, liveBidWritesEnabled: true, bidsSuppressedAt: true, dailyBudgetCurrency: true },
  })
  const markets = [...new Set(campaigns.map((c) => c.marketplace).filter((m): m is string => !!m))].sort()
  const unplaced = campaigns.filter((c) => !c.marketplace).length

  const [fresh, list, state, levers, health, vintage] = await Promise.all([
    performanceAsOf(markets),
    markets.length ? listAmazonCampaigns({ windowDays: String(args.days), limit: String(CAMPAIGN_READ_CAP), ...(args.market ? { marketplace: args.market } : {}) }) : Promise.resolve({ items: [] as never[] }),
    getAutomationState(),
    getEngineLevers(),
    pipelineHealth(),
    dataVintageByMarket(markets, range.sinceStr, range.untilStr),
  ])

  const perMarket = await Promise.all(markets.map(async (market) => {
    const mine = campaigns.filter((c) => c.marketplace === market)
    const [summary, profile] = await Promise.all([
      reportSummary({ reportId: 'campaign', marketplaces: [market], from: range.sinceStr, to: range.untilStr, compare: 'previous', metrics: OVERVIEW_METRICS }),
      adsProfileFor(market).catch(() => null),
    ])
    const metric = (period: 'current' | 'previous') => (id: string) => summary.metrics.find((m) => m.id === id)?.[period] ?? null
    const top = (list.items as Array<Record<string, unknown>>)
      .filter((c) => c.marketplace === market && (num(c.spend) > 0 || num(c.clicks) > 0))
      .sort((a, b) => num(b.spend) - num(a.spend) || String(a.name).localeCompare(String(b.name)))
      .slice(0, TOP_CAMPAIGNS)
      .map((c) => {
        const spendCents = Math.round(num(c.spend) * 100)
        const salesCents = Math.round(num(c.sales) * 100)
        return {
          campaignId: c.id as string,
          externalCampaignId: (c.externalCampaignId as string | null) ?? null,
          name: c.name as string,
          status: String(c.status),
          clicks: num(c.clicks),
          spendCents,
          salesCents,
          acos: ratio(spendCents, salesCents),
        }
      })
    const currencies = [...new Set(mine.map((c) => campaignCurrency(c)))]
    return {
      market,
      currency: currencies.length === 1 ? currencies[0] : null,
      ...(currencies.length > 1 ? { currencies, currencyNote: 'Campaigns in this market are in more than one currency: the totals add them as stored.' } : {}),
      dataAsOf: fresh.byMarket.get(market) ?? null,
      connection: profile
        ? { profileId: profile.profileId, mode: profile.mode, writesEnabled: profile.writesEnabledAt != null, writesEnabledAt: iso(profile.writesEnabledAt), lastWriteAt: iso(profile.lastWriteAt) }
        : null,
      campaigns: {
        total: mine.length,
        enabled: mine.filter((c) => String(c.status) === 'ENABLED').length,
        liveWritesAllowed: mine.filter((c) => c.liveBidWritesEnabled).length,
        bidsSuppressed: mine.filter((c) => c.bidsSuppressedAt != null).length,
      },
      totals: totalsOf(metric('current')),
      previous: { from: summary.comparisonWindow?.from ?? null, to: summary.comparisonWindow?.to ?? null, ...totalsOf(metric('previous')) },
      days: summary.series.map((point) => {
        const date = String(point.bucket)
        const read = (id: string) => (typeof point[id] === 'number' ? (point[id] as number) : null)
        const t = totalsOf(read)
        return { date, provisional: date >= window.provisionalFrom, impressions: t.impressions, clicks: t.clicks, orders: t.orders, spendCents: t.spendCents, salesCents: t.salesCents }
      }),
      topCampaigns: top,
      dataVintage: vintageOf(vintage.get(market)),
    }
  }))

  return {
    channel: 'amazon' as const,
    dataAsOf: fresh.lastDay,
    window,
    markets: perMarket,
    ...(unplaced ? { campaignsWithoutMarket: unplaced } : {}),
    ...(markets.length === 0 ? { empty: args.market ? `No Amazon campaign in market ${args.market}.` : 'No Amazon campaign in this business.' } : {}),
    automation: { ...automationSummary(state, levers), fullList: 'the automations tool lists every rule and engine' },
    pipeline: {
      feeds: health.feeds.map((f) => ({ id: f.id, label: f.label, status: f.status, lastDataDay: f.lastDataDay, lagDays: f.lagDays, lastRunOk: f.lastRunOk, recentFailures: f.recentFailures })),
      alerts: health.alerts,
      contradictions: health.contradictions.map((c) => ({ kind: c.kind, market: c.marketplace, date: c.date, severity: c.severity })),
    },
  }
}

// ── Google Ads (step 1a: these tools read what Nexus stored) ─────────────────────────────────────

/** 2026-10-15 — Google Ads changes go through the Google Ads change tools, each a request a person approves in Nexus. */
const GOOGLE_WRITES = {
  mode: 'approval',
  note: 'Google Ads changes go through the Nexus Google Ads change tools (set-google-…): each is a request a person approves in Nexus. google-ads-live reads the account live.',
} as const
const GOOGLE_PROVISIONAL_NOTE = 'Google can still add late conversions to the last 14 days (Nexus re-reads them every day): figures on or after provisionalFrom may still change.'
const GOOGLE_COUNTING = 'Cost, conversions and conversion value as Google counts them (its attribution and conversion actions; days in the '
  + 'account\'s time zone). Conversions can be fractional. Google Ads has no sales, orders or ACoS: never name them for it.'
const GOOGLE_STATUSES: readonly string[] = ['ENABLED', 'PAUSED', 'REMOVED']
const GOOGLE_OVERVIEW_WORDS = ' Google (channel google): the Google Ads account a person chose for this business (accountId: its '
  + 'connectionId from channel-connections, only when there is more than one): impressions, clicks, cost (as spendCents), conversions, '
  + 'conversion value and ROAS as Google counts them, for the window and for the window before (previous: only when Nexus read every '
  + 'day of both windows, else null: never work out a change from totals that leave days out), each day (a day Nexus has not read has read false and no numbers, never 0; the last 14 days provisional), the '
  + 'campaigns that cost most, the account\'s state in words, and coverage.missingDays. Read per account, never per market. dataAsOf '
  + 'is when Nexus last read the account from Google. Changes go through the Google Ads change tools (set-google-…), each a request '
  + 'a person approves in Nexus (writes.mode approval); google-ads-live reads the account live from Google.'
const GOOGLE_CAMPAIGN_WORDS = ' Google (channel google): per campaign its Nexus and Google ids, account, status (ENABLED, '
  + 'PAUSED, REMOVED; null when Nexus has its numbers but has not read its settings yet) and serving status, type (Search, Shopping, Performance Max, …), bidding strategy, daily budget (budgetShared), '
  + 'currency, and impressions, clicks, conversions, cost (as spendCents), conversion value and ROAS over the window (metrics null '
  + 'when Nexus read no day of it); writes.mode approval: changes go through the Google Ads change tools (set-google-…), each a '
  + 'request a person approves in Nexus.'

interface GoogleArgs { channel: ReadChannel; market?: string; accountId?: string; status?: string }

/** Why these arguments cannot be read, or null when they can. */
function googleArgsRefusal(a: GoogleArgs): string | null {
  if (a.channel !== 'google') {
    if (a.accountId) return 'accountId names a Google account: use it with channel google (Amazon and eBay are read per market).'
    if (a.status === 'REMOVED') return 'REMOVED is a Google campaign status: use it with channel google.'
    return null
  }
  if (a.market) return 'Google Ads is read per account, not per market: leave market out.'
  if (a.status && !GOOGLE_STATUSES.includes(a.status)) return 'Google campaign statuses are ENABLED, PAUSED and REMOVED.'
  return null
}

/** A Google read; an account the business does not hold reads as not found. */
async function googleRead(work: () => Promise<Record<string, unknown>>): Promise<ToolResult> {
  try {
    return { ok: true, data: await work() }
  } catch (error) {
    if (error instanceof GoogleAdsReadError) return { ok: false, error: error.message }
    throw error
  }
}

const googleAccountOut = (account: GoogleAccount) => ({
  accountId: account.connectionId,
  name: account.ads?.name ?? account.label,
  state: account.state,
  stateText: account.stateText,
  googleAdsAccount: account.ads
    ? { customerId: account.ads.customerId, currency: account.ads.currency, timeZone: account.ads.timeZone, testAccount: account.ads.isTest }
    : null,
  lastReadAt: account.read.lastReadAt,
  newestDay: account.read.lastDataDay,
  nextReadAt: account.read.nextReadAt,
  lastError: account.read.lastError,
})

/** Why a Google answer holds no numbers, in words; null when it holds some. */
function googleEmpty(account: GoogleAccount | null, daysRead: number): string | null {
  if (!account) return 'Google is not connected for this business: a person connects Google in Nexus (Settings › Channels › Google) and chooses the Google Ads account Nexus reads.'
  if (!account.ads) return 'No Google Ads account is chosen for this business yet: a person chooses one in Nexus (Settings › Channels › Google).'
  if (daysRead === 0) return `Nexus has no Google Ads numbers for this window yet. ${account.stateText}`.trim()
  return null
}

const googleMetricsOut = (m: GoogleAdsMetrics) => ({
  impressions: m.impressions,
  clicks: m.clicks,
  conversions: m.conversions,
  spendCents: m.spendCents,
  conversionValueCents: m.conversionValueCents,
  roas: m.roas,
})

async function googleOverview(a: GoogleArgs & { days: number }) {
  const o = await googleAdsOverview({ connectionId: a.accountId, days: a.days })
  const list = o.account?.ads ? await googleAdsCampaignList({ connectionId: o.account.connectionId, from: o.window.from, to: o.window.to }) : null
  const campaigns = list?.items ?? []
  const byStatus: Record<string, number> = {}
  for (const c of campaigns) {
    // A campaign Nexus has numbers for but whose settings it has not read yet has no status (never a guessed one).
    const key = c.status ?? 'NOT_READ_YET'
    byStatus[key] = (byStatus[key] ?? 0) + 1
  }
  const topCampaigns = campaigns
    .filter((c) => c.metrics && (c.metrics.spendCents > 0 || c.metrics.clicks > 0))
    .sort((x, y) => y.metrics!.spendCents - x.metrics!.spendCents || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
    .slice(0, TOP_CAMPAIGNS)
    .map((c) => ({ campaignId: c.campaignId, externalCampaignId: c.externalCampaignId, name: c.name, status: c.status, type: c.type, ...googleMetricsOut(c.metrics!) }))
  const empty = googleEmpty(o.account, o.coverage.daysRead)
  return {
    channel: 'google' as const,
    writes: GOOGLE_WRITES,
    account: o.account ? googleAccountOut(o.account) : null,
    accounts: o.accounts.map(googleAccountOut),
    currency: o.currency,
    timeZone: o.timeZone,
    dataAsOf: o.dataAsOf,
    window: { from: o.window.from, to: o.window.to, days: o.coverage.daysInWindow, provisionalFrom: o.window.provisionalFrom, note: GOOGLE_PROVISIONAL_NOTE },
    coverage: o.coverage,
    counting: GOOGLE_COUNTING,
    totals: o.totals,
    previous: o.previous,
    days: o.days,
    campaigns: { total: campaigns.length, byStatus },
    topCampaigns,
    ...(empty ? { empty } : {}),
  }
}

async function googleCampaigns(a: CampaignListArgs, scope: string) {
  const size = pageSize(a.limit)
  const list = await googleAdsCampaignList({ connectionId: a.accountId, days: a.days, status: a.status, search: a.search })
  const positionOf = (c: (typeof list.items)[number]): CursorPosition => ({ values: [c.name], id: c.campaignId })
  const page = keysetPage(list.items, positionOf, size, scope, a.cursor)
  const account = list.context.account
  const owner = account ? { accountId: account.connectionId, name: account.ads?.name ?? account.label } : null
  const items = page.items.map((c) => ({
    campaignId: c.campaignId,
    externalCampaignId: c.externalCampaignId,
    name: c.name,
    account: owner,
    status: c.status,
    servingStatus: c.servingStatus,
    primaryStatus: c.primaryStatus,
    type: c.type,
    typeText: campaignTypeText(c.type),
    biddingStrategy: c.biddingStrategy,
    currency: list.context.currency,
    dailyBudgetCents: c.dailyBudgetCents,
    budgetShared: c.budgetShared,
    startDate: c.startDate,
    endDate: c.endDate,
    metrics: c.metrics ? googleMetricsOut(c.metrics) : null,
    // Never a time Nexus did not read this campaign's settings (null: seen only in the numbers, settings never read).
    settingsSyncedAt: c.settingsReadAt,
  }))
  const empty = googleEmpty(account, list.coverage.daysRead)
    ?? (list.items.length === 0 ? (a.status || a.search ? 'No Google Ads campaign matches these filters.' : 'No Google Ads campaign in this account.') : null)
  return {
    channel: 'google' as const,
    writes: GOOGLE_WRITES,
    account: account ? googleAccountOut(account) : null,
    currency: list.context.currency,
    dataAsOf: list.context.customer?.lastSuccessAt?.toISOString() ?? null,
    window: { from: list.window.from, to: list.window.to, days: list.coverage.daysInWindow, provisionalFrom: list.window.provisionalFrom, note: GOOGLE_PROVISIONAL_NOTE },
    coverage: list.coverage,
    counting: GOOGLE_COUNTING,
    items,
    nextCursor: page.nextCursor,
    total: list.items.length,
    ...(page.nextCursor ? { more: moreHint(items.length, list.items.length, page.cut, 'status or search') } : {}),
    ...(empty ? { empty } : {}),
  }
}

const adsOverview: AgentTool = {
  name: 'ads-overview',
  title: 'Advertising overview',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  restrictedFields: AD_MONEY,
  input: z.object({
    channel: readChannelArg,
    market: marketArg,
    accountId: googleAccountArg,
    days: daysArg(7, 'the window'),
  }),
  description:
    'Advertising at a glance, per marketplace. Amazon (the default): impressions, clicks, orders, spend, sales, ACoS and ROAS for the '
    + 'window and for the window before it, each day (the last 3 days marked provisional: Amazon restates them for up '
    + 'to 72 hours), the 5 campaigns that spent most (with their ids), how many campaigns are enabled, allowed live '
    + 'writes or have suppressed bids, and the Amazon Ads connection (production or sandbox, writes enabled). Also the '
    + 'account\'s automation dial (autonomy, halted) with a count of engines per mode, the engines that change Amazon on '
    + 'their own (writingOnTheirOwn; enginesOnAuto lists every engine on Auto, whether or not it writes), every engine in '
    + 'a plain group (engineGroups: changes Amazon on its own, ready with nothing set up, off by a server switch, held back '
    + 'in Nexus, never changes Amazon by itself) with why and what it did in 7 days, and the health of the data '
    + 'feeds (late, failing, contradictions). dataAsOf is the newest day of performance data. dataVintage per market: '
    + 'the newest day holding Amazon\'s settled numbers (later days still gain late sales) and, over the window, the ad '
    + 'sales and orders Nexus first stored against the settled copy (gap).' + MONEY_WORDS
    + ' Each market\'s totals are in that market\'s currency; markets are never added together.'
    + ' eBay (channel ebay): per marketplace the ad fees (as spend), sales and sold units for the window and the one '
    + 'before, each day, the campaigns that cost most with their account, the eBay accounts in use, campaign counts, '
    + 'and for the business: listing coverage, the eligibility findings (unmatched, missing costs, unpromoted, '
    + 'campaigns without a rule, rates above break-even), pacing against the monthly ceilings, and whether eBay ad '
    + 'writes are live or sandbox.'
    + GOOGLE_OVERVIEW_WORDS,
  handler: async (args) => {
    const a = args as { channel: ReadChannel; market?: string; accountId?: string; days: number }
    const refused = googleArgsRefusal(a)
    if (refused) return { ok: false, error: refused }
    if (a.channel === 'google') return googleRead(() => googleOverview(a))
    await primeSettledWindow() // BB-14 — the settled window the scheduler's decisions read
    return { ok: true, data: a.channel === 'ebay' ? await ebayOverview(a) : await amazonOverview(a) }
  },
}

// ── ad-campaigns ───────────────────────────────────────────────────────────────────────────────────

const CAMPAIGN_STATUSES = ['ENABLED', 'PAUSED', 'ARCHIVED', 'DRAFT', 'RUNNING', 'SYSTEM_PAUSED', 'ENDED', 'SUSPENDED', 'SCHEDULED', 'REMOVED'] as const

interface CampaignListArgs { channel: ReadChannel; market?: string; accountId?: string; status?: string; search?: string; days: number; limit?: number; cursor?: string }

async function amazonCampaigns(a: CampaignListArgs, scope: string) {
  const size = pageSize(a.limit)
  const { window } = windowOf(a.days)
  const list = await listAmazonCampaigns({
    windowDays: String(a.days),
    limit: String(CAMPAIGN_READ_CAP),
    ...(a.market ? { marketplace: a.market } : {}),
    ...(a.status ? { status: a.status } : {}),
    ...(a.search ? { search: a.search } : {}),
  })
  const rows = list.items as Array<Record<string, any>>
  const positionOf = (c: Record<string, any>): CursorPosition => ({ values: [String(c.marketplace ?? ''), String(c.name ?? '')], id: String(c.id) })
  const page = keysetPage(rows, positionOf, size, scope, a.cursor)
  const ids = page.items.map((c) => String(c.id))
  // D11 — the portfolio by Amazon's id (Campaign.portfolioId), named as Amazon names it.
  const portfolioIds = [...new Set(page.items.map((c) => c.portfolioId).filter((p): p is string => typeof p === 'string' && p !== ''))]
  const [extra, fresh, portfolios] = await Promise.all([
    ids.length
      ? prisma.campaign.findMany({
          where: { id: { in: ids } },
          select: {
            id: true, dailyBudgetCurrency: true, liveBidWritesEnabled: true, bidsSuppressedAt: true, bidsSuppressedBy: true,
            pinBids: true, pinBudget: true, pinPlacement: true, targetingType: true, dynamicBidding: true, budgetBaselineCents: true,
            costType: true, budgetJson: true, // W4-11
            tactic: true, servingStatus: true, startDate: true, endDate: true, // SD-AUD
          },
        })
      : Promise.resolve([]),
    performanceAsOf(a.market ? [a.market] : []),
    portfolioIds.length
      ? prisma.amazonAdsPortfolio.findMany({ where: { externalPortfolioId: { in: portfolioIds } }, select: { externalPortfolioId: true, name: true } })
      : Promise.resolve([]),
  ])
  const extraById = new Map(extra.map((c) => [c.id, c]))
  const portfolioName = new Map(portfolios.map((p) => [p.externalPortfolioId, p.name]))
  const items = page.items.map((c) => {
    const x = extraById.get(String(c.id))
    // D11 — the campaign's own bid guards, which move a bid Claude asks for (set-target-bid's clampedBy).
    const guards = (x?.dynamicBidding ?? {}) as { maxBidChangePct?: unknown; cpcCeiling?: { enabled?: unknown; multiple?: unknown } }
    const maxBidChangePct = Number(guards.maxBidChangePct)
    const spendCents = Math.round(num(c.spend) * 100)
    const salesCents = Math.round(num(c.sales) * 100)
    return {
      campaignId: String(c.id),
      externalCampaignId: c.externalCampaignId ?? null,
      name: c.name,
      market: c.marketplace ?? null,
      adProduct: c.adProduct ?? c.type ?? null,
      // W4-11 — for Sponsored Brands / Display: how it pays (cpc | vcpm; Amazon's bid limits differ, and a bid in a campaign
      // whose cost type Nexus does not hold is refused), and a Sponsored Brands lifetime budget (not set from Nexus).
      costType: x?.costType ?? null,
      ...(x && isLifetimeBudget(x.budgetJson) ? { budgetPeriod: 'LIFETIME' } : {}),
      // SD-AUD — a Sponsored Display campaign's own settings, as the SD sync read them from Amazon (null: not read yet).
      ...(x && adProductOf({ adProduct: c.adProduct ?? null, type: c.type == null ? null : String(c.type) }) === SPONSORED_DISPLAY
        ? { sd: { tactic: x.tactic, tacticWords: sdTacticInWords(x.tactic), servingStatus: x.servingStatus, startDate: day(x.startDate), endDate: day(x.endDate) } }
        : {}),
      targetingType: x?.targetingType ?? null,
      status: String(c.status),
      deliveryStatus: c.deliveryStatus ?? null,
      deliveryReasons: Array.isArray(c.deliveryReasons) ? c.deliveryReasons.slice(0, 5) : [],
      currency: campaignCurrency({ dailyBudgetCurrency: x?.dailyBudgetCurrency }),
      dailyBudgetCents: unitsToMinor(c.dailyBudget),
      biddingStrategy: c.biddingStrategy ?? null,
      targetAcos: c.targetAcos ?? null,
      placementsPct: c.placements ? { topOfSearch: c.placements.tos ?? null, productPages: c.placements.pdp ?? null, restOfSearch: c.placements.ros ?? null } : null,
      minBidCents: c.minBidCents ?? null,
      maxBidCents: c.maxBidCents ?? null,
      minBudgetCents: c.minBudgetCents ?? null,
      maxBudgetCents: c.maxBudgetCents ?? null,
      // W3-2 — the daily budget relative budget rules and a restore to baseline start from (set-ad-guardrail campaign-budget-bounds).
      budgetBaselineCents: x?.budgetBaselineCents ?? null,
      portfolio: c.portfolioId ? { id: String(c.portfolioId), name: portfolioName.get(String(c.portfolioId)) ?? null } : null,
      maxBidChangePct: Number.isFinite(maxBidChangePct) && maxBidChangePct > 0 ? maxBidChangePct : null,
      // As the clamp reads it (ads-cpc-ceiling.ts): on only when enabled, 1.5 × when no multiple is stored.
      cpcCeiling: guards.cpcCeiling?.enabled === true ? { multiple: Number(guards.cpcCeiling.multiple ?? 1.5) } : null,
      liveWrites: x?.liveBidWritesEnabled ?? false,
      bidsSuppressed: x?.bidsSuppressedAt ? { since: iso(x.bidsSuppressedAt), by: x.bidsSuppressedBy ?? null } : null,
      pinned: x ? { bids: x.pinBids, budget: x.pinBudget, placement: x.pinPlacement } : null,
      metrics: {
        impressions: num(c.impressions),
        clicks: num(c.clicks),
        orders: num(c.ppcOrders),
        spendCents,
        salesCents,
        acos: ratio(spendCents, salesCents),
        roas: ratio(salesCents, spendCents),
      },
      settingsSyncedAt: iso(c.lastSyncedAt),
    }
  })
  const truncated = rows.length >= CAMPAIGN_READ_CAP
  return {
    channel: 'amazon' as const,
    dataAsOf: fresh.lastDay,
    window,
    items,
    nextCursor: page.nextCursor,
    total: rows.length,
    ...(truncated ? { truncated: `Only the first ${CAMPAIGN_READ_CAP} campaigns (by market and name) were read: narrow with market, status or search.` } : {}),
    ...(page.nextCursor ? { more: moreHint(items.length, rows.length, page.cut, 'market, status or search') } : {}),
  }
}

const adCampaigns: AgentTool = {
  name: 'ad-campaigns',
  title: 'Ad campaigns',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  restrictedFields: AD_MONEY,
  input: z.object({
    channel: readChannelArg,
    market: marketArg,
    accountId: googleAccountArg,
    status: z.preprocess(upper, z.enum(CAMPAIGN_STATUSES)).optional()
      .describe('only campaigns in this status: Amazon ENABLED | PAUSED | ARCHIVED | DRAFT; eBay RUNNING | PAUSED | SYSTEM_PAUSED | ENDED | SUSPENDED | SCHEDULED; Google ENABLED | PAUSED | REMOVED'),
    search: z.string().trim().min(1).max(100).optional().describe('only campaigns whose name contains this text'),
    days: daysArg(30, 'the metrics window'),
    limit: limitArg,
    cursor: cursorArg,
  }),
  description:
    'The Amazon campaigns, by market and name. Per campaign: campaignId (the Nexus id the other ad tools take) and '
    + 'externalCampaignId (Amazon\'s), name, market, ad product (for Sponsored Brands / Display also costType, cpc or vcpm, '
    + 'and budgetPeriod LIFETIME for an SB lifetime budget; for Sponsored Display also sd: tactic in words, Amazon\'s '
    + 'serving status, start and end date), status and delivery, currency, daily budget, bidding '
    + 'strategy, target ACoS, placement adjustments, bid and budget bounds and the budget baseline, its portfolio (Amazon\'s id and name), the '
    + 'guards that move a bid asked for (maxBidChangePct: the most one bid change may move, in %; cpcCeiling: no bid above '
    + 'that multiple of a target\'s average cost per click), whether live writes are allowed for it '
    + '(liveWrites), whether its bids are suppressed and by whom, pins, and impressions, clicks, orders, spend, sales, '
    + 'ACoS and ROAS over the window (the last 3 days provisional). Filter by market, status or name.'
    + ' eBay (channel ebay): per campaign its Nexus and eBay ids, market, funding model (cost per sale or per click), '
    + 'status, ad rate, daily budget, currency, its OWN eBay account (account.connectionId: the account any change to '
    + 'it goes to), ads promoted, the rules that cover it, and impressions, clicks, sold units, ad fees (as spend), '
    + 'sales and ACoS over the window; writes says whether eBay ad writes are live or sandbox.'
    + GOOGLE_CAMPAIGN_WORDS
    + MONEY_WORDS + PAGING,
  handler: (args) => listTool('ad-campaigns', async () => {
    const a = args as unknown as CampaignListArgs
    const refused = googleArgsRefusal(a)
    if (refused) return { ok: false, error: refused }
    const scope = scopeOf('ad-campaigns', args)
    if (a.channel === 'google') return googleRead(() => googleCampaigns(a, scope))
    await primeSettledWindow() // BB-14 — the settled window the scheduler's decisions read
    return { ok: true, data: a.channel === 'ebay' ? await ebayCampaigns(a, scope) : await amazonCampaigns(a, scope) }
  }),
}

// ── eBay (A13) ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A market's currency as configured (Marketplace.currency, services/pim/market-currency.ts), the last word when neither
 * the campaign nor eBay's own reports say; null when the market has none configured (never derived from its code).
 */
async function configuredEbayCurrency(): Promise<(market: string) => string | null> {
  const rows = await marketCurrencyRows('EBAY')
  return (market) => {
    try {
      return marketCurrency('EBAY', market, rows)
    } catch {
      return null
    }
  }
}
const EBAY_BY_SHORT: Record<string, string> = { ...Object.fromEntries(Object.entries(EBAY_MARKETPLACE_SHORT).map(([id, short]) => [short, id])), GB: 'EBAY_GB' }
/** EBAY_IT stays EBAY_IT; IT becomes EBAY_IT, UK or GB becomes EBAY_GB; anything else is kept as given (and matches nothing). */
const ebayMarket = (market: string | undefined) => (market ? (market.startsWith('EBAY_') ? market : EBAY_BY_SHORT[market] ?? market) : undefined)
const ebayWrites = () => {
  // The eBay write service's own question (currentWriteMode): the marketing write gate for eBay.
  const mode = checkMarketingWriteGate({ channel: 'EBAY', marketplace: 'EBAY_IT', payloadValueCents: 0 }).mode
  return { mode, note: mode === 'live' ? 'eBay ad writes are live: an approved change reaches eBay.' : 'sandbox: an approved change is recorded in Nexus only; nothing reaches eBay.' }
}

interface EbaySums { impressions: number; clicks: number; adFeesCents: number; salesCents: number; soldQty: number }
const ebayTotals = (s: EbaySums) => ({
  impressions: s.impressions,
  clicks: s.clicks,
  soldQty: s.soldQty,
  spendCents: s.adFeesCents,
  salesCents: s.salesCents,
  acos: ratio(s.adFeesCents, s.salesCents),
})
const accountOut = (account: EbayCampaignAccount | undefined) => (account ? { connectionId: account.connectionId, name: account.name, active: account.active } : null)

async function ebayOverview(args: { market?: string; days: number }) {
  const market = ebayMarket(args.market)
  const { range, window } = windowOf(args.days)
  const q = { startDate: range.sinceStr, endDate: range.untilStr }
  const census = await ebayCampaignCensus(market)
  const markets = [...new Set(census.map((c) => c.marketplace))].sort()
  const [grid, accounts, currencies, configured, account, dashboard, asOf] = await Promise.all([
    ebayAdsCampaigns({ ...q, ...(market ? { marketplace: market } : {}) }),
    ebayCampaignAccounts(census.map((c) => c.id)),
    ebayMarketCurrencies(),
    configuredEbayCurrency(),
    ebayAdsSummary(q),
    import('../../marketing/ebay-ads-dashboard.service.js').then((m) => m.getEbayAdsDashboard()),
    ebayPerformanceAsOf(market),
  ])
  const perMarket = await Promise.all(markets.map(async (m) => {
    const [summary, trend, marketAsOf] = await Promise.all([
      ebayAdsSummary({ ...q, marketplace: m }),
      ebayAdsTrend({ ...q, marketplace: m }),
      ebayPerformanceAsOf(m),
    ])
    const mine = census.filter((c) => c.marketplace === m)
    const byStatus: Record<string, number> = {}
    for (const c of mine) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1
    const used = new Map<string, { account: EbayCampaignAccount; campaigns: number }>()
    for (const c of mine) {
      const acc = accounts.get(c.id)
      if (!acc) continue
      const entry = used.get(acc.connectionId) ?? { account: acc, campaigns: 0 }
      entry.campaigns++
      used.set(acc.connectionId, entry)
    }
    const top = grid.campaigns
      .filter((c) => c.marketplace === m && (c.metrics.adFeesCents > 0 || c.metrics.clicks > 0))
      .sort((x, y) => y.metrics.adFeesCents - x.metrics.adFeesCents || x.name.localeCompare(y.name))
      .slice(0, TOP_CAMPAIGNS)
      .map((c) => ({
        campaignId: c.id,
        externalCampaignId: c.externalCampaignId,
        name: c.name,
        status: c.status,
        fundingModel: c.fundingModel,
        account: accountOut(accounts.get(c.id)),
        clicks: c.metrics.clicks,
        spendCents: c.metrics.adFeesCents,
        salesCents: c.metrics.salesCents,
        acos: ratio(c.metrics.adFeesCents, c.metrics.salesCents),
      }))
    const budgetCurrencies = [...new Set(mine.map((c) => c.budgetCurrency).filter((x): x is string => !!x))]
    return {
      market: m,
      currency: currencies.get(m) ?? (budgetCurrencies.length === 1 ? budgetCurrencies[0] : null) ?? configured(m),
      dataAsOf: marketAsOf,
      accounts: [...used.values()].map(({ account: acc, campaigns }) => ({ ...accountOut(acc), campaigns })),
      campaigns: { total: mine.length, byStatus },
      totals: ebayTotals(summary.current),
      previous: { from: priorFrom(range.sinceStr, range.days), to: addDays(range.sinceStr, -1), ...ebayTotals(summary.prior) },
      days: trend.points.map((p) => ({ date: p.date, provisional: p.date >= window.provisionalFrom, impressions: p.impressions, clicks: p.clicks, soldQty: p.soldQty, spendCents: p.adFeesCents, salesCents: p.salesCents })),
      topCampaigns: top,
    }
  }))
  return {
    channel: 'ebay' as const,
    dataAsOf: asOf,
    window,
    writes: ebayWrites(),
    markets: perMarket,
    ...(markets.length === 0 ? { empty: market ? `No eBay campaign in market ${market}.` : 'No eBay campaign in this business.' } : {}),
    coverage: account.coverage,
    economics: account.economicsStatus,
    attribution: 'eBay counts a sale after any click on the ad (any-click attribution); ACoS = ad fees ÷ those sales.',
    findings: dashboard.recommendations.map((r) => ({
      type: r.type,
      count: r.count,
      title: r.title,
      criteria: r.criteria,
      // The above-break-even samples quote each listing's ad rate and break-even rate: money.
      ...(r.type === 'rates_above_breakeven' ? { rateSamples: r.samples } : { samples: r.samples }),
    })),
    pacing: {
      ceilings: dashboard.pacing.ceilings.map((c) => ({ market: c.marketplace, monthToDateCents: c.mtdCents, capCents: c.capCents, usedPct: c.pct, projectedCents: c.projectedCents })),
      costPerClick: {
        campaigns: dashboard.pacing.cpc.campaigns,
        dailyBudgetCents: dashboard.pacing.cpc.dailyBudgetCents,
        yesterdayFeesCents: dashboard.pacing.cpc.ydayFeesCents,
        utilizationPct: dashboard.pacing.cpc.utilizationPct,
        limitedByBudget: dashboard.pacing.cpc.limitedCount,
      },
    },
  }
}

/** The first day of the window of `days` days that ends the day before `since`. */
const priorFrom = (since: string, days: number) => addDays(since, -days)

async function ebayCampaigns(a: CampaignListArgs, scope: string) {
  const size = pageSize(a.limit)
  const market = ebayMarket(a.market)
  const { range, window } = windowOf(a.days)
  const [grid, census, currencies, configured, asOf] = await Promise.all([
    ebayAdsCampaigns({ startDate: range.sinceStr, endDate: range.untilStr, ...(market ? { marketplace: market } : {}) }),
    ebayCampaignCensus(market),
    ebayMarketCurrencies(),
    configuredEbayCurrency(),
    ebayPerformanceAsOf(market),
  ])
  const needle = a.search?.toLowerCase()
  const rows = grid.campaigns.filter((c) => (!a.status || c.status === a.status) && (!needle || c.name.toLowerCase().includes(needle)))
  const positionOf = (c: (typeof rows)[number]): CursorPosition => ({ values: [c.marketplace, c.name], id: c.id })
  const page = keysetPage(rows, positionOf, size, scope, a.cursor)
  const accounts = await ebayCampaignAccounts(page.items.map((c) => c.id))
  const budgetCurrency = new Map(census.map((c) => [c.id, c.budgetCurrency]))
  const items = page.items.map((c) => ({
    campaignId: c.id,
    externalCampaignId: c.externalCampaignId,
    name: c.name,
    market: c.marketplace,
    fundingModel: c.fundingModel,
    targetingType: c.targetingType ?? null,
    channels: c.channels,
    status: c.status,
    adRateStrategy: c.adRateStrategy ?? null,
    currency: budgetCurrency.get(c.id) ?? currencies.get(c.marketplace) ?? configured(c.marketplace),
    bidPercentage: c.bidPercentage,
    dailyBudgetCents: c.dailyBudgetCents,
    rulesBased: c.isRulesBased,
    nexusManaged: c.nexusManaged,
    startDate: iso(c.startDate),
    endDate: iso(c.endDate),
    account: accountOut(accounts.get(c.id)),
    ads: c.ads,
    automation: c.automation,
    limitedByBudget: c.limitedByBudget,
    metrics: { ...ebayTotals(c.metrics) },
    settingsSyncedAt: iso(c.lastEntitySyncAt),
  }))
  return {
    channel: 'ebay' as const,
    dataAsOf: asOf,
    window,
    writes: ebayWrites(),
    items,
    nextCursor: page.nextCursor,
    total: rows.length,
    ...(page.nextCursor ? { more: moreHint(items.length, rows.length, page.cut, 'market, status or search') } : {}),
  }
}

// ── ad-targets ─────────────────────────────────────────────────────────────────────────────────────

const TARGET_STATUSES = ['enabled', 'paused', 'archived', 'all'] as const

const adTargets: AgentTool = {
  name: 'ad-targets',
  title: 'Ad targets and bids',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  restrictedFields: AD_MONEY,
  input: z.object({
    campaignId: campaignArg,
    adGroupId: z.string().trim().min(1).max(64).optional().describe('only this ad group: its Nexus id'),
    market: marketArg,
    status: z.preprocess(lower, z.enum(TARGET_STATUSES)).default('enabled').describe('target status (default enabled)'),
    search: z.string().trim().min(1).max(100).optional().describe('only targets whose text, campaign or ad group name contains this'),
    days: daysArg(30, 'the metrics window'),
    limit: limitArg,
    cursor: cursorArg,
  }),
  description:
    'The positive targets (keywords, product and auto targets) of the Amazon campaigns, by campaign, ad group and '
    + 'text. Per target: targetId (the id set-target-bid takes), its ad group and campaign (Nexus and Amazon ids, and the '
    + 'campaign\'s ad product), '
    + 'text, kind, match type, status, live now (target and campaign enabled), bid, the bid it held before a no-pause '
    + 'suppression (suppressedFromBidCents; a suppressed bid is not raised), the campaign\'s bid bounds, effective max '
    + 'CPC, who owns its bids (brain, schedule, goal, manual or none), and impressions, clicks, orders, spend, sales, CPC and '
    + 'ACoS over the window. A Sponsored Display target\'s metrics are its own SD targeting report\'s (14 days, a click or '
    + 'a view of the ad counts) and add viewable impressions, units, ROAS, detail page views, new-to-brand, and each '
    + 'attributed figure after a click (afterClick) and after a view (afterView). The bid is Nexus\'s copy: when it has not '
    + 'reached Amazon yet (a write queued or being sent, '
    + 'or one that failed), bidNotAtAmazon says so, with the bid Amazon still has (amazonBidCents) and, for a failed '
    + 'one, why; null when Amazon has the bid shown. A Sponsored Display target also gives sd: its expression in plain words '
    + '(inWords, e.g. "people who viewed the advertised products in the last 30 days" or "products in category \"Helmets\" '
    + '(123), brand \"Acme\" (9), rating above 4 stars"), Amazon\'s expression and resolved expression, and its serving '
    + 'status (null: not read from Amazon yet). Filter by campaignId, adGroupId, market, status or text.' + MONEY_WORDS + PAGING,
  handler: (args) => listTool('ad-targets', async () => {
    const a = args as { campaignId?: string; adGroupId?: string; market?: string; status: (typeof TARGET_STATUSES)[number]; search?: string; days: number; limit?: number; cursor?: string }
    const size = pageSize(a.limit)
    const scope = scopeOf('ad-targets', args)
    let campaignId = a.campaignId ?? null
    if (a.campaignId && !(await campaignById(a.campaignId))) return { ok: false, error: 'Campaign not found' }
    if (a.adGroupId) {
      const groupCampaign = await adGroupCampaignId(a.adGroupId)
      if (!groupCampaign || (campaignId && groupCampaign !== campaignId)) return { ok: false, error: 'Ad group not found' }
      campaignId = groupCampaign
    }
    const { range, window } = windowOf(a.days)
    const grid = await getBidGrid({
      market: a.market ?? 'all',
      line: null,
      portfolio: null,
      campaign: campaignId,
      view: 'targets',
      status: a.status,
      kind: [],
      match: [],
      band: null,
      measured: 'all',
      q: a.search ?? null,
      windowDays: a.days,
      sort: null,
      dir: 'desc',
      limit: 5000,
    })
    const rows = (grid.rows as BidTargetRow[]).filter((r) => !a.adGroupId || r.adGroupId === a.adGroupId)
    const positionOf = (r: BidTargetRow): CursorPosition => ({ values: [r.campaignName, r.adGroupName, r.label], id: r.id })
    const page = keysetPage(rows, positionOf, size, scope, a.cursor)
    const campaignIds = [...new Set(page.items.map((r) => r.campaignId))]
    const groupIds = [...new Set(page.items.map((r) => r.adGroupId))]
    const [index, externalGroup, notAtAmazon] = await Promise.all([
      campaignIndex(campaignIds, []), adGroupExternalIds(groupIds), bidsNotAtAmazon(page.items.map((r) => ({ id: r.id, bidCents: r.bidCents }))),
    ])
    const adProductOfRow = (r: BidTargetRow) => {
      const c = index.byId.get(r.campaignId)
      return c ? adProductOf({ adProduct: c.adProduct, type: c.type == null ? null : String(c.type) }) : null
    }
    // SD reports below the campaign (2026-10-20) — a Sponsored Display target's figures are its own SD targeting report's.
    const sdIds = new Set(page.items.filter((r) => adProductOfRow(r) === SPONSORED_DISPLAY).map((r) => r.id))
    const sd = await sdMetricsByLocalId('AD_TARGET', [...sdIds], range.since, range.until)
    // SD-AUD — a Sponsored Display target as Amazon holds it (the SD sync's read): its expression, in words, and serving status.
    const sdRows = sdIds.size
      ? await prisma.adTarget.findMany({ where: { id: { in: [...sdIds] } }, select: { id: true, expressionJson: true, resolvedExpressionJson: true, servingStatus: true } })
      : []
    const sdSettings = new Map(sdRows.map((t) => [t.id, t]))
    const items = page.items.map((r) => {
      const c = index.byId.get(r.campaignId)
      const unsent = notAtAmazon.get(r.id)
      const settings = sdSettings.get(r.id)
      return {
        targetId: r.id,
        text: r.label,
        textIsDerived: r.derived,
        kind: r.kind,
        match: r.match,
        status: r.status,
        liveNow: r.liveNow,
        adGroupId: r.adGroupId,
        externalAdGroupId: externalGroup.get(r.adGroupId) ?? null,
        adGroupName: r.adGroupName,
        campaignId: r.campaignId,
        externalCampaignId: c?.externalCampaignId ?? null,
        campaignName: r.campaignName,
        // W4-11 — set-target-bid and bulk-ad-bid-change also change Sponsored Brands keyword and product-target bids and
        // Sponsored Display target bids.
        adProduct: adProductOfRow(r),
        ...(settings
          ? {
              sd: {
                inWords: sdExpressionInWords(settings.expressionJson, settings.resolvedExpressionJson),
                expression: settings.expressionJson ?? null,
                resolvedExpression: settings.resolvedExpressionJson ?? null,
                servingStatus: settings.servingStatus,
              },
            }
          : {}),
        campaignStatus: r.campaignStatus,
        market: r.market,
        currency: c ? campaignCurrency(c) : null,
        bidCents: r.bidCents,
        // Honest writes — a bid Nexus shows that Amazon does not have yet (or did not take).
        bidNotAtAmazon: unsent ? { state: unsent.state, amazonBidCents: unsent.amazonBidCents, since: iso(unsent.since), deliveryError: unsent.deliveryError } : null,
        suppressed: r.suppressedFromBidCents != null,
        suppressedFromBidCents: r.suppressedFromBidCents,
        inMinBidWindow: r.inMinBidWindow,
        minBidCents: r.minBidCents,
        maxBidCents: r.maxBidCents,
        effectiveMaxCpcCents: r.effectiveMaxCpcCents,
        biddingStrategy: r.biddingStrategy,
        bidOwner: r.bidder,
        bidOwnerName: r.bidderName,
        bidChangedOutsideNexus: r.unrecorded,
        metrics: sdIds.has(r.id)
          ? sd.byId.get(r.id) ?? sdMetricsOf(null)
          : {
              measured: r.measured,
              impressions: r.impressions,
              clicks: r.clicks,
              orders: r.orders,
              spendCents: r.spendCents,
              salesCents: r.salesCents,
              cpcCents: r.cpcCents == null ? null : Math.round(r.cpcCents),
              acos: r.acos,
            },
      }
    })
    return {
      ok: true,
      data: {
        dataAsOf: day(grid.freshness.newestPerfDate ? new Date(grid.freshness.newestPerfDate) : null),
        window,
        ...(sdIds.size ? { display: { dataAsOf: sd.dataAsOf, attribution: SD_ATTRIBUTION_NOTE } } : {}),
        items,
        nextCursor: page.nextCursor,
        total: rows.length,
        ...(grid.truncated ? { truncated: 'More than 5,000 targets matched: only the first 5,000 (by bid) were read. Narrow with campaignId, market or search.' } : {}),
        ...(page.nextCursor ? { more: moreHint(items.length, rows.length, page.cut, 'campaignId, adGroupId, market or search') } : {}),
      },
    }
  }),
}

// ── ad-purchased-products ──────────────────────────────────────────────────────────────────────────

/** A purchased-product line's own id: its Amazon campaign and ad group, the advertised product and the one bought. */
const purchasedLineId = (l: SdPurchasedLine) => shortId([l.campaignId, l.adGroupId, l.promotedAsin, l.promotedSku ?? '', l.purchasedAsin, l.currencyCode].join('|'))

const adPurchasedProducts: AgentTool = {
  name: 'ad-purchased-products',
  title: 'What shoppers bought after a Display ad',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  restrictedFields: AD_MONEY,
  input: z.object({
    campaignId: campaignArg,
    adGroupId: z.string().trim().min(1).max(64).optional().describe('only this ad group: its Nexus id (adGroupId in ad-groups or ad-targets)'),
    market: z.string().trim().toUpperCase().min(2).max(20).optional().describe('only this Amazon marketplace: IT, DE, FR, ES, UK'),
    asin: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{10}$/, 'an ASIN is 10 letters and digits').optional()
      .describe('only lines where this ASIN is the advertised product or the one bought'),
    days: daysArg(30, 'the window'),
    limit: limitArg,
    cursor: cursorArg,
  }),
  description:
    'Amazon Sponsored Display: what shoppers bought after an ad. Per campaign, ad group and advertised product (ASIN and '
    + 'SKU), each OTHER product (boughtAsin, a different ASIN) bought within 14 days of the ad (Amazon\'s SD purchased '
    + 'product report): orders, units and sales after a click or a view (clickOrView: Amazon sends it for vcpm campaigns, '
    + 'null when it sent none), after a click (afterClick) and after a view (afterView, the difference), with the campaign '
    + 'and ad group (Nexus and Amazon ids, names), market and currency. Most orders first. Filter by campaignId, adGroupId '
    + '(the campaign read is named), market or asin.' + MONEY_WORDS + PAGING,
  handler: (args) => listTool('ad-purchased-products', async () => {
    const a = args as { campaignId?: string; adGroupId?: string; market?: string; asin?: string; days: number; limit?: number; cursor?: string }
    const size = pageSize(a.limit)
    const scope = scopeOf('ad-purchased-products', args)
    let campaign = a.campaignId ? await campaignById(a.campaignId) : null
    if (a.campaignId && !campaign) return { ok: false, error: 'Campaign not found' }
    let externalAdGroupId: string | null = null
    if (a.adGroupId) {
      const groupCampaign = await adGroupCampaignId(a.adGroupId)
      if (!groupCampaign || (campaign && groupCampaign !== campaign.id)) return { ok: false, error: 'Ad group not found' }
      campaign = campaign ?? await campaignById(groupCampaign)
      externalAdGroupId = (await adGroupExternalIds([a.adGroupId])).get(a.adGroupId) ?? null
    }
    // Amazon reports by its own ids: a campaign or ad group Amazon does not hold has nothing reported.
    const campaignIds = campaign
      ? (campaign.externalCampaignId ? [campaign.externalCampaignId] : [])
      : a.market
        ? (await prisma.campaign.findMany({ where: { marketplace: a.market, externalCampaignId: { not: null } }, select: { externalCampaignId: true } }))
            .map((c) => c.externalCampaignId as string)
        : undefined
    const { range } = windowOf(a.days)
    const read = a.adGroupId && !externalAdGroupId
      ? { lines: [] as SdPurchasedLine[], dataAsOf: null }
      : await sdPurchasedProducts({ since: range.since, until: range.until, campaignIds, adGroupId: externalAdGroupId ?? undefined, asin: a.asin })
    const ordersOf = (l: SdPurchasedLine) => l.clickOrView.orders ?? l.afterClick.orders ?? 0
    const unitsOf = (l: SdPurchasedLine) => l.clickOrView.units ?? l.afterClick.units ?? 0
    const positionOf = (l: SdPurchasedLine): CursorPosition => ({ values: [ordersOf(l), unitsOf(l)], id: purchasedLineId(l) })
    const page = keysetPage(read.lines, positionOf, size, scope, a.cursor, [true, true])
    const [index, groups] = await Promise.all([
      campaignIndex([], page.items.map((l) => l.campaignId)), adGroupsByExternalId(page.items.map((l) => l.adGroupId)),
    ])
    const items = page.items.map((l) => {
      const group = groups.get(l.adGroupId)
      return {
        lineId: purchasedLineId(l),
        ...campaignOut(index.byExternal.get(l.campaignId)),
        externalCampaignId: l.campaignId,
        adGroupId: group?.id ?? null,
        externalAdGroupId: l.adGroupId,
        adGroupName: group?.name ?? null,
        currency: l.currencyCode,
        advertised: { asin: l.promotedAsin, sku: l.promotedSku },
        boughtAsin: l.purchasedAsin,
        clickOrView: l.clickOrView,
        afterClick: l.afterClick,
        afterView: l.afterView,
      }
    })
    return {
      ok: true,
      data: {
        dataAsOf: read.dataAsOf,
        window: { from: range.sinceStr, to: range.untilStr, days: range.days },
        // The campaign a campaignId or adGroupId narrowed the read to.
        ...(campaign ? { campaign: campaignOut(campaign) } : {}),
        attribution: SD_ATTRIBUTION_NOTE,
        meaning: 'Each line: shoppers who saw or clicked the ad for the advertised product, then bought boughtAsin (not the advertised product) within 14 days. For a cpc campaign Amazon counts after a click; for a vcpm campaign after a click or a view.',
        items,
        nextCursor: page.nextCursor,
        total: read.lines.length,
        ...(page.nextCursor ? { more: moreHint(items.length, read.lines.length, page.cut, 'campaignId, adGroupId, market or asin') } : {}),
      },
    }
  }),
}

// ── ad-search-terms ────────────────────────────────────────────────────────────────────────────────

const TERM_KINDS = ['wasteful', 'converting', 'all'] as const

const adSearchTerms: AgentTool = {
  name: 'ad-search-terms',
  title: 'Ad search terms',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  restrictedFields: AD_MONEY,
  input: z.object({
    kind: z.preprocess(lower, z.enum(TERM_KINDS)).default('all')
      .describe('wasteful = spent at least 15.00 with no order (a first look only: ad-waste holds the waste test in force, the verb and what is held); converting = 2 or more orders (a first look only: the harvest bar, place and state are harvest-candidates); all = both (default)'),
    campaignId: campaignArg,
    market: marketArg,
    search: z.string().trim().min(1).max(100).optional().describe('only search terms that contain this text'),
    days: daysArg(30, 'the window'),
    limit: limitArg,
    cursor: cursorArg,
  }),
  description:
    'What shoppers typed that triggered the Amazon ads, from the search-term report, in two lists: wasteful terms '
    + '(spent with no order, by a fixed bar: a first look only — ad-waste judges waste by the test in force, with its verb and '
    + 'what is held) by spend, then converting terms (2 or more orders) by '
    + 'orders. A converting term is harvested through the harvest engine, never from here: harvest-candidates lists it with '
    + 'the bar it must pass (the ads strategy\'s, else the brain\'s test), where it would go, its start bid and its state, '
    + 'and apply-harvest asks for the harvest (its candidateId is on the row when the campaign belongs to one product). '
    + 'Per term: the search term itself (keywordText / query for those tools), whether it '
    + 'is an ASIN (a product target), the campaign (Nexus campaignId and Amazon externalCampaignId) and ad group it ran '
    + 'in, market, currency, and impressions, clicks, orders, spend, sales and ACoS over the window. Filter by kind, '
    + 'campaignId, market or text. The list is ranked live: a term that moves between two pages may repeat.'
    + MONEY_WORDS + PAGING,
  handler: (args) => listTool('ad-search-terms', async () => {
    const a = args as { kind: (typeof TERM_KINDS)[number]; campaignId?: string; market?: string; search?: string; days: number; limit?: number; cursor?: string }
    const size = pageSize(a.limit)
    const scope = scopeOf('ad-search-terms', args)
    let adGroupExternals: string[] | undefined
    if (a.campaignId) {
      const campaign = await campaignById(a.campaignId)
      if (!campaign) return { ok: false, error: 'Campaign not found' }
      adGroupExternals = (await adGroupsOfCampaign(campaign.id)).map((g) => g.externalAdGroupId).filter((id): id is string => !!id)
    }
    const since = new Date(Date.now() - a.days * 86_400_000)
    const [harvest, newest] = await Promise.all([
      previewHarvest({ windowDays: a.days, ...(adGroupExternals ? { adGroupExternalIds: adGroupExternals } : {}) }),
      prisma.amazonAdsSearchTerm.aggregate({ _max: { date: true } }),
    ])
    type Term = HarvestCandidate & { kind: 'wasteful' | 'converting'; isAsin: boolean }
    const asin = (q: string) => /^b0[a-z0-9]{8}$/i.test(q.trim())
    const wasteful: Term[] = [...harvest.negatives, ...harvest.productNegatives]
      .sort((x, y) => y.costCents - x.costCents)
      .map((t) => ({ ...t, kind: 'wasteful' as const, isAsin: asin(t.query) }))
    const converting: Term[] = [...harvest.graduations, ...harvest.productGraduations]
      .sort((x, y) => y.orders - x.orders || y.salesCents - x.salesCents)
      .map((t) => ({ ...t, kind: 'converting' as const, isAsin: asin(t.query) }))
    let terms = [...(a.kind !== 'converting' ? wasteful : []), ...(a.kind !== 'wasteful' ? converting : [])]
    if (a.search) terms = terms.filter((t) => t.query.toLowerCase().includes(a.search!.toLowerCase()))
    const index = await campaignIndex([], terms.map((t) => t.externalCampaignId))
    if (a.market) terms = terms.filter((t) => index.byExternal.get(t.externalCampaignId)?.marketplace === a.market)
    const idOf = (t: Term) => shortId(`${t.kind}|${t.externalCampaignId}|${t.externalAdGroupId}|${t.query}`)
    const page = rankedPage(terms, idOf, size, scope, a.cursor)
    const groupByExternal = await adGroupsByExternalId(page.items.map((t) => t.externalAdGroupId))
    // Keyword Harvest page rebuild (lane HMCP) — a converting term's harvest candidate (the product that owns its campaign).
    const convertingCampaigns = [...new Set(page.items.filter((t) => t.kind === 'converting').map((t) => index.byExternal.get(t.externalCampaignId)?.id).filter((id): id is string => !!id))]
    const owners = convertingCampaigns.length ? await resolveCampaignOwnership(convertingCampaigns) : new Map()
    const candidateOf = (t: Term): string | null => {
      const own = owners.get(index.byExternal.get(t.externalCampaignId)?.id ?? '')
      const market = strategyMarket(own?.market ?? null)
      return own?.owner.kind === 'product' && market ? candidateIdOf(market, own.owner.productId, normTerm(t.query)) : null
    }
    const items = page.items.map((t) => {
      const c = index.byExternal.get(t.externalCampaignId)
      const g = groupByExternal.get(t.externalAdGroupId)
      return {
        termId: idOf(t),
        kind: t.kind,
        query: t.query,
        isAsin: t.isAsin,
        ...campaignOut(c),
        externalCampaignId: t.externalCampaignId,
        adGroupId: g?.id ?? null,
        externalAdGroupId: t.externalAdGroupId,
        adGroupName: g?.name ?? null,
        metrics: {
          impressions: t.impressions,
          clicks: t.clicks,
          orders: t.orders,
          spendCents: t.costCents,
          salesCents: t.salesCents,
          acos: ratio(t.costCents, t.salesCents),
        },
        suggestedTool: t.kind === 'wasteful' ? (t.isAsin ? null : 'create-negative-keyword') : 'harvest-candidates',
        ...(t.kind === 'converting' ? { candidateId: candidateOf(t) } : {}),
      }
    })
    return {
      ok: true,
      data: {
        dataAsOf: day(newest._max.date),
        window: {
          from: since.toISOString().slice(0, 10),
          to: new Date().toISOString().slice(0, 10),
          days: a.days,
          provisionalFrom: addDays(new Date().toISOString().slice(0, 10), -(PROVISIONAL_DAYS - 1)),
          note: PROVISIONAL_NOTE,
        },
        thresholds: { wasteful: 'spent at least 1500 minor units (15.00) with no order', converting: '2 or more orders (a first look: harvest-candidates holds the harvest bar)' },
        items,
        nextCursor: page.nextCursor,
        total: page.total,
        ...(page.nextCursor ? { more: moreHint(items.length, page.total, page.cut, 'kind, campaignId, market or search') } : {}),
      },
    }
  }),
}

// ── ad-changes ─────────────────────────────────────────────────────────────────────────────────────

const CHANGE_SOURCES = ['automation', 'operator', 'system', 'external'] as const
/** Fields whose values are not money; every other field's before/after is an amount (bid, budget, placement %). */
const PLAIN_FIELDS = new Set(['status', 'state', 'name', 'startDate', 'endDate', 'targetingType', 'biddingStrategy', 'servingStatus'])

function changeOut(row: ChangeRow, scopeCampaign: CampaignRef | null) {
  const fromHistory = row.id.startsWith('h:')
  const plain = PLAIN_FIELDS.has(row.field)
  const campaign = row.campaign ?? (scopeCampaign ? { id: scopeCampaign.id, name: scopeCampaign.name } : null)
  return {
    changeId: row.id,
    at: iso(row.at),
    source: row.source,
    origin: row.origin,
    actor: row.actor,
    entity: row.entity,
    campaign,
    ...(fromHistory
      ? { field: row.field, ...(plain ? { oldValue: row.oldValue, newValue: row.newValue } : { fromAmount: row.oldValue, toAmount: row.newValue }) }
      : { action: row.field, note: row.newValue }),
    why: row.reason,
    evidence: row.evidence,
    delivery: row.delivery ? { state: row.delivery.state, attempts: row.delivery.attempts, deliveryError: row.delivery.lastError } : null,
    undoable: row.undoable,
    undoActionLogId: row.undoActionLogId,
    ...(row.undoBlockedReason ? { undoBlockedReason: row.undoBlockedReason } : {}),
  }
}

const adChanges: AgentTool = {
  name: 'ad-changes',
  title: 'Ad change log',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  restrictedFields: AD_MONEY,
  input: z.object({
    channel: changeChannelArg,
    campaignId: z.string().trim().min(1).max(64).optional().describe('only this campaign: its Nexus id (campaignId in ad-campaigns, for the channel asked; not for meta)'),
    targetId: z.string().trim().min(1).max(64).optional().describe('Amazon only: this target, by its Nexus id (targetId in ad-targets)'),
    source: z.preprocess(lower, z.enum(CHANGE_SOURCES)).optional()
      .describe('only changes by automation (rules, schedules, engines), an operator, the system, or made outside Nexus'),
    days: daysArg(14, 'how far back'),
    limit: limitArg,
    cursor: cursorArg,
  }),
  description:
    'What changed on the Amazon ads, newest first: bids, budgets, placements, statuses and the operations behind them. '
    + 'Per change: when, who (source automation | operator | system | external, and which rule, schedule or person), '
    + 'the entity and its campaign, the field with its old and new value (amounts as fromAmount / toAmount), why (the '
    + 'writer\'s reason and evidence), whether it reached Amazon (delivery), and whether it can be undone '
    + '(undoActionLogId) or why not. Filter by campaignId, targetId or source.'
    + ' eBay (channel ebay): the eBay ad audit trail — each write, its campaign, who made it (operator, automation, or '
    + 'accepted from eBay), what it replaced and wrote, and whether eBay took it (or it ran in sandbox).'
    + ' Meta (channel meta): the changes Nexus made on Meta, newest first — each Meta change tool\'s own record: when, which '
    + 'tool (action), who decided it (decidedVia: in Nexus, or "no-approval" when the business\'s switch ran it in the name of '
    + 'the person who asked), the plan step it ran as, the Meta ad account, what was asked (note, "Asked: …"), what it '
    + 'replaced and wrote (only what Meta made: a change Meta made in part shows that part), and whether undo-change can '
    + 'still put it back (undo, with changeId). Nexus makes no Meta change by itself: a change a person approved is source '
    + 'operator; one Claude asked for that ran by the business\'s "Claude\'s changes need no approval" switch is source '
    + 'automation, with decidedVia no-approval. Changes made outside Nexus (Ads Manager, Meta\'s own rules) are read with '
    + 'meta-activity-log.' + MONEY_WORDS
    + ' Returns { items, nextCursor }; a page can hold fewer rows than limit to stay within a size limit: follow nextCursor for the rest.',
  handler: (args) => listTool('ad-changes', async () => {
    if ((args as { channel?: string }).channel === 'ebay') return ebayChanges(args, scopeOf('ad-changes', args))
    if ((args as { channel?: string }).channel === 'meta') return metaChanges(args, scopeOf('ad-changes', args))
    const a = args as { campaignId?: string; targetId?: string; source?: ChangeSource; days: number; limit?: number; cursor?: string }
    const size = pageSize(a.limit)
    const scope = scopeOf('ad-changes', args)
    const start = decodeCursor(scope, a.cursor)
    let scopeCampaign: CampaignRef | null = null
    let entityIds: string[] | undefined
    if (a.campaignId) {
      scopeCampaign = await campaignById(a.campaignId)
      if (!scopeCampaign) return { ok: false, error: 'Campaign not found' }
      const groups = await adGroupsOfCampaign(scopeCampaign.id)
      entityIds = [scopeCampaign.id, ...groups.map((g) => g.id), ...groups.flatMap((g) => g.targetIds)]
    }
    if (a.targetId) {
      const target = await prisma.adTarget.findFirst({ where: { id: a.targetId }, select: { id: true, adGroup: { select: { campaignId: true } } } })
      if (!target || (scopeCampaign && target.adGroup.campaignId !== scopeCampaign.id)) return { ok: false, error: 'Target not found' }
      entityIds = [target.id]
      scopeCampaign ??= await campaignById(target.adGroup.campaignId)
    }
    const to = start ? new Date(String(start.values[0])) : new Date()
    if (Number.isNaN(to.getTime())) throw new InvalidCursorError()
    const from = new Date(Date.now() - a.days * 86_400_000)
    const read = async (limit: number) => {
      const out = await listChanges({
        from,
        to,
        ...(a.source ? { source: a.source } : {}),
        ...(entityIds ? { entityIds } : {}),
        limit,
      })
      return out.items
    }
    const order = (x: ChangeRow, y: ChangeRow) => y.at.getTime() - x.at.getTime() || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)
    const afterStart = (row: ChangeRow) => {
      if (!start) return true
      const t = row.at.getTime()
      const s = to.getTime()
      return t < s || (t === s && row.id > start.id)
    }
    let want = Math.min(500, (size + 1) * 2 + 20)
    let rows = (await read(want)).sort(order)
    let rest = rows.filter(afterStart)
    // Many changes can share one instant (a bulk write): if the read filled up with rows before the cursor, read wider.
    if (rest.length <= size && rows.length >= want && want < 500) {
      want = 500
      rows = (await read(want)).sort(order)
      rest = rows.filter(afterStart)
    }
    // A campaign's own changes only: the operation log has no campaign column, so it is narrowed by entity above.
    const scoped = scopeCampaign && !a.targetId
      ? rest.filter((r) => !r.campaign || r.campaign.id === scopeCampaign!.id)
      : rest
    const items = scoped.slice(0, size)
    const positionOf = (r: ChangeRow): CursorPosition => ({ values: [r.at.toISOString()], id: r.id })
    const last = items.at(-1)
    const page = fitPage({ items, nextCursor: scoped.length > size && last ? encodeCursor(scope, positionOf(last)) : null }, scope, positionOf)
    return {
      ok: true,
      data: {
        dataAsOf: iso(rows[0]?.at ?? null),
        window: { from: day(from), days: a.days },
        items: page.items.map((r) => changeOut(r, scopeCampaign)),
        nextCursor: page.nextCursor,
        ...(page.nextCursor ? { more: moreHint(page.items.length, null, page.cut, 'campaignId, targetId or source') } : {}),
      },
    }
  }),
}

/** A13 gap — the eBay change log (CampaignAction, through the eBay read service), newest first, keyset paged. */
async function ebayChanges(args: Record<string, unknown>, scope: string): Promise<ToolResult> {
  const a = args as { campaignId?: string; targetId?: string; source?: ChangeSource; days: number; limit?: number; cursor?: string }
  if (a.targetId) return { ok: false, error: 'targetId names an Amazon target: the eBay change log is read by campaign.' }
  const size = pageSize(a.limit)
  const start = decodeCursor(scope, a.cursor)
  let externalCampaignId: string | null = null
  if (a.campaignId) {
    const census = (await ebayCampaignCensus()).find((c) => c.id === a.campaignId)
    if (!census) return { ok: false, error: 'Campaign not found' }
    externalCampaignId = census.externalCampaignId
  }
  const from = new Date(Date.now() - a.days * 86_400_000)
  const before = start ? new Date(new Date(String(start.values[0])).getTime() + 1) : null
  if (before && Number.isNaN(before.getTime())) throw new InvalidCursorError()
  const { actions } = await ebayAdsActions({
    limit: String(Math.min(200, (size + 1) * 2 + 20)),
    ...(externalCampaignId ? { entityId: externalCampaignId } : {}),
    ...(before ? { before: before.toISOString() } : {}),
  })
  const sourceOf = (s: string) => (s === 'external_accepted' ? 'external' : s === 'automation' ? 'automation' : 'operator')
  const rows = actions
    .filter((r) => r.createdAt >= from)
    .filter((r) => !a.source || sourceOf(r.source) === a.source)
    .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime() || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    .filter((r) => !start || r.createdAt.getTime() < new Date(String(start.values[0])).getTime() || (r.createdAt.getTime() === new Date(String(start.values[0])).getTime() && r.id > start.id))
  const items = rows.slice(0, size)
  const positionOf = (r: (typeof rows)[number]): CursorPosition => ({ values: [r.createdAt.toISOString()], id: r.id })
  const last = items.at(-1)
  const page = fitPage({ items, nextCursor: rows.length > size && last ? encodeCursor(scope, positionOf(last)) : null }, scope, positionOf)
  return {
    ok: true,
    data: {
      channel: 'ebay',
      dataAsOf: iso(actions[0]?.createdAt ?? null),
      window: { from: day(from), days: a.days },
      items: page.items.map((r) => {
        const after = (r.payloadAfter ?? {}) as Record<string, unknown>
        const { _mode, ...wrote } = after
        return {
          changeId: r.id,
          at: iso(r.createdAt),
          source: sourceOf(r.source),
          actor: r.userId,
          action: r.actionType,
          entity: { type: r.entityType, id: r.entityId },
          campaign: r.campaignId ? { id: r.campaignId, name: r.campaignName } : null,
          replaced: r.payloadBefore,
          wrote,
          delivery: { state: r.channelResponseStatus, mode: typeof _mode === 'string' ? _mode : null },
        }
      }),
      nextCursor: page.nextCursor,
      ...(page.nextCursor ? { more: moreHint(page.items.length, null, page.cut, 'campaignId or source') } : {}),
    },
  }
}

// ── ad-changes, Meta (step 44): the changes Nexus made on Meta ───────────────────────────────────────

const META_OUTSIDE = 'Changes made outside Nexus (in Ads Manager, by Meta\'s own rules or another tool) are not here: meta-activity-log reads the Meta ad account\'s whole history live.'
const LIVE_APPROVALS = ['pending', 'scheduled', 'executing']

/** The Meta change tools, by the registry (loaded when asked: the registry imports this file). Name → title. */
async function metaChangeTools(): Promise<Map<string, string>> {
  const { listTools } = await import('../tool-registry.js')
  return new Map(listTools()
    .filter((t) => !t.readOnly && !t.control && !!t.execute && t.category === 'advertising' && /(^|-)meta-/.test(t.name))
    .map((t) => [t.name, t.title]))
}

/**
 * A preview's own summary (a Meta change's draft summary), labelled as what was asked, capped; null when it has none.
 * Review fix (step 44) — the change record keeps no count of the requests Meta made (runMetaChange answers done / of but
 * records only what Meta made, in before / after): a change Meta made in part keeps the whole request's summary here.
 */
function summaryOf(preview: unknown): string | null {
  const summary = (preview as { summary?: unknown } | null)?.summary
  if (typeof summary !== 'string' || !summary.trim()) return null
  const asked = `Asked: ${summary}`
  return asked.length > 500 ? `${asked.slice(0, 499)}…` : asked
}

/** Review fix (step 44) — what the business's "Claude's changes need no approval" switch ran (#691) is source automation. */
const META_BY_ITSELF = 'Nexus makes no Meta change by itself. A change Claude asked for that ran by this business\'s "Claude\'s changes need no approval" switch, in the name of the person who asked, is source automation (decidedVia no-approval); one a person approved is source operator.'

/**
 * Meta ads step 44 — the Meta change kit's records (AgentChange of every Meta change tool), newest first, keyset-paged by
 * when it ran. What a change replaced and wrote, and its summary, are under money keys (a budget, a bid, a spending limit
 * can be in them): a person without the ad-spend money permission gets the rest.
 */
async function metaChanges(args: Record<string, unknown>, scope: string): Promise<ToolResult> {
  const a = args as { campaignId?: string; targetId?: string; source?: ChangeSource; days: number; limit?: number; cursor?: string }
  if (a.campaignId || a.targetId) {
    return { ok: false, error: 'campaignId and targetId name Amazon or eBay objects: Meta changes are listed by time and source. meta-activity-log reads one Meta campaign\'s, ad set\'s or ad\'s whole history.' }
  }
  const from = new Date(Date.now() - a.days * 86_400_000)
  const base = { channel: 'meta' as const, window: { from: day(from), days: a.days }, outsideNexus: META_OUTSIDE }
  if (a.source === 'external' || a.source === 'system') {
    return {
      ok: true,
      data: {
        ...base, dataAsOf: null, items: [], nextCursor: null,
        note: a.source === 'external'
          ? 'Nexus records only the Meta changes made through it. meta-activity-log reads what was changed outside Nexus.'
          : META_BY_ITSELF,
      },
    }
  }
  const size = pageSize(a.limit)
  const start = decodeCursor(scope, a.cursor)
  const after = start ? new Date(String(start.values[0])) : null
  if (after && Number.isNaN(after.getTime())) throw new InvalidCursorError()
  const tools = await metaChangeTools()
  const by = a.source === 'automation' ? { approval: { decisionVia: NO_APPROVAL_VIA } }
    : a.source === 'operator' ? { approval: { OR: [{ decisionVia: null }, { decisionVia: { not: NO_APPROVAL_VIA } }] } } : {}
  const rows = await prisma.agentChange.findMany({
    where: {
      toolName: { in: [...tools.keys()] },
      executedAt: { gte: from },
      ...by,
      ...(after && start ? { OR: [{ executedAt: { lt: after } }, { executedAt: after, id: { gt: start.id } }] } : {}),
    },
    orderBy: [{ executedAt: 'desc' }, { id: 'asc' }],
    take: size + 1,
    select: {
      id: true, toolName: true, executedAt: true, reversibility: true, before: true, after: true, undoneAt: true, undoneByApprovalId: true,
      approvalId: true, planStepId: true, approval: { select: { decisionVia: true, decidedBy: true, preview: true } },
    },
  })
  const shown = rows.slice(0, size)
  const stepIds = shown.map((r) => r.planStepId).filter((id): id is string => !!id)
  const steps = stepIds.length ? await prisma.agentPlanStep.findMany({ where: { id: { in: stepIds } }, select: { id: true, position: true, preview: true } }) : []
  const stepOf = new Map(steps.map((s) => [s.id, s]))
  const undoIds = shown.map((r) => r.undoneByApprovalId).filter((id): id is string => !!id)
  const liveUndos = new Set(undoIds.length
    ? (await prisma.agentApproval.findMany({ where: { id: { in: undoIds }, status: { in: LIVE_APPROVALS } }, select: { id: true } })).map((x) => x.id)
    : [])
  const { undoStateOf } = await import('../claude-activity.service.js')
  const positionOf = (r: (typeof shown)[number]): CursorPosition => ({ values: [r.executedAt.toISOString()], id: r.id })
  const last = shown.at(-1)
  const page = fitPage({ items: shown, nextCursor: rows.length > size && last ? encodeCursor(scope, positionOf(last)) : null }, scope, positionOf)
  return {
    ok: true,
    data: {
      ...base,
      dataAsOf: iso(rows[0]?.executedAt ?? null),
      items: page.items.map((r) => {
        const step = r.planStepId ? stepOf.get(r.planStepId) : undefined
        const stamp = (r.after ?? r.before ?? {}) as { adAccountId?: unknown }
        const undo = undoStateOf(r, liveUndos)
        const decidedBy = typeof r.approval?.decidedBy === 'string' ? r.approval.decidedBy.slice(0, 120) : null
        return {
          changeId: r.id,
          at: iso(r.executedAt),
          source: r.approval?.decisionVia === NO_APPROVAL_VIA ? 'automation' as const : 'operator' as const,
          actor: decidedBy,
          decidedVia: r.approval?.decisionVia ?? null,
          action: r.toolName,
          title: tools.get(r.toolName) ?? null,
          adAccountId: typeof stamp.adAccountId === 'string' ? stamp.adAccountId : null,
          approvalId: r.approvalId,
          ...(step ? { planStep: step.position } : {}),
          note: summaryOf(step ? step.preview : r.approval?.preview),
          replaced: r.before,
          wrote: r.after,
          undoable: undo === 'possible',
          undo,
          ...(r.undoneAt ? { undoneAt: iso(r.undoneAt) } : {}),
        }
      }),
      nextCursor: page.nextCursor,
      ...(page.nextCursor ? { more: moreHint(page.items.length, null, page.cut, 'days or source') } : {}),
    },
  }
}

// ── ad-recommendations ─────────────────────────────────────────────────────────────────────────────

const REC_CATEGORIES = ['bid', 'negative', 'graduate', 'budget', 'sov', 'retail', 'rule', 'autopilot', 'tracker'] as const
/** A rule's suggested action that would pause, enable, resume or archive: never done (the Owner's no-pause rule). */
const PAUSING_ACTION = /(^|_)(pause|enable|resume|archive)(_|$)/i
const NO_PAUSE = 'Nexus never pauses, enables or archives ads on its own: to stop delivery it lowers bids (suppression). This one is information only.'
/** W3-1 — an unsellable campaign is carried out the Nexus way: its bids go to the stop bid, never a pause. */
const RETAIL_STOP = 'Nexus never pauses it: carried out (suppress-campaign, or apply-ad-recommendations with this id), every bid of the campaign goes to the stop bid; restore-campaign puts them back.'
/** W3-1 — the change tool each kind of engine recommendation is carried out with (apply-ad-recommendations does it by id). */
const SUGGESTED_TOOL: Partial<Record<(typeof REC_CATEGORIES)[number], string>> = {
  bid: 'set-target-bid', negative: 'create-negative-keyword', graduate: 'graduate-keyword', budget: 'set-campaign-budget', retail: 'suppress-campaign',
}

/** W4-9 — the change tool an autopilot plan's decision is carried out with, by its module (apply-ad-recommendations does it). */
const AUTOPILOT_TOOL: Record<string, string> = { bid: 'bulk-ad-bid-change', budget: 'set-campaign-budget', placement: 'set-placement-multipliers' }
const AUTOPILOT_HOW: Record<string, string> = {
  bid: 'Carried out with bulk-ad-bid-change: the bids the plan\'s optimizer computes at the plan\'s target when apply-ad-recommendations is asked, frozen in the request.',
  budget: 'Carried out with set-campaign-budget at the budget it names.',
  placement: 'Carried out with set-placement-multipliers: top of search nudged by its step, from the adjustment the campaign has then.',
}
const AUTOPILOT_LIFE = 'Its plan replaces its waiting decisions on every run (every 15 minutes): carry it out or dismiss it soon after reading it.'

interface RecItem {
  recommendationId: string
  from: 'engine' | 'rule' | 'autopilot' | 'tracker'
  category: (typeof REC_CATEGORIES)[number]
  severity: string
  title: string
  [key: string]: unknown
}

/**
 * W4-9 — the autopilot plans' waiting decisions, as the A.I. Bids tab lists them (listAiDecisions 'proposed'), each with
 * whether its plan still runs (a plan switched off or OFF proposes nothing new: its rows are stale). Read only.
 */
async function waitingDecisions() {
  const { listAiDecisions, decisionFacts } = await import('../../advertising/autopilot/decisions.js')
  const listed = (await listAiDecisions('proposed')).items as Array<{ id: string }>
  const facts = await decisionFacts(listed.map((d) => d.id))
  return listed.map((d) => facts.get(d.id)).filter((d): d is NonNullable<typeof d> => !!d)
}

const adRecommendations: AgentTool = {
  name: 'ad-recommendations',
  title: 'Ad recommendations',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  restrictedFields: AD_MONEY,
  input: z.object({
    channel: channelArg,
    category: z.preprocess(lower, z.enum(REC_CATEGORIES)).optional()
      .describe('only bid, negative, graduate, budget, sov (Nexus\'s own search-term checks: likely outbid, overlapping campaigns — not Amazon\'s share of voice), retail (unsellable products), rule (a rule\'s pending suggestion), autopilot (an autopilot plan\'s waiting decision) or tracker (a Keyword Tracker bid proposal)'),
    campaignId: campaignArg,
    market: marketArg,
    days: daysArg(30, 'the window the engines judge'),
    // C5 (2026-10-10) — the engines' lines for what runs, or every line (read only).
    scope: z.enum(['running', 'all']).default('running')
      .describe('running (default): the engines\' lines for running campaigns only — a bid only toward a target ACoS you set, none on a lever a product\'s brain owns or you locked, the sov checks per market, none in a market you muted; all: every line, each one the running scope leaves out saying why (outOfScope) — read only, apply-ad-recommendations carries out running lines'),
    limit: limitArg,
    cursor: cursorArg,
  }),
  description:
    'What the Amazon ad engines recommend now (bid changes, wasteful terms to negate, converting terms to graduate, '
    + 'budget changes, sov lines — Nexus\'s own search-term checks (likely outbid, overlapping campaigns), not Amazon\'s '
    + 'share of voice — and unsellable-product warnings), most severe first, then the automation rules\' '
    + 'pending suggestions, the autopilot plans\' waiting decisions (autopilot:, the A.I. Bids tab: a bid, budget or '
    + 'placement change of one campaign; an id lasts until its plan\'s next run, every 15 minutes) and the Keyword '
    + 'Tracker\'s waiting bid proposals (kt:, one bid on every target of a term in a market). Per recommendation: id, category, severity, title, why (detail), estimated impact and what '
    + 'kind of number it is, the supporting metrics, the ids a change tool takes (targetId, campaignId, '
    + 'externalCampaignId, externalAdGroupId, query) and suggestedTool when one exists. Nothing pauses: a '
    + 'recommendation to pause is shown as information (noPause); an unsellable campaign is carried out by lowering its '
    + 'bids to the stop bid. Carry recommendations out by id with apply-ad-recommendations (one change plan), or mute '
    + 'them with mute-ad-recommendations (a rule\'s suggestion, an autopilot decision or a proposal: dismiss or restore); '
    + 'one already carried out is not offered again until the data shows what the change did. By default (scope running) '
    + 'the engines\' lines are for running campaigns only: a bid toward a target ACoS you set, nothing on a lever a '
    + 'product\'s brain owns or you locked (the brain\'s own views carry those), the sov checks per market, nothing in a '
    + 'market you muted (mute-ad-recommendations with markets); leftOut counts what it left out, by why, and scope all '
    + 'lists every line with why it is left out (outOfScope). Filter by category, '
    + 'campaignId or market. The list '
    + 'is computed live: a row that moves between two pages may repeat.'
    + ' eBay (channel ebay): the eBay rules\' pending proposals (rate, bid, budget, negatives), each with its campaign, '
    + 'listing or keyword, the change it proposes and the reasoning; a proposal to pause is information only.'
    + MONEY_WORDS + PAGING,
  handler: (args) => listTool('ad-recommendations', async () => {
    if ((args as { channel?: string }).channel === 'ebay') return ebayRecommendations(args, scopeOf('ad-recommendations', args))
    const a = args as { category?: (typeof REC_CATEGORIES)[number]; campaignId?: string; market?: string; days: number; scope?: 'running' | 'all'; limit?: number; cursor?: string }
    const size = pageSize(a.limit)
    const scope = scopeOf('ad-recommendations', args)
    if (a.campaignId && !(await campaignById(a.campaignId))) return { ok: false, error: 'Campaign not found' }
    const wantEngine = !a.category || !['rule', 'autopilot', 'tracker'].includes(a.category)
    const wantRules = !a.category || a.category === 'rule'
    // W4-9 — the autopilot plans' waiting decisions (the A.I. Bids tab) and the Keyword Tracker's waiting proposals.
    const wantAutopilot = !a.category || a.category === 'autopilot'
    const wantTracker = !a.category || a.category === 'tracker'
    const [feed, suggestions, fresh, decisions, proposals] = await Promise.all([
      wantEngine ? import('../../advertising/ads-recommendations.service.js').then((m) => m.buildRecommendations({ windowDays: a.days, scope: a.scope ?? 'running' })) : Promise.resolve(null),
      wantRules
        ? pendingRuleSuggestions(500)
        : Promise.resolve([] as Awaited<ReturnType<typeof pendingRuleSuggestions>>),
      performanceAsOf(a.market ? [a.market] : []),
      wantAutopilot ? waitingDecisions() : Promise.resolve([]),
      wantTracker ? import('../../advertising/kt6-proposal.service.js').then((m) => m.waitingProposals(200)) : Promise.resolve([]),
    ])
    // W4-9 — the campaigns each proposal's targets sit in, for the campaignId filter.
    const proposalTargets = [...new Set(proposals.flatMap((p) => p.targetIds))]
    const proposalCampaignOf = new Map<string, string>(
      (proposalTargets.length ? await prisma.adTarget.findMany({ where: { id: { in: proposalTargets } }, select: { id: true, adGroup: { select: { campaignId: true } } } }) : [])
        .map((t) => [t.id, t.adGroup.campaignId] as [string, string]),
    )
    const recs: Recommendation[] = (feed?.recommendations ?? []).filter((r) => !a.category || r.category === a.category)

    // Where each recommendation lives: targets → their campaign, Amazon ids → Nexus campaigns.
    const targetIds = [
      ...recs.filter((r) => r.category === 'bid').map((r) => (r.apply?.payload as { changes?: Array<{ targetId: string }> })?.changes?.[0]?.targetId),
      ...suggestions.filter((s) => s.entityType === 'AD_TARGET').map((s) => s.entityId),
    ].filter((id): id is string => !!id)
    const targets = targetIds.length
      ? await prisma.adTarget.findMany({ where: { id: { in: [...new Set(targetIds)] } }, select: { id: true, adGroup: { select: { id: true, externalAdGroupId: true, campaignId: true } } } })
      : []
    const targetById = new Map(targets.map((t) => [t.id, t]))
    const harvestOf = (r: Recommendation) => {
      const p = r.apply?.payload as { negatives?: HarvestCandidate[]; graduations?: HarvestCandidate[] } | undefined
      return p?.negatives?.[0] ?? p?.graduations?.[0] ?? null
    }
    const campaignIdOf = (r: Recommendation): string | null => {
      const p = r.apply?.payload as { changes?: Array<{ targetId?: string; campaignId?: string }>; campaignIds?: string[] } | undefined
      if (r.category === 'bid') return targetById.get(p?.changes?.[0]?.targetId ?? '')?.adGroup.campaignId ?? null
      if (r.category === 'budget') return p?.changes?.[0]?.campaignId ?? null
      if (r.category === 'retail') return p?.campaignIds?.[0] ?? null
      return null
    }
    const index = await campaignIndex(
      [
        ...recs.map(campaignIdOf),
        ...targets.map((t) => t.adGroup.campaignId),
        ...suggestions.filter((s) => s.entityType === 'CAMPAIGN').map((s) => s.entityId),
        ...decisions.map((d) => d.campaignId),
      ].filter((id): id is string => !!id),
      recs.map((r) => harvestOf(r)?.externalCampaignId).filter((id): id is string => !!id),
    )
    const groupExternals = recs.map((r) => harvestOf(r)?.externalAdGroupId).filter((id): id is string => !!id)
    const groupByExternal = await adGroupsByExternalId(groupExternals)

    const items: Array<RecItem & { _campaign: CampaignRef | null; _campaigns?: string[]; _market?: string }> = []
    for (const r of recs) {
      const term = harvestOf(r)
      const campaign = term ? index.byExternal.get(term.externalCampaignId) ?? null : index.byId.get(campaignIdOf(r) ?? '') ?? null
      const change = (r.apply?.payload as { changes?: Array<{ targetId?: string; proposedBidCents?: number; proposedBudgetCents?: number }> } | undefined)?.changes?.[0]
      const target = change?.targetId ? targetById.get(change.targetId) : undefined
      const retail = r.category === 'retail'
      items.push({
        recommendationId: r.id,
        from: 'engine',
        category: r.category,
        severity: r.severity,
        // The retail engine words its finding as a pause; Nexus does not pause, so the title states the finding.
        title: retail ? r.title.replace(/^Pause\s+/, '') : r.title,
        detail: r.detail,
        impactCents: r.estImpactCents,
        impactKind: r.impactKind ?? null,
        metrics: r.metrics ?? null,
        ...campaignOut(campaign),
        ...(term ? { externalCampaignId: term.externalCampaignId, externalAdGroupId: term.externalAdGroupId, adGroupId: groupByExternal.get(term.externalAdGroupId)?.id ?? null, query: term.query } : {}),
        ...(change?.targetId ? { targetId: change.targetId, adGroupId: target?.adGroup.id ?? null, externalAdGroupId: target?.adGroup.externalAdGroupId ?? null } : {}),
        ...(change?.proposedBidCents != null ? { proposedBidCents: change.proposedBidCents } : {}),
        ...(change?.proposedBudgetCents != null ? { proposedBudgetCents: change.proposedBudgetCents } : {}),
        suggestedTool: SUGGESTED_TOOL[r.category] ?? null,
        ...(retail ? { noPause: RETAIL_STOP } : {}),
        ...(r.outOfScope ? { outOfScope: r.outOfScope } : {}),
        _campaign: campaign,
      })
    }
    for (const s of suggestions) {
      const action = (s.proposedAction as { type?: unknown } | null)?.type
      const actionType = typeof action === 'string' ? action : s.proposedKey.split(':')[0]
      const target = s.entityType === 'AD_TARGET' ? targetById.get(s.entityId) : undefined
      const campaign = s.entityType === 'CAMPAIGN' ? index.byId.get(s.entityId) ?? null : target ? index.byId.get(target.adGroup.campaignId) ?? null : null
      const pausing = PAUSING_ACTION.test(actionType)
      items.push({
        recommendationId: `rule:${s.id}`,
        from: 'rule',
        category: 'rule',
        severity: 'medium',
        title: `${s.ruleName ?? 'A rule'} suggests ${actionType} on ${s.entityName ?? s.entityId}`,
        suggestionId: s.id,
        rule: { id: s.ruleId, name: s.ruleName },
        family: familyOfRow(s),
        action: actionType,
        entity: { type: s.entityType, id: s.entityId, name: s.entityName },
        ...campaignOut(campaign),
        ...(target ? { targetId: target.id, adGroupId: target.adGroup.id, externalAdGroupId: target.adGroup.externalAdGroupId } : {}),
        proposedChange: s.proposedAction,
        firstSeenAt: iso(s.createdAt),
        lastSeenAt: iso(s.lastSeenAt),
        ...(pausing ? { noPause: NO_PAUSE } : {}),
        _campaign: campaign,
      })
    }
    // W4-9 — the autopilot plans' decisions, then the Keyword Tracker's proposals (they span the term's campaigns).
    for (const d of decisions) {
      const campaign = d.campaignId ? index.byId.get(d.campaignId) ?? null : null
      const tool = AUTOPILOT_TOOL[d.module] ?? null
      items.push({
        recommendationId: `autopilot:${d.id}`,
        from: 'autopilot',
        category: 'autopilot',
        severity: 'medium',
        title: `Autopilot plan${d.planName ? ` "${d.planName}"` : ''} proposes ${d.action} on ${campaign?.name ?? d.campaignId ?? 'no campaign'}`,
        decisionId: d.id,
        plan: { id: d.planId, name: d.planName, on: d.planOn },
        module: d.module,
        action: d.action,
        ...campaignOut(campaign),
        proposedChange: { before: d.before, after: d.after },
        detail: d.reason,
        proposedAt: d.at,
        suggestedTool: d.planOn ? tool : null,
        ...(tool && d.planOn ? { carriedOut: `${AUTOPILOT_HOW[d.module]} ${AUTOPILOT_LIFE}` } : {}),
        ...(!d.planOn ? { stale: 'Its plan is off, so this proposal is stale: dismiss it (mute-ad-recommendations, op dismiss).' } : {}),
        ...(d.planOn && !tool ? { noApply: `The ${d.module} module has no way to be carried out: dismiss it (mute-ad-recommendations, op dismiss).` } : {}),
        _campaign: campaign,
      })
    }
    for (const p of proposals) {
      items.push({
        recommendationId: `kt:${p.id}`,
        from: 'tracker',
        category: 'tracker',
        severity: 'medium',
        title: `Keyword Tracker proposal: one bid on "${p.term}" in ${p.marketplace} (${p.targetIds.length} target${p.targetIds.length === 1 ? '' : 's'})`,
        proposalId: p.id,
        query: p.term,
        market: p.marketplace,
        proposedBidCents: p.requestedBidCents,
        targets: p.targetIds.length,
        campaigns: p.actionableCampaigns,
        targetIds: p.targetIds.slice(0, 50),
        commitmentCents: p.commitmentCents,
        detail: p.confirmationText,
        ...(p.ceilingVerdict !== 'NO_CEILING' ? { note: p.ceilingMessage } : {}),
        proposedAt: iso(p.proposedAt),
        suggestedTool: 'bulk-ad-bid-change',
        carriedOut: 'Carried out with bulk-ad-bid-change, its one bid on each of its targets, after the Keyword Tracker\'s own checks (the same targets as when it was raised, its spend ceiling today with the request\'s other proposals), checked again before it writes.',
        _campaign: null,
        _campaigns: [...new Set<string>(p.targetIds.map((t) => proposalCampaignOf.get(t) ?? '').filter(Boolean))],
        _market: p.marketplace,
      })
    }
    const scoped: RecItem[] = items
      .filter((item) => (!a.campaignId || item._campaign?.id === a.campaignId || !!item._campaigns?.includes(a.campaignId))
        && (!a.market || (item._campaign?.marketplace ?? item._market) === a.market))
      .map(({ _campaign, _campaigns, _market, ...item }) => item)
    const page = rankedPage(scoped, (item) => shortId(item.recommendationId), size, scope, a.cursor)
    return {
      ok: true,
      data: {
        dataAsOf: fresh.lastDay,
        windowDays: a.days,
        counts: Object.fromEntries(REC_CATEGORIES.map((c) => [c, scoped.filter((item) => item.category === c).length])),
        items: page.items,
        nextCursor: page.nextCursor,
        total: page.total,
        // C5 — which engine lines: the running scope and what it left out (scope all lists them), and the markets muted.
        ...(feed ? { scope: feed.scope ?? 'running' } : {}),
        ...(feed?.leftOut?.total ? { leftOut: { ...feed.leftOut, see: 'counted over the engines\' whole feed, before this call\'s filters; scope all lists each with why (outOfScope)' } } : {}),
        ...(feed?.mutedMarkets?.length ? { mutedMarkets: feed.mutedMarkets } : {}),
        ...(page.nextCursor ? { more: moreHint(page.items.length, page.total, page.cut, 'category, campaignId or market') } : {}),
      },
    }
  }),
}

/** A13 gap — the eBay rules' pending proposals as recommendations. */
async function ebayRecommendations(args: Record<string, unknown>, scope: string): Promise<ToolResult> {
  const a = args as { category?: string; campaignId?: string; market?: string; limit?: number; cursor?: string }
  if (a.category && a.category !== 'rule') return { ok: false, error: 'eBay recommendations are the eBay rules\' proposals: only category rule applies.' }
  const size = pageSize(a.limit)
  if (a.campaignId && !(await ebayCampaignCensus()).some((c) => c.id === a.campaignId)) return { ok: false, error: 'Campaign not found' }
  const market = ebayMarket(a.market)
  const proposals = await ebayPendingProposals(200)
  const items = proposals
    .map((p) => {
      const ref = (p.entityRef ?? {}) as { campaignId?: string; externalCampaignId?: string; campaignName?: string; listingId?: string; keywordId?: string; keywordText?: string; marketplace?: string }
      const pausing = /(^|_)(pause|end|archive)(_|$)/i.test(p.kind)
      return {
        recommendationId: `ebay:${p.id}`,
        from: 'rule' as const,
        category: 'rule' as const,
        severity: 'medium',
        title: `${p.kind.replace(/_/g, ' ')} on ${ref.campaignName ?? ref.externalCampaignId ?? 'a campaign'}${ref.keywordText ? ` (“${ref.keywordText}”)` : ref.listingId ? ` (listing ${ref.listingId})` : ''}`,
        proposalId: p.id,
        kind: p.kind,
        campaignId: ref.campaignId ?? null,
        externalCampaignId: ref.externalCampaignId ?? null,
        campaignName: ref.campaignName ?? null,
        market: ref.marketplace ?? null,
        ...(ref.listingId ? { listingId: ref.listingId } : {}),
        ...(ref.keywordId ? { keywordId: ref.keywordId, keywordText: ref.keywordText ?? null } : {}),
        proposedChange: p.proposedAction,
        why: p.reasoning,
        estimatedImpact: p.estimatedImpact,
        firstSeenAt: iso(p.createdAt),
        expiresAt: iso(p.expiresAt),
        ...(pausing ? { noPause: NO_PAUSE } : {}),
      }
    })
    .filter((item) => (!a.campaignId || item.campaignId === a.campaignId) && (!market || item.market === market))
  const page = rankedPage(items, (item) => shortId(item.recommendationId), size, scope, a.cursor)
  return {
    ok: true,
    data: {
      channel: 'ebay',
      dataAsOf: iso(proposals[0]?.createdAt ?? null),
      items: page.items,
      nextCursor: page.nextCursor,
      total: page.total,
      ...(page.nextCursor ? { more: moreHint(page.items.length, page.total, page.cut, 'campaignId or market') } : {}),
    },
  }
}

// ── ebay-ad-details (T4) ───────────────────────────────────────────────────────────────────────────

/*
 * One tool with a `view`, not `channel: ebay` on ad-targets or ad-search-terms: an eBay listing's ad rate and its
 * break-even, and a Priority campaign's ad groups, have no Amazon twin in those tools, and ad-search-terms reads search
 * queries, not keywords. Each row names the eBay change tools' own ids under their own names.
 */
const EBAY_DETAIL_VIEWS = ['listings', 'ad-groups', 'keywords'] as const
type EbayDetailView = (typeof EBAY_DETAIL_VIEWS)[number]
/** The most campaigns one call opens when no campaignId names one: each is read whole, as its page reads it. */
const EBAY_DETAIL_CAMPAIGN_CAP = 40
/** This read's money beyond AD_MONEY and the shared registry: an ad rate, a break-even rate and how the two compare. */
const EBAY_DETAIL_MONEY = { ...AD_MONEY, ratePct: ADSPEND, breakEvenPct: ADSPEND, rateAboveBreakEven: ADSPEND } as const
const EBAY_ENDED = new Set(['ENDED', 'DELETED', 'ARCHIVED'])
const isPriority = (fundingModel: string | null | undefined) => fundingModel === 'COST_PER_CLICK'

interface EbayDetailArgs { view: EbayDetailView; campaignId?: string; market?: string; adGroupId?: string; search?: string; days: number; limit?: number; cursor?: string }
type EbayDetailRow = { id: string; sort: string[]; row: Record<string, unknown> }

/** Why set-ebay-ad-rates refuses this campaign's listings (its own refusals, in its words); null when it sets them. */
function ebayRateNote(c: EbayCampaignDetail['campaign']): string | null {
  if (EBAY_ENDED.has(String(c.status).toUpperCase())) return 'ended: eBay changes nothing in an ended campaign.'
  if (isPriority(c.fundingModel)) return 'Priority (cost-per-click): its listings have no ad rate; its keyword bids change with ebay-keywords-change.'
  if (c.isRulesBased) return 'rules-based: eBay applies the campaign\'s own rate to the listings its rules select, so its ads have no rate of their own here.'
  if (c.adRateStrategy === 'DYNAMIC') return 'dynamic rates: eBay sets each ad\'s rate every day under the campaign\'s cap.'
  return null
}

async function ebayAdDetails(a: EbayDetailArgs, scope: string): Promise<ToolResult> {
  const size = pageSize(a.limit)
  const market = ebayMarket(a.market)
  const census = await ebayCampaignCensus()
  let picked: typeof census
  if (a.campaignId) {
    const one = census.find((c) => c.id === a.campaignId)
    if (!one) return { ok: false, error: 'Campaign not found' }
    if (market && one.marketplace !== market) return { ok: false, error: `${one.name} is a ${one.marketplace} campaign, not ${market}: leave market out, or name a campaign of ${market}.` }
    if (a.view !== 'listings' && !isPriority(one.fundingModel)) {
      return { ok: false, error: `${one.name} is a General (cost-per-sale) campaign: it has no ad groups or keywords (those belong to Priority, cost-per-click, campaigns). Its promoted listings and their rates: view listings.` }
    }
    picked = [one]
  } else {
    if (a.adGroupId) return { ok: false, error: 'adGroupId needs campaignId: the eBay campaign the ad group belongs to (ebayCampaignId in this read\'s rows).' }
    picked = census.filter((c) => (!market || c.marketplace === market)
      && (EBAY_MANAGED_STATUSES as readonly string[]).includes(c.status)
      && (a.view === 'listings' || isPriority(c.fundingModel)))
  }
  picked.sort((x, y) => x.marketplace.localeCompare(y.marketplace) || x.name.localeCompare(y.name) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
  const opened = picked.slice(0, EBAY_DETAIL_CAMPAIGN_CAP)
  const { range } = windowOf(a.days)
  const [details, currencies, configured, asOf] = await Promise.all([
    Promise.all(opened.map((c) => ebayCampaignDetail(c.id, { startDate: range.sinceStr, endDate: range.untilStr }))),
    ebayMarketCurrencies(),
    configuredEbayCurrency(),
    ebayPerformanceAsOf(market ?? (a.campaignId ? opened[0]?.marketplace : undefined)),
  ])
  const budgetCurrency = new Map(opened.map((c) => [c.id, c.budgetCurrency]))
  const campaigns = details.filter((d): d is EbayCampaignDetail => d != null).map((d) => ({
    d,
    currency: budgetCurrency.get(d.campaign.id) ?? currencies.get(d.campaign.marketplace) ?? configured(d.campaign.marketplace),
    // An unmapped market's break-even would be read from Italy's listings (the page's fallback): never shown.
    knownMarket: Object.prototype.hasOwnProperty.call(EBAY_MARKETPLACE_SHORT, d.campaign.marketplace),
  }))
  if (a.adGroupId && !campaigns.some(({ d }) => d.adGroups.some((g) => g.id === a.adGroupId))) return { ok: false, error: 'Ad group not found' }

  const needle = a.search?.toLowerCase()
  const has = (text: string | null | undefined) => !needle || (text ?? '').toLowerCase().includes(needle)
  const rows: EbayDetailRow[] = []
  for (const { d, currency, knownMarket } of campaigns) {
    const c = d.campaign
    const where = { ebayCampaignId: c.id, campaignName: c.name, market: c.marketplace, currency }
    if (a.view === 'listings') {
      const groupName = new Map(d.adGroups.map((g) => [g.id, g.name]))
      for (const ad of d.ads) {
        if ((a.adGroupId && ad.adGroupId !== a.adGroupId) || !(has(ad.title) || has(ad.listingId))) continue
        const ratePct = isPriority(c.fundingModel) ? null : ad.bidPercentage ?? c.bidPercentage
        const breakEvenPct = knownMarket ? ad.breakEvenAdRatePct : null
        rows.push({
          id: ad.id,
          sort: [c.marketplace, c.name, ad.title ?? '', ad.listingId ?? ''],
          row: {
            ebayItemId: ad.listingId,
            ...(ad.listingId ? {} : { inventoryReference: ad.inventoryReference }),
            title: ad.title,
            productId: ad.productId,
            ...where,
            fundingModel: c.fundingModel,
            ebayAdGroupId: ad.adGroupId,
            adGroupName: ad.adGroupId ? groupName.get(ad.adGroupId) ?? null : null,
            status: ad.status,
            hiddenReason: ad.hiddenReason,
            listingEnded: ad.listingEnded,
            priceCents: ad.priceCents,
            quantity: ad.quantity,
            ratePct,
            rateFrom: ratePct == null ? null : ad.bidPercentage != null ? 'listing' : 'campaign',
            breakEvenPct,
            economics: knownMarket ? ad.economicsStatus : null,
            rateAboveBreakEven: ratePct != null && breakEvenPct != null ? ratePct > breakEvenPct : null,
            metrics: ebayTotals(ad.metrics),
          },
        })
      }
    } else if (a.view === 'ad-groups') {
      for (const g of d.adGroups) {
        if ((a.adGroupId && g.id !== a.adGroupId) || !has(g.name)) continue
        rows.push({
          id: g.id,
          sort: [c.marketplace, c.name, g.name],
          row: {
            ebayAdGroupId: g.id,
            externalAdGroupId: g.externalAdGroupId,
            name: g.name,
            status: g.status,
            ...where,
            defaultBidCents: g.defaultBidCents,
            counts: {
              keywords: d.keywords.filter((k) => k.adGroupId === g.id).length,
              listings: d.ads.filter((x) => x.adGroupId === g.id).length,
              negativeKeywords: d.negativeKeywords.filter((n) => n.adGroupId === g.id).length,
            },
          },
        })
      }
    } else {
      for (const k of d.keywords) {
        if ((a.adGroupId && k.adGroupId !== a.adGroupId) || !has(k.text)) continue
        rows.push({
          id: k.id,
          sort: [c.marketplace, c.name, k.adGroupName ?? '', k.text, k.matchType],
          row: {
            ebayKeywordId: k.id,
            externalKeywordId: k.externalKeywordId,
            text: k.text,
            matchType: k.matchType,
            status: k.status,
            bidCents: k.bidCents,
            bidLocked: k.bidCents == null,
            ebayAdGroupId: k.adGroupId,
            adGroupName: k.adGroupName,
            ...where,
            metrics: { ...ebayTotals(k.metrics), cpcCents: k.metrics.avgCpcCents },
          },
        })
      }
    }
  }
  const page = keysetPage(rows, (r): CursorPosition => ({ values: r.sort, id: r.id }), size, scope, a.cursor)
  const scopeWords = a.view === 'listings' ? 'running, paused or system-paused eBay campaign' : 'running, paused or system-paused Priority (cost-per-click) eBay campaign'
  return {
    ok: true,
    data: {
      channel: 'ebay',
      view: a.view,
      dataAsOf: asOf,
      window: { from: range.sinceStr, to: range.untilStr, days: range.days },
      attribution: 'eBay counts a sale after any click on the ad (any-click attribution); ACoS = ad fees ÷ those sales.',
      writes: ebayWrites(),
      campaigns: campaigns.map(({ d, currency }) => {
        const c = d.campaign
        const note = a.view === 'listings' ? ebayRateNote(c) : null
        return {
          ebayCampaignId: c.id,
          externalCampaignId: c.externalCampaignId,
          name: c.name,
          market: c.marketplace,
          fundingModel: c.fundingModel,
          targetingType: c.targetingType ?? null,
          status: c.status,
          currency,
          ratePct: isPriority(c.fundingModel) ? null : c.bidPercentage,
          adRateStrategy: c.adRateStrategy ?? null,
          rulesBased: c.isRulesBased,
          ...(note ? { rateNote: note } : {}),
          settingsSyncedAt: iso(c.lastEntitySyncAt),
        }
      }),
      items: page.items.map((r) => r.row),
      nextCursor: page.nextCursor,
      total: rows.length,
      ...(campaigns.length === 0 ? { empty: `No ${scopeWords}${market ? ` in ${market}` : ''}.` } : {}),
      ...(picked.length > EBAY_DETAIL_CAMPAIGN_CAP
        ? { truncated: `Only the first ${EBAY_DETAIL_CAMPAIGN_CAP} of ${picked.length} campaigns (by market and name) were opened: narrow with market or campaignId.` }
        : {}),
      ...(page.nextCursor ? { more: moreHint(page.items.length, rows.length, page.cut, 'campaignId, adGroupId, market or search') } : {}),
    },
  }
}

const ebayAdDetailsTool: AgentTool = {
  name: 'ebay-ad-details',
  title: 'eBay ad details',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  restrictedFields: EBAY_DETAIL_MONEY,
  input: z.object({
    view: z.preprocess(lower, z.enum(EBAY_DETAIL_VIEWS)).default('listings')
      .describe('listings (default) = the promoted listings with their ad rate and break-even; ad-groups = the ad groups of Priority (cost-per-click) campaigns; keywords = their keywords with bid, status and metrics'),
    campaignId: z.string().trim().min(1).max(64).optional()
      .describe('only this eBay campaign: its Nexus id (campaignId in ad-campaigns with channel ebay; the ebayCampaignId the eBay change tools take). Without it: every running, paused or system-paused campaign (of the market, when given)'),
    market: z.string().trim().toUpperCase().min(2).max(20).optional()
      .describe('only this eBay marketplace: EBAY_IT, EBAY_DE, EBAY_FR, EBAY_ES, EBAY_GB or the short code (IT, DE, FR, ES, UK or GB)'),
    adGroupId: z.string().trim().min(1).max(64).optional()
      .describe('with campaignId: only this ad group, by its Nexus id (ebayAdGroupId in the rows)'),
    search: z.string().trim().min(1).max(100).optional()
      .describe('only listings whose title or item id, ad groups whose name, or keywords whose text contains this'),
    days: daysArg(30, 'the metrics window'),
    limit: limitArg,
    cursor: cursorArg,
  }),
  description:
    'What eBay Promoted Listings campaigns hold, as their page in Nexus shows it (stored data, no eBay call). Every row '
    + 'names the ids the eBay change tools take, under the same names: ebayCampaignId, ebayItemId (the eBay item id), '
    + 'ebayAdGroupId and ebayKeywordId. view listings: each promoted listing with its title, product, status (eBay '
    + 'hides an out-of-stock ad: hiddenReason), price and stock, its ad rate (ratePct: its own, or the campaign\'s when '
    + 'it has none — rateFrom; null in a Priority campaign), its break-even rate (breakEvenPct: the highest rate at '
    + 'which a sale still covers the product cost and eBay\'s fees; null when Nexus does not know it, and economics says '
    + 'why: MISSING_COGS no product cost, MISSING_PRICE no price, ESTIMATED fees estimated), whether the rate is above '
    + 'it, and impressions, clicks, sold units, ad fees (as spend), sales and ACoS over the window. view ad-groups: a '
    + 'Priority campaign\'s ad groups with their default bid and how many keywords, listings and negatives each holds. '
    + 'view keywords: each keyword with its text, match type, status, bid (null and bidLocked under dynamic bidding), '
    + 'its ad group, and impressions, clicks, sold units, ad fees, sales, ACoS and cost per click. campaigns lists the '
    + 'campaigns read with their rate, strategy and, for listings, why set-ebay-ad-rates cannot change their rates '
    + '(rateNote). Filter by campaignId, market, adGroupId or text.' + MONEY_WORDS + PAGING,
  handler: (args) => listTool('ebay-ad-details', async () => ebayAdDetails(args as unknown as EbayDetailArgs, scopeOf('ebay-ad-details', args))),
}

// ── google-ad-details (Google Ads step 1b, read only) ──────────────────────────────────────────────

/*
 * One tool with a `view`, as ebay-ad-details: each view is one of the Google Ads page's own reads (R5–R15), answered from
 * what the daily read stored. A list is read whole from its service (following the service's own pages, up to
 * GOOGLE_DETAIL_READ_CAP rows) and paged here, so this tool's cursor is its own: a keyset of names, or, for the lists
 * ranked by cost, only a place — never an amount.
 */
const GOOGLE_DETAIL_VIEWS = [
  'ad-groups', 'keywords', 'negatives', 'search-terms', 'brand-split', 'asset-groups', 'products', 'acts-on-its-own',
  'recommendations', 'alerts', 'disapprovals',
] as const
type GoogleDetailView = (typeof GOOGLE_DETAIL_VIEWS)[number]

/** What each view takes besides the account. A filter a view does not take is refused, never ignored. */
const GOOGLE_VIEW_TAKES: Readonly<Record<GoogleDetailView, { campaignId: boolean; days: boolean; search: boolean; pages: boolean }>> = {
  'ad-groups': { campaignId: true, days: true, search: true, pages: true },
  keywords: { campaignId: true, days: true, search: true, pages: true },
  negatives: { campaignId: true, days: false, search: true, pages: true },
  'search-terms': { campaignId: true, days: true, search: true, pages: true },
  'brand-split': { campaignId: false, days: true, search: false, pages: false },
  'asset-groups': { campaignId: true, days: true, search: false, pages: true },
  products: { campaignId: true, days: true, search: true, pages: true },
  'acts-on-its-own': { campaignId: false, days: false, search: false, pages: true },
  recommendations: { campaignId: true, days: false, search: false, pages: true },
  alerts: { campaignId: false, days: false, search: false, pages: true },
  disapprovals: { campaignId: true, days: false, search: false, pages: true },
}

/**
 * This read's money beyond AD_MONEY and the shared registry: bids and targets, a recommendation's expected effect and an
 * alert's figures (each stripped whole), as the Google Ads routes strip them (PLAN-1B M12).
 */
const GOOGLE_DETAIL_MONEY = {
  ...AD_MONEY,
  cpcBidCents: ADSPEND,
  effectiveCpcBidCents: ADSPEND,
  targetCpaCents: ADSPEND,
  targetRoas: ADSPEND,
  impact: ADSPEND,
  numbers: ADSPEND,
} as const

/** Never under `note`: AD_MONEY strips that key as prose that quotes amounts. */
const GOOGLE_DETAIL_WRITES = {
  mode: 'approval',
  text: 'Google Ads changes go through the Nexus Google Ads change tools (set-google-…): each is a request a person approves in Nexus. Google\'s recommendations are not applied by Nexus.',
} as const
const GOOGLE_DETAIL_DAYS = 30
/** The most rows one call reads from a list service; beyond it the answer says how many it left out. */
const GOOGLE_DETAIL_READ_CAP = 2000
/** Rows asked of a list service per call while reading it whole. */
const GOOGLE_SERVICE_PAGE = 500
const GOOGLE_EDITOR_UNSEEN = 'Changes made with Google Ads Editor never reach Google\'s change history, so Nexus cannot list them.'
const GOOGLE_SEARCH_TERM_SCOPE = 'Only search terms with at least one click in the window are read: a term with impressions and no click is not in this list.'

interface GoogleDetailArgs { view: GoogleDetailView; accountId?: string; campaignId?: string; days?: number; search?: string; limit?: number; cursor?: string }

/** Why these arguments do not fit the view, or null when they do. */
function googleDetailRefusal(a: GoogleDetailArgs): string | null {
  const takes = GOOGLE_VIEW_TAKES[a.view]
  if (a.campaignId && !takes.campaignId) return `View ${a.view} reads the whole account: leave campaignId out.`
  if (a.days != null && !takes.days) return `View ${a.view} has no window of days: leave days out.`
  if (a.search && !takes.search) return `View ${a.view} takes no search: leave search out.`
  if ((a.limit != null || a.cursor) && !takes.pages) return `View ${a.view} is one short answer with no pages: leave limit and cursor out.`
  return null
}

/** Why there is nothing to read in Google Ads for this business, in words; null when an account is chosen. */
function googleNoAccount(account: GoogleAccount | null): string | null {
  if (!account) return 'Google is not connected for this business: a person connects Google in Nexus (Settings › Channels › Google) and chooses the Google Ads account Nexus reads.'
  if (!account.ads) return 'No Google Ads account is chosen for this business yet: a person chooses one in Nexus (Settings › Channels › Google).'
  return null
}

interface GoogleReadState { readAt: string | null; lastStatus: string | null; lastError: string | null }

/** "Not read yet" in words, with why when the last try failed or was skipped; null when Nexus has read it. */
function googleNotRead(read: GoogleReadState | null | undefined, what: string): string | null {
  if (read?.readAt) return null
  const why = read?.lastStatus === 'FAILED' && read.lastError
    ? ` The last try failed: ${read.lastError}`
    : read?.lastStatus === 'SKIPPED_BUDGET' ? ' The last read left it out to stay within the day\'s Google reads.' : ''
  return `Nexus has not read the ${what} from Google yet.${why}`
}

/** Why a list holds no rows (not read yet, or nothing matches), in words; null when it holds some. */
function googleListEmpty(read: GoogleReadState | null | undefined, total: number, filtered: boolean, one: string, many: string): string | null {
  return googleNotRead(read, many) ?? (total === 0 ? (filtered ? `No ${one} matches these filters.` : `No ${one} in this account.`) : null)
}

interface ServicePage { items: unknown[]; nextCursor: string | null; total: number }

/** A list service read whole: its own pages followed up to GOOGLE_DETAIL_READ_CAP rows, in the service's order. */
async function readEvery<P extends ServicePage>(read: (paging: { limit: number; cursor?: string }) => Promise<P>) {
  const first = await read({ limit: GOOGLE_SERVICE_PAGE })
  const items: P['items'][number][] = [...first.items]
  let next = first.nextCursor
  while (next && items.length < GOOGLE_DETAIL_READ_CAP) {
    const page = await read({ limit: GOOGLE_SERVICE_PAGE, cursor: next })
    items.push(...page.items)
    next = page.items.length ? page.nextCursor : null
  }
  const rows = items.slice(0, GOOGLE_DETAIL_READ_CAP)
  const total = Math.max(first.total, items.length)
  return { first, rows, total }
}

/** The list part of an answer: the page, the totals, and what the reader may do for more (narrowBy null: no filter). */
function googleListOut(page: { items: unknown[]; nextCursor: string | null; cut: number }, read: number, total: number, narrowBy: string | null) {
  const trimmed = page.cut ? ` (cut from ${page.items.length + page.cut} to stay within the size limit)` : ''
  return {
    items: page.items,
    nextCursor: page.nextCursor,
    total,
    ...(read < total ? { truncated: `Only the first ${read} of ${total} rows were read: narrow with ${narrowBy ?? 'a filter'}.` } : {}),
    ...(page.nextCursor
      ? { more: narrowBy ? moreHint(page.items.length, total, page.cut, narrowBy) : `${total} rows; this page has ${page.items.length}${trimmed}. To go on, call again with cursor set to nextCursor.` }
      : {}),
  }
}

/** The window of a view with numbers, as ads-overview names it (provisionalFrom: Google can still add conversions). */
const googleWindowOut = (window: { from: string; to: string; provisionalFrom: string | null }, coverage: { daysInWindow: number }) =>
  ({ from: window.from, to: window.to, days: coverage.daysInWindow, provisionalFrom: window.provisionalFrom })
const GOOGLE_DETAIL_COUNTING = `${GOOGLE_COUNTING} Google can still add late conversions to recent days: figures on or after provisionalFrom may still change.`
/** Alerts worst first. */
const GOOGLE_SEVERITY_RANK: Readonly<Record<string, number>> = { danger: 0, warn: 1, info: 2 }

async function googleAdDetails(a: GoogleDetailArgs, scope: string): Promise<Record<string, unknown>> {
  const context = await googleAdsAccount(a.accountId)
  const takes = GOOGLE_VIEW_TAKES[a.view]
  const base = {
    channel: 'google' as const,
    view: a.view,
    writes: GOOGLE_DETAIL_WRITES,
    account: context.account ? googleAccountOut(context.account) : null,
  }
  const missing = googleNoAccount(context.account)
  if (missing) return { ...base, ...(takes.pages ? { items: [], nextCursor: null, total: 0 } : {}), empty: missing }
  try {
    return await googleDetailView(a, scope, base, context.account!.connectionId)
  } catch (error) {
    // The answer is always about the account named (or the chosen one): a campaign of another Google Ads account of the
    // business is not in it, and the refusal says how to read that one.
    const several = context.accounts.filter((other) => other.ads).length > 1
    if (error instanceof GoogleAdsReadError && error.status === 404 && a.campaignId && !a.accountId && several) {
      throw new GoogleAdsReadError(404, `${error.message}. If it is a campaign of another Google Ads account of this business, name that account with accountId.`)
    }
    throw error
  }
}

/** One view, read for one Google account (its connection id). */
async function googleDetailView(a: GoogleDetailArgs, scope: string, base: Record<string, unknown>, connectionId: string): Promise<Record<string, unknown>> {
  const size = pageSize(a.limit)
  const account = { connectionId }
  const days = a.days ?? GOOGLE_DETAIL_DAYS
  const filtered = !!(a.campaignId || a.search)
  const numbersOf = (read: GoogleReadState, what: string) => {
    const unread = googleNotRead(read, what)
    return unread ? { numbersNotRead: `${unread} Their metrics are null (not read), never 0.` } : {}
  }

  switch (a.view) {
    case 'ad-groups': {
      const { first, rows, total } = await readEvery((paging) => googleAdsAdGroups({ ...account, days, campaignId: a.campaignId, search: a.search, ...paging }))
      const page = keysetPage(rows, (g): CursorPosition => ({ values: [g.name], id: g.adGroupId }), size, scope, a.cursor)
      const empty = googleListEmpty(first.read, total, filtered, 'ad group', 'ad groups')
      return {
        ...base, currency: first.currency, dataAsOf: first.dataAsOf, window: googleWindowOut(first.window, first.coverage),
        coverage: first.coverage, counting: GOOGLE_DETAIL_COUNTING, read: first.read, numbersRead: first.numbersRead,
        ...numbersOf(first.numbersRead, 'ad groups\' numbers'),
        ...googleListOut(page, rows.length, total, 'campaignId or search'), ...(empty ? { empty } : {}),
      }
    }
    case 'keywords': {
      const { first, rows, total } = await readEvery((paging) => googleAdsKeywords({ ...account, days, campaignId: a.campaignId, search: a.search, sort: 'spend', ...paging }))
      const page = rankedPage(rows, (k) => k.keywordId, size, scope, a.cursor)
      const empty = googleListEmpty(first.read, total, filtered, 'keyword', 'keywords')
      return {
        ...base, currency: first.currency, dataAsOf: first.dataAsOf, window: googleWindowOut(first.window, first.coverage),
        coverage: first.coverage, counting: GOOGLE_DETAIL_COUNTING, order: 'by cost in the window, highest first',
        read: first.read, numbersRead: first.numbersRead, ...numbersOf(first.numbersRead, 'keywords\' numbers'),
        ...googleListOut(page, rows.length, total, 'campaignId or search'), ...(empty ? { empty } : {}),
      }
    }
    case 'negatives': {
      const { first, rows, total } = await readEvery((paging) => googleAdsNegatives({ ...account, campaignId: a.campaignId, search: a.search, ...paging }))
      const page = keysetPage(rows, (n): CursorPosition => ({
        values: [n.level, n.campaignName ?? '', n.adGroupName ?? n.listName ?? '', n.text ?? ''], id: n.negativeId,
      }), size, scope, a.cursor)
      const reads = [first.read.adGroup, first.read.campaign, first.read.lists]
      const empty = reads.every((r) => !r.readAt) ? googleNotRead(first.read.adGroup, 'negative keywords')
        : total === 0 ? (filtered ? 'No negative keyword matches these filters.' : 'No negative keyword in this account.') : null
      return { ...base, read: first.read, lists: first.lists, ...googleListOut(page, rows.length, total, 'campaignId or search'), ...(empty ? { empty } : {}) }
    }
    case 'search-terms': {
      const { first, rows, total } = await readEvery((paging) => googleAdsSearchTerms({ ...account, days, campaignId: a.campaignId, search: a.search, sort: 'spend', ...paging }))
      const page = rankedPage(rows, (t) => t.termId, size, scope, a.cursor)
      const empty = googleListEmpty(first.read, total, filtered, 'search term', 'search terms')
      return {
        ...base, currency: first.currency, dataAsOf: first.dataAsOf, window: googleWindowOut(first.window, first.coverage),
        coverage: first.coverage, counting: GOOGLE_DETAIL_COUNTING, order: 'by cost in the window, highest first',
        scope: first.scope, scopeText: GOOGLE_SEARCH_TERM_SCOPE, brandTerms: first.brandTerms, brandText: googleBrandText(first.brandTerms.terms.length),
        read: first.read, ...googleListOut(page, rows.length, total, 'campaignId or search'), ...(empty ? { empty } : {}),
      }
    }
    case 'brand-split': {
      const split = await googleAdsBrandSplit({ ...account, days })
      const empty = googleNotRead(split.read, 'search terms')
      return {
        ...base, currency: split.currency, dataAsOf: split.dataAsOf, window: googleWindowOut(split.window, split.coverage),
        coverage: split.coverage, counting: GOOGLE_DETAIL_COUNTING, scopeText: GOOGLE_SEARCH_TERM_SCOPE,
        brandTerms: split.brandTerms, brandText: googleBrandText(split.brandTerms.terms.length),
        splitText: 'Per campaign type (ALL, then Search, Shopping, Performance Max): the total, the search terms that are brand, those that are not, '
          + 'and what is not in the search-term list (total minus the search terms: clicks on terms Google does not name, or without a click). '
          + 'Coverage counts only the days Nexus read both the campaign numbers and the search terms.',
        read: split.read, rows: split.rows, ...(empty ? { empty } : {}),
      }
    }
    case 'asset-groups': {
      const { first, rows, total } = await readEvery((paging) => googleAdsAssetGroups({ ...account, days, campaignId: a.campaignId, ...paging }))
      const page = keysetPage(rows, (g): CursorPosition => ({ values: [g.name], id: g.assetGroupId }), size, scope, a.cursor)
      const empty = googleListEmpty(first.read, total, filtered, 'asset group', 'asset groups')
      return {
        ...base, currency: first.currency, dataAsOf: first.dataAsOf, window: googleWindowOut(first.window, first.coverage),
        coverage: first.coverage, counting: GOOGLE_DETAIL_COUNTING, read: first.read, numbersRead: first.numbersRead,
        ...numbersOf(first.numbersRead, 'asset groups\' numbers'),
        ...googleListOut(page, rows.length, total, 'campaignId'), ...(empty ? { empty } : {}),
      }
    }
    case 'products': {
      const { first, rows, total } = await readEvery((paging) => googleAdsProducts({ ...account, days, campaignId: a.campaignId, search: a.search, sort: 'spend', ...paging }))
      const page = rankedPage(rows, (p) => p.productKey, size, scope, a.cursor)
      const empty = first.numbersRead.readAt || first.statusRead.readAt
        ? (total === 0 ? (filtered ? 'No product matches these filters.' : 'No product in this account.') : null)
        : googleNotRead(first.statusRead, 'products')
      const statusNotRead = googleNotRead(first.statusRead, 'products\' status at Google')
      return {
        ...base, currency: first.currency, dataAsOf: first.dataAsOf, window: googleWindowOut(first.window, first.coverage),
        coverage: first.coverage, counting: GOOGLE_DETAIL_COUNTING, order: 'by cost in the window, highest first',
        numbersRead: first.numbersRead, statusRead: first.statusRead, ...numbersOf(first.numbersRead, 'products\' numbers'),
        ...(statusNotRead ? { statusNotRead: `${statusNotRead} Their status is null (not read).` } : {}),
        ...googleListOut(page, rows.length, total, 'campaignId or search'), ...(empty ? { empty } : {}),
      }
    }
    case 'acts-on-its-own': {
      const acts = await googleAdsActsOnItsOwn({ ...account })
      const changes = acts.outsideChanges.items
      const page = keysetPage(changes, (c): CursorPosition => ({ values: [c.changedAt], id: shortId(JSON.stringify(c)) }), size, scope, a.cursor, [true])
      return {
        ...base, read: acts.read, autoApply: acts.autoApply,
        ...(acts.autoApply ? {} : { autoApplyNotRead: googleNotRead(acts.read.autoApply, 'recommendation types Google applies on its own') }),
        campaigns: acts.campaigns,
        outsideChanges: {
          nexusWrites: acts.outsideChanges.nexusWrites,
          coveredFrom: acts.outsideChanges.coveredFrom,
          coveredThrough: acts.outsideChanges.coveredThrough,
          bySource: acts.outsideChanges.bySource,
        },
        unseen: GOOGLE_EDITOR_UNSEEN,
        // items: the changes made outside Nexus, newest first (at most 200, as the page shows them).
        ...googleListOut(page, changes.length, changes.length, null),
      }
    }
    case 'recommendations': {
      const recs = await googleAdsRecommendations({ ...account, campaignId: a.campaignId })
      const page = keysetPage(recs.items, (r): CursorPosition => ({ values: [r.typeText, r.campaignName ?? ''], id: r.recommendationId }), size, scope, a.cursor)
      const empty = googleNotRead(recs.read, 'recommendations')
        ?? (recs.items.length === 0 ? (a.campaignId ? 'Google has no recommendation for this campaign.' : 'Google has no recommendation for this account.') : null)
      return {
        ...base, currency: recs.currency, read: recs.read, byType: recs.byType,
        recommendationsText: 'Read only: Nexus applies and dismisses none of Google\'s recommendations; a person does that in Google Ads. autoApplied: Google applied it on its own.',
        ...googleListOut(page, recs.items.length, recs.items.length, 'campaignId'), ...(empty ? { empty } : {}),
      }
    }
    case 'alerts': {
      const { googleAdsAlerts: readAlerts } = await import('../../marketing/google-ads/alerts.service.js')
      const alerts: Awaited<ReturnType<typeof googleAdsAlerts>> = await readAlerts({ ...account })
      const page = keysetPage(alerts.items, (al): CursorPosition => ({
        values: [GOOGLE_SEVERITY_RANK[al.severity] ?? 3, al.kind, al.campaignName ?? ''], id: al.alertId,
      }), size, scope, a.cursor)
      return {
        ...base, checkedAt: alerts.checkedAt, notChecked: alerts.notChecked,
        ...googleListOut(page, alerts.items.length, alerts.items.length, null),
        ...(alerts.items.length === 0 ? { empty: 'Nothing needs a look in Google Ads right now (notChecked names what could not be checked).' } : {}),
      }
    }
    case 'disapprovals': {
      const issues = await googleAdsDisapprovals({ ...account, campaignId: a.campaignId })
      const rows = [
        ...issues.ads.map((ad) => ({ kind: 'ad' as const, ...ad })),
        ...issues.products.map((product) => ({ kind: 'product' as const, ...product })),
      ]
      const page = keysetPage(rows, (r): CursorPosition => (r.kind === 'ad'
        ? { values: ['ad', r.campaignName ?? '', r.adGroupName ?? ''], id: `ad:${r.adId}` }
        : { values: ['product', r.title ?? '', r.itemId, r.status], id: `product:${r.itemId}` }), size, scope, a.cursor)
      const empty = !issues.read.ads.readAt && !issues.read.products.readAt
        ? googleNotRead(issues.read.ads, 'ads\' and products\' review status')
        : rows.length === 0 ? 'No ad is disapproved or limited, and no product is not eligible or limited.' : null
      return {
        ...base, read: issues.read,
        ...(issues.truncated ? { truncated: 'Google holds more issues than Nexus keeps (500 ads and 500 products): the rest are not listed.' } : {}),
        ...googleListOut(page, rows.length, rows.length, 'campaignId'), ...(empty ? { empty } : {}),
      }
    }
  }
}

/** What `brand` means in this answer, in words. */
function googleBrandText(terms: number): string {
  return terms > 0
    ? 'brand true = the search term holds one of the business\'s protected terms that apply to every market (brandTerms); a person changes them in Nexus (brandTerms.editHref).'
    : 'No protected terms that apply to every market are set, so no search term is marked brand or not brand (brand null, never "not brand"); a person sets them in Nexus (brandTerms.editHref).'
}

const googleAdDetailsTool: AgentTool = {
  name: 'google-ad-details',
  title: 'Google Ads details',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  restrictedFields: GOOGLE_DETAIL_MONEY,
  input: z.object({
    view: z.preprocess(lower, z.enum(GOOGLE_DETAIL_VIEWS))
      .describe('what to read: ad-groups | keywords | negatives | search-terms | brand-split | asset-groups | products | acts-on-its-own | recommendations | alerts | disapprovals'),
    accountId: z.string().trim().min(1).max(64).optional()
      .describe('the Google account to read, by its connectionId (channel-connections); default the business\'s chosen Google Ads account'),
    campaignId: z.string().trim().min(1).max(64).optional()
      .describe('only this Google campaign: campaignId from ad-campaigns with channel google. Views ad-groups, keywords, negatives, search-terms, asset-groups, products, recommendations and disapprovals'),
    days: z.coerce.number().int().min(1).max(MAX_DAYS).optional()
      .describe(`views with numbers (ad-groups, keywords, search-terms, brand-split, asset-groups, products): the last N days, ending yesterday in the account's time zone (default ${GOOGLE_DETAIL_DAYS}, max ${MAX_DAYS})`),
    search: z.string().trim().min(1).max(100).optional()
      .describe('only rows whose text contains this: ad group names, keyword and negative text, search terms, product titles or item ids (views ad-groups, keywords, negatives, search-terms, products)'),
    limit: limitArg,
    cursor: cursorArg,
  }),
  description:
    'Google Ads, read only: what the Google Ads account a person chose for this business holds, as the Google Ads page in '
    + 'Nexus shows it (stored data, no Google call). view ad-groups: each ad group with its status, bid or target and '
    + 'numbers. keywords: each keyword with match type, status, quality score, bid and numbers, by cost. negatives: the '
    + 'negative keywords of ad groups, campaigns and negative keyword lists (lists: each list and its campaigns; '
    + 'accountLevel true = the account-level list, never attached to a campaign; appliesToAccount true = Google applies the '
    + 'list to the whole account (in force), false = read and not in use, null = not read yet — never say a list is in '
    + 'force unless appliesToAccount is true). '
    + 'search-terms: the search terms with at least one click, each marked brand or not (brand = a protected term of the '
    + 'business for every market; none set, brand is null), by cost. brand-split: cost, clicks and conversions split into '
    + 'brand, not brand and not in the search-term list, per campaign type. asset-groups: Performance Max asset groups '
    + 'with ad strength and numbers. products: Shopping products with their status at Google (no issue, limited, not '
    + 'eligible and why), the Nexus product with the same SKU, and numbers, by cost. acts-on-its-own: what Google does by '
    + 'itself — the recommendation types it applies on its own (auto-apply), per campaign AI Max, campaign broad match, '
    + 'search partners, display expansion, final URL expansion, text customization, dynamic search ads and brand '
    + 'exclusions (a flag null = not read yet) — and the changes made outside Nexus, with who made them. recommendations: '
    + 'Google\'s recommendations with their expected effect (impact). alerts: what needs a look (spend pace, month pace, '
    + 'no conversions, tracking stopped, disapproved ads, products not eligible, limited ads, auto-apply on, changed by '
    + 'Google, settings changed, moved to AI Max) and the checks that could not run (notChecked). disapprovals: '
    + 'disapproved or limited ads and products not eligible or limited, with Google\'s reasons. A part Nexus has not read '
    + 'yet says so (readAt null): say "not read yet", never 0; a day outside a read range has no numbers (coverage). '
    + GOOGLE_COUNTING + ' Amounts are minor units (cents) of the account\'s currency, never converted; a person without '
    + 'the ad-spend money permission gets the same answer without the amounts (bids, targets, impact and an alert\'s '
    + 'numbers too).' + PAGING + ' This tool reads what Nexus stored; changes go through the Google Ads change tools '
    + '(set-google-…, writes.mode approval), each a request a person approves in Nexus, and google-ads-live reads the '
    + 'account live from Google. Nexus applies none of Google\'s recommendations by itself: apply-google-recommendations and '
    + 'dismiss-google-recommendations ask to apply or dismiss them, each a request a person approves.',
  handler: (args) => listTool('google-ad-details', async () => {
    const a = args as unknown as GoogleDetailArgs
    const refused = googleDetailRefusal(a)
    if (refused) return { ok: false, error: refused }
    return googleRead(() => googleAdDetails(a, scopeOf('google-ad-details', args)))
  }),
}

export const ADS_READ_TOOLS: AgentTool[] = [adsOverview, adCampaigns, adTargets, adPurchasedProducts, adSearchTerms, adChanges, adRecommendations, ebayAdDetailsTool, googleAdDetailsTool]
