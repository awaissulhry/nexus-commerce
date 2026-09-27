import { isPhotoChangeId, type StudioPublishChange, type StudioPublishResult, type StudioPublishReview } from '@nexus/shared/studio-publication'

import type { MediaDestinationRow } from './model'

/**
 * Images rebuild P4c — "Review & publish photos" (PLAN.md §5.6), pure: what each destination would receive, and what it
 * answered. Only photos are sent: eBay through the studio publication review with its photo fields selected (the gallery,
 * the colour sets), Amazon through its image run (image attributes only). Titles, prices and stock are never selected.
 */

export interface EbaySend { channel: 'EBAY'; reviewId: string; selectedIds: string[] }
export interface AmazonSend { channel: 'AMAZON'; path: string; runId: string; revision: string }

export type PhotoCheck =
  | { kind: 'checking' }
  /** This window cannot send here (Shopify sends whole products; Etsy is a later step; a paused account). */
  | { kind: 'unsupported'; reason: string }
  /** Something must be fixed first — the channel's or Nexus's own sentence. */
  | { kind: 'blocked'; reason: string }
  /** The channel already shows these photos. */
  | { kind: 'same'; summary: string }
  | { kind: 'ready'; summary: string; send: EbaySend | AmazonSend; note?: string }

/** Why this window does not send to a destination, or null when it can. */
export function unsupportedReason(d: Pick<MediaDestinationRow, 'channel' | 'targetable' | 'refusal' | 'accountActive'>): string | null {
  if (!d.targetable) return d.refusal ?? 'This destination cannot receive photos.'
  if (!d.accountActive) return 'This account is paused. Reconnect it before publishing.'
  if (d.channel === 'SHOPIFY') return 'Shopify sends the whole product: its photos go with the next Shopify publish.'
  if (d.channel === 'ETSY') return 'Publishing to Etsy comes in a later step.'
  return null
}

const FIELD_LABEL: Record<string, string> = { pictures: 'Gallery', Pictures: 'Colour sets', variationPictures: 'Colour sets' }
const fieldOf = (change: StudioPublishChange) => FIELD_LABEL[change.field] ?? change.label

/** An eBay listing's photo rows from its change review: the gallery and the colour sets, each same / replaced / refused. */
export function ebayCheck(review: StudioPublishReview): PhotoCheck {
  if (!review.id) return { kind: 'blocked', reason: review.issues.find(i => i.severity === 'error')?.message ?? 'The eBay review could not be completed. Refresh it.' }
  const photos = (review.changes ?? []).filter(c => isPhotoChangeId(c.id))
  if (!photos.length) return { kind: 'blocked', reason: 'This eBay listing has no photos to compare. Refresh the review.' }
  const differ = photos.filter(c => c.status !== 'SAME')
  if (!differ.length) return { kind: 'same', summary: 'eBay already shows these photos.' }
  const send = differ.filter(c => c.selectable)
  if (!send.length) return { kind: 'blocked', reason: differ.map(c => c.reason).filter(Boolean).join(' ') || 'The photo change cannot be sent.' }
  const summary = photos.map(c => `${fieldOf(c)}: ${c.status === 'SAME' ? 'same on eBay' : c.selectable ? 'will be replaced' : `not sent — ${c.reason}`}`).join(' · ')
  return { kind: 'ready', summary, send: { channel: 'EBAY', reviewId: review.id, selectedIds: send.map(c => c.id) },
    ...(review.photosOnly ? { note: 'Other fields of this listing have problems; only photos are sent.' } : {}) }
}

export interface AmazonRunLike {
  id: string; status: string; revision: string
  items: Array<{ sku: string; changes: Array<{ slot: string }>; issues: string[] }>
  receipts: Array<{ listingId: string; status: string; message?: string }>
}

/** An Amazon image run once reviewed: how many SKUs and photo slots change, or why it cannot be sent. */
export function amazonCheck(run: AmazonRunLike, path: string): PhotoCheck {
  if (run.status === 'REVIEW_QUEUED' || run.status === 'REVIEWING') return { kind: 'checking' }
  const problems = run.items.flatMap(i => i.issues.map(issue => `${i.sku}: ${issue}`))
  if (run.status === 'REVIEW_FAILED' || problems.length) return { kind: 'blocked', reason: problems.slice(0, 3).join(' ') + (problems.length > 3 ? ` (+${problems.length - 3} more)` : '') || 'Amazon could not check these photos.' }
  if (run.status !== 'REVIEW') return { kind: 'blocked', reason: 'An earlier Amazon photo run is still open. Finish it on the Amazon photo page first.' }
  const changed = run.items.filter(i => i.changes.length)
  if (!changed.length) return { kind: 'same', summary: 'Amazon already shows these photos.' }
  const slots = changed.reduce((n, i) => n + i.changes.length, 0)
  return { kind: 'ready', summary: `${changed.length} SKU${changed.length === 1 ? '' : 's'} · ${slots} photo slot${slots === 1 ? '' : 's'} change`,
    send: { channel: 'AMAZON', path, runId: run.id, revision: run.revision } }
}

export type PhotoOutcome = { tone: 'success' | 'info' | 'danger'; text: string; final: boolean }

export function ebayOutcome(result: StudioPublishResult): PhotoOutcome {
  if (result.status === 'VERIFIED' || result.status === 'ACCEPTED') return { tone: 'success', text: 'Sent — eBay accepted it.', final: true }
  if (['UNVERIFIED', 'PUBLISHING', 'SUBMITTED'].includes(result.status)) return { tone: 'info', text: 'Sent — eBay\'s answer is still being checked.', final: false }
  const failed = result.results.filter(r => r.status === 'FAILED').map(r => r.message).filter(Boolean)
  return { tone: 'danger', text: failed[0] ?? result.message ?? 'eBay refused the photos.', final: true }
}

export function amazonOutcome(run: AmazonRunLike): PhotoOutcome {
  const count = (status: string) => run.receipts.filter(r => r.status === status).length
  if (run.status === 'COMPLETE') {
    const rejected = run.receipts.filter(r => r.status === 'REJECTED')
    return rejected.length ? { tone: 'danger', text: `${rejected.length} SKU${rejected.length === 1 ? '' : 's'} refused: ${rejected[0].message ?? 'Amazon gave no reason.'}`, final: true }
      : { tone: 'success', text: `Sent — Amazon accepted ${count('ACCEPTED')} SKU${count('ACCEPTED') === 1 ? '' : 's'}${count('UNCHANGED') ? ` (${count('UNCHANGED')} unchanged)` : ''}.`, final: true }
  }
  if (run.status === 'UNKNOWN') return { tone: 'danger', text: 'Amazon\'s answer is unknown. Check the Amazon photo page before sending again.', final: true }
  return { tone: 'info', text: `Sending to Amazon… ${count('ACCEPTED')} of ${run.receipts.length} accepted so far.`, final: false }
}
