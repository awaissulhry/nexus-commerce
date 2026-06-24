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
import { ebayAccountService } from '../services/ebay-account.service.js';
import { EbayCategoryService } from '../services/ebay-category.service.js';
import { syncActivatedListings } from '../services/listing-activation-sync.service.js';
import { enqueueContentSyncIfEnabled } from '../services/content-auto-publish.service.js';
import { productEventService } from '../services/product-event.service.js';
import { runFlatFileAiInstruction } from '../services/flat-file-ai.service.js';
import { computeAvailableToPublish } from '../services/available-to-publish.service.js';
import { MARKETPLACE_ID_TO_CODE } from '../utils/marketplace-code.js';
import { getPendingMcfReservedByProduct } from '../services/amazon-mcf.service.js';
import {
  buildInventoryNdjson,
  createInventoryTask,
  uploadFeedFile,
  getTaskStatus,
  type EbayFlatRow,
} from '../services/ebay-feed.service.js';
import {
  startEbayPullPreviewJob,
  getEbayPullPreviewJobStatus,
} from '../services/ebay-flat-file-pull-preview.service.js';

const EBAY_API_BASE = process.env.EBAY_API_BASE ?? 'https://api.ebay.com';

// FF-EN.2 — eBay numeric conditionId → Inventory API ConditionEnum string.
// get_item_condition_policies returns numeric ids; the flat-file/Inventory
// push uses the enum string, so we translate before exposing as options.
const CONDITION_ID_TO_ENUM: Record<string, string> = {
  '1000': 'NEW',
  '1500': 'NEW_OTHER',
  '1750': 'NEW_WITH_DEFECTS',
  '2000': 'CERTIFIED_REFURBISHED',
  '2010': 'EXCELLENT_REFURBISHED',
  '2020': 'VERY_GOOD_REFURBISHED',
  '2030': 'GOOD_REFURBISHED',
  '2500': 'SELLER_REFURBISHED',
  '2750': 'LIKE_NEW',
  '3000': 'USED_EXCELLENT',
  '4000': 'USED_VERY_GOOD',
  '5000': 'USED_GOOD',
  '6000': 'USED_ACCEPTABLE',
  '7000': 'FOR_PARTS_OR_NOT_WORKING',
};

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
    // EV.5b — family linkage + variation data (present at runtime; /rows
    // selects all Product scalars).
    parentId?: string | null;
    variationTheme?: string | null;
    categoryAttributes?: unknown;
    images?: Array<{ url: string; sortOrder: number; type: string }>;
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

  // Prefer Cloudinary images (ProductImage rows) over Amazon CDN platformAttributes URLs.
  // Sort MAIN type first, then by sortOrder. Fall back to non-Amazon platformAttributes URLs.
  const cloudinaryUrls = (product.images ?? [])
    .slice()
    .sort((a, b) => (a.type === 'MAIN' ? -1 : b.type === 'MAIN' ? 1 : 0) || a.sortOrder - b.sortOrder)
    .map((img) => img.url)
    .filter((url) => !url.includes('amazon.com'));
  const fallbackUrls = firstImageUrls.filter((url) => !url.includes('amazon.com'));
  const effectiveImageUrls = cloudinaryUrls.length > 0 ? cloudinaryUrls : fallbackUrls;

  // EV.5b — variation linkage. Axis names normalised to comma-separated
  // (what the variation publish's split(',') expects); axis values from
  // the canonical categoryAttributes.variations.
  const variationAxisNames = (product.variationTheme ?? '')
    .split(/[/,|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const variationValues =
    ((product.categoryAttributes as { variations?: Record<string, string> } | null)?.variations) ?? {};

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
    // FF-EN.4 — full-parity fields (round-trip via platformAttributes)
    vat_rate: (firstAttrs.vatRate as string | undefined) ?? '',
    listing_format: (firstAttrs.listingFormat as string | undefined) ?? 'FIXED_PRICE',
    listing_duration: (firstAttrs.listingDuration as string | undefined) ?? 'GTC',
    item_location_country: (firstAttrs.itemLocationCountry as string | undefined) ?? '',
    package_type: (firstAttrs.packageType as string | undefined) ?? '',
    package_weight: (firstAttrs.packageWeight as number | undefined) ?? 0,
    weight_unit: (firstAttrs.weightUnit as string | undefined) ?? 'KILOGRAM',
    package_length: (firstAttrs.packageLength as number | undefined) ?? 0,
    package_width: (firstAttrs.packageWidth as number | undefined) ?? 0,
    package_height: (firstAttrs.packageHeight as number | undefined) ?? 0,
    dimension_unit: (firstAttrs.dimensionUnit as string | undefined) ?? 'CENTIMETER',
    image_1: effectiveImageUrls[0] ?? '',
    image_2: effectiveImageUrls[1] ?? '',
    image_3: effectiveImageUrls[2] ?? '',
    image_4: effectiveImageUrls[3] ?? '',
    image_5: effectiveImageUrls[4] ?? '',
    image_6: effectiveImageUrls[5] ?? '',
    fulfillment_policy_id: (firstAttrs.fulfillmentPolicyId as string | undefined) ?? '',
    payment_policy_id: (firstAttrs.paymentPolicyId as string | undefined) ?? '',
    return_policy_id: (firstAttrs.returnPolicyId as string | undefined) ?? '',
    // legacy single-market fields (backward compat)
    listing_status: first?.listingStatus ?? 'DRAFT',
    last_pushed_at: first?.updatedAt.toISOString() ?? '',
    sync_status: first?.syncStatus ?? 'pending',
    ebay_item_id: first?.externalListingId ?? '',
    // EV.5b — family group key: children share the parent's id, the parent
    // uses its own. So a family groups (push + UI) instead of every row
    // being its own one-row "family".
    platformProductId: product.parentId ?? product.id,
    variation_theme: variationAxisNames.join(','),
    // metadata flag (underscore-prefixed, not a display column).
    _isParent: !product.parentId,
  };

  // Dynamic item specifics from first listing
  const itemSpecifics = (firstAttrs.itemSpecifics as Record<string, string> | undefined) ?? {};
  for (const [key, val] of Object.entries(itemSpecifics)) {
    const colId = `aspect_${key.replace(/\s+/g, '_')}`;
    row[colId] = val;
  }

  // EV.5b — variation axis values from categoryAttributes.variations,
  // under both the case-preserved key (the dynamic UI columns) and the
  // lowercased key the variation publish's variesBy build reads.
  for (const [axis, val] of Object.entries(variationValues)) {
    if (!val) continue;
    row[`aspect_${axis.replace(/\s+/g, '_')}`] = val;
    row[`aspect_${axis.toLowerCase().replace(/\s+/g, '_')}`] = val;
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
      // FF-EN.4 — full-parity fields
      vatRate: (row.vat_rate as string) ?? '',
      listingFormat: (row.listing_format as string) ?? 'FIXED_PRICE',
      listingDuration: (row.listing_duration as string) ?? 'GTC',
      itemLocationCountry: (row.item_location_country as string) ?? '',
      packageType: (row.package_type as string) ?? '',
      packageWeight: Number(row.package_weight ?? 0),
      weightUnit: (row.weight_unit as string) ?? 'KILOGRAM',
      packageLength: Number(row.package_length ?? 0),
      packageWidth: Number(row.package_width ?? 0),
      packageHeight: Number(row.package_height ?? 0),
      dimensionUnit: (row.dimension_unit as string) ?? 'CENTIMETER',
    } as Prisma.InputJsonValue,
  };
}

// ── Variation group push helper ────────────────────────────────────────

// FF-EN.4 — build the Inventory API packageWeightAndSize from the flat
// row's package fields. Returns undefined when nothing usable is set, so
// the publish body is unchanged for rows without shipping dimensions.
function buildPackageWeightAndSize(
  row: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const w = Number(row.package_weight ?? 0);
  const l = Number(row.package_length ?? 0);
  const wd = Number(row.package_width ?? 0);
  const h = Number(row.package_height ?? 0);
  const pkgType = (row.package_type as string) || '';
  const out: Record<string, unknown> = {};
  if (w > 0) out.weight = { value: w, unit: (row.weight_unit as string) || 'KILOGRAM' };
  if (l > 0 && wd > 0 && h > 0) {
    out.dimensions = {
      length: l,
      width: wd,
      height: h,
      unit: (row.dimension_unit as string) || 'CENTIMETER',
    };
  }
  if (pkgType) out.packageType = pkgType;
  return Object.keys(out).length ? out : undefined;
}

// Maps eBay marketplace short-code to the BCP-47 language tag that eBay's
// Inventory API requires for Content-Language / Accept-Language headers.
// eBay stores aspect names in the locale used at write time — sending en-US
// for an EBAY_IT listing causes eBay to expect English names ("Color", "Size")
// which then don't match the Italian category aspects ("Colore", "Taglia"),
// triggering publish error 25013.
function toListingLanguage(mp: string): string {
  const MAP: Record<string, string> = {
    IT: 'it-IT', DE: 'de-DE', FR: 'fr-FR', ES: 'es-ES', UK: 'en-GB', GB: 'en-GB',
  }
  return MAP[mp.toUpperCase()] ?? 'en-US'
}

async function pushVariationGroup(
  groupKey: string,
  rows: Array<Record<string, unknown>>,
  mp: string,
  token: string,
  connectionId: string,
  connectionMeta: Record<string, unknown>,
  apiBase: string,
  marketplaceId: string,
  // FCF.3 — caps each variant's qty at its FBM-available pool.
  capToFbm: (pid: string | undefined, sku: string, requested: number, market?: string) => number,
): Promise<{ sku: string; market: string; status: 'PUSHED' | 'ERROR'; message: string; itemId?: string }[]> {
  const results: { sku: string; market: string; status: 'PUSHED' | 'ERROR'; message: string; itemId?: string }[] = []

  const lang = toListingLanguage(mp)
  // eBay Sell Inventory API requires BOTH Content-Language AND Accept-Language
  // on every call (inventory_item, inventory_item_group, offer, publish).
  // Sending only one triggers error 25709 ("Invalid value for Content-Language
  // header"). Use one headers object for all steps — mirrors ebay-publish.adapter.ts.
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Content-Language': lang,
    'Accept-Language': lang,
    Accept: 'application/json',
    'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
  }

  // EV.5b — the family load (EV.5) includes the parent *container* row
  // (_isParent). The parent is not a sellable variant: it must not get
  // its own inventory_item nor be a group member. It IS the right source
  // for the group-level title/description/images.
  const parentRow = rows.find((r) => r._isParent) ?? rows[0]
  const variantRowsAll = rows.filter((r) => !r._isParent)
  const variantRows = variantRowsAll.length > 0 ? variantRowsAll : rows

  // EV.6b — name/value renames from parent ChannelListing platformAttributes
  let nameLabels: Record<string, string> = {}
  let valueLabels: Record<string, Record<string, string>> = {}
  try {
    const ids = rows.map((r) => r._productId as string).filter(Boolean)
    const prods = await prisma.product.findMany({
      where: { id: { in: ids } },
      select: { id: true, parentId: true },
    })
    const parentId = prods.find((p) => !p.parentId)?.id ?? prods[0]?.parentId ?? ids[0]
    if (parentId) {
      const pl = await prisma.channelListing.findFirst({
        where: { productId: parentId, channel: 'EBAY', marketplace: mp },
        select: { platformAttributes: true },
      })
      const pa = (pl?.platformAttributes ?? {}) as Record<string, unknown>
      nameLabels = (pa._axisNameLabels ?? {}) as Record<string, string>
      valueLabels = (pa._axisValueLabels ?? {}) as Record<string, Record<string, string>>
    }
  } catch {
    /* renames best-effort — publish proceeds with canonical values */
  }
  const nmLabel = (a: string) => nameLabels[a] || a
  const vlLabel = (a: string, v: string) => valueLabels[a]?.[v] || v

  // Detect variation axes dynamically: scan all aspect_* keys across variant
  // rows and find those with >1 distinct value. Robust against the Amazon
  // variation theme (e.g. "SIZE_COLOR") not matching the eBay category's
  // locale-specific aspect names ("Colore", "Taglia" on EBAY_IT).
  const allAspectValueSets = new Map<string, Set<string>>()
  for (const row of variantRows) {
    for (const [k, v] of Object.entries(row)) {
      if (k.startsWith('aspect_') && typeof v === 'string' && v) {
        const name = k.slice('aspect_'.length).replace(/_/g, ' ')
        if (!allAspectValueSets.has(name)) allAspectValueSets.set(name, new Set())
        allAspectValueSets.get(name)!.add(v)
      }
    }
  }
  const effectiveVarAxes = [...allAspectValueSets.entries()]
    .filter(([, vals]) => vals.size > 1)
    .map(([name]) => name)

  const isVarAxis = (name: string) => effectiveVarAxes.includes(name)

  // Step 1: Create/update each variant's inventory_item.
  for (const row of variantRows) {
    const sku = row.sku as string

    // Deduplicate aspects by nmLabel key: buildFlatRow writes both the
    // case-preserved key (aspect_Colore) and lowercased key (aspect_color),
    // and Amazon import can add English equivalents. Using a Map keyed by
    // nmLabel ensures each logical axis appears exactly once in the item.
    const aspectsMap = new Map<string, string[]>()
    for (const [k, v] of Object.entries(row)) {
      if (k.startsWith('aspect_') && v) {
        const aspectName = k.slice('aspect_'.length).replace(/_/g, ' ')
        if (isVarAxis(aspectName)) {
          aspectsMap.set(nmLabel(aspectName), [vlLabel(aspectName, String(v))])
        } else {
          aspectsMap.set(aspectName, [String(v)])
        }
      }
    }
    if (row.ean) aspectsMap.set('EAN', [String(row.ean)])
    if (row.mpn) aspectsMap.set('MPN', [String(row.mpn)])
    const aspects = Object.fromEntries(aspectsMap)

    // FCF.3 — cap each variant at its FBM-available pool.
    const qty = capToFbm(row._productId as string | undefined, sku, Number(row[`${mp.toLowerCase()}_qty`] ?? row.quantity ?? 0), mp)

    // Filter out Amazon CDN URLs — eBay cannot crawl m.media-amazon.com
    // (WAF restrictions). Send only publicly accessible URLs.
    const imageUrls: string[] = []
    for (let i = 1; i <= 6; i++) {
      const url = row[`image_${i}`] as string | undefined
      if (url && !url.includes('amazon.com')) imageUrls.push(url)
    }

    // Translate numeric conditionId (e.g. '1000') to eBay ConditionEnum ('NEW').
    // buildFlatRow stores the raw conditionId from platformAttributes; the
    // Inventory API rejects numeric strings.
    const rawCondition = String(row.condition ?? '')
    const condition = CONDITION_ID_TO_ENUM[rawCondition] ?? (rawCondition || 'NEW')

    const pkgSize = buildPackageWeightAndSize(row)
    const itemBody = {
      product: {
        title: row.title ?? sku,
        description: row.description ?? '',
        imageUrls,
        aspects,
        ...(row.ean ? { ean: [String(row.ean)] } : {}),
        ...(row.mpn ? { mpn: String(row.mpn) } : {}),
      },
      condition,
      availability: {
        shipToLocationAvailability: { quantity: Number(qty) },
      },
      ...(pkgSize ? { packageWeightAndSize: pkgSize } : {}),
    }

    const itemRes = await fetch(`${apiBase}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
      method: 'PUT', headers, body: JSON.stringify(itemBody),
    })
    if (!itemRes.ok && itemRes.status !== 204) {
      const err = await itemRes.text().catch(() => '')
      results.push({ sku, market: mp, status: 'ERROR', message: `inventory_item PUT ${itemRes.status}: ${err.slice(0, 300)}` })
      continue
    }
    results.push({ sku, market: mp, status: 'PUSHED', message: 'inventory_item updated' })
  }

  // Step 2: Build variesBy specifications from the detected variation axes.
  // Deduplicate by nmLabel output: two different aspect_* raw keys (e.g. "color"
  // imported from Amazon + "Colore" set up on eBay) can both have >1 distinct value
  // and therefore both appear in effectiveVarAxes, then nmLabel maps both to the
  // same Italian label → two specs entries with identical name → eBay error 25013
  // ("Duplicate names in variant specifications"). Merge values across raw keys that
  // share a label so the group sees exactly one specification entry per axis.
  // Key by lowercase label so "Colore" and "colore" (buildFlatRow writes both
  // the original-case and a lowercase duplicate of each variation axis) collapse
  // into a single specifications entry. Without this, both pass the vals.size > 1
  // filter and produce two entries with identical display names → eBay 25013.
  const specificationsMap = new Map<string, { name: string; values: Set<string> }>()
  for (const rawName of effectiveVarAxes) {
    const label = nmLabel(rawName)
    const mapKey = label.toLowerCase()
    if (!specificationsMap.has(mapKey)) {
      specificationsMap.set(mapKey, { name: label, values: new Set() })
    }
    const entry = specificationsMap.get(mapKey)!
    for (const v of (allAspectValueSets.get(rawName) ?? [])) {
      entry.values.add(vlLabel(rawName, v))
    }
  }
  const specifications = specificationsMap.size > 0
    ? [...specificationsMap.values()].map(e => ({ name: e.name, values: [...e.values] }))
    : [{ name: 'Custom Bundle', values: variantRows.map(r => r.sku as string) }]
  const imageVariesByAxes = [...specificationsMap.keys()].slice(0, 1)

  // Step 3: Create/update the inventory_item_group.
  // variantSKUs is the correct field name (plain string array, not objects).
  if (!String(parentRow.title ?? '').trim()) {
    return results.map(r => ({ ...r, status: 'ERROR' as const, message: 'Missing title on parent row — set a title before pushing' }))
  }
  const groupImageUrls: string[] = []
  for (let i = 1; i <= 6; i++) {
    const url = parentRow[`image_${i}`] as string | undefined
    if (url && !url.includes('amazon.com')) groupImageUrls.push(url)
  }

  const groupBody = {
    inventoryItemGroupKey: groupKey,
    title: parentRow.title ?? '',
    description: parentRow.description ?? '',
    imageUrls: groupImageUrls,
    variantSKUs: variantRows.map(r => r.sku as string),
    variesBy: {
      aspectsImageVariesBy: imageVariesByAxes,
      specifications,
    },
  }

  const groupRes = await fetch(`${apiBase}/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`, {
    method: 'PUT', headers, body: JSON.stringify(groupBody),
  })
  if (!groupRes.ok && groupRes.status !== 204) {
    const err = await groupRes.text().catch(() => '')
    return results.map(r => ({ ...r, status: 'ERROR' as const, message: `inventory_item_group PUT ${groupRes.status}: ${err.slice(0, 300)}` }))
  }

  // Step 3.5: Create/update one offer per variant.
  // Rules for variation member offers (eBay Inventory API):
  //   • listingDescription MUST be omitted — it comes from the group description;
  //     including it overwrites the group description on the live listing.
  //   • inventoryItemGroupKey is NOT a valid offer field — group linkage is
  //     established exclusively via variantSKUs in the group PUT above.
  //   • availableQuantity is required before publishOfferByInventoryItemGroup.
  //   • merchantLocationKey (top-level on offer) is required so eBay can resolve
  //     Item.Country; absence causes error 25002 at publish.
  //
  // Policy waterfall (mirrors ebay-publish.adapter.ts):
  //   1. Per-row flat-file columns (operator override)
  //   2. ChannelConnection.connectionMetadata.ebayPolicies (account default)
  //   3. ebayAccountService.getSnapshot() — live eBay Account + Inventory API
  //   Hard-fail if any required field is still missing after all three tiers.
  const configured = ((connectionMeta.ebayPolicies ?? {}) as {
    fulfillmentPolicyId?: string
    paymentPolicyId?: string
    returnPolicyId?: string
    merchantLocationKey?: string
  })
  let fulfillmentPolicyId = (parentRow.fulfillment_policy_id as string | undefined) || configured.fulfillmentPolicyId || ''
  let paymentPolicyId     = (parentRow.payment_policy_id     as string | undefined) || configured.paymentPolicyId     || ''
  let returnPolicyId      = (parentRow.return_policy_id      as string | undefined) || configured.returnPolicyId      || ''
  let merchantLocationKey = (parentRow.merchant_location_key as string | undefined) || configured.merchantLocationKey || ''

  if (!fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId || !merchantLocationKey) {
    try {
      const snapshot = await ebayAccountService.getSnapshot(connectionId, marketplaceId)
      if (!fulfillmentPolicyId) fulfillmentPolicyId = snapshot.fulfillmentPolicies[0]?.id ?? ''
      if (!paymentPolicyId)     paymentPolicyId     = snapshot.paymentPolicies[0]?.id     ?? ''
      if (!returnPolicyId)      returnPolicyId      = snapshot.returnPolicies[0]?.id      ?? ''
      if (!merchantLocationKey) merchantLocationKey = snapshot.locations[0]?.key           ?? ''
    } catch (err) {
      const msg = `Could not fetch seller policies: ${err instanceof Error ? err.message : String(err)}`
      return rows.map(r => ({ sku: (r.sku ?? '') as string, market: mp, status: 'ERROR' as const, message: msg }))
    }
  }

  const missing: string[] = []
  if (!merchantLocationKey) missing.push('merchantLocation (configure in eBay Seller Hub > Inventory > Locations)')
  if (!fulfillmentPolicyId) missing.push('fulfillmentPolicy')
  if (!returnPolicyId)      missing.push('returnPolicy')
  if (missing.length > 0) {
    const msg = `Missing required seller settings: ${missing.join(', ')}`
    return rows.map(r => ({ sku: (r.sku ?? '') as string, market: mp, status: 'ERROR' as const, message: msg }))
  }

  const currency = mp === 'UK' ? 'GBP' : 'EUR'
  const catId    = (parentRow.category_id as string | undefined) ?? ''

  let anyOfferFailed = false
  for (const row of variantRows) {
    const sku   = row.sku as string
    const price = Number(row[`${mp.toLowerCase()}_price`] ?? row.price ?? 0)
    const qty   = capToFbm(row._productId as string | undefined, sku, Number(row[`${mp.toLowerCase()}_qty`] ?? row.quantity ?? 0), mp)

    if (!price || price <= 0) {
      const msg = `No ${mp} price set for ${sku} — enter a price before pushing`
      const idx = results.findIndex(r => r.sku === sku)
      if (idx >= 0) results[idx] = { ...results[idx], status: 'ERROR', message: msg }
      else results.push({ sku, market: mp, status: 'ERROR', message: msg })
      anyOfferFailed = true
      continue
    }

    const offerBody: Record<string, unknown> = {
      sku,
      marketplaceId,
      format: 'FIXED_PRICE',
      // listingDescription intentionally omitted — comes from group description
      ...(catId ? { categoryId: catId } : {}),
      availableQuantity: qty,
      pricingSummary: { price: { value: price.toFixed(2), currency } },
      listingPolicies: {
        ...(fulfillmentPolicyId ? { fulfillmentPolicyId } : {}),
        ...(paymentPolicyId     ? { paymentPolicyId }     : {}),
        ...(returnPolicyId      ? { returnPolicyId }      : {}),
      },
      // merchantLocationKey (top-level, not inside listingPolicies) tells eBay
      // the seller's location so it can resolve Item.Country for the listing.
      ...(merchantLocationKey ? { merchantLocationKey } : {}),
      quantityLimitPerBuyer: 10,
    }

    const getOfferRes = await fetch(
      `${apiBase}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${marketplaceId}`,
      { headers: headers },
    )
    let offerId: string | null = null
    if (getOfferRes.ok) {
      const od = await getOfferRes.json() as { offers?: Array<{ offerId: string }> }
      offerId = od.offers?.[0]?.offerId ?? null
    }

    if (offerId) {
      const upd = await fetch(`${apiBase}/sell/inventory/v1/offer/${offerId}`, {
        method: 'PUT', headers: headers, body: JSON.stringify(offerBody),
      })
      if (!upd.ok) {
        const err = await upd.text().catch(() => '')
        const msg = `offer update ${upd.status}: ${err.slice(0, 300)}`
        const idx = results.findIndex(r => r.sku === sku)
        if (idx >= 0) results[idx] = { ...results[idx], status: 'ERROR', message: msg }
        else results.push({ sku, market: mp, status: 'ERROR', message: msg })
        anyOfferFailed = true
        continue
      }
    } else {
      const cre = await fetch(`${apiBase}/sell/inventory/v1/offer`, {
        method: 'POST', headers: headers, body: JSON.stringify(offerBody),
      })
      if (!cre.ok) {
        const err = await cre.text().catch(() => '')
        const msg = `offer create ${cre.status}: ${err.slice(0, 300)}`
        const idx = results.findIndex(r => r.sku === sku)
        if (idx >= 0) results[idx] = { ...results[idx], status: 'ERROR', message: msg }
        else results.push({ sku, market: mp, status: 'ERROR', message: msg })
        anyOfferFailed = true
        continue
      }
    }
  }

  // If any offer failed, skip publish and return per-variant results so the
  // operator can see exactly which SKUs need attention.
  if (anyOfferFailed) return results

  // Step 4: Publish the variation listing.
  const publishRes = await fetch(`${apiBase}/sell/inventory/v1/offer/publish_by_inventory_item_group`, {
    method: 'POST', headers,
    body: JSON.stringify({ inventoryItemGroupKey: groupKey, marketplaceId }),
  })

  if (!publishRes.ok) {
    const err = await publishRes.text().catch(() => '')
    return results.map(r => ({ ...r, status: 'ERROR' as const, message: `publish_by_group ${publishRes.status}: ${err.slice(0, 300)}` }))
  }

  const pubData = await publishRes.json().catch(() => ({})) as { listingId?: string }
  const listingId = pubData.listingId

  // Write the shared listingId back to all variant ChannelListings.
  const productIds = variantRows.map(r => r._productId as string).filter(Boolean)
  const region = mp === 'UK' ? 'GB' : mp
  if (productIds.length > 0) {
    try {
      await prisma.channelListing.updateMany({
        where: { productId: { in: productIds }, channel: 'EBAY', region },
        data: { externalListingId: listingId ?? null, listingStatus: 'ACTIVE', offerActive: true },
      })
      const activated = await prisma.channelListing.findMany({
        where: { productId: { in: productIds }, channel: 'EBAY', region },
        select: { id: true },
      })
      void syncActivatedListings(activated.map(l => l.id))
    } catch {
      /* DB write-back failure is non-fatal — listing is already live on eBay */
    }
  }

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
          // EV.5 — a family must load the parent AND its variant children
          // so the bulk editor shows every variation (price/qty come from
          // their eBay ChannelListings, which the cockpit matrix writes).
          ...(familyId ? { OR: [{ id: familyId }, { parentId: familyId }] } : {}),
        },
        include: {
          channelListings: {
            where: { channel: 'EBAY' },
          },
          images: {
            select: { url: true, sortOrder: true, type: true },
            orderBy: { sortOrder: 'asc' },
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
      // FF-EN.2 — fetch aspects + the category's allowed conditions together.
      const [richAspects, condPolicies] = await Promise.all([
        ebayCategoryService.getCategoryAspectsRich(categoryId, marketplace, {
          throwOnError: false,
        }),
        ebayCategoryService
          .getItemConditionPolicies(categoryId, marketplace)
          .catch(() => []),
      ]);

      // Map EbayAspectRich to column definitions the frontend can consume.
      // FF-EN.0 — any aspect eBay gives values for becomes a pick-or-type
      // combobox, not just SELECTION_ONLY ones. enumMode carries eBay's
      // aspectMode so the grid can suggest-only (FREE_TEXT) vs flag a
      // non-listed value (SELECTION_ONLY) — but typing a custom value is
      // always allowed.
      const aspects = richAspects.map((a) => {
        const isEnum = a.values.length > 0;
        const isNumber = a.dataType === 'NUMBER';
        const kind = isEnum ? 'enum' : isNumber ? 'number' : 'text';
        const enumMode: 'open' | 'strict' | undefined = isEnum
          ? a.mode === 'SELECTION_ONLY'
            ? 'strict'
            : 'open'
          : undefined;
        const label = a.englishName ? `${a.name} (${a.englishName})` : a.name;
        return {
          id: `aspect_${a.name.replace(/\s+/g, '_')}`,
          label,
          kind,
          options: isEnum ? a.values : undefined,
          enumMode,
          required: a.required || a.usage === 'REQUIRED',
          recommended: a.usage === 'RECOMMENDED',
          // guidance propagates eBay's usage level so the grid can shade low-priority fields
          guidance: (a.usage === 'REQUIRED' || a.usage === 'RECOMMENDED' || a.usage === 'OPTIONAL')
            ? a.usage : 'OPTIONAL',
          width: isEnum ? 140 : a.maxLength && a.maxLength > 50 ? 200 : 130,
          variantEligible: a.variantEligible,
        };
      });

      // FF-EN.2 — translate numeric conditionIds → Inventory enum strings so
      // the Condition column can narrow to this category's allowed set
      // (strict, but still overridable). Falls back to the static full list
      // on the client when empty.
      const conditions = condPolicies
        .map((c) => ({
          value: CONDITION_ID_TO_ENUM[c.conditionId] ?? '',
          label: c.conditionDescription || c.conditionId,
        }))
        .filter((c) => c.value);

      const result = { categoryId, marketplace, aspects, conditions };
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

    // Lookup primary warehouse once for StockLevel writes (same pattern as Amazon flat-file service)
    const primaryLocation = await prisma.stockLocation.findFirst({
      where: { type: 'WAREHOUSE', isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

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
            // FCF.4 — eBay is merchant-fulfilled: mark fulfillment on THIS
            // listing (per channel×marketplace), not on the shared product.
            fulfillmentMethod: 'FBM' as const,
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

        // ── StockLevel update (once per product, FBM warehouse) ──────
        // Use the first non-null qty across markets as the warehouse qty.
        // eBay is always FBM — stock lives in the primary warehouse.
        let stockQty: number | null = null;
        for (const mp of MARKETS) {
          const q = row[`${(mp as string).toLowerCase()}_qty`];
          if (q != null && !isNaN(Number(q)) && Number(q) >= 0) {
            stockQty = Number(q);
            break;
          }
        }

        if (primaryLocation && stockQty !== null) {
          // findFirst (not findUnique) — variationId is null for products without a
          // ProductVariation, and Prisma rejects a null component in a compound-
          // unique findUnique. The unique constraint still guarantees ≤1 match.
          const existingStock = await prisma.stockLevel.findFirst({
            where: {
              locationId: primaryLocation.id,
              productId,
              variationId: null,
            },
          });

          if (existingStock) {
            const delta = stockQty - existingStock.quantity;
            if (delta !== 0) {
              await prisma.$transaction([
                prisma.stockLevel.update({
                  where: { id: existingStock.id },
                  data: {
                    quantity: stockQty,
                    available: Math.max(0, stockQty - existingStock.reserved),
                  },
                }),
                prisma.stockMovement.create({
                  data: {
                    productId,
                    locationId: primaryLocation.id,
                    change: delta,
                    balanceAfter: stockQty,
                    quantityBefore: existingStock.quantity,
                    reason: 'MANUAL_ADJUSTMENT',
                    referenceType: 'FlatFileSync',
                    notes: 'eBay flat-file sync',
                    actor: 'system',
                  },
                }),
                prisma.product.update({
                  where: { id: productId },
                  data: { totalStock: stockQty },
                }),
              ]);
            }
          } else {
            await prisma.$transaction([
              prisma.stockLevel.create({
                data: {
                  locationId: primaryLocation.id,
                  productId,
                  variationId: null as any,
                  quantity: stockQty,
                  reserved: 0,
                  available: stockQty,
                },
              }),
              prisma.stockMovement.create({
                data: {
                  productId,
                  locationId: primaryLocation.id,
                  change: stockQty,
                  balanceAfter: stockQty,
                  quantityBefore: 0,
                  reason: 'MANUAL_ADJUSTMENT',
                  referenceType: 'FlatFileSync',
                  notes: 'eBay flat-file sync (initial)',
                  actor: 'system',
                },
              }),
              prisma.product.update({
                where: { id: productId },
                data: { totalStock: stockQty },
              }),
            ]);
          }
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

    // Get eBay connection — connectionMetadata carries ebayPolicies (policy IDs +
    // merchantLocationKey) configured by the operator in account settings.
    const connection = await prisma.channelConnection.findFirst({
      where: { channelType: 'EBAY', isActive: true },
      select: { id: true, connectionMetadata: true },
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

    // ── FCF.3 / FCF.5 — per-pool oversell guard ─────────────────────
    // An eBay listing is bound to a stock pool by its
    // ChannelListing.fulfillmentMethod:
    //   • FBM (default) → own-warehouse pool (StockLevel.available). FBA stock
    //     sits at Amazon and can't ship a merchant order.
    //   • FBA (= MCF, FCF.5) → Amazon FBA SELLABLE pool — Amazon ships the eBay
    //     order via Multi-Channel Fulfillment, so it's safe to publish FBA qty.
    // Never publish more than the bound pool holds (less the listing buffer).
    // Per-variant (row._productId); products/SKUs with NO stock record for the
    // resolved pool are left uncapped but flagged (a data gap is not a real
    // stockout — don't mass-delist on missing data).
    const pushProductIds = [
      ...new Set(rows.map((r) => r._productId as string | undefined).filter((x): x is string => !!x)),
    ];
    const pushSkus = [...new Set(rows.map((r) => r.sku as string | undefined).filter((x): x is string => !!x))];
    const fbmByProduct = new Map<string, number>();
    const trackedProducts = new Set<string>();
    // FCF.3b — per (product, market) eBay stock buffer. FCF.5 — per (product,
    // market) resolved fulfillment method. Both keyed `${productId}::${MARKET}`.
    const bufferByListing = new Map<string, number>();
    const methodByListing = new Map<string, 'FBA' | 'FBM'>();
    // FCF.5 — FBA SELLABLE per `${sku}::${MARKET}` for MCF-backed listings.
    const fbaBySkuMarket = new Map<string, number>();
    // FCF.6 — in-flight MCF reservations against the FBA pool, per product.
    let pendingMcfByProduct = new Map<string, number>();
    if (pushProductIds.length > 0) {
      const [whRows, clRows, fbaRows, pendingMcf] = await Promise.all([
        prisma.stockLevel.findMany({
          where: { productId: { in: pushProductIds }, location: { type: 'WAREHOUSE' } },
          select: { productId: true, available: true },
        }),
        prisma.channelListing.findMany({
          where: { productId: { in: pushProductIds }, channel: 'EBAY' },
          select: { productId: true, marketplace: true, stockBuffer: true, fulfillmentMethod: true },
        }),
        pushSkus.length > 0
          ? prisma.fbaInventoryDetail.findMany({
              where: { sku: { in: pushSkus }, condition: 'SELLABLE' },
              select: { sku: true, quantity: true, marketplaceId: true },
            })
          : Promise.resolve([] as Array<{ sku: string; quantity: number; marketplaceId: string }>),
        getPendingMcfReservedByProduct(pushProductIds),
      ]);
      pendingMcfByProduct = pendingMcf;
      for (const r of whRows) {
        trackedProducts.add(r.productId);
        fbmByProduct.set(r.productId, (fbmByProduct.get(r.productId) ?? 0) + r.available);
      }
      for (const cl of clRows) {
        const key = `${cl.productId}::${(cl.marketplace ?? '').toUpperCase()}`;
        bufferByListing.set(key, cl.stockBuffer ?? 0);
        if (cl.fulfillmentMethod === 'FBA' || cl.fulfillmentMethod === 'FBM') methodByListing.set(key, cl.fulfillmentMethod);
      }
      for (const r of fbaRows) {
        const code = MARKETPLACE_ID_TO_CODE[r.marketplaceId] ?? r.marketplaceId;
        const key = `${r.sku}::${code}`;
        fbaBySkuMarket.set(key, (fbaBySkuMarket.get(key) ?? 0) + r.quantity);
      }
    }
    const oversellWarnings: Array<{ sku: string; requested: number; published: number; reason: string }> = [];
    // Resolve the listing's pool, then cap the requested qty at what that pool
    // can publish. Named capToFbm historically; now pool-aware (FCF.5).
    const capToFbm = (pid: string | undefined, sku: string, requested: number, market?: string): number => {
      const req = Number(requested) || 0;
      const mkt = (market ?? '').toUpperCase();
      const listingKey = pid ? `${pid}::${mkt}` : '';
      const stockBuffer = listingKey ? bufferByListing.get(listingKey) ?? 0 : 0;
      // Default merchant channel = FBM; FBA means MCF (Amazon ships).
      const method = (listingKey ? methodByListing.get(listingKey) : undefined) ?? 'FBM';

      if (method === 'FBA') {
        // MCF: cap at the Amazon FBA SELLABLE pool for this sku + market.
        const fbaKey = `${sku}::${mkt}`;
        if (!fbaBySkuMarket.has(fbaKey)) {
          if (req > 0) oversellWarnings.push({ sku, requested: req, published: req, reason: 'FBA stock not tracked (MCF) — not capped' });
          return req;
        }
        const cap = computeAvailableToPublish({
          fulfillmentMethod: 'FBA',
          warehouseAvailable: 0,
          fbaSellable: fbaBySkuMarket.get(fbaKey) ?? 0,
          stockBuffer,
          // FCF.6 — don't republish FBA units already committed to in-flight MCF.
          pendingReserved: pid ? pendingMcfByProduct.get(pid) ?? 0 : 0,
        }).available;
        if (req > cap) {
          oversellWarnings.push({
            sku, requested: req, published: cap,
            reason: stockBuffer > 0 ? `capped to FBA-available, MCF (buffer ${stockBuffer})` : 'capped to FBA-available (MCF)',
          });
          return cap;
        }
        return req;
      }

      // FBM (default): own-warehouse pool.
      if (!pid || !trackedProducts.has(pid)) {
        if (req > 0) oversellWarnings.push({ sku, requested: req, published: req, reason: 'FBM stock not tracked — not capped' });
        return req;
      }
      const cap = computeAvailableToPublish({
        fulfillmentMethod: 'FBM',
        warehouseAvailable: fbmByProduct.get(pid) ?? 0,
        fbaSellable: 0,
        stockBuffer,
      }).available;
      if (req > cap) {
        oversellWarnings.push({
          sku, requested: req, published: cap,
          reason: stockBuffer > 0 ? `capped to FBM-available (buffer ${stockBuffer})` : 'capped to FBM-available',
        });
        return cap;
      }
      return req;
    };

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
            // FCF.3 — cap at FBM-available so the feed never lists more than we hold.
            quantity: capToFbm(r._productId as string | undefined, r.sku as string, Number(r[`${prefix}_qty`] ?? r.quantity ?? 0), mp),
          } as unknown as EbayFlatRow;
        });

        const ndjson = buildInventoryNdjson(feedRows);
        const taskId = await createInventoryTask(mp, token);
        await uploadFeedFile(taskId, ndjson, token);

        return reply.send({
          mode: 'feed',
          taskId,
          rowCount: rows.length,
          warnings: oversellWarnings,
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
            connection.id,
            (connection.connectionMetadata ?? {}) as Record<string, unknown>,
            EBAY_API_BASE,
            marketplaceId,
            capToFbm,
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
        const lang = toListingLanguage(mp);
        const price = Number(row[`${prefix}_price`] ?? row.price ?? 0);
        // FCF.3 — cap at FBM-available so eBay never lists more than we hold.
        const qty = capToFbm(row._productId as string | undefined, sku, Number(row[`${prefix}_qty`] ?? row.quantity ?? 0), mp);

        try {
          const encodedSku = encodeURIComponent(sku);
          const invUrl = `${EBAY_API_BASE}/sell/inventory/v1/inventory_item/${encodedSku}`;

          // Filter Amazon CDN URLs — eBay cannot crawl m.media-amazon.com.
          const imageUrls: string[] = [];
          for (let i = 1; i <= 6; i++) {
            const url = row[`image_${i}`] as string | undefined;
            if (url && !url.includes('amazon.com')) imageUrls.push(url);
          }

          // Deduplicate aspects by key (Map last-write wins for repeated keys).
          const aspectsMap = new Map<string, string[]>();
          for (const [key, val] of Object.entries(row)) {
            if (key.startsWith('aspect_') && typeof val === 'string' && val) {
              aspectsMap.set(key.slice('aspect_'.length).replace(/_/g, ' '), [val]);
            }
          }
          if (row.ean) aspectsMap.set('EAN', [row.ean as string]);
          if (row.mpn) aspectsMap.set('MPN', [row.mpn as string]);
          const aspects = Object.fromEntries(aspectsMap);

          // Translate numeric conditionId ('1000') to eBay ConditionEnum ('NEW').
          const rawCond = String(row.condition ?? '');
          const condition = CONDITION_ID_TO_ENUM[rawCond] ?? (rawCond || 'NEW');

          const invBody = {
            product: {
              title: (row.title as string) ?? sku,
              description: (row.description as string) ?? '',
              imageUrls,
              aspects,
              ...((row.ean as string) ? { ean: [row.ean as string] } : {}),
              ...((row.mpn as string) ? { mpn: row.mpn as string } : {}),
            },
            condition,
            availability: {
              shipToLocationAvailability: { quantity: qty },
            },
            ...(buildPackageWeightAndSize(row)
              ? { packageWeightAndSize: buildPackageWeightAndSize(row) }
              : {}),
          };

          const invRes = await fetch(invUrl, {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Content-Language': lang,
              'Accept-Language': lang,
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
            // Single headers object reused for all steps (mirrors ebay-publish.adapter.ts).
            // Both Content-Language AND Accept-Language required on every Inventory API call.
            const singleHeaders = {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Content-Language': lang,
              'Accept-Language': lang,
              Accept: 'application/json',
              'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
            };

            // Policy waterfall — row data → connectionMetadata → live snapshot.
            // Hard-fail if merchantLocationKey cannot be resolved (causes error 25002).
            const connMeta = ((connection.connectionMetadata ?? {}) as Record<string, unknown>)
            const connPolicies = ((connMeta.ebayPolicies ?? {}) as {
              fulfillmentPolicyId?: string; paymentPolicyId?: string;
              returnPolicyId?: string; merchantLocationKey?: string;
            })
            let sFulfillmentId  = (row.fulfillment_policy_id  as string | undefined) || connPolicies.fulfillmentPolicyId  || ''
            let sPaymentId      = (row.payment_policy_id      as string | undefined) || connPolicies.paymentPolicyId      || ''
            let sReturnId       = (row.return_policy_id       as string | undefined) || connPolicies.returnPolicyId       || ''
            let sMlk            = (row.merchant_location_key  as string | undefined) || connPolicies.merchantLocationKey   || ''
            if (!sFulfillmentId || !sPaymentId || !sReturnId || !sMlk) {
              const snap = await ebayAccountService.getSnapshot(connection.id, marketplaceId)
              if (!sFulfillmentId) sFulfillmentId = snap.fulfillmentPolicies[0]?.id ?? ''
              if (!sPaymentId)     sPaymentId     = snap.paymentPolicies[0]?.id     ?? ''
              if (!sReturnId)      sReturnId      = snap.returnPolicies[0]?.id      ?? ''
              if (!sMlk)           sMlk           = snap.locations[0]?.key           ?? ''
            }
            if (!sMlk) {
              perRowResults.push({ sku, market: mp, status: 'ERROR',
                message: 'Missing merchantLocation: add an inventory location in eBay Seller Hub > Inventory > Locations' })
              continue
            }

            const offerBody: Record<string, unknown> = {
              sku,
              marketplaceId,
              format: 'FIXED_PRICE',
              listingDescription: (row.description as string) ?? '',
              categoryId,
              pricingSummary: { price: { value: price.toFixed(2), currency } },
              listingPolicies: {
                ...(sFulfillmentId ? { fulfillmentPolicyId: sFulfillmentId } : {}),
                ...(sPaymentId     ? { paymentPolicyId: sPaymentId }         : {}),
                ...(sReturnId      ? { returnPolicyId: sReturnId }           : {}),
              },
              merchantLocationKey: sMlk,
              quantityLimitPerBuyer: 10,
            };

            // Check if offer exists
            const getOfferUrl = `${EBAY_API_BASE}/sell/inventory/v1/offer?sku=${encodedSku}&marketplace_id=${marketplaceId}`;
            const getOfferRes = await fetch(getOfferUrl, { headers: singleHeaders });

            let offerId: string | null = null;
            if (getOfferRes.ok) {
              const offerData = (await getOfferRes.json()) as { offers?: Array<{ offerId: string }> };
              offerId = offerData.offers?.[0]?.offerId ?? null;
            }

            if (offerId) {
              const updateOfferRes = await fetch(
                `${EBAY_API_BASE}/sell/inventory/v1/offer/${offerId}`,
                { method: 'PUT', headers: singleHeaders, body: JSON.stringify(offerBody) },
              );
              if (!updateOfferRes.ok) {
                const errBody = await updateOfferRes.text().catch(() => '');
                perRowResults.push({ sku, market: mp, status: 'ERROR',
                  message: `Offer update ${updateOfferRes.status}: ${errBody.slice(0, 300)}` });
                continue;
              }
            } else {
              const createOfferRes = await fetch(`${EBAY_API_BASE}/sell/inventory/v1/offer`, {
                method: 'POST', headers: singleHeaders, body: JSON.stringify(offerBody),
              });
              if (createOfferRes.ok) {
                const offerResp = (await createOfferRes.json()) as { offerId?: string };
                offerId = offerResp.offerId ?? null;
              } else {
                const errBody = await createOfferRes.text().catch(() => '');
                perRowResults.push({ sku, market: mp, status: 'ERROR',
                  message: `Offer create ${createOfferRes.status}: ${errBody.slice(0, 300)}` });
                continue;
              }
            }

            if (offerId) {
              const publishRes = await fetch(
                `${EBAY_API_BASE}/sell/inventory/v1/offer/${offerId}/publish`,
                { method: 'POST', headers: singleHeaders, body: '{}' },
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
              } else {
                const errBody = await publishRes.text().catch(() => '');
                perRowResults.push({
                  sku,
                  market: mp,
                  status: 'ERROR',
                  message: `Publish ${publishRes.status}: ${errBody.slice(0, 300)}`,
                });
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

    return reply.send({ mode: 'api', pushed, errors, results: perRowResults, warnings: oversellWarnings });
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

  // ── A4.1 — Flat File AI Assistant ──────────────────────────────────────────
  // POST /api/ebay/flat-file/ai-assist
  fastify.post<{
    Body: {
      instruction: string
      rows: Array<Record<string, unknown>>
      columnMeta: Array<{ id: string; label: string; description?: string }>
      marketplace?: string
      model?: string
    }
  }>('/ebay/flat-file/ai-assist', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { instruction, rows, columnMeta, marketplace = 'IT', model } = request.body ?? {}

    if (!instruction || typeof instruction !== 'string' || instruction.trim().length === 0) {
      return reply.code(400).send({ error: 'instruction is required' })
    }
    if (instruction.length > 2000) {
      return reply.code(400).send({ error: 'instruction must be ≤ 2000 characters' })
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      return reply.code(400).send({ error: 'rows must be a non-empty array' })
    }
    if (rows.length > 300) {
      return reply.code(400).send({ error: 'Max 300 rows per request' })
    }

    try {
      const result = await runFlatFileAiInstruction({
        instruction: instruction.trim(),
        rows,
        columnMeta: Array.isArray(columnMeta) ? columnMeta : [],
        marketplace: (marketplace ?? 'IT').toUpperCase(),
        channel: 'EBAY',
        model: model || undefined,
      })
      return reply.send(result)
    } catch (err: any) {
      request.log.error(err, '[ebay/flat-file/ai-assist] failed')
      return reply.code(500).send({ error: err?.message ?? 'AI assistant failed' })
    }
  })

  // ── POST /api/ebay/flat-file/pull-preview/start ─────────────────────
  // In-editor pull from eBay. Fetches live inventory items + offers per
  // SKU for the requested marketplace, builds expanded EbayRow shapes
  // in memory, and returns them through the status endpoint. Does NOT
  // touch the database — the editor merges the rows into its local
  // state via PullDiffModal where the operator can review, undo
  // (Cmd+Z), and Save on their own terms.
  fastify.post<{
    Body: { marketplace?: string; skus?: string[] }
  }>('/ebay/flat-file/pull-preview/start', async (request, reply) => {
    const { marketplace = 'IT', skus } = request.body ?? {};
    const jobId = startEbayPullPreviewJob({
      marketplace,
      skus: Array.isArray(skus) && skus.length > 0 ? skus : undefined,
    });
    return reply.send({ jobId });
  });

  // ── GET /api/ebay/flat-file/pull-preview/status/:jobId ──────────────
  fastify.get<{ Params: { jobId: string } }>(
    '/ebay/flat-file/pull-preview/status/:jobId',
    async (request, reply) => {
      const job = getEbayPullPreviewJobStatus(request.params.jobId);
      if (!job) return reply.code(404).send({ error: 'Job not found or expired' });
      return reply.send(job);
    },
  );

  // ── POST /api/ebay/flat-file/pull-preview/apply ─────────────────────
  // Audit-log endpoint. Called after the operator confirms what to
  // merge in PullDiffModal. Writes one FlatFilePullRecord row with
  // channel='EBAY'. Does NOT touch product or listing data; those
  // writes flow through the editor's normal Save path.
  fastify.post<{
    Body: {
      jobId?: string
      marketplace?: string
      skusRequested?: string[]
      skusReturned?: number
      columnsApplied?: string[]
      rowsApplied?: number
      fieldsApplied?: number
      operatorNote?: string
    }
  }>('/ebay/flat-file/pull-preview/apply', async (request, reply) => {
    const {
      jobId,
      marketplace = 'IT',
      skusRequested = [],
      skusReturned = 0,
      columnsApplied = [],
      rowsApplied = 0,
      fieldsApplied = 0,
      operatorNote,
    } = request.body ?? {};

    try {
      const record = await prisma.flatFilePullRecord.create({
        data: {
          channel: 'EBAY',
          marketplace: marketplace.toUpperCase(),
          // eBay editor isn't scoped by productType — store a marker so
          // the (channel, marketplace, pulledAt) index still discriminates
          // eBay rows from Amazon's pre-existing entries.
          productType: 'EBAY_ANY',
          jobId: jobId ?? null,
          skusRequested,
          skusReturned,
          columnsApplied,
          rowsApplied,
          fieldsApplied,
          appliedAt: new Date(),
          operatorNote: operatorNote ?? null,
        },
        select: { id: true, pulledAt: true, appliedAt: true },
      });
      return reply.send({ ok: true, id: record.id });
    } catch (err: any) {
      request.log.error(err, '[ebay/flat-file/pull-preview/apply] failed');
      return reply.code(500).send({ error: err?.message ?? 'Audit write failed' });
    }
  });

}
