import { CONTENT_COLUMNS, PRIMARY_CONTENT_LOCALE } from '../content-locale.js'
import { normalizeLanguage } from '../content-language.js'
import { isLocalizableContent, contentField, legacyPin, listingFollowsContent } from '../content-resolver.js'
import type { ContentAddress } from '@nexus/shared/content-language'
import type { SheetColumn, SheetColumnSet } from '../sheet-columns.service.js'
import { CHANNEL_FIELD_MAP, FOLLOW_FLAG_FOR_COLUMN, channelOverrideKeys } from '../channel-field-map.js'
import { CHANNEL_OVERRIDE_COLUMNS } from '../channel-inheritance.js'
import type { CellCoordinate } from './cell-formula.service.js'

type Bag = Record<string, any>
type Entry = { path: string[]; present: boolean; value: unknown }
export type FormulaStorage = { target: 'master' | 'channelListing'; writeField: string; entries: Entry[]; cascaded?: boolean; content?: { address: ContentAddress; values: Record<string, unknown>; reset: string[] } }
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
  const field = contentField(col.slot?.of ?? col.key)
  if (isLocalizableContent(field, col.storage)) {
    const language = normalizeLanguage(input.locale || PRIMARY_CONTENT_LOCALE)
    const address: ContentAddress = input.contentAddress ?? (col.writeTarget === 'channelListing'
      ? { tier: 'pin', language, coordinate: { channel: input.channel!, market: input.marketplace!, ...(input.channelConnectionId ? { accountId: input.channelConnectionId } : {}), ...(input.aliasKey ? { aliasId: input.aliasKey } : {}) } }
      : language === PRIMARY_CONTENT_LOCALE ? { tier: 'source' } : { tier: 'language', language })
    const row = address.tier === 'source' ? product : (address.tier === 'pin' ? listing?.translations : product.translations)?.find((row: Bag) => row.language === language)
    const column = CONTENT_COLUMNS[field as keyof typeof CONTENT_COLUMNS]
    const attrs = address.tier === 'source' ? row?.categoryAttributes : row?.attributes
    const own = Object.prototype.hasOwnProperty.call(attrs ?? {}, field)
    let value = own ? attrs[field] : column ? row?.[column] : undefined
    let authored = own || value != null && value !== '' && (!Array.isArray(value) || value.length > 0)
    if (address.tier === 'pin') {
      if (row?.follows?.includes(field)) authored = false
      else if (!authored && listing) {
        const languages = set.coordinates.find(c => c.channel === input.channel)?.languages ?? []
        if (languages.length && !listingFollowsContent(listing, field, language, languages)) {
          value = legacyPin(listing as any, field); authored = value != null
        }
      }
    }
    return { target: col.writeTarget, writeField, entries: [], content: { address, values: authored ? { [field]: value } : {}, reset: authored ? [] : [field] } }
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
  if (storage.content) return {}
  if (storage.entries.some(entry => entry.path[0] === 'localizedContent' || storage.target === 'channelListing' && ['title','description','titleOverride','descriptionOverride','bulletPointsOverride'].includes(entry.path[0]))) throw new Error(`${storage.writeField} has a legacy restore address. Restore it through the addressed sheet writer.`)
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
