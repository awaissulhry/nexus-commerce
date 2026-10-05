/**
 * New listings (Owner 2026-10-04, plan "NEW LISTINGS — control before the first publish") — what Publish does with each
 * row of a family that is NOT on the channel yet, on ONE destination (channel + market + account + alias):
 *
 *   - the row's own Status choice: `sellingTarget` ACTIVE / INACTIVE / NOT_LISTED on a row not on the channel;
 *   - else, for a variation, the main row's choice (while the main row is not on the channel either);
 *   - else today's default (ND2 A, `newListingDefault`): Amazon and eBay Active, Shopify Inactive (a Draft product)
 *     unless the family's own Shopify status is ACTIVE, Etsy Inactive (an Etsy draft, Owner D1 2026-10-05) but Active for
 *     a new variation of a listing already on Etsy; a variation Publish would leave out today (no listing here, or left
 *     out of the listing in Information) reads Not listed.
 *
 * A row Nexus deleted (Owner 2026-10-04, simplify) is such a row too: its default is Not listed (every Publish skips it),
 * and its own choice Active or Inactive lists it again (whole) on the next Publish. An older relist choice stored the
 * first build's way (Partial or Full update in the Action column after the delete, `ListingDeletion.relistChosenAt`) is
 * read as the row's own choice Active until a Status choice replaces it.
 *
 * A row Nexus UNLINKED (Item ID control, 2026-10-05; `ListingDeletion.unlinked`) is not a deleted one: the listing may
 * still be live on the channel. It always reads Not listed — no own, main or older choice lists it as new (that made a
 * second eBay item) — until its id is linked again.
 *
 * PURE. The sheet's read (`publish-action.service.ts`) and Publish (`studio-publication-plan.ts`,
 * `studio-publication.service.ts`) read the choices from the same facts with this one function, so the Status a cell
 * shows is what Publish does.
 */
import { isNewListingTarget, newListingChoice, newListingDefault, type ListingDeletion, type NewListingSource, type NewListingTarget } from '@nexus/shared/listing-actions'
import { statusTargetOf } from '@nexus/shared/publish-actions'

export interface ChoiceProduct { id: string; parentId: string | null }

export interface ChoiceListing {
  id: string
  productId: string
  externalListingId: string | null
  listingStatus?: string | null
  isPublished?: boolean | null
  /** The Status column's stored value (`ChannelListing.sellingTarget`) and when it was set. */
  sellingTarget?: string | null
  sellingTargetAt?: Date | string | null
}

export interface NewListingChoicesInput {
  channel: string
  /** '' = the primary listing. */
  aliasKey: string
  familyId: string
  products: readonly ChoiceProduct[]
  /** The family's rows on this destination only. */
  listings: readonly ChoiceListing[]
  /** Variation rows left out of this listing (`variationExcluded`). */
  excludedListingIds?: ReadonlySet<string>
  /** Rows Nexus deleted and not listed again, by listing id (`readListingDeletions`): rows not on the channel, default Not listed. */
  deletions?: ReadonlyMap<string, ListingDeletion>
  /** Shopify: the family's stored Shopify status is ACTIVE (today such a product is created active). */
  shopifyActive?: boolean
}

export interface NewListingRowChoice {
  productId: string
  /** Null when the product has no listing here (the row's cell then has a `new:` id). */
  listingId: string | null
  target: NewListingTarget
  source: NewListingSource
  /** The row's own stored choice, or null. */
  own: NewListingTarget | null
  /** What the row gets when nobody chose (the default part of `newListingChoice`). */
  defaultTarget: NewListingTarget
  /** Publish includes it today without any choice (see `NewListingChoiceInput.includedByDefault`). */
  includedByDefault: boolean
  noRecord: boolean
  isVariation: boolean
  /** Nexus deleted this row from the channel (its Active or Inactive lists it again), or null. */
  deleted: ListingDeletion | null
}

/** Was this stored value set before the row's delete (it belongs to the listing that was deleted)? */
export const setBeforeDelete = (at: Date | string | null | undefined, deletion: Pick<ListingDeletion, 'at'> | null) =>
  !!deletion && !!at && new Date(at).getTime() <= Date.parse(deletion.at)

/**
 * A row's own stored choice. On a deleted row: a Status set BEFORE the delete is not one (it belongs to the listing that
 * was deleted); with none, an older relist choice (Action Partial or Full update after the delete) reads Active.
 */
const ownChoice = (listing: ChoiceListing | undefined, deletion: ListingDeletion | null): NewListingTarget | null => {
  // An UNLINKED row (Item ID control, 2026-10-05) is never listed as new — the listing may still be live there, and a
  // create would make a second one: no stored value is a create choice on it (nor a main row's choice for its variations).
  if (deletion?.unlinked) return null
  const target = statusTargetOf(listing?.sellingTarget)
  if (isNewListingTarget(target) && !setBeforeDelete(listing?.sellingTargetAt, deletion)) return target
  return deletion?.relistChosenAt ? 'active' : null
}

/** Every product of the family NOT on the channel here (never sent, no listing, or deleted by Nexus) → what Publish does with it. */
export function newListingChoices(input: NewListingChoicesInput): Map<string, NewListingRowChoice> {
  const out = new Map<string, NewListingRowChoice>()
  const channel = String(input.channel ?? '').toUpperCase()
  const listingOf = new Map(input.listings.map(listing => [listing.productId, listing]))
  const isVariationOf = (product: ChoiceProduct) => !!product.parentId && product.parentId === input.familyId
  // The selling state's own rule (`sellingStateOf`): never sent = no channel number, and a draft or never published. A
  // listing the channel accepted that waits for its channel number (an Amazon ASIN not read yet) is on the channel.
  const notOnChannel = (listing: ChoiceListing | undefined) => !listing
    || (!listing.externalListingId && (String(listing.listingStatus ?? '').trim().toUpperCase() === 'DRAFT' || listing.isPublished === false))
  const deletionOf = (listing: ChoiceListing | undefined) => (listing && input.deletions?.get(listing.id)) || null
  // Audit P4 (readPublicationFacts) — an eBay family never started here publishes all its variations.
  const ebayUnstarted = channel === 'EBAY' && input.aliasKey === '' && input.products.length > 1
    && !input.listings.some(listing => listing.externalListingId) && !input.listings.some(listing => listing.productId !== input.familyId)
  // Etsy (one listing per family): a row of the listing on the channel makes every new row a new variation of it.
  const listingOnChannel = input.listings.some(listing => !!listing.externalListingId)
  const mainListing = listingOf.get(input.familyId)
  const main = notOnChannel(mainListing) ? ownChoice(mainListing, deletionOf(mainListing)) : null
  for (const product of input.products) {
    const listing = listingOf.get(product.id)
    if (!notOnChannel(listing)) continue
    const deletion = deletionOf(listing)
    const isVariation = isVariationOf(product)
    const includedByDefault = !isVariation ? true
      : listing ? !input.excludedListingIds?.has(listing.id) : ebayUnstarted
    const own = ownChoice(listing, deletion)
    // An unlinked row reads Not listed whatever its main row chose: Publish leaves it out (`deletedPublishSkip` says why).
    const choice = deletion?.unlinked ? { target: 'not_listed' as const, source: 'default' as const }
      : newListingChoice({ channel, own, main, isVariation, includedByDefault, shopifyActive: input.shopifyActive, listingOnChannel, deleted: !!deletion })
    out.set(product.id, {
      productId: product.id, listingId: listing?.id ?? null, target: choice.target, source: choice.source, own,
      defaultTarget: includedByDefault && !deletion ? newListingDefault(channel, { shopifyActive: input.shopifyActive, listingOnChannel }) : 'not_listed',
      includedByDefault, noRecord: !listing, isVariation, deleted: deletion,
    })
  }
  return out
}
