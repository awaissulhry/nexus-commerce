import type { StudioPublishResult, StudioPublishReview, StudioPublishScope } from '@nexus/shared/studio-publication'
import type { MarketplaceLite } from '../types'

export const publicationScopeKey = (scope: StudioPublishScope) => JSON.stringify([scope.channel, scope.marketplace, scope.accountId, scope.listingId ?? null])

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
