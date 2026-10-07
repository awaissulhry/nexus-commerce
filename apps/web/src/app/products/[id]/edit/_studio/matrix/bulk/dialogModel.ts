/**
 * The Matrix bulk Edit dialog's own logic, as pure functions (`BulkEditDialog.tsx` is the screen; `types.ts` the contract).
 *
 * Everything here reads what the operator typed or what the runner answered and says it back in plain words: how an
 * entry is read (or why it cannot be), what the Apply button says and why it is held, the footer sentence, the skipped
 * lines by reason, what the dialog opens on, and the key that ties a preview to what is on screen. Nothing here
 * computes a number the dialog shows as a result: every `Now → New` is the runner's.
 */
import type { CoordinateKey } from '../contract'
import type {
  BulkChoiceOption, BulkEditSource, BulkFieldId, BulkFieldSpec, BulkInitial, BulkInput, BulkInputKind, BulkLine, BulkModeId,
  BulkModeSpec, BulkPreview, BulkRequest,
} from './types'

/** The preview is asked again this long after the last change. */
export const PREVIEW_DELAY_MS = 250
/** Up to this many choices show as segments; more open a list. */
export const SEGMENT_CHOICES_MAX = 5

/** What is on screen, as typed: the dialog parses it and never sends a string it could not read. */
export interface BulkRaw {
  /** The amount, the percentage, the number, or the sale price. */
  text: string
  choice: string
  /** The sale's dates, ISO `YYYY-MM-DD` (the date fields give ISO whatever they show). */
  start: string
  end: string
}
export const EMPTY_RAW: BulkRaw = Object.freeze({ text: '', choice: '', start: '', end: '' })

/**
 * `empty`    nothing entered yet: Apply waits, no error under the field
 * `partial`  a number still being typed (`99,`, `-`): Apply waits, no error yet
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

/** A typed minus: ASCII, the minus sign the placeholder shows, or an en dash. */
const MINUS = /^[-−–]/
const compact = (s: string) => s.trim().replace(/\s+/g, '')

function readMoney(raw: string, empty: string): ParseResult {
  const t = compact(raw)
  if (t === '') return fail('empty', empty)
  if (MINUS.test(t)) return fail('invalid', 'Enter 0 or more.')
  if (/^\d+[.,]$/.test(t)) return fail('partial', 'Finish the number.')
  if (/^\d+[.,]\d{3,}$/.test(t)) return fail('invalid', 'Use at most 2 decimals, like 99.75.')
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(t)) return fail('invalid', 'Enter a number, like 99.75.')
  return ok({ amount: Math.round(Number(t.replace(',', '.')) * 100) / 100 })
}

function readPercent(raw: string): ParseResult {
  const t = compact(raw).replace(/%$/, '').replace(MINUS, '-')
  if (t === '') return fail('empty', 'Enter a percentage.')
  if (/^[-+]$/.test(t) || /^[-+]?\d+[.,]$/.test(t)) return fail('partial', 'Finish the number.')
  if (!/^[-+]?\d+(?:[.,]\d{1,2})?$/.test(t)) return fail('invalid', 'Enter a percentage, like −5 or 10.')
  const n = Number(t.replace(',', '.'))
  if (n === 0) return fail('invalid', 'Enter a change other than 0.')
  if (n <= -100) return fail('invalid', 'It cannot go down by 100 % or more.')
  return ok({ percent: n })
}

function readInteger(raw: string): ParseResult {
  const t = compact(raw)
  if (t === '') return fail('empty', 'Enter a number.')
  if (MINUS.test(t)) return fail('invalid', 'Enter 0 or more.')
  if (/^\d+[.,]\d*$/.test(t)) return fail('invalid', 'Enter a whole number.')
  if (!/^\d+$/.test(t)) return fail('invalid', 'Enter a whole number, like 5.')
  const n = Number(t)
  if (!Number.isSafeInteger(n)) return fail('invalid', 'That number is too large.')
  return ok({ amount: n })
}

/** A real calendar day written `YYYY-MM-DD` (`2026-02-30` is not one). */
export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
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

/**
 * Reads what the operator entered for a mode:
 *   money    0 or more, up to 2 decimals: `105` · `99,75` · `99.75`
 *   percent  signed, not 0, above −100: `-5` · `−5` · `+10` · `2,5 %`
 *   integer  a whole number, 0 or more (as `amount`)
 *   choice   one of `choices` (when given: a choice no longer offered is not read)
 *   sale     a sale price as money, and a start and an end date with start ≤ end
 *   none     always read
 */
export function parseInput(kind: BulkInputKind, raw: BulkRaw, choices?: readonly BulkChoiceOption[]): ParseResult {
  switch (kind) {
    case 'none': return ok({})
    case 'money': return readMoney(raw.text, 'Enter an amount.')
    case 'percent': return readPercent(raw.text)
    case 'integer': return readInteger(raw.text)
    case 'choice': {
      const c = raw.choice
      if (c === '' || (choices && !choices.some((o) => o.value === c))) return fail('empty', 'Choose one.')
      return ok({ choice: c })
    }
    case 'sale': return readSale(raw)
  }
}

/** The input's words back on screen (an opening value, `initial.input`). */
export function rawFromInput(kind: BulkInputKind, input: BulkInput | undefined): BulkRaw {
  if (!input) return EMPTY_RAW
  switch (kind) {
    case 'money': case 'integer': return { ...EMPTY_RAW, text: input.amount != null ? String(input.amount) : '' }
    case 'percent': return { ...EMPTY_RAW, text: input.percent != null ? String(input.percent) : '' }
    case 'choice': return { ...EMPTY_RAW, choice: input.choice ?? '' }
    case 'sale': return input.sale ? { text: String(input.sale.value), choice: '', start: input.sale.start, end: input.sale.end } : EMPTY_RAW
    case 'none': return EMPTY_RAW
  }
}

const SYMBOLS: Readonly<Record<string, string>> = { EUR: '€', GBP: '£', USD: '$' }
/** `€` for EUR, `£` GBP, `$` USD; any other currency by its code. */
export const currencySymbol = (code: string): string => SYMBOLS[code.trim().toUpperCase()] ?? code

/** An input's label when its mode names none. */
export const DEFAULT_INPUT_LABEL: Readonly<Record<BulkInputKind, string>> = {
  none: '', money: 'Amount', percent: 'Change by', integer: 'Number', choice: 'Choose', sale: 'Sale price',
}

// ── What the dialog opens on ──────────────────────────────────────────────────────────────────────────────────────

export interface BulkFormState {
  field: BulkFieldId | null
  mode: BulkModeId | null
  /** The ticked markets (empty for a product-level field). */
  markets: CoordinateKey[]
  raw: BulkRaw
}

type SourceShape = Pick<BulkEditSource, 'fields' | 'marketsFor' | 'defaultMarkets'>

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

/** A field as it starts when chosen: its first mode, its default markets, nothing typed. */
export function fieldDefaults(source: SourceShape, fieldId: BulkFieldId): BulkFormState {
  const field = source.fields.find((f) => f.id === fieldId)
  if (!field) return { field: null, mode: null, markets: [], raw: EMPTY_RAW }
  return { field: field.id, mode: field.modes[0]?.id ?? null, markets: marketsFor(source, field), raw: EMPTY_RAW }
}

/**
 * What the dialog opens on: the initial field when it is offered (with its mode and value when they belong to it),
 * else the first field that is not held (else the first field, which then says why it is held); its first mode; the
 * initial markets that can be ticked, else the field's default markets.
 */
export function resolveInitial(source: SourceShape | null, initial?: BulkInitial): BulkFormState {
  if (!source || source.fields.length === 0) return { field: null, mode: null, markets: [], raw: EMPTY_RAW }
  const asked = initial?.field ? source.fields.find((f) => f.id === initial.field && f.held === null) : undefined
  const field = asked ?? source.fields.find((f) => f.held === null) ?? source.fields[0]!
  const askedMode = asked && initial?.mode ? field.modes.find((m) => m.id === initial.mode) : undefined
  const mode: BulkModeSpec | undefined = askedMode ?? field.modes[0]
  return {
    field: field.id,
    mode: mode?.id ?? null,
    markets: marketsFor(source, field, initial?.coordinateKeys),
    raw: asked && mode && (askedMode || !initial?.mode) ? rawFromInput(mode.input, initial?.input) : EMPTY_RAW,
  }
}

// ── The request, and the key that ties a preview to the screen ──────────────────────────────────────────────────────

/** The request on screen; null while the entry cannot be read, no market is ticked, or the field is held. */
export function buildRequest(field: BulkFieldSpec | null, mode: BulkModeSpec | null, parsed: ParseResult, markets: readonly CoordinateKey[]): BulkRequest | null {
  if (!field || !mode || field.held !== null || !parsed.input) return null
  if (field.perMarket && markets.length === 0) return null
  return { field: field.id, mode: mode.id, input: parsed.input, coordinateKeys: field.perMarket ? [...markets] : [] }
}

/**
 * One string per request, stable whatever order the markets were ticked in and whatever order the input's keys were
 * written in. A preview is applied only when the key of the request it answers equals the key on screen.
 */
export function requestKey(r: BulkRequest | null): string | null {
  if (!r) return null
  const i = r.input
  return JSON.stringify([
    r.field, r.mode, i.amount ?? null, i.percent ?? null, i.choice ?? null,
    i.sale ? [i.sale.value, i.sale.start, i.sale.end] : null,
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

export interface HeldInputs {
  phase: BulkPhase
  /** No field chosen (`null` field) or the field's own `held`. */
  field: Pick<BulkFieldSpec, 'held' | 'perMarket'> | null
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
  if (!s.field) return 'Choose what to change'
  if (s.field.held) return s.field.held
  if (s.parsed.state === 'empty') return 'Choose a value first'
  if (s.parsed.state !== 'ok') return s.parsed.reason ?? 'Choose a value first'
  if (s.field.perMarket && s.ticked === 0) return 'Tick at least one market'
  if (s.error) return 'The changes could not be worked out'
  if (!s.current) return 'Working out the changes…'
  if (s.current.changes === 0) return 'Nothing would change'
  if (s.current.confirmWord && !s.confirmed) return `Type ${s.current.confirmWord} to confirm`
  return null
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
export const skipGroupLine = (g: SkipGroup): string => `${g.reason} (${num(g.count)}): ${g.skus.join(', ')}`

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

/** What the table area says while there is no request to preview. */
export function previewPrompt(s: { field: Pick<BulkFieldSpec, 'held' | 'perMarket'> | null; kind: BulkInputKind; parsed: ParseResult; ticked: number }): string {
  if (!s.field) return 'Choose what to change.'
  if (s.field.held) return s.field.held
  if (s.parsed.state !== 'ok') return s.kind === 'choice' ? 'Choose a value to see what would change.' : 'Enter a value to see what would change.'
  if (s.field.perMarket && s.ticked === 0) return 'Tick a market to see what would change.'
  return 'Working out the changes…'
}

/** A thrown value as a sentence. */
export const errorText = (e: unknown): string => (e instanceof Error ? e.message : typeof e === 'string' ? e : 'Something went wrong.')
