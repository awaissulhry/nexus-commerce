/**
 * Google Ads programme 2, G8a (2026-10-15) — conversion value rules: make rules (and put them in the account's or a
 * campaign's rule set), change their action, pause or enable them. A pure builder (request + live state →
 * GoogleChangeDraft, or a refusal). No call here.
 *
 * Google's rules, checked 2026-10-15 in the v25 reference (ConversionValueRule, ConversionValueRule.ValueRuleAction,
 * .ValueRuleDeviceCondition, .ValueRuleGeoLocationCondition, .ValueRuleAudienceCondition, ConversionValueRuleSet,
 * ConversionValueRuleOperation, ConversionValueRuleSetOperation, ValueRuleOperationEnum, ValueRuleDeviceTypeEnum,
 * ValueRuleGeoLocationMatchTypeEnum, ValueRuleSetDimensionEnum, ValueRuleSetAttachmentTypeEnum,
 * ConversionValueRuleStatusEnum, ConversionValueRuleSetStatusEnum; MutateOperation has conversion_value_rule_operation and
 * conversion_value_rule_set_operation) and the guide …/docs/conversions/conversion-value-rules:
 *   - a rule has ONE action (ADD: value > 0; MULTIPLY: 0.5 to 10; SET only for allowlisted accounts or store sales — not
 *     offered) and at most two conditions of device, location, audience (itinerary: allowlist only — not offered);
 *   - a rule does nothing until it is in a rule set (conversion_value_rules, resource names, in order: the first rule
 *     that matches applies); a rule is in at most one set; a set names 1–2 dimensions its rules may use;
 *   - a rule's status is ENABLED or PAUSED (settable); a set's status is read only (PAUSED when all its rules are);
 *   - a set is attached to the account (CUSTOMER) or to one campaign (CAMPAIGN + campaign); its categories are set only
 *     at creation (empty = every category; Nexus makes empty-category sets).
 * Temporary ids (negative) let a new set name new rules in the same request.
 *
 * Money: what a matching conversion is worth is compared before and after (upliftOf, valueDirection: a paused or absent
 * rule is × 1 + 0). Whenever values go up — a new or enabled rule that adds or multiplies above 1, a higher action, and
 * also PAUSING a rule that multiplied below 1 — value bidding (target ROAS, maximize conversion value) bids for higher
 * values: SPENDS MONEY, naming the enabled campaigns that bid on value. Only a real fall is a "lowers" warning. New rules
 * are made PAUSED unless the request says enable.
 */
import { changeLines, money, plural, type GoogleChangeDraft } from './change-draft.js'
import { VALUE_BIDDING, type LiveValueRule, type LiveValueRuleSet, type SmartBiddingCampaign, type ValueRuleDimension } from './live-conversions.js'
import type { GoogleMutateOperation } from './write-client.js'
import { chaseSentence } from './change-conversions.js'

export const RULE_DEVICES = ['MOBILE', 'DESKTOP', 'TABLET'] as const
export const MULTIPLY_MIN = 0.5
export const MULTIPLY_MAX = 10

export interface RuleAction { add?: number; multiply?: number }
export interface ValueRuleCreate extends RuleAction {
  devices?: Array<(typeof RULE_DEVICES)[number]>
  locations?: { include: string[]; exclude?: string[]; presenceOnly?: boolean }
  audiences?: { userLists?: string[]; userInterests?: string[] }
  /** The campaign whose rule set holds it; without one, the account's rule set. */
  campaignId?: string
  /** true: the rule applies at once (SPENDS MONEY when it raises values); otherwise it is made PAUSED. */
  enable?: boolean
}
export interface ValueRuleChange extends RuleAction { valueRuleId: string; status?: 'ENABLED' | 'PAUSED' }
export interface ValueRuleRequest { create?: ValueRuleCreate[]; change?: ValueRuleChange[] }

/** A rule's changed fields: what it replaced (before) or wrote (after). ADD values in cents. */
export interface RuleFields { valueRuleId: string; operation?: string | null; addCents?: number | null; multiply?: number | null; status?: string | null }
export interface ValueRuleRecord {
  rules: RuleFields[]
  created: Array<{ valueRuleId: string; status: 'ENABLED' | 'PAUSED' }>
  /** The rule sets the new rules went into (`new` when it made one). */
  ruleSets?: Array<{ ruleSetId: string; created: boolean; campaignId: string | null }>
}

export const NEW_RULE = (n: number) => `new-${n}`
const DIGITS = /^\d{1,20}$/

function actionProblem(a: RuleAction, what: string, required: boolean): string | null {
  const given = (a.add !== undefined ? 1 : 0) + (a.multiply !== undefined ? 1 : 0)
  if (given > 1) return `${what}: give add or multiply, not both.`
  if (required && given === 0) return `${what}: give its action — add (cents to add) or multiply (a factor).`
  if (a.add !== undefined && (!Number.isInteger(a.add) || a.add <= 0)) return `${what}: add is whole cents above 0.`
  if (a.multiply !== undefined && (!(a.multiply >= MULTIPLY_MIN) || !(a.multiply <= MULTIPLY_MAX))) return `${what}: multiply is ${MULTIPLY_MIN} to ${MULTIPLY_MAX}.`
  return null
}

const actionJson = (a: RuleAction) => (a.add !== undefined ? { operation: 'ADD', value: a.add / 100 } : { operation: 'MULTIPLY', value: a.multiply })

/**
 * What a rule does to a matching conversion's value: × mult, then + add. A rule that does not apply (paused, or no rule
 * at all) is × 1 + 0; a SET rule has no fixed direction (null).
 */
export type Uplift = { mult: number; add: number } | null
export function upliftOf(status: string | null | undefined, operation: string | null | undefined, value: number | null | undefined): Uplift {
  if (status !== 'ENABLED') return { mult: 1, add: 0 }
  if (operation === 'ADD') return { mult: 1, add: Number(value) || 0 }
  if (operation === 'MULTIPLY') return { mult: Number(value), add: 0 }
  return operation === 'SET' ? null : { mult: 1, add: 0 }
}

/**
 * Whether matching conversions are worth more or less after a change than before: `up` when no part falls and one rises,
 * `down` the other way, `same`, or `unknown` (a SET rule, or one part up and the other down: values may go up).
 */
export function valueDirection(before: Uplift, after: Uplift): 'up' | 'down' | 'same' | 'unknown' {
  if (!before || !after) return before === after ? 'same' : 'unknown'
  const dm = after.mult - before.mult
  const da = after.add - before.add
  if (dm === 0 && da === 0) return 'same'
  if (dm >= 0 && da >= 0) return 'up'
  if (dm <= 0 && da <= 0) return 'down'
  return 'unknown'
}
const showAction = (operation: string | null | undefined, value: number | null | undefined, currency: string) =>
  operation === 'ADD' ? `add ${money(Math.round(Number(value) * 100), currency)}` : operation === 'MULTIPLY' ? `× ${value}` : operation === 'SET' ? `set ${money(Math.round(Number(value) * 100), currency)}` : '(none)'
/** A rule's effect in words: its action when it applies, else that it changes nothing. */
const showEffect = (status: string | null | undefined, operation: string | null | undefined, value: number | null | undefined, currency: string) =>
  status === 'ENABLED' ? showAction(operation, value, currency) : 'no change (not applied)'

export function valueRuleChangeDraft(
  customer: string,
  currency: string,
  request: ValueRuleRequest,
  live: { rules: LiveValueRule[]; sets: LiveValueRuleSet[]; campaigns: SmartBiddingCampaign[] },
): GoogleChangeDraft | { refusal: string } {
  const creates = request.create ?? []
  const changes = request.change ?? []
  if (!creates.length && !changes.length) return { refusal: 'Say what to change: create or change.' }
  const operations: GoogleMutateOperation[] = []
  const setOperations: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const spends: string[] = []
  const warnings: string[] = []
  const skipped: string[] = []
  const before: ValueRuleRecord = { rules: [], created: [] }
  const after: ValueRuleRecord = { rules: [], created: [] }
  const valueBidders = (campaignId: string | null) => live.campaigns.filter((c) =>
    c.status === 'ENABLED' && !!c.bidding && VALUE_BIDDING.has(c.bidding) && (campaignId === null || c.campaignId === campaignId))
  const ruleRes = (id: string | number) => `${customer}/conversionValueRules/${id}`

  // ── new rules, grouped by the rule set that holds them ──
  const byTarget = new Map<string, { campaignId: string | null; temps: string[]; dims: ValueRuleDimension[] }>()
  let temp = 0
  for (const [i, c] of creates.entries()) {
    const what = `New value rule ${i + 1}`
    const problem = actionProblem(c, what, true)
    if (problem) return { refusal: problem }
    const dims: ValueRuleDimension[] = []
    const body: Record<string, unknown> = { action: actionJson(c) }
    if (c.devices?.length) {
      dims.push('DEVICE')
      body.deviceCondition = { deviceTypes: [...new Set(c.devices)] }
    }
    if (c.locations) {
      const include = c.locations.include ?? []
      const exclude = c.locations.exclude ?? []
      if (!include.length && !exclude.length) return { refusal: `${what}: a location condition names locations to include or exclude.` }
      if ([...include, ...exclude].some((id) => !DIGITS.test(id))) return { refusal: `${what}: a location is Google's geo target id (digits, e.g. 2380 = Italy).` }
      const matchType = c.locations.presenceOnly ? 'LOCATION_OF_PRESENCE' : 'ANY'
      dims.push('GEO_LOCATION')
      body.geoLocationCondition = {
        ...(include.length ? { geoTargetConstants: include.map((id) => `geoTargetConstants/${id}`), geoMatchType: matchType } : {}),
        ...(exclude.length ? { excludedGeoTargetConstants: exclude.map((id) => `geoTargetConstants/${id}`), excludedGeoMatchType: matchType } : {}),
      }
    }
    if (c.audiences) {
      const lists = c.audiences.userLists ?? []
      const interests = c.audiences.userInterests ?? []
      if (!lists.length && !interests.length) return { refusal: `${what}: an audience condition names user lists or user interests.` }
      if ([...lists, ...interests].some((id) => !DIGITS.test(id))) return { refusal: `${what}: a user list or user interest is Google's id (digits).` }
      dims.push('AUDIENCE')
      body.audienceCondition = {
        ...(lists.length ? { userLists: lists.map((id) => `${customer}/userLists/${id}`) } : {}),
        ...(interests.length ? { userInterests: interests.map((id) => `${customer}/userInterests/${id}`) } : {}),
      }
    }
    if (!dims.length) return { refusal: `${what}: give its condition — devices, locations or audiences (at most two).` }
    if (dims.length > 2) return { refusal: `${what}: Google allows at most two conditions of devices, locations and audiences on one rule.` }
    const campaignId = c.campaignId ?? null
    if (campaignId && !live.campaigns.some((x) => x.campaignId === campaignId)) return { refusal: `${what}: campaign ${campaignId} is not in the account (or is removed).` }
    temp -= 1
    const status = c.enable ? 'ENABLED' : 'PAUSED'
    operations.push({ conversionValueRuleOperation: { create: { resourceName: ruleRes(temp), ...body, status } } })
    const id = NEW_RULE(i + 1)
    after.created.push({ valueRuleId: id, status })
    const where = campaignId ? `campaign "${live.campaigns.find((x) => x.campaignId === campaignId)?.name}"` : 'the account'
    lines.push([`new value rule ${i + 1} (${where})`, null, `${showAction(actionJson(c).operation, actionJson(c).value as number, currency)} when ${dims.map((d) => d.toLowerCase().replace('_', ' ')).join(' + ')} matches, ${status}`])
    const effect = valueDirection({ mult: 1, add: 0 }, upliftOf(status, actionJson(c).operation, actionJson(c).value as number))
    if (effect === 'up' || effect === 'unknown') {
      spends.push(chaseSentence(`New value rule ${i + 1} raises conversion values in ${where} (value bidding)`, valueBidders(campaignId)))
    }
    if (effect === 'down') warnings.push(`New value rule ${i + 1} lowers conversion values in ${where}: value bidding may bid lower.`)
    const key = campaignId ?? 'account'
    const group = byTarget.get(key) ?? { campaignId, temps: [], dims: [] }
    group.temps.push(ruleRes(temp))
    for (const d of dims) if (!group.dims.includes(d)) group.dims.push(d)
    byTarget.set(key, group)
  }

  // ── each group into its rule set (the existing one, or a new one) ──
  for (const group of byTarget.values()) {
    const set = live.sets.find((s) => s.categories.length === 0 && (group.campaignId
      ? s.attachment === 'CAMPAIGN' && s.campaignId === group.campaignId
      : s.attachment === 'CUSTOMER'))
    const where = group.campaignId ? `campaign ${group.campaignId}'s rule set` : 'the account\'s rule set'
    if (set) {
      const dims = [...set.dimensions]
      for (const d of group.dims) if (!dims.includes(d)) dims.push(d)
      if (dims.length > 2) return { refusal: `${where} uses ${set.dimensions.join(' and ')}: Google allows two dimensions per rule set, so a rule on ${group.dims.filter((d) => !set.dimensions.includes(d)).join(' and ')} cannot join it.` }
      const mask = ['conversion_value_rules', ...(dims.length !== set.dimensions.length ? ['dimensions'] : [])]
      setOperations.push({
        conversionValueRuleSetOperation: {
          update: { resourceName: `${customer}/conversionValueRuleSets/${set.ruleSetId}`, conversionValueRules: [...set.ruleIds.map((id) => ruleRes(id)), ...group.temps], ...(mask.includes('dimensions') ? { dimensions: dims } : {}) },
          updateMask: mask.join(','),
        },
      })
      after.ruleSets = [...(after.ruleSets ?? []), { ruleSetId: set.ruleSetId, created: false, campaignId: group.campaignId }]
      lines.push([where, `${plural(set.ruleIds.length, 'rule')}`, `${plural(set.ruleIds.length + group.temps.length, 'rule')}`])
    } else {
      temp -= 1
      setOperations.push({
        conversionValueRuleSetOperation: {
          create: {
            resourceName: `${customer}/conversionValueRuleSets/${temp}`,
            attachmentType: group.campaignId ? 'CAMPAIGN' : 'CUSTOMER',
            ...(group.campaignId ? { campaign: `${customer}/campaigns/${group.campaignId}` } : {}),
            conversionValueRules: group.temps,
            dimensions: group.dims,
          },
        },
      })
      after.ruleSets = [...(after.ruleSets ?? []), { ruleSetId: 'new', created: true, campaignId: group.campaignId }]
      lines.push([where, '(none)', `new, ${plural(group.temps.length, 'rule')} (${group.dims.join(', ')})`])
    }
  }

  // ── changes to existing rules ──
  const seen = new Set<string>()
  for (const ch of changes) {
    const r = live.rules.find((x) => x.valueRuleId === ch.valueRuleId)
    const what = `Value rule ${ch.valueRuleId}`
    if (!r) return { refusal: `${what} is not in the account (or is removed).` }
    if (seen.has(ch.valueRuleId)) return { refusal: `${what} is named twice.` }
    seen.add(ch.valueRuleId)
    const problem = actionProblem(ch, what, false)
    if (problem) return { refusal: problem }
    if (r.operation === 'SET' && (ch.add !== undefined || ch.multiply !== undefined)) return { refusal: `${what} sets a value (SET): Nexus changes only its status.` }
    const was: RuleFields = { valueRuleId: r.valueRuleId }
    const now: RuleFields = { valueRuleId: r.valueRuleId }
    const update: Record<string, unknown> = { resourceName: ruleRes(r.valueRuleId) }
    const mask: string[] = []
    if (ch.add !== undefined || ch.multiply !== undefined) {
      const next = actionJson(ch)
      const same = next.operation === r.operation && Number(next.value) === Number(r.value)
      if (same) skipped.push(`${what}: its action is already ${showAction(r.operation, r.value, currency)}.`)
      else {
        update.action = next
        mask.push('action.operation', 'action.value')
        was.operation = r.operation
        if (r.operation === 'ADD') was.addCents = Math.round(Number(r.value) * 100)
        else was.multiply = r.value
        now.operation = next.operation
        if (next.operation === 'ADD') now.addCents = ch.add!
        else now.multiply = ch.multiply!
        lines.push([`value rule ${r.valueRuleId}: action`, showAction(r.operation, r.value, currency), showAction(next.operation, next.value as number, currency)])
      }
    }
    if (ch.status !== undefined) {
      if (ch.status === r.status) skipped.push(`${what} is already ${ch.status}.`)
      else {
        update.status = ch.status
        mask.push('status')
        was.status = r.status
        now.status = ch.status
        lines.push([`value rule ${r.valueRuleId}: status`, r.status, ch.status])
      }
    }
    if (!mask.length) continue
    operations.push({ conversionValueRuleOperation: { update, updateMask: mask.join(',') } })
    before.rules.push(was)
    after.rules.push(now)
    const set = live.sets.find((s) => s.ruleIds.includes(r.valueRuleId))
    if (!set) warnings.push(`${what} is in no rule set, so it applies nowhere (yet).`)
    // Money: what a matching conversion is worth before and after (a paused rule is × 1); a pause of a rule below 1
    // raises values as surely as a higher factor does.
    const statusAfter = now.status ?? r.status
    const opAfter = now.operation ?? r.operation
    const valueAfter = now.operation === 'ADD' ? (now.addCents ?? 0) / 100 : now.operation === 'MULTIPLY' ? now.multiply : r.value
    const direction = valueDirection(upliftOf(r.status, r.operation, r.value), upliftOf(statusAfter, opAfter, valueAfter))
    const fromTo = `${showEffect(r.status, r.operation, r.value, currency)} → ${showEffect(statusAfter, opAfter, valueAfter, currency)}`
    const campaignId = set?.attachment === 'CAMPAIGN' ? set.campaignId : null
    if (set && (direction === 'up' || direction === 'unknown')) {
      spends.push(chaseSentence(`${what} ${direction === 'up' ? 'raises' : 'may raise'} conversion values (${fromTo}; value bidding)`, valueBidders(campaignId)))
    }
    if (set && direction === 'down') warnings.push(`${what} lowers conversion values (${fromTo}): value bidding may bid lower.`)
    if (now.status === 'PAUSED') warnings.push(`${what} is paused: from now it no longer changes conversion values (they count as the sale reports them).`)
  }

  if (!operations.length) return { refusal: `Nothing to change: ${skipped.join(' ') || 'every rule is already so.'}` }
  const { changes: table, more } = changeLines(lines)
  const made = after.created.length
  const changed = after.rules.length
  return {
    summary: made && changed
      ? `Make ${plural(made, 'conversion value rule')} and change ${plural(changed, 'conversion value rule')}.`
      : made ? `Make ${plural(made, 'conversion value rule')}.` : `Change ${plural(changed, 'conversion value rule')}.`,
    changes: table,
    totals: { created: made, changed, ...(more ? { moreLines: more } : {}) },
    warnings,
    spendsMoney: spends,
    skipped,
    // Rules first (the new set names them by their temporary ids), then the sets.
    operations: [...operations, ...setOperations],
    stands: {
      rules: live.rules.filter((r) => seen.has(r.valueRuleId)).map((r) => `${r.valueRuleId}:${r.status}:${r.operation}:${r.value}`).sort(),
      sets: creates.length ? live.sets.map((s) => `${s.ruleSetId}:${s.attachment}:${s.campaignId ?? ''}:${s.ruleIds.join(',')}:${s.dimensions.join(',')}`).sort() : [],
    },
    before,
    after,
  }
}

/** After the run: the ids Google gave the rules (and the set) it made, in create order. */
export function valueRuleRecordAfterRun(after: ValueRuleRecord, responses: Array<Record<string, { resourceName?: string } | undefined>>): ValueRuleRecord {
  const tail = (n: string) => n.slice(n.lastIndexOf('/') + 1)
  const rules = responses.map((r) => r.conversionValueRuleResult?.resourceName).filter((n): n is string => !!n)
  const sets = responses.map((r) => r.conversionValueRuleSetResult?.resourceName).filter((n): n is string => !!n)
  const out = structuredClone(after)
  // The first results are the rules it made (creates come before updates of other rules).
  out.created = out.created.map((c, i) => ({ ...c, valueRuleId: rules[i] ? tail(rules[i]) : c.valueRuleId }))
  // One set result per group, in group order (updated sets answer too).
  if (out.ruleSets) out.ruleSets = out.ruleSets.map((s, i) => (s.created && sets[i] ? { ...s, ruleSetId: tail(sets[i]) } : s))
  return out
}
