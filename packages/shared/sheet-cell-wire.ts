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
 *
 * Pooled patches (`cells=compact&patches=pooled`, 2026-10-01), a second opt-in on top: many cells and nested objects
 * differ from their column the same way (the same key order, the same inherited source …), so each patch that repeats
 * is sent once in `patchPool` and every place that holds it sends its index instead. See `encodePooledSheetCells`.
 */
export const SHEET_CELL_ENCODING = 'column-base-v1'
export const POOLED_SHEET_CELL_ENCODING = 'column-base-pool-v2'

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

const present = (object: Obj): string[] => Object.keys(object).filter(key => object[key] !== undefined)

/** The cell most of a column's cells are closest to: per key, the value most cells hold (nested objects per key too). */
function baseOf(objects: Obj[], depth: number): Obj {
  const tallies = new Map<string, { absent: number; objects: Obj[]; values: Map<string, { count: number; value: unknown }> }>()
  for (const object of objects) {
    for (const key of present(object)) {
      let tally = tallies.get(key)
      if (!tally) tallies.set(key, tally = { absent: 0, objects: [], values: new Map() })
      const value = object[key]
      if (isObject(value) && depth < MAX_DEPTH) { tally.objects.push(value); continue }
      const id = identity(value)
      const seen = tally.values.get(id)
      if (seen) seen.count++
      else tally.values.set(id, { count: 1, value })
    }
  }
  const base: Obj = {}
  for (const [key, tally] of tallies) {
    const absent = objects.length - tally.objects.length - [...tally.values.values()].reduce((sum, v) => sum + v.count, 0)
    let best: { count: number; value: unknown } | undefined
    for (const candidate of tally.values.values()) if (!best || candidate.count > best.count) best = candidate
    const objectCount = tally.objects.length
    if (absent >= objectCount && absent >= (best?.count ?? 0)) continue
    base[key] = objectCount >= (best?.count ?? 0) ? baseOf(tally.objects, depth + 1) : best!.value
  }
  return base
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The key order `apply` gives: the base's keys it keeps, in the base's order, then the patch's keys the base lacks. */
function decodedOrder(base: Obj, patch: Obj, meta: Meta): string[] {
  const unset = new Set(meta.u ?? [])
  const order = Object.keys(base).filter(key => !unset.has(key))
  for (const key of Object.keys(patch)) if (key !== META && !(key in base)) order.push(key)
  return order
}
const sameOrder = (a: string[], b: string[]) => a.length === b.length && a.every((key, i) => key === b[i])

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
  for (const key of present(base)) if (object[key] === undefined) (meta.u ??= []).push(key)
  // Key order is kept too: a reader may show an object's values in order (a row's axis values, say).
  const order = present(object)
  if (!sameOrder(order, decodedOrder(base, patch, meta))) meta.o = order
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
  const unset = new Set(meta?.u ?? [])
  const out: Obj = {}
  for (const key of Object.keys(base ?? {})) {
    if (unset.has(key)) continue
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
/** The pooled wire form: an encoded sheet whose repeated patches are sent once, in `patchPool`. */
export type PooledSheet<T> = EncodedSheet<T> & { patchPool: Obj[] }

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

const utf8 = new TextEncoder()
const utf8Bytes = (json: string): number => utf8.encode(json).length
const mapValues = <V>(object: Obj, map: (value: unknown) => V): Record<string, V> =>
  Object.fromEntries(Object.entries(object).map(([key, value]) => [key, map(value)]))
const nestedPatches = (patch: Obj): Record<string, Obj> | undefined => (patch[META] as Meta | undefined)?.n
/** Names the wire itself uses. A sheet that already holds one is not pooled (see `encodePooledSheetCells`). */
const WIRE_FIELDS = ['cellBase', 'rowBase', 'patchPool'] as const
const ENCODINGS: ReadonlySet<unknown> = new Set([SHEET_CELL_ENCODING, POOLED_SHEET_CELL_ENCODING])

/**
 * The sheet for a reader that asked for pooled patches (`cells=compact&patches=pooled`): whichever of the plain sheet,
 * the `encodeSheetCells` form and the pooled form is the fewest UTF-8 bytes, so asking can never make an answer larger.
 * `decodeSheetCells` restores all three.
 *
 * The pooled form is the `encodeSheetCells` form plus `patchPool`: the cell patches (`rows[].values[field]`) and nested
 * patches (`~.n[key]`, in a row's fields or a cell, at any depth) that repeat often enough to pay for themselves. Each
 * such place sends the patch's index in `patchPool` instead. `encodeSheetCells` never puts a number in those places (a
 * cell that is not an object is sent as `{"~":{"v":…}}`), so a number there is always a reference and never a value.
 * Pool entries are those exact patches, never references themselves; values, metadata and the bases are not pooled.
 *
 * A sheet that already holds a field the wire uses (`cellBase`, `rowBase`, `patchPool`, `meta.cellEncoding`) is sent
 * plain, which keeps it exact; only one whose `meta.cellEncoding` would make the reader take it for encoded gets the
 * answer a reader that did not ask would get.
 */
export function encodePooledSheetCells<T extends { rows?: readonly object[]; meta?: object }>(sheet: T): T | EncodedSheet<T> | PooledSheet<T> {
  const meta = (sheet.meta ?? {}) as Obj
  if (WIRE_FIELDS.some(field => Object.hasOwn(sheet, field)) || Object.hasOwn(meta, 'cellEncoding')) {
    return ENCODINGS.has(meta.cellEncoding) ? encodeSheetCells(sheet) : sheet
  }
  const legacy = encodeSheetCells(sheet)
  const legacyJson = JSON.stringify(legacy)
  let best: { form: T | EncodedSheet<T> | PooledSheet<T>; bytes: number } = { form: legacy, bytes: utf8Bytes(legacyJson) }
  const pooled = poolPatches(legacy)
  if (pooled) {
    const bytes = utf8Bytes(JSON.stringify(pooled))
    if (bytes < best.bytes) best = { form: pooled, bytes }
  }
  // A sheet too small or too varied to gain from either form goes plain, as a reader that did not ask would get it.
  return utf8Bytes(JSON.stringify(sheet)) <= best.bytes ? sheet : best.form
}

/** `legacy` with each repeated cell or nested patch sent once; undefined when no patch repeats. */
function poolPatches<T>(legacy: EncodedSheet<T>): PooledSheet<T> | undefined {
  // A patch's text is its identity: two patches are the same patch only when they are the same JSON, key order included.
  const texts = new WeakMap<Obj, string>()
  const textOf = (patch: Obj): string => {
    let text = texts.get(patch)
    if (text === undefined) texts.set(patch, text = JSON.stringify(patch))
    return text
  }
  const seen = new Map<string, { patch: Obj; count: number; bytes: number }>()
  const count = (patch: Obj) => {
    const text = textOf(patch)
    const entry = seen.get(text)
    if (entry) entry.count++
    else seen.set(text, { patch, count: 1, bytes: utf8Bytes(text) })
    for (const child of Object.values(nestedPatches(patch) ?? {})) count(child)
  }
  for (const row of legacy.rows) {
    for (const child of Object.values(nestedPatches(row) ?? {})) count(child)
    if (isObject(row.values)) for (const cell of Object.values(row.values)) count(cell as Obj)
  }
  // The most used patches get the shortest indexes.
  let pool = [...seen.entries()].filter(([, entry]) => entry.count > 1)
    .sort(([, a], [, b]) => b.count - a.count || b.bytes - a.bytes)
  let result: PooledSheet<T> | undefined
  // A pooled patch hides the patches nested in it, so their uses drop; drop the entries that no longer pay and index again.
  for (let pass = 0; pool.length && pass < 8; pass++) {
    const indexOf = new Map(pool.map(([text], index) => [text, index]))
    const uses = pool.map(() => 0)
    const reference = (patch: Obj): Obj | number => {
      const index = indexOf.get(textOf(patch))
      if (index === undefined) return withNestedReferences(patch)
      uses[index]++
      return index
    }
    const withNestedReferences = (patch: Obj): Obj => {
      const nested = nestedPatches(patch)
      return nested ? { ...patch, [META]: { ...(patch[META] as Meta), n: mapValues(nested, child => reference(child as Obj)) } } : patch
    }
    result = {
      ...legacy,
      meta: { ...(legacy as { meta?: Obj }).meta, cellEncoding: POOLED_SHEET_CELL_ENCODING },
      patchPool: pool.map(([, entry]) => entry.patch),
      rows: legacy.rows.map(row => {
        const patch = withNestedReferences(row)
        return isObject(row.values) ? { ...patch, values: mapValues(row.values, cell => reference(cell as Obj)) } : patch
      }),
    }
    // An entry pays when what its uses save (its bytes less the index's digits, each) exceeds its own bytes and comma.
    const paying = pool.filter(([, entry], index) => uses[index] * (entry.bytes - String(index).length) > entry.bytes + 1)
    if (paying.length === pool.length) break
    pool = paying
  }
  return result
}

/** The `encodeSheetCells` form of a pooled sheet: every reference replaced by its pooled patch, checked first. */
function expandPooledPatches(encoded: SheetLike & { patchPool?: unknown }): SheetLike {
  const refuse = (why: string): never => { throw new Error(`The sheet response could not be read: ${why}.`) }
  const pool = encoded.patchPool
  if (!Array.isArray(pool) || !Array.isArray(encoded.rows) || !isObject(encoded.cellBase) || !isObject(encoded.rowBase)) {
    return refuse('the pooled form is incomplete')
  }
  const strings = (value: unknown) => value === undefined || (Array.isArray(value) && value.every(key => typeof key === 'string'))
  /** `references`: whether this place may hold an index (a pooled patch itself may not, so no reference can loop). */
  const expand = (patch: unknown, references: boolean, open: Set<object>): Obj => {
    if (typeof patch === 'number') {
      if (!references) return refuse('a pooled patch refers to another one')
      if (!Number.isSafeInteger(patch) || patch < 0 || Object.is(patch, -0) || patch >= pool.length) return refuse(`no pooled patch ${patch}`)
      return pool[patch] as Obj
    }
    if (!isObject(patch)) return refuse('a patch is not an object')
    if (open.has(patch)) return refuse('a patch contains itself')
    const meta = patch[META]
    if (meta === undefined) return patch
    if (!isObject(meta)) return refuse('a patch marker is not an object')
    if (Object.hasOwn(meta, 'v')) return patch
    if (!strings(meta.u) || !strings(meta.o)) return refuse('a patch lists keys that are not text')
    if (meta.n === undefined) return patch
    if (!isObject(meta.n)) return refuse('a nested patch list is not an object')
    open.add(patch)
    try {
      return { ...patch, [META]: { ...meta, n: mapValues(meta.n, child => expand(child, references, open)) } }
    } finally { open.delete(patch) }
  }
  // Every pooled patch is checked before any reference to it is followed.
  for (const patch of pool) expand(patch, false, new Set())
  const rows = encoded.rows.map((row: unknown) => {
    // A row is never pooled: only cells and nested patches are.
    if (typeof row === 'number') return refuse('a row is a reference')
    const patch = expand(row, true, new Set())
    if (Object.hasOwn((patch[META] ?? {}) as Obj, 'v') || patch.values === undefined) return patch
    if (!isObject(patch.values)) return refuse('a row\'s cells are not an object')
    return { ...patch, values: mapValues(patch.values, cell => expand(cell, true, new Set())) }
  })
  const { patchPool: _pool, ...rest } = encoded
  return { ...rest, meta: { ...encoded.meta, cellEncoding: SHEET_CELL_ENCODING }, rows }
}

/**
 * The sheet exactly as it was before `encodeSheetCells` or `encodePooledSheetCells`. A sheet that was not encoded (an
 * older API, or a reader that did not ask) is returned as it is. A pooled sheet whose references do not resolve is
 * refused with an error, never read as something else.
 */
export function decodeSheetCells<T>(sheet: T): T {
  let encoded = sheet as SheetLike
  if (encoded?.meta?.cellEncoding === POOLED_SHEET_CELL_ENCODING) encoded = expandPooledPatches(encoded)
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
