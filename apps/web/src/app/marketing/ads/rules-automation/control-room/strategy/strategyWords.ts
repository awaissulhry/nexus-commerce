/**
 * ADS AUTONOMY W1-4 — the words and rules of the Control Room's Strategy tab, kept pure so they are tested without a
 * browser (strategyWords.vitest.test.ts).
 *
 * The API decides everything (apps/api services/advertising/ads-strategy): what is in force and where it comes from,
 * which engines read a field (the registry's `readBy`), whether a change raises or lowers, who may save it. This file
 * only says it: a field's value in the market's money, "inherited from …" when a scope does not set it, "stored only"
 * when no engine reads it, the change table of a save, and the words of its buttons. It never judges a raise itself.
 *
 * Units, as the API holds them: a target is a whole percent (30 = 30 %), money is in cents of the market's currency.
 * The inputs take money in the market's own units ("1.50"); `moneyCents` turns it back into cents.
 */
import type { ActionImpact } from '@/design-system/grid/actions/registry'
import { formatMoney } from '../../../_shell/adsMarkets'
import type { CategoryNode, ClaudeEntry, ClaudeLevel, Direction, FieldEntry, HistoryVersion, StrategyChange, StrategyRowOut, StrategySourceOut } from './strategyApi'

export type Level = 'MARKET' | 'CATEGORY' | 'PRODUCT'
export type FieldKey =
  | 'goal' | 'goalNote' | 'target' | 'monthlySpendCapCents' | 'minBidCents' | 'maxBidCents' | 'maxChangePct'
  | 'maxActionsPerRun' | 'protect' | 'harvest' | 'negate' | 'stop' | 'claudeAutonomy' | 'reviewEveryDays'
export type ClaudeActionKey = 'bid' | 'negative' | 'harvest' | 'placement' | 'budget' | 'target' | 'suggestion' | 'stop' | 'restore' | 'create' | 'rule' | 'undo'

/** The scope being edited: the market, or one category or product in it. */
export type Scope = { level: 'MARKET' } | { level: 'CATEGORY' | 'PRODUCT'; id: string; label: string }

/** What each field is called on the screen, in plain words. */
export const FIELD_LABEL: Record<FieldKey, string> = {
  goal: 'Goal',
  goalNote: 'Why',
  target: 'Target',
  monthlySpendCapCents: 'Monthly spend cap',
  minBidCents: 'Lowest bid',
  maxBidCents: 'Highest bid',
  maxChangePct: 'Largest bid change per action',
  maxActionsPerRun: 'Most changes per engine run',
  protect: 'Protected',
  harvest: 'Harvest a search term when',
  negate: 'Negate a search term when',
  stop: 'Temporary stop',
  claudeAutonomy: 'What Claude may do alone',
  reviewEveryDays: 'Claude reviews it every',
}

/** The same, as a noun inside a sentence ("raises the highest bid and the monthly spend cap"). */
export const FIELD_NOUN: Record<FieldKey, string> = {
  goal: 'the goal',
  goalNote: 'the why',
  target: 'the target',
  monthlySpendCapCents: 'the monthly spend cap',
  minBidCents: 'the lowest bid',
  maxBidCents: 'the highest bid',
  maxChangePct: 'the largest bid change',
  maxActionsPerRun: 'the most changes per run',
  protect: 'the protection',
  harvest: 'when a search term is harvested',
  negate: 'when a search term is negated',
  stop: 'the stop bid',
  claudeAutonomy: 'what Claude may do alone',
  reviewEveryDays: 'how often Claude reviews it',
}

/** Fields that are ad-spend money as a whole: hidden from a person who may not see ad spend (the API leaves them out). */
export const MONEY_FIELDS: readonly FieldKey[] = ['target', 'monthlySpendCapCents', 'minBidCents', 'maxBidCents', 'stop']

/**
 * Where a field may be set: the registry's `levels` (apps/api ads-strategy/fields.ts). Two fields are limited: the most
 * changes per run belongs to a market, protection to a category or a product. The API refuses anything else.
 */
export function fieldAllowed(field: FieldKey, level: Level): boolean {
  if (field === 'maxActionsPerRun') return level === 'MARKET'
  if (field === 'protect') return level !== 'MARKET'
  return true
}

export const GOALS: ReadonlyArray<{ value: string; label: string; hint: string }> = [
  { value: 'LAUNCH', label: 'Launch', hint: 'a new product: sales and reviews first, a higher ACoS is fine' },
  { value: 'GROW', label: 'Grow', hint: 'more sales at a steady ACoS' },
  { value: 'PROFIT', label: 'Profit', hint: 'the best margin: cut what does not pay' },
  { value: 'CLEAR_STOCK', label: 'Clear stock', hint: 'sell what is left, even at a thinner margin' },
  { value: 'DEFEND', label: 'Defend', hint: 'keep your place on your own brand and best sellers' },
]
export const goalLabel = (goal: unknown) => GOALS.find((g) => g.value === goal)?.label ?? (typeof goal === 'string' ? goal : '')

/** The kinds of ad action Claude may do alone, in the API's order (CLAUDE_ACTION_TOOLS), in plain words. */
export const CLAUDE_ACTION_LABEL: Record<ClaudeActionKey, string> = {
  bid: 'Bids',
  negative: 'Negative keywords',
  harvest: 'New keywords from search terms',
  placement: 'Placement adjustments',
  budget: 'Budgets',
  target: 'Campaign target ACoS',
  suggestion: 'Rule suggestions',
  stop: 'Stopping a campaign (low bids)',
  restore: "Restoring a campaign's bids",
  create: 'New campaigns',
  rule: 'Ads rules',
  undo: 'Undoing ad changes',
}

// ── Values ────────────────────────────────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>
const rec = (value: unknown): Rec | null => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null)
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Money in the market's currency, from cents ("€1.50"; the number alone when the currency is unknown). */
export const money = (cents: unknown, currency: string | null) => (num(cents) == null ? '—' : formatMoney((cents as number) / 100, currency))

/** A field's value as a person reads it. Groups come under their column names, as the API sends them. */
export function valueText(field: FieldKey | 'targetAcosPct', value: unknown, currency: string | null): string | null {
  if (value == null) return null
  const v = rec(value)
  switch (field) {
    case 'goal':
      return goalLabel(value)
    case 'goalNote':
      return typeof value === 'string' ? `“${value.length > 80 ? `${value.slice(0, 79)}…` : value}”` : null
    case 'target':
      return v && num(v.targetPct) != null ? `${v.targetKind === 'TACOS' ? 'TACoS' : 'ACoS'} ${v.targetPct} %` : null
    case 'targetAcosPct':
      return num(value) != null ? `ACoS ${value} %` : null
    case 'monthlySpendCapCents':
      return `${money(value, currency)} a month`
    case 'minBidCents':
    case 'maxBidCents':
      return money(value, currency)
    case 'maxChangePct':
      return `${value} %`
    case 'maxActionsPerRun':
      return plural(value as number, 'change')
    case 'reviewEveryDays':
      return plural(value as number, 'day')
    case 'protect':
      return value === true ? 'Protected' : 'Not protected'
    case 'harvest':
      if (!v || num(v.harvestMinOrders) == null) return null
      return [
        `${plural(v.harvestMinOrders as number, 'order')}`,
        `${plural(num(v.harvestMinClicks) ?? 0, 'click')}`,
        !('harvestMaxAcosPct' in v) ? 'ACoS hidden' : num(v.harvestMaxAcosPct) != null ? `ACoS at most ${v.harvestMaxAcosPct} %` : 'any ACoS',
        `last ${v.harvestWindowDays} days`,
      ].join(' · ')
    case 'negate':
      if (!v || num(v.negateMinClicks) == null) return null
      return [
        `${plural(v.negateMinClicks as number, 'click')}`,
        'negateMinSpendCents' in v ? `${money(v.negateMinSpendCents, currency)} spent` : 'spend hidden',
        `at most ${plural(num(v.negateMaxOrders) ?? 0, 'order')}`,
        `last ${v.negateWindowDays} days`,
      ].join(' · ')
    case 'stop':
      if (!v || !v.stopMethod) return null
      return v.stopMethod === 'PAUSE' ? 'Pause' : num(v.stopBidCents) != null ? `Low bids at ${money(v.stopBidCents, currency)}` : 'Low bids at Nexus’s own floor'
    case 'claudeAutonomy': {
      if (!v) return null
      const set = Object.entries(v).filter(([, level]) => typeof level === 'string')
      if (!set.length) return null
      return set.map(([action, level]) => `${CLAUDE_ACTION_LABEL[action as ClaudeActionKey] ?? action}: ${CLAUDE_LEVEL_SHORT[level as ClaudeLevel] ?? level}`).join(' · ')
    }
  }
}

export const CLAUDE_LEVEL_SHORT: Record<ClaudeLevel, string> = { off: 'Off', ask: 'Ask', confirm: 'Confirm', auto: 'Auto' }

/** A field's value in force from an effective-view entry (its value under its own column keys; a hidden key stays absent). */
export function entryValue(field: FieldKey | 'targetAcosPct', entry: FieldEntry | undefined): unknown {
  if (!entry) return null
  const pick = (keys: string[], required: string) => (entry[required] == null ? null : Object.fromEntries(keys.filter((k) => k in entry).map((k) => [k, entry[k] ?? null])))
  switch (field) {
    case 'target':
      return pick(['targetKind', 'targetPct'], 'targetKind')
    case 'harvest':
      return pick(['harvestMinOrders', 'harvestMinClicks', 'harvestMaxAcosPct', 'harvestWindowDays'], 'harvestMinOrders')
    case 'negate':
      return pick(['negateMinClicks', 'negateMinSpendCents', 'negateMaxOrders', 'negateWindowDays'], 'negateMinClicks')
    case 'stop':
      return pick(['stopMethod', 'stopBidCents'], 'stopMethod')
    default:
      return entry[field] ?? null
  }
}

// ── Where a value comes from ──────────────────────────────────────────────────────────────────────

/** A row's label without its market ("Full face (IT)" → "Full face"): the market is chosen above. */
export const plainLabel = (label: string) => label.replace(/\s\([A-Z]{2,3}\)$/, '')

/** "Set here", or "Inherited from …", for the row that supplied a value at this scope; null when nothing sets it. */
export function sourceWords(source: StrategySourceOut | null | undefined, scope: Scope): string | null {
  if (!source) return null
  const here = scope.level === 'MARKET' ? source.level === 'market' : source.scopeId === scope.id && source.level === scope.level.toLowerCase()
  if (here) return 'Set here'
  if (source.via === 'parent') return `Inherited from its parent product ${plainLabel(source.label)}`
  if (source.level === 'market') return 'Inherited from the market'
  return `Inherited from the ${source.level} ${plainLabel(source.label)}`
}

/**
 * One line under a field: where the value in force comes from when this scope inherits it, what else binds beside it,
 * or what applies when nothing in the strategy does. Null when this scope sets it and nothing else binds: the field
 * itself shows the value. What Claude may do alone says it per kind of action, on its own rows.
 */
export function inForceLine(field: FieldKey, entry: FieldEntry | undefined, scope: Scope, currency: string | null): string | null {
  if (field === 'monthlySpendCapCents') return capLine(entry, scope, currency)
  if (field === 'claudeAutonomy') return null
  const value = valueText(field, entryValue(field, entry), currency)
  const from = sourceWords(entry?.source ?? null, scope)
  const also = alsoLine(field, entry, currency)
  if (value && from) return from === 'Set here' ? also : [`${from}: ${value}.`, also].filter(Boolean).join(' ')
  // Nothing in the strategy sets it here: say what applies instead, never a blank that reads as "no limit".
  switch (field) {
    case 'target': {
      const today = entry?.today
      return today ? `Not set. Nexus's bid optimiser aims at ${today.targetAcosPct != null ? `${today.targetAcosPct} %, ` : ''}from ${today.from}.` : 'Not set.'
    }
    case 'minBidCents':
    case 'maxBidCents':
      return also ? `Not set in the strategy. ${also}` : 'Not set: no bid limit from the strategy.'
    case 'harvest': {
      const today = entry?.alsoInForce?.[0]
      return today ? `Not set. In force today: ${today.setting}: ${valueText('harvest', today, currency)}.` : 'Not set.'
    }
    case 'negate':
      return "Not set: each engine and rule keeps its own thresholds."
    case 'stop':
      return `Not set: a stop lowers bids to Nexus's own floor (${money(2, currency)}).`
    case 'protect':
      return 'Not set: not protected.'
    case 'maxChangePct':
    case 'maxActionsPerRun':
      return also ? `Not set in the strategy. ${also}` : 'Not set: the engines keep their own limits.'
    default:
      return 'Not set.'
  }
}

/** An older setting that also binds beside the strategy's value (a bid policy, a campaign's own limit, a harvest policy). */
function alsoLine(field: FieldKey, entry: FieldEntry | undefined, currency: string | null): string | null {
  const also = entry?.alsoInForce?.[0]
  if (!also || (field === 'harvest' && !entry?.source)) return null
  const amount = field === 'harvest' ? valueText('harvest', also, currency) : field === 'maxChangePct' ? (num(also.maxChangePct) != null ? `${also.maxChangePct} %` : null) : num(also[field]) != null ? money(also[field], currency) : null
  if (!amount) return null
  const stricter = entry?.stricter?.from ? ` The stricter one binds: ${entry.stricter.from}.` : ''
  return `Also in force: ${also.setting}, ${amount}.${stricter}`
}

/** The monthly cap is not inherited: each scope's own cap binds on its own spend. */
function capLine(entry: FieldEntry | undefined, scope: Scope, currency: string | null): string {
  const caps = entry?.caps ?? []
  const own = caps.find((c) => sourceWords(c, scope) === 'Set here')
  const others = caps.filter((c) => c !== own)
  const parts = [
    own ? `In force: ${money(own.monthlySpendCapCents, currency)} a month on this ${scope.level === 'MARKET' ? "market's" : `${scope.level.toLowerCase()}'s`} own spend.` : 'Not set: no monthly cap of its own.',
    ...others.map((c) => `Also binds: the ${c.level === 'market' ? 'market' : `${c.level} ${plainLabel(c.label)}`}'s cap, ${money(c.monthlySpendCapCents, currency)} a month.`),
  ]
  const plan = entry?.alsoInForce?.[0]
  if (plan && num(plan.monthlyBudgetCents) != null) parts.push(`Also in force: ${plan.setting}, ${money(plan.monthlyBudgetCents, currency)}.`)
  return parts.join(' ')
}

/** Who acts on a field: the registry's readers, or that it is stored only. Never claims a reader the API does not list. */
export function readByWords(readBy: readonly string[] | undefined): { storedOnly: boolean; text: string; full: string | null } {
  if (!readBy?.length) return { storedOnly: true, text: 'Stored only — no engine reads this yet', full: null }
  // The registry's sentences name the reader first; the rest (after ":" or "(") explains it. The full text is one tap away.
  // Each reader once: two entries for one engine (the budget engine reads a market's cap and a product's) read as one.
  const shorts = [...new Set(readBy.map((r) => r.split(/[:(]/)[0].trim()).filter(Boolean))]
  const shown = shorts.length > 2 ? `${shorts.slice(0, 2).join('; ')} and ${shorts.length - 2} more` : shorts.join('; ')
  return { storedOnly: false, text: `Read by ${shown}`, full: readBy.join(' · ') }
}

// ── What Claude may do alone ─────────────────────────────────────────────────────────────────────

const LEVELS: readonly ClaudeLevel[] = ['off', 'ask', 'confirm', 'auto']
const rank = (level: ClaudeLevel) => LEVELS.indexOf(level)
const distinct = (levels: ClaudeLevel[]) => [...new Set(levels)].map((l) => CLAUDE_LEVEL_SHORT[l]).join(' · ')

/**
 * One kind of ad action: the business's rule for its tools, the level this scope inherits, and what Claude may then do
 * alone — the LOWER of the rule and the strategy (W1-8: the strategy narrows, never widens). `own` is the level this
 * scope's draft sets ('' or undefined: not set here).
 */
export function claudeRow(entry: ClaudeEntry, own: ClaudeLevel | '' | undefined, scope: Scope): {
  rule: string
  inherited: string | null
  inheritedLevel: ClaudeLevel | null
  result: string
  noEffect: boolean
} {
  const business = entry.tools.map((t) => t.business)
  const from = sourceWords(entry.source, scope)
  const inheritedLevel = entry.strategy && from && from !== 'Set here' ? entry.strategy : null
  const applied = own || inheritedLevel || null
  const result = entry.tools.map((t) => (applied && rank(applied) < rank(t.business) ? applied : t.business))
  return {
    rule: distinct(business),
    inherited: inheritedLevel ? `${from}: ${CLAUDE_LEVEL_SHORT[inheritedLevel]}` : null,
    inheritedLevel,
    result: distinct(result),
    noEffect: !!own && business.every((b) => rank(b) <= rank(own)),
  }
}

// ── The draft: what the person typed, as the API takes it ─────────────────────────────────────────

export type Window = '' | '30' | '60' | '90'

/** Every field of one row as text (empty = not set here, so the scope inherits it). Money in the market's own units. */
export interface Draft {
  goal: string
  goalNote: string
  targetKind: 'ACOS' | 'TACOS'
  targetPct: string
  monthlySpendCap: string
  minBid: string
  maxBid: string
  maxChangePct: string
  maxActionsPerRun: string
  protect: '' | 'yes' | 'no'
  harvestMinOrders: string
  harvestMinClicks: string
  harvestMaxAcosPct: string
  harvestWindowDays: Window
  negateMinClicks: string
  negateMinSpend: string
  negateMaxOrders: string
  negateWindowDays: Window
  stopBid: string
  claude: Partial<Record<ClaudeActionKey, ClaudeLevel>>
  reviewEveryDays: string
}

const text = (value: unknown) => (num(value) == null ? '' : String(value))
const moneyText = (cents: unknown) => (num(cents) == null ? '' : ((cents as number) / 100).toFixed(2))
const windowText = (days: unknown): Window => (days === 30 || days === 60 || days === 90 ? (String(days) as Window) : '')

/** The draft of a stored row (null: the scope has no row yet — everything inherited). */
export function draftOf(row: StrategyRowOut | null): Draft {
  return {
    goal: row?.goal ?? '',
    goalNote: row?.goalNote ?? '',
    targetKind: row?.targetKind === 'TACOS' ? 'TACOS' : 'ACOS',
    targetPct: text(row?.targetPct),
    monthlySpendCap: moneyText(row?.monthlySpendCapCents),
    minBid: moneyText(row?.minBidCents),
    maxBid: moneyText(row?.maxBidCents),
    maxChangePct: text(row?.maxChangePct),
    maxActionsPerRun: text(row?.maxActionsPerRun),
    protect: row?.protect === true ? 'yes' : row?.protect === false ? 'no' : '',
    harvestMinOrders: text(row?.harvestMinOrders),
    harvestMinClicks: text(row?.harvestMinClicks),
    harvestMaxAcosPct: text(row?.harvestMaxAcosPct),
    harvestWindowDays: windowText(row?.harvestWindowDays),
    negateMinClicks: text(row?.negateMinClicks),
    negateMinSpend: moneyText(row?.negateMinSpendCents),
    negateMaxOrders: text(row?.negateMaxOrders),
    negateWindowDays: windowText(row?.negateWindowDays),
    stopBid: moneyText(row?.stopBidCents),
    claude: { ...(row?.claudeAutonomy ?? {}) },
    reviewEveryDays: text(row?.reviewEveryDays),
  }
}

/** Money typed in the market's units ("1.50", "1,50", "1500") as cents; null when empty; NaN when it is not a sum. */
export function moneyCents(typed: string): number | null {
  const t = typed.trim().replace(/\s/g, '')
  if (!t) return null
  const normal = !t.includes('.') ? t.replace(',', '.') : t
  if (!/^\d+(\.\d{1,2})?$/.test(normal)) return Number.NaN
  return Math.round(Number(normal) * 100)
}

/** A whole number typed (null when empty; NaN when it is not one). */
function whole(typed: string): number | null {
  const t = typed.trim()
  if (!t) return null
  return /^\d+$/.test(t) ? Number(t) : Number.NaN
}

type Parsed = { value: unknown; error: string | null }
const ok = (value: unknown): Parsed => ({ value, error: null })
const bad = (error: string): Parsed => ({ value: undefined, error })

function wholeIn(typed: string, min: number, max: number, words: string): Parsed {
  const n = whole(typed)
  if (n == null) return ok(null)
  return Number.isNaN(n) || n < min || n > max ? bad(words) : ok(n)
}

function moneyIn(typed: string, currency: string | null, range?: { min: number; max: number }): Parsed {
  const cents = moneyCents(typed)
  if (cents == null) return ok(null)
  if (Number.isNaN(cents)) return bad(`A sum in ${currency ?? 'the market’s currency'} with at most 2 decimals, like 1.50.`)
  if (range && (cents < range.min || cents > range.max)) return bad(`From ${money(range.min, currency)} to ${money(range.max, currency)}.`)
  return ok(cents)
}

/** One field of a draft as the API's `values` takes it (null = clear it here), or the reason it cannot be sent. */
export function parseField(field: FieldKey, d: Draft, currency: string | null): Parsed {
  switch (field) {
    case 'goal':
      return ok(d.goal || null)
    case 'goalNote':
      return d.goalNote.length > 2000 ? bad('At most 2,000 characters.') : ok(d.goalNote.trim() || null)
    case 'target': {
      const pct = wholeIn(d.targetPct, 1, 500, 'A whole percent from 1 to 500.')
      return pct.error || pct.value == null ? pct : ok({ kind: d.targetKind, pct: pct.value })
    }
    case 'monthlySpendCapCents':
      // 0 goes to the API, which refuses it in its own words ("0 would mean 'no cap'…"): the screen shows that sentence.
      return moneyIn(d.monthlySpendCap, currency)
    case 'minBidCents':
      return moneyIn(d.minBid, currency)
    case 'maxBidCents':
      return moneyIn(d.maxBid, currency)
    case 'maxChangePct':
      return wholeIn(d.maxChangePct, 1, 100, 'A whole percent from 1 to 100.')
    case 'maxActionsPerRun':
      return wholeIn(d.maxActionsPerRun, 0, 1_000_000, 'A whole number of changes, 0 or more.')
    case 'reviewEveryDays':
      return wholeIn(d.reviewEveryDays, 1, 90, 'A whole number of days from 1 to 90.')
    case 'protect':
      return ok(d.protect === 'yes' ? true : d.protect === 'no' ? false : null)
    case 'harvest': {
      const typed = [d.harvestMinOrders, d.harvestMinClicks, d.harvestMaxAcosPct].some((t) => t.trim()) || !!d.harvestWindowDays
      if (!typed) return ok(null)
      if (!d.harvestMinOrders.trim() || !d.harvestMinClicks.trim() || !d.harvestWindowDays) return bad('Give the orders, the clicks and the days looked at — or leave them all empty.')
      const orders = wholeIn(d.harvestMinOrders, 1, 100, 'Orders: a whole number from 1 to 100.')
      const clicks = wholeIn(d.harvestMinClicks, 0, 10_000, 'Clicks: a whole number from 0 to 10,000.')
      const acos = wholeIn(d.harvestMaxAcosPct, 1, 1000, 'ACoS: a whole percent from 1 to 1,000, or empty for any.')
      const error = orders.error ?? clicks.error ?? acos.error
      return error ? bad(error) : ok({ minOrders: orders.value, minClicks: clicks.value, maxAcosPct: acos.value ?? null, windowDays: Number(d.harvestWindowDays) })
    }
    case 'negate': {
      const typed = [d.negateMinClicks, d.negateMinSpend, d.negateMaxOrders].some((t) => t.trim()) || !!d.negateWindowDays
      if (!typed) return ok(null)
      if (!d.negateMinClicks.trim() || !d.negateMinSpend.trim() || !d.negateMaxOrders.trim() || !d.negateWindowDays) {
        return bad('Give the clicks, the spend, the orders and the days looked at — or leave them all empty.')
      }
      const clicks = wholeIn(d.negateMinClicks, 0, 10_000, 'Clicks: a whole number from 0 to 10,000.')
      const spend = moneyIn(d.negateMinSpend, currency)
      const orders = wholeIn(d.negateMaxOrders, 0, 100, 'Orders: a whole number from 0 to 100.')
      const error = clicks.error ?? spend.error ?? orders.error
      return error ? bad(error) : ok({ minClicks: clicks.value, minSpendCents: spend.value, maxOrders: orders.value, windowDays: Number(d.negateWindowDays) })
    }
    case 'stop': {
      const bid = moneyIn(d.stopBid, currency, { min: 2, max: 100 })
      return bid.error || bid.value == null ? bid : ok({ method: 'LOW_BIDS', bidCents: bid.value })
    }
    case 'claudeAutonomy': {
      const set = Object.fromEntries(Object.entries(d.claude).filter(([, level]) => !!level))
      return ok(Object.keys(set).length ? set : null)
    }
  }
}

export const EDITABLE: readonly FieldKey[] = [
  'goal', 'goalNote', 'target', 'monthlySpendCapCents', 'minBidCents', 'maxBidCents', 'maxChangePct', 'maxActionsPerRun',
  'protect', 'harvest', 'negate', 'stop', 'claudeAutonomy', 'reviewEveryDays',
]

/** One text per value whatever the order of its keys. */
function canonical(value: unknown): string {
  const sorted = (v: unknown): unknown => (rec(v) ? Object.fromEntries(Object.keys(v as Rec).sort().map((k) => [k, sorted((v as Rec)[k])])) : v)
  return JSON.stringify(sorted(value ?? null))
}

export interface DraftDiff {
  /** The fields that changed, as the API's `values` takes them. */
  values: Record<string, unknown>
  changed: FieldKey[]
  errors: Partial<Record<FieldKey, string>>
}

/** What the person changed against the stored row, field by field (only the fields this scope may hold). */
export function diffDraft(draft: Draft, base: Draft, level: Level, currency: string | null): DraftDiff {
  const out: DraftDiff = { values: {}, changed: [], errors: {} }
  for (const field of EDITABLE) {
    if (!fieldAllowed(field, level)) continue
    const now = parseField(field, draft, currency)
    const was = parseField(field, base, currency)
    if (now.error) {
      out.errors[field] = now.error
      continue
    }
    if (canonical(now.value) === canonical(was.error ? undefined : was.value)) continue
    out.values[field] = now.value
    out.changed.push(field)
  }
  const min = parseField('minBidCents', draft, currency).value
  const max = parseField('maxBidCents', draft, currency).value
  if (typeof min === 'number' && typeof max === 'number' && min > max) out.errors.minBidCents = 'The lowest bid is above the highest bid: give one at or below it.'
  return out
}

/**
 * The API's refusal, placed on its field when it names one ("monthlySpendCapCents: 0 would mean 'no cap'…" → the cap,
 * "0 would mean 'no cap'…"); otherwise the whole sentence for a banner.
 */
export function serverError(error: string): { field: FieldKey | null; text: string } {
  const m = /^(?:values\.)?([A-Za-z]+)(?:\.[A-Za-z]+)?:\s*(.+)$/.exec(error.trim())
  if (!m) return { field: null, text: error }
  const key = m[1]
  const field: FieldKey | null = (EDITABLE as readonly string[]).includes(key)
    ? (key as FieldKey)
    : key.startsWith('harvest') ? 'harvest' : key.startsWith('negate') ? 'negate' : key === 'stopBidCents' || key === 'stopMethod' ? 'stop' : key === 'targetPct' || key === 'targetKind' ? 'target' : null
  if (!field) return { field: null, text: error }
  const said = m[2].trim()
  return { field, text: said.charAt(0).toUpperCase() + said.slice(1) }
}

// ── The save: one summary, one table, a counted button ────────────────────────────────────────────

/** A change's label in this screen's words (a campaign's own target names the campaign). */
export function changeLabel(change: Pick<StrategyChange, 'field' | 'label' | 'campaign' | 'term'>): string {
  if (change.campaign) return `Own target ACoS of “${change.campaign}”`
  if (change.term) return `Protected search term “${change.term}”`
  return FIELD_LABEL[change.field as FieldKey] ?? change.label.replace(/\s\((cents|%|actions|days)\)$/, '')
}

/** One row of the change table: the setting, its value now and after, and whether it raises or lowers. */
export interface ChangeRow { id: string; setting: string; now: string; next: string; effect: string; tone: 'warning' | 'success' | 'neutral' }

const EFFECT: Record<Direction, { effect: string; tone: ChangeRow['tone'] }> = {
  raise: { effect: 'Raises', tone: 'warning' },
  lower: { effect: 'Lowers', tone: 'success' },
  same: { effect: 'Same in force', tone: 'neutral' },
}

function sideText(field: string, own: unknown, effective: unknown, currency: string | null, campaign: boolean): string {
  if (campaign) return own == null ? 'None: the strategy applies' : `${own} %`
  const key = field as FieldKey
  const shown = valueText(key, own, currency)
  if (shown) return shown
  const inherited = valueText(key, effective, currency)
  return inherited ? `Not set (inherits ${inherited})` : 'Not set'
}

export function changeRows(changes: readonly StrategyChange[], currency: string | null): ChangeRow[] {
  return changes.map((c, i) => ({
    id: `${c.field}:${c.campaignId ?? c.term ?? ''}:${i}`,
    setting: changeLabel(c),
    now: sideText(c.field, c.from, c.effectiveFrom, currency, !!c.campaignId),
    next: sideText(c.field, c.to, c.effectiveTo, currency, !!c.campaignId),
    ...EFFECT[c.direction],
  }))
}

/** A change as a noun inside a sentence. */
export function changeNoun(change: Pick<StrategyChange, 'field' | 'campaign' | 'term'>): string {
  if (change.campaign) return `the own target ACoS of “${change.campaign}”`
  if (change.term) return `the protected term “${change.term}”`
  return FIELD_NOUN[change.field as FieldKey] ?? change.field
}

/** What a change raises, as nouns, once each ("the highest bid", "the monthly spend cap"). */
export function raiseList(changes: readonly StrategyChange[]): string[] {
  return [...new Set(changes.filter((c) => c.direction === 'raise').map(changeNoun))]
}

/** "a and b", "a, b and c", "a, b, c and 2 more". */
export function listWords(items: readonly string[], max = 3): string {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length <= max) return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`
}

/** The primary button of the save: what it does, with its count; a raise says it asks for the code. */
export function saveButtonWords(o: { changes: number; raises: number; mayRaise: boolean; undo?: boolean }): { label: string; disabled: boolean; why: string | null } {
  const what = o.undo ? 'Undo' : `Save ${plural(o.changes, 'change')}`
  if (!o.raises) return { label: what, disabled: false, why: null }
  if (!o.mayRaise) return { label: what, disabled: true, why: 'Raising the strategy needs the settings.security.manage permission. Lower it instead, or ask the person who has it.' }
  return { label: `${what} with your code…`, disabled: false, why: null }
}

/** The sticky bar's sentence while there are unsaved edits. */
export function barWords(o: { changes: number; problems: number; checking: boolean; raises: readonly string[] | null; clears: number }): string {
  const head = `${plural(o.changes, 'unsaved change')}`
  const clears = o.clears ? ` · clears ${plural(o.clears, "campaign's own target", "campaigns' own targets")}` : ''
  if (o.problems) return `${head} · ${plural(o.problems, 'problem')} to fix first`
  if (o.checking || !o.raises) return `${head}${clears} · checking…`
  if (!o.raises.length) return `${head}${clears} · lowers or keeps every limit`
  return `${head}${clears} · raises ${listWords(o.raises)}: saving asks for your code`
}

/** The step-up dialog's sentence: what rises, and that lowering never asks. */
export function stepUpSentence(raises: readonly string[], where: string, undo = false): string {
  return `${undo ? 'Undo puts a higher value back for' : 'This raises'} ${listWords(raises, 4)} ${undo ? 'of' : 'for'} ${where}. Raising the strategy asks for the 6-digit code from your authenticator app; lowering it never does.`
}

/** What happens when the save lands, per changed field: binds at once (and who reads it), or stored only. */
export function effectLines(
  changes: readonly StrategyChange[],
  readBy: Record<string, readonly string[]>,
  market: string,
  affects?: { campaigns: number; products?: number },
): string[] {
  const lines: string[] = []
  if (affects) {
    lines.push(affects.products != null
      ? `It covers ${plural(affects.products, 'product')} and the ${plural(affects.campaigns, 'campaign')} in ${market} that advertise them.`
      : `It covers the whole ${market} market: ${plural(affects.campaigns, 'campaign')}.`)
  }
  const fields = [...new Set(changes.filter((c) => !c.campaignId && !c.term).map((c) => c.field))]
  const stored = fields.filter((f) => !(readBy[f]?.length))
  const read = fields.filter((f) => readBy[f]?.length)
  for (const f of read) lines.push(`${FIELD_LABEL[f as FieldKey] ?? f}: binds at once — ${readByWords(readBy[f]).text.replace(/^Read by/, 'read by')}.`)
  if (stored.length) lines.push(`${stored.map((f) => FIELD_LABEL[f as FieldKey] ?? f).join(', ')}: stored and shown only — no engine reads ${stored.length === 1 ? 'it' : 'them'} yet, so no bid or budget moves.`)
  const clears = changes.filter((c) => c.campaignId && c.to == null).length
  const restores = changes.filter((c) => c.campaignId && c.to != null).length
  if (clears) lines.push(`${plural(clears, 'campaign')} lose${clears === 1 ? 's its' : ' their'} own target ACoS: Nexus's bid optimiser then aims at the account default, profit data or 30 % for ${clears === 1 ? 'it' : 'them'}.`)
  if (restores) lines.push(`${plural(restores, 'campaign')} get${restores === 1 ? 's its' : ' their'} own target ACoS back.`)
  lines.push(`Nexus only: nothing is sent to Amazon ${market} by this change.`)
  return lines
}

/** A short summary of a row for the list of categories and products ("Goal Launch · Target ACoS 45 %"). */
export function rowSummary(row: StrategyRowOut, currency: string | null): string {
  const parts: string[] = []
  if (row.goal) parts.push(goalLabel(row.goal))
  if (row.targetPct != null) parts.push(valueText('target', { targetKind: row.targetKind, targetPct: row.targetPct }, currency)!)
  if (row.monthlySpendCapCents != null) parts.push(`cap ${money(row.monthlySpendCapCents, currency)}`)
  if (row.maxBidCents != null) parts.push(`bids up to ${money(row.maxBidCents, currency)}`)
  if (row.protect != null) parts.push(row.protect ? 'protected' : 'not protected')
  const rest = [row.minBidCents, row.maxChangePct, row.harvestMinOrders, row.negateMinClicks, row.stopMethod, row.claudeAutonomy, row.reviewEveryDays].filter((v) => v != null).length
  const shown = parts.slice(0, 3)
  const more = parts.length - shown.length + rest
  return [...shown, more ? `${plural(more, 'more setting')}` : null].filter(Boolean).join(' · ') || 'Nothing set yet'
}

/** One version in the history, in words: when, who, how, and what changed from → to. */
export function historyLine(v: HistoryVersion, currency: string | null): { head: string; changes: string[] } {
  const when = v.at ? new Date(v.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'time not recorded'
  const how = [v.via === 'claude' ? 'approved Claude request' : v.via === 'screen' ? 'on this screen' : v.via, v.stepUpAt ? 'with code' : null].filter(Boolean).join(', ')
  const head = `Version ${v.version} · ${when} · ${v.actor} (${how})${v.op === 'remove' ? ' · removed' : ''}`
  const changes = v.changes.map((c) => {
    const field = (c.field ?? '') as string
    const side = rec(c[field]) ?? rec(c.value)
    const label = changeLabel({ field, label: field, campaign: typeof c.campaign === 'string' ? c.campaign : undefined, term: typeof c.term === 'string' ? c.term : undefined })
    const direction = c.direction === 'raise' ? ' (raise)' : c.direction === 'lower' ? ' (lower)' : ''
    // A money field's numbers are left out for a person who may not see ad spend: say that it changed, never "Not set".
    if (!side) return `${label}: changed, amounts hidden${direction}`
    const campaign = typeof c.campaignId === 'string'
    const from = sideText(field, side.from, side.effectiveFrom, currency, campaign)
    const to = sideText(field, side.to, side.effectiveTo, currency, campaign)
    return `${label}: ${from} → ${to}${direction}`
  })
  return { head, changes }
}

/** The scope in a sentence: "the IT market strategy", "the strategy for Full face (category)". */
export function scopeWhat(scope: Scope, market: string): string {
  if (scope.level === 'MARKET') return `the ${market} market strategy`
  return `the strategy for ${scope.label} (${scope.level === 'CATEGORY' ? 'category' : 'product'}, ${market})`
}

/** Before leaving unsaved edits (another market, another scope, adding one): drop them only on a yes. */
export function leaveImpact(changes: number, what: string): ActionImpact {
  return {
    level: 'confirm',
    title: `Drop ${plural(changes, 'unsaved change')}?`,
    consequences: [`Your ${changes === 1 ? 'change' : 'changes'} to ${what} ${changes === 1 ? 'is' : 'are'} not saved and will be dropped. Nothing was sent anywhere.`],
  }
}

// ── Adding a category or a product ────────────────────────────────────────────────────────────────

/** A category's name: English, then Italian, then any language, then its slug (as the API's strategy labels read it). */
export function categoryName(name: unknown, slug: string): string {
  if (typeof name === 'string' && name.trim()) return name.trim()
  const byLanguage = rec(name)
  if (byLanguage) {
    for (const language of ['en', 'it', ...Object.keys(byLanguage)]) {
      const value = byLanguage[language]
      if (typeof value === 'string' && value.trim()) return value.trim()
      const inner = rec(value)
      for (const key of ['label', 'name', 'value', 'text']) if (typeof inner?.[key] === 'string' && (inner[key] as string).trim()) return (inner[key] as string).trim()
    }
  }
  return slug
}

/** Every category as a choice, named by its path ("Helmets › Full face"); one that already has a row here is shown, held. */
export function categoryChoices(tree: readonly CategoryNode[], taken: ReadonlySet<string>): Array<{ value: string; label: string; disabled?: boolean; trailing?: string }> {
  const out: Array<{ value: string; label: string; disabled?: boolean; trailing?: string }> = []
  const walk = (nodes: readonly CategoryNode[], path: string[]) => {
    for (const node of nodes) {
      const here = [...path, categoryName(node.name, node.slug)]
      const held = taken.has(node.id)
      out.push({ value: node.id, label: here.join(' › '), ...(held ? { disabled: true, trailing: 'has a strategy here' } : !node.isActive ? { trailing: 'inactive' } : {}) })
      walk(node.children ?? [], here)
    }
  }
  walk(tree, [])
  return out
}
