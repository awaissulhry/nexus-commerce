/**
 * The SKU a trashed duplicate keeps (identity-merge.service.ts, 0(a)): unique, and never the SKU an order, a file or a
 * channel names. Pure, so the eBay workbook's parse worker can read it without loading Prisma.
 */
export const tombstoneSku = (sku: string, productId: string) => `${sku}~merged-${productId.slice(-8)}`

/**
 * The SKU a trashed duplicate had before its tombstone. An adopted eBay listing shell is trashed this way, but old eBay
 * files and the shared eBay variation rows still name its listing by that SKU (2026-10-05, normal-knee-slider-ALT1).
 */
export const skuBeforeTombstone = (sku: string) => sku.replace(/~merged-[^~]{1,8}$/, '')
