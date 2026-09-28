/**
 * Sharing studio step 5 — the publish review's warning when the same shared product is already live on eBay in the
 * other business (plan docs/2026-09-28-sharing-review-and-plan.md §5, step 5). It never blocks: it names the business
 * and the market, and says what to check. The database answers through `nexus_shared_product_live_listings`
 * (assortment-sync.sql): only for a product of this business, only through an active link, and only a name, a market
 * and a count. A listing on the SAME account is already refused by the listing claim (listing-claim.service.ts).
 */
import { Prisma } from '@prisma/client'
import { channelLabel } from '@nexus/shared/channel-label'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

/** eBay is where two businesses listing the same item on linked accounts can breach the duplicate-listing policy. */
const WARNED_CHANNELS = new Set(['EBAY'])

export interface SharedListingWarning { severity: 'warning'; message: string }

export function sharedListingWarningText(channel: string, marketplace: string, rows: Array<{ business_name: string; marketplace: string; listings: number }>): string | null {
  const same = rows.filter((row) => row.marketplace === marketplace)
  if (!same.length) return null
  const where = same.map((row) => `${row.business_name} (${row.listings === 1 ? '1 listing' : `${row.listings} listings`})`).join(', ')
  return `This product is shared between your businesses and is already live on ${channelLabel(channel)} ${marketplace} in ${where}. Two sellers listing the same item can break ${channelLabel(channel)}’s duplicate-listing rules. Check that both listings should be live before you publish.`
}

export async function sharedListingWarnings(productId: string, channel: string, marketplace: string): Promise<SharedListingWarning[]> {
  if (!WARNED_CHANNELS.has(channel)) return []
  try {
    const rows = await prisma.$queryRaw<Array<{ business_name: string; marketplace: string; listings: number }>>(
      Prisma.sql`SELECT business_name, marketplace, listings FROM nexus_shared_product_live_listings(${productId}, ${channel})`)
    const message = sharedListingWarningText(channel, marketplace, rows)
    return message ? [{ severity: 'warning', message }] : []
  } catch (error) {
    // A warning that cannot be read must not stop a publication; it is logged instead.
    logger.warn('shared-listing-warning: could not read', { productId, channel, error: error instanceof Error ? error.message : String(error) })
    return []
  }
}
