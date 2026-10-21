/**
 * Meta step 21 — set-meta-value-rules as a draft: the chosen ad account's value rule sets made, changed and deleted
 * (AS-093, AS-094, AS-095), attached to an ad set (with its legacy bid multipliers removed on ask — the migration Meta
 * documents) or detached (AS-096, AS-097), and Meta's translation of an ad set's legacy bid multipliers into a proposed set
 * (AS-098). Pure: the live state comes in (live-labels-rules.ts), the requests and the record go out.
 *
 * A value rule raises (INCREASE 1–1,000 %) or lowers (DECREASE 1–90 %) the bid for people who match all its criteria; the
 * first rule that matches wins (bidding/value-rules.md). So what can make the account spend more (SPENDS MONEY, the person's
 * decision; the sentence says when no ad set using it is on, so nothing spends yet):
 *   - a change of a set that some ad set uses, unless it ONLY lowers (same rules, same order, same criteria, each
 *     adjustment the same or lower);
 *   - attaching a set with any raise, replacing a set that lowered bids, or removing legacy bid multipliers (their weights
 *     below 1 lowered bids);
 *   - detaching a set (or deleting one an ad set uses) that lowered bids for someone.
 * Meta has no check (validate_only) for any of these (facts F1 X2).
 */
import { changeLines, plural, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import type { LiveRule, LiveRuleSet, RuleSetUser, RulesAdSet } from './live-labels-rules.js'
import { valueRulesProblem, VALUE_RULE_CRITERIA_TYPES, VALUE_RULE_PRODUCT_TYPES } from '../../gateway/meta-labels-rules.js'

export const VALUE_RULE_ACTIONS = ['create', 'change', 'delete', 'attach', 'detach', 'translate'] as const
export type ValueRulesAction = typeof VALUE_RULE_ACTIONS[number]
/** The fields a value rule set is read with — also its read-back after a create or a change (the record keeps Meta's ids). */
export const VALUE_RULE_SET_FIELDS = 'id,name,status,rules{id,name,adjust_sign,adjust_value,status,criterias}'
/** Meta's value-rules guide says 6 sets per ad account; its bid-multiplier guide says 20: Nexus refuses past 20 and warns past 6. */
export const META_RULE_SETS_PER_ACCOUNT = 20
const META_RULE_SETS_GUIDE = 6
/** The bid strategies value rules work with (bidding/value-rules.md "Eligible ad set configurations"). */
export const VALUE_RULE_BID_STRATEGIES = ['LOWEST_COST_WITHOUT_CAP', 'COST_CAP'] as const
/** Housing, employment and credit (now financial products) campaigns cannot use AGE or GENDER rules (bid-multiplier.md limits). */
const RESTRICTED_CATEGORIES = ['HOUSING', 'EMPLOYMENT', 'CREDIT', 'FINANCIAL_PRODUCTS_SERVICES']

export interface ValueRuleAsk {
  /** change: keep this rule (its id in the set now). */
  ruleId?: string
  name: string
  adjust: 'INCREASE' | 'DECREASE'
  percent: number
  criteria: Array<{ type: typeof VALUE_RULE_CRITERIA_TYPES[number]; values: string[]; locationTypes?: string[] }>
}

export interface ValueRulesRequest {
  action: ValueRulesAction
  ruleSetId?: string
  name?: string
  rules?: ValueRuleAsk[]
  productType?: typeof VALUE_RULE_PRODUCT_TYPES[number]
  confirmDelete?: true
  adSetId?: string
  replaceLegacyBidMultipliers?: true
}

export interface ValueRulesLive {
  adAccountId: string
  ruleSets: LiveRuleSet[]
  /** Ad sets of the account that use a value rule set (the first 500 non-deleted ad sets read). */
  users: RuleSetUser[]
  usersMore: boolean
  /** attach, detach, translate: the ad set, now. */
  adSet?: RulesAdSet | null
}

/** A rule as a record keeps it (and as undo sends it back). */
export interface RecordedRule { id: string | null; name: string | null; sign: string | null; percent: number | null; criteria: Array<{ type: string; values: string[]; valueTypes: string[] }> }
export interface ValueRulesRecord {
  op: ValueRulesAction
  /** after a create or a change: the set as Meta read it back (rules null when Meta did not read them back). */
  ruleSet?: { id: string | null; name: string | null; rules?: RecordedRule[] | null } | null
  adSet?: { id: string; valueRuleSetId: string | null; legacyBidMultipliers?: unknown }
  noUndo?: string[]
}

/** One rule on the wire (bidding/value-rules.md; `criterias` as every example writes it). */
interface WireRule { id?: string; name: string; adjust_sign: string; adjust_value: number; status?: string; criterias: Array<{ id?: string; criteria_type: string; operator: 'CONTAINS'; criteria_values: string[]; criteria_value_types: string[] }> }

/** A rule as a record keeps it: from the live read before, and from Meta's read-back after (so undo's read equals it). */
export const recordedOf = (r: LiveRule): RecordedRule => ({ id: r.id, name: r.name, sign: r.sign, percent: r.percent, criteria: r.criteria.map((c) => ({ type: c.type, values: c.values, valueTypes: c.valueTypes })) })
const wireToRecorded = (r: WireRule): RecordedRule => ({ id: r.id ?? null, name: r.name, sign: r.adjust_sign, percent: r.adjust_value, criteria: r.criterias.map((c) => ({ type: c.criteria_type, values: c.criteria_values, valueTypes: c.criteria_value_types })) })
const effect = (r: { sign: string | null; percent: number | null }) => (r.sign === 'INCREASE' ? (r.percent ?? 0) : -(r.percent ?? 0))
const criteriaKey = (r: RecordedRule) => JSON.stringify(r.criteria.map((c) => [c.type, c.values.map((v, i) => `${c.valueTypes[i]}:${v}`).sort()]).sort())
const raises = (rules: RecordedRule[]) => rules.some((r) => r.sign === 'INCREASE')
const lowers = (rules: RecordedRule[]) => rules.some((r) => r.sign === 'DECREASE')
/** Does `next` only lower bids against `old` (same rules in the same order, same criteria, each adjustment the same or lower)? */
export function onlyLowers(old: RecordedRule[], next: RecordedRule[]): boolean {
  return old.length === next.length && old.every((o, i) => criteriaKey(o) === criteriaKey(next[i]) && effect(next[i]) <= effect(o))
}
const ruleWords = (r: RecordedRule) => `${r.sign === 'INCREASE' ? '+' : '−'}${r.percent ?? '?'} % for ${r.criteria.map((c) => `${c.type} ${c.values.join('/')}`).join(' and ')}`
const quoted = (name: string | null | undefined) => (name ? `"${name}" ` : '')
const isOn = (u: { status: string | null; campaignStatus: string | null }) => u.status === 'ACTIVE' && u.campaignStatus === 'ACTIVE'

/** The rules as Meta takes them, from what a person named; a kept rule (and each criterion of its type) by its id. */
export function wireRules(asks: ValueRuleAsk[], keep: LiveRuleSet | null): { value: string; rules: WireRule[] } | { refusal: string } {
  const rules: WireRule[] = []
  for (const ask of asks) {
    const kept = ask.ruleId ? keep?.rules.find((r) => r.id === ask.ruleId) : null
    if (ask.ruleId && !kept) return { refusal: `${ask.ruleId} is not a rule of ${keep ? `value rule set ${keep.id}` : 'a new set'}: a new rule names no ruleId.` }
    const criterias: WireRule['criterias'] = []
    for (const c of ask.criteria) {
      if (c.type === 'LOCATION' ? c.locationTypes?.length !== c.values.length : c.locationTypes !== undefined) {
        return { refusal: c.type === 'LOCATION' ? `Rule "${ask.name}": a LOCATION criterion names one location type per value (locationTypes: LOCATION_COUNTRY, LOCATION_REGION, LOCATION_CITY, LOCATION_COMSCORE_MARKET).` : `Rule "${ask.name}": only a LOCATION criterion names locationTypes.` }
      }
      const keptCriterion = kept?.criteria.find((k) => k.type === c.type && k.id)
      criterias.push({
        ...(keptCriterion?.id ? { id: keptCriterion.id } : {}),
        criteria_type: c.type, operator: 'CONTAINS', criteria_values: c.values, criteria_value_types: c.type === 'LOCATION' ? c.locationTypes! : c.values.map(() => 'NONE'),
      })
    }
    const status = kept?.status === 'ACTIVE' || kept?.status === 'DRAFT' ? kept.status : null
    rules.push({ ...(kept?.id ? { id: kept.id } : {}), name: ask.name, adjust_sign: ask.adjust, adjust_value: ask.percent, ...(kept?.id && status ? { status } : {}), criterias })
  }
  const value = JSON.stringify(rules)
  const problem = valueRulesProblem(value, keep !== null)
  return problem ? { refusal: `Not a value rule set Meta takes: ${problem}.` } : { value, rules }
}

/**
 * The sentence about spending for a set some ad sets use: from now when one of them is on, else nothing spends yet — and when
 * Nexus could not read every ad set (more than 500), it cannot say none is on.
 */
function spendSentence(what: string, users: RuleSetUser[], more = false): string {
  const on = users.filter(isOn)
  if (!on.length && more) return `${what}: Nexus reads only the first 500 ad sets of the account, so an ad set beyond them that uses it may be on — bids can go up for some people from now.`
  return on.length
    ? `${what}: ${plural(on.length, 'ad set')} using it ${on.length === 1 ? 'is' : 'are'} on (${on.slice(0, 5).map((u) => `${quoted(u.name)}${u.id}`).join(', ')}${on.length > 5 ? ', …' : ''}), so bids can go up for some people from now.`
    : `${what}: nothing spends yet — none of the ${plural(users.length, 'ad set')} using it is on (bids can go up once one is switched on).`
}

const base = { raisesSpend: false, readBackInPost: false, budget: false, check: 'none' as const }

/** set-meta-value-rules' draft, or why not. */
export function valueRulesDraft(request: ValueRulesRequest, live: ValueRulesLive): MetaChangeDraft | { refusal: string } {
  const setOf = (id: string | undefined) => (id ? live.ruleSets.find((s) => s.id === id) ?? null : null)
  const usersOf = (id: string) => live.users.filter((u) => u.valueRuleSetId === id)
  const usersMore = live.usersMore ? ['Nexus reads the first 500 ad sets of the account: an ad set beyond them that uses this set is not named here.'] : []
  const noCheck = 'Meta has no check for a value rule change: the run reads the live state again first and sends nothing if it moved.'

  if (request.action === 'create' || request.action === 'change') {
    const keep = request.action === 'change' ? setOf(request.ruleSetId) : null
    if (request.action === 'change' && !keep) return { refusal: request.ruleSetId ? `${request.ruleSetId} is not a value rule set of the chosen ad account (meta-value-rules lists them).` : 'A change names the value rule set (ruleSetId).' }
    if (!request.rules?.length) return { refusal: `A ${request.action === 'create' ? 'new value rule set' : 'change'} names its WHOLE list of rules (rules: 1 to 10, in order — the first that matches wins)${request.action === 'change' ? '; a rule kept names its ruleId' : ''}.` }
    const name = request.name ?? keep?.name ?? null
    if (!name) return { refusal: 'A new value rule set needs its name (name).' }
    if (request.action === 'create' && live.ruleSets.length >= META_RULE_SETS_PER_ACCOUNT) return { refusal: `The ad account has ${live.ruleSets.length} value rule sets: Meta allows ${META_RULE_SETS_PER_ACCOUNT}. Change or delete one first.` }
    if (request.action === 'change' && request.productType) return { refusal: 'A value rule set\'s product type is set when it is made only.' }
    const wire = wireRules(request.rules, keep)
    if ('refusal' in wire) return wire
    const next = wire.rules.map(wireToRecorded)
    const warnings: string[] = [noCheck]
    if (request.action === 'create') {
      if (live.ruleSets.length >= META_RULE_SETS_GUIDE) warnings.unshift(`The ad account has ${live.ruleSets.length} value rule sets: Meta's value-rules page says 6 per account, its bid-multiplier page 20 — Meta's answer decides.`)
      if (live.ruleSets.some((s) => s.name === name)) warnings.unshift(`A value rule set named "${name}" exists already: Meta keeps both (by their ids).`)
      return {
        summary: `Meta: make the value rule set "${name}" with ${plural(next.length, 'rule')} (it changes no bid until an ad set uses it).`,
        changes: changeLines(next.map((r, i): [string, unknown, unknown] => [`Rule ${i + 1} "${r.name}"`, 'none', ruleWords(r)])).changes,
        totals: { rules: next.length },
        warnings: [...warnings, 'Undo deletes it while no ad set uses it.'],
        spendsMoney: [],
        skipped: [],
        requests: [{
          ...base, step: 1, label: `Make value rule set "${name}"`, kind: 'ad', objectKind: 'adaccount', objectId: `act_${live.adAccountId}`, edge: 'value_rule_set',
          params: { name, rules: wire.value, ...(request.productType ? { product_type: request.productType } : {}) }, operation: 'valueRuleSet.create', undoable: false,
          expect: { name, rules: wire.value }, readBackFields: VALUE_RULE_SET_FIELDS,
        }],
        stands: { sets: live.ruleSets.map((s) => [s.id, s.name]).sort() },
        before: { op: 'create', ruleSet: null } satisfies ValueRulesRecord,
        after: { op: 'create', ruleSet: { id: null, name, rules: next } } satisfies ValueRulesRecord,
      }
    }
    const old = keep!.rules.map(recordedOf)
    if (name === keep!.name && JSON.stringify(old.map((r) => ({ ...r, id: null }))) === JSON.stringify(next.map((r) => ({ ...r, id: null })))) return { refusal: `Nothing to change: value rule set ${keep!.id} has exactly these rules.` }
    const users = usersOf(keep!.id)
    const spends = (users.length || live.usersMore) && !onlyLowers(old, next) ? [spendSentence(`Value rule set ${quoted(keep!.name)}(${keep!.id}) changes bid adjustments (not only lower)`, users, live.usersMore)] : []
    const removed = old.filter((o) => o.id && !next.some((n) => n.id === o.id))
    const lines: Array<[string, unknown, unknown]> = [
      ...(name !== keep!.name ? [['Name', keep!.name, name] as [string, unknown, unknown]] : []),
      ...next.map((r, i): [string, unknown, unknown] => { const was = r.id ? old.find((o) => o.id === r.id) : null; return [`Rule ${i + 1} "${r.name}"`, was ? ruleWords(was) : 'new', ruleWords(r)] }),
      ...removed.map((r): [string, unknown, unknown] => [`Rule "${r.name}" (${r.id})`, ruleWords(r), 'removed']),
    ]
    const shown = changeLines(lines)
    return {
      summary: `Meta: change value rule set ${quoted(keep!.name)}(${keep!.id})${users.length ? ` — used by ${plural(users.length, 'ad set')}` : ' (no ad set uses it)'}.`,
      changes: shown.changes,
      totals: { rules: next.length, adSetsUsingIt: users.length, ...(shown.more ? { moreLines: shown.more } : {}) },
      warnings: [...warnings, ...usersMore, 'Meta replaces the whole set: a rule or criterion not named is removed. Undo puts the earlier rules back (a removed rule comes back as a new rule).'],
      spendsMoney: spends,
      skipped: [],
      requests: [{
        ...base, raisesSpend: spends.length > 0, step: 1, label: `Change value rule set ${quoted(keep!.name)}(${keep!.id})`, kind: 'ad', objectKind: 'valueruleset', objectId: keep!.id,
        params: { name, rules: wire.value }, operation: 'valueRuleSet.change', undoable: true, expect: { name, rules: wire.value }, readBackFields: VALUE_RULE_SET_FIELDS,
      }],
      stands: { set: { id: keep!.id, name: keep!.name, rules: old }, users: users.map((u) => [u.id, u.status, u.campaignStatus]).sort() },
      before: { op: 'change', ruleSet: { id: keep!.id, name: keep!.name, rules: old } } satisfies ValueRulesRecord,
      after: { op: 'change', ruleSet: { id: keep!.id, name, rules: next } } satisfies ValueRulesRecord,
    }
  }

  if (request.action === 'delete') {
    const set = setOf(request.ruleSetId)
    if (!set) return { refusal: request.ruleSetId ? `${request.ruleSetId} is not a value rule set of the chosen ad account.` : 'A delete names the value rule set (ruleSetId).' }
    if (request.confirmDelete !== true) return { refusal: 'A value rule set is deleted only when the person explicitly asked to delete it (confirmDelete: true). To stop one ad set using it, use action detach.' }
    const users = usersOf(set.id)
    const rules = set.rules.map(recordedOf)
    const spends = (users.length || live.usersMore) && lowers(rules) ? [spendSentence(`Value rule set ${quoted(set.name)}(${set.id}) lowers bids for some people and goes`, users, live.usersMore)] : []
    return {
      summary: `Meta: DELETE value rule set ${quoted(set.name)}(${set.id})${users.length ? ` — ${plural(users.length, 'ad set')} use${users.length === 1 ? 's' : ''} it` : ''}.`,
      changes: { [`Value rule set ${quoted(set.name)}(${set.id})`]: { from: `${plural(rules.length, 'rule')}${users.length ? `, used by ${plural(users.length, 'ad set')}` : ', used by no ad set'}`, to: 'deleted' } },
      totals: { rules: rules.length, adSetsUsingIt: users.length },
      warnings: [
        'DELETING IS FINAL: no undo is offered. The record keeps every rule, so a set like it can be made again (action create — a new id) and attached again.',
        ...(users.length ? [`${plural(users.length, 'ad set')} use${users.length === 1 ? 's' : ''} it (${users.slice(0, 5).map((u) => `${quoted(u.name)}${u.id}`).join(', ')}${users.length > 5 ? ', …' : ''}): Meta may refuse to delete a set in use, or the ad sets lose its bid adjustments — Meta's answer decides. Detaching it from them first (action detach) is the safer order.`] : []),
        ...usersMore, noCheck,
      ],
      spendsMoney: spends,
      skipped: [],
      requests: [{ ...base, raisesSpend: spends.length > 0, step: 1, label: `Delete value rule set ${quoted(set.name)}(${set.id})`, kind: 'ad', objectKind: 'valueruleset', objectId: set.id, edge: 'delete_rule_set', params: {}, operation: 'valueRuleSet.delete', undoable: false }],
      stands: { set: { id: set.id, name: set.name, rules }, users: users.map((u) => [u.id, u.status, u.campaignStatus]).sort() },
      before: { op: 'delete', ruleSet: { id: set.id, name: set.name, rules }, noUndo: ['Meta has no undelete for a value rule set: make one with the same rules (a new id) and attach it again.'] } satisfies ValueRulesRecord,
      after: { op: 'delete', ruleSet: { id: set.id, name: set.name } } satisfies ValueRulesRecord,
      alsoDeleted: { usedBy: users.map((u) => ({ id: u.id, name: u.name, status: u.status })), more: live.usersMore },
    }
  }

  // attach, detach, translate: one ad set.
  const adSet = live.adSet
  if (!request.adSetId || !adSet) return { refusal: `An ${request.action} names the ad set (adSetId).` }
  const who = `ad set ${quoted(adSet.name)}(${adSet.id})`
  const adSetOn = isOn({ status: adSet.status, campaignStatus: adSet.campaign.status })
  const attachedNow = adSet.valueRuleSetId && adSet.valueRulesApplied !== false ? adSet.valueRuleSetId : null
  const spendWords = (why: string) => (adSetOn ? `${why}: ${who} is on, so it can spend more from now.` : `${why}: nothing spends yet — ${who} is not on (it can spend more once switched on).`)

  if (request.action === 'translate') {
    if (!adSet.legacyBidMultipliers) return { refusal: `${who} has no legacy bid multipliers (bid_adjustments): there is nothing to translate. Make a value rule set with action create.` }
    return {
      summary: `Meta: translate the legacy bid multipliers of ${who} into a proposed value rule set (Meta makes nothing; the answer shows the proposal).`,
      changes: { [`Bid multipliers of ${who}`]: { from: adSet.legacyBidMultipliers, to: 'translated by Meta (nothing changes)' } },
      totals: { adSets: 1 },
      warnings: [
        'Meta answers a proposed value rule set (or the id of one of the account\'s own that already matches) and changes nothing. To use it: make it (action create with its rules), then attach it with replaceLegacyBidMultipliers: true — Meta removes the multipliers as the rules come, for good.',
        'Meta documents this translation on its bid-multiplier guide only (not on a reference page): its answer decides.',
      ],
      spendsMoney: [],
      skipped: [],
      requests: [{
        ...base, step: 1, label: `Ask Meta to translate the bid multipliers of ${who}`, kind: 'adset', objectKind: 'adaccount', objectId: `act_${live.adAccountId}`, edge: 'value_rule_set_translation',
        params: { source: JSON.stringify({ bid_multiplier_ad_set_id: adSet.id }) }, operation: 'valueRuleSet.translate', undoable: false,
      }],
      stands: { adSet: { id: adSet.id, multipliers: adSet.legacyBidMultipliers } },
      before: { op: 'translate', adSet: { id: adSet.id, valueRuleSetId: attachedNow } } satisfies ValueRulesRecord,
      after: { op: 'translate', adSet: { id: adSet.id, valueRuleSetId: attachedNow } } satisfies ValueRulesRecord,
    }
  }

  if (request.action === 'detach') {
    if (!attachedNow) return { refusal: `Nothing to change: ${who} uses no value rule set.` }
    const set = setOf(attachedNow)
    const rules = set ? set.rules.map(recordedOf) : null
    const spends = rules === null || lowers(rules) ? [spendWords(`Its value rule set ${set ? `${quoted(set.name)}(${set.id})` : attachedNow} ${rules === null ? 'could not be read (it may lower bids)' : 'lowers bids for some people'}, and stops`)] : []
    return {
      summary: `Meta: ${who} stops using value rule set ${set ? `${quoted(set.name)}(${set.id})` : attachedNow} (the set stays in the account).`,
      changes: { [`Value rules of ${who}`]: { from: set ? `${quoted(set.name)}(${set.id}): ${set.rules.map((r) => ruleWords(recordedOf(r))).join('; ')}` : attachedNow, to: 'none' } },
      totals: { adSets: 1 },
      warnings: ['Meta: a detach sends ONLY value_rules_applied=false (an id sent with it would attach that set).', noCheck],
      spendsMoney: spends,
      skipped: [],
      requests: [{
        ...base, raisesSpend: spends.length > 0, step: 1, label: `Detach the value rules of ${who}`, kind: 'adset', objectId: adSet.id, params: { value_rules_applied: 'false' },
        operation: 'adset.valueRules.detach', undoable: true, expect: { value_rules_applied: 'false' }, readBackFields: 'id,value_rule_set_id,value_rules_applied',
      }],
      stands: { adSet: [adSet.id, adSet.status, adSet.campaign.status, attachedNow], set: rules },
      before: { op: 'detach', adSet: { id: adSet.id, valueRuleSetId: attachedNow } } satisfies ValueRulesRecord,
      after: { op: 'detach', adSet: { id: adSet.id, valueRuleSetId: null } } satisfies ValueRulesRecord,
    }
  }

  // attach
  const set = setOf(request.ruleSetId)
  if (!set) return { refusal: request.ruleSetId ? `${request.ruleSetId} is not a value rule set of the chosen ad account.` : 'An attach names the value rule set (ruleSetId).' }
  if (attachedNow === set.id) return { refusal: `Nothing to change: ${who} uses value rule set ${set.id} already.` }
  const strategy = adSet.bidStrategy ?? adSet.campaign.bidStrategy
  if (strategy && !(VALUE_RULE_BID_STRATEGIES as readonly string[]).includes(strategy)) {
    return { refusal: `${who} bids with ${strategy}: Meta takes value rules only with ${VALUE_RULE_BID_STRATEGIES.join(' or ')} (no ROAS goal or bid cap yet). Change its bid strategy first (set-meta-ad-set).` }
  }
  const rules = set.rules.map(recordedOf)
  const restricted = adSet.campaign.specialAdCategories.filter((c) => RESTRICTED_CATEGORIES.includes(c))
  if (restricted.length && rules.some((r) => r.criteria.some((c) => c.type === 'AGE' || c.type === 'GENDER'))) {
    return { refusal: `${who} is in a ${restricted.join(' / ')} campaign: Meta does not allow value rules by AGE or GENDER there. Use a set without them.` }
  }
  if (adSet.legacyBidMultipliers && request.replaceLegacyBidMultipliers !== true) {
    return { refusal: `${who} uses legacy bid multipliers: Meta takes value rules on it only as they replace them (bid_adjustments {} with the attach — for good). Ask with replaceLegacyBidMultipliers: true (action translate shows Meta's equivalent rules first).` }
  }
  if (!adSet.legacyBidMultipliers && request.replaceLegacyBidMultipliers) return { refusal: `${who} has no legacy bid multipliers: leave replaceLegacyBidMultipliers out.` }
  const oldSet = attachedNow ? setOf(attachedNow) : null
  const oldRules = oldSet ? oldSet.rules.map(recordedOf) : attachedNow ? null : []
  const why = [
    ...(raises(rules) ? [`value rule set ${quoted(set.name)}(${set.id}) raises bids for some people`] : []),
    ...(oldRules === null ? ['the set it replaces could not be read (it may have lowered bids)'] : lowers(oldRules) ? ['the set it replaces lowered bids for some people'] : []),
    ...(adSet.legacyBidMultipliers ? ['its legacy bid multipliers go (where they lowered a bid, it goes back up)'] : []),
  ]
  const spends = why.length ? [spendWords(why.join('; '))] : []
  const noUndo = adSet.legacyBidMultipliers ? ['Meta: removing the legacy bid multipliers cannot be undone by Nexus (the record keeps them as they were).'] : []
  return {
    summary: `Meta: ${who} uses value rule set ${quoted(set.name)}(${set.id})${attachedNow ? ` instead of ${attachedNow}` : ''}${adSet.legacyBidMultipliers ? ', its legacy bid multipliers removed' : ''}.`,
    changes: {
      [`Value rules of ${who}`]: { from: attachedNow ? (oldSet ? `${quoted(oldSet.name)}(${oldSet.id})` : attachedNow) : 'none', to: `${quoted(set.name)}(${set.id}): ${rules.map(ruleWords).join('; ')}` },
      ...(adSet.legacyBidMultipliers ? { [`Legacy bid multipliers of ${who}`]: { from: adSet.legacyBidMultipliers, to: 'removed (for good)' } } : {}),
    },
    totals: { adSets: 1, rules: rules.length },
    warnings: [
      ...(adSet.legacyBidMultipliers ? ['REMOVING THE LEGACY BID MULTIPLIERS IS FOR GOOD (Meta): undo takes the value rules off, but cannot put the multipliers back — the record keeps them.'] : []),
      'Meta: in a campaign with a campaign budget, use the same value rule set on all its ad sets (different sets, or rules on only some, may deliver unexpectedly). Meta also refuses value rules on some sales and leads setups (web plus in-store or call conversions): its answer decides.',
      noCheck,
    ],
    spendsMoney: spends,
    skipped: [],
    requests: [{
      ...base, raisesSpend: spends.length > 0, step: 1, label: `${who} uses value rule set ${quoted(set.name)}(${set.id})`, kind: 'adset', objectId: adSet.id,
      params: { value_rule_set_id: set.id, value_rules_applied: 'true', ...(adSet.legacyBidMultipliers ? { bid_adjustments: '{}' } : {}) },
      operation: 'adset.valueRules.attach', undoable: true, expect: { value_rule_set_id: set.id }, readBackFields: 'id,value_rule_set_id',
    }],
    stands: { adSet: [adSet.id, adSet.status, adSet.campaign.status, attachedNow, strategy, adSet.legacyBidMultipliers], set: rules, old: oldRules },
    before: { op: 'attach', adSet: { id: adSet.id, valueRuleSetId: attachedNow, ...(adSet.legacyBidMultipliers ? { legacyBidMultipliers: adSet.legacyBidMultipliers } : {}) }, ...(noUndo.length ? { noUndo } : {}) } satisfies ValueRulesRecord,
    after: { op: 'attach', adSet: { id: adSet.id, valueRuleSetId: set.id } } satisfies ValueRulesRecord,
  }
}

/** Undo's arguments for a change: the earlier rules, a kept rule (still in the set after the change) by its id. */
export function undoRulesOf(before: RecordedRule[], after: RecordedRule[]): ValueRuleAsk[] {
  const kept = new Set(after.map((r) => r.id).filter((id): id is string => !!id))
  return before.map((r) => ({
    ...(r.id && kept.has(r.id) ? { ruleId: r.id } : {}),
    name: r.name ?? 'Rule',
    adjust: r.sign === 'INCREASE' ? 'INCREASE' as const : 'DECREASE' as const,
    percent: r.percent ?? 1,
    criteria: r.criteria.map((c) => ({
      type: c.type as ValueRuleAsk['criteria'][number]['type'], values: c.values,
      ...(c.type === 'LOCATION' ? { locationTypes: c.valueTypes } : {}),
    })),
  }))
}
