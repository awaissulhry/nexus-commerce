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
  axisSynonymKey,
  type Market,
} from '../ebay-variation-push.service.js'
import { logger } from '../../utils/logger.js'
import { resolveImagePictureAxis } from './ebay-image-axis.pure.js'

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
  // EFX P5 — resolved-axis feedback (additive). The modal compares these with
  // the axis the operator requested and warns visibly on any divergence.
  /** activeAxis → stored imageAxisPreference → 'Color' ('__shared__' = explicit shared gallery). */
  requestedAxis?: string
  /** The axis pictures actually vary/curate by; null = explicit shared gallery. */
  pictureAxis?: string | null
  /** The axes the family REALLY varies by (>1 distinct value). */
  realAxes?: string[]
  /** Published as ONE listing-level gallery (aspectsImageVariesBy omitted). */
  sharedGallery?: boolean
  /** Truncation / axis-resolution warnings from the push (never silent). */
  warnings?: string[]
}

export async function publishEbayImagesViaInventory(
  productId: string,
  marketplace?: string,
  /** FFP.7 — the axis the operator selected in the modal (wins over the stored preference). */
  activeAxis?: string,
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
    select: { region: true, price: true, productId: true },
  })
  const allPricedMarkets = [...new Set(
    childListings
      .filter((l) => l.price != null && Number(l.price) > 0)
      .map((l) => (l.region === 'GB' ? 'UK' : l.region)),
  )].filter((m): m is Market => (MARKETS as readonly string[]).includes(m))
  // MARKET-SPECIFIC: publish ONLY to the market the operator is on (the flat file's
  // active marketplace). Fanning out to every priced market is what pushed IT images
  // to DE and returned a German 25007 (invalid DE shipping policy). Absent marketplace
  // → legacy all-markets behaviour (kept for any non-flat-file caller).
  const wantMarket = marketplace
    ? (marketplace.toUpperCase() === 'GB' ? 'UK' : marketplace.toUpperCase())
    : null
  const markets = wantMarket ? allPricedMarkets.filter((m) => m === wantMarket) : allPricedMarkets

  // Build per-market set of productIds that have an eBay listing (any price).
  // Variants with NO listing haven't been set up for eBay yet — they carry
  // incomplete/corrupted aspect data and must not be included in the group PUT
  // or they'll create duplicate variation value collisions with existing variants.
  const listedByMarket = new Map<string, Set<string>>()
  for (const l of childListings) {
    const mp = l.region === 'GB' ? 'UK' : l.region
    if (!listedByMarket.has(mp)) listedByMarket.set(mp, new Set())
    listedByMarket.get(mp)!.add(l.productId)
  }

  if (markets.length === 0) {
    const msg = wantMarket
      ? `This product isn't priced/listed on eBay ${wantMarket} yet — set it up on that market before publishing images there.`
      : 'No eBay market has priced variant listings for this product yet'
    return { success: false, message: msg, pictureCount: 0, colorSetCount: 0, error: 'No priced eBay markets' }
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
  // FFP.7 — the job row is created AFTER axis resolution below so the payload
  // records which axis was actually used (observability for axis mismatches).
  let job: { id: string } | null = null

  // The Images tab changes images only — keep each variant's currently-published
  // quantity (passthrough cap; the row qty already reflects what's live on eBay).
  const passthroughCap = (_pid: string | undefined, _sku: string, requested: number) =>
    Number(requested) || 0

  // P3/P4 — curation. The operator's master-gallery picks are saved as eBay
  // ListingImage rows: per-axis-value sets (variantGroupKey = the chosen picture
  // axis, variantGroupValue = e.g. "Nero") and optional per-SKU overrides
  // (variationId = the variant's product id). Both feed the push and WIN over the
  // default (Amazon-CDN child) images; per-SKU wins over per-axis-value.
  //
  // FFP.7 — axis resolution. Priority: the axis the operator SAW in the modal →
  // the stored preference → the family's first REAL variation axis. Either way
  // the result is validated against the axes the variants actually vary by:
  // curating by an axis the family doesn't have (e.g. the old hardcoded 'Color'
  // default on a Size-only family) silently dropped every curated set and
  // produced an inconsistent group — the misleading 25007 on image publishes.
  const axisInfo = (() => {
    const found = new Map<string, { label: string; values: Set<string> }>()
    for (const r of variantRows) {
      for (const [k, v] of Object.entries(r)) {
        if (!k.startsWith('aspect_') || typeof v !== 'string' || !v.trim()) continue
        const label = k.slice('aspect_'.length).replace(/_/g, ' ')
        const syn = axisSynonymKey(label)
        const e = found.get(syn) ?? { label, values: new Set<string>() }
        // prefer the cased variant of the key (buildFlatRow writes both)
        if (/[A-Z]/.test(label[0] ?? '') && !/[A-Z]/.test(e.label[0] ?? '')) e.label = label
        e.values.add(v.trim().toLowerCase())
        found.set(syn, e)
      }
    }
    return [...found.values()]
  })()
  // EFX P5 — FFP.15/16 resolution rules extracted to resolveImagePictureAxis
  // (pure, vitest-covered) + the explicit '__shared__' request: the operator
  // picked "One shared gallery" in the modal (or it's stored as the
  // preference), so pictureAxis is null, aspectsImageVariesBy is omitted, and
  // ONLY the Default/cover bucket forms the listing gallery.
  const { requestedAxis, pictureAxis, realAxes: multiAxes, sharedGallery, explicitShared } =
    resolveImagePictureAxis(axisInfo, activeAxis, product.imageAxisPreference)

  job = await prisma.channelImagePublishJob.create({
    data: {
      productId,
      channel: 'EBAY',
      marketplace: wantMarket ?? null,
      status: 'SUBMITTING',
      vendorEntityId: groupKey,
      requestPayload: { markets, groupKey, requestedAxis, pictureAxis, realAxes: multiAxes, sharedGallery } as object,
    },
  })
  const curatedRows = await prisma.listingImage.findMany({
    where: { productId, platform: 'EBAY', mediaType: 'IMAGE' },
    orderBy: { position: 'asc' },
    select: { variantGroupKey: true, variantGroupValue: true, variationId: true, url: true },
  })
  // Resolve per-SKU rows (variationId → sku) so the push can key by SKU.
  const variationIds = [...new Set(curatedRows.map((r) => r.variationId).filter((v): v is string => !!v))]
  const skuByVariationId = new Map<string, string>()
  if (variationIds.length > 0) {
    const vprods = await prisma.product.findMany({ where: { id: { in: variationIds } }, select: { id: true, sku: true } })
    for (const p of vprods) skuByVariationId.set(p.id, p.sku)
  }
  const sharedUrls: string[] = []
  const imageOverrideByColor = new Map<string, string[]>()
  const imageOverrideBySku = new Map<string, string[]>()
  for (const r of curatedRows) {
    if (r.variationId) {
      const sku = skuByVariationId.get(r.variationId)
      if (!sku) continue
      if (!imageOverrideBySku.has(sku)) imageOverrideBySku.set(sku, [])
      imageOverrideBySku.get(sku)!.push(r.url)
    } else if (r.variantGroupKey && pictureAxis && axisSynonymKey(r.variantGroupKey) === axisSynonymKey(pictureAxis)) {
      const key = String(r.variantGroupValue ?? '').toLowerCase()
      if (!key) continue
      if (!imageOverrideByColor.has(key)) imageOverrideByColor.set(key, [])
      imageOverrideByColor.get(key)!.push(r.url)
    } else if (!r.variantGroupKey && !r.variationId) {
      // P5 — the shared "cover & common" gallery (group/default images).
      sharedUrls.push(r.url)
    }
  }
  // P5 — de-dupe: a photo in the cover/common gallery must NOT also appear in a
  // per-colour or per-SKU set, or eBay shows it twice. The shared gallery wins.
  if (sharedUrls.length > 0) {
    const sharedSet = new Set(sharedUrls)
    for (const [k, urls] of imageOverrideByColor) imageOverrideByColor.set(k, urls.filter((u) => !sharedSet.has(u)))
    for (const [k, urls] of imageOverrideBySku) imageOverrideBySku.set(k, urls.filter((u) => !sharedSet.has(u)))
  }

  // FFP.15 — shared-gallery mode: the curated set IS the listing gallery.
  // Fold the single-value axis set into the listing-level urls (cover/common
  // first, curated set after); variants still each carry the same set via
  // imageOverrideByColor, so the gallery is uniform however the buyer clicks.
  if (sharedGallery) {
    for (const urls of imageOverrideByColor.values()) {
      for (const u of urls) if (!sharedUrls.includes(u)) sharedUrls.push(u)
    }
  }

  const allResults: Array<{ sku: string; market: string; status: string; message: string }> = []
  // EFX P5 — collects axis-resolution AND 12-image truncation warnings from
  // the push so the modal can show them (never silent).
  const pushWarnings: string[] = []
  for (const mp of markets) {
    const listedIds = listedByMarket.get(mp) ?? new Set<string>()
    const marketRows = rows.filter((r) => r._isParent || listedIds.has(r._productId as string))
    const groupResults = await pushVariationGroup(
      groupKey,
      marketRows,
      mp,
      token,
      connection.id,
      (connection.connectionMetadata ?? {}) as Record<string, unknown>,
      EBAY_API_BASE,
      toMarketplaceId(mp),
      passthroughCap,
      imageOverrideByColor.size > 0 ? imageOverrideByColor : undefined,
      pictureAxis ?? undefined,
      imageOverrideBySku.size > 0 ? imageOverrideBySku : undefined,
      sharedUrls.length > 0 ? sharedUrls : undefined,
      { skipOffersOnNoPrice: true, omitImageVariesBy: sharedGallery, warningsSink: pushWarnings },
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

  if (job) {
    await prisma.channelImagePublishJob.update({
      where: { id: job.id },
      data: success
        ? { status: 'DONE', completedAt: new Date(), response: { markets, results: allResults, warnings: pushWarnings } as object }
        : { status: 'FATAL', completedAt: new Date(), errorMessage: (errors[0]?.message ?? 'eBay publish failed').slice(0, 500), response: { markets, results: allResults, warnings: pushWarnings } as object },
    })
  }

  logger.info('[ebay-inventory-image-publish]', { productId, groupKey, markets, success, pushedSkus, errors: errors.length })

  return {
    success,
    message: success
      ? (sharedGallery
          ? `Published eBay images across ${markets.join(', ')} · ${variantRows.length} variants · ONE shared gallery ${explicitShared ? '(operator-selected — no per-variant images)' : `(family has a single ${pictureAxis} value — pictures no longer swap when the buyer picks a size)`}`
          : `Published eBay images across ${markets.join(', ')} · ${variantRows.length} variants · vary by ${pictureAxis}${imageOverrideByColor.size > 0 ? ` (${imageOverrideByColor.size} ${(pictureAxis ?? '').toLowerCase()} curated)` : ''}${imageOverrideBySku.size > 0 ? ` + ${imageOverrideBySku.size} per-SKU` : ''}`)
      : `eBay publish failed: ${errors[0]?.message ?? 'unknown error'}`,
    pictureCount: pushedSkus,
    colorSetCount: colours.size,
    jobId: job?.id,
    markets,
    results: allResults,
    // EFX P5 — resolved-axis feedback, surfaced top-level so the modal can
    // show "Images vary by: X" / "Shared gallery" and warn on divergence.
    requestedAxis,
    pictureAxis,
    realAxes: multiAxes,
    sharedGallery,
    ...(pushWarnings.length > 0 ? { warnings: pushWarnings } : {}),
    ...(success ? {} : { error: errors[0]?.message }),
  }
}
