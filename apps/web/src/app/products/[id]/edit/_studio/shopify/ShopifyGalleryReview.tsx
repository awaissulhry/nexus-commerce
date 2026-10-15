import type { ShopifyLinkedPlan } from '@nexus/shared/shopify-linked-products'
import { Disclosure } from '@/design-system/components'

/** What a gallery sync sends: photos that already are files of this store are used as they are; only the others upload. */
export function galleryUploads(gallery: NonNullable<ShopifyLinkedPlan['sheetGalleries']>[number]) {
  const reused = gallery.assets.filter(asset => gallery.storeFiles?.[asset.id]).length
  const uploads = gallery.assets.length - reused
  const parts = [reused === 1 ? '1 photo is already a file of this store and is used as it is (no new upload).' : reused ? `${reused} photos are already files of this store and are used as they are (no new upload).` : '',
    uploads === 1 ? '1 new file uploads when you synchronize.' : uploads ? `${uploads} new files upload when you synchronize.` : '']
  return parts.filter(Boolean).join(' ')
}

export function ShopifyGalleryReview({ galleries }: { galleries: ShopifyLinkedPlan['sheetGalleries'] }) {
  return <>{galleries?.map(gallery => <Disclosure key={gallery.listingId} summary={`${gallery.ownerLabel} · ${gallery.variantId ? 'Variant image' : 'Product media'}`}>
    <p>{gallery.variantId ? gallery.variantValue?.length ?? 0 : gallery.value.length} current items → {gallery.assets.length} saved items.</p>
    <p>{gallery.assets.map((asset, index) => `${index + 1}. ${asset.alt || asset.type || 'Image'}`).join(' · ') || 'Clear this gallery.'}</p>
    <p>Membership is shared across languages. Saved image alt translations are included. {galleryUploads(gallery)}</p>
  </Disclosure>)}</>
}
