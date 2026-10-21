/**
 * Meta step 21 — the live state set-meta-labels, set-meta-value-rules and create-meta-reach-frequency stand on: the chosen
 * ad account's labels, a campaign's or ad set's labels, what carries a label, the account's value rule sets and which ad
 * sets use them, one ad set with its campaign (bid strategy, legacy bid multipliers, value rules, reservation, buying type),
 * and one reach & frequency prediction. Read from Meta now (GET through the gateway), built on step 6's helpers
 * (live-objects.ts readGroups, listPaged, listGroups) — never a copy. Nothing here stores anything; every object read is
 * checked to be the chosen ad account's own (its account_id, or the account's own list for a label: a label node names no
 * account on v26) and of the kind named (services/meta/meta-kinds.ts), and refused in words otherwise.
 */
import { metaAdAccountId, metaObjectId } from '../../cx/connectors/meta/discovery.js'
import { META_KIND_FIELDS } from '../../meta/meta-kinds.js'
import { MetaReadError } from './errors.js'
import { MetaLiveRefusal } from './live.js'
import { AD_LIST_STATUSES, ADSET_LIST_STATUSES, MAX_ROWS, listGroups, listPaged, readGroups } from './live-objects.js'
import type { MetaSettingsTarget } from './live-settings.js'
import { VALUE_RULE_SET_FIELDS } from './change-value-rules.js'

type Row = Record<string, unknown>
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)
const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : null }
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const rowsOf = (v: unknown): Row[] => {
  const list = Array.isArray(v) ? v : Array.isArray(obj(v)?.data) ? (obj(v)!.data as unknown[]) : []
  return list.filter((r): r is Row => !!r && typeof r === 'object' && !Array.isArray(r))
}
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => text(x)).filter((x): x is string => !!x) : [])

const WORD = { campaign: 'campaign', adset: 'ad set' } as const

function readRefusal(err: unknown, id: string, word: string): never {
  if (err instanceof MetaReadError) {
    if (/nonexisting field/i.test(err.message)) throw new MetaLiveRefusal(`${id} is not ${/^[aeiou]/.test(word) ? 'an' : 'a'} ${word} (Meta: ${err.message}).`)
    throw new MetaLiveRefusal(`Nexus could not read ${word} ${id} from Meta: ${err.message}`)
  }
  throw err
}

/** Meta's answer is the chosen ad account's own and of the kind named (two fields only that kind has), or refused. */
function ownedOfKind(target: MetaSettingsTarget, body: Row, id: string, kind: 'campaign' | 'adset'): void {
  if (metaAdAccountId(body.account_id) !== target.adAccountId) throw new MetaLiveRefusal(`${WORD[kind][0].toUpperCase()}${WORD[kind].slice(1)} ${id} is not of the Meta ad account this business chose: Nexus changes nothing in another account.`)
  if (META_KIND_FIELDS[kind].some((f) => body[f] === undefined || body[f] === null)) throw new MetaLiveRefusal(`${id} is not ${kind === 'adset' ? 'an' : 'a'} ${WORD[kind]} of this ad account.`)
}

// ── labels ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LiveLabel { id: string; name: string | null }
const labelsOf = (v: unknown): LiveLabel[] => rowsOf(v).map((l) => ({ id: text(l.id) ?? '', name: text(l.name) })).filter((l) => !!l.id)

/** The chosen ad account's labels (CMP-081), up to 500 — whose a label is (its node names no account). */
export async function liveAccountLabels(target: MetaSettingsTarget): Promise<{ labels: LiveLabel[]; more: boolean }> {
  const read = await listPaged(target.connectionId, 'labels.read.account', `act_${target.adAccountId}/adlabels`, { fields: 'id,name' }, MAX_ROWS)
  return { labels: labelsOf(read.rows), more: read.more }
}

/** A campaign or ad set of the chosen account with its labels, now. */
export interface LabelledObject { kind: 'campaign' | 'adset'; id: string; name: string | null; status: string | null; labels: LiveLabel[] }

export async function liveLabelledObject(target: MetaSettingsTarget, kind: 'campaign' | 'adset', objectId: string): Promise<LabelledObject> {
  const id = metaObjectId(objectId)
  if (!id) throw new MetaLiveRefusal(`"${objectId}" is not a Meta ${WORD[kind]} id (digits).`)
  let body: Row
  try {
    body = (await readGroups(target.connectionId, `labels.read.${kind}`, id, [{ name: 'core', fields: ['id', 'account_id', 'name', 'status', ...META_KIND_FIELDS[kind], 'adlabels{id,name}'].join(',') }])).body
  } catch (err) { readRefusal(err, id, WORD[kind]) }
  ownedOfKind(target, body, id, kind)
  return { kind, id, name: text(body.name), status: text(body.status), labels: labelsOf(body.adlabels) }
}

/** What carries a label (CMP-013, CMP-085, AS-024, AD-012, CR-008 — its own edges), up to 100 of each: a delete takes it off all of them. */
export interface LabelCarriers { campaigns: Array<{ id: string; name: string | null }>; adSets: Array<{ id: string; name: string | null }>; ads: Array<{ id: string; name: string | null }>; creatives: Array<{ id: string; name: string | null }>; more: boolean }

export async function liveLabelCarriers(target: MetaSettingsTarget, labelId: string): Promise<LabelCarriers> {
  const out: LabelCarriers = { campaigns: [], adSets: [], ads: [], creatives: [], more: false }
  const edges: Array<[keyof Omit<LabelCarriers, 'more'>, string]> = [['campaigns', 'campaigns'], ['adSets', 'adsets'], ['ads', 'ads'], ['creatives', 'adcreatives']]
  for (const [key, edge] of edges) {
    const read = await listPaged(target.connectionId, `labels.read.carriers.${edge}`, `${labelId}/${edge}`, { fields: 'id,account_id,name' }, 100)
    // Only the chosen account's own objects are named (a label is one account's).
    out[key] = read.rows.filter((r) => metaAdAccountId(r.account_id) === target.adAccountId).map((r) => ({ id: text(r.id) ?? '', name: text(r.name) })).filter((r) => !!r.id)
    out.more ||= read.more
  }
  return out
}

// ── value rules ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LiveCriterion { id: string | null; type: string; values: string[]; valueTypes: string[] }
export interface LiveRule { id: string | null; name: string | null; sign: 'INCREASE' | 'DECREASE' | null; percent: number | null; status: string | null; criteria: LiveCriterion[] }
export interface LiveRuleSet { id: string; name: string | null; status: string | null; productType: string | null; rules: LiveRule[] }

/**
 * One value rule set as Meta answers it (a list row, or a read-back of one set): its rules and criteria with their ids.
 * GENDER values come back lower case ("male", bidding/value-rules.md read example) though they are written MALE / FEMALE:
 * read as written, so a set read again equals what a change recorded.
 */
export const ruleSetFromRow = (r: Row): LiveRuleSet => ({
  id: text(r.id) ?? '', name: text(r.name), status: text(r.status), productType: text(r.product_type),
  rules: rowsOf(r.rules).map((rule) => {
    const sign = text(rule.adjust_sign)
    return {
      id: text(rule.id), name: text(rule.name), sign: sign === 'INCREASE' || sign === 'DECREASE' ? sign : null, percent: num(rule.adjust_value), status: text(rule.status),
      criteria: rowsOf(rule.criterias).map((c) => {
        const type = text(c.criteria_type) ?? ''
        return { id: text(c.id), type, values: strings(c.criteria_values).map((v) => (type === 'GENDER' ? v.toUpperCase() : v)), valueTypes: strings(c.criteria_value_types) }
      }),
    }
  }),
})

const RULE_SET_GROUPS = [
  { name: 'core', fields: VALUE_RULE_SET_FIELDS },
  { name: 'sdk', fields: 'product_type' },
]

/** The chosen ad account's value rule sets with their rules (AS-091; Meta allows 20 per account). */
export async function liveValueRuleSets(target: MetaSettingsTarget): Promise<LiveRuleSet[]> {
  const read = await listGroups(target.connectionId, 'valueRules.read.sets', `act_${target.adAccountId}/value_rule_set`, RULE_SET_GROUPS, {}, 100)
  return read.rows.map(ruleSetFromRow).filter((s) => !!s.id)
}

/** One ad set of the account as a value-rule or reservation change needs it, with its campaign. */
export interface RulesAdSet {
  id: string
  name: string | null
  status: string | null
  effectiveStatus: string | null
  bidStrategy: string | null
  /** The legacy bid multipliers (bid_adjustments) as Meta sent them; null when none. */
  legacyBidMultipliers: Row | null
  valueRuleSetId: string | null
  /** value_rules_applied (Meta's SDK field; null when Meta did not answer it): false = its set is detached. */
  valueRulesApplied: boolean | null
  rfPredictionId: string | null
  campaign: { id: string; name: string | null; status: string | null; buyingType: string | null; bidStrategy: string | null; specialAdCategories: string[] }
}

const ADSET_FIELDS = ['id', 'account_id', 'campaign_id', 'name', 'status', 'effective_status', ...META_KIND_FIELDS.adset, 'bid_strategy', 'bid_adjustments', 'value_rule_set_id', 'rf_prediction_id']
const CAMPAIGN_FIELDS = ['id', 'account_id', 'name', 'status', ...META_KIND_FIELDS.campaign, 'buying_type', 'bid_strategy', 'special_ad_categories']

export async function liveRulesAdSet(target: MetaSettingsTarget, adSetId: string): Promise<RulesAdSet> {
  const id = metaObjectId(adSetId)
  if (!id) throw new MetaLiveRefusal(`"${adSetId}" is not a Meta ad set id (digits).`)
  let body: Row
  try {
    body = (await readGroups(target.connectionId, 'valueRules.read.adset', id, [{ name: 'core', fields: ADSET_FIELDS.join(',') }, { name: 'sdk', fields: 'value_rules_applied' }])).body
  } catch (err) { readRefusal(err, id, 'ad set') }
  ownedOfKind(target, body, id, 'adset')
  const campaignId = text(body.campaign_id)
  if (!campaignId) throw new MetaLiveRefusal(`Meta did not say which campaign ad set ${id} is in.`)
  let campaign: Row
  try {
    campaign = (await readGroups(target.connectionId, 'valueRules.read.campaign', campaignId, [{ name: 'core', fields: CAMPAIGN_FIELDS.join(',') }])).body
  } catch (err) { readRefusal(err, campaignId, 'campaign') }
  ownedOfKind(target, campaign, campaignId, 'campaign')
  const multipliers = obj(body.bid_adjustments)
  const rf = text(body.rf_prediction_id)
  return {
    id, name: text(body.name), status: text(body.status), effectiveStatus: text(body.effective_status), bidStrategy: text(body.bid_strategy),
    legacyBidMultipliers: multipliers && Object.keys(multipliers).length ? multipliers : null,
    valueRuleSetId: text(body.value_rule_set_id) === '0' ? null : text(body.value_rule_set_id),
    valueRulesApplied: typeof body.value_rules_applied === 'boolean' ? body.value_rules_applied : null, rfPredictionId: rf && rf !== '0' ? rf : null,
    campaign: { id: campaignId, name: text(campaign.name), status: text(campaign.status), buyingType: text(campaign.buying_type), bidStrategy: text(campaign.bid_strategy), specialAdCategories: strings(campaign.special_ad_categories) },
  }
}

/** The ad sets of the account that use a value rule set (what a change of that set moves), up to 500 non-deleted ad sets read. */
export interface RuleSetUser { id: string; name: string | null; status: string | null; campaignStatus: string | null; valueRuleSetId: string }

export async function liveRuleSetUsers(target: MetaSettingsTarget): Promise<{ users: RuleSetUser[]; more: boolean }> {
  const read = await listPaged(target.connectionId, 'valueRules.read.users', `act_${target.adAccountId}/adsets`, {
    fields: 'id,name,status,value_rule_set_id,campaign{status}', effective_status: [...ADSET_LIST_STATUSES],
  }, MAX_ROWS)
  const users = read.rows
    .map((r) => ({ id: text(r.id) ?? '', name: text(r.name), status: text(r.status), campaignStatus: text(obj(r.campaign)?.status), valueRuleSetId: text(r.value_rule_set_id) ?? '' }))
    .filter((r) => !!r.id && !!r.valueRuleSetId && r.valueRuleSetId !== '0')
  return { users, more: read.more }
}

/** Does an ad set have at least one ad that is not deleted (marketing-api/reservation.md "Error codes", 1487583: an ad set with no ads cannot be assigned a reservation)? */
export async function liveAdSetHasAds(target: MetaSettingsTarget, adSetId: string): Promise<boolean> {
  const read = await listPaged(target.connectionId, 'rf.read.adset.ads', `${adSetId}/ads`, { fields: 'id', effective_status: [...AD_LIST_STATUSES] }, 1)
  return read.rows.length > 0
}

// ── reach & frequency ───────────────────────────────────────────────────────────────────────────────────────────────────

/** One reach & frequency prediction (or reservation) as Meta has it now (reference/reach-frequency-prediction.md). */
export interface LivePrediction {
  id: string
  /** 1 SUCCESS, 2 PENDING, 3–99 a failure (reservation.md "Response status codes"), 100+ Meta's own failure. */
  status: number | null
  /** 0 budget from reach, 1 reach from budget. */
  predictionMode: number | null
  /** 0 cancelled, 1 reserved, 2 attached to an ad set. */
  reservationStatus: number | null
  /** The ad set it is attached to (Meta's `campaign_id`: R&F's own older naming), and its campaign. */
  adSetId: string | null
  campaignId: string | null
  /** Unix seconds. */
  start: number | null
  stop: number | null
  expiration: number | null
  /** external_budget as Meta sent it (its unit: "in cents" of the account currency — change-reach-frequency.ts rfBudgetCents). */
  budgetCents: number | null
  reach: number | null
  impressions: number | null
  frequencyCap: number | null
  intervalFrequencyCap: number | null
  intervalResetHours: number | null
  destinationId: string | null
  instagramDestinationId: string | null
  /** SDK-only fields Meta refused, in its words. */
  unread: string[]
}

const PREDICTION_GROUPS = [
  {
    name: 'core',
    fields: 'id,account_id,status,prediction_mode,prediction_progress,reservation_status,campaign_id,campaign_group_id,campaign_time_start,campaign_time_stop,expiration_time,external_budget,external_reach,external_impression,frequency_cap,interval_frequency_cap,interval_frequency_cap_reset_period,destination_id,instagram_destination_id,time_created',
  },
]

/** A Meta time (Unix seconds as a number or string, or ISO) as Unix seconds. */
const unix = (v: unknown): number | null => {
  const n = num(v)
  if (n !== null) return n > 0 ? Math.floor(n) : null
  const ms = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

export async function livePrediction(target: MetaSettingsTarget, predictionId: string): Promise<LivePrediction> {
  const id = metaObjectId(predictionId)
  if (!id) throw new MetaLiveRefusal(`"${predictionId}" is not a Meta reach and frequency prediction id (digits).`)
  let body: Row
  let missing: Array<{ part: string; sentence: string }>
  try {
    ({ body, missing } = await readGroups(target.connectionId, 'rf.read.prediction', id, PREDICTION_GROUPS))
  } catch (err) { readRefusal(err, id, 'reach and frequency prediction') }
  if (metaAdAccountId(body.account_id) !== target.adAccountId) throw new MetaLiveRefusal(`Prediction ${id} is not of the Meta ad account this business chose: Nexus changes nothing in another account.`)
  if (body.prediction_mode === undefined || body.prediction_mode === null) throw new MetaLiveRefusal(`${id} is not a reach and frequency prediction of this ad account.`)
  return {
    id, status: num(body.status), predictionMode: num(body.prediction_mode), reservationStatus: num(body.reservation_status),
    adSetId: text(body.campaign_id) === '0' ? null : text(body.campaign_id), campaignId: text(body.campaign_group_id) === '0' ? null : text(body.campaign_group_id),
    start: unix(body.campaign_time_start), stop: unix(body.campaign_time_stop), expiration: unix(body.expiration_time),
    budgetCents: num(body.external_budget), reach: num(body.external_reach), impressions: num(body.external_impression),
    frequencyCap: num(body.frequency_cap), intervalFrequencyCap: num(body.interval_frequency_cap), intervalResetHours: num(body.interval_frequency_cap_reset_period),
    destinationId: text(body.destination_id), instagramDestinationId: text(body.instagram_destination_id),
    unread: missing.map((m) => `${m.part}: ${m.sentence}`),
  }
}
