/**
 * Meta step 18 — the live state a settings change stands on: ONE campaign or ad set of the chosen ad account read from Meta
 * now (GET through the gateway), with what its rules need (the campaign's ad sets, an ad set's campaign and ads, the
 * budget schedules of either, the account's pixels, catalogs and capabilities). Built on step 6's reads
 * (live-objects.ts: the field lists, readGroups, listPaged, the high-demand-period fields) — never a copy. Nothing here
 * stores anything; nothing here reads another business's objects: an id is read with the fields only its kind has
 * (services/meta/meta-kinds.ts) and refused when Meta places it in another ad account.
 *
 * Values are kept AS META SENT THEM (amounts in Meta's offset unit as strings, specs as JSON): a change compares and
 * restores exactly those (settings-units.ts converts what a person names).
 */
import { metaAdAccountId, metaObjectId } from '../../cx/connectors/meta/discovery.js'
import { META_KIND_FIELDS } from '../../meta/meta-kinds.js'
import { MetaReadError } from './errors.js'
import { MetaLiveRefusal } from './live.js'
import { ADSET_CORE_FIELDS, AD_LIST_STATUSES, ADSET_LIST_STATUSES, CAMPAIGN_ADVANTAGE_FIELDS, CAMPAIGN_DETAIL_FIELDS, HDP_CORE, fieldRefused, listPaged, readGroups } from './live-objects.js'
import { metaReadOne } from './read-client.js'

type Row = Record<string, unknown>
export interface MetaSettingsTarget { connectionId: string; adAccountId: string }

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : null)
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const list = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : Array.isArray(obj(v)?.data) ? obj(v)!.data as unknown[] : null)
const strings = (v: unknown): string[] | null => list(v)?.map((x) => text(x)).filter((x): x is string => !!x) ?? null
/** A Meta amount as sent (offset units, a string); 0 is Meta's "none" for a budget, a bid or a minimum spend. */
const amount = (v: unknown): string | null => { const t = text(v); return t && /^\d{1,16}$/.test(t) && !/^0+$/.test(t) ? t : null }

/** The campaign of a change, as Meta sent it now. */
export interface LiveCampaign {
  id: string
  name: string | null
  status: string | null
  effectiveStatus: string | null
  objective: string | null
  buyingType: string | null
  smartPromotionType: string | null
  /** Meta's offset-unit amounts as strings (null: not set). */
  dailyBudget: string | null
  lifetimeBudget: string | null
  /** The raw spend cap (922337203685478 = none). */
  spendCap: string | null
  canUseSpendCap: boolean | null
  bidStrategy: string | null
  pacingType: string[] | null
  promotedObject: Row | null
  specialAdCategories: string[] | null
  specialAdCategory: string | null
  specialAdCategoryCountry: string[] | null
  budgetSharing: boolean | null
  budgetScheduling: boolean | null
  reelsTrendingAds: boolean | null
  /** advantage_state_info.advantage_state (ADVANTAGE_PLUS_SALES, …, DISABLED) — null when Meta did not answer it. */
  advantageState: string | null
}

/** One child ad set of a campaign (what a budget or bid move of the campaign needs). */
export interface LiveChildAdSet { id: string; name: string | null; status: string | null; dailyBudget: string | null; lifetimeBudget: string | null; bidAmount: string | null; endTime: string | null }

export interface LiveAdSet {
  id: string
  campaignId: string | null
  name: string | null
  status: string | null
  effectiveStatus: string | null
  optimizationGoal: string | null
  optimizationSubEvent: string | null
  billingEvent: string | null
  bidStrategy: string | null
  bidAmount: string | null
  bidConstraints: Row | null
  dailyBudget: string | null
  lifetimeBudget: string | null
  budgetRemaining: string | null
  dailyMinSpendTarget: string | null
  lifetimeMinSpendTarget: string | null
  dailySpendCap: string | null
  lifetimeSpendCap: string | null
  minBudgetSpendPercentage: string | null
  maxBudgetSpendPercentage: string | null
  startTime: string | null
  endTime: string | null
  pacingType: string[] | null
  adsetSchedule: unknown[] | null
  frequencyControlSpecs: unknown[] | null
  attributionSpec: unknown[] | null
  incrementalAttribution: boolean | null
  promotedObject: Row | null
  dsaPayor: string | null
  dsaBeneficiary: string | null
  regionalRegulatedCategories: string[] | null
  regionalRegulationIdentities: Row | null
  adSetGoal: Row | null
  creativeSequence: string[] | null
  /** creative_sequence_repetition_pattern (SDK only: its own read group; null when Meta did not answer it). */
  sequenceRepetition: string | null
  rotationBlocks: unknown[] | null
  rotationIntervals: unknown[] | null
  brandSafety: Row | null
  contextualBundling: Row | null
  fullFunnelExploration: string | null
  automaticManualState: string | null
  budgetScheduling: boolean | null
  /** The countries the ad set targets (geo_locations.countries; null: it targets by region, city or radius instead). */
  targetingCountries: string[] | null
  /** The SDK-only or limited fields Meta refused to read (each its own group), in Meta's words. */
  unread: Array<{ part: string; sentence: string }>
}

const campaignOf = (r: Row, advantageState: string | null): LiveCampaign => ({
  id: text(r.id)!,
  name: text(r.name), status: text(r.status), effectiveStatus: text(r.effective_status), objective: text(r.objective), buyingType: text(r.buying_type),
  smartPromotionType: text(r.smart_promotion_type), dailyBudget: amount(r.daily_budget), lifetimeBudget: amount(r.lifetime_budget),
  spendCap: amount(r.spend_cap), canUseSpendCap: bool(r.can_use_spend_cap), bidStrategy: text(r.bid_strategy), pacingType: strings(r.pacing_type),
  promotedObject: obj(r.promoted_object), specialAdCategories: strings(r.special_ad_categories), specialAdCategory: text(r.special_ad_category),
  specialAdCategoryCountry: strings(r.special_ad_category_country), budgetSharing: bool(r.is_adset_budget_sharing_enabled),
  budgetScheduling: bool(r.is_budget_schedule_enabled), reelsTrendingAds: bool(r.is_reels_trending_ads_enabled), advantageState,
})

/** Meta's answer was another kind or another account: refused in words, nothing read further. */
function owned(target: MetaSettingsTarget, body: Row, id: string, word: string): void {
  if (metaAdAccountId(body.account_id) !== target.adAccountId) throw new MetaLiveRefusal(`${word} ${id} is not of the Meta ad account this business chose: Nexus changes nothing in another account.`)
}

function readRefusal(err: unknown, id: string, word: string): never {
  if (err instanceof MetaReadError) {
    if (/nonexisting field/i.test(err.message)) throw new MetaLiveRefusal(`${id} is not ${word === 'ad set' ? 'an' : 'a'} ${word} (Meta: ${err.message}); meta-ads-live shows the ids.`)
    throw new MetaLiveRefusal(`Nexus could not read ${word} ${id} from Meta: ${err.message}`)
  }
  throw err
}

/** One campaign, now (CAMPAIGN_DETAIL_FIELDS of step 6), and its Advantage+ state in a read of its own. */
export async function liveCampaign(target: MetaSettingsTarget, campaignId: string): Promise<LiveCampaign> {
  const id = metaObjectId(campaignId)
  if (!id) throw new MetaLiveRefusal(`"${campaignId}" is not a Meta campaign id (digits).`)
  let body: Row
  try {
    body = (await readGroups(target.connectionId, 'settings.read.campaign', id, [{ name: 'core', fields: CAMPAIGN_DETAIL_FIELDS }])).body
  } catch (err) { readRefusal(err, id, 'campaign') }
  owned(target, body, id, 'Campaign')
  if (META_KIND_FIELDS.campaign.some((f) => body[f] === undefined || body[f] === null)) throw new MetaLiveRefusal(`${id} is not a campaign of this ad account.`)
  let advantageState: string | null = null
  try {
    const read = await metaReadOne({ connectionId: target.connectionId }, { operation: 'settings.read.campaign.advantage', path: id, query: { fields: CAMPAIGN_ADVANTAGE_FIELDS } })
    advantageState = text(obj((read.body as Row).advantage_state_info)?.advantage_state)
  } catch (err) {
    if (!(err instanceof MetaReadError) || err.failure.authLost || err.failure.throttled) throw err
  }
  return campaignOf(body, advantageState)
}

/** Every non-deleted ad set of a campaign (ARCHIVED included: Meta's adset_budgets lists "all the non-deleted child adset IDs"). */
export async function liveCampaignAdSets(target: MetaSettingsTarget, campaignId: string): Promise<{ adSets: LiveChildAdSet[]; more: boolean }> {
  const read = await listPaged(target.connectionId, 'settings.read.campaign.adsets', `${campaignId}/adsets`, {
    fields: 'id,name,status,daily_budget,lifetime_budget,bid_amount,end_time', effective_status: [...ADSET_LIST_STATUSES],
  }, 200)
  return {
    adSets: read.rows.map((r) => ({ id: text(r.id)!, name: text(r.name), status: text(r.status), dailyBudget: amount(r.daily_budget), lifetimeBudget: amount(r.lifetime_budget), bidAmount: amount(r.bid_amount), endTime: text(r.end_time) })).filter((a) => !!a.id),
    more: read.more,
  }
}

/**
 * Fields Meta lists only in its SDK, or for some accounts only: each asked in a group of its own, so a refusal never costs
 * the ad set's core read (the unread part is named).
 */
const ADSET_EXTRA_GROUPS = [
  { name: 'contextualBundling', fields: 'contextual_bundling_spec' },
  { name: 'maxBudgetShare', fields: 'max_budget_spend_percentage' },
  { name: 'fullFunnelExploration', fields: 'full_funnel_exploration_mode' },
  { name: 'automaticManualState', fields: 'automatic_manual_state' },
  { name: 'budgetScheduling', fields: 'is_budget_schedule_enabled' },
  { name: 'sequenceRepetition', fields: 'creative_sequence_repetition_pattern' },
]

/** One ad set, now (ADSET_CORE_FIELDS of step 6 + its SDK-only fields), with its campaign. */
export async function liveAdSet(target: MetaSettingsTarget, adSetId: string): Promise<{ adSet: LiveAdSet; campaign: LiveCampaign }> {
  const id = metaObjectId(adSetId)
  if (!id) throw new MetaLiveRefusal(`"${adSetId}" is not a Meta ad set id (digits).`)
  let body: Row
  let missing: Array<{ part: string; sentence: string }>
  try {
    ({ body, missing } = await readGroups(target.connectionId, 'settings.read.adset', id, [{ name: 'core', fields: ADSET_CORE_FIELDS }, ...ADSET_EXTRA_GROUPS]))
  } catch (err) { readRefusal(err, id, 'ad set') }
  owned(target, body, id, 'Ad set')
  if (META_KIND_FIELDS.adset.some((f) => body[f] === undefined || body[f] === null)) throw new MetaLiveRefusal(`${id} is not an ad set of this ad account.`)
  const campaignId = text(body.campaign_id)
  if (!campaignId) throw new MetaLiveRefusal(`Meta did not say which campaign ad set ${id} is in.`)
  const campaign = await liveCampaign(target, campaignId)
  const geo = obj(obj(body.targeting)?.geo_locations)
  const adSet: LiveAdSet = {
    id, campaignId, name: text(body.name), status: text(body.status), effectiveStatus: text(body.effective_status),
    optimizationGoal: text(body.optimization_goal), optimizationSubEvent: text(body.optimization_sub_event), billingEvent: text(body.billing_event),
    bidStrategy: text(body.bid_strategy), bidAmount: amount(body.bid_amount), bidConstraints: obj(body.bid_constraints),
    dailyBudget: amount(body.daily_budget), lifetimeBudget: amount(body.lifetime_budget), budgetRemaining: amount(body.budget_remaining),
    dailyMinSpendTarget: amount(body.daily_min_spend_target), lifetimeMinSpendTarget: amount(body.lifetime_min_spend_target),
    dailySpendCap: amount(body.daily_spend_cap), lifetimeSpendCap: amount(body.lifetime_spend_cap),
    minBudgetSpendPercentage: amount(body.min_budget_spend_percentage), maxBudgetSpendPercentage: amount(body.max_budget_spend_percentage),
    startTime: text(body.start_time), endTime: text(body.end_time), pacingType: strings(body.pacing_type),
    adsetSchedule: list(body.adset_schedule), frequencyControlSpecs: list(body.frequency_control_specs), attributionSpec: list(body.attribution_spec),
    incrementalAttribution: bool(body.is_incremental_attribution_enabled), promotedObject: obj(body.promoted_object),
    dsaPayor: text(body.dsa_payor), dsaBeneficiary: text(body.dsa_beneficiary), regionalRegulatedCategories: strings(body.regional_regulated_categories),
    regionalRegulationIdentities: obj(body.regional_regulation_identities), adSetGoal: obj(body.ad_set_goal), creativeSequence: strings(body.creative_sequence),
    sequenceRepetition: text(body.creative_sequence_repetition_pattern),
    rotationBlocks: list(body.time_based_ad_rotation_id_blocks), rotationIntervals: list(body.time_based_ad_rotation_intervals),
    brandSafety: obj(body.brand_safety_config), contextualBundling: obj(body.contextual_bundling_spec),
    fullFunnelExploration: text(body.full_funnel_exploration_mode), automaticManualState: text(body.automatic_manual_state),
    budgetScheduling: bool(body.is_budget_schedule_enabled),
    targetingCountries: geo ? strings(geo.countries) : null,
    unread: missing,
  }
  return { adSet, campaign }
}

/** The ads of an ad set (a sequence or a rotation names only these). */
export async function liveAdSetAds(target: MetaSettingsTarget, adSetId: string): Promise<{ ads: Array<{ id: string; status: string | null }>; more: boolean }> {
  const read = await listPaged(target.connectionId, 'settings.read.adset.ads', `${adSetId}/ads`, { fields: 'id,status', effective_status: [...AD_LIST_STATUSES] }, 100)
  return { ads: read.rows.map((r) => ({ id: text(r.id)!, status: text(r.status) })).filter((a) => !!a.id), more: read.more }
}

/** One high-demand period as Meta sent it. */
export interface LivePeriod { id: string; budgetValue: number | null; budgetValueType: string | null; recurrenceType: string | null; timeStart: string | null; timeEnd: string | null }

/** The budget schedules (high-demand periods) of a campaign or ad set (at most 50 per object — Meta's limit). */
export async function liveBudgetSchedules(target: MetaSettingsTarget, objectId: string): Promise<LivePeriod[]> {
  const read = await listPaged(target.connectionId, 'settings.read.budgetSchedules', `${objectId}/budget_schedules`, { fields: HDP_CORE }, 100)
  return read.rows.map((r) => {
    const value = Number(text(r.budget_value))
    return { id: text(r.id)!, budgetValue: Number.isFinite(value) ? value : null, budgetValueType: text(r.budget_value_type), recurrenceType: text(r.recurrence_type), timeStart: text(r.time_start), timeEnd: text(r.time_end) }
  }).filter((p) => !!p.id)
}

/** The ad account's own pixels (a promoted object names only these). */
export async function liveAccountPixels(target: MetaSettingsTarget): Promise<Set<string>> {
  const read = await listPaged(target.connectionId, 'settings.read.pixels', `act_${target.adAccountId}/adspixels`, { fields: 'id' }, 100)
  return new Set(read.rows.map((r) => text(r.id)).filter((x): x is string => !!x))
}

/** The ad account's capabilities (CAN_USE_BUDGET_SCHEDULING_API, …); null when Meta does not answer them. */
export async function liveAccountCapabilities(target: MetaSettingsTarget): Promise<string[] | null> {
  try {
    const read = await metaReadOne({ connectionId: target.connectionId }, { operation: 'settings.read.account.capabilities', path: `act_${target.adAccountId}`, query: { fields: 'capabilities' } })
    return strings((read.body as Row).capabilities)
  } catch (err) {
    if (fieldRefused(err)) return null
    throw err
  }
}

/** Is an ad set's targeting in the EU (DSA): one of its countries is, or it names no country at all (regions, cities, worldwide). */
export const EU_COUNTRIES: ReadonlySet<string> = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'])
export const targetsEu = (countries: string[] | null): boolean => countries === null || countries.some((c) => EU_COUNTRIES.has(c.toUpperCase()))

/**
 * Undo's "now" for a settings change: the fields it wrote, read live from the object and viewed exactly as its record
 * viewed them (change-settings-common.ts settingsView). A field Meta refuses to read (SDK only) comes back undefined — the
 * caller keeps the record's value for it (it cannot see whether it moved). Never reads another kind: the fields asked are
 * that object's own.
 */
export async function liveFieldValues(target: MetaSettingsTarget, objectId: string, fields: string[]): Promise<Record<string, unknown> | null> {
  if (!fields.length) return {}
  try {
    const read = await metaReadOne({ connectionId: target.connectionId }, { operation: 'settings.read.undo', path: objectId, query: { fields: ['id', 'account_id', ...fields].join(',') } })
    const body = read.body as Row
    if (metaAdAccountId(body.account_id) !== target.adAccountId) return null
    return Object.fromEntries(fields.map((f) => [f, f in body ? body[f] : null]))
  } catch (err) {
    if (!fieldRefused(err)) return null
  }
  // One field Meta refuses: each read alone; the refused ones stay undefined.
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    try {
      const read = await metaReadOne({ connectionId: target.connectionId }, { operation: 'settings.read.undo.field', path: objectId, query: { fields: `id,account_id,${f}` } })
      const body = read.body as Row
      if (metaAdAccountId(body.account_id) !== target.adAccountId) return null
      out[f] = f in body ? body[f] : null
    } catch (err) {
      if (!fieldRefused(err)) return null
      out[f] = undefined
    }
  }
  return out
}
