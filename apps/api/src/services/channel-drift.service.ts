import prisma from '../db.js'

/**
 * PLAN Step 3.5a (A-36, R-36) — the ONE writer of `ChannelDrift`: what a channel holds that differs from what Nexus
 * holds, per listing.
 *
 * The READS already existed (Amazon's merchant-listings report for quantity and price, Shopify's inventory levels…) and
 * each logged its differences into `SyncHealthLog`, which has no listing, market or account column — so nothing could
 * say WHICH listing drifted, and no screen could filter to it. They now also write here, through this one function.
 *
 * A source replaces only what IT read: every field it compared this time — the differing ones are stored, the matching
 * ones are CLEARED. Another source's entries on the same listing are left alone. A listing that was checked and matches
 * keeps its row with `driftCount` 0: "checked and clean" must not read like "never checked".
 */
export const DRIFT_FIELD_CAP = 50

export type DriftField = { field: string; ours: unknown; theirs: unknown }
export type DriftEntry = DriftField & { source: string; checkedAt: string }

/** Pure: one source's fresh read merged into a listing's stored entries, capped. */
export function mergeDrift(previous: unknown, source: string, compared: readonly string[], differing: readonly DriftField[], checkedAt: Date): DriftEntry[] {
  const prior = Array.isArray(previous) ? previous as DriftEntry[] : []
  const kept = prior.filter(e => !(e.source === source && compared.includes(e.field)))
  const fresh = differing.filter(d => compared.includes(d.field))
    .map(d => ({ field: d.field, ours: d.ours ?? null, theirs: d.theirs ?? null, source, checkedAt: checkedAt.toISOString() }))
  return [...kept, ...fresh].slice(0, DRIFT_FIELD_CAP)
}

/**
 * Record one read-back of one listing. `compared` = every field this source compared (a field that now matches is
 * cleared); `differing` = the ones that differ, with our value and the channel's.
 */
export async function recordChannelReadback(input: {
  channelListingId: string
  channel: string
  marketplace: string
  source: string
  compared: readonly string[]
  differing: readonly DriftField[]
  checkedAt?: Date
}): Promise<{ driftCount: number }> {
  const checkedAt = input.checkedAt ?? new Date()
  const existing = await prisma.channelDrift.findFirst({ where: { channelListingId: input.channelListingId }, select: { id: true, driftedFields: true } })
  const entries = mergeDrift(existing?.driftedFields, input.source, input.compared, input.differing, checkedAt)
  const data = { channel: input.channel, marketplace: input.marketplace, driftCount: entries.length, driftedFields: entries as never, lastCheckedAt: checkedAt }
  if (existing) await prisma.channelDrift.update({ where: { id: existing.id }, data })
  else await prisma.channelDrift.create({ data: { channelListingId: input.channelListingId, ...data } })
  return { driftCount: entries.length }
}

/**
 * The product ids a "differs on the channel" filter matches: every product with a drifted listing, and its parent —
 * the product list shows families by their parent row.
 */
export async function productIdsWithChannelDrift(): Promise<string[]> {
  const rows = await prisma.channelDrift.findMany({ where: { driftCount: { gt: 0 } },
    select: { channelListing: { select: { productId: true, product: { select: { parentId: true } } } } } })
  const ids = new Set<string>()
  for (const r of rows) {
    ids.add(r.channelListing.productId)
    if (r.channelListing.product?.parentId) ids.add(r.channelListing.product.parentId)
  }
  return [...ids]
}
