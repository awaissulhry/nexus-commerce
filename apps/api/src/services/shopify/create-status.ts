/**
 * Wave 2 D4 (Owner decisions 9, 10) — the status a product Shopify does not hold yet is created with, by ONE rule: the
 * Status column's choice of the family's main row on that Shopify store (`newListingChoices`: its own choice, else the
 * default — a Draft unless the family's stored Shopify status is ACTIVE; a product Nexus deleted: Not listed), read as
 * Shopify's status by `shopifyCreateStatus` (Active → ACTIVE, Inactive → DRAFT, Not listed → nothing is created).
 *
 * Publish reads the same choices from its own facts (`studio-publication.service.ts` `newRowsOf`); the sheet's "Shopify
 * status" cell (`channel-sheet.service.ts`) and the Media tab's "Create reviewed product" (`content-sync.service.ts`) read
 * them here. No channel call: Nexus's own rows only.
 */
import { shopifyCreateStatus, type ListingDeletion, type NewListingTarget, type ShopifyCreateStatus } from '@nexus/shared/listing-actions'
import prisma from '../../db.js'
import { readListingDeletions } from '../listings/listing-deletions.js'
import { newListingChoices, type ChoiceListing, type ChoiceProduct } from '../listings/new-listing-choices.js'
import { nativeListingValue } from './native-listing-value.js'

export interface ShopifyCreateChoice {
  /** The family's main product is on Shopify here: nothing is created, so there is no create status. */
  onShopify: boolean
  /** The Status column's choice for the main row (null when it is on Shopify). */
  target: NewListingTarget | null
  /** What Shopify creates it as; null = nothing is created (Not listed, or already on Shopify). */
  status: ShopifyCreateStatus | null
}

export type CreateChoiceListing = ChoiceListing & { platformAttributes?: unknown }

/** PURE. The main row's choice on one Shopify destination, from the family's rows there. */
export function shopifyCreateChoiceOf(input: { familyId: string; aliasKey: string; products: readonly ChoiceProduct[]; listings: readonly CreateChoiceListing[]
  deletions?: ReadonlyMap<string, ListingDeletion> }): ShopifyCreateChoice {
  const familyRow = input.listings.find(listing => listing.productId === input.familyId)
  const products = input.products.some(product => product.id === input.familyId) ? input.products : [{ id: input.familyId, parentId: null }, ...input.products]
  const choices = newListingChoices({ channel: 'SHOPIFY', aliasKey: input.aliasKey, familyId: input.familyId, products, listings: input.listings, deletions: input.deletions,
    shopifyActive: String(nativeListingValue(familyRow ?? null, 'status', 'DRAFT') ?? '').toUpperCase() === 'ACTIVE' })
  const main = choices.get(input.familyId)
  if (!main) return { onShopify: true, target: null, status: null }
  return { onShopify: false, target: main.target, status: shopifyCreateStatus(main.target) }
}

/** The family's rows on one Shopify destination, as the choice reads them (one product read, one listing read, deletions). */
export async function readShopifyCreateChoice(familyId: string, destination: { accountId: string; marketplace: string; aliasKey?: string | null }): Promise<ShopifyCreateChoice> {
  const products = await prisma.product.findMany({ where: { deletedAt: null, OR: [{ id: familyId }, { parentId: familyId }] }, select: { id: true, parentId: true } })
  const listings = await prisma.channelListing.findMany({
    where: { productId: { in: [...new Set([familyId, ...products.map(product => product.id)])] }, channel: 'SHOPIFY', marketplace: destination.marketplace,
      channelConnectionId: destination.accountId, aliasKey: destination.aliasKey ?? '' },
    select: { id: true, productId: true, channel: true, marketplace: true, externalListingId: true, listingStatus: true, isPublished: true, sellingTarget: true,
      sellingTargetAt: true, publishAction: true, publishActionAt: true, platformAttributes: true },
  })
  const deletions = await readListingDeletions(listings)
  return shopifyCreateChoiceOf({ familyId, aliasKey: destination.aliasKey ?? '', products, listings, deletions })
}
