/**
 * The sheet read's cells on the wire, once per column (P2 of fix/product-sheet-editing, 2026-09-30).
 *
 * Measured on GALE-JACKET · eBay · IT: 995 bytes per cell, of which the value was under a tenth. Most of a cell is
 * the same for its whole column — its `contentAddress`, its write routing, the mapping engine's provenance — and was
 * sent again in every row. Here each column sends a BASE cell once, and each cell sends only what differs from it.
 *
 * Lossless: `decodeSheetCells(encodeSheetCells(sheet))` deep-equals the sheet as JSON would carry it (a key whose
 * value is `undefined` is absent, as `JSON.stringify` leaves it). Every decoded cell owns its objects and arrays, as
 * `JSON.parse` would give it, so a reader that mutates one cell never touches another.
 *
 * The same holds for each row's own fields (completeness, readiness, listing …): they are sent as their difference
 * from the fields most rows share (`rowBase`).
 *
 * Opt-in per request (`cells=compact`): a reader that does not ask gets today's shape, and a reader that asks an
 * older API gets today's shape too — `decodeSheetCells` passes any sheet without `meta.cellEncoding` through.
 *
 * A patch is an object: each key it holds replaces the base's value for that key; the reserved key `~` holds
 * `u` (keys the base has and this cell lacks), `n` (patches of nested objects both sides hold) or `v` (a cell that
 * is not an object, or that itself holds `~`, sent whole).
 */
export const SHEET_CELL_ENCODING = 'column-base-v1'

type Obj = Record<string, unknown>
interface Meta { u?: string[]; n?: Record<string, Obj>; v?: unknown; o?: string[] }
const META = '~'
const MAX_DEPTH = 4

/** A plain object. A Date, a Decimal or anything else with its own JSON form is a value, compared and sent as that JSON. */
const isObject = (value: unknown): value is Obj => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return (prototype === Object.prototype || prototype === null) && typeof (value as { toJSON?: unknown }).toJSON !== 'function'
}

/** A value's identity for counting and comparing: primitives by type and value, everything else as JSON. */
function identity(value: unknown): string {
  switch (typeof value) {
    case 'string': return `s${value}`
    case 'number': return `n${value}`
    case 'boolean': return value ? 'T' : 'F'
    default: return value === null ? 'null' : `j${JSON.stringify(value)}`
  }
}

const present = (object: Obj): string[] => {
  const keys: string[] = []
  for (const key of Object.keys(object)) if (object[key] !== undefined) keys.push(key)
  return keys
}

/** A value `JSON.stringify` leaves out of an object (and writes as `null` in an array). */
const unsent = (value: unknown) => value === undefined || typeof value === 'function' || typeof value === 'symbol'

/**
 * B33 — `JSON.stringify(a) === JSON.stringify(b)` without building either string (the encoder's hot path): plain objects
 * key by key in order, arrays item by item, anything else (a Date, a Decimal, NaN, mixed types) by its JSON.
 */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return typeof a !== 'number' || Number.isFinite(a)
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      const x = unsent(a[i]) ? null : a[i], y = unsent(b[i]) ? null : b[i]
      if (!jsonEqual(x, y)) return false
    }
    return true
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a), kb = Object.keys(b)
    let i = 0, j = 0
    for (;;) {
      while (i < ka.length && unsent(a[ka[i]])) i++
      while (j < kb.length && unsent(b[kb[j]])) j++
      if (i === ka.length || j === kb.length) return i === ka.length && j === kb.length
      if (ka[i] !== kb[j] || !jsonEqual(a[ka[i]], b[kb[j]])) return false
      i++; j++
    }
  }
  if (typeof a !== 'object' && typeof b !== 'object' && typeof a !== 'number' && typeof b !== 'number') return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Past this many distinct non-primitive values of one key, they are counted by their JSON (`identity`) instead. */
const LINEAR_CANDIDATES = 8

/** The cell most of a column's cells are closest to: per key, the value most cells hold (nested objects per key too). */
function baseOf(objects: Obj[], depth: number): Obj {
  type Candidate = { count: number; value: unknown }
  // Candidates in first-seen order (the tie-break); primitives found by value, others by `jsonEqual` or their JSON.
  type Tally = { objects: Obj[]; seen: number; candidates: Candidate[]; primitives: Map<unknown, Candidate>; others: Candidate[]; byJson?: Map<string, Candidate> }
  const tallies = new Map<string, Tally>()
  for (const object of objects) {
    for (const key of Object.keys(object)) {
      const value = object[key]
      if (value === undefined) continue
      let tally = tallies.get(key)
      if (!tally) tallies.set(key, tally = { objects: [], seen: 0, candidates: [], primitives: new Map(), others: [] })
      if (isObject(value) && depth < MAX_DEPTH) { tally.objects.push(value); continue }
      tally.seen++
      let found: Candidate | undefined
      const primitive = value === null || (typeof value !== 'object' && (typeof value !== 'number' || Number.isFinite(value)))
      if (primitive) found = tally.primitives.get(value)
      else if (tally.byJson) found = tally.byJson.get(identity(value))
      else found = tally.others.find(candidate => jsonEqual(candidate.value, value))
      if (found) { found.count++; continue }
      const candidate = { count: 1, value }
      tally.candidates.push(candidate)
      if (primitive) tally.primitives.set(value, candidate)
      else if (tally.byJson) tally.byJson.set(identity(value), candidate)
      else if (tally.others.push(candidate) > LINEAR_CANDIDATES) tally.byJson = new Map(tally.others.map(other => [identity(other.value), other]))
    }
  }
  const base: Obj = {}
  for (const [key, tally] of tallies) {
    const absent = objects.length - tally.objects.length - tally.seen
    let best: Candidate | undefined
    for (const candidate of tally.candidates) if (!best || candidate.count > best.count) best = candidate
    const objectCount = tally.objects.length
    if (absent >= objectCount && absent >= (best?.count ?? 0)) continue
    base[key] = objectCount >= (best?.count ?? 0) ? baseOf(tally.objects, depth + 1) : best!.value
  }
  return base
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  return jsonEqual(a, b)
}

/**
 * Whether `order` is the key order `apply` gives: the base's keys it keeps, in the base's order, then the patch's keys
 * the base lacks (compared in place: this runs once per cell).
 */
function decodesInOrder(order: string[], base: Obj, patch: Obj, meta: Meta): boolean {
  let i = 0
  for (const key of Object.keys(base)) if (!meta.u?.includes(key) && order[i++] !== key) return false
  for (const key of Object.keys(patch)) if (key !== META && !(key in base) && order[i++] !== key) return false
  return i === order.length
}

function patchOf(base: Obj, object: Obj, depth: number): Obj {
  const patch: Obj = {}
  const meta: Meta = {}
  for (const key of present(object)) {
    const value = object[key]
    const from = base[key]
    if (from !== undefined && same(from, value)) continue
    if (isObject(from) && isObject(value) && depth < MAX_DEPTH && !(META in value)) {
      (meta.n ??= {})[key] = patchOf(from, value, depth + 1)
      continue
    }
    patch[key] = value
  }
  for (const key of Object.keys(base)) if (base[key] !== undefined && object[key] === undefined) (meta.u ??= []).push(key)
  // Key order is kept too: a reader may show an object's values in order (a row's axis values, say).
  const order = present(object)
  if (!decodesInOrder(order, base, patch, meta)) meta.o = order
  if (meta.n || meta.u || meta.o) patch[META] = meta
  return patch
}

/** A fresh copy, as JSON.parse would make it. */
function copy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copy)
  if (!isObject(value)) return value
  const out: Obj = {}
  for (const key of Object.keys(value)) out[key] = copy(value[key])
  return out
}

/** `extra`: keys the caller decodes itself (a row's `values`), placed before the key order is restored. */
function apply(base: Obj | undefined, patch: Obj, extra?: Obj): unknown {
  const meta = patch[META] as Meta | undefined
  if (meta && 'v' in meta) return copy(meta.v)
  const unset = meta?.u
  const out: Obj = {}
  for (const key of Object.keys(base ?? {})) {
    if (unset?.includes(key)) continue
    if (key !== META && key in patch) { out[key] = copy(patch[key]); continue }
    const nested = meta?.n?.[key]
    out[key] = nested ? apply(base![key] as Obj, nested) : copy(base![key])
  }
  for (const key of Object.keys(patch)) if (key !== META && !(key in out)) out[key] = copy(patch[key])
  for (const key of Object.keys(meta?.n ?? {})) if (!(key in out)) out[key] = apply(base?.[key] as Obj | undefined, meta!.n![key])
  if (extra) Object.assign(out, extra)
  if (!meta?.o) return out
  const ordered: Obj = {}
  for (const key of meta.o) if (key in out) ordered[key] = out[key]
  for (const key of Object.keys(out)) if (!(key in ordered)) ordered[key] = out[key]
  return ordered
}

interface SheetLike { rows?: Obj[]; meta?: Obj; cellBase?: Record<string, Obj>; rowBase?: Obj }
/** What goes on the wire: the rows are patches until `decodeSheetCells` restores them. */
export type EncodedSheet<T> = Omit<T, 'rows'> & { rows: Obj[]; cellBase: Record<string, Obj>; rowBase: Obj }

const literal = (value: unknown): Obj => ({ [META]: { v: value } })
/** A row with its cells replaced by a placeholder in place, so the row base keeps where `values` stands. */
const withoutCells = (row: Obj): Obj => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, key === 'values' && value !== undefined ? 0 : value]))

function encodeCells(values: Obj, cellBase: Record<string, Obj>): Obj {
  const out: Obj = {}
  for (const [field, cell] of Object.entries(values)) {
    if (cell === undefined) continue
    out[field] = isObject(cell) && !(META in cell) ? patchOf(cellBase[field], cell, 0) : literal(cell)
  }
  return out
}

/**
 * The sheet with each column's shared cell sent once (`cellBase`), each cell as its difference from it, and each
 * row's own fields (completeness, readiness, listing …) as their difference from the fields most rows share
 * (`rowBase`).
 */
export function encodeSheetCells<T extends { rows?: readonly object[]; meta?: object }>(sheet: T): EncodedSheet<T> {
  const rows = (sheet.rows ?? []) as Obj[]
  const columns = new Map<string, Obj[]>()
  const rowFields: Obj[] = []
  for (const row of rows) {
    if (!isObject(row) || META in row) continue
    const values = row.values
    rowFields.push(withoutCells(row))
    if (!isObject(values)) continue
    for (const [field, cell] of Object.entries(values)) {
      if (!isObject(cell) || META in cell) continue
      let cells = columns.get(field)
      if (!cells) columns.set(field, cells = [])
      cells.push(cell)
    }
  }
  const cellBase: Record<string, Obj> = {}
  for (const [field, cells] of columns) cellBase[field] = baseOf(cells, 0)
  const rowBase = baseOf(rowFields, 0)
  return {
    ...sheet,
    meta: { ...(sheet.meta ?? {}), cellEncoding: SHEET_CELL_ENCODING },
    cellBase,
    rowBase,
    rows: rows.map(row => {
      if (!isObject(row) || META in row || (row.values !== undefined && !isObject(row.values))) return literal(row)
      const patch = patchOf(rowBase, withoutCells(row), 0)
      if (row.values !== undefined) patch.values = encodeCells(row.values as Obj, cellBase)
      return patch
    }),
  }
}

/**
 * The sheet exactly as it was before `encodeSheetCells`. A sheet that was not encoded (an older API, or a reader that
 * did not ask) is returned as it is.
 */
export function decodeSheetCells<T>(sheet: T): T {
  const encoded = sheet as SheetLike
  if (!encoded || encoded.meta?.cellEncoding !== SHEET_CELL_ENCODING) return sheet
  const cellBase = encoded.cellBase ?? {}
  const rowBase = encoded.rowBase ?? {}
  const { cellEncoding: _encoding, ...meta } = encoded.meta
  const { cellBase: _cells, rowBase: _rows, ...rest } = encoded
  return {
    ...rest,
    meta,
    rows: (encoded.rows ?? []).map(patch => {
      const meta = patch[META] as Meta | undefined
      if (meta && 'v' in meta) return copy(meta.v)
      const { values, ...fields } = patch
      if (values === undefined) return apply(rowBase, fields)
      const cells: Obj = {}
      for (const [field, cell] of Object.entries(values as Obj)) cells[field] = apply(cellBase[field], cell as Obj)
      return apply(rowBase, fields, { values: cells })
    }),
  } as T
}
