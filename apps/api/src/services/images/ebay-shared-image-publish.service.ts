/**
 * EB-IMG Phase 1 — image publish for SHELL / adopted eBay listings.
 *
 * The Inventory-API image path (ebay-inventory-image-publish.service.ts)
 * requires a real product family pushed as an inventory_item_group. The
 * flat-file's EXTRA listings are EBAY_LISTING_SHELL products: no product
 * children, variants linked via SharedListingMembership rows, and a LIVE
 * Trading-API ItemID. Their images can only change through a Trading
 * ReviseFixedPriceItem carrying <PictureDetails> (listing gallery) and
 * <Variations><Pictures> (per-axis-value picture sets) — this service.
 *
 * Correctness rules learned from the live listings:
 *   • The Pictures axis MUST be one of the listing's DECLARED variation
 *     specifics names (Italian on IT — 'Colore', 'Taglia'). The curated
 *     buckets are keyed by workspace axis names ('Color'); mapping goes
 *     through axisSynonymKey and the values are matched case-insensitively
 *     against the live VariationSpecificsSet. Unmatched values are surfaced
 *     as warnings, never silently dropped.
 *   • 12 pictures max per variation set AND for the gallery (Trading cap).
 *   • Per-SKU overrides (ListingImage.variationId) have no Trading
 *     equivalent (pictures key on ONE specific value) — warned + skipped.
 *   • A curated axis the listing doesn't declare (or an explicit
 *     '__shared__' pick) folds every bucket into one listing gallery.
 */
import prisma from '../../db.js'
import { ebayAuthService } from '../ebay-auth.service.js'
import {
  callTradingApi,
  escapeXml,
  siteIdForMarket,
} from '../ebay-trading-api.service.js'
import { parseVariationSpecificsSet } from '../ebay-variation-add.service.js'
import { axisSynonymKey } from '../ebay-variation-push.service.js'
import { logger } from '../../utils/logger.js'
import type { EbayInventoryPublishResult } from './ebay-inventory-image-publish.service.js'

const TRADING_PICTURE_CAP = 12
const SHARED_SENTINEL = '__shared__'

// ── pure: curated rows + live specifics → picture payload ────────────────────

export interface CuratedImageRow {
  url: string
  variantGroupKey: string | null
  variantGroupValue: string | null
  variationId: string | null
}

export interface SharedPicturePayload {
  galleryUrls: string[]
  /** LIVE VariationSpecificName to send; null = gallery-only publish. */
  axisName: string | null
  /** LIVE VariationSpecificValue → urls (≤ 12 each). */
  byValue: Record<string, string[]>
  warnings: string[]
  sharedGallery: boolean
  requestedAxis: string | null
}

export function buildSharedPicturePayload(opts: {
  curated: CuratedImageRow[]
  /** Live VariationSpecificsSet from GetItem ({} = non-variation listing). */
  liveSpecificsSet: Record<string, string[]>
  /** Operator's modal pick → stored preference → null. '__shared__' allowed. */
  requestedAxis: string | null
}): SharedPicturePayload {
  const warnings: string[] = []
  const gallery: string[] = []
  const perSkuCount = opts.curated.filter((r) => r.variationId).length
  if (perSkuCount > 0) {
    warnings.push(`${perSkuCount} per-SKU image override${perSkuCount === 1 ? '' : 's'} skipped — adopted Trading listings only support per-${Object.keys(opts.liveSpecificsSet)[0] ?? 'value'} picture sets`)
  }

  // Cover/common bucket → listing gallery (order preserved, capped).
  for (const r of opts.curated) {
    if (r.variationId || r.variantGroupKey) continue
    if (!gallery.includes(r.url)) gallery.push(r.url)
  }

  // Axis-bucket rows grouped by their curated axis key.
  const axisRows = opts.curated.filter((r) => !r.variationId && r.variantGroupKey)
  const curatedAxes = [...new Set(axisRows.map((r) => r.variantGroupKey as string))]

  // Resolve the LIVE axis: explicit shared → none; otherwise the requested
  // axis (or the curated rows' own axis) must synonym-match a declared
  // variation specifics name.
  const liveAxisNames = Object.keys(opts.liveSpecificsSet)
  const matchLive = (axis: string | null): string | null => {
    if (!axis) return null
    const key = axisSynonymKey(axis)
    return liveAxisNames.find((n) => axisSynonymKey(n) === key) ?? null
  }
  const explicitShared = opts.requestedAxis === SHARED_SENTINEL
  let liveAxis: string | null = null
  if (!explicitShared) {
    liveAxis = matchLive(opts.requestedAxis)
    if (!liveAxis) {
      for (const a of curatedAxes) {
        liveAxis = matchLive(a)
        if (liveAxis) break
      }
    }
    if (!liveAxis && axisRows.length > 0) {
      warnings.push(
        liveAxisNames.length === 0
          ? 'Listing has no variations — curated sets folded into one listing gallery'
          : `Listing declares no matching image axis (live: ${liveAxisNames.join(', ')}) — curated sets folded into one listing gallery`,
      )
    }
  }

  const byValue: Record<string, string[]> = {}
  if (liveAxis && !explicitShared) {
    const liveValues = opts.liveSpecificsSet[liveAxis] ?? []
    const liveByKey = new Map(liveValues.map((v) => [v.trim().toLowerCase(), v]))
    const liveAxisKey = axisSynonymKey(liveAxis)
    for (const r of axisRows) {
      if (axisSynonymKey(r.variantGroupKey as string) !== liveAxisKey) {
        warnings.push(`Set "${r.variantGroupKey}: ${r.variantGroupValue}" ignored — pictures vary by ${liveAxis} on this listing`)
        continue
      }
      const liveVal = liveByKey.get(String(r.variantGroupValue ?? '').trim().toLowerCase())
      if (!liveVal) {
        warnings.push(`No live ${liveAxis} variation "${r.variantGroupValue}" on this listing — that set was skipped`)
        continue
      }
      if (!byValue[liveVal]) byValue[liveVal] = []
      if (!byValue[liveVal].includes(r.url)) byValue[liveVal].push(r.url)
    }
  } else {
    // Shared-gallery mode (explicit, or nothing to vary by): fold buckets
    // into the gallery after the cover images, deduped.
    for (const r of axisRows) {
      if (!gallery.includes(r.url)) gallery.push(r.url)
    }
  }

  // Gallery wins over sets (same rule as the Inventory path) + caps.
  const gallerySet = new Set(gallery)
  for (const [val, urls] of Object.entries(byValue)) {
    const filtered = urls.filter((u) => !gallerySet.has(u))
    if (filtered.length === 0) {
      delete byValue[val]
      continue
    }
    if (filtered.length > TRADING_PICTURE_CAP) {
      warnings.push(`${val}: ${filtered.length} pictures — eBay caps variation sets at ${TRADING_PICTURE_CAP}, extra ones dropped`)
    }
    byValue[val] = filtered.slice(0, TRADING_PICTURE_CAP)
  }
  if (gallery.length > TRADING_PICTURE_CAP) {
    warnings.push(`Gallery: ${gallery.length} pictures — eBay caps the listing gallery at ${TRADING_PICTURE_CAP}, extra ones dropped`)
  }

  const hasSets = Object.keys(byValue).length > 0
  return {
    galleryUrls: gallery.slice(0, TRADING_PICTURE_CAP),
    axisName: hasSets ? liveAxis : null,
    byValue,
    warnings,
    sharedGallery: !hasSets,
    requestedAxis: opts.requestedAxis,
  }
}

// ── pure: payload → ReviseFixedPriceItem XML ─────────────────────────────────

export function buildReviseItemPicturesXml(opts: {
  itemId: string
  galleryUrls: string[]
  axisName?: string | null
  byValue?: Record<string, string[]>
}): string {
  const galleryXml = opts.galleryUrls.length
    ? `    <PictureDetails>\n${opts.galleryUrls
        .map((u) => `      <PictureURL>${escapeXml(u)}</PictureURL>`)
        .join('\n')}\n    </PictureDetails>\n`
    : ''
  let picturesXml = ''
  const byValue = opts.byValue ?? {}
  if (opts.axisName && Object.keys(byValue).length > 0) {
    const sets = Object.entries(byValue)
      .filter(([, urls]) => urls.length > 0)
      .map(([value, urls]) => {
        const pics = urls.map((u) => `          <PictureURL>${escapeXml(u)}</PictureURL>`).join('\n')
        return `        <VariationSpecificPictureSet>
          <VariationSpecificValue>${escapeXml(value)}</VariationSpecificValue>
${pics}
        </VariationSpecificPictureSet>`
      })
      .join('\n')
    picturesXml = `    <Variations>
      <Pictures>
        <VariationSpecificName>${escapeXml(opts.axisName)}</VariationSpecificName>
${sets}
      </Pictures>
    </Variations>\n`
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <Item>
    <ItemID>${escapeXml(opts.itemId)}</ItemID>
${galleryXml}${picturesXml}  </Item>
</ReviseFixedPriceItemRequest>`
}

// ── orchestrator ─────────────────────────────────────────────────────────────

/**
 * Publish curated eBay images for a listing whose live presence is a Trading
 * ItemID: EBAY_LISTING_SHELL products (memberships carry the ItemID) and
 * plain single-SKU products with Product.ebayItemId. Result shape mirrors
 * publishEbayImagesViaInventory so every caller/modal renders it unchanged.
 */
export async function publishEbaySharedListingImages(
  productId: string,
  marketplace?: string,
  activeAxis?: string,
): Promise<EbayInventoryPublishResult> {
  const fail = (message: string, error: string): EbayInventoryPublishResult => ({
    success: false, message, pictureCount: 0, colorSetCount: 0, error,
  })

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, sku: true, ebayItemId: true, imageAxisPreference: true, productType: true },
  })
  if (!product) throw new Error(`Product ${productId} not found`)

  // Normalise to the membership convention ('UK', not 'GB').
  const wantMarket = marketplace
    ? (marketplace.toUpperCase() === 'GB' ? 'UK' : marketplace.toUpperCase())
    : null

  // Resolve live targets: memberships first (shells), then the legacy
  // Product.ebayItemId (plain single-listing products).
  const memberships = await prisma.sharedListingMembership.findMany({
    where: {
      parentSku: product.sku ?? '',
      status: 'ACTIVE',
      ...(wantMarket ? { marketplace: wantMarket } : {}),
    },
    select: { marketplace: true, itemId: true },
  })
  const targets = [...new Map(memberships.map((m) => [`${m.marketplace}:${m.itemId}`, { marketplace: m.marketplace, itemId: m.itemId }])).values()]
  if (targets.length === 0 && product.ebayItemId) {
    targets.push({ marketplace: wantMarket ?? 'IT', itemId: product.ebayItemId })
  }
  if (targets.length === 0) {
    return fail(
      wantMarket
        ? `No live eBay ${wantMarket} listing found for ${product.sku} — publish the listing from the flat-file page first, then push images.`
        : `No live eBay listing found for ${product.sku} — publish the listing from the flat-file page first, then push images.`,
      'No live ItemID',
    )
  }

  const curated = await prisma.listingImage.findMany({
    where: { productId, platform: 'EBAY', mediaType: 'IMAGE' },
    orderBy: { position: 'asc' },
    select: { url: true, variantGroupKey: true, variantGroupValue: true, variationId: true },
  })
  if (curated.length === 0) {
    return fail('No eBay images curated for this listing yet — assign images in the drawer, Save, then Publish.', 'No curated images')
  }

  const connection = await prisma.channelConnection.findFirst({
    where: { channelType: 'EBAY', isActive: true },
    select: { id: true },
  })
  if (!connection) return fail('No active eBay connection found', 'No connection')
  let token: string
  try {
    token = await ebayAuthService.getValidToken(connection.id)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return fail(`eBay auth failed: ${msg}`, msg)
  }

  const requestedAxis = activeAxis ?? product.imageAxisPreference ?? null
  const job = await prisma.channelImagePublishJob.create({
    data: {
      productId,
      channel: 'EBAY',
      marketplace: wantMarket,
      status: 'SUBMITTING',
      vendorEntityId: targets.map((t) => t.itemId).join(','),
      requestPayload: { lane: 'TRADING_SHELL', targets, requestedAxis } as object,
    },
  })

  const allResults: Array<{ sku: string; market: string; status: string; message: string }> = []
  const warnings: string[] = []
  let liveAxisUsed: string | null = null
  let sharedGallery = true
  let pictureCount = 0
  let colorSetCount = 0

  for (const target of targets) {
    const siteId = siteIdForMarket(target.marketplace === 'UK' ? 'UK' : target.marketplace)
    try {
      const got = await callTradingApi('GetItem', `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ItemID>${escapeXml(target.itemId)}</ItemID>
</GetItemRequest>`, { oauthToken: token, siteId })
      const liveSet = parseVariationSpecificsSet(got.raw)

      const payload = buildSharedPicturePayload({
        curated,
        liveSpecificsSet: liveSet,
        requestedAxis,
      })
      warnings.push(...payload.warnings)
      liveAxisUsed = payload.axisName ?? liveAxisUsed
      sharedGallery = sharedGallery && payload.sharedGallery

      if (payload.galleryUrls.length === 0 && Object.keys(payload.byValue).length === 0) {
        allResults.push({ sku: target.itemId, market: target.marketplace, status: 'ERROR', message: 'Nothing to publish after axis/value mapping' })
        continue
      }

      const xml = buildReviseItemPicturesXml({
        itemId: target.itemId,
        galleryUrls: payload.galleryUrls,
        axisName: payload.axisName,
        byValue: payload.byValue,
      })
      await callTradingApi('ReviseFixedPriceItem', xml, { oauthToken: token, siteId })
      pictureCount += payload.galleryUrls.length + Object.values(payload.byValue).reduce((n, u) => n + u.length, 0)
      colorSetCount = Math.max(colorSetCount, Object.keys(payload.byValue).length)
      allResults.push({
        sku: target.itemId,
        market: target.marketplace,
        status: 'PUSHED',
        message: `gallery ${payload.galleryUrls.length}${payload.axisName ? ` + ${Object.keys(payload.byValue).length} ${payload.axisName} sets` : ''}`,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      allResults.push({ sku: target.itemId, market: target.marketplace, status: 'ERROR', message: msg })
    }
  }

  const errors = allResults.filter((r) => r.status === 'ERROR')
  const success = errors.length === 0 && allResults.length > 0

  await prisma.listingImage.updateMany({
    where: { productId, platform: 'EBAY' },
    data: success
      ? { publishStatus: 'PUBLISHED', publishedAt: new Date(), publishError: null }
      : { publishStatus: 'ERROR', publishError: (errors[0]?.message ?? 'eBay publish failed').slice(0, 500) },
  })
  await prisma.channelImagePublishJob.update({
    where: { id: job.id },
    data: success
      ? { status: 'DONE', completedAt: new Date(), response: { results: allResults, warnings } as object }
      : { status: 'FATAL', completedAt: new Date(), errorMessage: (errors[0]?.message ?? 'eBay publish failed').slice(0, 500), response: { results: allResults, warnings } as object },
  })

  logger.info('[ebay-shared-image-publish]', {
    productId, sku: product.sku, targets, success, pictureCount, colorSetCount, warnings: warnings.length,
  })

  const marketsOut = [...new Set(allResults.map((r) => r.market))]
  return {
    success,
    message: success
      ? (sharedGallery
          ? `Published images to live eBay listing${targets.length === 1 ? '' : 's'} ${targets.map((t) => t.itemId).join(', ')} (${marketsOut.join(', ')}) · ONE shared gallery`
          : `Published images to live eBay listing${targets.length === 1 ? '' : 's'} ${targets.map((t) => t.itemId).join(', ')} (${marketsOut.join(', ')}) · vary by ${liveAxisUsed} (${colorSetCount} sets)`)
      : `eBay publish failed: ${errors[0]?.message ?? 'unknown error'}`,
    pictureCount,
    colorSetCount,
    jobId: job.id,
    markets: marketsOut,
    results: allResults,
    requestedAxis: requestedAxis ?? undefined,
    pictureAxis: liveAxisUsed,
    sharedGallery,
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(success ? {} : { error: errors[0]?.message }),
  }
}
