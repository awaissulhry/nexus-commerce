/**
 * 4b (review 4.1) — the save-time check of every number an Amazon Ads rule carries: readable (a decimal comma is
 * fine) and inside the range the screens promise. `createAdsRule` / `updateAdsRule` refuse a rule that fails it with
 * a 400 and plain sentences naming each field, before anything is stored.
 *
 * Why at save as well as in the adapter: the adapter fails CLOSED on a number it cannot read (the rule runs as
 * no-match), which keeps a broken rule harmless but silent; here the person hears why while they can still fix it.
 * The ranges — a decrease is at most 100%, a placement adjustment 0–900%, money never negative, a floor not above
 * its ceiling — are checked only here: the handlers clamp whatever is already stored, so a stored rule keeps
 * running exactly as it did until someone edits it.
 */
import { checkDecimal, DECIMAL_RANGE, floorAboveCeiling, type DecimalRange } from '@nexus/shared/ads-number'

type Ops = Record<string, { words: string; range: DecimalRange; blankOk?: boolean }>
const MONEY_OPS: Ops = {
  set: { words: 'The “Set to” value', range: DECIMAL_RANGE.money },
  incPct: { words: 'The “Increase by %” value', range: DECIMAL_RANGE.increasePct },
  decPct: { words: 'The “Decrease by %” value', range: DECIMAL_RANGE.decreasePct },
  incAbs: { words: 'The “Increase by €” value', range: DECIMAL_RANGE.money },
  decAbs: { words: 'The “Decrease by €” value', range: DECIMAL_RANGE.money },
}
const BID_OPS: Ops = {
  ...MONEY_OPS,
  // The ratio ops: blank is theirs to have (`bid_apply` then uses the account's target ACoS).
  targetAcos: { words: 'The target ACoS', range: DECIMAL_RANGE.increasePct, blankOk: true },
  curBidTargetAcos: { words: 'The target ACoS', range: DECIMAL_RANGE.increasePct, blankOk: true },
}
/** The THEN ops each campaign slug offers (RuleBuilder's BUDGET_ / PLACEMENT_ / BID_ACTIONS) and each value's range. */
const THEN_OPS: Record<string, Ops> = {
  budget: MONEY_OPS,
  placement: {
    set: { words: 'The “Set to %” value', range: DECIMAL_RANGE.placementPct },
    incPct: MONEY_OPS.incPct,
    decPct: MONEY_OPS.decPct,
  },
  bid: BID_OPS,
  sov: BID_OPS,
  'keyword-tracker': BID_OPS,
}
/** Ops that take no value at all: the two computed bids and the status verbs. */
const VALUELESS_OPS = new Set(['setCpc', 'revPerClick', 'pauseTarget', 'enableTarget'])

interface Group { conditions?: Array<{ metric?: string; value?: unknown }>; action?: { op?: string; value?: unknown } }

/**
 * Every problem with the numbers in a rule's `conditions` and `actions`, as sentences; empty when all is well. An
 * engine-native rule's flat conditions and actions are numbers already and are not this check's business — but the
 * builder's nested criteria are read whichever kind of rule they are saved onto.
 */
export function ruleValueProblems(rule: { actions?: unknown; conditions?: unknown }): string[] {
  const out: string[] = []
  const say = (check: ReturnType<typeof checkDecimal>) => { if (check.ok === false) out.push(check.error) }
  const a0 = (Array.isArray(rule.actions) ? rule.actions[0] : null) as Record<string, unknown> | null
  const slug = typeof a0?.type === 'string' ? a0.type : ''
  const groups = (Array.isArray(rule.conditions) ? rule.conditions : []).filter((g): g is Group => Array.isArray((g as Group)?.conditions))
  const thenOps = THEN_OPS[slug]
  groups.forEach((g, i) => {
    const where = groups.length > 1 ? `Criteria ${i + 1}: ` : ''
    for (const c of g.conditions ?? []) if (c?.metric) say(checkDecimal(c.value, `${where}${c.metric}`, {}, true))
    if (!thenOps) return
    const op = String(g.action?.op ?? 'set')
    if (VALUELESS_OPS.has(op)) return
    const spec = thenOps[op]
    if (spec) say(checkDecimal(g.action?.value, `${where}${spec.words}`, spec.range, !spec.blankOk))
    else say(checkDecimal(g.action?.value, `${where}The THEN value`)) // an op the builder does not offer: readable, at least
  })
  if (!a0) return out
  const pair = (floorKey: string, ceilingKey: string, floorWords: string, ceilingWords: string, range: DecimalRange) => {
    const floor = checkDecimal(a0[floorKey], floorWords, range)
    const ceiling = checkDecimal(a0[ceilingKey], ceilingWords, range)
    say(floor); say(ceiling)
    return { floor: floor.ok ? floor.value : null, ceiling: ceiling.ok ? ceiling.value : null }
  }
  const above = (b: { floor: number | null; ceiling: number | null }, floorWords: string, ceilingWords: string) => {
    if (floorAboveCeiling(b.floor, b.ceiling)) out.push(`${floorWords} (${b.floor}) is above the ${ceilingWords.toLowerCase()} (${b.ceiling}): lower the floor or raise the ceiling.`)
  }
  if (slug === 'budget') above(pair('budgetFloor', 'budgetCeiling', 'Budget floor', 'Budget ceiling', DECIMAL_RANGE.money), 'Budget floor', 'Budget ceiling')
  if (slug === 'placement') above(pair('placeFloor', 'placeCeiling', 'Placement floor', 'Placement ceiling', DECIMAL_RANGE.placementPct), 'Placement floor', 'Placement ceiling')
  if (slug === 'bid' || slug === 'sov' || slug === 'keyword-tracker') {
    // SK1's bidFloor/bidCeiling; a blank one falls back to the legacy budget* field — as the adapter reads them.
    const blank = (v: unknown) => v == null || (typeof v === 'string' && v.trim() === '')
    const floorKey = blank(a0.bidFloor) ? 'budgetFloor' : 'bidFloor'
    const ceilingKey = blank(a0.bidCeiling) ? 'budgetCeiling' : 'bidCeiling'
    above(pair(floorKey, ceilingKey, 'Bid floor', 'Bid ceiling', DECIMAL_RANGE.money), 'Bid floor', 'Bid ceiling')
  }
  if (slug === 'negative-targeting') say(checkDecimal(a0.protectDays, 'Protect days', DECIMAL_RANGE.count))
  if (slug === 'keyword-harvesting') say(checkDecimal((a0.bid as { value?: unknown } | undefined)?.value, 'Harvest bid'))
  return out
}

/** The four brakes a rule row carries, and the words the screens use for them. */
const CAPS = {
  maxExecutionsPerDay: 'Max matches per day',
  maxValueCentsEur: 'Max value per run (cents)',
  maxDailyAdSpendCentsEur: 'Daily spend ceiling (cents)',
  maxWritesPerDay: 'Max writes per day',
} as const
type CapKey = keyof typeof CAPS

/**
 * The caps a create or edit sent, read as whole numbers ≥ 0 (a string is read too, never coerced to 0), plus the
 * problems. `null` stays `null` — clearing a cap is a choice — but a value that cannot be read is refused: it never
 * becomes "no cap". Keys the body did not send are left out, so an edit changes only what it names.
 */
export function readRuleCaps(body: Partial<Record<CapKey, unknown>>): { caps: Partial<Record<CapKey, number | null>>; problems: string[] } {
  const caps: Partial<Record<CapKey, number | null>> = {}
  const problems: string[] = []
  for (const key of Object.keys(CAPS) as CapKey[]) {
    if (body[key] === undefined) continue
    const check = checkDecimal(body[key], CAPS[key], DECIMAL_RANGE.count)
    if (check.ok === false) problems.push(check.error)
    else caps[key] = check.value
  }
  return { caps, problems }
}

/** The 400 body: every problem as one sentence the screen can show, and the list. */
export const invalidValuesBody = (problems: string[]) => ({ error: problems.join(' '), problems })
