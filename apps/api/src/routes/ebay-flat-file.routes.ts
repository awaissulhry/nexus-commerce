/**
 * eBay Flat-File Spreadsheet API
 *
 * Endpoints that power the /products/ebay-flat-file page:
 *
 *   GET  /api/ebay/flat-file/rows            — load from Product table + join all market ChannelListings
 *   PATCH /api/ebay/flat-file/rows           — update all market ChannelListings from flat row
 *   POST /api/ebay/flat-file/push            — push rows to eBay (api or feed mode, multi-market)
 *   POST /api/ebay/flat-file/publish         — publish offer for selected rows + markets
 *   GET  /api/ebay/flat-file/category-schema — fetch rich aspect schema for a category
 *   GET  /api/ebay/flat-file/category-search — search eBay categories by keyword
 *   GET  /api/ebay/flat-file/feed/:taskId    — poll Sell Feed task status
 *   GET  /api/ebay/flat-file/amazon-import   — Amazon ChannelListing pre-fill data
 */

import type { FastifyInstance } from 'fastify';
import { Prisma } from '@nexus/database';
import prisma from '../db.js';
import { ebayAuthService } from '../services/ebay-auth.service.js';
import { EbayCategoryService } from '../services/ebay-category.service.js';
import { syncActivatedListings } from '../services/listing-activation-sync.service.js';
import { enqueueContentSyncIfEnabled } from '../services/content-auto-publish.service.js';
import { productEventService } from '../services/product-event.service.js';
import {
  buildInventoryNdjson,
  createInventoryTask,
  uploadFeedFile,
  getTaskStatus,
  type EbayFlatRow,
} from '../services/ebay-feed.service.js';

const EBAY_API_BASE = process.env.EBAY_API_BASE ?? 'https://api.ebay.com';

// Singleton category service (holds in-memory cache)
const ebayCategoryService = new EbayCategoryService();

// ── In-memory cache for category schema results (24h) ─────────────────
interface CachedSchema {
  data: unknown;
  ts: number;
}
const schemaCache = new Map<string, CachedSchema>();
const SCHEMA_CACHE_TTL = 24 * 60 * 60 * 1000;

// ── Market constants ───────────────────────────────────────────────────
const MARKETS = ['IT', 'DE', 'FR', 'ES', 'UK'] as const;
type Market = (typeof MARKETS)[number];

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

function toChannelMarket(mp: Market): string {
  if (mp === 'UK') return 'EBAY_GB';
  return `EBAY_${mp}`;
}

/**
 * Build a flat multi-market row from a Product + its eBay ChannelListings.
 */
function buildFlatRow(
  product: {
    id: string;
    sku: string;
    name: string;
    ean: string | null;
    channelListings: Array<{
      id: string;
      region: string;
      externalListingId: string | null;
      title: string | null;
      description: string | null;
      price: { toNumber(): number } | null;
      quantity: number | null;
      platformAttributes: unknown;
      listingStatus: string;
      offerActive: boolean;
      syncStatus: string;
      updatedAt: Date;
      // IN.1 — Inheritance state fields (present at runtime, optional in type)
      followMasterTitle?: boolean | null;
      followMasterDescription?: boolean | null;
      followMasterPrice?: boolean | null;
      followMasterQuantity?: boolean | null;
      followMasterBulletPoints?: boolean | null;
      masterTitle?: string | null;
      masterDescription?: string | null;
      masterPrice?: { toNumber(): number } | null;
      masterQuantity?: number | null;
    }>;
  },
): Record<string, unknown> {
  // Shared fields come from the first listing that has data, or from the product
  const listings = product.channelListings;
  const first = listings[0];
  const firstAttrs = first ? ((first.platformAttributes ?? {}) as Record<string, unknown>) : {};
  const firstImageUrls = (firstAttrs.imageUrls as string[] | undefined) ?? [];

  const row: Record<string, unknown> = {
    _rowId: product.id,
    _productId: product.id,
    _dirty: false,
    _status: 'idle',
    sku: product.sku,
    ean: product.ean ?? '',
    mpn: '',
    // shared listing fields from first listing
    title: first?.title ?? '',
    condition: (firstAttrs.conditionId as string | undefined) ?? 'NEW',
    category_id: (firstAttrs.categoryId as string | undefined) ?? '',
    subtitle: (firstAttrs.subtitle as string | undefined) ?? '',
    description: first?.description ?? '',
    price: first?.price?.toNumber() ?? 0,
    best_offer_enabled: (firstAttrs.bestOffer as boolean | undefined) ?? false,
    best_offer_floor: (firstAttrs.bestOfferFloor as number | undefined) ?? 0,
    best_offer_ceiling: (firstAttrs.bestOfferCeiling as number | undefined) ?? 0,
    quantity: first?.quantity ?? 0,
    handling_time: (firstAttrs.handlingTime as number | undefined) ?? 1,
    image_1: firstImageUrls[0] ?? '',
    image_2: firstImageUrls[1] ?? '',
    image_3: firstImageUrls[2] ?? '',
    image_4: firstImageUrls[3] ?? '',
    image_5: firstImageUrls[4] ?? '',
    image_6: firstImageUrls[5] ?? '',
    fulfillment_policy_id: (firstAttrs.fulfillmentPolicyId as string | undefined) ?? '',
    payment_policy_id: (firstAttrs.paymentPolicyId as string | undefined) ?? '',
    return_policy_id: (firstAttrs.returnPolicyId as string | undefined) ?? '',
    // legacy single-market fields (backward compat)
    listing_status: first?.listingStatus ?? 'DRAFT',
    last_pushed_at: first?.updatedAt.toISOString() ?? '',
    sync_status: first?.syncStatus ?? 'pending',
    ebay_item_id: first?.externalListingId ?? '',
    platformProductId: product.id,
  };

  // Dynamic item specifics from first listing
  const itemSpecifics = (firstAttrs.itemSpecifics as Record<string, string> | undefined) ?? {};
  for (const [key, val] of Object.entries(itemSpecifics)) {
    const colId = `aspect_${key.replace(/\s+/g, '_')}`;
    row[colId] = val;
  }

  // Per-market flat fields
  for (const mp of MARKETS) {
    const listing = listings.find((l) => l.region === mp || l.region === (mp === 'UK' ? 'GB' : mp));
    const attrs = listing ? ((listing.platformAttributes ?? {}) as Record<string, unknown>) : {};
    const prefix = mp.toLowerCase() as Lowercase<Market>;
    row[`${prefix}_price`] = listing?.price?.toNumber() ?? null;
    row[`${prefix}_qty`] = listing?.quantity ?? null;
    row[`${prefix}_item_id`] = listing?.externalListingId ?? null;
    row[`${prefix}_status`] = listing?.listingStatus ?? null;
    row[`${prefix}_listing_id`] = (attrs.offerId as string | undefined) ?? null;
  }

  // IN.1 — Inheritance state from the first (primary) listing.
  // _marketFieldStates provides per-market breakdown for the eBay popover.
  if (first) {
    row._listingId = first.id
    row._fieldStates = {
      price:        (first.followMasterPrice        ?? true) ? 'INHERITED' : 'OVERRIDE',
      title:        (first.followMasterTitle        ?? true) ? 'INHERITED' : 'OVERRIDE',
      description:  (first.followMasterDescription  ?? true) ? 'INHERITED' : 'OVERRIDE',
      quantity:     (first.followMasterQuantity     ?? true) ? 'INHERITED' : 'OVERRIDE',
      bulletPoints: (first.followMasterBulletPoints ?? true) ? 'INHERITED' : 'OVERRIDE',
    }
    row._masterValues = {
      price:       first.masterPrice != null ? first.masterPrice.toNumber() : null,
      title:       first.masterTitle       ?? null,
      description: first.masterDescription ?? null,
      quantity:    first.masterQuantity    ?? null,
    }
    // Per-market override state (price + qty are the key ones for eBay)
    const marketFieldStates: Record<string, Record<string, 'INHERITED' | 'OVERRIDE'>> = {}
    for (const mp of MARKETS) {
      const l = listings.find((x) => x.region === mp || x.region === (mp === 'UK' ? 'GB' : mp))
      if (l) {
        marketFieldStates[mp] = {
          price:    (l.followMasterPrice    ?? true) ? 'INHERITED' : 'OVERRIDE',
          quantity: (l.followMasterQuantity ?? true) ? 'INHERITED' : 'OVERRIDE',
          title:    (l.followMasterTitle    ?? true) ? 'INHERITED' : 'OVERRIDE',
        }
      }
    }
    row._marketFieldStates = marketFieldStates
    // Build list of per-market listing IDs for the reset-per-market action
    const marketListingIds: Record<string, string> = {}
    for (const mp of MARKETS) {
      const l = listings.find((x) => x.region === mp || x.region === (mp === 'UK' ? 'GB' : mp))
      if (l) marketListingIds[mp] = l.id
    }
    row._marketListingIds = marketListingIds
  }

  return row;
}

/**
 * Pack shared listing fields back into ChannelListing DB fields.
 */
function packSharedFields(row: Record<string, unknown>): {
  title: string;
  description: string;
  externalListingId: string | null;
  listingStatus: string;
  offerActive: boolean;
  platformAttributes: Prisma.InputJsonValue;
} {
  const imageUrls: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const url = row[`image_${i}`] as string | undefined;
    if (url) imageUrls.push(url);
  }

  // Collect item specifics from aspect_* keys
  const itemSpecifics: Record<string, string> = {};
  for (const [key, val] of Object.entries(row)) {
    if (key.startsWith('aspect_') && typeof val === 'string' && val) {
      const aspectName = key.slice('aspect_'.length).replace(/_/g, ' ');
      itemSpecifics[aspectName] = val;
    }
  }

  return {
    title: (row.title as string) ?? '',
    description: (row.description as string) ?? '',
    externalListingId: (row.ebay_item_id as string) || null,
    listingStatus: (row.listing_status as string) ?? 'DRAFT',
    offerActive: row.listing_status === 'ACTIVE',
    platformAttributes: {
      conditionId: (row.condition as string) ?? 'NEW',
      categoryId: (row.category_id as string) ?? '',
      subtitle: (row.subtitle as string) ?? '',
      imageUrls,
      itemSpecifics,
      handlingTime: Number(row.handling_time ?? 1),
      bestOffer: Boolean(row.best_offer_enabled),
      bestOfferFloor: Number(row.best_offer_floor ?? 0),
      bestOfferCeiling: Number(row.best_offer_ceiling ?? 0),
      fulfillmentPolicyId: (row.fulfillment_policy_id as string) ?? '',
      paymentPolicyId: (row.payment_policy_id as string) ?? '',
      returnPolicyId: (row.return_policy_id as string) ?? '',
    } as Prisma.InputJsonValue,
  };
}

// ── Variation group push helper ────────────────────────────────────────

async function pushVariationGroup(
  groupKey: string,
  rows: Array<Record<string, unknown>>,
  mp: string,
  token: string,
  apiBase: string,
  marketplaceId: string,
): Promise<{ sku: string; market: string; status: 'PUSHED' | 'ERROR'; message: string; itemId?: string }[]> {
  const results: { sku: string; market: string; status: 'PUSHED' | 'ERROR'; message: string; itemId?: string }[] = []
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Content-Language': 'en-US',
    Accept: 'application/json',
  }

  // Step 1: Create/update each individual inventory item (same as single-row flow)
  for (const row of rows) {
    const sku = row.sku as string
    const aspects: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(row)) {
      if (k.startsWith('aspect_') && v) {
        const aspectName = k.replace('aspect_', '').replace(/_/g, ' ')
          .replace(/\b\w/g, (c: string) => c.toUpperCase())
        aspects[aspectName] = [String(v)]
      }
    }
    if (row.ean) aspects['EAN'] = [String(row.ean)]
    if (row.mpn) aspects['MPN'] = [String(row.mpn)]

    const price = row[`${mp.toLowerCase()}_price`] ?? row.price ?? 0
    const qty   = row[`${mp.toLowerCase()}_qty`]   ?? row.quantity ?? 0

    const itemBody = {
      product: {
        title: row.title,
        description: row.description ?? '',
        imageUrls: [row.image_1, row.image_2, row.image_3].filter(Boolean),
        aspects,
      },
      condition: row.condition ?? 'NEW',
      shipToLocationAvailability: { quantity: Number(qty) },
    }

    const itemRes = await fetch(`${apiBase}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
      method: 'PUT', headers, body: JSON.stringify(itemBody),
    })
    if (!itemRes.ok && itemRes.status !== 204) {
      const err = await itemRes.text().catch(() => '')
      results.push({ sku, market: mp, status: 'ERROR', message: `inventory_item PUT ${itemRes.status}: ${err.slice(0, 200)}` })
      continue
    }
    results.push({ sku, market: mp, status: 'PUSHED', message: 'inventory_item updated' })
  }

  // Step 2: Build variesBy from variation_theme on the first row
  const variationTheme = (rows[0].variation_theme as string | undefined) ?? ''
  const varAspectNames = variationTheme.split(',').map((s: string) => s.trim()).filter(Boolean)

  // Collect all values per variation aspect across all rows
  const specMap = new Map<string, Set<string>>()
  for (const name of varAspectNames) {
    specMap.set(name, new Set())
  }
  for (const row of rows) {
    for (const name of varAspectNames) {
      const key = `aspect_${name.toLowerCase().replace(/\s+/g, '_')}`
      const val = row[key] as string | undefined
      if (val) specMap.get(name)?.add(val)
    }
  }
  const specifications = [...specMap.entries()].map(([name, vals]) => ({ name, values: [...vals] }))

  // Step 3: Create/update the inventory item group
  const groupBody = {
    inventoryItemGroupKey: groupKey,
    title: rows[0].title ?? '',
    description: rows[0].description ?? '',
    imageUrls: [rows[0].image_1, rows[0].image_2, rows[0].image_3].filter(Boolean),
    variesBy: {
      aspectsImageVariesBy: varAspectNames.slice(0, 1), // first aspect drives image variation
      specifications: specifications.length ? specifications : [{ name: 'Model', values: rows.map(r => r.sku as string) }],
    },
    inventoryItems: rows.map(r => ({ sku: r.sku as string })),
  }

  const groupRes = await fetch(`${apiBase}/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`, {
    method: 'PUT', headers, body: JSON.stringify(groupBody),
  })
  if (!groupRes.ok && groupRes.status !== 204) {
    const err = await groupRes.text().catch(() => '')
    return results.map(r => ({ ...r, status: 'ERROR' as const, message: `inventory_item_group PUT ${groupRes.status}: ${err.slice(0, 200)}` }))
  }

  // Step 4: Publish via group
  const publishRes = await fetch(`${apiBase}/sell/inventory/v1/offer/publish_by_inventory_item_group`, {
    method: 'POST', headers,
    body: JSON.stringify({ inventoryItemGroupKey: groupKey, marketplaceId }),
  })

  let listingId: string | undefined
  if (publishRes.ok) {
    const pubData = await publishRes.json().catch(() => ({})) as { listingId?: string }
    listingId = pubData.listingId
  } else {
    const err = await publishRes.text().catch(() => '')
    return results.map(r => ({ ...r, status: 'ERROR' as const, message: `publish_by_group ${publishRes.status}: ${err.slice(0, 200)}` }))
  }

  // Mark all rows PUSHED with the shared listingId
  return results.map(r => ({ ...r, status: 'PUSHED' as const, message: 'pushed as variation group', itemId: listingId }))
}

// ── Route plugin ───────────────────────────────────────────────────────

export default async function ebayFlatFileRoutes(fastify: FastifyInstance) {
  // ── GET /api/ebay/flat-file/rows ────────────────────────────────────
  // Returns one flat row per Product (not per market), with per-market
  // fields prefixed: it_price, de_qty, uk_item_id, etc.
  fastify.get<{
    Querystring: { familyId?: string }
  }>('/ebay/flat-file/rows', async (request, reply) => {
    const { familyId } = request.query;

    try {
      const products = await prisma.product.findMany({
        where: {
          deletedAt: null,
          ...(familyId ? { id: familyId } : {}),
        },
        include: {
          channelListings: {
            where: { channel: 'EBAY' },
          },
        },
        orderBy: { sku: 'asc' },
      });

      const rows = products.map((p) =>
        buildFlatRow(p as Parameters<typeof buildFlatRow>[0]),
      );

      return reply.send({ rows });
    } catch (err: unknown) {
      request.log.error(err, 'ebay/flat-file/rows failed');
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : 'Failed to load rows' });
    }
  });

  // ── GET /api/ebay/flat-file/category-schema ─────────────────────────
  // Returns rich aspect definitions for a category (all aspects: required,
  // recommended, optional). Cached in-memory for 24h.
  fastify.get<{
    Querystring: { categoryId: string; marketplace?: string }
  }>('/ebay/flat-file/category-schema', async (request, reply) => {
    const { categoryId, marketplace = 'EBAY_IT' } = request.query;

    if (!categoryId) {
      return reply.code(400).send({ error: 'categoryId is required' });
    }

    const cacheKey = `${marketplace}:${categoryId}`;
    const cached = schemaCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SCHEMA_CACHE_TTL) {
      return reply.send(cached.data);
    }

    try {
      const richAspects = await ebayCategoryService.getCategoryAspectsRich(
        categoryId,
        marketplace,
        { throwOnError: false },
      );

      // Map EbayAspectRich to column definitions the frontend can consume
      const aspects = richAspects.map((a) => {
        const isEnum = a.mode === 'SELECTION_ONLY' && a.values.length > 0;
        const isNumber = a.dataType === 'NUMBER';
        const kind = isEnum ? 'enum' : isNumber ? 'number' : 'text';
        const label = a.englishName ? `${a.name} (${a.englishName})` : a.name;
        return {
          id: `aspect_${a.name.replace(/\s+/g, '_')}`,
          label,
          kind,
          options: isEnum ? a.values : undefined,
          required: a.required || a.usage === 'REQUIRED',
          recommended: a.usage === 'RECOMMENDED',
          // guidance propagates eBay's usage level so the grid can shade low-priority fields
          guidance: (a.usage === 'REQUIRED' || a.usage === 'RECOMMENDED' || a.usage === 'OPTIONAL')
            ? a.usage : 'OPTIONAL',
          width: isEnum ? 140 : a.maxLength && a.maxLength > 50 ? 200 : 130,
          variantEligible: a.variantEligible,
        };
      });

      const result = { categoryId, marketplace, aspects };
      schemaCache.set(cacheKey, { data: result, ts: Date.now() });

      return reply.send(result);
    } catch (err: unknown) {
      request.log.error(err, 'ebay/flat-file/category-schema failed');
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : 'Failed to fetch category schema' });
    }
  });

  // ── GET /api/ebay/flat-file/category-search ──────────────────────────
  // Search eBay categories by keyword.
  fastify.get<{
    Querystring: { q: string; marketplace?: string }
  }>('/ebay/flat-file/category-search', async (request, reply) => {
    const { q, marketplace = 'EBAY_IT' } = request.query;

    if (!q || q.trim().length < 2) {
      return reply.send({ categories: [] });
    }

    try {
      const items = await ebayCategoryService.searchCategories(
        marketplace,
        q.trim(),
        { throwOnError: false, limit: 15 },
      );

      const categories = items.map((item) => ({
        id: item.productType,
        name: item.displayName.split(' › ').pop() ?? item.displayName,
        path: item.displayName,
        matchScore: item.matchPercentage ?? 0,
      }));

      return reply.send({ categories });
    } catch (err: unknown) {
      request.log.error(err, 'ebay/flat-file/category-search failed');
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : 'Category search failed' });
    }
  });

  // ── PATCH /api/ebay/flat-file/rows ──────────────────────────────────
  // Accept flat rows with market-prefixed fields. For each market,
  // find-or-create the ChannelListing and update it. Creates
  // OutboundSyncQueue entries when price or qty actually changes.
  fastify.patch<{
    Body: { rows: Array<Record<string, unknown>> }
  }>('/ebay/flat-file/rows', async (request, reply) => {
    const { rows } = request.body;

    if (!Array.isArray(rows) || rows.length === 0) {
      return reply.code(400).send({ error: 'rows must be a non-empty array' });
    }

    let saved = 0;

    try {
      for (const row of rows) {
        const sku = row.sku as string;
        if (!sku) continue;

        // Resolve productId
        let productId = (row._productId as string) ?? '';
        if (!productId) {
          const product = await prisma.product.findFirst({
            where: { sku, deletedAt: null },
            select: { id: true },
          });
          if (!product) {
            request.log.warn({ sku }, 'ebay/flat-file/rows PATCH: product not found, skipping');
            continue;
          }
          productId = product.id;
        }

        const sharedPacked = packSharedFields(row);

        // Process each market
        for (const mp of MARKETS) {
          const prefix = mp.toLowerCase() as Lowercase<Market>;
          const newPrice = row[`${prefix}_price`] != null ? Number(row[`${prefix}_price`]) : null;
          const newQty = row[`${prefix}_qty`] != null ? Number(row[`${prefix}_qty`]) : null;
          const itemId = (row[`${prefix}_item_id`] as string | null) ?? null;
          const status = (row[`${prefix}_status`] as string | null) ?? null;

          // Skip if no market-specific data provided at all
          if (newPrice == null && newQty == null && !itemId && !status) continue;

          const region = mp === 'UK' ? 'GB' : mp;
          const channelMarket = toChannelMarket(mp);

          // Find existing listing
          const existing = await prisma.channelListing.findFirst({
            where: { productId, channel: 'EBAY', region },
            select: { id: true, price: true, quantity: true },
          });

          const oldPrice = existing?.price?.toNumber() ?? null;
          const oldQty = existing?.quantity ?? null;

          const listingData = {
            title: sharedPacked.title,
            description: sharedPacked.description,
            price: newPrice ?? undefined,
            quantity: newQty ?? undefined,
            externalListingId: itemId ?? sharedPacked.externalListingId,
            listingStatus: status ?? sharedPacked.listingStatus,
            offerActive: (status ?? sharedPacked.listingStatus) === 'ACTIVE',
            platformAttributes: sharedPacked.platformAttributes,
            updatedAt: new Date(),
          };

          let listingId: string;

          if (existing) {
            await prisma.channelListing.update({
              where: { id: existing.id },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              data: listingData as any,
            });
            listingId = existing.id;
          } else {
            const created = await prisma.channelListing.create({
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              data: {
                productId,
                channel: 'EBAY',
                channelMarket,
                region,
                marketplace: mp,
                ...listingData,
              } as any,
            });
            listingId = created.id;
          }

          // Create OutboundSyncQueue entries only when price or qty actually changed
          const priceChanged = newPrice != null && oldPrice !== newPrice;
          const qtyChanged = newQty != null && oldQty !== newQty;

          if (priceChanged) {
            await prisma.outboundSyncQueue.create({
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              data: {
                channelListingId: listingId,
                targetChannel: 'EBAY' as any,
                targetRegion: region,
                syncStatus: 'PENDING' as any,
                syncType: 'PRICE_UPDATE',
                holdUntil: null,
                payload: { price: newPrice, currency: mp === 'UK' ? 'GBP' : 'EUR' },
              } as any,
            });
          }

          if (qtyChanged) {
            await prisma.outboundSyncQueue.create({
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              data: {
                channelListingId: listingId,
                targetChannel: 'EBAY' as any,
                targetRegion: region,
                syncStatus: 'PENDING' as any,
                syncType: 'QUANTITY_UPDATE',
                holdUntil: null,
                payload: { quantity: newQty },
              } as any,
            });
          }

          // Content auto-publish: title/description changes
          void enqueueContentSyncIfEnabled([listingId])

          // ES.2 — emit FLAT_FILE_IMPORTED event for this product × market.
          void productEventService.emit({
            aggregateId: productId,
            aggregateType: 'Product',
            eventType: 'FLAT_FILE_IMPORTED',
            data: {
              channel: 'EBAY',
              marketplace: mp,
              region,
              channelListingId: listingId,
              ...(priceChanged ? { price: newPrice } : {}),
              ...(qtyChanged ? { quantity: newQty } : {}),
            },
            metadata: {
              source: 'FLAT_FILE_IMPORT',
              flatFileType: 'EBAY_FLAT_FILE',
            },
          })
        }

        saved++;
      }

      return reply.send({ saved });
    } catch (err: unknown) {
      request.log.error(err, 'ebay/flat-file/rows PATCH failed');
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : 'Failed to save rows' });
    }
  });

  // ── POST /api/ebay/flat-file/push ───────────────────────────────────
  // Push rows to eBay markets. Accepts multi-market flat rows.
  // For each row × market: PUT inventory_item + create/update offer + publish.
  fastify.post<{
    Body: {
      rows: Array<Record<string, unknown>>;
      markets?: string[];
      marketplace?: string;
      mode?: 'api' | 'feed';
    }
  }>('/ebay/flat-file/push', async (request, reply) => {
    const {
      rows,
      markets,
      marketplace = 'IT',
      mode = 'api',
    } = request.body;

    if (!Array.isArray(rows) || rows.length === 0) {
      return reply.code(400).send({ error: 'rows must be non-empty' });
    }

    // Resolve which markets to push to
    const targetMarkets: Market[] = (
      markets && markets.length > 0
        ? markets.map((m) => m.toUpperCase())
        : [marketplace.toUpperCase()]
    ).filter((m) => (MARKETS as readonly string[]).includes(m)) as Market[];

    if (targetMarkets.length === 0) {
      return reply.code(400).send({ error: 'No valid target markets specified' });
    }

    // Get eBay connection
    const connection = await prisma.channelConnection.findFirst({
      where: { channelType: 'EBAY', isActive: true },
      select: { id: true },
    });

    if (!connection) {
      return reply.code(503).send({
        error: 'No active eBay connection found. Please connect your eBay account first.',
      });
    }

    let token: string;
    try {
      token = await ebayAuthService.getValidToken(connection.id);
    } catch (err: unknown) {
      return reply.code(503).send({
        error: `Failed to get eBay token: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // ── Feed mode ───────────────────────────────────────────────────
    const effectiveMode = mode === 'feed' || rows.length > 50 ? 'feed' : 'api';

    if (effectiveMode === 'feed') {
      // Feed mode uses first target market
      const mp = targetMarkets[0];
      try {
        // Map flat rows to EbayFlatRow shape expected by feed service
        const feedRows = rows.map((r) => {
          const prefix = mp.toLowerCase() as Lowercase<Market>;
          return {
            ...r,
            price: r[`${prefix}_price`] ?? r.price ?? 0,
            quantity: r[`${prefix}_qty`] ?? r.quantity ?? 0,
          } as unknown as EbayFlatRow;
        });

        const ndjson = buildInventoryNdjson(feedRows);
        const taskId = await createInventoryTask(mp, token);
        await uploadFeedFile(taskId, ndjson, token);

        return reply.send({
          mode: 'feed',
          taskId,
          rowCount: rows.length,
          message: `Feed task created. Poll /api/ebay/flat-file/feed/${taskId} for status.`,
        });
      } catch (err: unknown) {
        request.log.error(err, 'ebay/flat-file/push feed mode failed');
        return reply.code(500).send({
          error: err instanceof Error ? err.message : 'Feed push failed',
        });
      }
    }

    // ── API mode — family-aware per row × market ────────────────────
    const perRowResults: Array<{
      sku: string;
      market: string;
      status: 'PUSHED' | 'ERROR';
      message: string;
      itemId?: string;
    }> = [];

    // Group rows by family (platformProductId). Rows without one are their own family.
    const families = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = (row.platformProductId as string | undefined) ?? (row.sku as string);
      if (!families.has(key)) families.set(key, []);
      families.get(key)!.push(row);
    }

    for (const mp of targetMarkets) {
      const marketplaceId = toMarketplaceId(mp);

      for (const [familyKey, familyRows] of families) {
        if (familyRows.length > 1) {
          // Multi-SKU family — push as variation group
          const groupResults = await pushVariationGroup(
            familyKey,
            familyRows,
            mp,
            token,
            EBAY_API_BASE,
            marketplaceId,
          );
          perRowResults.push(...groupResults);
          continue;
        }

        // Single-SKU family — existing per-row flow
        const row = familyRows[0];
        const sku = row.sku as string;
        if (!sku) {
          perRowResults.push({ sku: '', market: mp, status: 'ERROR', message: 'Missing SKU' });
          continue;
        }

        const prefix = mp.toLowerCase() as Lowercase<Market>;
        const currency = mp === 'UK' ? 'GBP' : 'EUR';
        const price = Number(row[`${prefix}_price`] ?? row.price ?? 0);
        const qty = Number(row[`${prefix}_qty`] ?? row.quantity ?? 0);

        try {
          const encodedSku = encodeURIComponent(sku);
          const invUrl = `${EBAY_API_BASE}/sell/inventory/v1/inventory_item/${encodedSku}`;

          const imageUrls: string[] = [];
          for (let i = 1; i <= 6; i++) {
            const url = row[`image_${i}`] as string | undefined;
            if (url) imageUrls.push(url);
          }

          // Collect aspects from row
          const aspects: Record<string, string[]> = {};
          for (const [key, val] of Object.entries(row)) {
            if (key.startsWith('aspect_') && typeof val === 'string' && val) {
              const aspectName = key.slice('aspect_'.length).replace(/_/g, ' ');
              aspects[aspectName] = [val];
            }
          }
          if (row.ean) aspects['EAN'] = [row.ean as string];
          if (row.mpn) aspects['MPN'] = [row.mpn as string];

          const invBody = {
            product: {
              title: (row.title as string) ?? sku,
              description: (row.description as string) ?? '',
              imageUrls,
              aspects,
              ...((row.ean as string) ? { ean: [row.ean as string] } : {}),
              ...((row.mpn as string) ? { mpn: row.mpn as string } : {}),
            },
            condition: (row.condition as string) ?? 'NEW',
            availability: {
              shipToLocationAvailability: { quantity: qty },
            },
          };

          const invRes = await fetch(invUrl, {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Content-Language': mp === 'IT' ? 'it-IT' : mp === 'DE' ? 'de-DE' : mp === 'FR' ? 'fr-FR' : mp === 'ES' ? 'es-ES' : 'en-GB',
              'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
            },
            body: JSON.stringify(invBody),
          });

          if (!invRes.ok) {
            const errBody = await invRes.text().catch(() => '');
            perRowResults.push({
              sku,
              market: mp,
              status: 'ERROR',
              message: `Inventory API error ${invRes.status}: ${errBody.slice(0, 200)}`,
            });
            continue;
          }

          const categoryId = row.category_id as string | undefined;
          if (categoryId) {
            const offerBody: Record<string, unknown> = {
              sku,
              marketplaceId,
              format: 'FIXED_PRICE',
              listingDescription: (row.description as string) ?? '',
              categoryId,
              pricingSummary: {
                price: {
                  value: price.toFixed(2),
                  currency,
                },
              },
              listingPolicies: {
                ...((row.fulfillment_policy_id as string)
                  ? { fulfillmentPolicyId: row.fulfillment_policy_id as string }
                  : {}),
                ...((row.payment_policy_id as string)
                  ? { paymentPolicyId: row.payment_policy_id as string }
                  : {}),
                ...((row.return_policy_id as string)
                  ? { returnPolicyId: row.return_policy_id as string }
                  : {}),
              },
              quantityLimitPerBuyer: 10,
            };

            // Check if offer exists
            const getOfferUrl = `${EBAY_API_BASE}/sell/inventory/v1/offer?sku=${encodedSku}&marketplace_id=${marketplaceId}`;
            const getOfferRes = await fetch(getOfferUrl, {
              headers: {
                Authorization: `Bearer ${token}`,
                'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
              },
            });

            let offerId: string | null = null;
            if (getOfferRes.ok) {
              const offerData = (await getOfferRes.json()) as {
                offers?: Array<{ offerId: string }>;
              };
              offerId = offerData.offers?.[0]?.offerId ?? null;
            }

            if (offerId) {
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
                const offerResp = (await createOfferRes.json()) as { offerId?: string };
                offerId = offerResp.offerId ?? null;
              }
            }

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
                const pubData = (await publishRes.json()) as { listingId?: string };
                const itemId = pubData.listingId;

                // Update DB
                const productId = row._productId as string | undefined;
                const region = mp === 'UK' ? 'GB' : mp;
                if (productId) {
                  await prisma.channelListing.updateMany({
                    where: { productId, channel: 'EBAY', region },
                    data: {
                      externalListingId: itemId,
                      listingStatus: 'ACTIVE',
                      offerActive: true,
                    },
                  });
                  const activated = await prisma.channelListing.findMany({
                    where: { productId, channel: 'EBAY', region },
                    select: { id: true },
                  });
                  void syncActivatedListings(activated.map((l) => l.id));
                }

                perRowResults.push({ sku, market: mp, status: 'PUSHED', message: 'Listed', itemId });
                continue;
              }
            }
          }

          perRowResults.push({ sku, market: mp, status: 'PUSHED', message: 'Inventory updated' });
        } catch (err: unknown) {
          perRowResults.push({
            sku,
            market: mp,
            status: 'ERROR',
            message: err instanceof Error ? err.message : 'Unknown error',
          });
        }
      }
    }

    const pushed = perRowResults.filter((r) => r.status === 'PUSHED').length;
    const errors = perRowResults.filter((r) => r.status === 'ERROR').length;

    return reply.send({ mode: 'api', pushed, errors, results: perRowResults });
  });

  // ── POST /api/ebay/flat-file/publish ────────────────────────────────
  // Publish existing offers for selected rows + markets.
  fastify.post<{
    Body: { rowIds: string[]; markets: string[] }
  }>('/ebay/flat-file/publish', async (request, reply) => {
    const { rowIds, markets } = request.body;

    if (!Array.isArray(rowIds) || rowIds.length === 0) {
      return reply.code(400).send({ error: 'rowIds must be non-empty' });
    }
    if (!Array.isArray(markets) || markets.length === 0) {
      return reply.code(400).send({ error: 'markets must be non-empty' });
    }

    const connection = await prisma.channelConnection.findFirst({
      where: { channelType: 'EBAY', isActive: true },
      select: { id: true },
    });

    if (!connection) {
      return reply.code(503).send({ error: 'No active eBay connection' });
    }

    let token: string;
    try {
      token = await ebayAuthService.getValidToken(connection.id);
    } catch (err: unknown) {
      return reply.code(503).send({
        error: `Failed to get eBay token: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const results: Array<{ productId: string; market: string; status: string; message: string }> = [];

    for (const productId of rowIds) {
      for (const mp of markets) {
        const mpUpper = mp.toUpperCase() as Market;
        if (!(MARKETS as readonly string[]).includes(mpUpper)) continue;

        const region = mpUpper === 'UK' ? 'GB' : mpUpper;
        const marketplaceId = toMarketplaceId(mpUpper);

        try {
          // Find the listing
          const listing = await prisma.channelListing.findFirst({
            where: { productId, channel: 'EBAY', region },
            include: { product: { select: { sku: true } } },
          });

          if (!listing) {
            results.push({ productId, market: mpUpper, status: 'SKIPPED', message: 'No listing found' });
            continue;
          }

          const encodedSku = encodeURIComponent(listing.product.sku);
          const getOfferUrl = `${EBAY_API_BASE}/sell/inventory/v1/offer?sku=${encodedSku}&marketplace_id=${marketplaceId}`;
          const getOfferRes = await fetch(getOfferUrl, {
            headers: {
              Authorization: `Bearer ${token}`,
              'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
            },
          });

          if (!getOfferRes.ok) {
            results.push({ productId, market: mpUpper, status: 'ERROR', message: `Could not fetch offer: ${getOfferRes.status}` });
            continue;
          }

          const offerData = (await getOfferRes.json()) as { offers?: Array<{ offerId: string }> };
          const offerId = offerData.offers?.[0]?.offerId;

          if (!offerId) {
            results.push({ productId, market: mpUpper, status: 'SKIPPED', message: 'No offer found — push first' });
            continue;
          }

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
            const pubData = (await publishRes.json()) as { listingId?: string };
            await prisma.channelListing.update({
              where: { id: listing.id },
              data: {
                externalListingId: pubData.listingId ?? listing.externalListingId,
                listingStatus: 'ACTIVE',
                offerActive: true,
              },
            });
            void syncActivatedListings([listing.id]);
            results.push({ productId, market: mpUpper, status: 'PUBLISHED', message: `Listed: ${pubData.listingId}` });
          } else {
            const errBody = await publishRes.text().catch(() => '');
            results.push({ productId, market: mpUpper, status: 'ERROR', message: `Publish failed ${publishRes.status}: ${errBody.slice(0, 200)}` });
          }
        } catch (err: unknown) {
          results.push({
            productId,
            market: mpUpper,
            status: 'ERROR',
            message: err instanceof Error ? err.message : 'Unknown error',
          });
        }
      }
    }

    const published = results.filter((r) => r.status === 'PUBLISHED').length;
    const errors = results.filter((r) => r.status === 'ERROR').length;

    return reply.send({ published, errors, results });
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

  // ── GET /api/ebay/flat-file/policies ────────────────────────────────
  // Returns the seller's eBay business policies (fulfillment, payment, return)
  // for a given marketplace so the frontend can show them as dropdown options.
  fastify.get<{
    Querystring: { marketplace?: string }
  }>('/ebay/flat-file/policies', async (request, reply) => {
    const marketplace = toMarketplaceId(request.query.marketplace ?? 'IT');

    const connection = await prisma.channelConnection.findFirst({
      where: { channelType: 'EBAY', isActive: true },
      select: { id: true },
    });
    if (!connection) {
      return reply.code(503).send({ error: 'No active eBay connection' });
    }

    try {
      const token = await ebayAuthService.getValidToken(connection.id);
      const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const base = `${EBAY_API_BASE}/sell/account/v1`;

      const [fRes, pmRes, rRes] = await Promise.allSettled([
        fetch(`${base}/fulfillment_policy?marketplace_id=${marketplace}`, { headers }),
        fetch(`${base}/payment_policy?marketplace_id=${marketplace}`,     { headers }),
        fetch(`${base}/return_policy?marketplace_id=${marketplace}`,      { headers }),
      ]);

      async function extract<T>(r: PromiseSettledResult<Response>, key: string): Promise<T[]> {
        if (r.status !== 'fulfilled' || !r.value.ok) return [];
        try { const d = await r.value.json() as Record<string, T[]>; return d[key] ?? []; } catch { return []; }
      }

      const [fulfillment, payment, ret] = await Promise.all([
        extract<{ fulfillmentPolicyId: string; name: string }>(fRes,  'fulfillmentPolicies'),
        extract<{ paymentPolicyId: string;     name: string }>(pmRes, 'paymentPolicies'),
        extract<{ returnPolicyId: string;      name: string }>(rRes,  'returnPolicies'),
      ]);

      return reply.send({
        fulfillment: fulfillment.map((p) => ({ id: p.fulfillmentPolicyId, name: p.name })),
        payment:     payment.map((p)     => ({ id: p.paymentPolicyId,     name: p.name })),
        return:      ret.map((p)         => ({ id: p.returnPolicyId,      name: p.name })),
      });
    } catch (err: unknown) {
      request.log.error(err, 'ebay/flat-file/policies failed');
      return reply.code(500).send({ error: err instanceof Error ? err.message : 'Failed to fetch policies' });
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

      const rows = amazonListings.map((l) => {
        const attrs = (l.platformAttributes ?? {}) as Record<string, unknown>;
        const bulletPoints = (attrs.bullet_points ?? attrs.bulletPoints ?? []) as string[];
        const imageUrls = (attrs.main_product_image_locator ?? attrs.imageUrls ?? []) as string[];

        return {
          _productId: l.productId,
          sku: l.product.sku,
          ean: l.product.ean ?? '',
          mpn: '',
          amazon_title: l.title ?? '',
          title: (l.title ?? '').slice(0, 80),
          amazon_description: l.description ?? '',
          description: [l.description ?? '', ...bulletPoints].filter(Boolean).join('<br>'),
          amazon_price: l.price?.toNumber() ?? 0,
          price: l.price?.toNumber() ?? 0,
          amazon_quantity: l.quantity ?? 0,
          quantity: l.quantity ?? 0,
          image_1: imageUrls[0] ?? '',
          image_2: imageUrls[1] ?? '',
          image_3: imageUrls[2] ?? '',
          image_4: imageUrls[3] ?? '',
          image_5: imageUrls[4] ?? '',
          image_6: imageUrls[5] ?? '',
          brand: (attrs.brand as string | undefined) ?? '',
          colour: ((attrs.color ?? attrs.colour) as string) ?? '',
          size: ((attrs.size ?? attrs.size_name) as string) ?? '',
          material: ((attrs.material ?? attrs.material_type) as string) ?? '',
          model_number: ((attrs.model_number ?? attrs.part_number) as string) ?? '',
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

  // ── GET /api/ebay/flat-file/poll-orders ──────────────────────────────────
  // Polls eBay Fulfillment API for new orders in the last N hours and
  // decrements local stock via applyStockMovement. Designed to be called
  // by a cron job every 5 minutes. Idempotent — skips already-processed
  // orders via channelOrderId unique constraint.
  fastify.get<{
    Querystring: { hoursBack?: string; marketplace?: string }
  }>('/ebay/flat-file/poll-orders', async (request, reply) => {
    const hoursBack = parseInt(request.query.hoursBack ?? '1', 10) || 1;
    const marketplace = toMarketplaceId(request.query.marketplace ?? 'IT');

    const connection = await prisma.channelConnection.findFirst({
      where: { channelType: 'EBAY', isActive: true },
      select: { id: true },
    });
    if (!connection) {
      return reply.code(503).send({ error: 'No active eBay connection' });
    }

    let token: string;
    try {
      token = await ebayAuthService.getValidToken(connection.id);
    } catch (err) {
      return reply.code(503).send({ error: `eBay token error: ${err instanceof Error ? err.message : String(err)}` });
    }

    const since = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString();
    const ordersUrl = `${EBAY_API_BASE}/sell/fulfillment/v1/order?filter=creationdate:%5B${encodeURIComponent(since)}..%5D&limit=50`;

    let ordersData: { orders?: Array<{ orderId: string; lineItems?: Array<{ sku: string; quantity: number }> }> };
    try {
      const res = await fetch(ordersUrl, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (!res.ok) {
        return reply.code(502).send({ error: `eBay orders API ${res.status}` });
      }
      ordersData = await res.json() as typeof ordersData;
    } catch (err) {
      return reply.code(502).send({ error: `eBay orders fetch failed: ${err instanceof Error ? err.message : String(err)}` });
    }

    const orders = ordersData.orders ?? [];
    let processed = 0; let skipped = 0; const errors: string[] = [];

    for (const order of orders) {
      for (const line of order.lineItems ?? []) {
        if (!line.sku || !line.quantity) continue;
        try {
          // Idempotent check — skip if already processed
          const existing = await prisma.order.findFirst({
            where: { channelOrderId: order.orderId, channel: 'EBAY' },
            select: { id: true },
          });
          if (existing) { skipped++; continue; }

          const product = await prisma.product.findUnique({
            where: { sku: line.sku }, select: { id: true, sku: true },
          });
          if (!product) { errors.push(`SKU not found: ${line.sku}`); continue; }

          // Decrement via canonical path — triggers OutboundSyncQueue cascade
          const { applyStockMovement } = await import('../services/stock-movement.service.js');
          await applyStockMovement({
            productId: product.id,
            change: -line.quantity,
            reason: 'ORDER_PLACED',
            referenceType: 'EbayOrder',
            referenceId: order.orderId,
            actor: 'ebay:poll-orders',
            notes: `eBay order ${order.orderId} marketplace=${marketplace}`,
          });
          processed++;
        } catch (err) {
          errors.push(`${line.sku}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    return reply.send({
      marketplace, hoursBack, ordersChecked: orders.length,
      processed, skipped, errors,
    });
  });
}
