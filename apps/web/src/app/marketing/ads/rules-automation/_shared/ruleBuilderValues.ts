/**
 * ruleBuilderValues.ts — the numbers a person types into the Amazon Ads rule builder and the budget schedule
 * builder, read the way the server reads them (`@nexus/shared/ads-number`).
 *
 * 4g (2026-10-04; review 4.1 web, 5.8) — the builders did `Number(v)`. "12,50" is NaN, JSON writes NaN as `null`,
 * and the server reads a null ceiling or cap as "none": a Max bid of 12,50 saved a rule with NO bid ceiling, and a
 * spend ceiling typed with a comma REMOVED the ceiling on edit. The schedule builder did `Number(v) || 0`, so
 * "Decrease by 12,5" saved as 0%. The server cannot refuse `null` (a deliberate null clears a cap), so the screen
 * must never send one for a typed value. Here every typed value is read with either decimal separator and held to
 * its range; a value that fails gives a sentence the screen shows by the field, and Save stays blocked until it is
 * fixed. Only an EMPTY field means its default, and each field says what that is.
 */
import { checkDecimal, DECIMAL_RANGE, floorAboveCeiling, parseDecimalInput, type DecimalRange } from '@nexus/shared/ads-number'

/**
 * 5.8 — the lowest bid a rule writes. The bid action floors every bid at max(€0.05, the rule's Min bid)
 * (`BID_FLOOR_CENTS` in automation-action-handlers.ts), so a lower Min bid was a promise the engine never kept.
 */
export const BID_FLOOR_EUR = 0.05
/** Amazon's lowest daily budget. */
export const BUDGET_FLOOR_EUR = 1
/** Amazon's largest placement bid adjustment. */
export const PLACEMENT_MAX_PCT = 900
/** A new keyword's lowest bid: the harvest engine raises a lower custom bid to this (`resolveHarvestBidEur`). */
export const HARVEST_BID_FLOOR_EUR = 0.02
/** What an empty "protect converting terms" window means, and the longest the engine reads (`ads-protect-converting.ts`). */
export const PROTECT_DAYS_DEFAULT = 30
export const PROTECT_DAYS_MAX = 365

/** One typed field: what to send, and the sentence to show when it cannot be saved (`null` = fine). */
export interface FieldRead {
  value: number | string | null
  error: string | null
}

/**
 * Read one field. `blank` is what an empty field means. A value that cannot be read is passed on as typed — the
 * server refuses it and the engine's preview matches nothing — and never as `null`, 0 or the default.
 */
export function readField(raw: string, label: string, range: DecimalRange, blank: number | null, required = false): FieldRead {
  const check = checkDecimal(raw, label, range, required)
  const read = parseDecimalInput(raw)
  return { value: read.ok ? (read.value ?? blank) : raw.trim(), error: check.ok ? null : check.error }
}

/** "12,5" → "12.5", so every later reader sees one spelling. Blank or unreadable text stays as typed. */
export function normalizeDecimalText(raw: string): string {
  const read = parseDecimalInput(raw)
  return read.ok && read.value != null ? String(read.value) : raw
}

export interface RuleNumberInputs {
  budgetFloor: string
  budgetCeiling: string
  placeFloor: string
  placeCeiling: string
  bidFloor: string
  bidCeiling: string
  maxAdSpend: string
  maxWrites: string
  maxExecs: string
  protectDays: string
  everyN: string
  harvestBid: string
}
export type RuleNumberKey = keyof RuleNumberInputs

/** Which of the inputs this rule sends — the ones it does not send are not held against Save. */
export interface RuleNumberShape {
  /** An engine-native rule: its save sends only the name, the criteria and the three caps. */
  locked: boolean
  budget: boolean
  placement: boolean
  bidLike: boolean
  negative: boolean
  harvest: boolean
  harvestBidMode: string
  customFrequency: boolean
}

export interface RuleNumbers {
  /** What each field sends; read every field, whether or not this rule sends it. */
  values: Record<RuleNumberKey, number | string | null>
  /** Why Save is blocked, by field; only fields this rule sends. Empty = every number can be saved. */
  errors: Partial<Record<RuleNumberKey, string>>
  /** The three caps as the API takes them; `undefined` = not sent (blank, or failing its check — Save is held then). */
  caps: { maxDailyAdSpendCentsEur?: number; maxWritesPerDay?: number; maxExecutionsPerDay?: number }
}

const WHOLE_FROM_ONE: DecimalRange = { min: 1, whole: true }

/** Every number the rule builder sends besides the criteria, read and range-checked. */
export function readRuleNumbers(inp: RuleNumberInputs, shape: RuleNumberShape): RuleNumbers {
  const harvestRange: DecimalRange = shape.harvestBidMode === 'fixed' ? { min: HARVEST_BID_FLOOR_EUR } : DECIMAL_RANGE.increasePct
  const reads: Record<RuleNumberKey, FieldRead> = {
    budgetFloor: readField(inp.budgetFloor, 'Min daily budget', { min: BUDGET_FLOOR_EUR }, BUDGET_FLOOR_EUR),
    budgetCeiling: readField(inp.budgetCeiling, 'Max daily budget', DECIMAL_RANGE.money, null),
    placeFloor: readField(inp.placeFloor, 'Min placement modifier', DECIMAL_RANGE.placementPct, 0),
    placeCeiling: readField(inp.placeCeiling, 'Max placement modifier', DECIMAL_RANGE.placementPct, PLACEMENT_MAX_PCT),
    bidFloor: readField(inp.bidFloor, 'Min bid', { min: BID_FLOOR_EUR }, BID_FLOOR_EUR),
    bidCeiling: readField(inp.bidCeiling, 'Max bid', DECIMAL_RANGE.money, null),
    maxAdSpend: readField(inp.maxAdSpend, 'Max daily ad spend', DECIMAL_RANGE.money, null),
    maxWrites: readField(inp.maxWrites, 'Max writes per day', WHOLE_FROM_ONE, null),
    maxExecs: readField(inp.maxExecs, 'Max runs per day', WHOLE_FROM_ONE, null),
    protectDays: readField(inp.protectDays, 'Protection window (days)', { min: 1, max: PROTECT_DAYS_MAX, whole: true }, PROTECT_DAYS_DEFAULT),
    everyN: readField(inp.everyN, 'The “Every” number', WHOLE_FROM_ONE, 1),
    // Custom bid must have a value (the engine refuses a blank one); a blank "CPC + %" is CPC + 0%.
    harvestBid: readField(inp.harvestBid, shape.harvestBidMode === 'fixed' ? 'Custom bid' : 'Percent above CPC', harvestRange, shape.harvestBidMode === 'fixed' ? null : 0, shape.harvestBidMode === 'fixed'),
  }
  const sent: RuleNumberKey[] = ['maxAdSpend', 'maxWrites', 'maxExecs']
  if (!shape.locked) {
    if (shape.budget) sent.push('budgetFloor', 'budgetCeiling')
    if (shape.placement) sent.push('placeFloor', 'placeCeiling')
    if (shape.bidLike) sent.push('bidFloor', 'bidCeiling')
    if (shape.negative) sent.push('protectDays')
    if (shape.harvest && (shape.harvestBidMode === 'fixed' || shape.harvestBidMode === 'cpcPlus')) sent.push('harvestBid')
    if (shape.customFrequency) sent.push('everyN')
  }
  const errors: Partial<Record<RuleNumberKey, string>> = {}
  for (const k of sent) if (reads[k].error) errors[k] = reads[k].error as string
  // A floor above its ceiling can never be met, and the server refuses it: said on the ceiling field.
  const pair = (floor: RuleNumberKey, ceiling: RuleNumberKey, floorWords: string, ceilingWords: string) => {
    if (!sent.includes(ceiling) || errors[floor] || errors[ceiling]) return
    const f = reads[floor].value
    const c = reads[ceiling].value
    if (typeof f === 'number' && typeof c === 'number' && floorAboveCeiling(f, c)) {
      errors[ceiling] = `${ceilingWords} (${c}) is below the ${floorWords.toLowerCase()} (${f}): raise the max or lower the min.`
    }
  }
  pair('budgetFloor', 'budgetCeiling', 'Min daily budget', 'Max daily budget')
  pair('placeFloor', 'placeCeiling', 'Min placement modifier', 'Max placement modifier')
  pair('bidFloor', 'bidCeiling', 'Min bid', 'Max bid')
  const num = (k: RuleNumberKey) => (!reads[k].error && typeof reads[k].value === 'number' ? (reads[k].value as number) : undefined)
  const spend = num('maxAdSpend')
  const values = Object.fromEntries(Object.entries(reads).map(([k, r]) => [k, r.value])) as Record<RuleNumberKey, number | string | null>
  return {
    values,
    errors,
    caps: {
      maxDailyAdSpendCentsEur: spend != null ? Math.round(spend * 100) : undefined,
      maxWritesPerDay: num('maxWrites'),
      maxExecutionsPerDay: num('maxExecs'),
    },
  }
}

/** The THEN side of a criteria card: budget rules move a budget, placement rules a modifier, bid-like rules a bid. */
export type ThenKind = 'budget' | 'placement' | 'bid'
type ThenSpec = { words: string; range: DecimalRange }
const MONEY_THEN: Record<string, ThenSpec> = {
  set: { words: 'The “Set to” value', range: DECIMAL_RANGE.money },
  incPct: { words: 'The “Increase by %” value', range: DECIMAL_RANGE.increasePct },
  decPct: { words: 'The “Decrease by %” value', range: DECIMAL_RANGE.decreasePct },
  incAbs: { words: 'The “Increase by €” value', range: DECIMAL_RANGE.money },
  decAbs: { words: 'The “Decrease by €” value', range: DECIMAL_RANGE.money },
}
/** The same words and ranges the server holds a saved rule to (`ads-rule-values.ts`). */
const THEN_SPEC: Record<ThenKind, Record<string, ThenSpec>> = {
  budget: MONEY_THEN,
  placement: {
    set: { words: 'The “Set to %” value', range: DECIMAL_RANGE.placementPct },
    incPct: MONEY_THEN.incPct,
    decPct: MONEY_THEN.decPct,
  },
  bid: {
    ...MONEY_THEN,
    targetAcos: { words: 'The target ACoS', range: DECIMAL_RANGE.increasePct },
    curBidTargetAcos: { words: 'The target ACoS', range: DECIMAL_RANGE.increasePct },
  },
}

export interface CriteriaProblems {
  /** One entry per condition, in screen order: the sentence, or `null` when the value is fine. */
  conditions: Array<string | null>
  then: string | null
  /** Every sentence above, in screen order; empty = the card's numbers can be saved. */
  all: string[]
}

/**
 * One criteria card's number problems. Blank values are not reported here: the builder already holds Save until
 * every value is filled. `then` is `null` when the card sends no THEN value (an ad-group rule, an engine-native
 * rule's criteria-only save, or an action that computes its own number).
 */
export function criteriaProblems(
  conditions: ReadonlyArray<{ metric: string; value: string }>,
  then: { kind: ThenKind; op: string; value: string } | null,
): CriteriaProblems {
  const say = (check: ReturnType<typeof checkDecimal>) => (check.ok === false ? check.error : null)
  const conds = conditions.map((c) => say(checkDecimal(c.value, c.metric || 'The value')))
  const spec = then ? THEN_SPEC[then.kind][then.op] : undefined
  const thenErr = then ? say(checkDecimal(then.value, spec?.words ?? 'The THEN value', spec?.range ?? {})) : null
  return { conditions: conds, then: thenErr, all: [...conds, thenErr].filter((e): e is string => e != null) }
}

const SCHEDULE_VALUE: Record<string, ThenSpec> = {
  set: { words: 'Set budget to (€)', range: { min: BUDGET_FLOOR_EUR } },
  incPct: { words: 'Increase budget by (%)', range: DECIMAL_RANGE.increasePct },
  decPct: { words: 'Decrease budget by (%)', range: DECIMAL_RANGE.decreasePct },
}
const MULTIPLIER_VALUE: ThenSpec = { words: 'Multiplier (×)', range: DECIMAL_RANGE.multiplier }

/**
 * One budget schedule window's value, held to the range the server holds it to (`ads-budget-schedule.service.ts`):
 * a set budget is at least €1, a decrease at most 100%, a multiplier above 0. Blank is `null` and no error — a row
 * without a value is incomplete, and incomplete rows are not saved.
 */
export function scheduleWindowValue(
  scheduleType: string,
  w: { day: string; start: string; end: string; adj: string; value: string },
): FieldRead {
  const spec = scheduleType === 'budget-multiplier' ? MULTIPLIER_VALUE : SCHEDULE_VALUE[w.adj]
  const when = `${w.day} ${w.start && w.end ? `${w.start}–${w.end}` : '(all day)'}`
  return readField(w.value, `${when}: ${spec?.words ?? 'the value'}`, spec?.range ?? {}, null)
}
