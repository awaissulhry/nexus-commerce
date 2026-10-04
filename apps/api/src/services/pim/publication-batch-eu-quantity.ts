/**
 * Sheet publish parity, step 5 (item 3) — Amazon's ONE EU quantity, inside one publication batch.
 *
 * Amazon keeps one merchant-fulfilled quantity per SKU for all EU marketplaces (`amazon-eu-quantity-guard.ts`). A
 * listing Amazon already has never sends a quantity from the product sheet (price and stock have their own doors), but
 * a NEW listing does: its complete UPDATE message carries `fulfillment_availability`. A batch that creates the same SKU
 * in two EU markets with two different quantities would therefore overwrite Amazon's one number with whichever feed
 * Amazon processes last. The batch is refused before anything is sent, naming the SKU and the markets.
 *
 * Pure apart from `amazonSendOf`, which compiles a stored review's saved selection (no channel read).
 */
import { AMAZON_EU_SHARED_MARKETS, detectEuIntentConflict, EU_GUARD_REMEDY, type EuIntentRow } from '../amazon-eu-quantity-guard.js'
import { compileSelection, type PublicationChangePlan } from './studio-publication-selection.js'

export interface BatchAmazonMessage { sku: string; operationType?: string; attributes?: Record<string, unknown> }
export interface BatchAmazonSend { reviewId: string; marketplace: string; accountId: string; messages: BatchAmazonMessage[] }
export interface BatchEuConflict { sku: string; accountId: string; markets: string[]; detail: string }

/** PURE. The quantity a new-listing message sends, or null: a PATCH sends no quantity here. FBA is Amazon's own. */
export function createdQuantity(message: BatchAmazonMessage): { quantity: number; fba: boolean } | null {
  if (message.operationType !== 'UPDATE') return null
  const offers = message.attributes?.fulfillment_availability
  if (!Array.isArray(offers)) return null
  for (const offer of offers) {
    if (!offer || typeof offer !== 'object') continue
    const entry = offer as Record<string, unknown>
    const quantity = Number(entry.quantity)
    const code = String(entry.fulfillment_channel_code ?? 'DEFAULT')
    if (code.startsWith('AMAZON')) return { quantity: 0, fba: true }
    if (entry.quantity != null && Number.isFinite(quantity)) return { quantity, fba: false }
  }
  return null
}

/** PURE. Every SKU that two EU markets of one Amazon account would create with different quantities in this batch. */
export function batchEuQuantityConflicts(sends: BatchAmazonSend[]): BatchEuConflict[] {
  const rows = new Map<string, { sku: string; accountId: string; intents: EuIntentRow[] }>()
  for (const send of sends) {
    const marketplace = send.marketplace.toUpperCase()
    if (!AMAZON_EU_SHARED_MARKETS.has(marketplace)) continue
    for (const message of send.messages) {
      const created = createdQuantity(message)
      if (!created) continue
      const key = JSON.stringify([send.accountId, message.sku])
      const entry = rows.get(key) ?? { sku: message.sku, accountId: send.accountId, intents: [] }
      entry.intents.push({ marketplace, followMasterQuantity: false, quantityOverride: created.quantity, quantity: created.quantity, isFba: created.fba })
      rows.set(key, entry)
    }
  }
  const conflicts: BatchEuConflict[] = []
  for (const entry of rows.values()) {
    const verdict = detectEuIntentConflict(entry.intents)
    if (!verdict.conflict) continue
    conflicts.push({ sku: entry.sku, accountId: entry.accountId, markets: [...new Set(entry.intents.filter(i => !i.isFba).map(i => i.marketplace))].sort(), detail: verdict.detail })
  }
  return conflicts.sort((a, b) => a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0)
}

/** The refusal sentence for the batch, one line per SKU. */
export function euConflictMessage(conflicts: BatchEuConflict[]): string {
  const lines = conflicts.slice(0, 10).map(c => `${c.sku} (${c.markets.join(', ')}): ${c.detail}.`)
  const more = conflicts.length > 10 ? [`…and ${conflicts.length - 10} more SKUs.`] : []
  return [`These new Amazon listings would send different quantities to markets that share one EU quantity. Nothing was sent.`,
    ...lines, ...more, `Give these SKUs the same quantity in every EU market of this batch, or publish one market at a time. ${EU_GUARD_REMEDY}`].join('\n')
}

/** The Amazon messages a stored review would send with its saved selection — compiled from the saved plan, no channel read. */
export function amazonSendOf(reviewId: string, data: Record<string, any>): BatchAmazonSend | null {
  if (data?.scope?.channel !== 'AMAZON' || data.changeVersion !== 1 || !data.changePlan || !Array.isArray(data.selection?.selectedIds)) return null
  try {
    const compiled = compileSelection(data.changePlan as PublicationChangePlan, data.selection.selectedIds, reviewId)
    if (compiled.prepared?.kind !== 'amazon') return null
    return { reviewId, marketplace: String(data.scope.marketplace), accountId: String(data.scope.accountId), messages: compiled.prepared.feed.messages as BatchAmazonMessage[] }
  } catch {
    // A selection that no longer compiles is refused by the submit itself, with its own words.
    return null
  }
}
