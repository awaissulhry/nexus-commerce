/**
 * Reviews › Requests › the rule editor's form: the API rule ⇄ the form, the body a save sends, which fields changed
 * (the save bar's count), and why Save is held. Amazon always counts from delivery (Amazon's request is
 * delivery-based) and its first try stays inside day 4–30; "Shipped by" is Amazon's FBA / FBM. Pure; tested in
 * ruleForm.vitest.test.ts.
 */
import type { RuleItem } from '../../_rules/rulesModel'

export const RULE_SCOPES = [
  { value: 'AMAZON_PER_MARKETPLACE', title: 'Amazon — one market', description: 'Pick the market. A rule for one market wins over “all markets”.' },
  { value: 'AMAZON_GLOBAL', title: 'Amazon — all markets', description: 'Every Amazon market at once.' },
  { value: 'EBAY', title: 'eBay', description: 'Not e-mailed: eBay asks its buyers for feedback itself.' },
  { value: 'SHOPIFY', title: 'Shopify', description: 'Our own review email, once per order.' },
] as const

export const RULE_MARKETS = ['IT', 'DE', 'FR', 'ES', 'UK', 'NL', 'BE', 'PL', 'SE', 'IE', 'TR'] as const

export const SKIP_CHOICES = [
  { key: 'has_refund', label: 'Refunded', hint: 'A refund was issued on the order.' },
  { key: 'has_active_return', label: 'Return open', hint: 'A return is still open.' },
  { key: 'is_cancelled', label: 'Cancelled', hint: 'The order was cancelled.' },
  { key: 'asked_buyer_90d', label: 'Asked this buyer in the last 90 days', hint: 'Another order of the same buyer was asked in the last 90 days.' },
] as const

const SKIP_KEYS: readonly string[] = SKIP_CHOICES.map((c) => c.key)
const SHIPPED_BY_KEYS = { fbm: 'fbm_only', fba: 'fba_only' } as const

/** Amazon's window, counted from Nexus's delivery date. */
export const WINDOW_MIN = 4
export const WINDOW_MAX = 30
export const DELAY_MIN = 1
export const DELAY_MAX = 60

export type ShippedBy = 'any' | 'fbm' | 'fba'
export type Anchor = 'DELIVERY' | 'SHIP' | 'PURCHASE'

export interface RuleForm {
  name: string
  notes: string
  isActive: boolean
  scope: string
  marketplace: string | null
  shippedBy: ShippedBy
  productTypes: string[]
  /** Euros, as typed ("49.90"); empty = no minimum. */
  minOrderTotal: string
  firstTryMode: 'table' | 'custom'
  firstTryDays: number
  anchor: Anchor
  windowFrom: number
  windowTo: number
  fixedHour: boolean
  sendHour: number
  skipWeekends: boolean
  shiftToBestDay: boolean
  skips: string[]
  /** Exclusions this editor has no box for, kept as they are. */
  otherExclusions: string[]
  useSentimentDiversion: boolean
  fallbackOnNoResponse: boolean
}

/** A new rule: off until a person turns it on; the safe skips ticked. */
export const NEW_RULE_FORM: RuleForm = {
  name: '',
  notes: '',
  isActive: false,
  scope: 'AMAZON_GLOBAL',
  marketplace: null,
  shippedBy: 'any',
  productTypes: [],
  minOrderTotal: '',
  firstTryMode: 'table',
  firstTryDays: 7,
  anchor: 'DELIVERY',
  windowFrom: WINDOW_MIN,
  windowTo: WINDOW_MAX,
  fixedHour: false,
  sendHour: 10,
  skipWeekends: false,
  shiftToBestDay: false,
  skips: ['has_refund', 'has_active_return', 'is_cancelled'],
  otherExclusions: [],
  useSentimentDiversion: false,
  fallbackOnNoResponse: true,
}

export const isAmazon = (scope: string) => scope === 'AMAZON_PER_MARKETPLACE' || scope === 'AMAZON_GLOBAL'
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number.isFinite(n) ? n : lo)))

/** The API rule → the form. */
export function formFromRule(rule: RuleItem): RuleForm {
  const ex = rule.exclusions ?? []
  return {
    name: rule.name ?? '',
    notes: rule.notes ?? '',
    isActive: !!rule.isActive,
    scope: rule.scope,
    marketplace: rule.marketplace ?? null,
    shippedBy: ex.includes(SHIPPED_BY_KEYS.fbm) ? 'fbm' : ex.includes(SHIPPED_BY_KEYS.fba) ? 'fba' : 'any',
    productTypes: [...(rule.productTypes ?? [])],
    minOrderTotal: rule.minOrderTotalCents != null ? (rule.minOrderTotalCents / 100).toFixed(2) : '',
    firstTryMode: rule.sendDelayDays != null ? 'custom' : 'table',
    firstTryDays: rule.sendDelayDays ?? 7,
    anchor: rule.anchor === 'SHIP' || rule.anchor === 'PURCHASE' ? rule.anchor : 'DELIVERY',
    windowFrom: rule.minDaysSinceDelivery,
    windowTo: rule.maxDaysSinceDelivery,
    fixedHour: rule.sendHourLocal != null,
    sendHour: rule.sendHourLocal ?? 10,
    skipWeekends: !!rule.skipWeekends,
    shiftToBestDay: !!rule.shiftToBestDay,
    skips: ex.filter((e) => SKIP_KEYS.includes(e)),
    otherExclusions: ex.filter((e) => !SKIP_KEYS.includes(e) && e !== SHIPPED_BY_KEYS.fbm && e !== SHIPPED_BY_KEYS.fba),
    useSentimentDiversion: !!rule.useSentimentDiversion,
    fallbackOnNoResponse: rule.fallbackOnNoResponse !== false,
  }
}

/** A minimum order total in cents; empty = none; NaN when it is not a number. */
export function minTotalCents(text: string): number | null {
  const t = text.trim().replace(',', '.')
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : Number.NaN
}

/** What a save sends (POST for a new rule, PATCH for one that exists). Amazon is forced to count from delivery. */
export function ruleBody(form: RuleForm) {
  const amazon = isAmazon(form.scope)
  const shippedBy = amazon && form.shippedBy !== 'any' ? [SHIPPED_BY_KEYS[form.shippedBy]] : []
  return {
    name: form.name.trim(),
    notes: form.notes.trim() || null,
    isActive: form.isActive,
    scope: form.scope,
    marketplace: form.scope === 'AMAZON_PER_MARKETPLACE' ? form.marketplace : null,
    minDaysSinceDelivery: form.windowFrom,
    maxDaysSinceDelivery: form.windowTo,
    exclusions: [...SKIP_KEYS.filter((k) => form.skips.includes(k)), ...shippedBy, ...form.otherExclusions],
    minOrderTotalCents: minTotalCents(form.minOrderTotal),
    productTypes: [...form.productTypes],
    sendDelayDays: form.firstTryMode === 'custom' ? form.firstTryDays : null,
    anchor: amazon ? 'DELIVERY' : form.anchor,
    sendHourLocal: form.fixedHour ? form.sendHour : null,
    skipWeekends: form.skipWeekends,
    shiftToBestDay: form.shiftToBestDay,
    useSentimentDiversion: form.useSentimentDiversion,
    fallbackOnNoResponse: form.fallbackOnNoResponse,
  }
}

export type RuleBody = ReturnType<typeof ruleBody>

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** The fields a save would change (the save bar counts them). */
export function changedFields(initial: RuleForm, form: RuleForm): (keyof RuleBody)[] {
  const a = ruleBody(initial)
  const b = ruleBody(form)
  return (Object.keys(b) as (keyof RuleBody)[]).filter((k) => !same(a[k], b[k]))
}

/** A new channel: Amazon counts from delivery and keeps its first try in day 4–30; a market only for one market. */
export function withScope(form: RuleForm, scope: string): RuleForm {
  const amazon = isAmazon(scope)
  return {
    ...form,
    scope,
    marketplace: scope === 'AMAZON_PER_MARKETPLACE' ? form.marketplace : null,
    anchor: amazon ? 'DELIVERY' : form.anchor,
    firstTryDays: amazon ? clamp(form.firstTryDays, WINDOW_MIN, WINDOW_MAX) : form.firstTryDays,
  }
}

/** The first try's day, kept inside what the channel allows. */
export function withFirstTryDays(form: RuleForm, days: number): RuleForm {
  return { ...form, firstTryDays: isAmazon(form.scope) ? clamp(days, WINDOW_MIN, WINDOW_MAX) : clamp(days, DELAY_MIN, DELAY_MAX) }
}

/** The window, both ends in day 4–30. */
export function withWindow(form: RuleForm, from: number, to: number): RuleForm {
  return { ...form, windowFrom: clamp(from, WINDOW_MIN, WINDOW_MAX), windowTo: clamp(to, WINDOW_MIN, WINDOW_MAX) }
}

export function toggleSkip(form: RuleForm, key: string): RuleForm {
  return { ...form, skips: form.skips.includes(key) ? form.skips.filter((k) => k !== key) : [...form.skips, key] }
}

export interface LintIssue { severity: string; message: string; match?: string }

export const MANAGE_RULE_HELD = "You need 'Manage reviews' to change review-request rules."

/** Why Save is held, in the order a person fixes things; null = it saves. */
export function saveHeld(form: RuleForm, opts: { canManage: boolean; lint: readonly LintIssue[] }): string | null {
  if (!opts.canManage) return MANAGE_RULE_HELD
  if (!form.name.trim()) return 'Give the rule a name first.'
  if (!RULE_SCOPES.some((s) => s.value === form.scope)) return 'Pick Amazon or Shopify — Nexus asks only those buyers (eBay asks its buyers itself).'
  if (form.scope === 'AMAZON_PER_MARKETPLACE' && !form.marketplace) return 'Pick the market first: an Amazon rule for one market needs one.'
  if (form.windowFrom > form.windowTo) return `The window’s first day (${form.windowFrom}) is after its last day (${form.windowTo}).`
  if (Number.isNaN(minTotalCents(form.minOrderTotal))) return 'The minimum order total is not an amount — type it like 49.90, or leave it empty.'
  if (form.firstTryMode === 'custom' && isAmazon(form.scope) && (form.firstTryDays < form.windowFrom || form.firstTryDays > form.windowTo)) {
    return `The first try (day ${form.firstTryDays}) is outside the window (day ${form.windowFrom}–${form.windowTo}): it would never go.`
  }
  const errors = opts.lint.filter((i) => i.severity === 'error')
  if (errors.length) return `Fix ${errors.length} ${errors.length === 1 ? 'problem' : 'problems'} in the notes first: ${errors[0].message}`
  return null
}

/** "3 unsaved changes" */
export function unsavedWords(count: number): string {
  return `${count} unsaved ${count === 1 ? 'change' : 'changes'}`
}
