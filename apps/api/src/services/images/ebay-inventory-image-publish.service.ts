/**
 * Phase 2 — eBay image publish via the Inventory API.
 *
 * The legacy path (ebay-image-publish.service.ts) used the Trading API
 * ReviseItem keyed on Product.ebayItemId. For Inventory-API-listed products
 * (e.g. GALE-JACKET) ebayItemId is null, so that path is a permanent no-op.
 *
 * This service instead builds the SAME full family payload the eBay flat-file
 * page builds (buildEbayFamilyRows) and pushes it through the SAME proven
 * shared publisher (pushVariationGroup → inventory_item + inventory_item_group
 * + publish_by_inventory_item_group), to every eBay market the product is
 * listed on.
 *
 * Images come from the child ProductImage rows (the publisher's default).
 * Per-colour curation overrides arrive in Phase 3.
 */
import prisma from '../../db.js'
import { ebayAuthService } from '../ebay-auth.service.js'
import {
  buildEbayFamilyRows,
  pushVariationGroup,
  toMarketplaceId,
  MARKETS,
  type Market,
} from '../ebay-variation-push.service.js'
import { logger } from '../../utils/logger.js'

const EBAY_API_BASE = process.env.EBAY_API_BASE ?? 'https://api.ebay.com'

export interface EbayInventoryPublishResult {
  success: boolean
  message: string
  pictureCount: number
  colorSetCount: number
  jobId?: string
  error?: string
  markets?: string[]
  results?: Array<{ sku: string; market: string; status: string; message: string }>
}

export async function publishEbayImagesViaInventory(
  productId: string,
): Promise<EbayInventoryPublishResult> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, sku: true, isParent: true, parentId: true, imageAxisPreference: true },
  })
  if (!product) throw new Error(`Product ${productId} not found`)

  // The Images tab can be opened on the parent OR a child — resolve the family
  // root either way so we publish the whole variation group.
  const familyParentId = product.parentId ?? product.id

  // Build the exact same flat rows the eBay flat-file page builds for this family.
  const rows = await buildEbayFamilyRows(familyParentId)
  if (rows.length === 0) {
    return { success: false, message: 'No eBay listing rows for this product', pictureCount: 0, colorSetCount: 0, error: 'No rows' }
  }

  const parentRow = rows.find((r) => r._isParent) ?? rows[0]
  const groupKey = (parentRow.sku as string) || familyParentId
  const variantRows = rows.filter((r) => !r._isParent)

  // Phase 2 covers the variation-group case (the real curation use case). A
  // single-SKU eBay listing uses a different Inventory flow on the flat-file page.
  if (variantRows.length === 0) {
    return { success: false, message: 'Single-SKU eBay image publish isn’t wired here yet — push from the eBay flat-file page', pictureCount: 0, colorSetCount: 0, error: 'No variant children' }
  }

  // Resolve the markets the VARIANTS are actually listed + priced on. eBay
  // publishes a variation group per market, and an offer with no price fails at
  // publish_by_inventory_item_group — so a lone parent listing (or a stale row)
  // in a market the children aren't priced in must NOT be targeted.
  const childProductIds = variantRows.map((r) => r._productId as string).filter(Boolean)
  const childListings = await prisma.channelListing.findMany({
    where: { productId: { in: childProductIds }, channel: 'EBAY' },
    select: { region: true, price: true },
  })
  const markets = [...new Set(
    childListings
      .filter((l) => l.price != null && Number(l.price) > 0)
      .map((l) => (l.region === 'GB' ? 'UK' : l.region)),
  )].filter((m): m is Market => (MARKETS as readonly string[]).includes(m))

  if (markets.length === 0) {
    return { success: false, message: 'No eBay market has priced variant listings for this product yet', pictureCount: 0, colorSetCount: 0, error: 'No priced eBay markets' }
  }

  // eBay connection + token (mirrors the flat-file /push path).
  const connection = await prisma.channelConnection.findFirst({
    where: { channelType: 'EBAY', isActive: true },
    select: { id: true, connectionMetadata: true },
  })
  if (!connection) {
    return { success: false, message: 'No active eBay connection found', pictureCount: 0, colorSetCount: 0, error: 'No connection' }
  }
  let token: string
  try {
    token = await ebayAuthService.getValidToken(connection.id)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, message: `eBay auth failed: ${msg}`, pictureCount: 0, colorSetCount: 0, error: msg }
  }

  // Track the attempt so the publish dashboard/history sees it immediately.
  const job = await prisma.channelImagePublishJob.create({
    data: {
      productId,
      channel: 'EBAY',
      status: 'SUBMITTING',
      vendorEntityId: groupKey,
      requestPayload: { markets, groupKey } as object,
    },
  })

  // The Images tab changes images only — keep each variant's currently-published
  // quantity (passthrough cap; the row qty already reflects what's live on eBay).
  const passthroughCap = (_pid: string | undefined, _sku: string, requested: number) =>
    Number(requested) || 0

  // P3/P4 — curation. The operator's master-gallery picks are saved as eBay
  // ListingImage rows: per-axis-value sets (variantGroupKey = the chosen picture
  // axis, variantGroupValue = e.g. "Nero") and optional per-SKU overrides
  // (variationId = the variant's product id). Both feed the push and WIN over the
  // default (Amazon-CDN child) images; per-SKU wins over per-axis-value.
  const pictureAxis = product.imageAxisPreference ?? 'Color'
  const curatedRows = await prisma.listingImage.findMany({
    where: {
      productId, platform: 'EBAY', mediaType: 'IMAGE',
      OR: [{ variantGroupKey: pictureAxis }, { variationId: { not: null } }],
    },
    orderBy: { position: 'asc' },
    select: { variantGroupValue: true, variationId: true, url: true },
  })
  // Resolve per-SKU rows (variationId → sku) so the push can key by SKU.
  const variationIds = [...new Set(curatedRows.map((r) => r.variationId).filter((v): v is string => !!v))]
  const skuByVariationId = new Map<string, string>()
  if (variationIds.length > 0) {
    const vprods = await prisma.product.findMany({ where: { id: { in: variationIds } }, select: { id: true, sku: true } })
    for (const p of vprods) skuByVariationId.set(p.id, p.sku)
  }
  const imageOverrideByColor = new Map<string, string[]>()
  const imageOverrideBySku = new Map<string, string[]>()
  for (const r of curatedRows) {
    if (r.variationId) {
      const sku = skuByVariationId.get(r.variationId)
      if (!sku) continue
      if (!imageOverrideBySku.has(sku)) imageOverrideBySku.set(sku, [])
      imageOverrideBySku.get(sku)!.push(r.url)
    } else {
      const key = String(r.variantGroupValue ?? '').toLowerCase()
      if (!key) continue
      if (!imageOverrideByColor.has(key)) imageOverrideByColor.set(key, [])
      imageOverrideByColor.get(key)!.push(r.url)
    }
  }

  const allResults: Array<{ sku: string; market: string; status: string; message: string }> = []
  for (const mp of markets) {
    const groupResults = await pushVariationGroup(
      groupKey,
      rows,
      mp,
      token,
      connection.id,
      (connection.connectionMetadata ?? {}) as Record<string, unknown>,
      EBAY_API_BASE,
      toMarketplaceId(mp),
      passthroughCap,
      imageOverrideByColor.size > 0 ? imageOverrideByColor : undefined,
      pictureAxis,
      imageOverrideBySku.size > 0 ? imageOverrideBySku : undefined,
    )
    allResults.push(...groupResults)
  }

  const errors = allResults.filter((r) => r.status === 'ERROR')
  const success = errors.length === 0 && allResults.length > 0
  const pushedSkus = allResults.filter((r) => r.status === 'PUSHED').length
  const colours = new Set(
    variantRows
      .map((r) => String((r as Record<string, unknown>).aspect_color ?? (r as Record<string, unknown>).aspect_Color ?? '').toLowerCase())
      .filter(Boolean),
  )

  // Reflect status on the product's eBay ListingImage rows. Phase 3's per-colour
  // curation lives here; for products without curated rows this is a no-op.
  await prisma.listingImage.updateMany({
    where: { productId, platform: 'EBAY' },
    data: success
      ? { publishStatus: 'PUBLISHED', publishedAt: new Date(), publishError: null }
      : { publishStatus: 'ERROR', publishError: (errors[0]?.message ?? 'eBay publish failed').slice(0, 500) },
  })

  await prisma.channelImagePublishJob.update({
    where: { id: job.id },
    data: success
      ? { status: 'DONE', completedAt: new Date(), response: { markets, results: allResults } as object }
      : { status: 'FATAL', completedAt: new Date(), errorMessage: (errors[0]?.message ?? 'eBay publish failed').slice(0, 500), response: { markets, results: allResults } as object },
  })

  logger.info('[ebay-inventory-image-publish]', { productId, groupKey, markets, success, pushedSkus, errors: errors.length })

  return {
    success,
    message: success
      ? `Published eBay images across ${markets.join(', ')} · ${variantRows.length} variants · vary by ${pictureAxis}${imageOverrideByColor.size > 0 ? ` (${imageOverrideByColor.size} ${pictureAxis.toLowerCase()} curated)` : ''}${imageOverrideBySku.size > 0 ? ` + ${imageOverrideBySku.size} per-SKU` : ''}`
      : `eBay publish failed: ${errors[0]?.message ?? 'unknown error'}`,
    pictureCount: pushedSkus,
    colorSetCount: colours.size,
    jobId: job.id,
    markets,
    results: allResults,
    ...(success ? {} : { error: errors[0]?.message }),
  }
}
