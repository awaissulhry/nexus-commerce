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
 *
 * An eBay LISTING SHELL is hidden from the list by default, and a shared ItemID's owner listing is usually a shell: its
 * entries name the variant by SKU (`quantity:<SKU>`, the eBay read-back's field). So for a shell's drifted listing, the
 * products those SKUs name (the shell's workspace, not deleted) and their parents are matched too. Only a shell's
 * entries are read this way; every other listing matches its own product and parent, as before.
 */
export async function productIdsWithChannelDrift(): Promise<string[]> {
  const rows = await prisma.channelDrift.findMany({ where: { driftCount: { gt: 0 } },
    select: { driftedFields: true, channelListing: { select: { productId: true, product: { select: { parentId: true, productType: true, workspaceId: true } } } } } })
  const ids = new Set<string>()
  const shellSkus = new Map<string, Set<string>>()
  for (const r of rows) {
    ids.add(r.channelListing.productId)
    if (r.channelListing.product?.parentId) ids.add(r.channelListing.product.parentId)
    if (r.channelListing.product?.productType !== 'EBAY_LISTING_SHELL') continue
    const workspaceId = r.channelListing.product.workspaceId
    for (const e of Array.isArray(r.driftedFields) ? r.driftedFields as DriftEntry[] : []) {
      const at = typeof e?.field === 'string' ? e.field.indexOf(':') : -1
      if (at < 0 || at === e.field.length - 1) continue
      const skus = shellSkus.get(workspaceId) ?? new Set<string>()
      skus.add(e.field.slice(at + 1))
      shellSkus.set(workspaceId, skus)
    }
  }
  for (const [workspaceId, skus] of shellSkus) {
    const named = await prisma.product.findMany({ where: { workspaceId, sku: { in: [...skus] }, deletedAt: null }, select: { id: true, parentId: true } })
    for (const p of named) {
      ids.add(p.id)
      if (p.parentId) ids.add(p.parentId)
    }
  }
  return [...ids]
}
