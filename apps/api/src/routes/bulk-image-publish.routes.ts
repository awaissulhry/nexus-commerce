/**
 * PB.14 — Bulk image publish across products.
 *
 *   POST /api/products/bulk-image-publish
 *     body (legacy shape): { productIds: string[], channel: 'AMAZON'|'EBAY'|'SHOPIFY',
 *                            marketplace?: 'IT'|'DE'|'FR'|'ES'|'UK'|'ALL' }
 *     body (EFX P6 items shape):
 *       { items: [{ productId, activeAxis?, marketplace? }], channel, marketplace? }
 *     → { results: Array<{ productId, ok, message?, …per-channel extras }>, summary }
 *
 * EFX P6 — the items shape lets the eBay flat-file images drawer send ONE
 * request for the whole sheet, carrying each family's chosen image axis
 * ('__shared__' included) and the drawer's publish market. Per-item
 * marketplace wins over the body-level one; per-item activeAxis is forwarded
 * to publishEbayImagesViaInventory (omitted → the service falls back to the
 * stored imageAxisPreference). eBay results echo the service's P5
 * resolved-axis fields (requestedAxis / pictureAxis / sharedGallery /
 * realAxes / warnings) so the drawer can render honest per-family feedback.
 * The legacy plain-ids shape is unchanged EXCEPT that a provided marketplace
 * is now honored for EBAY too (market-specific publish — the all-markets
 * fan-out was the FFP.7 25007 footgun; the only existing caller sends
 * marketplace: null for EBAY, which keeps the legacy fan-out).
 *
 * Loops sequentially, dispatching the matching per-product publish service.
 * Failures are caught + recorded per product; the loop continues so a single
 * bad product doesn't tank the whole batch.
 *
 * Hard cap: 50 products per call. Operators with bigger batches should chunk
 * via the FE.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { submitAmazonImageFeed } from '../services/images/amazon-image-feed.service.js'
// FFP.7 — the Trading-API path (publishEbayImages) is a permanent no-op for
// Inventory-listed products (ebayItemId is null); use the real Inventory push.
import { publishEbayImagesViaInventory } from '../services/images/ebay-inventory-image-publish.service.js'
import { publishShopifyImages } from '../services/images/shopify-image-publish.service.js'
import { recordImagePublishAudit } from '../utils/image-publish-audit.js'

const MAX_PER_CALL = 50

interface PerProductResult {
  productId: string
  ok: boolean
  message?: string
  jobId?: string
  perMarket?: Array<{ marketplace: string; ok: boolean; jobId?: string; error?: string }>
  // EFX P6 — eBay extras (additive): counts + P5 resolved-axis feedback.
  pictureCount?: number
  colorSetCount?: number
  markets?: string[]
  requestedAxis?: string
  pictureAxis?: string | null
  realAxes?: string[]
  sharedGallery?: boolean
  warnings?: string[]
}

/** Normalized publish unit — one per requested product. */
interface PublishEntry {
  productId: string
  activeAxis?: string
  /** Uppercased; per-item value wins over the body-level marketplace. */
  marketplace?: string
}

const AMAZON_MARKETS = ['IT', 'DE', 'FR', 'ES', 'UK'] as const
const VALID_AMAZON = ['IT', 'DE', 'FR', 'ES', 'UK', 'ALL'] as const

interface BulkBody {
  productIds?: string[]
  items?: Array<{ productId?: unknown; activeAxis?: unknown; marketplace?: unknown }>
  channel?: string
  marketplace?: string
}

const bulkImagePublishRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: BulkBody }>(
    '/products/bulk-image-publish',
    async (req, reply) => {
      const channel = (req.body?.channel ?? '').toUpperCase()
      const bodyMarketplace = req.body?.marketplace ? req.body.marketplace.toUpperCase() : null

      // ── Normalize both body shapes into PublishEntry[] ──────────────────
      const rawItems = Array.isArray(req.body?.items) ? req.body!.items : null
      const entries: PublishEntry[] = rawItems
        ? rawItems
            .filter((i): i is { productId: string; activeAxis?: unknown; marketplace?: unknown } =>
              !!i && typeof i.productId === 'string' && i.productId.length > 0)
            .map((i) => ({
              productId: i.productId,
              activeAxis: typeof i.activeAxis === 'string' && i.activeAxis ? i.activeAxis : undefined,
              marketplace: typeof i.marketplace === 'string' && i.marketplace ? i.marketplace.toUpperCase() : undefined,
            }))
        : (Array.isArray(req.body?.productIds) ? req.body!.productIds! : [])
            .filter((id): id is string => typeof id === 'string' && id.length > 0)
            .map((id) => ({ productId: id }))

      if (entries.length === 0) {
        return reply.code(400).send({ error: 'PRODUCT_IDS_REQUIRED' })
      }
      if (entries.length > MAX_PER_CALL) {
        return reply.code(400).send({
          error: 'TOO_MANY',
          message: `Max ${MAX_PER_CALL} products per call; chunk larger batches client-side.`,
        })
      }
      if (!['AMAZON', 'EBAY', 'SHOPIFY'].includes(channel)) {
        return reply.code(400).send({ error: 'INVALID_CHANNEL' })
      }
      // AMAZON needs a valid marketplace for EVERY entry (per-item override
      // OR the body-level fallback).
      if (channel === 'AMAZON') {
        const bad = entries.some((e) => {
          const m = e.marketplace ?? bodyMarketplace
          return !m || !(VALID_AMAZON as readonly string[]).includes(m)
        })
        if (bad) return reply.code(400).send({ error: 'INVALID_MARKETPLACE' })
      }

      // Sanity-check the IDs exist + dedupe in one shot.
      const found = await prisma.product.findMany({
        where: { id: { in: entries.map((e) => e.productId) } },
        select: { id: true },
      })
      const validIds = new Set(found.map((p) => p.id))

      const results: PerProductResult[] = []

      for (const entry of entries) {
        const { productId } = entry
        const marketplace = entry.marketplace ?? bodyMarketplace
        if (!validIds.has(productId)) {
          results.push({ productId, ok: false, message: 'Product not found' })
          continue
        }
        // PB.16 — Audit log on bulk publish entry. One row per (productId,
        // channel) so the operator can filter by action='imagePublishBulk'.
        void recordImagePublishAudit({
          productId,
          action: 'imagePublishBulk',
          channel: channel as 'AMAZON' | 'EBAY' | 'SHOPIFY',
          marketplace,
          metadata: {
            batchSize: entries.length,
            ...(entry.activeAxis ? { activeAxis: entry.activeAxis } : {}),
          },
        })
        try {
          if (channel === 'AMAZON') {
            const markets = marketplace === 'ALL'
              ? AMAZON_MARKETS
              : [marketplace as typeof AMAZON_MARKETS[number]]
            const perMarket: PerProductResult['perMarket'] = []
            for (const m of markets) {
              try {
                const out = await submitAmazonImageFeed({ productId, marketplace: m })
                perMarket.push({ marketplace: m, ok: true, jobId: out.jobId })
              } catch (err) {
                perMarket.push({
                  marketplace: m,
                  ok: false,
                  error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
                })
              }
            }
            const okCount = perMarket.filter((p) => p.ok).length
            results.push({
              productId,
              ok: okCount > 0,
              perMarket,
              message: okCount === markets.length
                ? `Queued for ${okCount} market${okCount === 1 ? '' : 's'}`
                : `Partial: ${okCount}/${markets.length} markets queued`,
            })
          } else if (channel === 'EBAY') {
            // EFX P6 — forward the per-item marketplace + axis. marketplace
            // undefined keeps the service's legacy all-priced-markets fan-out;
            // activeAxis undefined falls back to the stored imageAxisPreference.
            const out = await publishEbayImagesViaInventory(productId, marketplace ?? undefined, entry.activeAxis)
            results.push({
              productId,
              ok: out.success,
              message: out.message,
              pictureCount: out.pictureCount,
              colorSetCount: out.colorSetCount,
              markets: out.markets,
              requestedAxis: out.requestedAxis,
              pictureAxis: out.pictureAxis,
              realAxes: out.realAxes,
              sharedGallery: out.sharedGallery,
              warnings: out.warnings,
            })
          } else if (channel === 'SHOPIFY') {
            const out = await publishShopifyImages(productId)
            results.push({
              productId,
              ok: out.success,
              message: out.message,
            })
          }
        } catch (err) {
          results.push({
            productId,
            ok: false,
            message: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
          })
        }
      }

      const totalOk = results.filter((r) => r.ok).length
      return reply.send({
        results,
        summary: {
          total: entries.length,
          ok: totalOk,
          failed: entries.length - totalOk,
        },
      })
    },
  )
}

export default bulkImagePublishRoutes
