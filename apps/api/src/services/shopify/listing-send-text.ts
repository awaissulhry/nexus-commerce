/**
 * The title and description a Shopify listing sends (`content-sync.service.ts` → `publishContent`).
 *
 * The listing's own text first: the content writer's pin in the store's main language (the market's first language),
 * the one the product sheet's Shopify Title / Description cells show and save, and `set-listing-content` on
 * SHOPIFY · GLOBAL writes. Until 2026-10-16 the publisher read only the legacy listing columns, so a pin the sheet
 * showed was never sent: a Nexus publish sent the shared (Amazon) title over the store's own.
 *
 * Without such a pin it is exactly as before: the legacy columns when the listing does not follow the master, else the
 * family's. A legacy pin resolves to the same value as those columns, and an empty pin falls back too (Shopify refuses
 * a product without a title).
 */
import { contentListing } from '../pim/content-read.js'
import { contentResolverEnabled, isOperatorContentPin, resolveContent, type ContentProduct } from '../pim/content-resolver.js'

type Family = { id: string; name: string; description: string | null }
type Listing = Record<string, any> & {
  workspaceId?: string | null
  languages?: readonly string[]
  followMasterTitle: boolean
  followMasterDescription: boolean
  title?: string | null
  titleOverride?: string | null
  description?: string | null
  descriptionOverride?: string | null
}

/** This listing's own text for a field, when it keeps one (a pin in the store's main language), else undefined. */
function ownText(family: Family, listing: Listing, field: 'title' | 'description'): string | undefined {
  if (!contentResolverEnabled() || !listing.languages?.length) return undefined
  // The family row read for publication carries no workspace: its listing's (same business) stands for it.
  const product = { ...family, workspaceId: listing.workspaceId ?? null } as unknown as ContentProduct
  const hydrated = contentListing(product, listing)!
  const resolved = resolveContent({ product, parent: null, listing: hydrated, field, address: { requested: listing.languages[0], coordinate: hydrated.coordinate } })
  return isOperatorContentPin(resolved) && typeof resolved.value === 'string' && resolved.value.trim() !== '' ? resolved.value : undefined
}

export function shopifySendText(family: Family, listing: Listing): { title: string; description: string } {
  return {
    title: ownText(family, listing, 'title')
      ?? (listing.followMasterTitle ? family.name : listing.titleOverride ?? listing.title ?? family.name),
    description: ownText(family, listing, 'description')
      ?? (listing.followMasterDescription ? family.description ?? '' : listing.descriptionOverride ?? listing.description ?? family.description ?? ''),
  }
}
