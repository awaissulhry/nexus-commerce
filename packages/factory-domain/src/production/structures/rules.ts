import { PRODUCT_TYPES } from '../../product/styles/rules'
import type { TeamRowIn } from '../order-teams/rules'

/**
 * Order structures and their rules (owb-ss6 step 6.1; build/briefs/owb-ss6.md; _owb-ss-common L10; design order-workflow-2026-11-25
 * § 5zj C "Order structures and their rules", prototype rules.js ruleFor, ruleDead, rulePlace, structOf, planTeams; the form of the
 * real app's InspectionTrigger and ApprovalRule lists: a hand-ordered list, the first that fits wins, a broad line last, a test).
 * Pure: the API (apps/factory-api modules/production/structures) reads the facts and writes the rows; the guards
 * (…_order_structures_guards) are the last word.
 *
 *   a structure   a named way to handle an order: its steps (v1: "as the product says"), its team(s), its office people
 *   a rule        "When an order line is from ⟨a customer, or any⟩ and is ⟨a category, or any⟩ → handle it as ⟨a structure⟩".
 *                 ONE list per company, read from the top: the FIRST open, active rule (whose structure is open) that fits
 *                 the line wins. An exception is a more exact rule above. The last line is fixed and is no row:
 *                 "Everything else → the normal way" (the product's route, the team by hand, as today).
 *   by hand       one order takes a structure (or the normal way) by hand, with why: it wins over every rule for each line
 *                 of the order — unless that structure was closed since, then the rules are read again.
 *
 * It cannot go wrong in silence: a new rule is placed above the first rule that would take all its orders (rulePlace); a rule
 * that a broader rule ABOVE takes whole is "Never used" (ruleDead); two open rules for exactly the same orders are refused
 * (sameOrdersRule; the database's partial uniques OrderStructureRule_open_same_orders(_any_kind) are the last word).
 * Each line of an order takes its own structure (suits and gloves); at Confirm the structures give the teams (planTeams).
 * Words: EN (the web has its own words per code; these explain a line, a try, a refusal).
 */

/**
 * The kinds of product a rule can name: the line's Style.productType.
 * // S4 ProductType: S4's product type profiles (Style.productTypeProfileId, "Molded part", "T-shirt"…) may take this place later.
 */
export const STRUCTURE_CATEGORIES = PRODUCT_TYPES
export type StructureCategory = (typeof STRUCTURE_CATEGORIES)[number]

/** The word of each category in a rule's sentence ("Any customer · Gloves"). */
export const CATEGORY_WORDS: Readonly<Record<StructureCategory, string>> = Object.freeze({
  JACKET: 'Jacket',
  TROUSERS: 'Trousers',
  SUIT: 'Suit',
  GLOVES: 'Gloves',
  VEST: 'Vest',
  OTHER: 'Other',
})

/** Where a line's structure comes from: a rule, the order by hand, or the normal way (OrderStructureFrom). */
export const STRUCTURE_FROM = ['RULE', 'ORDER', 'NORMAL'] as const
export type StructureFrom = (typeof STRUCTURE_FROM)[number]

/** The fixed last line's structure. */
export const NORMAL_WAY = 'The normal way'

/** The most characters of a structure's name, a note, why. */
export const STRUCTURE_LIMITS = Object.freeze({ name: 80, note: 500, whyMin: 3, why: 500, teams: 20, people: 50 })

/** The refusals of the structures, rules and one order by hand, each with its words (409, `refusal/<CODE>`). */
export const STRUCTURE_REFUSALS = {
  NAME_TAKEN: 'An open order structure of this company already has this name.',
  TEAM_NOT_OPEN: 'The teams of a structure are open teams of its company.',
  PERSON_NOT_OFFICE: 'The people of a structure are active office people.',
  STRUCTURE_CLOSED: 'This structure is closed: open it again to change it.',
  STRUCTURE_ALREADY_CLOSED: 'This structure is closed already.',
  STRUCTURE_ALREADY_OPEN: 'This structure is open already.',
  SAME_ORDERS: 'Another open rule is for exactly these orders. Change that rule: two rules for the same orders are never both used.',
  STRUCTURE_NOT_OPEN: 'An open rule gives an open structure of its company: open the structure again, or pick another.',
  CUSTOMER_NOT_OURS: 'A rule names a customer of its own company.',
  RULE_CLOSED: 'This rule is closed: open it again to change it.',
  RULE_ALREADY_CLOSED: 'This rule is closed already.',
  RULE_ALREADY_OPEN: 'This rule is open already.',
  ORDER_NOT_WHOLE: 'Name every open rule of the list once, in its new order.',
  PRINTED: 'The work on this order started at its first print: it keeps its structure, which no longer changes.',
  ORDER_STARTED: 'This order is in work or has ended: its structure no longer changes.',
  ORDER_STRUCTURE_NOT_OPEN: 'An order takes an open structure of its own company by hand.',
} as const
export type StructureRefusal = keyof typeof STRUCTURE_REFUSALS

/** One rule as the rules read it (closed rules are off the list; a rule of a closed structure is skipped). */
export interface StructureRuleFacts {
  readonly id: string
  readonly sortOrder: number
  /** null: any customer. */
  readonly partyId: string | null
  /** null: any category. */
  readonly category: string | null
  readonly structureId: string
  readonly active: boolean
  readonly closed: boolean
  /** Its structure is closed (the rule stays, flagged, and is skipped). */
  readonly structureClosed: boolean
}

/** What a rule reads of an order line: the order's customer and the line's category (null: a customer or kind no rule names). */
export interface StructureLine {
  readonly partyId: string | null
  readonly category: string | null
}

/** The order's open structure by hand (null structure: the normal way by hand). */
export interface StructureOverrideFacts {
  readonly structureId: string | null
  readonly why: string
  /** The structure it names was closed since (then the rules are read again). */
  readonly structureClosed: boolean
}

/** The names the words use (a customer this caller may not see has none: "One customer"). */
export interface RuleNames {
  readonly party?: (partyId: string) => string | null | undefined
  readonly structure?: (structureId: string) => string | null | undefined
}

/** One line's structure: which, from which rule, where it comes from, and why in words. */
export interface LineStructure {
  readonly structureId: string | null
  readonly ruleId: string | null
  readonly from: StructureFrom
  readonly why: string
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** The open rules in their order on the list (by place, then id): closed rules are off the list. */
export function openRules<Rule extends StructureRuleFacts>(rules: readonly Rule[]): Rule[] {
  return rules.filter((rule) => !rule.closed).sort((a, b) => a.sortOrder - b.sortOrder || byId(a.id, b.id))
}

/** A rule that is used: open, switched on, and its structure open. */
export const ruleLive = (rule: StructureRuleFacts): boolean => !rule.closed && rule.active && !rule.structureClosed

/** The rule fits the line: it is used, and its customer and category are the line's (or any). */
export const ruleFits = (rule: StructureRuleFacts, line: StructureLine): boolean =>
  ruleLive(rule) && (rule.partyId === null || rule.partyId === line.partyId) && (rule.category === null || rule.category === line.category)

/** The first rule of the list that fits the line; null: none (the normal way). */
export function ruleFor<Rule extends StructureRuleFacts>(line: StructureLine, rules: readonly Rule[]): Rule | null {
  return openRules(rules).find((rule) => ruleFits(rule, line)) ?? null
}

/** `above` takes every order `rule` could take (its customer and its category are the same, or any). */
export const ruleCovers = (above: Pick<StructureRuleFacts, 'partyId' | 'category'>, rule: Pick<StructureRuleFacts, 'partyId' | 'category'>): boolean =>
  (above.partyId === null || above.partyId === rule.partyId) && (above.category === null || above.category === rule.category)

/** A category's word (an unknown one as it is). */
export const categoryWord = (category: string): string => (CATEGORY_WORDS as Readonly<Record<string, string>>)[category] ?? category

/** A rule's "when": "Seed Racing · Gloves", "Any customer · any category". */
export function ruleWhen(rule: Pick<StructureRuleFacts, 'partyId' | 'category'>, names: RuleNames = {}): string {
  const customer = rule.partyId === null ? 'Any customer' : (names.party?.(rule.partyId) ?? 'One customer')
  const kind = rule.category === null ? 'any category' : categoryWord(rule.category)
  return `${customer} · ${kind}`
}

/** The rule's number on the list (1 first); 0 when it is not on it (closed). */
export function ruleNumber(rule: Pick<StructureRuleFacts, 'id'>, rules: readonly StructureRuleFacts[]): number {
  return openRules(rules).findIndex((open) => open.id === rule.id) + 1
}

/**
 * The structure of ONE order line, and why: an open structure by hand wins (ORDER: a structure, or the normal way); else the
 * first rule that fits (RULE); else "Everything else → the normal way" (NORMAL).
 */
export function structureOf(line: StructureLine, rules: readonly StructureRuleFacts[], override: StructureOverrideFacts | null, names: RuleNames = {}): LineStructure {
  if (override && !override.structureClosed) {
    if (override.structureId === null) return { structureId: null, ruleId: null, from: 'ORDER', why: `Chosen by hand for this order, the normal way: ${override.why}` }
    return { structureId: override.structureId, ruleId: null, from: 'ORDER', why: `Chosen by hand for this order: ${override.why}` }
  }
  const lead = override ? 'The structure chosen by hand is closed, so the rules are read. ' : ''
  const rule = ruleFor(line, rules)
  if (rule) return { structureId: rule.structureId, ruleId: rule.id, from: 'RULE', why: `${lead}Rule ${ruleNumber(rule, rules)} fits (${ruleWhen(rule, names)}).` }
  return { structureId: null, ruleId: null, from: 'NORMAL', why: `${lead}No rule fits: everything else goes the normal way.` }
}

/**
 * The rules that are "Never used": a used rule that a used rule ABOVE takes whole (it takes every order this one could take).
 * Answers rule id → the id of the first rule above that takes it (deadBecause). A rule that is off, or whose structure is closed,
 * is neither dead nor takes another.
 */
export function ruleDead(rules: readonly StructureRuleFacts[]): ReadonlyMap<string, string> {
  const list = openRules(rules)
  const dead = new Map<string, string>()
  list.forEach((rule, index) => {
    if (!ruleLive(rule)) return
    const above = list.slice(0, index).find((other) => ruleLive(other) && ruleCovers(other, rule))
    if (above) dead.set(rule.id, above.id)
  })
  return dead
}

/**
 * Where a new (or reopened) rule goes on the list: the index (0 first) above the first used rule that would take all its orders,
 * so it is never dead; none: the end of the list. `rules` are the others (the rule itself not among them).
 */
export function rulePlace(rule: Pick<StructureRuleFacts, 'partyId' | 'category'>, rules: readonly StructureRuleFacts[]): number {
  const list = openRules(rules)
  const at = list.findIndex((other) => ruleLive(other) && ruleCovers(other, rule))
  return at < 0 ? list.length : at
}

/** The open rule (other than `exceptId`) for exactly the same orders — the same customer and category, or both any; null: none. */
export function sameOrdersRule<Rule extends StructureRuleFacts>(rule: Pick<StructureRuleFacts, 'partyId' | 'category'>, rules: readonly Rule[], exceptId: string | null = null): Rule | null {
  return openRules(rules).find((other) => other.id !== exceptId && other.partyId === rule.partyId && other.category === rule.category) ?? null
}

/** "Try an order": the rule that wins for a customer and a category, and why each other rule of the list does not. */
export interface TryAnswer {
  readonly winner: { readonly ruleId: string | null; readonly structureId: string | null; readonly words: string }
  readonly others: Array<{ readonly ruleId: string; readonly words: string }>
}

/** Why `rule` does not win for the line (the winner `winner` or none). */
function notWinning(rule: StructureRuleFacts, line: StructureLine): string {
  if (!rule.active) return 'it is off'
  if (rule.structureClosed) return 'its structure is closed'
  if (rule.partyId !== null && rule.partyId !== line.partyId) return 'it is for another customer'
  if (rule.category !== null && rule.category !== line.category) return 'it is for another category'
  return 'a rule above fits first'
}

/** Nothing is saved: the winner (or the normal way) and, for each other open rule in its order, why it does not win. */
export function tryOrder(line: StructureLine, rules: readonly StructureRuleFacts[], names: RuleNames = {}): TryAnswer {
  const list = openRules(rules)
  const winner = list.find((rule) => ruleFits(rule, line)) ?? null
  const words = winner
    ? `Rule ${list.indexOf(winner) + 1} wins → ${names.structure?.(winner.structureId) ?? 'its structure'}`
    : `No rule fits → ${NORMAL_WAY}`
  return {
    winner: { ruleId: winner?.id ?? null, structureId: winner?.structureId ?? null, words },
    others: list.flatMap((rule, index) => (rule === winner ? [] : [{ ruleId: rule.id, words: `Rule ${index + 1} (${ruleWhen(rule, names)}): ${notWinning(rule, line)}.` }])),
  }
}

/** One line of a confirmed order as planTeams reads it: its pieces and the teams its structure names (open, taking orders), in order. */
export interface PlanLine {
  readonly pieces: number
  readonly teamIds: readonly string[]
}

/**
 * The teams the structures of an order's lines give it at Confirm, as an order's team rows (none: no structure names a team — the
 * team by hand, as today). The same teams for every line → TOGETHER (every team, no share; the first in charge). Each line one team
 * and at least two teams → SPLIT: each team makes the baskets of ITS lines (its share = their pieces), the first line's team in
 * charge. Anything else (a line with no team or with several, beside lines with others) → they work together.
 */
export function planTeams(lines: readonly PlanLine[]): TeamRowIn[] {
  const all = [...new Set(lines.flatMap((line) => line.teamIds))]
  if (all.length === 0) return []
  const together = (): TeamRowIn[] => all.map((teamId, index) => ({ teamId, inCharge: index === 0, basketShare: null }))
  const first = lines[0]?.teamIds.join('|') ?? ''
  if (lines.every((line) => line.teamIds.join('|') === first)) return together()
  if (lines.some((line) => line.teamIds.length !== 1)) return together()
  const shares = new Map<string, number>()
  for (const line of lines) {
    const teamId = line.teamIds[0]!
    shares.set(teamId, (shares.get(teamId) ?? 0) + Math.max(0, Math.floor(line.pieces)))
  }
  if (shares.size < 2 || [...shares.values()].some((share) => share < 1)) return together()
  return [...shares].map(([teamId, share], index) => ({ teamId, inCharge: index === 0, basketShare: share }))
}
