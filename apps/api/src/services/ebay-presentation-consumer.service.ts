import prisma from '../db.js'
import { MappingConflict } from './pim/mapping/revision-token.js'

export const ORDER_RECEIPT = '_presentationOrderRevision'
export const FULL_PRESENTATION_RESTRICTION = 'This family has a reviewed product Presentation customization. Full Inventory/shared-listing publication needs the destination and version review contract. Use the selected Trading listing’s separate presentation publication review; Inventory listings remain unsupported.'

/** The older full-publish callers cannot carry a reviewed alias/version. Refuse the new
 * product-order contract before credentials, eBay calls or result writes. An omitted account
 * cannot prove which account it will affect, so its check includes all accounts for this family. */
export async function assertLegacyPresentationPublishAllowed(input: { sku?: string; productId?: string; marketplace?: string; accountId?: string }) {
  const seed = await prisma.product.findFirst({ where: { ...(input.productId ? { id: input.productId } : { sku: input.sku ?? '__missing__' }), deletedAt: null }, select: { id: true, parentId: true } })
  if (!seed) return
  const root = seed.parentId ?? seed.id
  const listings = await prisma.channelListing.findMany({ where: { productId: root, channel: 'EBAY', ...(input.marketplace ? { marketplace: input.marketplace.toUpperCase().replace(/^EBAY_/, '').replace(/^GB$/, 'UK') } : {}), ...(input.accountId ? { channelConnectionId: input.accountId } : {}) }, select: { platformAttributes: true } })
  if (listings.some(l => !!(l.platformAttributes as Record<string, unknown> | null)?.[ORDER_RECEIPT])) throw new MappingConflict(FULL_PRESENTATION_RESTRICTION)
}
