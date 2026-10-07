/**
 * Amazon sheet gaps — the listing rows a quantity or fulfilment-setting write on ONE listing lands on, as the Matrix's
 * EU inventory group writes them (`matrix-write.service.ts` `targetsOf`, `listing-matrix-cell.service.ts`
 * `quantityTargetsOf`), keyed on any primary listing.
 *
 * Amazon keeps ONE merchant quantity — and one fulfilment entry (handling time, restock date) — per SKU across the EU
 * markets. So a write on an Amazon EU market lands on every EU row of the SKU on the same account and alias-free
 * coordinate whose offer is not closed (SCT.6: an EU-wide action never reopens a closed offer), in the Matrix's market
 * order. Any other listing (another channel, a non-EU market, an alias) is its own only target.
 *
 * `includeClosed` (Step 2, "Sells from"): a setting that writes nothing to Amazon and must hold on every EU row — the
 * closed ones too, or a reopened market would sell from another list — takes every row, each version-checked.
 */
import type { Prisma } from '@prisma/client'
import { AMAZON_EU_SHARED_MARKETS } from '../amazon-eu-quantity-guard.js'
import { compareMarkets, isAmazonEuMarket } from './matrix-cells.js'

export interface SharedInventoryPrimary {
  id: string
  productId: string
  channel: string
  marketplace: string
  channelConnectionId: string | null
  aliasKey: string | null
  /** The version the caller saw (CAS); it is the primary target's version. */
  version: number
}
export interface SharedInventorySibling { id: string; marketplace: string; version: number; offerClosedAt: unknown }
export interface SharedInventoryTarget { id: string; marketplace: string; version: number }
export interface SharedInventoryOptions { primary?: 'open-only' | 'always'; includeClosed?: boolean }

/** Does a write on this listing reach the whole Amazon EU group? */
export const sharesAmazonEuInventory = (l: Pick<SharedInventoryPrimary, 'channel' | 'marketplace' | 'aliasKey'>): boolean =>
  isAmazonEuMarket(String(l.channel).toUpperCase(), l.marketplace) && (l.aliasKey ?? '') === ''

/**
 * PURE — the targets among the group's rows (`siblings` = every EU row of the SKU on the account, the primary among
 * them). `conflict` = the primary moved since the caller read it (its current version), or is gone (0).
 * `primary: 'always'` keeps the primary even when its own offer is closed (the listings screen's quantity edit).
 * `includeClosed` keeps every row of the group, closed offers included.
 */
export function pickSharedInventoryTargets(
  primary: SharedInventoryPrimary,
  siblings: readonly SharedInventorySibling[],
  options: SharedInventoryOptions = {},
): { targets: SharedInventoryTarget[]; expandedTo?: string[] } | { conflict: number } {
  const own: SharedInventoryTarget = { id: primary.id, marketplace: primary.marketplace, version: primary.version }
  if (!sharesAmazonEuInventory(primary)) return { targets: [own] }
  const current = siblings.find((r) => r.id === primary.id)
  if (!current && options.primary !== 'always') return { conflict: 0 }
  if (current && current.version !== primary.version) return { conflict: current.version }
  const open = siblings.filter((r) => options.includeClosed || !r.offerClosedAt || (options.primary === 'always' && r.id === primary.id))
  const targets = open.map((r) => (r.id === primary.id ? own : { id: r.id, marketplace: r.marketplace, version: r.version }))
  if (options.primary === 'always' && !targets.some((t) => t.id === primary.id)) targets.push(own)
  targets.sort((a, b) => compareMarkets(a.marketplace, b.marketplace))
  return { targets, expandedTo: targets.map((t) => t.marketplace) }
}

/** The group's rows of one primary listing: one query (none for a listing outside the Amazon EU group). */
export async function loadSharedInventoryTargets(
  db: Pick<Prisma.TransactionClient, 'channelListing'>,
  primary: SharedInventoryPrimary,
  options: SharedInventoryOptions = {},
): Promise<{ targets: SharedInventoryTarget[]; expandedTo?: string[] } | { conflict: number }> {
  if (!sharesAmazonEuInventory(primary)) return pickSharedInventoryTargets(primary, [], options)
  const siblings = await db.channelListing.findMany({
    where: { productId: primary.productId, channel: 'AMAZON', marketplace: { in: [...AMAZON_EU_SHARED_MARKETS] }, aliasKey: '', channelConnectionId: primary.channelConnectionId },
    select: { id: true, marketplace: true, version: true, offerClosedAt: true },
  })
  return pickSharedInventoryTargets(primary, siblings, options)
}
