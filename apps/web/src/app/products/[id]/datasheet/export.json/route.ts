/**
 * ATM.14 — JSON export route.
 *
 * GET /products/[id]/datasheet/export.json
 *
 * Returns a single audit-grade JSON payload aggregating everything
 * the datasheet hub surfaces across its tabs: master Product
 * fields, all ProductTranslations, all ChannelListings (incl
 * follow-master flags + masterX mirrors), ProductCertificates,
 * review aggregates, and the latest ListingQualitySnapshot per
 * (channel, marketplace).
 *
 * The shape is intentionally OPEN — operators paste this into a
 * spreadsheet or feed it to a distributor's data team without
 * needing schema docs. Every property is named to match what the
 * UI shows. Numeric values are coerced from Prisma Decimal to
 * JS number; Dates are ISO strings.
 *
 * Auth model: today the hub is operator-only and not session-
 * gated separately, so this route inherits the same access. When
 * signed-share-link functionality lands (ATM.14b), the signed
 * token will be validated here.
 *
 * Failure mode: per-table defensive try/catch around each fetch;
 * a missing table on a stale DB returns its slot as `null` /
 * `[]` rather than 500'ing the whole export.
 *
 * The route is intentionally NOT a /api/* path so operators get
 * the friendly URL shape /products/X/datasheet/export.json
 * directly from the hub's Export button.
 */

import { NextResponse } from 'next/server'
import { prisma } from '@nexus/database'

interface ExportPayload {
  schemaVersion: number
  generatedAt: string
  product: Record<string, unknown> | null
  brandSettings: Record<string, unknown> | null
  translations: unknown[]
  channelListings: unknown[]
  certificates: unknown[]
  qualitySnapshots: unknown[]
  reviewStatsByChannel: unknown[]
  variants?: unknown[]
}

const SCHEMA_VERSION = 1

// Recursively coerce Prisma Decimal-typed values to JS numbers so
// JSON.stringify produces "9.99" rather than "9.99" wrapped in
// the Decimal toString quirk.
function serialise<T>(v: T): unknown {
  if (v == null) return v
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString()
    // Prisma Decimal: object with toString() and no .getTime
    // — duck-type check is more reliable than instanceof here
    // since Decimal class isn't directly importable in route
    // handlers without bloating the bundle.
    if (
      'toString' in v &&
      'toFixed' in v &&
      typeof (v as { toFixed: unknown }).toFixed === 'function'
    ) {
      return Number((v as { toString: () => string }).toString())
    }
    if (Array.isArray(v)) return v.map(serialise)
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = serialise(val)
    }
    return out
  }
  return v
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params

  const [
    product,
    brandSettings,
    translations,
    channelListings,
    certificates,
    qualitySnapshots,
    reviewStats,
    children,
  ] = await Promise.all([
    prisma.product
      .findUnique({
        where: { id },
        select: {
          id: true,
          sku: true,
          name: true,
          description: true,
          brand: true,
          manufacturer: true,
          productType: true,
          basePrice: true,
          gtin: true,
          upc: true,
          ean: true,
          amazonAsin: true,
          ebayItemId: true,
          shopifyProductId: true,
          weightValue: true,
          weightUnit: true,
          dimLength: true,
          dimWidth: true,
          dimHeight: true,
          dimUnit: true,
          bulletPoints: true,
          keywords: true,
          categoryAttributes: true,
          status: true,
          fulfillmentMethod: true,
          totalStock: true,
          lowStockThreshold: true,
          isParent: true,
          hsCode: true,
          countryOfOrigin: true,
          ppeCategory: true,
          hazmatClass: true,
          hazmatUnNumber: true,
          version: true,
          updatedAt: true,
          createdAt: true,
        },
      })
      .catch(() => null),
    prisma.brandSettings
      .findFirst({
        select: {
          companyName: true,
          addressLines: true,
          piva: true,
          taxId: true,
          contactEmail: true,
          websiteUrl: true,
        },
      })
      .catch(() => null),
    prisma.productTranslation
      .findMany({
        where: { productId: id },
        orderBy: { language: 'asc' },
        select: {
          language: true,
          name: true,
          description: true,
          bulletPoints: true,
          keywords: true,
          source: true,
          sourceModel: true,
          reviewedAt: true,
          updatedAt: true,
        },
      })
      .catch(() => []),
    prisma.channelListing
      .findMany({
        where: { productId: id },
        orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }],
        select: {
          id: true,
          channel: true,
          marketplace: true,
          externalListingId: true,
          listingStatus: true,
          isPublished: true,
          offerActive: true,
          title: true,
          titleOverride: true,
          followMasterTitle: true,
          masterTitle: true,
          description: true,
          descriptionOverride: true,
          followMasterDescription: true,
          masterDescription: true,
          price: true,
          priceOverride: true,
          followMasterPrice: true,
          masterPrice: true,
          salePrice: true,
          pricingRule: true,
          priceAdjustmentPercent: true,
          quantity: true,
          quantityOverride: true,
          followMasterQuantity: true,
          masterQuantity: true,
          bulletPointsOverride: true,
          followMasterBulletPoints: true,
          masterBulletPoints: true,
          estimatedFbaFee: true,
          referralFeePercent: true,
          lowestCompetitorPrice: true,
          validationStatus: true,
          validationErrors: true,
          lastSyncedAt: true,
          lastSyncStatus: true,
        },
      })
      .catch(() => []),
    prisma.productCertificate
      .findMany({
        where: { productId: id },
        orderBy: [{ expiresAt: 'desc' }, { issuedAt: 'desc' }],
        select: {
          certType: true,
          certNumber: true,
          standard: true,
          issuingBody: true,
          issuedAt: true,
          expiresAt: true,
          fileUrl: true,
        },
      })
      .catch(() => []),
    prisma.listingQualitySnapshot
      .findMany({
        where: { productId: id },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          channel: true,
          marketplace: true,
          overallScore: true,
          dimensions: true,
          createdAt: true,
        },
      })
      .catch(() => []),
    prisma.review
      .groupBy({
        by: ['channel', 'marketplace'],
        where: { productId: id, rating: { not: null } },
        _avg: { rating: true },
        _count: { _all: true },
      })
      .catch(() => []),
    prisma.product
      .findMany({
        where: { parentId: id },
        orderBy: { sku: 'asc' },
        select: {
          id: true,
          sku: true,
          name: true,
          basePrice: true,
          totalStock: true,
          status: true,
          gtin: true,
          amazonAsin: true,
          ebayItemId: true,
          shopifyProductId: true,
          categoryAttributes: true,
        },
      })
      .catch(() => []),
  ])

  if (product == null) {
    return NextResponse.json(
      { error: 'Product not found', id },
      { status: 404 },
    )
  }

  const payload: ExportPayload = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    product: serialise(product) as Record<string, unknown>,
    brandSettings: serialise(brandSettings) as Record<string, unknown> | null,
    translations: serialise(translations) as unknown[],
    channelListings: serialise(channelListings) as unknown[],
    certificates: serialise(certificates) as unknown[],
    qualitySnapshots: serialise(qualitySnapshots) as unknown[],
    reviewStatsByChannel: serialise(reviewStats) as unknown[],
  }
  if (product.isParent && children.length > 0) {
    payload.variants = serialise(children) as unknown[]
  }

  // Content-Disposition so the browser offers Save-As with a
  // useful default filename. The SKU + date are sufficient for an
  // operator to drop the file into their own audit folder
  // structure.
  const dateStamp = new Date().toISOString().slice(0, 10)
  const filename = `${product.sku.replace(/[^A-Za-z0-9_-]/g, '_')}-datasheet-${dateStamp}.json`

  return new NextResponse(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}
