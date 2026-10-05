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
import { optionListingLabel, type PublicationAlias } from './model'

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
 * still on its way: nothing has happened that needs telling. Used by the toast and the dialog's announcement. `place`:
 * the dialog's own name for the destination ("eBay · IT · ① Racing edition" on a listing alias), else "eBay · IT".
 */
export function publicationOutcome(status: string, counts: PublicationCounts | null, channel: string, marketplace: string, place?: string | null): { message: string; tone: Tone } | null {
  const label = place || destinationLabel(channel, marketplace)
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
 * the toast told the person once. `place`: the listing's own name ("eBay · IT · ① Racing edition"), else "eBay · IT".
 */
export function publicationMark(read: StudioPublicationStatus | null, channel: string, marketplace: string, place?: string | null): SheetStatus | null {
  if (!read) return null
  const label = place || destinationLabel(channel, marketplace)
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

// ── Aliases (Owner 2026-10-05): every listing of the sheet's destination ───────────────────────────────────────────

/** A listing alias the sheet watches: its id (the event's `aliasKey`), name and place (`listedAliases`). */
export type WatchedAlias = Pick<PublicationAlias, 'id' | 'label' | 'position'>

/**
 * The listings the sheet's toolbar mark and toast cover: the chosen listing alone, or — no listing chosen (`''`, the
 * main listing) — the main listing and every ACTIVE alias of the destination (the server reads only those).
 */
export function watchedListings(chosenAliasKey: string, aliases: readonly WatchedAlias[]): string[] {
  return chosenAliasKey ? [chosenAliasKey] : ['', ...new Set(aliases.map(alias => alias.id).filter(Boolean))]
}

/**
 * One listing's place in the mark and the toast, as the Publish window names it: "eBay · IT" when the destination has
 * no aliases; else "eBay · IT · ★ Primary" (the main listing) or "eBay · IT · ① Racing edition". An alias the read does
 * not name yet reads "eBay · IT · Other listing".
 */
export function listingPlace(channel: string, marketplace: string, aliasKey: string, aliases: readonly WatchedAlias[]): string {
  const place = destinationLabel(channel, marketplace)
  const alias = aliasKey ? aliases.find(a => a.id === aliasKey) : null
  if (aliasKey && !alias) return `${place} · Other listing`
  const listing = optionListingLabel({ scope: { channel, marketplace, accountId: '', ...(aliasKey ? { listingId: aliasKey } : {}) }, alias: alias ?? null, listings: 1 + aliases.length })
  return listing ? `${place} · ${listing}` : place
}

const MARK_RANK: Record<SheetStatus['tone'], number> = { danger: 3, warning: 2, info: 1, neutral: 0 }
const readTime = (read: StudioPublicationStatus | null) => {
  const at = Date.parse(read?.latest?.completedAt ?? read?.latest?.at ?? '')
  return Number.isFinite(at) ? at : 0
}

/**
 * The ONE toolbar mark over every listing the sheet watches: the worst (a rejection, then a result nobody confirmed,
 * then a publish on its way), the newest of equals. Each listing's mark names its listing; the other listings that also
 * have a mark are named in its detail ("Also: Sending 3 products to eBay · IT · ① Racing edition."), never dropped.
 */
export function combinedPublicationMark(listings: ReadonlyArray<{ read: StudioPublicationStatus | null; place: string }>, channel: string, marketplace: string): SheetStatus | null {
  const marks = listings.flatMap(listing => {
    const mark = publicationMark(listing.read, channel, marketplace, listing.place)
    return mark ? [{ mark, at: readTime(listing.read) }] : []
  }).sort((a, b) => MARK_RANK[b.mark.tone] - MARK_RANK[a.mark.tone] || b.at - a.at)
  if (!marks.length) return null
  const [first, ...others] = marks
  if (!others.length) return first.mark
  const also = `Also: ${others.map(o => o.mark.label).join('; ')}.`
  return { ...first.mark, detail: first.mark.detail ? `${first.mark.detail.replace(/\s+$/, '')} ${also}` : also }
}

/**
 * Which watched listing a `publication.status_changed` event is about: its alias key ('' = the main listing), or null
 * when it is about another family, destination or (a listing chosen) another listing. `known: false` — no listing is
 * chosen and the event names an alias of this destination the sheet has not read yet: read the aliases again.
 */
export function eventListing(event: PublicationStatusEvent, destination: PublicationDestination, listings: readonly string[]): { aliasKey: string; known: boolean } | null {
  if (!publicationEventMatches(event, { ...destination, aliasKey: event.aliasKey })) return null
  if (listings.includes(event.aliasKey)) return { aliasKey: event.aliasKey, known: true }
  return destination.aliasKey === '' && event.aliasKey ? { aliasKey: event.aliasKey, known: false } : null
}
