/** Lossless readiness details for readers that ask for details=compact. */
export const READINESS_DETAIL_ENCODING = 'readiness-details-v1'
type Obj = Record<string, unknown>
type Pair = [number, number]
type Group = [number, number, number]
interface Tables { products: string[]; details: Obj[]; lists: number[][]; states: Obj[]; groups: Group[] }
const SECTIONS = ['scopes', 'matrix'] as const
const DETAIL_FIELDS = ['missing', 'optionalMissing'] as const
const own = (value: Obj, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const enumerable = (value: Obj, key: string) => Object.prototype.propertyIsEnumerable.call(value, key)
const object = (value: unknown): value is Obj => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return (prototype === Object.prototype || prototype === null) && typeof (value as Obj).toJSON !== 'function'
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
function pool<T>(values: T[]) {
  const indexes = new Map<string, number>()
  return (value: T) => {
    const key = JSON.stringify(value)
    let index = indexes.get(key)
    if (index === undefined) { index = values.length; indexes.set(key, index); values.push(value) }
    return index
  }
}

/** No readiness verdict is recomputed. Invalid/unrecognized original fields remain literal. */
export function encodeReadiness(value: unknown): unknown {
  if (!object(value) || own(value, 'detailEncoding') || own(value, 'detailTables')) return value
  const tables: Tables = { products: [], details: [], lists: [], states: [], groups: [] }
  const product = pool(tables.products), detail = pool(tables.details), list = pool(tables.lists), state = pool(tables.states)
  const result: Obj = { ...value }
  const records = (items: Obj[]): Pair[] => {
    const runs: Pair[] = []
    let id: string | undefined, refs: number[] = []
    const finish = () => { if (id !== undefined) runs.push([product(id), list(refs)]) }
    for (const item of items) {
      if (item.productId !== id) { finish(); id = item.productId as string; refs = [] }
      // Overwrite in place in the copied object: productId keeps its original key position.
      refs.push(detail({ ...item, productId: null }))
    }
    finish()
    return runs
  }
  SECTIONS.forEach((section, sectionIndex) => {
    const entries = value[section]
    if (!enumerable(value, section) || !Array.isArray(entries)) return
    result[section] = entries.map((entry, index) => {
      if (!object(entry)) return entry
      const packed: Obj = { ...entry }
      let flags = 0
      DETAIL_FIELDS.forEach((field, bit) => {
        const items = entry[field]
        if (enumerable(entry, field) && Array.isArray(items) && items.every(item => object(item) && enumerable(item, 'productId') && typeof item.productId === 'string')) {
          packed[field] = records(items)
          flags |= 1 << bit
        }
      })
      if (enumerable(entry, 'byProduct') && object(entry.byProduct) && Object.values(entry.byProduct).every(object)) {
        packed.byProduct = Object.entries(entry.byProduct).map(([id, verdict]) => [product(id), state(verdict as Obj)])
        flags |= 4
      }
      if (flags) tables.groups.push([sectionIndex, index, flags])
      return flags ? packed : entry
    })
  })
  if (!tables.groups.length) return value
  result.detailEncoding = READINESS_DETAIL_ENCODING
  result.detailTables = tables
  // The replacement introduces ASCII references and never adds copies of original Unicode text.
  return JSON.stringify(result).length < JSON.stringify(value).length ? result : value
}

const invalid = (): never => { throw new Error('The readiness detail response could not be decoded.') }
const indexIn = (value: unknown, values: readonly unknown[]): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) < values.length
const pair = (value: unknown, left: readonly unknown[], right: readonly unknown[]): Pair => {
  if (!Array.isArray(value) || value.length !== 2 || !indexIn(value[0], left) || !indexIn(value[1], right)) return invalid()
  return value as Pair
}

/** Plain responses from older APIs pass through. Every pooled decoded value owns its nested data. */
export function decodeReadiness(value: unknown): unknown {
  if (!object(value) || !own(value, 'detailEncoding')) return value
  if (value.detailEncoding !== READINESS_DETAIL_ENCODING) throw new Error('The readiness detail format is not supported.')
  const raw = value.detailTables
  if (!object(raw) || !Array.isArray(raw.products) || !raw.products.every(id => typeof id === 'string') || new Set(raw.products).size !== raw.products.length ||
      !Array.isArray(raw.details) || !raw.details.every(item => object(item) && own(item, 'productId') && item.productId === null) ||
      !Array.isArray(raw.lists) || !raw.lists.every(items => Array.isArray(items) && items.every(index => indexIn(index, raw.details as unknown[]))) ||
      !Array.isArray(raw.states) || !raw.states.every(object) || !Array.isArray(raw.groups)) return invalid()
  const tables = raw as unknown as Tables
  const result: Obj = { ...value }
  SECTIONS.forEach(section => { if (Array.isArray(value[section])) result[section] = (value[section] as unknown[]).map(entry => object(entry) ? { ...entry } : entry) })
  const targets = new Set<string>()
  for (const target of tables.groups) {
    if (!Array.isArray(target) || target.length !== 3) return invalid()
    const [sectionIndex, entryIndex, flags] = target
    if (!indexIn(sectionIndex, SECTIONS) || !Number.isInteger(flags) || flags < 1 || flags > 7) return invalid()
    const entries = result[SECTIONS[sectionIndex]]
    if (!Array.isArray(entries) || !indexIn(entryIndex, entries) || !object(entries[entryIndex])) return invalid()
    const key = `${sectionIndex}:${entryIndex}`
    if (targets.has(key)) return invalid()
    targets.add(key)
    const entry = entries[entryIndex] as Obj
    DETAIL_FIELDS.forEach((field, bit) => {
      if (!(flags & (1 << bit))) return
      const runs = entry[field]
      if (!Array.isArray(runs)) return invalid()
      entry[field] = runs.flatMap(run => {
        const [productIndex, listIndex] = pair(run, tables.products, tables.lists)
        return tables.lists[listIndex].map(detailIndex => ({ ...copy(tables.details[detailIndex]), productId: tables.products[productIndex] }))
      })
    })
    if (flags & 4) {
      if (!Array.isArray(entry.byProduct)) return invalid()
      const seen = new Set<string>()
      entry.byProduct = Object.fromEntries(entry.byProduct.map(row => {
        const [productIndex, stateIndex] = pair(row, tables.products, tables.states)
        const id = tables.products[productIndex]
        if (seen.has(id)) return invalid()
        seen.add(id)
        return [id, copy(tables.states[stateIndex])]
      }))
    }
  }
  delete result.detailEncoding
  delete result.detailTables
  return result
}
