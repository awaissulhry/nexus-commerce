/**
 * Reviews › Requests › Rules — the words of the rules grid (channel, markets, first try, window, skips, the A/B mark),
 * the warnings about rules that match no orders, the tiles, and what each bulk action would change (Owner ruling 7:
 * a bulk action counts the rules it changes; when it can change none it is held and names the rule that blocks it).
 * The server decides again (`POST /review-rules/bulk` → `{ changed, held }`); this file mirrors its rules
 * (review-queue.service.ts `rulesBulkPlan`). Pure; tested in rulesModel.vitest.test.ts.
 */
import type { RuleEmailText } from '@nexus/shared/review-request-text'
import { COUNTRY_NAMES } from '@/app/_shared/app-nav'
import { EBAY_NOT_EMAILED, NOT_MEASURABLE, rateNotMeasurable } from '../../../_lib/reviewWords'

export interface RuleItem {
  id: string
  name: string
  scope: string
  marketplace: string | null
  isActive: boolean
  minDaysSinceDelivery: number
  maxDaysSinceDelivery: number
  exclusions: string[]
  minOrderTotalCents: number | null
  notes: string | null
  useSentimentDiversion?: boolean
  fallbackOnNoResponse?: boolean
  productTypes?: string[]
  sendDelayDays?: number | null
  anchor?: string | null
  sendHourLocal?: number | null
  skipWeekends?: boolean
  shiftToBestDay?: boolean
  /** N3 — the rule's own e-mail text per language (null / absent = the standard text). */
  emailText?: RuleEmailText | null
  requestCount?: number
  updatedAt?: string
  /** `?withStats=1`: requests sent in 30 days. */
  sent30?: number
  /** Their review rate (0..1, the one review rate); null when nothing measurable was sent. */
  rate30?: number | null
  /** Why the rate leaves requests out or has none ("Not measurable: …"), in words. */
  rateWords?: string | null
  /** Orders the rule decided in 30 days. */
  matched30?: number
}

export interface RulesAnswer {
  items: RuleItem[]
  /** Set when the 30-day numbers could not be read (the rules still are). */
  statsError?: string | null
  /** Every request a rule sent in 30 days, as ONE rate (the API's review rate, never an average of the rules' rates). */
  statsAll?: { sent30: number; rate30: number | null; rateWords: string | null } | null
}

/** The channels Nexus asks buyers on. Etsy and eBay ask their buyers themselves (eBay: Owner, 2026-10-27). */
export const ASKED_SCOPES = ['AMAZON_PER_MARKETPLACE', 'AMAZON_GLOBAL', 'SHOPIFY'] as const

const SCOPE_CHANNEL: Record<string, string> = {
  AMAZON_PER_MARKETPLACE: 'Amazon',
  AMAZON_GLOBAL: 'Amazon',
  EBAY: 'eBay',
  SHOPIFY: 'Shopify',
  WOOCOMMERCE: 'WooCommerce',
  ETSY: 'Etsy',
  MANUAL: 'Manual orders',
}

export const SKIP_WORDS: Record<string, string> = {
  has_refund: 'Refunded',
  has_active_return: 'Return open',
  is_cancelled: 'Cancelled',
  asked_buyer_90d: 'Asked in the last 90 days',
}

const SHIPPED_BY_WORDS: Record<string, string> = {
  fba_only: 'Amazon ships (FBA) only',
  fbm_only: 'We ship (FBM) only',
}

export function channelWords(rule: Pick<RuleItem, 'scope'>): string {
  return SCOPE_CHANNEL[rule.scope] ?? rule.scope
}

export function isAmazonScope(scope: string): boolean {
  return scope === 'AMAZON_PER_MARKETPLACE' || scope === 'AMAZON_GLOBAL'
}

/** A per-market Amazon rule with no market: it matches no order. */
export function isBroken(rule: Pick<RuleItem, 'scope' | 'marketplace'>): boolean {
  return rule.scope === 'AMAZON_PER_MARKETPLACE' && !rule.marketplace
}

export function marketsWords(rule: Pick<RuleItem, 'scope' | 'marketplace'>): string {
  if (rule.scope === 'AMAZON_PER_MARKETPLACE') return rule.marketplace ? COUNTRY_NAMES[rule.marketplace] ?? rule.marketplace : 'No market set'
  return 'All markets'
}

const ANCHOR_WORDS: Record<string, string> = { DELIVERY: 'delivery', SHIP: 'shipping', PURCHASE: 'purchase' }

/** "Day 7" + "after delivery", or the product-type table. */
export function firstTryWords(rule: Pick<RuleItem, 'scope' | 'sendDelayDays' | 'anchor'>): { value: string; sub: string } {
  const anchor = isAmazonScope(rule.scope) ? 'delivery' : ANCHOR_WORDS[rule.anchor ?? 'DELIVERY'] ?? 'delivery'
  if (rule.sendDelayDays != null) return { value: `Day ${rule.sendDelayDays}`, sub: `after ${anchor}` }
  return { value: 'By product type', sub: `the Timing table, after ${anchor}` }
}

export function windowWords(rule: Pick<RuleItem, 'minDaysSinceDelivery' | 'maxDaysSinceDelivery'>): string {
  return `Day ${rule.minDaysSinceDelivery}–${rule.maxDaysSinceDelivery}`
}

/** "Refunded, Return open" (+ who ships); none → "Nothing skipped". */
export function skipsWords(rule: Pick<RuleItem, 'exclusions'>): string {
  const words = rule.exclusions.map((e) => SKIP_WORDS[e] ?? SHIPPED_BY_WORDS[e] ?? e)
  return words.length ? words.join(', ') : 'Nothing skipped'
}

const VARIANT = /^(.*) \(variant \d+\)$/

/** A "Duplicate as A/B" copy: side B. */
export function isAbCopy(rule: Pick<RuleItem, 'name'>): boolean {
  return VARIANT.test(rule.name)
}

/** "A" when a B copy of the rule exists, "B" for a copy, else null. */
export function abMark(rule: Pick<RuleItem, 'name'>, rules: readonly Pick<RuleItem, 'name'>[]): 'A' | 'B' | null {
  if (isAbCopy(rule)) return 'B'
  return rules.some((r) => VARIANT.exec(r.name)?.[1] === rule.name) ? 'A' : null
}

/** Why "Duplicate as A/B" is held for a rule, or null. */
export function duplicateHeld(rule: Pick<RuleItem, 'name'>, rules: readonly Pick<RuleItem, 'name'>[]): string | null {
  if (isAbCopy(rule)) return 'This rule is already side B of a test. Duplicate side A instead.'
  const copy = rules.find((r) => VARIANT.exec(r.name)?.[1] === rule.name)
  return copy ? `This rule is already side A of a test (“${copy.name}”). Delete or rename that copy to start another.` : null
}

/** Why a rule cannot be turned on, or null (the server's rules). */
export function turnOnHeld(rule: Pick<RuleItem, 'name' | 'scope' | 'marketplace' | 'isActive'>): string | null {
  if (rule.isActive) return `“${rule.name}” is already on`
  if (isBroken(rule)) return `“${rule.name}” matches no orders: it has no market. Open it and pick one.`
  if (rule.scope === 'EBAY') return `“${rule.name}” asks nobody: ${EBAY_NOT_EMAILED}`
  if (!(ASKED_SCOPES as readonly string[]).includes(rule.scope)) return `“${rule.name}” matches no orders: Nexus asks only Amazon and Shopify buyers.`
  return null
}

export interface RuleWarning { id: string; title: string; detail: string }

/** A warning per rule that matches no orders (no market, a channel Nexus does not ask, or none in 30 days); every eBay rule. */
export function noMatchWarnings(rules: readonly RuleItem[], statsRead: boolean): RuleWarning[] {
  const out: RuleWarning[] = []
  for (const r of rules) {
    if (r.scope === 'EBAY') {
      out.push({ id: r.id, title: `“${r.name}” is for eBay — eBay buyers are not e-mailed`, detail: `${EBAY_NOT_EMAILED} ${r.isActive ? 'Turn it off or delete it.' : 'Delete it, or keep it off.'}` })
    } else if (isBroken(r)) {
      out.push({ id: r.id, title: `“${r.name}” has no market set — it matches no orders`, detail: 'Pick its market, or delete it if a rule for all markets already covers that market.' })
    } else if (r.isActive && !(ASKED_SCOPES as readonly string[]).includes(r.scope)) {
      out.push({ id: r.id, title: `“${r.name}” is for ${channelWords(r)} — it matches no orders`, detail: 'Nexus asks only Amazon and Shopify buyers. Turn it off or delete it.' })
    } else if (r.isActive && statsRead && r.matched30 === 0) {
      out.push({ id: r.id, title: `“${r.name}” matched no orders in the last 30 days`, detail: 'Check its channel, market, product types and skips — or whether another rule wins its orders.' })
    }
  }
  return out
}

export interface RulesTiles { on: number; total: number; sent30: number | null; matched30: number | null; rate30: number | null; rateWords: string | null }

/** Rules on, the 30-day numbers summed, and the rules' review rate as the API counts it (`all`). */
export function rulesTiles(rules: readonly RuleItem[], statsRead: boolean, all: RulesAnswer['statsAll'] = null): RulesTiles {
  const on = rules.filter((r) => r.isActive).length
  if (!statsRead) return { on, total: rules.length, sent30: null, matched30: null, rate30: null, rateWords: null }
  let sent = 0
  let matched = 0
  for (const r of rules) {
    sent += r.sent30 ?? 0
    matched += r.matched30 ?? 0
  }
  return { on, total: rules.length, sent30: sent, matched30: matched, rate30: all?.rate30 ?? null, rateWords: all?.rateWords ?? null }
}

export type RulesBulkAction = 'on' | 'off' | 'delete' | 'test' | 'export'

export interface RulesPlan { apply: string[]; held: { id: string; words: string }[] }

/** Which ticked rules an action changes and which it leaves out. Test run and Export reach every ticked rule. */
export function rulesBulkPlan(rules: readonly RuleItem[], action: RulesBulkAction): RulesPlan {
  const plan: RulesPlan = { apply: [], held: [] }
  for (const r of rules) {
    const why = action === 'on' ? turnOnHeld(r) : action === 'off' && !r.isActive ? `“${r.name}” is already off` : null
    if (why) plan.held.push({ id: r.id, words: why })
    else plan.apply.push(r.id)
  }
  return plan
}

const VERB: Record<RulesBulkAction, string> = { on: 'turned on', off: 'turned off', delete: 'deleted', test: 'test-run', export: 'exported' }

/** The bar's held reason when no ticked rule can change: the blocking rule named (and how many more). */
export function rulesBulkHeld(plan: RulesPlan, action: RulesBulkAction): string | null {
  if (plan.apply.length > 0 || plan.held.length === 0) return null
  const first = plan.held[0].words
  const more = plan.held.length - 1
  return `Nothing to be ${VERB[action]}: ${first}${more ? ` (and ${more} more)` : ''}`
}

/** "Turn on" or "Turn on (2 of 3)" when some ticked rules are left out. */
export function rulesBulkLabel(base: string, plan: RulesPlan): string {
  const total = plan.apply.length + plan.held.length
  return plan.held.length && plan.apply.length ? `${base} (${plan.apply.length} of ${total})` : base
}

/** The toast after the server answered. */
export function rulesBulkResultWords(action: 'on' | 'off' | 'delete', changed: number, held: readonly { words: string }[]): string {
  const what = `${changed} ${changed === 1 ? 'rule' : 'rules'} ${VERB[action]}`
  return held.length ? `${what} · ${held.length} left out: ${held[0].words}` : what
}

/**
 * A rule's 30-day review rate: "7.4%", "Not measurable" when its requests went out but no review can follow them (live
 * audit A02 — never "0.0%"), "—" when it sent nothing.
 */
export function ruleRateWords(r: Pick<RuleItem, 'rate30' | 'rateWords'> | undefined | null): string {
  if (!r) return ''
  if (rateNotMeasurable(r.rate30, r.rateWords)) return NOT_MEASURABLE
  return r.rate30 == null ? '—' : `${(r.rate30 * 100).toFixed(1)}%`
}
