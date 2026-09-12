import type { ShopifyLinkedPlan } from '@nexus/shared/shopify-linked-products'
import { Disclosure } from '@/design-system/components'

export function ShopifyGalleryReview({ galleries }: { galleries: ShopifyLinkedPlan['sheetGalleries'] }) {
  return <>{galleries?.map(gallery => <Disclosure key={gallery.listingId} summary={`${gallery.ownerLabel} · ${gallery.variantId ? 'Variant image' : 'Product media'}`}>
    <p>{gallery.variantId ? gallery.variantValue?.length ?? 0 : gallery.value.length} current items → {gallery.assets.length} saved items.</p>
    <p>{gallery.assets.map((asset, index) => `${index + 1}. ${asset.alt || asset.type || 'Image'}`).join(' · ') || 'Clear this gallery.'}</p>
    <p>Membership is shared across languages. Saved image alt translations are included. New files upload only when you synchronize.</p>
  </Disclosure>)}</>
}
