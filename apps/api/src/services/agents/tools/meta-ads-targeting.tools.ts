/**
 * Meta ads, step 9 (2026-10-21) — Claude's targeting reads for Meta (Facebook + Instagram ads). Read only: nothing here
 * changes Meta, and the gateway lets only GET through.
 *
 *   meta-targeting-search  find what can be targeted: locations (and their details, a radius), interests (and
 *                          suggestions), behaviours / demographics / devices by class, schools, majors, employers, job
 *                          titles, languages (Graph's /search); every kind at once, related suggestions, the whole tree,
 *                          broad categories, place page sets, saved keywords and an ad set's location clusters (the chosen
 *                          ad account's own edges). Master rows TG-001…TG-017, TG-020, TG-022.
 *   meta-targeting-check   check before a change: interests still valid, options valid, retired options (and the ad sets
 *                          holding them, or touched by a Meta-side change), a custom audience's special-ad-category
 *                          eligibility, reach and delivery estimates (account or ad set, before → after), a
 *                          marketing-message estimate, and the targeting in Meta's own words. Master rows AS-020, TG-006,
 *                          TG-023…TG-026, TG-030…TG-032, TG-034…TG-037.
 * The caller never names a Graph path, field or parameter: each kind / check sends a fixed request (live-targeting.ts),
 * and a targeting spec is parsed by an allow-list (unknown keys refused, every list capped).
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolResult } from '../tool-types.js'
import { MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import { MetaReadError } from '../../marketing/meta-ads/errors.js'
import {
  CAMPAIGN_OBJECTIVES, CATEGORY_CLASSES, CHECKS, COUNTRY_GROUPS, DEPRECATION_TYPES, DETAILED_TYPES, LOCATION_TYPES, OPTIMIZATION_GOALS, PACING_TYPES,
  PROMOTED_OBJECT, REGULATED_CATEGORIES, SEARCH_KINDS, SPECIAL_AD_CATEGORIES, TARGETING_SPEC, targetingCheck, targetingSearch,
  type SearchKind, type TargetingCheck,
} from '../../marketing/meta-ads/live-targeting.js'

const ADSPEND = FIELDS.financialsAdspendView
/** Money keys of meta-targeting-check (the marketing-message estimate): the amounts asked and Meta's cost estimate. */
export const META_TARGETING_MONEY = {
  bidAmountCents: ADSPEND, lifetimeBudgetCents: ADSPEND, dailyBudgetCents: ADSPEND,
  estimateCostMetaUnits: ADSPEND, estimateCostLowerBoundMetaUnits: ADSPEND, estimateCostUpperBoundMetaUnits: ADSPEND,
} as const

const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v)
const metaId = (what: string) => z.string().trim().regex(/^\d{1,25}$/).optional().describe(what)
const digitsList = (max: number, what: string) => z.array(z.string().trim().regex(/^\d{1,25}$/)).min(1).max(max).optional().describe(what)
const connectionArg = z.string().trim().min(1).max(64).optional().describe('the Meta connection (from meta-connection); default: this business\'s one')
const localeArg = z.string().trim().regex(/^[a-z]{2}_[A-Z]{2}$/).optional().describe('names in this language where Meta has them (language_TERRITORY, e.g. it_IT); default: the ad account\'s')
const optionList = (max: number, what: string) => z.array(z.object({
  type: z.enum(DETAILED_TYPES).describe('the kind of option'), id: z.string().trim().regex(/^\d{1,25}$/).describe('its Meta id'),
}).strict()).min(1).max(max).optional().describe(what)

async function guarded(work: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { ok: true, data: await work() }
  } catch (err) {
    if (err instanceof MetaLiveRefusal || err instanceof MetaReadError) return { ok: false, error: err.message }
    throw err
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : null)

// ── meta-targeting-search ────────────────────────────────────────────────────────────────────────────────────────

const metaTargetingSearch: AgentTool = {
  name: 'meta-targeting-search',
  title: 'Meta targeting search',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  input: z.object({
    kind: z.preprocess(lower, z.enum(SEARCH_KINDS)).describe(
      'location | location-details | radius | interest | interest-suggestions | category | school | major | employer | job-title | language '
      + '(Meta\'s targeting search) | any | suggest | browse | broad-categories | place-page-sets | saved-keywords | location-cluster (the chosen ad account\'s)',
    ),
    q: z.string().trim().max(100).optional().describe('the words to search for (location, interest, school, major, employer, job-title, language, any); location and language take an empty q with a large limit to list everything'),
    locationTypes: z.array(z.enum(LOCATION_TYPES)).min(1).max(7).optional().describe('location: only these kinds (country, country_group, region, city, zip, geo_market, electoral_district — US only)'),
    countryCode: z.string().trim().regex(/^[A-Za-z]{2}$/).optional().describe('location: only in this country (ISO code, e.g. IT)'),
    regionId: z.string().trim().regex(/^\d{1,12}$/).optional().describe('location: only in this region (its key)'),
    matchCountryCode: z.boolean().optional().describe('location with locationTypes [country]: match q against country codes instead of names'),
    locations: z.object({
      countries: z.array(z.string().trim().regex(/^[A-Za-z]{2}$/)).min(1).max(50).optional().describe('country codes'),
      regions: z.array(z.string().trim().regex(/^\d{1,12}$/)).min(1).max(50).optional().describe('region keys'),
      cities: z.array(z.string().trim().regex(/^\d{1,15}$/)).min(1).max(50).optional().describe('city keys'),
      zips: z.array(z.string().trim().regex(/^[A-Z]{2}:[A-Za-z0-9 -]{1,12}$/)).min(1).max(50).optional().describe('postcode keys, e.g. IT:20121'),
      countryGroups: z.array(z.enum(COUNTRY_GROUPS)).min(1).max(20).optional().describe('country groups'),
    }).strict().optional().describe('location-details: the places to describe, by key (from kind location)'),
    latitude: z.number().min(-90).max(90).optional().describe('radius: the point\'s latitude'),
    longitude: z.number().min(-180).max(180).optional().describe('radius: the point\'s longitude'),
    distanceUnit: z.enum(['mile', 'kilometer']).optional().describe('radius: the unit of the answer'),
    locale: localeArg,
    interestNames: z.array(z.string().trim().min(1).max(100)).min(1).max(50).optional().describe('interest-suggestions: interest names (exact, case-sensitive)'),
    categoryClass: z.enum(CATEGORY_CLASSES).optional().describe('category: interests, behaviors, demographics (all of them), life_events, industries, income, family_statuses, user_device, user_os'),
    limitType: z.enum(DETAILED_TYPES).optional().describe('any, suggest, browse: only this kind of option'),
    regulatedCategories: z.array(z.enum(REGULATED_CATEGORIES)).min(1).max(5).optional().describe('any, suggest, browse: the special ad category of the campaign, so only options it allows come back'),
    objective: z.enum(CAMPAIGN_OBJECTIVES).optional().describe('any: the campaign objective'),
    vettedOnly: z.boolean().optional().describe('any: only interests Meta pre-vetted (Meta\'s allow_only_fat_head_interests), e.g. for a special ad category campaign'),
    options: optionList(50, 'suggest: the options to get suggestions for ({type, id}, from a search)'),
    customOnly: z.boolean().optional().describe('broad-categories: only custom categories'),
    adSetId: metaId('location-cluster: the ad set (of the chosen account) whose targeting uses the cluster'),
    locationClusterId: metaId('location-cluster: the cluster to read (from that ad set)'),
    placePageSetId: metaId('place-page-sets: one place page set of the chosen account (default: the list)'),
    limit: z.number().int().min(1).max(1000).optional().describe('at most this many results (default 25; suggest at most 45)'),
    connectionId: connectionArg,
  }),
  description:
    'Find what a Meta ad set can target, live from Meta. Meta\'s targeting search: kind location (countries, regions, '
    + 'cities, postcodes, markets; target by key, the name may change), location-details (Meta\'s details of places by '
    + 'key), radius (Meta\'s suggested radius around a point), interest, interest-suggestions (from interest names), '
    + 'category (the whole list of a class: behaviours, demographics, life events, industries, income, family statuses, '
    + 'devices, operating systems; demographics depend on the system user\'s home country and can be empty), school, '
    + 'major, employer, job-title, language (its key goes in locales). The chosen ad account\'s own: any (every kind of '
    + 'detailed targeting at once; without limitType Meta drops employers, job titles, majors and schools under 2,000 '
    + 'people), suggest (related options, at most 45), browse (the whole tree as a flat list; parent is the key above), '
    + 'broad-categories, place-page-sets, saved-keywords, location-cluster (the big postcode lists one of its ad sets uses). '
    + 'Meta says a search does not return every option and options get renamed: keep the id. Saved keywords and one place '
    + 'page set by id are only in Meta\'s SDK, and Meta documents no fields for a location cluster: when Meta refuses, the '
    + 'answer says so (its postcodes are in Ads Manager). Check options before a change with meta-targeting-check. '
    + 'Read only; only the chosen ad account and its own ad sets are read.',
  async handler(args): Promise<ToolResult> {
    return guarded(() => targetingSearch({
      connectionId: str(args.connectionId),
      kind: args.kind as SearchKind,
      q: str(args.q),
      locationTypes: (args.locationTypes as string[] | undefined) ?? null,
      countryCode: str(args.countryCode),
      regionId: str(args.regionId),
      matchCountryCode: args.matchCountryCode === true,
      locations: (args.locations as never) ?? null,
      latitude: typeof args.latitude === 'number' ? args.latitude : null,
      longitude: typeof args.longitude === 'number' ? args.longitude : null,
      distanceUnit: (args.distanceUnit as 'mile' | 'kilometer' | undefined) ?? null,
      locale: str(args.locale),
      interestNames: (args.interestNames as string[] | undefined) ?? null,
      categoryClass: str(args.categoryClass),
      limitType: str(args.limitType),
      regulatedCategories: (args.regulatedCategories as string[] | undefined) ?? null,
      objective: str(args.objective),
      vettedOnly: args.vettedOnly === true,
      options: (args.options as Array<{ type: string; id: string }> | undefined) ?? null,
      customOnly: args.customOnly === true,
      adSetId: str(args.adSetId),
      locationClusterId: str(args.locationClusterId),
      placePageSetId: str(args.placePageSetId),
      limit: typeof args.limit === 'number' ? args.limit : null,
    }))
  },
}

// ── meta-targeting-check ─────────────────────────────────────────────────────────────────────────────────────────

const metaTargetingCheck: AgentTool = {
  name: 'meta-targeting-check',
  title: 'Meta targeting check',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  restrictedFields: META_TARGETING_MONEY,
  input: z.object({
    check: z.preprocess(lower, z.enum(CHECKS)).describe(
      'interests | options | status | retired-adsets | affected-adsets | audience-special-category | reach | delivery | message-delivery | describe',
    ),
    interestIds: digitsList(100, 'interests: interest ids to check (best: Meta renames interests)'),
    interestNames: z.array(z.string().trim().min(1).max(100)).min(1).max(100).optional().describe('interests, options: interest names to check (case-sensitive for interests)'),
    options: optionList(100, 'options: the options to check ({type, id}; best)'),
    optionIds: digitsList(250, 'options: ids to check (only ids Meta knows uniquely); status: option ids whose retirement to check'),
    isExclusion: z.boolean().optional().describe('options: check them for excluding people (default: for including)'),
    locale: localeArg,
    deprecation: z.enum(DEPRECATION_TYPES).optional().describe('retired-adsets: deprecating (default: ad sets holding an option being retired) | delivery_paused (ad sets Meta stopped for it)'),
    audienceId: metaId('audience-special-category: a custom audience of the chosen ad account'),
    specialAdCategories: z.array(z.enum(SPECIAL_AD_CATEGORIES)).min(1).max(3).optional().describe('audience-special-category: the campaign\'s special ad categories'),
    countries: z.array(z.string().trim().regex(/^[A-Za-z]{2}$/)).min(1).max(30).optional().describe('audience-special-category: the countries the campaign reaches (ISO codes)'),
    targeting: TARGETING_SPEC.optional().describe(
      'reach, delivery, message-delivery, describe: a Meta targeting spec, allow-listed (unknown keys are refused): '
      + 'geo_locations / excluded_geo_locations {countries, regions, cities, zips, places, custom_locations, geo_markets, '
      + 'country_groups, subcities, neighborhoods, large_geo_areas, medium_geo_areas, small_geo_areas, metro_areas, '
      + 'electoral_districts, location_types home | recent — never recent in an exclusion; a location cluster: name the ad '
      + 'set that uses it instead}, place_page_set_ids (the chosen account\'s own), age_min, age_max, '
      + 'genders [1 men, 2 women], locales, interests, behaviors, life_events, industries, income, family_statuses, '
      + 'user_adclusters, work_*, education_*, flexible_spec, exclusions {work_employers} (Meta refuses other detailed '
      + 'exclusions since v22: exclude custom audiences instead), custom_audiences / excluded_custom_audiences (the chosen '
      + 'account\'s own), placements (publisher_platforms, facebook_positions, instagram_positions, …, whatsapp_positions '
      + 'status — with Instagram story — | marketing_messages), devices, '
      + 'targeting_automation {advantage_audience}, targeting_relaxation_types, targeting_optimization',
    ),
    optimizationGoal: z.enum(OPTIMIZATION_GOALS).optional().describe('delivery (required for an account estimate), message-delivery: the ad set\'s optimization goal (app goals are not estimated: they need an app and store URL)'),
    promotedObject: PROMOTED_OBJECT.optional().describe('delivery, message-delivery: what the ad set promotes — the chosen Page (page_id), the chosen Instagram account (instagram_profile_id), or a pixel of the chosen ad account (pixel_id) with its event (custom_event_type)'),
    adSetId: metaId('delivery, message-delivery: estimate this ad set of the chosen account (with targeting: before → after, the after with THAT WHOLE targeting in place of the ad set\'s own); status: check the options it holds; describe: its targeting in words'),
    adId: metaId('describe: this ad\'s targeting in words'),
    bidAmountCents: z.number().int().min(1).max(100_000_000).optional().describe('message-delivery: bid in minor units of the account currency (its smallest unit: cents for EUR, yen for JPY; minorUnitDigits in the answer)'),
    lifetimeBudgetCents: z.number().int().min(1).max(10_000_000_000).optional().describe('message-delivery: lifetime budget in minor units of the account currency'),
    dailyBudgetCents: z.number().int().min(1).max(10_000_000_000).optional().describe('message-delivery, account estimate only: daily budget in minor units of the account currency'),
    directSend: z.boolean().optional().describe('message-delivery, account estimate only: a direct-send marketing-message campaign (Meta\'s is_direct_send_campaign)'),
    lifetimeDays: z.number().int().min(1).max(365).optional().describe('message-delivery: how many days the campaign runs'),
    pacingType: z.enum(PACING_TYPES).optional().describe('message-delivery: pacing'),
    maxRows: z.number().int().min(1).max(1000).optional().describe('retired-adsets, affected-adsets: at most this many ad sets (default 200)'),
    connectionId: connectionArg,
  }),
  description:
    'Check Meta targeting before a change, live from Meta (nothing changes). check interests: are these interests still '
    + 'valid (by id: Meta renames them). options: Meta\'s own validation of options ({type, id}), also for excluding people. '
    + 'status: is an option being retired (in use, being retired — an ad set holding it is rejected at its next edit '
    + 'unless it is removed —, retired, not for exclusions), for option ids or every option an ad set holds (adSetId). '
    + 'retired-adsets: the chosen account\'s ad sets that hold a retiring option, or that Meta paused for one. '
    + 'affected-adsets: ad sets Meta lists as affected by a change on its side (only in Meta\'s SDK; when Meta refuses, '
    + 'the answer says so). audience-special-category: may this custom audience go in a housing, employment or financial '
    + 'campaign in these countries. reach: people a spec reaches (a range; -1 from Meta means no estimate for a custom '
    + 'audience, not an empty one). delivery: monthly active people for a spec and goal, or an ad set as it is and with '
    + 'THIS WHOLE targeting (before → after; Meta does not merge a partial spec, so name all it should keep) — Meta no '
    + 'longer estimates results per day for a budget (removed in v26, every version from 2026-10-27); app goals are not '
    + 'estimated. message-delivery: a WhatsApp marketing-message estimate (the account must be onboarded to marketing '
    + 'messages — the answer says its activation status — and the spec use whatsapp_positions marketing_messages; Meta '
    + 'does not document the cost\'s unit, so it is given as Meta answers it). describe: who sees it in Meta\'s own words, '
    + 'for a spec, an ad set or an ad. Only the chosen ad account, its ad sets, ads and custom audiences, its Page, '
    + 'Instagram account and pixels are used. Read only; money in minor units of the account currency (its smallest unit '
    + 'as Nexus counts it: cents for EUR, yen for JPY — minorUnitDigits says how many decimals).',
  async handler(args): Promise<ToolResult> {
    return guarded(() => targetingCheck({
      connectionId: str(args.connectionId),
      check: args.check as TargetingCheck,
      interestIds: (args.interestIds as string[] | undefined) ?? null,
      interestNames: (args.interestNames as string[] | undefined) ?? null,
      options: (args.options as Array<{ type: string; id: string }> | undefined) ?? null,
      optionIds: (args.optionIds as string[] | undefined) ?? null,
      isExclusion: args.isExclusion === true,
      locale: str(args.locale),
      deprecation: (args.deprecation as 'deprecating' | 'delivery_paused' | undefined) ?? null,
      audienceId: str(args.audienceId),
      specialAdCategories: (args.specialAdCategories as string[] | undefined) ?? null,
      countries: (args.countries as string[] | undefined) ?? null,
      targeting: args.targeting ?? null,
      optimizationGoal: str(args.optimizationGoal),
      promotedObject: args.promotedObject ?? null,
      adSetId: str(args.adSetId),
      adId: str(args.adId),
      bidAmountCents: typeof args.bidAmountCents === 'number' ? args.bidAmountCents : null,
      lifetimeBudgetCents: typeof args.lifetimeBudgetCents === 'number' ? args.lifetimeBudgetCents : null,
      dailyBudgetCents: typeof args.dailyBudgetCents === 'number' ? args.dailyBudgetCents : null,
      directSend: args.directSend === true,
      lifetimeDays: typeof args.lifetimeDays === 'number' ? args.lifetimeDays : null,
      pacingType: str(args.pacingType),
      maxRows: typeof args.maxRows === 'number' ? args.maxRows : null,
    }))
  },
}

export const META_ADS_TARGETING_TOOLS: AgentTool[] = [metaTargetingSearch, metaTargetingCheck]
