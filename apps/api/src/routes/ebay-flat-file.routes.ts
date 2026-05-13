/**
 * eBay Flat-File Spreadsheet API
 *
 * Endpoints that power the /products/ebay-flat-file page:
 *
 *   GET  /api/ebay/flat-file/rows            — load ChannelListing rows for EBAY+marketplace
 *   PATCH /api/ebay/flat-file/rows           — upsert ChannelListing records
 *   POST /api/ebay/flat-file/push            — push rows to eBay (api or feed mode)
 *   GET  /api/ebay/flat-file/feed/:taskId    — poll Sell Feed task status
 *   GET  /api/ebay/flat-file/amazon-import   — Amazon ChannelListing pre-fill data
 */

import type { FastifyInstance } from 'fastify';
import { Prisma } from '@nexus/database';
import prisma from '../db.js';
import { ebayAuthService } from '../services/ebay-auth.service.js';
import {
  buildInventoryNdjson,
  createInventoryTask,
  uploadFeedFile,
  getTaskStatus,
  type EbayFlatRow,
} from '../services/ebay-feed.service.js';

const EBAY_API_BASE = process.env.EBAY_API_BASE ?? 'https://api.ebay.com';

// ── Helpers ────────────────────────────────────────────────────────────

function toMarketplaceId(marketplace: string): string {
  const MAP: Record<string, string> = {
    IT: 'EBAY_IT',
    DE: 'EBAY_DE',
    FR: 'EBAY_FR',
    ES: 'EBAY_ES',
    UK: 'EBAY_GB',
    GB: 'EBAY_GB',
  };
  return MAP[marketplace.toUpperCase()] ?? `EBAY_${marketplace.toUpperCase()}`;
}

/**
 * Unpacks a ChannelListing DB record into a flat EbayFlatRow for the frontend.
 */
function unpackListing(
  listing: {
    id: string;
    productId: string;
    channelMarket: string;
    externalListingId: string | null;
    platformProductId: string | null;
    title: string | null;
    description: string | null;
    price: { toNumber(): number } | null;
    quantity: number | null;
    platformAttributes: unknown;
    variationTheme: string | null;
    listingStatus: string | null;
    offerActive: boolean;
    updatedAt: Date;
    product: { sku: string; name: string; ean?: string | null };
  },
): EbayFlatRow {
  const attrs = (listing.platformAttributes ?? {}) as Record<string, unknown>;

  const imageUrls = (attrs.imageUrls as string[] | undefined) ?? [];
  const itemSpecifics = (attrs.itemSpecifics as Record<string, string> | undefined) ?? {};

  return {
    _rowId: listing.id,
    _productId: listing.productId,
    sku: listing.product.sku,
    ebay_item_id: listing.externalListingId ?? '',
    ean: listing.product.ean ?? '',
    mpn: '',
    title: listing.title ?? '',
    condition: (attrs.conditionId as string | undefined) ?? 'NEW',
    category_id: (attrs.categoryId as string | undefined) ?? '',
    subtitle: (attrs.subtitle as string | undefined) ?? '',
    description: listing.description ?? '',
    price: listing.price?.toNumber() ?? 0,
    best_offer_enabled: (attrs.bestOffer as boolean | undefined) ?? false,
    best_offer_floor: (attrs.bestOfferFloor as number | undefined) ?? 0,
    best_offer_ceiling: (attrs.bestOfferCeiling as number | undefined) ?? 0,
    quantity: listing.quantity ?? 0,
    handling_time: (attrs.handlingTime as number | undefined) ?? 1,
    image_1: imageUrls[0] ?? '',
    image_2: imageUrls[1] ?? '',
    image_3: imageUrls[2] ?? '',
    image_4: imageUrls[3] ?? '',
    image_5: imageUrls[4] ?? '',
    image_6: imageUrls[5] ?? '',
    brand: itemSpecifics['Brand'] ?? '',
    colour: itemSpecifics['Colour'] ?? '',
    size: itemSpecifics['Size'] ?? '',
    material: itemSpecifics['Material'] ?? '',
    model_number: itemSpecifics['Model Number'] ?? '',
    custom_label: itemSpecifics['Custom Label'] ?? '',
    fulfillment_policy_id: (attrs.fulfillmentPolicyId as string | undefined) ?? '',
    payment_policy_id: (attrs.paymentPolicyId as string | undefined) ?? '',
    return_policy_id: (attrs.returnPolicyId as string | undefined) ?? '',
    listing_status: listing.listingStatus ?? (listing.offerActive ? 'ACTIVE' : 'INACTIVE'),
    last_pushed_at: listing.updatedAt.toISOString(),
    sync_status: listing.offerActive ? 'synced' : 'pending',
    platformProductId: listing.platformProductId ?? listing.id,
  };
}

/**
 * Packs a flat EbayFlatRow back into ChannelListing DB fields.
 */
function packRow(row: EbayFlatRow): {
  title: string;
  description: string;
  price: number;
  quantity: number;
  externalListingId: string | null;
  platformProductId: string | null;
  listingStatus: string;
  offerActive: boolean;
  platformAttributes: Prisma.InputJsonValue;
} {
  const imageUrls: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const url = row[`image_${i}`] as string | undefined;
    if (url) imageUrls.push(url);
  }

  const itemSpecifics: Record<string, string> = {};
  if (row.brand) itemSpecifics['Brand'] = row.brand;
  if (row.colour) itemSpecifics['Colour'] = row.colour;
  if (row.size) itemSpecifics['Size'] = row.size;
  if (row.material) itemSpecifics['Material'] = row.material;
  if (row.model_number) itemSpecifics['Model Number'] = row.model_number;
  if (row.custom_label) itemSpecifics['Custom Label'] = row.custom_label;

  return {
    title: row.title ?? '',
    description: row.description ?? '',
    price: Number(row.price ?? 0),
    quantity: Number(row.quantity ?? 0),
    externalListingId: row.ebay_item_id || null,
    platformProductId: row.platformProductId || null,
    listingStatus: row.listing_status ?? 'DRAFT',
    offerActive: row.listing_status === 'ACTIVE',
    platformAttributes: {
      conditionId: row.condition ?? 'NEW',
      categoryId: row.category_id ?? '',
      subtitle: row.subtitle ?? '',
      imageUrls,
      itemSpecifics,
      handlingTime: Number(row.handling_time ?? 1),
      bestOffer: Boolean(row.best_offer_enabled),
      bestOfferFloor: Number(row.best_offer_floor ?? 0),
      bestOfferCeiling: Number(row.best_offer_ceiling ?? 0),
      fulfillmentPolicyId: row.fulfillment_policy_id ?? '',
      paymentPolicyId: row.payment_policy_id ?? '',
      returnPolicyId: row.return_policy_id ?? '',
    } as Prisma.InputJsonValue,
  };
}

// ── Route plugin ───────────────────────────────────────────────────────

export default async function ebayFlatFileRoutes(fastify: FastifyInstance) {
  // ── GET /api/ebay/flat-file/rows ────────────────────────────────────
  fastify.get<{
    Querystring: { marketplace?: string; familyId?: string }
  }>('/ebay/flat-file/rows', async (request, reply) => {
    const marketplace = (request.query.marketplace ?? 'IT').toUpperCase();
    const familyId = request.query.familyId;

    try {
      const listings = await prisma.channelListing.findMany({
        where: {
          channel: 'EBAY',
          region: marketplace,
          product: { deletedAt: null },
          ...(familyId ? { productId: familyId } : {}),
        },
        include: {
          product: {
            select: { sku: true, name: true, ean: true },
          },
        },
        orderBy: [{ platformProductId: 'asc' }, { product: { sku: 'asc' } }],
      });

      const rows = listings.map((l) =>
        unpackListing(l as Parameters<typeof unpackListing>[0]),
      );

      return reply.send({ rows, marketplace });
    } catch (err: unknown) {
      request.log.error(err, 'ebay/flat-file/rows failed');
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : 'Failed to load rows' });
    }
  });

  // ── PATCH /api/ebay/flat-file/rows ──────────────────────────────────
  fastify.patch<{
    Body: { rows: EbayFlatRow[] }
  }>('/ebay/flat-file/rows', async (request, reply) => {
    const { rows } = request.body;

    if (!Array.isArray(rows) || rows.length === 0) {
      return reply.code(400).send({ error: 'rows must be a non-empty array' });
    }

    try {
      const results: Array<{ sku: string; id: string; action: 'created' | 'updated' }> = [];

      for (const row of rows) {
        if (!row.sku) continue;

        const packed = packRow(row);

        // Determine productId — look up by sku if not provided
        let productId = row._productId ?? '';
        if (!productId) {
          const product = await prisma.product.findFirst({
            where: { sku: row.sku, deletedAt: null },
            select: { id: true },
          });
          if (!product) {
            request.log.warn({ sku: row.sku }, 'ebay/flat-file/rows: product not found, skipping');
            continue;
          }
          productId = product.id;
        }

        // Check for existing listing by rowId (_rowId is the listing id) or by productId + channel
        const existingById = row._rowId && !row._rowId.startsWith('new-')
          ? await prisma.channelListing.findUnique({ where: { id: row._rowId } })
          : null;

        if (existingById) {
          await prisma.channelListing.update({
            where: { id: existingById.id },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            data: { ...packed, updatedAt: new Date() } as any,
          });
          results.push({ sku: row.sku, id: existingById.id, action: 'updated' });
        } else {
          // Try to find by productId + channelMarket
          const marketplace = String(row._rowId ?? '').includes('EBAY_')
            ? String(row._rowId).split('_')[1]
            : 'IT';

          const existing = await prisma.channelListing.findFirst({
            where: {
              productId,
              channel: 'EBAY',
              channelMarket: `EBAY_${marketplace}`,
            },
          });

          if (existing) {
            await prisma.channelListing.update({
              where: { id: existing.id },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              data: { ...packed, updatedAt: new Date() } as any,
            });
            results.push({ sku: row.sku, id: existing.id, action: 'updated' });
          } else {
            // Create new listing
            const created = await prisma.channelListing.create({
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              data: {
                productId,
                channel: 'EBAY',
                channelMarket: 'EBAY_IT',
                region: 'IT',
                marketplace: 'IT',
                ...packed,
              } as any,
            });
            results.push({ sku: row.sku, id: created.id, action: 'created' });
          }
        }
      }

      return reply.send({ saved: results.length, results });
    } catch (err: unknown) {
      request.log.error(err, 'ebay/flat-file/rows PATCH failed');
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : 'Failed to save rows' });
    }
  });

  // ── POST /api/ebay/flat-file/push ───────────────────────────────────
  fastify.post<{
    Body: { rows: EbayFlatRow[]; marketplace: string; mode?: 'api' | 'feed' }
  }>('/ebay/flat-file/push', async (request, reply) => {
    const { rows, marketplace = 'IT', mode = 'api' } = request.body;

    if (!Array.isArray(rows) || rows.length === 0) {
      return reply.code(400).send({ error: 'rows must be non-empty' });
    }

    const mp = marketplace.toUpperCase();
    const marketplaceId = toMarketplaceId(mp);

    // Get eBay connection
    const connection = await prisma.channelConnection.findFirst({
      where: { channelType: 'EBAY', isActive: true },
      select: { id: true },
    });

    if (!connection) {
      return reply.code(503).send({ error: 'No active eBay connection found. Please connect your eBay account first.' });
    }

    let token: string;
    try {
      token = await ebayAuthService.getValidToken(connection.id);
    } catch (err: unknown) {
      return reply.code(503).send({
        error: `Failed to get eBay token: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // ── Feed mode (≤50 rows → auto api, else feed) ─────────────────
    const effectiveMode = mode === 'feed' || rows.length > 50 ? 'feed' : 'api';

    if (effectiveMode === 'feed') {
      try {
        const ndjson = buildInventoryNdjson(rows);
        const taskId = await createInventoryTask(mp, token);
        await uploadFeedFile(taskId, ndjson, token);

        return reply.send({
          mode: 'feed',
          taskId,
          rowCount: rows.length,
          message: `Feed task created. Poll /api/ebay/flat-file/feed/${taskId}?marketplace=${mp} for status.`,
        });
      } catch (err: unknown) {
        request.log.error(err, 'ebay/flat-file/push feed mode failed');
        return reply.code(500).send({
          error: err instanceof Error ? err.message : 'Feed push failed',
        });
      }
    }

    // ── API mode (per-row Inventory API calls) ──────────────────────
    const perRowResults: Array<{
      sku: string;
      status: 'PUSHED' | 'ERROR';
      message: string;
      itemId?: string;
    }> = [];

    for (const row of rows) {
      if (!row.sku) {
        perRowResults.push({ sku: '', status: 'ERROR', message: 'Missing SKU' });
        continue;
      }

      try {
        // PUT /sell/inventory/v1/inventory_item/{sku}
        const encodedSku = encodeURIComponent(row.sku);
        const invUrl = `${EBAY_API_BASE}/sell/inventory/v1/inventory_item/${encodedSku}`;

        const imageUrls: string[] = [];
        for (let i = 1; i <= 6; i++) {
          const url = row[`image_${i}`] as string | undefined;
          if (url) imageUrls.push(url);
        }

        const aspects: Record<string, string[]> = {};
        if (row.brand) aspects['Brand'] = [row.brand];
        if (row.colour) aspects['Colour'] = [row.colour];
        if (row.size) aspects['Size'] = [row.size];
        if (row.material) aspects['Material'] = [row.material];
        if (row.model_number) aspects['Model Number'] = [row.model_number];
        if (row.custom_label) aspects['Custom Label'] = [row.custom_label];
        if (row.ean) aspects['EAN'] = [row.ean];
        if (row.mpn) aspects['MPN'] = [row.mpn];

        const invBody = {
          product: {
            title: row.title ?? row.sku,
            description: row.description ?? '',
            imageUrls,
            aspects,
            ...(row.ean ? { ean: [row.ean] } : {}),
            ...(row.mpn ? { mpn: row.mpn } : {}),
          },
          condition: row.condition ?? 'NEW',
          availability: {
            shipToLocationAvailability: {
              quantity: Number(row.quantity ?? 0),
            },
          },
        };

        const invRes = await fetch(invUrl, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Language': 'it-IT',
            'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
          },
          body: JSON.stringify(invBody),
        });

        if (!invRes.ok) {
          const errBody = await invRes.text().catch(() => '');
          perRowResults.push({
            sku: row.sku,
            status: 'ERROR',
            message: `Inventory API error ${invRes.status}: ${errBody.slice(0, 200)}`,
          });
          continue;
        }

        // If row has a category_id, also create/update the offer
        if (row.category_id) {
          const offerBody: Record<string, unknown> = {
            sku: row.sku,
            marketplaceId,
            format: 'FIXED_PRICE',
            listingDescription: row.description ?? '',
            categoryId: row.category_id,
            pricingSummary: {
              price: {
                value: String(Number(row.price ?? 0).toFixed(2)),
                currency: 'EUR',
              },
            },
            listingPolicies: {
              ...(row.fulfillment_policy_id ? { fulfillmentPolicyId: row.fulfillment_policy_id } : {}),
              ...(row.payment_policy_id ? { paymentPolicyId: row.payment_policy_id } : {}),
              ...(row.return_policy_id ? { returnPolicyId: row.return_policy_id } : {}),
            },
            quantityLimitPerBuyer: 10,
            ...(row.best_offer_enabled
              ? {
                  bestOfferTerms: {
                    bestOfferEnabled: true,
                    bestOfferAutoAcceptPrice: row.best_offer_ceiling
                      ? { value: String(row.best_offer_ceiling), currency: 'EUR' }
                      : undefined,
                    minimumBestOfferPrice: row.best_offer_floor
                      ? { value: String(row.best_offer_floor), currency: 'EUR' }
                      : undefined,
                  },
                }
              : {}),
          };

          // Check if offer exists
          const getOfferUrl = `${EBAY_API_BASE}/sell/inventory/v1/offer?sku=${encodedSku}&marketplace_id=${marketplaceId}`;
          const getOfferRes = await fetch(getOfferUrl, {
            headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': marketplaceId },
          });

          let offerId: string | null = null;
          if (getOfferRes.ok) {
            const offerData = await getOfferRes.json() as { offers?: Array<{ offerId: string }> };
            offerId = offerData.offers?.[0]?.offerId ?? null;
          }

          if (offerId) {
            // Update existing offer
            await fetch(`${EBAY_API_BASE}/sell/inventory/v1/offer/${offerId}`, {
              method: 'PUT',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
              },
              body: JSON.stringify(offerBody),
            });
          } else {
            // Create new offer
            const createOfferRes = await fetch(`${EBAY_API_BASE}/sell/inventory/v1/offer`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
              },
              body: JSON.stringify(offerBody),
            });

            if (createOfferRes.ok) {
              const offerResp = await createOfferRes.json() as { offerId?: string };
              offerId = offerResp.offerId ?? null;
            }
          }

          // Publish the offer if we have an offerId
          if (offerId) {
            const publishRes = await fetch(
              `${EBAY_API_BASE}/sell/inventory/v1/offer/${offerId}/publish`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${token}`,
                  'Content-Type': 'application/json',
                },
                body: '{}',
              },
            );

            if (publishRes.ok) {
              const pubData = await publishRes.json() as { listingId?: string };
              const itemId = pubData.listingId;

              // Update DB
              if (row._productId) {
                await prisma.channelListing.updateMany({
                  where: { productId: row._productId, channel: 'EBAY', region: mp },
                  data: {
                    externalListingId: itemId,
                    listingStatus: 'ACTIVE',
                    offerActive: true,
                  },
                });
              }

              perRowResults.push({ sku: row.sku, status: 'PUSHED', message: 'Listed', itemId });
              continue;
            }
          }
        }

        perRowResults.push({ sku: row.sku, status: 'PUSHED', message: 'Inventory updated' });
      } catch (err: unknown) {
        perRowResults.push({
          sku: row.sku,
          status: 'ERROR',
          message: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    const pushed = perRowResults.filter((r) => r.status === 'PUSHED').length;
    const errors = perRowResults.filter((r) => r.status === 'ERROR').length;

    return reply.send({
      mode: 'api',
      pushed,
      errors,
      results: perRowResults,
    });
  });

  // ── GET /api/ebay/flat-file/feed/:taskId ────────────────────────────
  fastify.get<{
    Params: { taskId: string };
    Querystring: { marketplace?: string }
  }>('/ebay/flat-file/feed/:taskId', async (request, reply) => {
    const { taskId } = request.params;

    const connection = await prisma.channelConnection.findFirst({
      where: { channelType: 'EBAY', isActive: true },
      select: { id: true },
    });

    if (!connection) {
      return reply.code(503).send({ error: 'No active eBay connection' });
    }

    try {
      const token = await ebayAuthService.getValidToken(connection.id);
      const status = await getTaskStatus(taskId, token);
      return reply.send({ taskId, ...status });
    } catch (err: unknown) {
      request.log.error(err, 'ebay/flat-file/feed poll failed');
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : 'Poll failed' });
    }
  });

  // ── GET /api/ebay/flat-file/amazon-import ───────────────────────────
  // Returns Amazon ChannelListing data mapped to eBay fields for pre-fill.
  fastify.get<{
    Querystring: { marketplace?: string; productIds?: string }
  }>('/ebay/flat-file/amazon-import', async (request, reply) => {
    const marketplace = (request.query.marketplace ?? 'IT').toUpperCase();
    const productIds = request.query.productIds
      ? request.query.productIds.split(',').filter(Boolean)
      : [];

    try {
      const amazonListings = await prisma.channelListing.findMany({
        where: {
          channel: 'AMAZON',
          region: marketplace,
          product: { deletedAt: null },
          ...(productIds.length > 0 ? { productId: { in: productIds } } : {}),
        },
        include: {
          product: { select: { sku: true, name: true, ean: true } },
        },
      });

      // Map Amazon fields to eBay field names
      const rows = amazonListings.map((l) => {
        const attrs = (l.platformAttributes ?? {}) as Record<string, unknown>;
        const bulletPoints = (attrs.bullet_points ?? attrs.bulletPoints ?? []) as string[];
        const imageUrls = (attrs.main_product_image_locator ?? attrs.imageUrls ?? []) as string[];

        return {
          _productId: l.productId,
          sku: l.product.sku,
          ean: l.product.ean ?? '',
          mpn: '',
          // Amazon title → eBay title (truncate to 80 chars)
          amazon_title: l.title ?? '',
          title: (l.title ?? '').slice(0, 80),
          // Amazon description → eBay description (combine bullets)
          amazon_description: l.description ?? '',
          description: [l.description ?? '', ...bulletPoints].filter(Boolean).join('<br>'),
          // Amazon price → eBay price
          amazon_price: l.price?.toNumber() ?? 0,
          price: l.price?.toNumber() ?? 0,
          // Quantity
          amazon_quantity: l.quantity ?? 0,
          quantity: l.quantity ?? 0,
          // Images
          image_1: imageUrls[0] ?? '',
          image_2: imageUrls[1] ?? '',
          image_3: imageUrls[2] ?? '',
          image_4: imageUrls[3] ?? '',
          image_5: imageUrls[4] ?? '',
          image_6: imageUrls[5] ?? '',
          // Item specifics from Amazon attrs
          brand: (attrs.brand as string | undefined) ?? '',
          colour: (attrs.color ?? attrs.colour) as string ?? '',
          size: (attrs.size ?? attrs.size_name) as string ?? '',
          material: (attrs.material ?? attrs.material_type) as string ?? '',
          model_number: (attrs.model_number ?? attrs.part_number) as string ?? '',
        };
      });

      return reply.send({ rows, marketplace, source: 'AMAZON' });
    } catch (err: unknown) {
      request.log.error(err, 'ebay/flat-file/amazon-import failed');
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : 'Amazon import failed' });
    }
  });
}
