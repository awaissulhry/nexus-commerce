/**
 * Meta ads, step 11 (2026-10-21) — Claude's dataset (Meta pixel) reads. Read only: nothing here changes Meta, and the
 * gateway lets only GET through.
 *
 *   meta-datasets  the chosen ad account's pixels and the portfolio's, one pixel's settings and base code, who may use
 *                  it, its event volume, WHO SENDS its events (browser or server, which partner, deduplication — the
 *                  Owner's decision D2: view sources answers "does the shop platform already send Purchase by browser
 *                  AND server?" with yes / no / unknown), Event Match Quality and the rest of Meta's Dataset Quality
 *                  API, offline and older quality, diagnostics, the Conversions API Gateway, custom conversions (with
 *                  Meta's 100-per-account count), event rules and parameter extractors, legacy offline sets and
 *                  uploads. Master rows AU-020, SG-001…SG-005, SG-020, SG-023, SG-025, SG-030…SG-034, SG-036…SG-040,
 *                  SG-043, SG-045…SG-056, SG-082, SG-085…SG-089, SG-097, SG-101, SG-115.
 * The caller never names a Graph path, field or parameter: each view sends a fixed request (live-datasets.ts).
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolResult } from '../tool-types.js'
import { MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import { MetaReadError } from '../../marketing/meta-ads/errors.js'
import {
  ACTION_SOURCES, CONVERSION_SCOPES, CONVERSION_STATS_AGGREGATIONS, DATASET_VIEWS, datasetsView, DIAGNOSTIC_CHECKS, EVENT_SOURCES, MAX_STATS_HOURS,
  PORTFOLIO_LISTS, RAW_FIRE_FILTERS, STATS_AGGREGATIONS, UPLOAD_SORTS, type DatasetView,
} from '../../marketing/meta-ads/live-datasets.js'

const ADSPEND = FIELDS.financialsAdspendView
/**
 * Money keys of meta-datasets: the ad spend tied to an event and to each ad set using it (Dataset Quality API), a custom
 * conversion's default value, and Meta's US-dollar amounts of a custom conversion's stats.
 */
export const META_DATASETS_MONEY = { spendCents: ADSPEND, defaultValueCents: ADSPEND, usdAmounts: ADSPEND } as const

const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v)
const upper = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : v)
const metaId = (what: string) => z.string().trim().regex(/^\d{1,25}$/).optional().describe(what)
const connectionArg = z.string().trim().min(1).max(64).optional().describe('the Meta connection (from meta-connection); default: this business\'s one')
const str = (v: unknown) => (typeof v === 'string' ? v : null)
/** An event name as Meta writes it: a standard event (Purchase) or a custom one (letters, digits, _ and spaces). */
const eventArg = z.string().trim().regex(/^[A-Za-z0-9_][A-Za-z0-9_ .-]{0,99}$/).optional()

async function guarded(work: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { ok: true, data: await work() }
  } catch (err) {
    if (err instanceof MetaLiveRefusal || err instanceof MetaReadError) return { ok: false, error: err.message }
    throw err
  }
}

const metaDatasets: AgentTool = {
  name: 'meta-datasets',
  title: 'Meta datasets (pixels)',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  restrictedFields: META_DATASETS_MONEY,
  input: z.object({
    view: z.preprocess(lower, z.enum(DATASET_VIEWS)).default('list').describe(
      'list (default) | portfolio | detail | access | stats | sources (who sends: browser / server, D2) | quality | quality-offline | quality-legacy | diagnostics | gateway | custom-conversions | event-setup | legacy-offline',
    ),
    pixelId: metaId('the pixel (dataset) of the chosen ad account; default: its only pixel'),
    list: z.preprocess(lower, z.enum(PORTFOLIO_LISTS)).optional().describe('portfolio: all (default) | owned | client | pending (shared with the business, waiting for acceptance)'),
    search: z.string().trim().min(1).max(100).optional().describe('portfolio list all: pixels whose name contains this (Meta\'s name_filter)'),
    event: eventArg.describe('sources: the event to check (default Purchase); stats: the event for custom_data_field; quality: only this event; diagnostics: the event for events-last-fired, recent-events, raw-fires'),
    aggregation: z.enum(STATS_AGGREGATIONS).optional().describe('stats: how Meta counts (event — default —, event_total_counts, event_source, device_type, device_os, browser_type, host, url, url_by_rule, match_keys, had_pii, pixel_fire, event_detection_method, event_value_count, event_processing_results, custom_data_field)'),
    eventSource: z.preprocess(upper, z.enum(EVENT_SOURCES)).optional().describe('stats: only WEB_ONLY (the browser pixel) or SERVER_ONLY (a server: the Conversions API)'),
    agentName: z.string().trim().regex(/^[a-z0-9][a-z0-9_.-]{0,39}$/).optional().describe('sources, stats, quality: only events a partner sent with this partner_agent name (lower case, e.g. the shop platform\'s; Meta documents no list of names)'),
    hours: z.number().int().min(1).max(MAX_STATS_HOURS).optional().describe(`stats, sources, custom-conversions stats: the last N hours (default 168 = 7 days, at most ${MAX_STATS_HOURS} = 28 days); diagnostics event-log: at most 168; legacy-offline: uploads of this window`),
    check: z.preprocess(lower, z.enum(DIAGNOSTIC_CHECKS)).optional().describe('diagnostics: issues (default) | events-last-fired | domains-last-fired | recent-events | event-log | raw-fires | delivery-recommendations | item-prices | microdata | collaborative-ads'),
    domains: z.array(z.string().trim().regex(/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i)).min(1).max(50).optional().describe('diagnostics domains-last-fired: the shop\'s host names (shop.example)'),
    lookbackSeconds: z.number().int().min(60).max(604800).optional().describe('diagnostics recent-events: how far back, in seconds (default one day, at most 7 days)'),
    filterType: z.enum(RAW_FIRE_FILTERS).optional().describe('diagnostics raw-fires: filter by device_type, event_detection_method, host or url (with filter)'),
    filter: z.string().trim().min(1).max(200).optional().describe('diagnostics raw-fires: the value of filterType'),
    catalogId: metaId('diagnostics microdata: the catalog to compare the page microdata with'),
    actionSource: z.preprocess(upper, z.enum(ACTION_SOURCES)).optional().describe('diagnostics collaborative-ads: WEBSITE or PHYSICAL_STORE'),
    currentDomain: z.string().trim().min(1).max(260).optional().describe('event-setup: only the parameter extractors of this web address (https://shop.example)'),
    scope: z.preprocess(lower, z.enum(CONVERSION_SCOPES)).optional().describe('custom-conversions: account (default) | business (the portfolio\'s) | dataset (built on pixelId) | one | stats (customConversionId)'),
    customConversionId: metaId('custom-conversions one / stats: the custom conversion (of the chosen ad account)'),
    conversionAggregation: z.enum(CONVERSION_STATS_AGGREGATIONS).optional().describe('custom-conversions stats: count (default), device_type, host, pixel_fire, url, unmatched_count, usd_amount, unmatched_usd_amount'),
    uploadTag: z.string().trim().min(1).max(100).optional().describe('legacy-offline: only uploads with this tag'),
    sortBy: z.preprocess(upper, z.enum(UPLOAD_SORTS)).optional().describe('legacy-offline: sort the uploads by this'),
    order: z.preprocess(upper, z.enum(['ASCENDING', 'DESCENDING'])).optional().describe('legacy-offline: the sort order'),
    maxRows: z.number().int().min(1).max(500).optional().describe('at most this many rows (default 200)'),
    connectionId: connectionArg,
  }),
  description:
    'The business\'s Meta datasets (pixels), read live from Meta. view list (default): the chosen ad account\'s pixels '
    + '(Meta keeps pixels on ad accounts). portfolio: the business portfolio\'s pixels (all, owned, client, pending) — one '
    + 'not on the chosen ad account is its id only. detail: settings, automatic matching, cookies, the base code (to '
    + 'compare with the shop), entries and match rate, and the audiences built on it. access: the ad accounts it is '
    + 'connected to (one another business in Nexus uses: its id only — its events may then mix both businesses\' sales), '
    + 'partner businesses, people and system users. stats: event volume per hour for up to 28 days, by event, source '
    + '(WEB_ONLY browser / SERVER_ONLY Conversions API), device, browser, host, URL, match keys and more. sources — the '
    + 'check before Nexus would ever send events: for Purchase (or event) it answers browserAndServer yes / no / unknown '
    + 'from Meta\'s browser and server counts, whether Meta deduplicates them (dedup keys, coverage), which partner sends '
    + 'by server (agentName, the last uploading app, a Conversions API Gateway), and the gap, if any; it lists what Meta '
    + 'does not give. quality: Event Match Quality (out of 10) per event with match keys and fixes, additional conversions, '
    + 'coverage, deduplication, freshness, value problems, delay, and the spend and ad sets tied to each event. '
    + 'quality-offline, quality-legacy: offline events and the older edges. diagnostics: issues, last fired, recent '
    + 'events, the event log, raw fires (page addresses without their query; never the event body), delivery '
    + 'recommendations, item prices, microdata, collaborative ads. gateway: the Conversions API Gateway. '
    + 'custom-conversions: the account\'s (with Meta\'s 100-per-account count), the portfolio\'s, a pixel\'s, one, its '
    + 'stats — a rule cannot change after creation. event-setup: event rules and parameter extractors (read only: Meta\'s '
    + 'public API cannot change them; Meta\'s own MCP or Events Manager does). legacy-offline: old offline sets and '
    + 'uploads. Only the chosen ad account\'s pixels and custom conversions are read. Read only; money in minor units.',
  async handler(args): Promise<ToolResult> {
    return guarded(() => datasetsView({
      connectionId: str(args.connectionId),
      view: (args.view ?? 'list') as DatasetView,
      pixelId: str(args.pixelId),
      list: (args.list as (typeof PORTFOLIO_LISTS)[number] | undefined) ?? null,
      search: str(args.search),
      event: str(args.event),
      aggregation: str(args.aggregation),
      eventSource: str(args.eventSource),
      agentName: str(args.agentName),
      hours: typeof args.hours === 'number' ? args.hours : null,
      check: str(args.check),
      domains: (args.domains as string[] | undefined) ?? null,
      lookbackSeconds: typeof args.lookbackSeconds === 'number' ? args.lookbackSeconds : null,
      filterType: str(args.filterType),
      filter: str(args.filter),
      catalogId: str(args.catalogId),
      actionSource: str(args.actionSource),
      currentDomain: str(args.currentDomain),
      scope: str(args.scope),
      customConversionId: str(args.customConversionId),
      conversionAggregation: str(args.conversionAggregation),
      uploadTag: str(args.uploadTag),
      sortBy: str(args.sortBy),
      order: (args.order as 'ASCENDING' | 'DESCENDING' | undefined) ?? null,
      maxRows: typeof args.maxRows === 'number' ? args.maxRows : undefined,
    }))
  },
}

export const META_ADS_DATASETS_TOOLS: AgentTool[] = [metaDatasets]
