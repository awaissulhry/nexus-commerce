import type { StudioPublishIssue, StudioPublishResult, StudioPublishReview, StudioPublishScope, StudioPublishSelection } from '@nexus/shared/studio-publication'
import type { PublishPlan } from '@nexus/shared/publish-plan'

/**
 * The markets the dialog can publish to, as any surface describes them (the studio's `MarketplaceLite` fits). Kept
 * structural so the shared dialog never imports a studio type.
 */
export interface PublicationMarket {
  id?: string
  channel: string
  code: string
  name: string
  connected?: boolean
  accounts?: Array<{ id: string; label: string }>
}

/** One place the dialog can publish to: a market of a channel on one connected account (and, rarely, one listing). */
export interface PublicationDestinationOption {
  key: string
  scope: StudioPublishScope
  /** "Amazon Italy · Xavia Racing" — the old one-line label. */
  label: string
  /** The market's own name ("Amazon Italy"). */
  marketName: string
  accountLabel: string
}

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

export function publicationDestinations(markets: PublicationMarket[], current?: StudioPublishScope): PublicationDestinationOption[] {
  const options = markets.filter(m => m.connected !== false).flatMap(m => (m.accounts ?? []).map(a => {
    const scope: StudioPublishScope = { channel: m.channel, marketplace: m.code, accountId: a.id,
      ...(current?.channel === m.channel && current.marketplace === m.code && current.accountId === a.id && current.listingId ? { listingId: current.listingId } : {}) }
    return { key: publicationScopeKey(scope), scope, label: `${m.name} · ${a.label}${scope.listingId ? ' · Selected listing' : ''}`, marketName: m.name, accountLabel: a.label }
  }))
  return [...new Map(options.map(option => [option.key, option])).values()]
}
export function matchesPublicationReview(value: unknown, productId: string, scope: StudioPublishScope): value is StudioPublishReview {
  const review = value as StudioPublishReview | null
  return !!review && review.productId === productId && !!review.scope && publicationScopeKey(review.scope) === publicationScopeKey(scope)
    && Array.isArray(review.rows) && Array.isArray(review.issues) && typeof review.expiresAt === 'string'
    && (review.id === null || typeof review.id === 'string')
}

/**
 * Build shape v2 (P10) — the Publish window reads ONE destination per plan request: the answer must be for this product
 * and exactly this destination, and its content review (when there is one) must pass the review guard above. A plan
 * from an older server, or for another destination, is refused rather than shown.
 */
export function matchesPublishPlan(value: unknown, productId: string, scope: StudioPublishScope): value is PublishPlan {
  const plan = value as PublishPlan | null
  if (!plan || plan.productId !== productId || typeof plan.familySku !== 'string' || typeof plan.canDelete !== 'boolean'
    || !Array.isArray(plan.destinations) || plan.destinations.length !== 1) return false
  const destination = plan.destinations[0]
  return !!destination?.scope && publicationScopeKey(destination.scope) === publicationScopeKey(scope)
    && Array.isArray(destination.lifecycle) && Array.isArray(destination.outgrown) && Array.isArray(destination.contentHeld)
    && (destination.review === null || matchesPublicationReview(destination.review, productId, scope))
}

/** One row of the review's problem table: the SKU (or the whole listing) and what to fix, with the channel's own words. */
export interface PublicationProblemRow { id: string; sku: string; message: string; detail?: string }

/**
 * Audit D4 (2026-10-01) — the review's issues as ONE table of problems (SKU · what to fix) and a list of notes. A problem
 * that names no SKU is about the whole listing. A message that already starts with its SKU does not repeat it.
 */
export function publicationProblems(issues: readonly StudioPublishIssue[]): { problems: PublicationProblemRow[]; notes: string[] } {
  const text = (issue: StudioPublishIssue) => issue.sku && issue.message.startsWith(`${issue.sku}: `) ? issue.message.slice(issue.sku.length + 2) : issue.message
  const problems = issues.filter(issue => issue.severity === 'error')
    .map((issue, index) => ({ id: `${index}`, sku: issue.sku ?? 'Whole listing', message: text(issue), ...(issue.detail ? { detail: issue.detail } : {}) }))
  const notes = [...new Set(issues.filter(issue => issue.severity === 'warning').map(issue => issue.sku ? `${issue.sku}: ${text(issue)}` : issue.message))]
  return { problems, notes }
}
