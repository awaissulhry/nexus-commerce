/**
 * Phase F — image resolution cascade.
 *
 * Resolves the effective image set for a (productId, platform,
 * marketplace, variationId?) tuple by walking from most-specific to
 * most-general:
 *
 *   1. variationId + MARKETPLACE   (most specific)
 *   2. variationId + PLATFORM
 *   3. variationId + GLOBAL
 *   4. (no variation) + MARKETPLACE
 *   5. (no variation) + PLATFORM
 *   6. (no variation) + GLOBAL      (most general)
 *   7. ProductImage master gallery   (final fallback)
 *
 * The first level that returns at least one row wins — this is how
 * the dedicated image-manager page (separate from the wizard) layers
 * platform/marketplace overrides without losing the global default.
 *
 * The wizard itself doesn't write ListingImage rows yet (that's the
 * job of the dedicated image-manager page). Until ListingImage has
 * any rows, the resolution always falls through to ProductImage,
 * which is the master gallery editable on the product page.
 */

import type { PrismaClient } from '@nexus/database'

export type ImageScope = 'GLOBAL' | 'PLATFORM' | 'MARKETPLACE'
export type ImageRole =
  | 'MAIN'
  | 'GALLERY'
  | 'INFOGRAPHIC'
  | 'LIFESTYLE'
  | 'SIZE_CHART'
  | 'SWATCH'

export interface ResolvedImage {
  id: string
  url: string
  filename: string | null
  position: number
  role: ImageRole
  width: number | null
  height: number | null
  fileSize: number | null
  mimeType: string | null
  hasWhiteBackground: boolean | null
  /** Where this image originated. 'product_master' = ProductImage
   *  fallback (no ListingImage row yet); the rest are ListingImage
   *  scopes. */
  source:
    | 'product_master'
    | 'variation_marketplace'
    | 'variation_platform'
    | 'variation_global'
    | 'marketplace'
    | 'platform'
    | 'global'
}

export class ImageResolutionService {
  constructor(private readonly prisma: PrismaClient) {}

  async resolveForChannel(opts: {
    productId: string
    platform: string
    marketplace: string
    variationId?: string | null
  }): Promise<ResolvedImage[]> {
    const platform = opts.platform.toUpperCase()
    const marketplace = opts.marketplace.toUpperCase()
    const variationId = opts.variationId ?? null

    // Cascade levels — returned source label tracks which level matched.
    const cascade: Array<{
      where: any
      source: ResolvedImage['source']
    }> = []
    if (variationId) {
      cascade.push(
        {
          where: {
            productId: opts.productId,
            variationId,
            scope: 'MARKETPLACE',
            platform,
            marketplace,
          },
          source: 'variation_marketplace',
        },
        {
          where: {
            productId: opts.productId,
            variationId,
            scope: 'PLATFORM',
            platform,
          },
          source: 'variation_platform',
        },
        {
          where: {
            productId: opts.productId,
            variationId,
            scope: 'GLOBAL',
          },
          source: 'variation_global',
        },
      )
    }
    cascade.push(
      {
        where: {
          productId: opts.productId,
          variationId: null,
          scope: 'MARKETPLACE',
          platform,
          marketplace,
        },
        source: 'marketplace',
      },
      {
        where: {
          productId: opts.productId,
          variationId: null,
          scope: 'PLATFORM',
          platform,
        },
        source: 'platform',
      },
      {
        where: {
          productId: opts.productId,
          variationId: null,
          scope: 'GLOBAL',
        },
        source: 'global',
      },
    )

    for (const level of cascade) {
      const rows = await this.prisma.listingImage.findMany({
        where: level.where,
        orderBy: { position: 'asc' },
      })
      if (rows.length > 0) {
        return rows.map((r) => ({
          id: r.id,
          url: r.url,
          filename: r.filename,
          position: r.position,
          role: r.role as ImageRole,
          width: r.width,
          height: r.height,
          fileSize: r.fileSize,
          mimeType: r.mimeType,
          hasWhiteBackground: r.hasWhiteBackground,
          source: level.source,
        }))
      }
    }

    // Final fallback — ProductImage master gallery. ProductImage has
    // a smaller set of columns; we map type→role and use createdAt
    // ordering as the implicit position.
    const masterRows = await this.prisma.productImage.findMany({
      where: { productId: opts.productId },
      orderBy: [{ type: 'asc' }, { createdAt: 'asc' }],
    })
    if (masterRows.length === 0) return []
    // ProductImage.type values: MAIN | ALT | LIFESTYLE | SWATCH (per
    // schema). Sort MAIN first then everything else.
    const main = masterRows.filter((r) => r.type === 'MAIN')
    const rest = masterRows.filter((r) => r.type !== 'MAIN')
    const sorted = [...main, ...rest]
    return sorted.map((r, idx) => ({
      id: r.id,
      url: r.url,
      filename: null,
      position: idx,
      role: mapMasterTypeToRole(r.type),
      width: null,
      height: null,
      fileSize: null,
      mimeType: null,
      hasWhiteBackground: null,
      source: 'product_master',
    }))
  }
}

function mapMasterTypeToRole(type: string): ImageRole {
  const upper = type.toUpperCase()
  if (upper === 'MAIN') return 'MAIN'
  if (upper === 'LIFESTYLE') return 'LIFESTYLE'
  if (upper === 'SWATCH') return 'SWATCH'
  if (upper === 'INFOGRAPHIC') return 'INFOGRAPHIC'
  return 'GALLERY'
}
