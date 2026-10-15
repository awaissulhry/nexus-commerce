import { STORE_PHOTO_ID_PREFIX } from '@nexus/shared/product-media'

/**
 * The filter every "all photos of the product" read of an older publish path adds: a Shopify store photo (linked from the
 * store's Files for its own galleries, `isStorePhotoId`) never joins a list Nexus builds on its own. It is sent only where a
 * saved list or a photo-plan set names it, so a store's photos never reach Amazon, eBay or another business by default.
 */
export const NOT_STORE_PHOTO = { NOT: { id: { startsWith: STORE_PHOTO_ID_PREFIX } } }
