import { contentSlots } from '../content-locale.js'
import type { SheetColumn, SheetColumnSet } from '../sheet-columns.service.js'
import { CHANNEL_FIELD_MAP, FOLLOW_FLAG_FOR_COLUMN, channelOverrideKeys } from '../channel-field-map.js'
import { CHANNEL_OVERRIDE_COLUMNS } from '../channel-inheritance.js'
import type { CellCoordinate } from './cell-formula.service.js'

type Bag = Record<string, any>
type Entry = { path: string[]; present: boolean; value: unknown }
export type FormulaStorage = { target: 'master' | 'channelListing'; writeField: string; entries: Entry[]; cascaded?: boolean }
const read = (row: Bag, path: string[]): Entry => {
  let value: any = row
  for (const key of path) {
    if (!value || !Object.prototype.hasOwnProperty.call(value, key)) return { path, present: false, value: null }
    value = value[key]
  }
  return { path, present: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) }
}

/** Capture only the storage locations the ordinary writer owns, including an entire list for a slot. */
export function formulaStorage(input: CellCoordinate, col: SheetColumn & { writeTarget: 'master' | 'channelListing' }, set: SheetColumnSet, product: Bag, listing: Bag | null): FormulaStorage {
  const writeField = col.writeField.replace(/\[\d+\]$/, '')
  if (col.writeTarget === 'master' && col.storage === 'localizedContent') {
    const locale = input.locale || 'it'
    const key = (col.slot?.of ?? writeField).replace(/^attr_/, '').replace(/^name$/, 'title')
    const source = { ...product, localizedContent: contentSlots(product) }
    return { target: 'master', writeField, entries: [read(source, ['localizedContent', locale, key]), read(source, ['localizedContent', locale, '_meta', key])] }
  }
  if (col.writeTarget === 'master') return { target: 'master', writeField,
    entries: [read(product, writeField.startsWith('attr_') ? ['categoryAttributes', writeField.slice(5)] : [writeField])],
    cascaded: (product.cascadedFields ?? []).includes(writeField) }
  const label = set.coordinates?.find(c => c.channel === input.channel && c.marketplace === input.marketplace)?.label
  const facts = label ? col.channels?.[label] : undefined
  const stripped = writeField.replace(/^(amazon_|ebay_|attr_)/, '')
  const mappedColumn = CHANNEL_FIELD_MAP[writeField]
  const store = mappedColumn ? { kind: 'listingColumn' as const, column: mappedColumn, followFlag: FOLLOW_FLAG_FOR_COLUMN[mappedColumn] } : facts?.store
  const paths: string[][] = channelOverrideKeys(writeField).map(key => ['overrideData', key])
  if (store) paths.push(['overrideData', writeField])
  if (store?.kind === 'platformAttributes') {
    paths.push(['platformAttributes', ...store.path])
    if (store.unitPath) paths.push(['platformAttributes', ...store.unitPath])
  } else if (store?.kind === 'listingColumn') {
    paths.push([store.column])
    if (CHANNEL_OVERRIDE_COLUMNS[store.column]) paths.push([CHANNEL_OVERRIDE_COLUMNS[store.column]])
    if (store.followFlag) paths.push([store.followFlag])

  }
  return { target: 'channelListing', writeField, entries: [...new Map(paths.map(path => [path.join('\0'), read(listing ?? {}, path)])).values()] }
}

/** Merge the captured field into the CURRENT record, preserving unrelated edits and JSON keys. */
export function formulaStoragePatch(storage: FormulaStorage, current: Bag): Bag {
  const patch: Bag = {}
  for (const entry of storage.entries) {
    const [column, ...path] = entry.path
    if (!path.length) { patch[column] = entry.value; continue }
    if (!Object.prototype.hasOwnProperty.call(patch, column)) patch[column] = JSON.parse(JSON.stringify(current[column] ?? {}))
    let bag = patch[column]
    for (const key of path.slice(0, -1)) {
      if (!bag[key] || typeof bag[key] !== 'object') bag[key] = {}
      bag = bag[key]
    }
    if (entry.present) bag[path[path.length - 1]] = entry.value
    else delete bag[path[path.length - 1]]
  }
  if (storage.target === 'master') {
    const fields: string[] = (current.cascadedFields ?? []).filter((key: string) => key !== storage.writeField)
    patch.cascadedFields = storage.cascaded ? [...fields, storage.writeField] : fields
  }
  return patch
}
