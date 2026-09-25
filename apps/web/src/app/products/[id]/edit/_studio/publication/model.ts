import type { StudioPublishResult, StudioPublishReview, StudioPublishScope, StudioPublishSelection } from '@nexus/shared/studio-publication'
import type { MarketplaceLite } from '../types'

export const publicationScopeKey = (scope: StudioPublishScope) => JSON.stringify([scope.channel, scope.marketplace, scope.accountId, scope.listingId ?? null])

/** Out-of-order selection responses cannot enable a different review or checkbox set. */
export function matchesPublicationSelection(value: unknown, review: StudioPublishReview | null, selectedIds: string[]): value is StudioPublishSelection {
  const selection = value as StudioPublishSelection | null
  if (!review?.id || !review.changes || !selection || selection.reviewId !== review.id || typeof selection.token !== 'string' || !selection.token
    || !Array.isArray(selection.selectedIds) || new Set(selection.selectedIds).size !== selection.selectedIds.length
    || selection.selectedIds.length !== selectedIds.length || new Set(selectedIds).size !== selectedIds.length
    || selection.selectedIds.some(id => !selectedIds.includes(id) || !review.changes!.some(c => c.id === id && c.selectable))
    || selection.fieldCount !== selectedIds.length || !Array.isArray(selection.products)
    || selection.products.some(p => !p || typeof p.sku !== 'string' || !review.rows.some(r => r.productId === p.productId))
    || new Set(selection.products.map(p => p.productId)).size !== selection.products.length
    || !selection.payload || !['json', 'xml'].includes(selection.payload.format) || typeof selection.payload.content !== 'string') return false
  if (selectedIds.length && (!selection.products.length || !selection.payload.content.trim()
    || review.changes.filter(c => selectedIds.includes(c.id)).some(c => !selection.products.some(p => p.productId === c.productId && p.sku === c.sku)))) return false
  if (!selectedIds.length && (selection.products.length > 0 || selection.payload.content.trim())) return false
  return true
}

/** A tick belongs to one durable review; refreshing or changing destination needs a new tick. */
export function publicationOverwriteAcknowledged(review: StudioPublishReview | null, confirmedReviewId: string | null): boolean {
  if (!review) return false
  if (!review.rows.some(row => row.existing) && !review.overwrite?.requiresConfirmation) return true
  return !!review.id && review.overwrite?.requiresConfirmation === true && confirmedReviewId === review.id
}

/** A status read without durable provider results cannot erase a receipt already received by this dialog. */
export function retainPublicationReceipt(previous: StudioPublishResult | null, next: StudioPublishResult): StudioPublishResult {
  if (!previous || previous.id !== next.id || next.results.length) return next
  const references = [...new Set(previous.results.map(row => row.reference).filter(Boolean))]
  if (!references.length) return next
  return { ...next, results: previous.results, warnings: [...new Set([...(previous.warnings ?? []), ...(next.warnings ?? [])])],
    message: `${next.message} Previously received channel reference: ${references.join(', ')}.` }
}

export function publicationDestinations(markets: MarketplaceLite[], current?: StudioPublishScope) {
  const options = markets.filter(m => m.connected !== false).flatMap(m => (m.accounts ?? []).map(a => {
    const scope: StudioPublishScope = { channel: m.channel, marketplace: m.code, accountId: a.id,
      ...(current?.channel === m.channel && current.marketplace === m.code && current.accountId === a.id && current.listingId ? { listingId: current.listingId } : {}) }
    return { key: publicationScopeKey(scope), scope, label: `${m.name} · ${a.label}${scope.listingId ? ' · Selected listing' : ''}` }
  }))
  return [...new Map(options.map(option => [option.key, option])).values()]
}
export function matchesPublicationReview(value: unknown, productId: string, scope: StudioPublishScope): value is StudioPublishReview {
  const review = value as StudioPublishReview | null
  return !!review && review.productId === productId && !!review.scope && publicationScopeKey(review.scope) === publicationScopeKey(scope)
    && Array.isArray(review.rows) && Array.isArray(review.issues) && typeof review.expiresAt === 'string'
    && (review.id === null || typeof review.id === 'string')
}
