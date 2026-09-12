/**
 * AM.1 — how a stored value becomes a CELL value, per shape. ONE copy, imported by the studio sheet,
 * the master sheet rows, readiness and the write router — the same derivation everywhere, so a slot
 * that reads `bulletPoints[2]` on one surface cannot read `bulletPoints[3]` on another.
 *
 * Pure and node-loadable. The store shapes it accepts (measured 2026-09-04):
 *   list    — a real array (`Product.bulletPoints String[]`, `bulletPointsOverride`), the wizard's
 *             legacy JSON-encoded string `'["a","b"]'` (`submission.service.ts:1259`), or a bare
 *             string (one item).
 *   measure — `{ value, unit }`, or a bare number (unit unknown — reported as null, never invented).
 *   scalar  — as stored.
 */
import type { SheetColumn } from './sheet-columns.service.js'

export type MeasureValue = { value: number | null; unit: string | null }

export function isBlankValue(v: unknown): boolean {
  if (v === null || v === undefined) return true
  if (typeof v === 'string') return v.trim() === ''
  if (Array.isArray(v)) return v.every(isBlankValue)
  if (typeof v === 'object') {
    const m = v as Partial<MeasureValue>
    if ('value' in m || 'unit' in m) return isBlankValue(m.value)
    return Object.keys(v as object).length === 0
  }
  return false
}

/** A stored list in any of its shapes → an array, or null when there is nothing. */
export function readListValue(raw: unknown): unknown[] | null {
  if (raw === null || raw === undefined) return null
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    const t = raw.trim()
    if (t === '') return null
    if (t.startsWith('[')) {
      try {
        const parsed = JSON.parse(t)
        if (Array.isArray(parsed)) return parsed
      } catch {
        /* a string that merely starts with "[" is one item */
      }
    }
    return [raw]
  }
  return [raw]
}

/** A stored measure in any of its shapes → `{ value, unit }`, or null when there is nothing. */
export function readMeasureValue(raw: unknown): MeasureValue | null {
  if (raw === null || raw === undefined || raw === '') return null
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const m = raw as Record<string, unknown>
    const value = m.value === null || m.value === undefined || m.value === '' ? null : Number(m.value)
    const unit = typeof m.unit === 'string' && m.unit ? m.unit : null
    if (value === null && unit === null) return null
    return { value: value !== null && Number.isFinite(value) ? value : null, unit }
  }
  const n = Number(raw)
  return Number.isFinite(n) ? { value: n, unit: null } : null
}

/**
 * Project a column's STORED value (the list, the measure, the scalar) onto what its cell shows:
 * slot `n` of a list is item `n-1`; a list column shows the array; a measure shows `{ value, unit }`.
 * `base` is the value stored under the column's base key (`slot.of` for a slot).
 */
export function projectCellValue(col: Pick<SheetColumn, 'shape' | 'slot'>, base: unknown): unknown {
  if (col.slot) {
    const list = readListValue(base)
    if (!list) return null
    const item = list[col.slot.index - 1]
    return item === undefined || item === null || item === '' ? null : item
  }
  if (col.shape === 'list') {
    const list = readListValue(base)
    if (!list) return null
    const kept = list.filter((v) => !isBlankValue(v))
    return kept
  }
  if (col.shape === 'measure') return readMeasureValue(base)
  return base === undefined ? null : base
}

/**
 * The inverse for a SLOT write: the stored array with slot `index` set to `value`. Positions are
 * kept (an emptied slot becomes `''`) so nothing the operator typed moves — the outbound writer
 * compacts empties away (Owner ruling 2026-09-05: no gating between slots).
 */
export function withSlotValue(current: unknown, index: number, value: unknown): string[] {
  const list = (readListValue(current) ?? []).map((v) => (v === null || v === undefined ? '' : String(v)))
  while (list.length < index) list.push('')
  list[index - 1] = value === null || value === undefined ? '' : String(value)
  // Trailing empties carry no information; keep interior holes.
  while (list.length > 0 && list[list.length - 1] === '') list.pop()
  return list
}

/** Read a `path` out of a JSON bag (`platformAttributes.itemSpecifics.Marca`). */
export function readPath(bag: unknown, path: string[]): unknown {
  let cur: unknown = bag
  for (const p of path) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

/** `parseSlotField('bulletPoints[3]')` → `{ base: 'bulletPoints', index: 3 }`; null for a plain field. */
export function parseSlotField(field: string): { base: string; index: number } | null {
  const m = /^(.+)\[(\d+)\]$/.exec(field)
  if (!m) return null
  const index = Number(m[2])
  if (!Number.isInteger(index) || index < 1) return null
  return { base: m[1], index }
}

// ────────────────────────────────────────────────────────────────────
// Shape-aware WRITE coercion (AM.1) — the inverse of the projections above
// ────────────────────────────────────────────────────────────────────

/** The column facts a write needs; a subset of `SheetColumn` so the route can pass what it holds. */
export interface ShapeWriteFacts {
  maxLength?: number
  maxBytes?: number
  validation?: Record<string, unknown>
  kind?: string
  key?: string
  label?: string
  shape?: 'scalar' | 'list' | 'measure'
  cardinality?: { min: number; max: number | null }
  unitOptions?: string[]
  options?: string[]
  mode?: 'strict' | 'open'
}

export type ShapeWriteResult = { ok: true; value: unknown } | { ok: false; error: string }

const named = (f: ShapeWriteFacts) => f.label ?? f.key ?? 'this field'

/**
 * Turn an incoming cell value into the STORED shape for its column, or refuse with a sentence.
 * Never coerces across shapes: an array into a scalar, a bare number into a measure, or a string
 * into a list is refused rather than stringified — a `"a,b"` or `"[object Object]"` in the bag is
 * silent corruption (b0's reading of the route, 2026-09-05). `null`/`''`/`undefined` always means
 * CLEAR and is accepted for every shape. A legacy JSON-encoded array string (`'["a","b"]'`, the
 * wizard's L.2 encoding) is accepted for a list, because imports still carry it.
 */
export function coerceForShape(facts: ShapeWriteFacts | undefined, raw: unknown): ShapeWriteResult {
  const result = coerceShape(facts, raw)
  if (result.ok === false || result.value === null || result.value === undefined) return result
  const value = result.value
  const rules = facts?.validation ?? {}
  const number = (key: string): number | undefined => typeof rules[key] === 'number' && Number.isFinite(rules[key]) ? rules[key] as number : undefined
  const fail = (reason: string): ShapeWriteResult => ({ ok: false, error: `${named(facts ?? {})} ${reason}` })
  if (Array.isArray(value)) {
    if (number('minItems') !== undefined && value.length < number('minItems')!) return fail(`needs at least ${number('minItems')} values`)
    if (number('maxItems') !== undefined && value.length > number('maxItems')!) return fail(`takes at most ${number('maxItems')} values`)
    if (rules.uniqueItems === true && new Set(value).size !== value.length) return fail('requires distinct values')
  }
  const members = Array.isArray(value) ? value : facts?.shape === 'measure' ? [(value as MeasureValue).value] : [value]
  for (const member of members) {
    if (typeof member === 'string') {
      const max = facts?.maxLength ?? number('maxLength')
      if (max !== undefined && member.length > max) return fail(`takes at most ${max} characters`)
      if (number('minLength') !== undefined && member.length < number('minLength')!) return fail(`needs at least ${number('minLength')} characters`)
      if (facts?.maxBytes !== undefined && Buffer.byteLength(member, 'utf8') > facts.maxBytes) return fail(`takes at most ${facts.maxBytes} UTF-8 bytes`)
      if (typeof rules.pattern === 'string') {
        try { if (!new RegExp(rules.pattern, 'u').test(member)) return fail('does not match its configured format') }
        catch { return fail('has an invalid validation pattern; correct the attribute definition before saving') }
      }
    }
    if (typeof member === 'number') {
      const min = number('minimum') ?? number('min'), max = number('maximum') ?? number('max')
      if (min !== undefined && member < min) return fail(`must be at least ${min}`)
      if (max !== undefined && member > max) return fail(`must be at most ${max}`)
      if (number('exclusiveMinimum') !== undefined && member <= number('exclusiveMinimum')!) return fail(`must be greater than ${number('exclusiveMinimum')}`)
      if (number('exclusiveMaximum') !== undefined && member >= number('exclusiveMaximum')!) return fail(`must be less than ${number('exclusiveMaximum')}`)
      const multiple = number('multipleOf')
      if (multiple !== undefined && (multiple <= 0 || Math.abs(member / multiple - Math.round(member / multiple)) > 1e-8)) return fail(`must be a multiple of ${multiple}`)
    }
  }
  return result
}

function coerceShape(facts: ShapeWriteFacts | undefined, raw: unknown): ShapeWriteResult {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null }
  if (Array.isArray(facts?.validation?.recordFields)) {
    let records: unknown = raw
    if (typeof raw === 'string') { try { records = JSON.parse(raw) } catch { return { ok: false, error: `${named(facts)} needs a list of structured records` } } }
    if (!Array.isArray(records) || records.some(row => !row || typeof row !== 'object' || Array.isArray(row))) return { ok: false, error: `${named(facts)} needs a list of structured records` }
    const result: Record<string, unknown>[] = []
    for (const [index, rawRow] of records.entries()) {
      const row = { ...rawRow }
      for (const field of facts.validation.recordFields as Array<Record<string, any>>) {
        if (!field.key || !['text', 'number', 'boolean', 'select'].includes(field.kind)) return { ok: false, error: `${named(facts)} has an invalid record definition` }
        const value = row[field.key]
        if (field.required && (value == null || value === '')) return { ok: false, error: `${named(facts)} record ${index + 1} needs ${field.label ?? field.key}` }
        if (value === undefined) continue
        const checked = coerceForShape({ label: `${named(facts)} record ${index + 1}: ${field.label ?? field.key}`, kind: field.kind,
          mode: field.options?.length ? 'strict' : 'open', options: field.options?.map((option: any) => option.value), validation: { minimum: field.min, maximum: field.max } }, value)
        if (!checked.ok) return checked
        row[field.key] = checked.value
      }
      result.push(row)
    }
    const unique = facts.validation.uniqueBy
    if (typeof unique === 'string' && new Set(result.map(row => row[unique])).size !== result.length) return { ok: false, error: `${named(facts)} needs distinct ${unique} values` }
    const sum = facts.validation.sum as { field?: string; total?: number } | undefined
    if (result.length && sum?.field && typeof sum.total === 'number' && Math.abs(result.reduce((total, row) => total + Number(row[sum.field!] ?? 0), 0) - sum.total) > 0.001) return { ok: false, error: `${named(facts)} ${sum.field} values must total ${sum.total}` }
    return { ok: true, value: result }
  }
  const shape = facts?.shape ?? 'scalar'

  if (shape === 'list') {
    let items: unknown[] | null = null
    if (Array.isArray(raw)) items = raw
    else if (typeof raw === 'string' && raw.trim().startsWith('[')) items = readListValue(raw)
    if (!items) {
      return { ok: false, error: `${named(facts!)} takes a LIST of values — send an array, not one value` }
    }
    if (items.some(item => item !== null && typeof item === 'object')) {
      return { ok: false, error: `${named(facts!)} takes simple values; structured records cannot be converted to text` }
    }
    const cleaned: unknown[] = []
    for (const item of items) {
      if (isBlankValue(item)) continue
      if (facts?.kind === 'number' || facts?.kind === 'boolean') {
        const member = coerceShape({ ...facts, shape: 'scalar' }, item)
        if (member.ok === false) return member
        cleaned.push(member.value)
      } else cleaned.push(String(item).trim())
    }
    const max = facts?.cardinality?.max ?? null
    if (max !== null && cleaned.length > max) {
      return { ok: false, error: `${cleaned.length} values — ${named(facts!)} takes at most ${max}` }
    }
    const min = facts?.cardinality?.min ?? 1
    if (cleaned.length < min) {
      return { ok: false, error: `${cleaned.length} value${cleaned.length === 1 ? '' : 's'} — ${named(facts!)} needs at least ${min}` }
    }
    if (facts?.mode === 'strict' && facts.options && facts.options.length > 0) {
      const off = cleaned.find((x) => !facts.options!.includes(String(x)))
      if (off !== undefined) return { ok: false, error: `"${off}" is not one of the allowed values for ${named(facts)}` }
    }
    return { ok: true, value: cleaned }
  }

  if (shape === 'measure') {
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: `${named(facts!)} is a measure — send { value, unit }, not a bare ${Array.isArray(raw) ? 'list' : typeof raw}` }
    }
    const m = raw as { value?: unknown; unit?: unknown }
    if (m.value != null && typeof m.value !== 'number' && typeof m.value !== 'string') {
      return { ok: false, error: `${named(facts!)} needs a numeric measure value` }
    }
    if (m.unit != null && typeof m.unit !== 'string') {
      return { ok: false, error: `${named(facts!)} needs a text unit code` }
    }
    let value: number | null = null
    if (m.value != null && !(typeof m.value === 'string' && m.value.trim() === '')) {
      const n = typeof m.value === 'number' ? m.value : Number(String(m.value).replace(',', '.'))
      if (!Number.isFinite(n)) return { ok: false, error: `"${String(m.value)}" is not a number for ${named(facts!)}` }
      value = n
    }
    const unit = typeof m.unit === 'string' && m.unit.trim() ? m.unit.trim() : null
    if (value === null && unit === null) return { ok: true, value: null }
    if (unit !== null && facts?.unitOptions && facts.unitOptions.length > 0 && !facts.unitOptions.includes(unit)) {
      return { ok: false, error: `unit "${unit}" is not one of ${facts.unitOptions.join(', ')} for ${named(facts)}` }
    }
    if (value !== null && unit === null && facts?.unitOptions && facts.unitOptions.length > 0) {
      return { ok: false, error: `${named(facts)} needs a unit (${facts.unitOptions.join(', ')})` }
    }
    return { ok: true, value: { value, unit } }
  }

  // scalar
  if (Array.isArray(raw)) return { ok: false, error: `${named(facts ?? {})} takes ONE value — a list was sent` }
  if (typeof raw === 'object') return { ok: false, error: `${named(facts ?? {})} takes ONE value — an object was sent` }
  let value = typeof raw === 'string' ? raw.trim() : raw
  if (value === '') return { ok: true, value: null }
  if (facts?.kind === 'number') {
    if (typeof value === 'boolean' || !Number.isFinite(Number(value))) return { ok: false, error: `${named(facts)} needs a number` }
    value = Number(value)
  }
  if (facts?.kind === 'boolean') {
    if (value === 'true') value = true
    if (value === 'false') value = false
    if (typeof value !== 'boolean') return { ok: false, error: `${named(facts)} needs Yes or No` }
  }
  if (facts?.mode === 'strict' && facts.options && facts.options.length > 0 && !facts.options.includes(String(value))) {
    return { ok: false, error: `"${String(value)}" is not one of the allowed values for ${named(facts)}` }
  }
  return { ok: true, value }
}
