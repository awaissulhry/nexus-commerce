import { isReferenceField, resolveReferenceValue } from '@nexus/shared/reference-values'
import { sheetValuesMatch, type SheetWriteRequest } from '@/design-system/grid/editors/sheetWriter'
import { loadReferenceChoices, isReferenceField as isPickerReference } from './referenceOptions'
import { loadEbayPolicies, policyLists } from './ebayPolicies'
import { wholeListWriteField } from './channel/provenance'

type RecoveryCell = { shopifyWrite?: import('@nexus/shared/shopify-information').ShopifySheetWrite; value: unknown; pinned?: boolean; follows?: boolean | null; writeTarget?: string; writeField?: string }
type RecoveryRow = { id: string; version: number; aliasId?: string | null; productType?: string | null; listing?: { id: string; version?: number } | null; values: Record<string, RecoveryCell> }
export type RecoveryScope = { channel: string; market: string; locale?: string; accountId?: string }

/** A recovery read must address the same product, alias, account, market and language as the write. */
export async function recoverSheetRow<T extends RecoveryRow>(body: unknown, request: SheetWriteRequest<T>, scope: RecoveryScope) {
  const page = body as { scope?: { kind?: string; channel?: string; marketplace?: string; locale?: string; connectionId?: string }; rows?: RecoveryRow[] } | null
  if (!request.row || !Array.isArray(page?.rows) || !page.scope) return null
  const channel = scope.channel !== 'MASTER'
  if (channel && (page.scope.channel !== scope.channel || page.scope.marketplace !== scope.market || scope.accountId && page.scope.connectionId !== scope.accountId)) return null
  if (!channel && page.scope.kind !== 'master') return null
  if (scope.locale && page.scope.locale !== scope.locale) return null
  const row = page.rows.find(row => row?.id === request.row!.id && (!channel || (row.aliasId ?? '') === (request.row!.aliasId ?? '')))
  if (!row?.values || typeof row.values !== 'object' || !Number.isSafeInteger(row.version)) return null
  if (channel && request.row.listing && (row.listing?.id !== request.row.listing.id || !Number.isSafeInteger(row.listing.version))) return null
  const values = Object.fromEntries(Object.entries(row.values).filter(([, cell]) => cell && Object.prototype.hasOwnProperty.call(cell, 'value')).map(([key, cell]) => [key, cell.value]))
  const matches: Record<string, boolean | null> = {}
  for (const cell of request.cells) {
    const stored = row.values[cell.colId]
    if (!stored || !Object.prototype.hasOwnProperty.call(stored, 'value')) { matches[cell.colId] = null; continue }
    const reset = cell.intent === 'reset' || cell.intent === 'reset-list'
    if (channel && reset && stored.writeTarget === 'channelListing') {
      const base = cell.intent === 'reset-list' ? wholeListWriteField(stored.writeField ?? cell.colId) : null
      const slots = base ? Object.values(row.values).filter(value => wholeListWriteField(value.writeField ?? '') === base) : [stored]
      matches[cell.colId] = slots.length > 0 && slots.every(value => value.pinned === false && value.follows !== false)
      if (matches[cell.colId] && stored.shopifyWrite && request.row.values[cell.colId]) request.row.values[cell.colId].shopifyWrite = stored.shopifyWrite
      continue
    }
    let equal = sheetValuesMatch(stored.value, cell.value)
    if (!equal && !reset && isReferenceField(cell.colId) && typeof cell.value === 'string') {
      try {
        const field = cell.colId
        const labels = isPickerReference(field)
          ? (await loadReferenceChoices(field, { market: scope.market, productType: row.productType, connectionId: page.scope.connectionId ?? scope.accountId }, true)).labels
          : Object.fromEntries((await loadEbayPolicies(scope.market, true, page.scope.connectionId ?? scope.accountId))[policyLists[field]].map(policy => [policy.id, policy.name]))
        equal = sheetValuesMatch(stored.value, resolveReferenceValue(field, cell.value, Object.entries(labels).map(([id, name]) => ({ id, name }))))
      } catch { matches[cell.colId] = null; continue }
    }
    matches[cell.colId] = equal && (cell.intent !== 'pin' || stored.pinned === true)
    if (matches[cell.colId] && stored.shopifyWrite && request.row.values[cell.colId]) request.row.values[cell.colId].shopifyWrite = stored.shopifyWrite
  }
  // Keep local typing visible. Only the concurrency metadata is refreshed here; the host performs
  // a quiet sheet refresh after recovery when no newer edits are queued.
  if (row.listing && request.row.listing && typeof row.listing.version === 'number' && row.listing.version > (request.row.listing.version ?? -1)) request.row.listing.version = row.listing.version
  return { values, matches, version: row.version, row: request.row }
}
