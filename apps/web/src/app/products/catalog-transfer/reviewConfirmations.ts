import type { TransferJob } from './sourceMapping'

/**
 * CFI-4 / CFI-3 (R-CFI-1) — what the Owner confirms before a channel file is checked again.
 *
 * `links` maps a SKU as written in the file to the Nexus SKU it really is; `confirmDeletes` names the
 * SKUs whose delete rows the Owner SAW in the pending list and ticked — only those may mark a listing
 * ended in Nexus. Never "all": a delete revealed by a later check (for example behind a link) must
 * appear as pending with its evidence first. The page (or the product drawer) re-sends the SAME file
 * with these, and the server plans a new review.
 */
export interface Confirmations { links: Record<string, string>; confirmDeletes: string[] }
export type LinkProposal = NonNullable<TransferJob['links']>[number]
export const NO_CONFIRMATIONS: Confirmations = { links: {}, confirmDeletes: [] }

/** The one reason a proposal cannot be ticked. Shown next to it, never only in a tooltip. */
export const ONE_LISTING_AT_A_TIME = 'Confirm one listing at a time; this Nexus product already has a proposal selected'

/**
 * Two file parents proposed for the SAME Nexus product cannot both be confirmed: Nexus holds one
 * listing there, so the second would be refused as a duplicate (measured: MISANO IT, three eBay
 * parents, one Nexus listing). The first ticked proposal keeps the product; the others wait.
 */
export function linkChoices(proposals: readonly LinkProposal[], selected: Readonly<Record<string, string>>) {
  const taken = new Map<string, string>()
  for (const [fileSku, nexusSku] of Object.entries(selected)) if (!taken.has(nexusSku)) taken.set(nexusSku, fileSku)
  return proposals.map(p => {
    const checked = selected[p.fileSku] === p.proposedSku
    const holder = taken.get(p.proposedSku)
    const blocked = !checked && holder !== undefined && holder !== p.fileSku
    return { proposal: p, checked, disabled: blocked, reason: blocked ? ONE_LISTING_AT_A_TIME : '' }
  })
}

/** Ticking or unticking one proposal. A blocked proposal cannot be ticked. */
export function toggleLink(proposals: readonly LinkProposal[], selected: Readonly<Record<string, string>>, fileSku: string): Record<string, string> {
  const choice = linkChoices(proposals, selected).find(c => c.proposal.fileSku === fileSku)
  if (!choice || choice.disabled) return { ...selected }
  const next = { ...selected }
  if (choice.checked) delete next[fileSku]
  else next[fileSku] = choice.proposal.proposedSku
  return next
}

/**
 * Earlier confirmations stay: a second check (for example deletes after links) must not lose the first.
 * A delete is added only when its FILE SKU was SHOWN as pending in this review AND ticked — a tick for a
 * SKU the Owner never saw listed is dropped. Deletes are named by the file's SKU, never the Nexus SKU.
 */
export function mergeConfirmations(previous: Confirmations, links: Readonly<Record<string, string>>, tickedDeletes: readonly string[], shownPending: readonly string[]): Confirmations {
  const shown = new Set(shownPending)
  return { links: { ...previous.links, ...links }, confirmDeletes: [...new Set([...previous.confirmDeletes, ...tickedDeletes.filter(sku => shown.has(sku))])] }
}

/** What a check-again sends: earlier confirmations + this review's ticks, deletes named by the pending FILE SKUs shown. */
export const recheckConfirmations = (confirmed: Confirmations, links: Readonly<Record<string, string>>, tickedDeletes: readonly string[], job: Pick<TransferJob, 'deletes'>) =>
  mergeConfirmations(confirmed, links, tickedDeletes, pendingDeletes(job).map(d => d.fileSku))

/** Ticking or unticking one pending delete; only SKUs listed as pending can be ticked. */
export function toggleDelete(shownPending: readonly string[], ticked: readonly string[], sku: string): string[] {
  if (!shownPending.includes(sku)) return [...ticked]
  return ticked.includes(sku) ? ticked.filter(s => s !== sku) : [...ticked, sku]
}

/** The multipart fields the preview routes read: `links` a JSON object, `confirmDeletes` a JSON array of SKUs. */
export function appendConfirmations(body: FormData, confirmations: Confirmations) {
  if (Object.keys(confirmations.links).length) body.set('links', JSON.stringify(confirmations.links))
  if (confirmations.confirmDeletes.length) body.set('confirmDeletes', JSON.stringify(confirmations.confirmDeletes))
  return body
}

/** Deletes the file asks for that the Owner has not confirmed yet. */
export const pendingDeletes = (job: Pick<TransferJob, 'deletes'>) => (job.deletes ?? []).filter(d => !d.confirmed)
export const confirmedDeletes = (job: Pick<TransferJob, 'deletes'>) => (job.deletes ?? []).filter(d => d.confirmed)
export type ChannelDelete = NonNullable<TransferJob['deletes']>[number]
/** One listing the file deletes: its React key and its words — named by the FILE's SKU, the Nexus SKU beside it when different. */
export const deleteKey = (d: ChannelDelete) => `${d.channel}:${d.marketplace}:${d.fileSku}`
export const deleteName = (d: ChannelDelete, channelLabel: (channel: string) => string) =>
  `${d.fileSku}${d.sku && d.sku !== d.fileSku ? ` (Nexus ${d.sku})` : ''} · ${channelLabel(d.channel)} ${d.marketplace}`

/**
 * CFI-7 — an INVALID review still holds records that are ready. Saving them is offered only when
 * something would change; the refused records are skipped and stay listed.
 */
export function hasReadyRecords(job: Pick<TransferJob, 'state' | 'counts'>) {
  const c = job.counts
  return job.state === 'INVALID' && !!c && ((c.changed ?? 0) + (c.cleared ?? 0) + (c.ended ?? 0) + (c.pricesRecorded ?? 0) + (c.productsCreated ?? 0) + (c.listingsCreated ?? 0)) > 0
}

/** The apply request. `readyOnly` is sent only when the Owner chose to skip the refused records. */
export function applyRequest(job: Pick<TransferJob, 'reviewToken'>, readyOnly: boolean): { reviewToken?: string; readyOnly?: true } {
  return readyOnly ? { reviewToken: job.reviewToken, readyOnly: true } : { reviewToken: job.reviewToken }
}
