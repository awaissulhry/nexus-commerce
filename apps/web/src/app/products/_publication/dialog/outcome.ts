/**
 * Sheet publish parity, step 2 (item 1) — what the studio says when a publication settles by itself.
 *
 * The server's result sweep settles a publication without a click and announces `publication.status_changed` on the
 * listing bus; `use-listing-events` puts it on the invalidation channel. These pure rules turn that event, the
 * destination's status read (`GET …/studio/publication-status`) and a dialog's result into the words the open
 * dialog, the sheet's toolbar mark and the one toast use — so the three never disagree. Every status word comes
 * from the design system's one vocabulary (`publicationStatusMeta`).
 */
import type { StudioPublicationStatus, StudioPublishResult } from '@nexus/shared/studio-publication'
import { publicationStatusMeta, publishFullTime } from '@/design-system/grid/renderers/publishStatus'
import type { SheetStatus } from '@/design-system/grid/toolbars/SheetStatus'
import type { Tone } from '@/design-system/primitives/tone'
import { channelLabel, channelPlace } from '@nexus/shared/channel-label'

/** The payload of `publication.status_changed`, as the invalidation channel carries it in `meta`. */
export interface PublicationStatusEvent {
  publicationId: string
  productId: string
  channel: string
  marketplace: string
  accountId: string
  aliasKey: string
  status: string
  terminal: boolean
  /** Set when the publication is one destination of a batch (step 5): the dialog that started the batch listens for it. */
  batchId?: string
}

export interface PublicationDestination {
  /** The studio product and its family root: the event names the family. */
  productIds: readonly string[]
  channel: string
  marketplace: string
  accountId: string
  aliasKey: string
}

export interface PublicationCounts {
  products: number
  accepted: number
  verified: number
  failed: number
  submitted: number
  needsCheck: boolean
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0)

/** Read a `publication.status_changed` invalidation; anything malformed is not ours. */
export function publicationEventOf(event: { id?: string; meta?: Record<string, unknown> } | null | undefined): PublicationStatusEvent | null {
  const meta = event?.meta
  if (!meta) return null
  const publicationId = text(meta.publicationId) || text(event?.id)
  const parsed = {
    publicationId, productId: text(meta.productId), channel: text(meta.channel), marketplace: text(meta.marketplace),
    accountId: text(meta.accountId), aliasKey: text(meta.aliasKey), status: text(meta.status), terminal: meta.terminal === true,
    ...(text(meta.batchId) ? { batchId: text(meta.batchId) } : {}),
  }
  return parsed.publicationId && parsed.productId && parsed.channel && parsed.marketplace && parsed.accountId && parsed.status ? parsed : null
}

/** The event is about this product family on this exact destination (channel, market, account and listing). */
export function publicationEventMatches(event: PublicationStatusEvent, destination: PublicationDestination): boolean {
  return destination.productIds.includes(event.productId) && event.channel === destination.channel
    && event.marketplace === destination.marketplace && event.accountId === destination.accountId
    && event.aliasKey === destination.aliasKey
}

/** "Amazon · IT", "Shopify" — the destination as every publish message names it (`channelPlace`: GLOBAL is the name alone). */
export function destinationLabel(channel: string, marketplace: string): string {
  return channelPlace(channel, marketplace)
}

/** The counts a stored `BulkOperation.summary` carries (step 1's `publicationSummary`). */
export function summaryCounts(summary: Record<string, unknown> | null | undefined): PublicationCounts | null {
  if (!summary || typeof summary !== 'object') return null
  return {
    products: count(summary.products), accepted: count(summary.accepted), verified: count(summary.verified),
    failed: count(summary.failed), submitted: count(summary.submitted), needsCheck: summary.needsCheck === true,
  }
}

/** The same counts from a result the dialog already holds. The server's per-SKU statuses never overlap. */
export function resultCounts(result: Pick<StudioPublishResult, 'results'>): PublicationCounts {
  const of = (status: string) => result.results.filter(row => row.status === status).length
  return { products: result.results.length, accepted: of('ACCEPTED'), verified: of('VERIFIED'), failed: of('FAILED'), submitted: of('SUBMITTED'), needsCheck: false }
}

const products = (n: number) => `${n} ${n === 1 ? 'product' : 'products'}`

/**
 * The one sentence for a publication that has settled — or that the channel never confirmed. `null` while it is
 * still on its way: nothing has happened that needs telling. Used by the toast and the dialog's announcement.
 */
export function publicationOutcome(status: string, counts: PublicationCounts | null, channel: string, marketplace: string): { message: string; tone: Tone } | null {
  const label = destinationLabel(channel, marketplace)
  const channelName = channelLabel(channel)
  const meta = publicationStatusMeta(status)
  const n = counts?.products ?? 0
  const ok = (counts?.accepted ?? 0) + (counts?.verified ?? 0)
  const failed = counts?.failed ?? 0
  switch (status) {
    case 'ACCEPTED':
    case 'VERIFIED':
      return { tone: meta.tone, message: n === 0 ? `${label} accepted the publish.` : n === 1 ? `${label} accepted the product.` : `${label} accepted all ${products(n)}.` }
    case 'PARTIAL':
    case 'FAILED':
      if (status === 'FAILED' && ok === 0) {
        return { tone: 'danger', message: failed > 0 && failed === n
          ? `${label} rejected ${n === 1 ? 'the product' : `all ${products(n)}`}. Nothing changed on ${channelName}.`
          : `${label} rejected the upload. Nothing changed on ${channelName}.` }
      }
      return { tone: meta.tone, message: n > 0
        ? `${label} accepted ${ok} of ${products(n)}. ${failed} ${failed === 1 ? 'was' : 'were'} rejected.`
        : `${label} rejected part of the publish.` }
    case 'UNVERIFIED':
      return { tone: 'warning', message: `Not confirmed — ${label} has not answered. It may have arrived. Check before you publish again.` }
    default:
      return null
  }
}

/**
 * The sheet's toolbar mark for one destination, from its status read. Shown only while a publication is on its way
 * or unconfirmed, or after the last one failed in whole or in part. A publication that went through needs no mark;
 * the toast told the person once.
 */
export function publicationMark(read: StudioPublicationStatus | null, channel: string, marketplace: string): SheetStatus | null {
  if (!read) return null
  const label = destinationLabel(channel, marketplace)
  const channelName = channelLabel(channel)
  const latest = read.latest
  const latestCounts = summaryCounts(latest?.summary)
  if (read.inFlight) {
    const status = read.inFlight.status
    const counts = latest?.publicationId === read.inFlight.publicationId ? latestCounts : null
    if (status === 'UNVERIFIED' || counts?.needsCheck) {
      return { tone: 'warning', label: `Result unknown on ${label}`,
        detail: counts?.needsCheck
          ? `${channelName} has not answered for 7 days. Nexus stopped asking. Check the listing on ${channelName} before you publish again.`
          : publicationStatusMeta('UNVERIFIED').hint }
    }
    const n = counts?.products ?? 0
    const what = n > 0 ? products(n) : 'the last publish'
    return { tone: 'info',
      label: status === 'PUBLISHING' ? `Sending ${what} to ${label}` : `${label} is processing ${what}`,
      detail: `${publicationStatusMeta(status).hint} Nexus checks ${channelName} by itself and tells you when it answers.` }
  }
  if (!latest || (latest.status !== 'FAILED' && latest.status !== 'PARTIAL')) return null
  const failed = latestCounts?.failed ?? 0
  const n = latestCounts?.products ?? 0
  const when = publishFullTime(latest.completedAt ?? latest.at)
  return { tone: 'danger',
    label: failed > 0 ? `${failed} rejected on ${label}` : `Last publish failed on ${label}`,
    detail: failed > 0 && n > 0
      ? `In the publish of ${when}, ${channelName} rejected ${failed} of ${products(n)}.`
      : `${channelName} rejected the publish of ${when}.` }
}

/** A dialog result is final when the vocabulary says so; UNVERIFIED stays open until someone checks. */
export function isSettled(status: string | null | undefined): boolean {
  return !!status && publicationStatusMeta(status).terminal
}

/**
 * Step 3 — the "N rejected on …" mark becomes the way to see those rows: pressing it filters the sheet to the rows the
 * channel rejected in the latest publish, pressing again shows every row. Only a rejection mark gets the action, and
 * only when some row on this sheet can be shown; otherwise the mark keeps reporting and nothing more.
 */
export const SHOW_REJECTED_ACTION = 'Show these rows'
export const SHOW_ALL_ACTION = 'Show all rows'

export function withRejectedFilter(mark: SheetStatus | null, rejectedRows: number, filterOn: boolean, toggle: () => void): SheetStatus | null {
  if (!mark || mark.tone !== 'danger' || rejectedRows < 1) return mark
  return { ...mark, onSelect: toggle, actionLabel: filterOn ? SHOW_ALL_ACTION : SHOW_REJECTED_ACTION, selected: filterOn }
}

/** The same filter in the sheet's ⋯ menu — a mark folded into "+N" cannot be pressed, so the menu offers it too. */
export function rejectedFilterMenuLabel(rejectedRows: number, filterOn: boolean, channel: string, marketplace: string): string {
  const label = destinationLabel(channel, marketplace)
  return filterOn ? 'Show all rows' : `Show the ${rejectedRows === 1 ? 'row' : `${rejectedRows} rows`} rejected on ${label}`
}
