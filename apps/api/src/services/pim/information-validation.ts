import { resolveBatch } from './mapping/resolve-batch.service.js'
import { channelValuePatch } from './channel-value-mutation.js'
import { CHANNEL_FIELD_MAP, FOLLOW_FLAG_FOR_COLUMN, channelOverrideKeys } from './channel-field-map.js'
import { readListValue } from './sheet-values.js'
import { storedChannelState } from './channel-value-mutation.js'
import type { SheetColumn } from './sheet-columns.service.js'
import { cellFindings, editVerdict } from './value-verdict.js'

type Change = { id: string; field: string; value: unknown; reset?: boolean; slot?: number; target?: string }
/**
 * Validate the same serialized candidate the resolver presents, before the ordinary writer commits.
 *
 * P1 (`value-verdict.ts`) — the verdict, per CELL: a finding the field's type cannot hold refuses that change alone
 * (`errors`); every other finding (off-list, over a limit, required, the channel schema) is stored and comes back as a
 * warning with its exact reason. One bad cell never refuses another cell of the same product.
 */
export async function informationChangeErrors(input: {
  channel: string; marketplace: string; accountId?: string | null; aliasKey?: string; locale?: string
  changes: Change[]; listings: Array<Record<string, any>>; columns: Map<string, Map<string, SheetColumn>>
}) {
  const coordinate = { channel: input.channel, marketplace: input.marketplace, channelConnectionId: input.accountId,
    aliasKey: input.aliasKey ?? '', locale: input.locale, productIds: [...new Set(input.changes.map(c => c.id))], includeCatalogue: false }
  const before = await resolveBatch(coordinate)
  const patches: Record<string, Record<string, unknown>> = {}
  const editedKeys = new Map<string, Set<string>>()
  /** Every key each change edits (its field, its column, the channel's own key), so a cell names the change that wrote it. */
  const changeKeys: Array<{ change: Change; keys: Set<string> }> = []
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
    const own = new Set<string>([key, ...(col ? [col.key, Object.values(col.channels ?? {})[0]?.key].filter((k): k is string => !!k) : [])])
    changeKeys.push({ change, keys: own })
    editedKeys.set(change.id, new Set([...(editedKeys.get(change.id) ?? []), ...own]))
  }
  const after = await resolveBatch({ ...coordinate, listingChangesByProduct: patches })
  const errors: Array<{ id: string; field: string; error: string }> = []
  const warnings: Array<{ id: string; field: string; warning: string }> = []
  for (const product of after.products) {
    const changes = input.changes.filter(c => c.id === product.productId)
    // Category changes preserve old values; the newly applicable errors appear on reload.
    if (changes.every(c => /^(attr_)?(taxonomy_id|categoryId|productType)$/.test(c.field))) continue
    const previous = before.products.find(p => p.productId === product.productId)
    for (const cell of Object.values(product.cells)) {
      // The change that wrote this cell, by the keys it edits — never a guess: a finding on a cell no change of this save
      // wrote (a value derived from one) is that CELL's warning, under its own key, and is never a refusal.
      const writer = changeKeys.find(entry => entry.change.id === product.productId && entry.keys.has(cell.fieldKey))?.change
      const changed = !!writer
      // An empty cell this save did not write is not this save's business; one it cleared answers its warning
      // (a field the channel requires — stored empty, flagged, and blocked at publish).
      if (!changed && (cell.value === null || cell.value === undefined || cell.value === '' || Array.isArray(cell.value) && cell.value.length === 0)) continue
      const field = writer?.field ?? cell.fieldKey
      // One sentence per rule and cell: the resolver and the schema can both state one over-length value.
      const said = new Set<string>()
      for (const found of cellFindings(cell)) {
        if (said.has(found.rule)) continue
        said.add(found.rule)
        if (!changed && previous?.cells[cell.fieldKey]?.errors.includes(found.message)) continue
        // Information saves incomplete language drafts; readiness still reports untranslated sources.
        if (/fallback|Translation into|content .*missing/i.test(found.message)) continue
        // Only a cell this save wrote can be refused; a new problem on a cell derived from it is a warning.
        if (changed && editVerdict(found) === 'refuse') errors.push({ id: product.productId, field, error: `${cell.label}: ${found.message}` })
        else warnings.push({ id: product.productId, field, warning: `${cell.label}: ${found.message}` })
      }
    }
  }
  const unique = <T>(rows: T[]) => [...new Map(rows.map(row => [JSON.stringify(row), row])).values()]
  return { errors: unique(errors), warnings: unique(warnings) }
}
