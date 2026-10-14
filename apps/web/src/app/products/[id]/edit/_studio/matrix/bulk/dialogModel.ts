/**
 * The Matrix bulk Edit dialog's own logic, as pure functions (`BulkEditDialog.tsx` is the screen; `types.ts` the contract).
 *
 * Everything here reads what the operator typed or what the runner answered and says it back in plain words: how an
 * entry is read (or why it cannot be), what the Apply button says and why it is held, the ONE next step, the markets
 * that cannot be ticked, the skipped lines by reason, what the dialog opens on, the key that ties a preview to what is
 * on screen, and the keys of the table's rows. Nothing here computes a number the dialog shows as a result: every
 * `Now → New` is the runner's.
 */
import { BUSINESS_PERCENT_MAX, BUSINESS_TIER_MIN_QTY, businessTiersProblems, type BusinessTierType } from '@nexus/shared/business-price'

import type { CoordinateKey } from '../contract'
import { nextTier, tierDraft, type TierDraft } from '../businessPricing'
import type {
  BulkAdjustUnit, BulkChoiceOption, BulkEditSource, BulkFieldId, BulkFieldSpec, BulkGroup, BulkInitial, BulkInput, BulkInputKind,
  BulkLine, BulkMarketOption, BulkModeId, BulkModeSpec, BulkNotice, BulkPreview, BulkRequest,
} from './types'

/** The preview is asked again this long after the last change. */
export const PREVIEW_DELAY_MS = 250
/** Up to this many choices show as segments; more open a list. */
export const SEGMENT_CHOICES_MAX = 5
/** From this many markets to tick, `All` and `None` show beside them. */
export const ALL_NONE_MIN = 4
/** A new sale runs this many days from today (the dates the dialog fills in). */
export const SALE_DEFAULT_DAYS = 7

/** What is on screen, as typed: the dialog parses it and never sends a string it could not read. */
export interface BulkRaw {
  /** The price, the amount to raise or lower by, the number, or the sale price. */
  text: string
  /** Raise · Lower: what `text` is — a percentage or an amount in the markets' currency. */
  unit: BulkAdjustUnit
  choice: string
  /** The sale's dates, ISO `YYYY-MM-DD` (the date fields give ISO whatever they show). */
  start: string
  end: string
  /** Sells from: the warehouses ticked, in sale order. */
  codes: readonly string[]
  /** B2B tiers: what each quantity discount is — a percent off the B2B price, or a price per unit. */
  tierType: BusinessTierType
  /** B2B tiers: the quantity discounts as typed, in order (`key` keeps a row while rows are added and removed). */
  tiers: readonly TierDraft[]
}
export const EMPTY_RAW: BulkRaw = Object.freeze({
  text: '', unit: 'percent', choice: '', start: '', end: '', codes: Object.freeze([]) as readonly string[],
  tierType: 'percent', tiers: Object.freeze([]) as readonly TierDraft[],
})

// ── Dates ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The day as the operator's own calendar says it, `YYYY-MM-DD` (local time: a sale "from today" starts on the day they see). */
export function localIsoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** `YYYY-MM-DD` plus `days` calendar days (month and year ends included). */
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** A new sale's dates: from today, for a week. */
export const saleDefaultDates = (today: string): { start: string; end: string } => ({ start: today, end: addDays(today, SALE_DEFAULT_DAYS) })

/** A real calendar day written `YYYY-MM-DD` (`2026-02-30` is not one). */
export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

// ── Reading an entry ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `empty`    nothing entered yet: Apply waits, no error under the field
 * `partial`  a number still being typed (`99,`): Apply waits, no error yet
 * `invalid`  it cannot be read: the reason shows under the field
 */
export type ParseState = 'ok' | 'empty' | 'partial' | 'invalid'

export interface ParseResult {
  input: BulkInput | null
  state: ParseState
  /** Why it cannot be read, in plain words; null when it can. */
  reason: string | null
  /** Which control the reason belongs to (a sale has three). */
  at: 'value' | 'start' | 'end' | null
}

const ok = (input: BulkInput): ParseResult => ({ input, state: 'ok', reason: null, at: null })
const fail = (state: Exclude<ParseState, 'ok'>, reason: string, at: ParseResult['at'] = 'value'): ParseResult => ({ input: null, state, reason, at })

/** Every channel refuses a price of 0, and a change of 0 changes nothing. */
export const MORE_THAN_ZERO = 'Enter more than 0.'
export const NO_SIGN = 'Enter the number without a sign.'
export const DOWN_BY_100 = 'It cannot go down by 100 % or more.'

/** A typed sign: ASCII, the minus sign, an en dash, or a plus. */
const SIGN = /^[-−–+]/
const compact = (s: string) => s.trim().replace(/\s+/g, '')
const round2 = (n: number) => Math.round(n * 100) / 100

function readMoney(raw: string, empty: string): ParseResult {
  const t = compact(raw)
  if (t === '') return fail('empty', empty)
  if (SIGN.test(t)) return fail('invalid', MORE_THAN_ZERO)
  if (/^\d+[.,]$/.test(t)) return fail('partial', 'Finish the number.')
  if (/^\d+[.,]\d{3,}$/.test(t)) return fail('invalid', 'Use at most 2 decimals, like 99.75.')
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(t)) return fail('invalid', 'Enter a number, like 99.75.')
  const amount = round2(Number(t.replace(',', '.')))
  if (amount <= 0) return fail('invalid', MORE_THAN_ZERO)
  return ok({ amount })
}

/** Raise · Lower: an unsigned number in its unit; the mode is the sign (Lower 5 % → `percent: -5`, Raise €2 → `delta: 2`). */
function readAdjust(raw: BulkRaw, sign: 1 | -1): ParseResult {
  const percent = raw.unit === 'percent'
  const t = percent ? compact(raw.text).replace(/%$/, '') : compact(raw.text)
  if (t === '') return fail('empty', percent ? 'Enter a percentage.' : 'Enter an amount.')
  if (SIGN.test(t)) return fail('invalid', NO_SIGN)
  if (/^\d+[.,]$/.test(t)) return fail('partial', 'Finish the number.')
  if (/^\d+[.,]\d{3,}$/.test(t)) return fail('invalid', percent ? 'Use at most 2 decimals, like 2.5.' : 'Use at most 2 decimals, like 2.50.')
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(t)) return fail('invalid', percent ? 'Enter a number, like 5.' : 'Enter a number, like 2.50.')
  const n = round2(Number(t.replace(',', '.')))
  if (n === 0) return fail('invalid', MORE_THAN_ZERO)
  if (percent && sign < 0 && n >= 100) return fail('invalid', DOWN_BY_100)
  return ok(percent ? { percent: sign * n } : { delta: sign * n })
}

function readInteger(raw: string): ParseResult {
  const t = compact(raw)
  if (t === '') return fail('empty', 'Enter a number.')
  if (SIGN.test(t)) return fail('invalid', 'Enter 0 or more.')
  if (/^\d+[.,]\d*$/.test(t)) return fail('invalid', 'Enter a whole number.')
  if (!/^\d+$/.test(t)) return fail('invalid', 'Enter a whole number, like 5.')
  const n = Number(t)
  if (!Number.isSafeInteger(n)) return fail('invalid', 'That number is too large.')
  return ok({ amount: n })
}

function readSale(raw: BulkRaw): ParseResult {
  const value = readMoney(raw.text, 'Enter a sale price.')
  if (!value.input) return value
  if (raw.start === '') return fail('empty', 'Choose a start date.', 'start')
  if (!isIsoDate(raw.start)) return fail('invalid', 'Choose a real start date.', 'start')
  if (raw.end === '') return fail('empty', 'Choose an end date.', 'end')
  if (!isIsoDate(raw.end)) return fail('invalid', 'Choose a real end date.', 'end')
  // ISO dates compare as text.
  if (raw.start > raw.end) return fail('invalid', 'The sale ends before it starts.', 'end')
  return ok({ sale: { value: value.input.amount!, start: raw.start, end: raw.end } })
}

/** B2B price: how far below the price — a percentage from 0 to 99, up to 2 decimals, no sign (the mode says "below"). */
function readPercent(raw: string): ParseResult {
  const t = compact(raw).replace(/%$/, '')
  if (t === '') return fail('empty', 'Enter a percentage.')
  if (SIGN.test(t)) return fail('invalid', NO_SIGN)
  if (/^\d+[.,]$/.test(t)) return fail('partial', 'Finish the number.')
  if (/^\d+[.,]\d{3,}$/.test(t)) return fail('invalid', 'Use at most 2 decimals, like 2.5.')
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(t)) return fail('invalid', 'Enter a number, like 5.')
  const n = round2(Number(t.replace(',', '.')))
  if (n > BUSINESS_PERCENT_MAX) return fail('invalid', `Enter a percentage from 0 to ${BUSINESS_PERCENT_MAX}.`)
  return ok({ percent: n })
}

/** One quantity discount's entry: a whole number of units, or a percent / a price with up to 2 decimals. */
type TierEntry = { n: number } | { state: 'empty' | 'partial' } | { invalid: string }
function tierEntry(text: string, kind: 'qty' | BusinessTierType): TierEntry {
  const t = kind === 'percent' ? compact(text).replace(/%$/, '') : compact(text)
  if (t === '') return { state: 'empty' }
  if (kind === 'qty') return /^\d+$/.test(t) ? { n: Number(t) } : { invalid: `Write a whole number of units, ${BUSINESS_TIER_MIN_QTY} or more.` }
  if (/^\d+[.,]$/.test(t)) return { state: 'partial' }
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(t)) return { invalid: kind === 'percent' ? 'Write a percent, for example 3.' : 'Write a price, for example 30.' }
  return { n: Number(t.replace(',', '.')) }
}

/** The tiers' entries that cannot be read, by `<tier key>:minQty` · `<tier key>:value` (the input marks them). */
export function tierFieldProblems(raw: Pick<BulkRaw, 'tierType' | 'tiers'>): Map<string, string> {
  const out = new Map<string, string>()
  for (const t of raw.tiers) {
    const qty = tierEntry(t.minQty, 'qty'), value = tierEntry(t.value, raw.tierType)
    if ('invalid' in qty) out.set(`${t.key}:minQty`, qty.invalid)
    if ('invalid' in value) out.set(`${t.key}:value`, value.invalid)
  }
  return out
}

export const TIERS_EMPTY = 'Add a quantity discount.'
export const TIERS_UNFILLED = 'Fill in every quantity discount.'

/**
 * B2B tiers: every row read, then the shape Amazon takes (`businessTiersProblems`: 1 to 5, from 2 units, each quantity
 * higher and each discount bigger than the one before). Nothing typed yet, or a row half filled, waits without an error.
 */
function readTiers(raw: BulkRaw): ParseResult {
  if (raw.tiers.length === 0) return fail('empty', TIERS_EMPTY)
  const levels: Array<{ minQty: number; value: number }> = []
  let waiting: 'empty' | 'partial' | null = null
  for (const [i, t] of raw.tiers.entries()) {
    const qty = tierEntry(t.minQty, 'qty'), value = tierEntry(t.value, raw.tierType)
    for (const e of [qty, value]) if ('invalid' in e) return fail('invalid', `Discount ${i + 1}: ${e.invalid.charAt(0).toLowerCase()}${e.invalid.slice(1)}`)
    for (const e of [qty, value]) if ('state' in e) waiting = waiting === 'partial' ? 'partial' : e.state
    if ('n' in qty && 'n' in value) levels.push({ minQty: qty.n, value: value.n })
  }
  if (waiting === 'partial') return fail('partial', 'Finish the number.')
  if (waiting === 'empty') return fail('empty', TIERS_UNFILLED)
  const tiers = { type: raw.tierType, levels }
  const problem = businessTiersProblems(tiers)[0]
  return problem ? fail('invalid', problem) : ok({ tiers })
}

/** The first quantity discount a new B2B tiers entry offers (Claude's earlier pick: from 2 units, 3 % off). */
export const firstTier = (): TierDraft => nextTier({ tierType: 'percent', tiers: [] }, null)

/** The sign a mode gives an `adjust` entry: Lower takes it down, everything else up. */
export const adjustSign = (mode: BulkModeId | null | undefined): 1 | -1 => (mode === 'lower' ? -1 : 1)

export interface ParseOptions {
  /** A `choice` mode's choices: a choice no longer offered (the markets changed) is not read. */
  choices?: readonly BulkChoiceOption[]
  /** The mode: Lower is the minus sign of an `adjust` entry. */
  mode?: BulkModeId | null
}

/**
 * Reads what the operator entered for a mode:
 *   money      more than 0, up to 2 decimals: `105` · `99,75` · `99.75`
 *   adjust     unsigned, more than 0, up to 2 decimals, in `raw.unit`; Lower by 100 % or more is refused
 *   integer    a whole number, 0 or more (as `amount`)
 *   choice     one of `choices` (when given)
 *   sale       a sale price as money, and a start and an end date with start ≤ end
 *   locations  at least one warehouse ticked (as `codes`, in sale order)
 *   percent    0 to 99, up to 2 decimals, no sign (as `percent`)
 *   tiers      1 to 5 quantity discounts of the shape Amazon takes (as `tiers`)
 *   none · handoff  always read (nothing to enter)
 */
export function parseInput(kind: BulkInputKind, raw: BulkRaw, opts: ParseOptions = {}): ParseResult {
  switch (kind) {
    case 'none': case 'handoff': return ok({})
    case 'money': return readMoney(raw.text, 'Enter a price.')
    case 'adjust': return readAdjust(raw, adjustSign(opts.mode))
    case 'integer': return readInteger(raw.text)
    case 'choice': {
      const c = raw.choice
      if (c === '' || (opts.choices && !opts.choices.some((o) => o.value === c))) return fail('empty', 'Choose one.')
      return ok({ choice: c })
    }
    case 'sale': return readSale(raw)
    case 'locations': return raw.codes.length === 0 ? fail('empty', 'Tick at least one warehouse.') : ok({ codes: [...raw.codes] })
    case 'percent': return readPercent(raw.text)
    case 'tiers': return readTiers(raw)
  }
}

type ModeShape = Pick<BulkModeSpec, 'input' | 'units'>

/**
 * What a mode starts with: nothing typed, its first unit, and — for a sale — today and a week from today; for quantity
 * discounts, one suggested row (from 2 units, 3 % off) to change or add to.
 */
export function modeRaw(mode: ModeShape | null | undefined, today: string): BulkRaw {
  if (!mode) return EMPTY_RAW
  return {
    ...EMPTY_RAW, unit: mode.units?.[0] ?? EMPTY_RAW.unit, ...(mode.input === 'sale' ? saleDefaultDates(today) : {}),
    ...(mode.input === 'tiers' ? { tiers: [firstTier()] } : {}),
  }
}

/** An opening value (`initial.input`) back on screen, in the mode's own controls. */
export function rawFromInput(mode: ModeShape, input: BulkInput | undefined, today: string): BulkRaw {
  const base = modeRaw(mode, today)
  if (!input) return base
  switch (mode.input) {
    case 'money': case 'integer': return { ...base, text: input.amount != null ? String(input.amount) : '' }
    case 'adjust':
      if (input.delta != null) return { ...base, text: String(Math.abs(input.delta)), unit: 'money' }
      if (input.percent != null) return { ...base, text: String(Math.abs(input.percent)), unit: 'percent' }
      return base
    case 'choice': return { ...base, choice: input.choice ?? '' }
    case 'sale': return input.sale ? { ...base, text: String(input.sale.value), start: input.sale.start, end: input.sale.end } : base
    case 'locations': return { ...base, codes: [...(input.codes ?? [])] }
    case 'percent': return { ...base, text: input.percent != null ? String(input.percent) : '' }
    case 'tiers': return input.tiers
      ? { ...base, tierType: input.tiers.type, tiers: input.tiers.levels.map((l) => tierDraft(String(l.minQty), String(l.value))) }
      : base
    case 'none': case 'handoff': return base
  }
}

const SYMBOLS: Readonly<Record<string, string>> = { EUR: '€', GBP: '£', USD: '$' }
/** `€` for EUR, `£` GBP, `$` USD; any other currency by its code. */
export const currencySymbol = (code: string): string => SYMBOLS[code.trim().toUpperCase()] ?? code

/** An input's label when its mode names none. */
export const DEFAULT_INPUT_LABEL: Readonly<Record<BulkInputKind, string>> = {
  none: '', money: 'New price', adjust: 'By', integer: 'Number', choice: 'Choose', sale: 'Sale price', locations: 'Warehouses',
  percent: 'Percent', tiers: 'Quantity discounts', handoff: 'Open',
}

// ── The field list ────────────────────────────────────────────────────────────────────────────────────────────────

/** The fields under their headings (Prices · Listing · Stock), headings and fields in the order the runner gives them. */
export function fieldGroups<F extends Pick<BulkFieldSpec, 'group'>>(fields: readonly F[]): Array<{ group: BulkGroup; fields: F[] }> {
  const out: Array<{ group: BulkGroup; fields: F[] }> = []
  for (const f of fields) {
    const g = out.find((x) => x.group === f.group)
    if (g) g.fields.push(f)
    else out.push({ group: f.group, fields: [f] })
  }
  return out
}

/** The phone's field list (a `Listbox`): grouped, the description as the note, a held field with its reason. */
export function fieldListOptions(fields: readonly BulkFieldSpec[]): Array<{ value: string; label: string; group: string; note: string; heldReason?: string }> {
  return fields.map((f) => ({ value: f.id, label: f.label, group: f.group, note: f.held ?? f.description, ...(f.held !== null ? { heldReason: f.held } : {}) }))
}

// ── What the dialog opens on ──────────────────────────────────────────────────────────────────────────────────────

export interface BulkFormState {
  field: BulkFieldId | null
  mode: BulkModeId | null
  /** The ticked markets (empty for a product-level field). */
  markets: CoordinateKey[]
  raw: BulkRaw
}
const NO_FORM: BulkFormState = { field: null, mode: null, markets: [], raw: EMPTY_RAW }

type SourceShape = Pick<BulkEditSource, 'fields' | 'marketsFor' | 'defaultMarkets'> & Partial<Pick<BulkEditSource, 'defaultMode'>>

/** The markets of a field that can be ticked: offered, and not held. */
export function tickableMarkets(source: SourceShape, field: BulkFieldSpec): CoordinateKey[] {
  if (!field.perMarket) return []
  return source.marketsFor(field.id).filter((m) => m.held === null).map((m) => m.key)
}

/** `wanted` that can be ticked, in the order the dialog lists them; else the field's default markets that can. */
function marketsFor(source: SourceShape, field: BulkFieldSpec, wanted?: readonly CoordinateKey[]): CoordinateKey[] {
  if (!field.perMarket) return []
  const tickable = tickableMarkets(source, field)
  const pick = (keys: readonly CoordinateKey[]) => tickable.filter((k) => keys.includes(k))
  const named = wanted ? pick(wanted) : []
  return named.length > 0 ? named : pick(source.defaultMarkets(field.id))
}

/** The mode a field opens on: the runner's choice for these rows and markets (`defaultMode`), else the field's first. */
export function defaultModeFor(source: SourceShape, field: BulkFieldSpec, markets: readonly CoordinateKey[]): BulkModeSpec | undefined {
  const wanted = source.defaultMode?.(field.id, markets) ?? null
  return field.modes.find((m) => m.id === wanted) ?? field.modes[0]
}

/** A field as it starts when chosen: its default markets, its default mode for them, nothing typed (a sale's dates filled). */
export function fieldDefaults(source: SourceShape, fieldId: BulkFieldId, today: string): BulkFormState {
  const field = source.fields.find((f) => f.id === fieldId)
  if (!field) return NO_FORM
  const markets = marketsFor(source, field)
  const mode = defaultModeFor(source, field, markets)
  return { field: field.id, mode: mode?.id ?? null, markets, raw: modeRaw(mode, today) }
}

/**
 * What the dialog opens on: the initial field when it is offered (with its mode and value when they belong to it),
 * else the first field that is not held (else the first field, which then says why it is held); the initial markets
 * that can be ticked, else the field's default markets; the initial mode, else the field's default mode for those markets.
 */
export function resolveInitial(source: SourceShape | null, initial: BulkInitial | undefined, today: string): BulkFormState {
  if (!source || source.fields.length === 0) return NO_FORM
  const asked = initial?.field ? source.fields.find((f) => f.id === initial.field && f.held === null) : undefined
  const field = asked ?? source.fields.find((f) => f.held === null) ?? source.fields[0]!
  const markets = marketsFor(source, field, initial?.coordinateKeys)
  const askedMode = asked && initial?.mode ? field.modes.find((m) => m.id === initial.mode) : undefined
  const mode = askedMode ?? defaultModeFor(source, field, markets)
  // The opening value belongs to the field asked for, and to its mode when one was named.
  const carry = !!asked && !!mode && (!!askedMode || !initial?.mode)
  return { field: field.id, mode: mode?.id ?? null, markets, raw: carry && mode ? rawFromInput(mode, initial?.input, today) : modeRaw(mode, today) }
}

// ── Markets ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Copy from: the market the prices come from is the source, not a target. */
export const COPY_SOURCE_HELD = 'Prices are copied from here'

/** The market a Copy from takes its prices from; null for any other mode or while none is chosen. */
export const copySource = (mode: BulkModeId | null | undefined, raw: Pick<BulkRaw, 'choice'>): CoordinateKey | null =>
  (mode === 'copy' && raw.choice !== '' ? raw.choice : null)

/** The markets as the dialog shows them: the runner's, with the Copy from source held (it cannot also be a target). */
export function marketsShown(options: readonly BulkMarketOption[], source: CoordinateKey | null): BulkMarketOption[] {
  return options.map((m) => (source !== null && m.key === source && m.held === null ? { ...m, held: COPY_SOURCE_HELD } : m))
}

/** The markets the request names: ticked AND tickable on screen, in the order shown (a held one is never sent). */
export function requestMarkets(ticked: readonly CoordinateKey[], shown: readonly BulkMarketOption[]): CoordinateKey[] {
  return shown.filter((m) => m.held === null && ticked.includes(m.key)).map((m) => m.key)
}

/**
 * The held markets as ONE line, grouped by reason, the largest group first:
 * `None of these rows is on it: eBay · IT, Etsy. Prices are copied from here: Amazon · DE.` Null when none is held.
 */
export function heldMarketsLine(shown: readonly BulkMarketOption[]): string | null {
  const groups = new Map<string, string[]>()
  for (const m of shown) {
    if (m.held === null) continue
    const reason = m.held.trim().replace(/[.:]$/, '')
    groups.set(reason, [...(groups.get(reason) ?? []), m.label])
  }
  if (groups.size === 0) return null
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([reason, labels]) => `${reason}: ${labels.join(', ')}.`).join(' ')
}

// ── The request, and the key that ties a preview to the screen ──────────────────────────────────────────────────────

/** The request on screen; null while the entry cannot be read, no market is ticked, the field is held, or it is a hand-off. */
export function buildRequest(field: BulkFieldSpec | null, mode: BulkModeSpec | null, parsed: ParseResult, markets: readonly CoordinateKey[]): BulkRequest | null {
  if (!field || !mode || field.held !== null || mode.input === 'handoff' || !parsed.input) return null
  if (field.perMarket && markets.length === 0) return null
  return { field: field.id, mode: mode.id, input: parsed.input, coordinateKeys: field.perMarket ? [...markets] : [] }
}

/**
 * One string per request, stable whatever order the markets were ticked in and whatever order the input's keys were
 * written in, and different for anything that changes the answer (a percentage and an amount are different requests).
 * A preview is applied only when the key of the request it answers equals the key on screen.
 */
export function requestKey(r: BulkRequest | null): string | null {
  if (!r) return null
  const i = r.input
  return JSON.stringify([
    r.field, r.mode, i.amount ?? null, i.percent ?? null, i.delta ?? null, i.choice ?? null,
    i.sale ? [i.sale.value, i.sale.start, i.sale.end] : null,
    // Sells from: the order is the sale order, so it is part of the request (never sorted).
    i.codes ?? null,
    // B2B tiers: the type and each level in order.
    i.tiers ? [i.tiers.type, ...i.tiers.levels.map((l) => [l.minQty, l.value])] : null,
    [...r.coordinateKeys].sort(),
  ])
}

// ── Words ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const num = (n: number) => n.toLocaleString('en')
const count = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`

/** `Apply 10 changes` · `Apply 10 changes, skip 2` · `Apply 1 change` · `Nothing to change` · `Apply` (no preview yet). */
export function applyLabel(preview: Pick<BulkPreview, 'changes' | 'skipped'> | null): string {
  if (!preview) return 'Apply'
  if (preview.changes === 0) return 'Nothing to change'
  const apply = `Apply ${count(preview.changes, 'change')}`
  return preview.skipped > 0 ? `${apply}, skip ${num(preview.skipped)}` : apply
}

/** `10 changes · 2 skipped` · `1 change` · `No changes · 3 skipped` · `Nothing would change`. */
export function countSentence(changes: number, skipped: number): string {
  if (changes === 0 && skipped === 0) return 'Nothing would change'
  const head = changes === 0 ? 'No changes' : count(changes, 'change')
  return skipped > 0 ? `${head} · ${num(skipped)} skipped` : head
}

export type BulkPhase = 'form' | 'applying' | 'done' | 'undoing'

/** The footer's one sentence: the counts of the preview on screen, else why Apply waits. */
export function footerStatus(s: { phase: BulkPhase; current: Pick<BulkPreview, 'changes' | 'skipped'> | null; held: string | null }): string {
  if (s.phase === 'applying') return 'Applying…'
  if (s.current) return countSentence(s.current.changes, s.current.skipped)
  return s.held ?? ''
}

type StepField = Pick<BulkFieldSpec, 'held' | 'perMarket'>
type StepMode = Pick<BulkModeSpec, 'id' | 'input' | 'inputLabel'>

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

/** What to enter or choose, as an order: `Enter the new price` · `Enter how much` · `Choose the method` · `Tick a warehouse`. */
function stepWords(mode: StepMode | null, parsed: ParseResult): string {
  const label = mode?.inputLabel ? lowerFirst(mode.inputLabel) : null
  switch (mode?.input) {
    case 'money': case 'integer': case 'percent': return label ? `Enter the ${label}` : 'Enter a value'
    case 'tiers': return parsed.reason === TIERS_EMPTY ? 'Add a quantity discount' : 'Fill in every quantity discount'
    case 'adjust': return 'Enter how much'
    case 'choice': return mode.id === 'copy' ? 'Choose a market to copy from' : label ? `Choose the ${label}` : 'Choose a value'
    case 'sale': return parsed.at === 'start' ? 'Choose the start date' : parsed.at === 'end' ? 'Choose the end date' : 'Enter the sale price'
    case 'locations': return 'Tick a warehouse'
    default: return 'Choose a value'
  }
}

/** The ONE next step: `short` for the footer (`Enter the new price`), `long` above the table (`… to see what changes.`). */
export interface NextStep { short: string; long: string }
const toSee = (short: string): NextStep => ({ short, long: `${short} to see what changes.` })

/**
 * What the operator does next before anything can be previewed, in the order they meet it: choose a field, (a held
 * field says why), enter the value (or correct it), tick a market. Null = nothing: the request is on screen (or the
 * field is a hand-off, whose button says what happens).
 */
export function nextStep(s: { field: StepField | null; mode: StepMode | null; parsed: ParseResult; ticked: number }): NextStep | null {
  if (!s.field) return { short: 'Choose what to change', long: 'Choose what to change.' }
  if (s.field.held) return { short: s.field.held, long: s.field.held }
  if (s.mode?.input === 'handoff') return null
  if (s.parsed.state === 'empty') return toSee(stepWords(s.mode, s.parsed))
  // A half-typed number shows no error yet, so the step names it. An unreadable entry has its reason under its own
  // control already: the step only points there.
  if (s.parsed.state === 'partial') return toSee((s.parsed.reason ?? 'Finish the number').replace(/\.$/, ''))
  if (s.parsed.state !== 'ok') return toSee('Correct the value')
  if (s.field.perMarket && s.ticked === 0) return toSee('Tick a market')
  return null
}

export interface HeldInputs {
  phase: BulkPhase
  /** No field chosen (`null` field) or the field's own `held`. */
  field: StepField | null
  mode?: StepMode | null
  parsed: ParseResult
  ticked: number
  /** The preview could not be worked out. */
  error: string | null
  /** The preview that answers what is on screen; null while it is being worked out. */
  current: Pick<BulkPreview, 'changes' | 'confirmWord'> | null
  /** The typed word matches `current.confirmWord` (the DS `phraseMatches` rule). */
  confirmed: boolean
}

/** Why Apply waits, in the order the operator meets the reasons; null = it can apply. */
export function applyHeldReason(s: HeldInputs): string | null {
  if (s.phase === 'applying') return 'Applying…'
  const next = nextStep({ field: s.field, mode: s.mode ?? null, parsed: s.parsed, ticked: s.ticked })
  if (next) return next.short
  if (s.error) return 'The changes could not be worked out'
  if (!s.current) return 'Working out the changes…'
  if (s.current.changes === 0) return 'Nothing would change'
  if (s.current.confirmWord && !s.confirmed) return `Type ${s.current.confirmWord} to confirm`
  return null
}

/** What a `choice` mode says when it has no choice: never "nothing to choose" while markets are ticked. */
export function noChoiceText(mode: BulkModeId | null, ticked: number): string {
  if (ticked === 0) return 'Tick a market to see the choices.'
  return mode === 'copy' ? 'No market here has a price to copy.' : 'The ticked markets do not take this.'
}

/**
 * A refusal as the dialog says it: the server's `Refused — …` prefix dropped (the line already says Skipped), the first
 * letter upper-case: `Refused — an active FBA offer keeps…` → `An active FBA offer keeps…`.
 */
export function reasonText(reason: string): string {
  const t = reason.replace(/^Refused\s*[—–-]\s*/, '')
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/** A failed or refused preview line, in the New column. */
export const skippedText = (reason: string): string => `Skipped — ${reasonText(reason)}`

/** The skipped reasons' disclosure: `Why 3 lines are skipped`. */
export const skippedSummary = (n: number): string => (n === 1 ? 'Why 1 line is skipped' : `Why ${num(n)} lines are skipped`)

export const NOT_UNDOABLE = 'This cannot be undone once it is sent.'

/**
 * The banners above the table: the runner's notices, each once and never the mode's hint again, then "cannot be undone"
 * when it cannot. A notice that arrives as a bare string (an older runner) is info.
 */
export function noticesFor(p: Pick<BulkPreview, 'notices' | 'undoable'>, hint: string | null | undefined): BulkNotice[] {
  const norm = (s: string) => s.trim().replace(/\.$/, '').toLowerCase()
  const seen = new Set<string>(hint ? [norm(hint)] : [])
  const out: BulkNotice[] = []
  for (const raw of p.notices as ReadonlyArray<BulkNotice | string>) {
    const n: BulkNotice = typeof raw === 'string' ? { text: raw, tone: 'info' } : raw
    const k = norm(n.text)
    if (k === '' || seen.has(k)) continue
    seen.add(k)
    out.push(n)
  }
  if (!p.undoable && !seen.has(norm(NOT_UNDOABLE))) out.push({ text: NOT_UNDOABLE, tone: 'info' })
  return out
}

// ── The table ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SkipGroup { reason: string; count: number; skus: string[] }

/** The skipped lines by reason, the largest group first (ties keep the order they came in); each SKU named once. */
export function groupSkipped(lines: readonly BulkLine[]): SkipGroup[] {
  const groups = new Map<string, SkipGroup>()
  for (const l of lines) {
    if (l.skipped === null) continue
    let g = groups.get(l.skipped)
    if (!g) { g = { reason: l.skipped, count: 0, skus: [] }; groups.set(l.skipped, g) }
    g.count += 1
    if (!g.skus.includes(l.sku)) g.skus.push(l.sku)
  }
  return [...groups.values()].sort((a, b) => b.count - a.count)
}

/** `Amazon-managed (2): SKU-A, SKU-B` */
export const skipGroupLine = (g: SkipGroup): string => `${reasonText(g.reason)} (${num(g.count)}): ${g.skus.join(', ')}`

export type LineFilter = 'all' | 'changes' | 'skipped'

export function filterLines(lines: readonly BulkLine[], filter: LineFilter): BulkLine[] {
  if (filter === 'changes') return lines.filter((l) => l.skipped === null)
  if (filter === 'skipped') return lines.filter((l) => l.skipped !== null)
  return [...lines]
}

/**
 * The table's filter: `All · 12` / `Changes · 10` / `Skipped · 2`. Only when it can narrow the table — with no skipped
 * line (or no change) every segment would show the same rows, so there is no filter at all.
 */
export function lineFilterOptions(lines: readonly BulkLine[], done = false): Array<{ value: LineFilter; label: string }> {
  const skipped = lines.filter((l) => l.skipped !== null).length
  const changes = lines.length - skipped
  if (changes === 0 || skipped === 0) return []
  return [
    { value: 'all', label: `All · ${num(lines.length)}` },
    // Once applied, the changed lines are what was saved.
    { value: 'changes', label: `${done ? 'Saved' : 'Changes'} · ${num(changes)}` },
    { value: 'skipped', label: `Skipped · ${num(skipped)}` },
  ]
}

/** The filter on screen: the chosen one while it is offered, else All. */
export function effectiveFilter(lines: readonly BulkLine[], filter: LineFilter): LineFilter {
  return lineFilterOptions(lines).some((o) => o.value === filter) ? filter : 'all'
}

/** One row of the table: a line, under the key of the set of lines it came in. */
/** `first` = the first row of its variant in the table on screen (the full name and SKU); the rest say the name quietly. */
export interface TableRow { key: string; line: BulkLine; first: boolean }

/**
 * A key per SET of lines, by identity: the same array keeps its key; another array — even one with the same words —
 * gets a new one. The DS grid redraws a cell only when its row is new or the value it reads changed, and the table's
 * cells read nothing it compares, so a row that kept its key across two previews kept the old words (the stale-cell
 * bug, BEFORE-NOTES 2026-10-12: Quantity showing a Fulfilment refusal). A new key per set makes every row new.
 */
export function createTableKeys(): (lines: readonly BulkLine[]) => string {
  const seen = new WeakMap<readonly BulkLine[], string>()
  let n = 0
  return (lines) => {
    let k = seen.get(lines)
    if (k === undefined) { n += 1; k = `t${n}`; seen.set(lines, k) }
    return k
  }
}

/** The table's rows: `<set key>|<line id>`, unique even when a set repeats a line id (`#2`, `#3`). */
export function tableRows(lines: readonly BulkLine[], setKey: string): TableRow[] {
  const used = new Map<string, number>()
  return lines.map((line) => {
    const n = (used.get(line.id) ?? 0) + 1
    used.set(line.id, n)
    return { key: `${setKey}|${line.id}${n > 1 ? `#${n}` : ''}`, line, first: true }
  })
}

/** Marks the first row of each run of one variant: a variant on 8 markets names its SKU once, not 8 times. */
export function markFirsts(rows: readonly TableRow[]): TableRow[] {
  return rows.map((r, i) => ({ ...r, first: i === 0 || rows[i - 1]!.line.rowId !== r.line.rowId }))
}

/** The rows a filter keeps (their keys unchanged), each variant's first row marked. */
export function filterRows(rows: readonly TableRow[], filter: LineFilter): TableRow[] {
  if (filter === 'changes') return markFirsts(rows.filter((r) => r.line.skipped === null))
  if (filter === 'skipped') return markFirsts(rows.filter((r) => r.line.skipped !== null))
  return markFirsts(rows)
}

/** A thrown value as a sentence. */
export const errorText = (e: unknown): string => (e instanceof Error ? e.message : typeof e === 'string' ? e : 'Something went wrong.')
