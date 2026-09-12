import { resolveBatch } from './mapping/resolve-batch.service.js'
import { channelValuePatch } from './channel-value-mutation.js'
import { CHANNEL_FIELD_MAP, FOLLOW_FLAG_FOR_COLUMN, channelOverrideKeys } from './channel-field-map.js'
import { readListValue } from './sheet-values.js'
import { storedChannelState } from './channel-value-mutation.js'
import type { SheetColumn } from './sheet-columns.service.js'

type Change = { id: string; field: string; value: unknown; reset?: boolean; slot?: number; target?: string }
/** Validate the same serialized candidate the resolver presents, before the ordinary writer commits. */
export async function informationChangeErrors(input: {
  channel: string; marketplace: string; accountId?: string | null; aliasKey?: string; locale?: string
  changes: Change[]; listings: Array<Record<string, any>>; columns: Map<string, Map<string, SheetColumn>>
}) {
  const coordinate = { channel: input.channel, marketplace: input.marketplace, channelConnectionId: input.accountId,
    aliasKey: input.aliasKey ?? '', locale: input.locale, productIds: [...new Set(input.changes.map(c => c.id))], includeCatalogue: false }
  const before = await resolveBatch(coordinate)
  const patches: Record<string, Record<string, unknown>> = {}
  const editedKeys = new Map<string, Set<string>>()
  for (const change of input.changes) {
    const key = change.field.replace(/^attr_/, '').replace(/^(amazon|ebay)_/, '').replace(/^name$/, 'title')
    const col = input.columns.get(change.id)?.get(key) ?? input.columns.get(change.id)?.get(key === 'title' ? 'name' : key)
    const store = col && Object.values(col.channels ?? {})[0]?.store
    const native = CHANNEL_FIELD_MAP[change.field]
    const target = store ?? (native ? { kind: 'listingColumn' as const, column: native, followFlag: FOLLOW_FLAG_FOR_COLUMN[native] } : undefined)
    const listing = patches[change.id] ?? input.listings.find(row => row.productId === change.id) ?? {}
    let value = change.value
    if (change.slot) {
      const cell = Object.values(before.products.find(p => p.productId === change.id)?.cells ?? {}).find(c => c.fieldKey === key || c.fieldKey === col?.key)
      const prior = storedChannelState(listing, target, channelOverrideKeys(change.field))
      const list = [...(readListValue(prior.state === 'stored' ? prior.value : cell?.value) ?? [])]
      while (list.length < change.slot) list.push('')
      list[change.slot - 1] = value ?? ''
      value = list
    }
    patches[change.id] = { ...listing, ...channelValuePatch(listing, target, channelOverrideKeys(change.field), change.reset ? 'INHERIT' : 'SET', value) }
    const keys = editedKeys.get(change.id) ?? new Set<string>()
    keys.add(key); if (col) keys.add(col.key)
    editedKeys.set(change.id, keys)
  }
  const after = await resolveBatch({ ...coordinate, listingChangesByProduct: patches })
  const errors: Array<{ id: string; field: string; error: string }> = []
  for (const product of after.products) {
    const changes = input.changes.filter(c => c.id === product.productId)
    // Category changes preserve old values; the newly applicable errors appear on reload.
    if (changes.every(c => /^(attr_)?(taxonomy_id|categoryId|productType)$/.test(c.field))) continue
    const previous = before.products.find(p => p.productId === product.productId)
    for (const cell of Object.values(product.cells)) {
      if (cell.value === null || cell.value === undefined || cell.value === '' || Array.isArray(cell.value) && cell.value.length === 0) continue
      for (const error of cell.errors) {
        const changed = editedKeys.get(product.productId)?.has(cell.fieldKey)
        if (!changed && previous?.cells[cell.fieldKey]?.errors.includes(error)) continue
        // Information saves incomplete language drafts; readiness still reports untranslated sources.
        if (/fallback|Translation into|content .*missing/i.test(error)) continue
        errors.push({ id: product.productId, field: changes.find(c => editedKeys.get(product.productId)?.has(cell.fieldKey) && c.field.replace(/^attr_/, '') === cell.fieldKey)?.field ?? changes[0].field,
          error: `${cell.label}: ${error}` })
      }
    }
  }
  return [...new Map(errors.map(error => [JSON.stringify(error), error])).values()]
}
