import { variationValuesPlan } from './pim/shared-variation-values.js'
import { writeVariationValues } from './pim/category-attributes-write.js'
import { assertWriteAccount } from './write-account-guard.js'
import { requireTranslationGeneration, previewCatalogTranslation } from './pim/catalog-translate.js'
import { getAmazonSellerId } from '../lib/amazon-sp-client.js'
import { workspaceKey } from '@nexus/database/workspace-context'
/**
 * BulkActionService
 * Manages asynchronous bulk operations with progress tracking and error handling
 * Supports: PRICING_UPDATE, INVENTORY_UPDATE, STATUS_UPDATE, ATTRIBUTE_UPDATE, LISTING_SYNC
 */

import { prisma } from '@nexus/database';
import { Prisma } from '@prisma/client';
import type {
  BulkActionJob,
  ChannelListing,
  PrismaClient,
  Product,
  ProductVariation,
} from '@prisma/client';
import { logger } from '../utils/logger.js';
import { publishListingEvent } from './listing-events.service.js';
import { isFbaListing } from './outbound-sync.service.js';
import { MasterPriceRefusedError, MasterPriceService, PRICE_EDIT_PERMISSION, PRICE_EDIT_REFUSAL } from './master-price.service.js';
import { MasterStatusService } from './master-status.service.js';
import { applyStockMovement } from './stock-movement.service.js';
import { listActiveConnections, tryResolveConnection } from './connection-resolver.service.js';
import { assertPushAllowed } from '@nexus/shared/push-lock';
import { listingSendPrice } from './pim/follower-price.js';
import { marketCurrency } from './pim/market-currency.js';
import { priceBoundsOf, priceBoundsRefusal, zeroPriceReason } from './price-bounds.service.js';
import { masterCurrency } from './fx-rate.service.js';
// The ONE channel price write: a bulk price override goes through it like every other channel price edit.
import { writeChannelPrices } from './pim/channel-price-write.service.js';
import { adjustmentPercentProblem, normalisePricingRule, PRICING_RULES, type PricingRuleName } from '@nexus/shared/listing-price';
import { activeDatabaseTransaction, inDatabaseTransaction } from '../lib/database-context.js';
import { bulkActorNames } from './bulk-action-actor.js';
// The quantity and buffer primitives the Studio matrix and Sync Control use (the single-listing edit's path).
import { setFollowMasterQuantity, setStockBuffer, type FollowMasterChannel } from './follow-master.service.js';
import { AMAZON_EU_SHARED_MARKETS } from './amazon-eu-quantity-guard.js';
import { whereCoordinate, type ListingCoordinate } from '../lib/listing-coordinate.js';
// Shared stock — a pooled product's fallback is the pool's number, not its business's own total.
import { sellableQuantity } from './stock-pool/sync-ledgers.js';
// W1.8 — ATTRIBUTE_UPDATE helpers lifted into a focused module. Pure
// functions, no `this.`, no Prisma. Adding a new attribute path
// (variantAttributes, channelMetadata, …) is one diff to that file
// rather than navigating the full bulk-action service.
import {
  ATTRIBUTE_SCALAR_ALLOWLIST,
  CATEGORY_ATTRIBUTES_PREFIX,
  VARIANT_ATTRIBUTES_PREFIX,
  readProductAttribute,
  type ProductLike,
} from './bulk-action/attribute-helpers.js';
// PRICING_UPDATE — one rule per row for every mode, shared by the run and its preview.
import { currentBasePrice, pricingUpdateOutcome } from './bulk-action/pricing-update.js';

// (Removed: a stubbed Decimal mock class whose `.plus()` returned
// `this`, breaking every PRICING_UPDATE math op silently. Phase B-3
// rewrites the pricing handler with plain JS arithmetic.)

/**
 * W1.2 (2026-05-09) — actionType drift fix.
 *
 * Three independent code paths historically wrote BulkActionJob rows
 * with incompatible `actionType` strings:
 *
 *   1. BulkActionService (this file) — accepts the canonical six.
 *   2. listings-syndication.routes.ts:2870 — writes the literal
 *      'LISTING_BULK_ACTION' direct via `prisma.bulkActionJob.create`,
 *      bypassing this service.
 *   3. BulkOperationModal.tsx — surfaces 'SCHEMA_FIELD_UPDATE' but
 *      posts to /api/products/bulk-schema-update (NOT BulkActionJob).
 *
 * This union is now the single source of truth for *every* row in
 * BulkActionJob, including the listing-syndication path. The Zod
 * schema (validation.ts) and the syndication router both validate
 * against KNOWN_BULK_ACTION_TYPES below before insert.
 *
 * SCHEMA_FIELD_UPDATE is intentionally NOT in the union — it never
 * persists a BulkActionJob row. If that ever changes, add it here.
 */
export type BulkActionType =
  | 'PRICING_UPDATE'
  | 'INVENTORY_UPDATE'
  | 'STATUS_UPDATE'
  | 'ATTRIBUTE_UPDATE'
  | 'LISTING_SYNC'
  | 'MARKETPLACE_OVERRIDE_UPDATE'
  | 'LISTING_BULK_ACTION'
  // W11.1 — bulk translation of Product copy. payload =
  //   { targetLanguages: string[], fields?: ('name'|'description'|'bulletPoints')[] }.
  // Each item resolves to a Product; the handler upserts one
  // ProductTranslation row per (product, language).
  | 'AI_TRANSLATE_PRODUCT'
  // W11.2 — bulk SEO regeneration. payload =
  //   { locales: string[] }.
  // Per-locale ProductSeo upsert: metaTitle / metaDescription /
  // ogTitle / ogDescription rewritten by the LLM with SERP-aware
  // length caps applied defensively.
  | 'AI_SEO_REGEN'
  // W11.3 — bulk alt-text generation. payload =
  //   { onlyEmpty?: boolean (default true), locale?: string }.
  // For each item Product, walks ProductImage rows and writes
  // ProductImage.alt with an AI-generated description. v0 is
  // text-only (derived from product context); a vision-capable
  // v1 follow-up could send the image URL to a multimodal model.
  | 'AI_ALT_TEXT'
  // W12.4 — Channel batch submission. payload =
  //   { channel: 'AMAZON' | 'EBAY' | 'SHOPIFY',
  //     operation: 'price' | 'stock',
  //     marketplace?: string }.
  // For each item Product, looks up its ChannelListing on the
  // requested channel/marketplace and submits via the new W12.1-3
  // batch services. v0 fires one batch submission per item — the
  // services can handle N-message batches but the per-item loop
  // here doesn't aggregate yet. A future commit can add a
  // job-level accumulator for true cross-item batching.
  | 'CHANNEL_BATCH';

/**
 * Runtime allowlist mirroring `BulkActionType`. Used by the Zod
 * schema in validation.ts and by listings-syndication.routes.ts to
 * reject typo'd / drifted action types at the boundary, before they
 * land in the BulkActionJob table.
 */
export const KNOWN_BULK_ACTION_TYPES: ReadonlySet<BulkActionType> = new Set([
  'PRICING_UPDATE',
  'INVENTORY_UPDATE',
  'STATUS_UPDATE',
  'ATTRIBUTE_UPDATE',
  'LISTING_SYNC',
  'MARKETPLACE_OVERRIDE_UPDATE',
  'LISTING_BULK_ACTION',
  'AI_TRANSLATE_PRODUCT',
  'AI_SEO_REGEN',
  'AI_ALT_TEXT',
  'CHANNEL_BATCH',
]);

export function isKnownBulkActionType(t: string): t is BulkActionType {
  return KNOWN_BULK_ACTION_TYPES.has(t as BulkActionType);
}
/**
 * Which Prisma entity each action type operates on. Keeps
 * getItemsForJob honest — STATUS lives on Product, everything
 * else lives on ProductVariation. E.5a adds 'channelListing' for
 * MARKETPLACE_OVERRIDE_UPDATE which writes per-marketplace overrides
 * (price, quantity, stockBuffer, followMaster* toggles) directly on
 * ChannelListing rows.
 */
const ACTION_ENTITY = {
  // PRICING + INVENTORY route through master-cascade entrypoints
  // (MasterPriceService.update / applyStockMovement) so changes
  // propagate to ChannelListing + OutboundSyncQueue + AuditLog
  // atomically. See DEVELOPMENT.md "Master-data cascade".
  PRICING_UPDATE: 'product',
  INVENTORY_UPDATE: 'product',
  STATUS_UPDATE: 'product',
  // C.9 — ATTRIBUTE_UPDATE + LISTING_SYNC now target Product (was
  // 'variation'). The ProductVariation table is empty in production —
  // variants live as Product children via Product.parentId. C.9
  // rewires both action types to operate on Product rows directly.
  // ATTRIBUTE_UPDATE supports a strict allowlist of scalar columns
  // plus the categoryAttributes JSON path; LISTING_SYNC enqueues
  // OutboundSyncQueue rows per ChannelListing.
  ATTRIBUTE_UPDATE: 'product',
  LISTING_SYNC: 'product',
  MARKETPLACE_OVERRIDE_UPDATE: 'channelListing',
  // W1.2 — LISTING_BULK_ACTION jobs (listings-syndication.routes.ts)
  // store ChannelListing IDs in BulkActionJob.targetProductIds (the
  // column is reused across surfaces — see comment on that route).
  // Mark the entity 'channelListing' to keep ACTION_ENTITY honest;
  // BulkActionService itself never processes these (that route runs
  // its own per-listing worker), so this entry is documentation +
  // rollback-eligibility wiring rather than execution dispatch.
  LISTING_BULK_ACTION: 'channelListing',
  // W11.1 — AI bulk translation operates on Product rows; the
  // handler reads master copy + writes ProductTranslation rows.
  AI_TRANSLATE_PRODUCT: 'product',
  // W11.2 — AI bulk SEO regen operates on Product rows; the
  // handler reads master copy + writes ProductSeo rows per
  // requested locale.
  AI_SEO_REGEN: 'product',
  // W11.3 — AI bulk alt-text operates on Product rows; the
  // handler walks ProductImage rows for each product and
  // upserts the alt column.
  AI_ALT_TEXT: 'product',
  // W12.4 — CHANNEL_BATCH operates on Product rows; the handler
  // resolves each Product to its ChannelListing on the configured
  // (channel, marketplace) and routes through the W12.1/W12.2/W12.3
  // batch services.
  CHANNEL_BATCH: 'product',
} as const satisfies Record<
  BulkActionType,
  'product' | 'variation' | 'channelListing'
>;

/**
 * User-facing scope filter shape — what the frontend scope picker
 * sends, what /preview and /create accept. Field names match the
 * actual Product / ProductVariation / ChannelListing schema (the
 * spec's `category`, `stockQuantity`, `marketplaceId` are wrong;
 * real names are productType, stock, marketplace).
 */
export interface ScopeFilters {
  brand?: string;
  productType?: string;
  /** Marketplace key on ChannelListing — e.g. "IT", "DE", "GLOBAL". */
  marketplace?: string;
  status?: 'DRAFT' | 'ACTIVE' | 'INACTIVE';
  stockMin?: number;
  stockMax?: number;
}

export type BulkActionStatus =
  | 'PENDING'
  | 'QUEUED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'FAILED'
  | 'PARTIALLY_COMPLETED'
  /**
   * W1.1 — transient state set by `cancelJob` when the operator cancels
   * an IN_PROGRESS job. The per-item loop in `processJob` re-reads the
   * status column between items; observing CANCELLING (or CANCELLED)
   * causes a clean exit that finalises the job as CANCELLED with the
   * partial counts already recorded.
   */
  | 'CANCELLING'
  | 'CANCELLED';

export interface CreateJobInput {
  jobName: string;
  actionType: BulkActionType;
  channel?: string;
  targetProductIds?: string[];
  targetVariationIds?: string[];
  filters?: Record<string, any>;
  actionPayload: Record<string, any>;
  createdBy?: string;
  /**
   * S1 (F5) — the acting person's permissions, from the request (`permissionCheckerFor`). Given, a job that changes
   * prices needs `products.price.edit`; automation and the system's own jobs pass none.
   */
  can?: (permission: string) => boolean;
}

/** S1 (F5) — a person without `products.price.edit` asked for a bulk job that changes prices. No job was created. */
export class BulkActionPermissionError extends Error {
  readonly statusCode = 403;
  readonly code = 'PRICE_PERMISSION';
  constructor() {
    super(PRICE_EDIT_REFUSAL);
    this.name = 'BulkActionPermissionError';
  }
}

/**
 * S1 (F5) — does this bulk job change prices? A PRICING_UPDATE always does; a marketplace override when it carries a
 * price or a pricing rule (the price door's pin, hand-back or follower mode). A payload the override reader refuses is
 * refused by `createJob` itself, so it is not a price change here.
 */
export function bulkJobChangesPrices(actionType: string, actionPayload: Record<string, any> | null | undefined): boolean {
  if (actionType === 'PRICING_UPDATE') return true;
  if (actionType !== 'MARKETPLACE_OVERRIDE_UPDATE') return false;
  try {
    const plan = marketplaceOverridePlan(actionPayload ?? {});
    return plan.price !== undefined || plan.rule !== undefined;
  } catch {
    return false;
  }
}

/** S1 (F5) — refuse a price-changing bulk job for a person without `products.price.edit`. */
export function assertBulkJobPricePermission(
  input: { actionType: string; actionPayload?: Record<string, any> | null },
  can: (permission: string) => boolean,
): void {
  if (bulkJobChangesPrices(input.actionType, input.actionPayload) && !can(PRICE_EDIT_PERMISSION)) {
    throw new BulkActionPermissionError();
  }
}

export interface UpdateProgressInput {
  processedItems: number;
  failedItems: number;
  skippedItems: number;
  errors?: Array<{
    itemId: string;
    error: string;
    timestamp: Date;
  }>;
}

export interface ProcessJobResult {
  jobId: string;
  status: BulkActionStatus;
  processedItems: number;
  failedItems: number;
  skippedItems: number;
  totalItems: number;
  errors: Array<{
    itemId: string;
    error: string;
    timestamp: Date;
  }>;
}

/**
 * One in-flight job that overlaps with the candidate input.
 *
 * `overlapCount` is the number of products both jobs touch; on filter-based
 * inputs it's a probabilistic estimate (sampled set intersection at the
 * resolution cap). `overlapTruncated=true` means at least one side hit the
 * cap during resolution — the real overlap may be larger.
 */
export interface ConflictingJob {
  jobId: string;
  jobName: string;
  actionType: BulkActionType;
  status: string;
  startedAt: Date | null;
  createdAt: Date;
  createdBy: string | null;
  totalItems: number;
  progressPercent: number;
  overlapCount: number;
  overlapTruncated: boolean;
}

/**
 * What one MARKETPLACE_OVERRIDE_UPDATE payload does to a listing — the ONE reading of the payload, used by
 * `createJob` (refuse a bad payload before a job exists), the preview and the run, so the preview cannot show a
 * different change from the one that runs.
 *
 * Each field goes the way the app's single-listing edit of that field goes:
 *   - `price` → the ONE channel price write (`writeChannelPrices`): `undefined` = untouched, a number pins the listing
 *     at it, `null` hands it back to the master price. `priceOverride: null` and `followMasterPrice: true` are both
 *     that hand-back.
 *   - `quantity` → the follow/pin primitive the Studio matrix and Sync Control use (`setFollowMasterQuantity`):
 *     `{ follow: true }` rejoins the stock pool; `{ follow: false, value }` fixes it at `value` (the matrix's typed
 *     number); `{ follow: false }` fixes it at the number it shows now (Sync Control's Fixed number).
 *   - `buffer` → the stock-buffer primitive (`setStockBuffer`), as the matrix's buffer cell.
 *   - `isPublished` is refused, as the single-listing edit refuses it (`PATCH /listings/:id`): a local flag cannot
 *     confirm a marketplace change; publishing and withdrawing go through the listing channel workflow.
 *   - `rule` — the pricing rule and the adjustment percent — goes through the same door (its follower mode, 2026-10-01):
 *     written in the price's compare-and-set, and a following listing's price is recomputed by the new rule and sent,
 *     as the single-listing edit now does. Before, they were plain columns and nothing was sent.
 *   - `columns` — the content follow flags — are written as before and queue nothing.
 */
/** `follow: true` rejoins the stock pool; `follow: false` fixes it — at `value` when given, else at the number it shows now. */
export type OverrideQuantity = { follow: boolean; value?: number };
export interface MarketplaceOverridePlan {
  price?: number | null;
  /** The pricing rule (upper case) and/or the adjustment percent, for the price door's follower mode. */
  rule?: { pricingRule?: PricingRuleName; priceAdjustmentPercent?: number };
  quantity?: OverrideQuantity;
  buffer?: number;
  columns: Prisma.ChannelListingUpdateInput;
}

/**
 * A bulk job the caller asked for cannot run as asked — a payload every row would refuse, no channel scope, a scope
 * that matches nothing. The routes answer it 400 with this plain reason (`statusCode`, as `ListingCoordinateError`
 * does); anything else a job throws is a server fault and stays 500.
 */
export class BulkActionInputError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'BulkActionInputError';
  }
}

/** The single-listing edit's own sentence (`PATCH /listings/:id`, `POST /listings/bulk-action`). */
export const PUBLISH_FLAG_REFUSAL =
  'isPublished cannot be set by a bulk override. Use the listing channel workflow to publish or withdraw listings. A local status flag cannot confirm a marketplace change.';

const OVERRIDE_FOLLOW_KEYS = [
  'followMasterTitle',
  'followMasterDescription',
  'followMasterImages',
  'followMasterBulletPoints',
] as const;
/** Every field an override payload may carry (`isPublished` is known, and refused by its own sentence). */
const OVERRIDE_FIELDS = [
  'priceOverride', 'followMasterPrice', 'quantityOverride', 'followMasterQuantity', 'stockBuffer',
  ...OVERRIDE_FOLLOW_KEYS, 'pricingRule', 'priceAdjustmentPercent', 'isPublished',
] as const;
/** The likely meant field for a near miss — `price` for `priceOverride` is the one callers make. */
const OVERRIDE_FIELD_HINTS: Record<string, string> = { price: 'priceOverride', quantity: 'quantityOverride', buffer: 'stockBuffer' };

export function marketplaceOverridePlan(payload: Record<string, any>): MarketplaceOverridePlan {
  const numOrNull = (v: unknown): number | null | undefined => {
    if (v === null) return null;
    if (typeof v === 'number' && !Number.isNaN(v)) return v;
    if (typeof v === 'string' && v.length > 0 && !Number.isNaN(Number(v))) return Number(v);
    return undefined;
  };
  const columns: Prisma.ChannelListingUpdateInput = {};

  // A field the override does not know is never dropped silently: a typo would otherwise leave the price unchanged
  // while the job reports success. Named, with the field that was probably meant.
  const unknown = Object.keys(payload).filter((k) => !(OVERRIDE_FIELDS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    const named = unknown.map((k) => (OVERRIDE_FIELD_HINTS[k] ? `${k} (did you mean ${OVERRIDE_FIELD_HINTS[k]}?)` : k));
    throw new BulkActionInputError(
      `Unknown override field${unknown.length > 1 ? 's' : ''}: ${named.join(', ')}. The fields are: ${OVERRIDE_FIELDS.join(', ')}.`,
    );
  }
  if ('isPublished' in payload) throw new BulkActionInputError(PUBLISH_FLAG_REFUSAL);
  for (const flag of ['followMasterPrice', 'followMasterQuantity'] as const) {
    if (flag in payload && typeof payload[flag] !== 'boolean') throw new BulkActionInputError(`${flag} must be true or false.`);
  }

  let price: number | null | undefined;
  if ('priceOverride' in payload) {
    const v = numOrNull(payload.priceOverride);
    // Before, an unreadable price was skipped without a word; a price someone typed is never dropped silently.
    if (v === undefined) {
      throw new BulkActionInputError('priceOverride must be a number, or null to follow the master price again.');
    }
    // A typed price is above 0, as the price door requires (2026-10-01; 0 used to be accepted here).
    if (v !== null && (!Number.isFinite(v) || v <= 0)) {
      throw new BulkActionInputError('priceOverride must be above 0.');
    }
    price = v;
  }
  if (payload.followMasterPrice === true) {
    if (price != null) {
      throw new BulkActionInputError('priceOverride and followMasterPrice: true contradict each other: send one of them.');
    }
    price = null;
  } else if (payload.followMasterPrice === false && price == null) {
    throw new BulkActionInputError('followMasterPrice: false needs the price to send: set priceOverride to it.');
  }

  // The quantity — never dropped silently either, and a whole number (the matrix's own rule).
  let quantity: OverrideQuantity | undefined;
  if ('quantityOverride' in payload) {
    const v = numOrNull(payload.quantityOverride);
    if (v === undefined) {
      throw new BulkActionInputError('quantityOverride must be a whole number, or null to follow the stock again.');
    }
    if (v !== null && (!Number.isInteger(v) || v < 0)) {
      throw new BulkActionInputError('quantityOverride must be a whole number, zero or more.');
    }
    quantity = v === null ? { follow: true } : { follow: false, value: v };
  }
  if (payload.followMasterQuantity === true) {
    if (quantity && !quantity.follow) {
      throw new BulkActionInputError('quantityOverride and followMasterQuantity: true contradict each other: send one of them.');
    }
    quantity = { follow: true };
  } else if (payload.followMasterQuantity === false) {
    if (quantity?.follow) {
      throw new BulkActionInputError('quantityOverride: null and followMasterQuantity: false contradict each other: send one of them.');
    }
    quantity ??= { follow: false };
  }

  let buffer: number | undefined;
  if ('stockBuffer' in payload) {
    const v = numOrNull(payload.stockBuffer);
    if (v == null || !Number.isInteger(v) || v < 0) {
      throw new BulkActionInputError('stockBuffer must be a whole number, zero or more.');
    }
    buffer = v;
  }

  for (const k of OVERRIDE_FOLLOW_KEYS) {
    if (!(k in payload)) continue;
    if (typeof payload[k] !== 'boolean') throw new BulkActionInputError(`${k} must be true or false.`);
    (columns as Record<string, unknown>)[k] = payload[k];
  }
  // The pricing rule and percent: checked by the functions the price door checks with (a rule in any case, stored upper
  // case; a percent with at most 2 decimals, above -100 and within the column), then sent through the door.
  let rule: MarketplaceOverridePlan['rule'];
  if ('pricingRule' in payload) {
    const name = normalisePricingRule(payload.pricingRule);
    if (!name) throw new BulkActionInputError(`pricingRule must be one of ${PRICING_RULES.join(', ')}.`);
    rule = { ...rule, pricingRule: name };
  }
  if ('priceAdjustmentPercent' in payload) {
    if (typeof payload.priceAdjustmentPercent !== 'number') throw new BulkActionInputError('priceAdjustmentPercent must be a number.');
    const problem = adjustmentPercentProblem(payload.priceAdjustmentPercent);
    if (problem) throw new BulkActionInputError(problem);
    rule = { ...rule, priceAdjustmentPercent: payload.priceAdjustmentPercent };
  }

  if (price === undefined && rule === undefined && quantity === undefined && buffer === undefined && Object.keys(columns).length === 0) {
    throw new BulkActionInputError(
      'Invalid MARKETPLACE_OVERRIDE_UPDATE payload: at least one override field required',
    );
  }
  return {
    ...(price !== undefined ? { price } : {}),
    ...(rule !== undefined ? { rule } : {}),
    ...(quantity !== undefined ? { quantity } : {}),
    ...(buffer !== undefined ? { buffer } : {}),
    columns,
  };
}

/**
 * A-17 — the listing's own price as the job READ it: a number = pinned at it, `null` = following the master,
 * `undefined` = no clear answer (then no retry basis is offered). The same reading the price door makes.
 */
function ownPriceAsRead(listing: Pick<ChannelListing, 'price' | 'priceOverride' | 'followMasterPrice'>): number | null | undefined {
  const override = listing.priceOverride == null ? null : Number(listing.priceOverride);
  if (listing.followMasterPrice === false) return override ?? (listing.price == null ? null : Number(listing.price));
  return override == null ? null : undefined;
}

export class BulkActionService {
  private readonly masterPriceService: MasterPriceService;
  private readonly masterStatusService: MasterStatusService;
  /**
   * A running MARKETPLACE_OVERRIDE_UPDATE job's listings, and the inventory groups it has already changed. An Amazon
   * EU quantity is one number for every EU market of a SKU, so a quantity or buffer change on one EU row is applied to
   * the SKU's whole EU group at once — and only when the job itself holds every row of that group.
   */
  private readonly overrideRuns = new Map<string, { scope: Set<string>; inventoryDone: Set<string> }>();

  constructor(private prisma: PrismaClient = prisma) {
    this.masterPriceService = new MasterPriceService(prisma);
    this.masterStatusService = new MasterStatusService(prisma);
  }

  /**
   * Create a new bulk action job
   * Initializes job with PENDING status and calculates total items to process
   */
  async createJob(input: CreateJobInput): Promise<BulkActionJob> {
    if (input.actionType === 'AI_TRANSLATE_PRODUCT') requireTranslationGeneration()
    if (input.can) assertBulkJobPricePermission(input, input.can)
    try {
      // Audit-fix #3 — MARKETPLACE_OVERRIDE_UPDATE writes to ChannelListing
      // rows; without `channel` the filter spans every channel (could blast
      // Shopify rows when targeting Amazon DE). Refuse the job rather than
      // letting the caller miss the constraint.
      if (
        input.actionType === 'MARKETPLACE_OVERRIDE_UPDATE' &&
        (!input.channel || input.channel.trim().length === 0)
      ) {
        throw new BulkActionInputError(
          'MARKETPLACE_OVERRIDE_UPDATE requires `channel` to be set (e.g. "AMAZON"). Refusing to run without a channel scope.',
        );
      }
      // A payload every row would refuse is refused once, here, before a job exists.
      if (input.actionType === 'MARKETPLACE_OVERRIDE_UPDATE') {
        marketplaceOverridePlan(input.actionPayload ?? {});
      }

      // Calculate total items to process
      let totalItems = 0;

      if (
        ACTION_ENTITY[input.actionType] === 'channelListing' &&
        (input.targetProductIds?.length || input.targetVariationIds?.length)
      ) {
        // A channel-listing job runs on LISTINGS, not products: a product on four Amazon markets is four rows. Counting
        // products here made such a job report "Progress exceeds 100%" and fail mid-run.
        const productIds = input.targetProductIds?.length
          ? input.targetProductIds
          : Array.from(new Set((await this.prisma.productVariation.findMany({
              where: { id: { in: input.targetVariationIds } },
              select: { productId: true },
            })).map((v) => v.productId)));
        totalItems = await this.prisma.channelListing.count({
          where: this.buildChannelListingWhere(
            { channel: input.channel ?? null } as BulkActionJob,
            { productIds, filters: input.filters as ScopeFilters | undefined },
          ),
        });
      } else if (input.targetVariationIds?.length) {
        totalItems = input.targetVariationIds.length;
      } else if (input.targetProductIds?.length) {
        totalItems = input.targetProductIds.length;
      } else if (input.filters) {
        // Count items matching filters, scoped to the action's
        // target entity (Product for STATUS, ProductVariation for
        // PRICING/INVENTORY/ATTRIBUTE/LISTING_SYNC).
        const target = ACTION_ENTITY[input.actionType];
        totalItems = await this.countItemsByFilters(
          input.filters as ScopeFilters,
          target,
          input.channel,
        );
      }

      if (totalItems === 0) {
        throw new BulkActionInputError('No items found matching the specified criteria');
      }

      logger.info(`Creating bulk action job: ${input.jobName}`, {
        actionType: input.actionType,
        totalItems,
        channel: input.channel
      });

      const job = await this.prisma.bulkActionJob.create({
        data: {
          jobName: input.jobName,
          actionType: input.actionType,
          channel: input.channel || null,
          targetProductIds: input.targetProductIds || [],
          targetVariationIds: input.targetVariationIds || [],
          filters: input.filters || null,
          actionPayload: input.actionPayload,
          status: 'PENDING',
          totalItems,
          processedItems: 0,
          failedItems: 0,
          skippedItems: 0,
          progressPercent: 0,
          createdBy: input.createdBy || null,
          isRollbackable: true
        }
      });

      logger.info(`Bulk action job created successfully`, { jobId: job.id });
      return job;
    } catch (error) {
      logger.error('Failed to create bulk action job', {
        error: error instanceof Error ? error.message : String(error),
        input
      });
      throw error;
    }
  }

  /**
   * Update job progress with granular tracking
   * Calculates progress percentage and updates error log
   */
  async updateProgress(jobId: string, input: UpdateProgressInput): Promise<BulkActionJob> {
    try {
      const job = await this.prisma.bulkActionJob.findUnique({
        where: { id: jobId }
      });

      if (!job) {
        throw new Error(`Job not found: ${jobId}`);
      }

      // Calculate progress percentage
      const totalProcessed = input.processedItems + input.failedItems + input.skippedItems;
      const progressPercent = Math.round((totalProcessed / job.totalItems) * 100);

      // Validate progress doesn't exceed 100%
      if (progressPercent > 100) {
        throw new Error(`Progress exceeds 100%: ${progressPercent}%`);
      }

      // W10.2 — project finish time. Linear extrapolation from
      // wall-clock elapsed since startedAt. Skip while no items have
      // finished (avoid divide-by-zero) or once the job is past
      // 99.5% complete (the projection just clamps to "now"-ish at
      // that point, so it's not informative).
      let estimatedCompletionAt: Date | null = null;
      if (
        job.startedAt &&
        totalProcessed > 0 &&
        totalProcessed < job.totalItems
      ) {
        const elapsedMs = Date.now() - job.startedAt.getTime();
        const totalEstimatedMs =
          (elapsedMs / totalProcessed) * job.totalItems;
        estimatedCompletionAt = new Date(
          job.startedAt.getTime() + totalEstimatedMs,
        );
      }

      logger.debug(`Updating job progress`, {
        jobId,
        progressPercent,
        processedItems: input.processedItems,
        failedItems: input.failedItems,
        skippedItems: input.skippedItems,
        estimatedCompletionAt,
      });

      const updatedJob = await this.prisma.bulkActionJob.update({
        where: { id: jobId },
        data: {
          processedItems: input.processedItems,
          failedItems: input.failedItems,
          skippedItems: input.skippedItems,
          progressPercent,
          estimatedCompletionAt,
          errorLog: input.errors && input.errors.length > 0 ? input.errors : null,
          lastError: input.errors?.[0]?.error || null,
          updatedAt: new Date()
        }
      });

      // P-RT.9 — fan progress out to the SSE listing-events bus so
      // any /products tab can show a live progress bar without
      // subscribing to the per-job /api/bulk-operations/:id/events
      // endpoint. The per-job endpoint is still the right tool when
      // the operator is staring at THIS job's detail view; this bus
      // event is the ambient signal for "something bulk is in flight"
      // visible everywhere a workspace is open. Fire-and-forget;
      // bus failures must never block job progress.
      try {
        publishListingEvent({
          type: 'bulk.progress',
          jobId,
          processed: input.processedItems,
          total: job.totalItems,
          succeeded: input.processedItems,
          failed: input.failedItems,
          ts: Date.now(),
        })
      } catch {
        // bus is in-process + try/catch'd; this is belt + braces
      }

      return updatedJob;
    } catch (error) {
      logger.error('Failed to update job progress', {
        jobId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Process a bulk action job
   * Wraps execution in try/catch with comprehensive error handling
   * Updates job status based on execution result
   */
  async processJob(jobId: string): Promise<ProcessJobResult> {
    let job: BulkActionJob | null = null;

    try {
      // Fetch job
      job = await this.prisma.bulkActionJob.findUnique({
        where: { id: jobId }
      });

      if (!job) {
        throw new Error(`Job not found: ${jobId}`);
      }

      if (job.status !== 'PENDING' && job.status !== 'QUEUED') {
        throw new Error(`Cannot process job with status: ${job.status}`);
      }

      logger.info(`Starting job processing`, {
        jobId,
        actionType: job.actionType,
        totalItems: job.totalItems
      });

      // Update status to IN_PROGRESS
      await this.prisma.bulkActionJob.update({
        where: { id: jobId },
        data: {
          status: 'IN_PROGRESS',
          startedAt: new Date()
        }
      });

      // Get items to process
      const items = await this.getItemsForJob(job);

      if (items.length === 0) {
        throw new Error('No items found to process');
      }
      if (job.actionType === 'MARKETPLACE_OVERRIDE_UPDATE') {
        this.overrideRuns.set(jobId, { scope: new Set(items.map((i) => i.id)), inventoryDone: new Set() });
      }

      let processedItems = 0;
      let failedItems = 0;
      let skippedItems = 0;
      let cancelled = false;
      const errors: Array<{ itemId: string; error: string; timestamp: Date }> = [];

      // Process each item. For each: insert a BulkActionItem row in
      // PENDING with the beforeState snapshot, run the handler, then
      // update the row with terminal status + afterState (or
      // errorMessage on throw). The errorLog JSON on BulkActionJob
      // is still populated for backwards compat.
      //
      // W1.1 — between items, re-read the job's `status` column. If
      // it has flipped to CANCELLING (operator clicked cancel mid-
      // flight) we break out of the loop and let the post-loop block
      // finalize the job as CANCELLED.
      //
      // W10.4 — pre-W10.4 the loop hit Prisma every single item (1ms
      // each = ~1s/1000 items). For high-volume jobs that overhead is
      // not free, and per-item cancel-responsiveness is not a real
      // requirement — operators tolerate a 1-2s delay before the
      // CANCELLING status takes effect. So now the loop checks every
      // CANCEL_POLL_EVERY items (10) AND on a max wall-clock of
      // CANCEL_POLL_MAX_MS (2000), whichever comes first.
      const CANCEL_POLL_EVERY = 10;
      const CANCEL_POLL_MAX_MS = 2000;
      let lastCancelCheck = Date.now();
      const actionType = job.actionType as BulkActionType;
      const jobPayload = (job.actionPayload ?? {}) as Record<string, any>;
      let itemIdx = 0;
      for (const item of items) {
        const sinceLastCheck = Date.now() - lastCancelCheck;
        const dueByCount = itemIdx % CANCEL_POLL_EVERY === 0;
        const dueByTime = sinceLastCheck >= CANCEL_POLL_MAX_MS;
        if (itemIdx === 0 || dueByCount || dueByTime) {
          const liveStatus = await this.prisma.bulkActionJob.findUnique({
            where: { id: jobId },
            select: { status: true },
          });
          lastCancelCheck = Date.now();
          if (
            liveStatus?.status === 'CANCELLING' ||
            liveStatus?.status === 'CANCELLED'
          ) {
            logger.info(`Job cancellation observed — exiting per-item loop`, {
              jobId,
              processedSoFar: processedItems,
              failedSoFar: failedItems,
              skippedSoFar: skippedItems,
            });
            cancelled = true;
            break;
          }
        }
        itemIdx++;
        const beforeState = this.extractItemState(
          item,
          actionType,
          jobPayload,
        );
        const itemRow = await this.prisma.bulkActionItem.create({
          data: {
            jobId,
            ...this.targetColumnsFor(item.id, actionType),
            status: 'PENDING',
            beforeState,
          },
        });

        // W10.2 — wall-clock per-item timer. Stamped on the
        // BulkActionItem row regardless of success/failure so
        // service-level p50/p95 reporting can pull durations
        // directly without extra joins.
        const itemStartedAt = Date.now();
        // W13.3 — rate-limit-aware retry. The handler can throw a
        // RateLimitError (or a string-shaped 429) and the item
        // loop pauses + retries the SAME item rather than marking
        // it FAILED. Up to MAX_RATE_LIMIT_RETRIES attempts; after
        // that the row goes FAILED and the loop moves on so one
        // wedged channel never wedges the whole job.
        const MAX_RATE_LIMIT_RETRIES = 4;
        let rlAttempt = 0;
        let succeeded = false;
        while (!succeeded && rlAttempt <= MAX_RATE_LIMIT_RETRIES) {
          try {
            const result = await this.processItem(item, job);
            const afterState = await this.refetchAfterState(
              item.id,
              actionType,
              jobPayload,
            );

            await this.prisma.bulkActionItem.update({
              where: { id: itemRow.id },
              data: {
                status:
                  result.status === 'processed' ? 'SUCCEEDED' : 'SKIPPED',
                // A skipped row says why when its handler gave the reason
                // (PRICING_UPDATE); the item's message field, as the
                // rollback's own skipped rows use it.
                ...(result.status === 'skipped' && result.reason
                  ? { errorMessage: result.reason }
                  : {}),
                afterState,
                completedAt: new Date(),
                durationMs: Date.now() - itemStartedAt,
              },
            });

            if (result.status === 'processed') {
              processedItems++;
            } else if (result.status === 'skipped') {
              skippedItems++;
            }
            succeeded = true;
          } catch (itemError) {
            const { isRateLimitError, extractRetryAfterMs, defaultRateLimitBackoffMs } =
              await import('./channel-batch/rate-limit.js');
            const isRl = isRateLimitError(itemError);
            if (isRl && rlAttempt < MAX_RATE_LIMIT_RETRIES) {
              rlAttempt++;
              const backoffMs =
                extractRetryAfterMs(itemError) ??
                defaultRateLimitBackoffMs(rlAttempt);
              logger.warn(`Rate limit hit — pausing item retry`, {
                jobId,
                itemId: item.id,
                attempt: rlAttempt,
                backoffMs,
              });
              await new Promise((r) => setTimeout(r, backoffMs));
              continue;
            }
            failedItems++;
            const errorMessage =
              itemError instanceof Error ? itemError.message : String(itemError);
            errors.push({
              itemId: item.id,
              error: errorMessage,
              timestamp: new Date(),
            });

            await this.prisma.bulkActionItem.update({
              where: { id: itemRow.id },
              data: {
                status: 'FAILED',
                errorMessage,
                completedAt: new Date(),
                durationMs: Date.now() - itemStartedAt,
              },
            });

            logger.warn(`Failed to process item`, {
              jobId,
              itemId: item.id,
              error: errorMessage,
              rateLimitAttempts: rlAttempt,
            });
            break;
          }
        }

        // Update progress every 10 items
        if ((processedItems + failedItems + skippedItems) % 10 === 0) {
          await this.updateProgress(jobId, {
            processedItems,
            failedItems,
            skippedItems,
            errors: errors.length > 0 ? errors : undefined
          });
        }
      }

      this.overrideRuns.delete(jobId);
      // Final progress update
      await this.updateProgress(jobId, {
        processedItems,
        failedItems,
        skippedItems,
        errors: errors.length > 0 ? errors : undefined
      });

      // Determine final status. W1.1 — if the loop exited because the
      // operator cancelled mid-flight, finalize as CANCELLED. Partial
      // results stay on BulkActionItem for audit + downstream reporting.
      let finalStatus: BulkActionStatus;
      if (cancelled) {
        finalStatus = 'CANCELLED';
      } else if (failedItems === 0) {
        finalStatus = 'COMPLETED';
      } else if (processedItems > 0 || skippedItems > 0) {
        finalStatus = 'PARTIALLY_COMPLETED';
      } else {
        finalStatus = 'FAILED';
      }

      // Update job with final status
      const completedJob = await this.prisma.bulkActionJob.update({
        where: { id: jobId },
        data: {
          status: finalStatus,
          completedAt: new Date(),
          updatedAt: new Date()
        }
      });

      // P-RT.9 — fan completion out to the SSE listing-events bus
      // so /products workspaces clear their progress UI + show a
      // success/failure summary. use-listing-events.ts already maps
      // bulk.completed → invalidation 'bulk-job.completed', which the
      // workspace's invalidationTypes already names.
      try {
        publishListingEvent({
          type: 'bulk.completed',
          jobId,
          status: finalStatus,
          ts: Date.now(),
        })
      } catch {
        // see updateProgress comment
      }

      logger.info(`Job processing completed`, {
        jobId,
        status: finalStatus,
        processedItems,
        failedItems,
        skippedItems,
        totalItems: job.totalItems
      });

      // W7.2 — emit the automation trigger. Lazy-imported to avoid
      // a circular dep with the automation engine + to keep this
      // service usable in tests that don't boot the automation
      // module. Best-effort: a failing emit must never affect the
      // job's terminal state.
      try {
        const { emitBulkJobCompleted } = await import(
          './automation/bulk-ops-triggers.js'
        );
        emitBulkJobCompleted({
          jobId,
          jobName: completedJob.jobName,
          actionType: completedJob.actionType,
          channel: completedJob.channel,
          status: completedJob.status,
          totalItems: completedJob.totalItems,
          processedItems: completedJob.processedItems,
          failedItems: completedJob.failedItems,
          skippedItems: completedJob.skippedItems,
          progressPercent: completedJob.progressPercent,
          startedAt: completedJob.startedAt,
          completedAt: completedJob.completedAt,
          createdBy: completedJob.createdBy,
        });
      } catch (emitErr) {
        logger.warn(
          `[bulk-action] emitBulkJobCompleted failed for ${jobId}: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`,
        );
      }

      return {
        jobId,
        status: finalStatus,
        processedItems,
        failedItems,
        skippedItems,
        totalItems: job.totalItems,
        errors
      };
    } catch (error) {
      this.overrideRuns.delete(jobId);
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error(`Job processing failed with error`, {
        jobId,
        error: errorMessage
      });

      // Update job status to FAILED with error context
      if (job) {
        try {
          await this.prisma.bulkActionJob.update({
            where: { id: jobId },
            data: {
              status: 'FAILED',
              lastError: errorMessage,
              completedAt: new Date(),
              updatedAt: new Date(),
              errorLog: [
                {
                  itemId: 'JOB_LEVEL',
                  error: errorMessage,
                  timestamp: new Date()
                }
              ]
            }
          });
        } catch (updateError) {
          logger.error('Failed to update job status to FAILED', {
            jobId,
            error: updateError instanceof Error ? updateError.message : String(updateError)
          });
        }
      }

      throw error;
    }
  }

  /**
   * Get job status and details
   */
  async getJobStatus(jobId: string): Promise<BulkActionJob | null> {
    try {
      return await this.prisma.bulkActionJob.findUnique({
        where: { id: jobId }
      });
    } catch (error) {
      logger.error('Failed to get job status', {
        jobId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get all pending jobs
   */
  async getPendingJobs(): Promise<BulkActionJob[]> {
    try {
      return await this.prisma.bulkActionJob.findMany({
        where: {
          status: { in: ['PENDING', 'QUEUED'] }
        },
        orderBy: { createdAt: 'asc' }
      });
    } catch (error) {
      logger.error('Failed to get pending jobs', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Roll back a previously-COMPLETED or PARTIALLY_COMPLETED bulk job.
   * Each SUCCEEDED BulkActionItem has a beforeState snapshot captured
   * in Commit 2 (da0ac52); rollback walks those items and re-applies
   * the captured before values, creating a new BulkActionJob row +
   * per-item BulkActionItems for audit.
   *
   * Supported actionTypes:
   *   PRICING_UPDATE   → MasterPriceService.update(productId, beforeBasePrice)
   *   INVENTORY_UPDATE → applyStockMovement(change = beforeStock - currentStock)
   *   STATUS_UPDATE    → product.update(status = beforeStatus)
   *
   * Deferred (returns 409 with "not supported"):
   *   ATTRIBUTE_UPDATE, MARKETPLACE_OVERRIDE_UPDATE, LISTING_SYNC
   *
   * Guards:
   *   - Original must be COMPLETED or PARTIALLY_COMPLETED
   *   - Original.isRollbackable must be true
   *   - Original.rollbackJobId must be null (no double-rollback)
   *   - Rollback job is NOT itself rollbackable
   */
  async rollbackBulkActionJob(originalJobId: string, actor: string | null = null): Promise<{
    rollbackJobId: string
    succeeded: number
    failed: number
    skipped: number
  }> {
    const original = await this.prisma.bulkActionJob.findUnique({
      where: { id: originalJobId },
    });
    if (!original) {
      throw new Error(`Job not found: ${originalJobId}`);
    }
    if (
      original.status !== 'COMPLETED' &&
      original.status !== 'PARTIALLY_COMPLETED'
    ) {
      throw new Error(
        `Cannot rollback job with status ${original.status} (must be COMPLETED or PARTIALLY_COMPLETED)`,
      );
    }
    if (original.rollbackJobId) {
      throw new Error('Job has already been rolled back');
    }
    if (!original.isRollbackable) {
      throw new Error('Job is marked non-rollbackable');
    }

    // C.9 — ATTRIBUTE_UPDATE added to the supported set. Rollback
    // path reverses by writing beforeState.value back to the same
    // attributeName + re-running channel propagation through the
    // OutboundSyncQueue. LISTING_SYNC stays unsupported (no Product
    // mutation = nothing to invert; the queued syncs already pushed).
    const SUPPORTED = new Set([
      'PRICING_UPDATE',
      'INVENTORY_UPDATE',
      'STATUS_UPDATE',
      'ATTRIBUTE_UPDATE',
    ])
    if (!SUPPORTED.has(original.actionType)) {
      throw new Error(
        `Rollback not supported for actionType=${original.actionType} (PRICING_UPDATE / INVENTORY_UPDATE / STATUS_UPDATE / ATTRIBUTE_UPDATE only)`,
      );
    }

    const succeededItems = await this.prisma.bulkActionItem.findMany({
      where: { jobId: originalJobId, status: 'SUCCEEDED' },
    });
    if (succeededItems.length === 0) {
      throw new Error(
        'No SUCCEEDED items to roll back (original job had no successful applies)',
      );
    }

    const targetProductIds = Array.from(
      new Set(
        succeededItems
          .map((it) => it.productId)
          .filter((p): p is string => !!p),
      ),
    );

    // Create the rollback job up front so per-item BulkActionItem rows
    // can attach to it. Status starts IN_PROGRESS; we update at the end.
    const rollbackJob = await this.prisma.bulkActionJob.create({
      data: {
        jobName: `${original.jobName} (rollback)`,
        actionType: original.actionType,
        channel: original.channel,
        targetProductIds,
        targetVariationIds: [],
        actionPayload: {
          __rollback: true,
          originalJobId,
          originalJobName: original.jobName,
        } as any,
        status: 'IN_PROGRESS',
        totalItems: succeededItems.length,
        startedAt: new Date(),
        // The person who asked for the rollback (bulk-action-actor.ts); the system name only when none is known.
        createdBy: actor ?? 'bulk-action-rollback',
        // Rollback rows themselves are not rollbackable.
        isRollbackable: false,
      },
    });

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    const errors: Array<{ itemId: string; error: string; timestamp: Date }> = [];

    for (const item of succeededItems) {
      const before = (item.beforeState ?? null) as Record<string, any> | null;
      if (!item.productId) {
        // Polymorphic target wasn't a product — shouldn't happen for
        // PRICING/INVENTORY/STATUS but be defensive.
        await this.prisma.bulkActionItem.create({
          data: {
            jobId: rollbackJob.id,
            productId: null,
            variationId: item.variationId,
            channelListingId: item.channelListingId,
            status: 'SKIPPED',
            errorMessage: 'No productId on original item',
            completedAt: new Date(),
          },
        });
        skipped++;
        continue;
      }
      if (!before) {
        await this.prisma.bulkActionItem.create({
          data: {
            jobId: rollbackJob.id,
            productId: item.productId,
            status: 'SKIPPED',
            errorMessage: 'No beforeState captured (pre-Commit-2 row)',
            completedAt: new Date(),
          },
        });
        skipped++;
        continue;
      }

      try {
        // Capture rollback's own beforeState (= original's afterState)
        // and its afterState (= original's beforeState) for symmetry.
        const rollbackBeforeState = item.afterState ?? null;
        const rollbackAfterState = item.beforeState ?? null;

        switch (original.actionType) {
          case 'PRICING_UPDATE': {
            const target = Number(before.basePrice);
            if (!Number.isFinite(target) || target < 0) {
              throw new Error(
                `beforeState.basePrice is not a valid number (got ${before.basePrice})`,
              );
            }
            await this.masterPriceService.update(item.productId, target, {
              actor: 'bulk-action-rollback',
              reason: `rollback of job ${originalJobId}`,
              idempotencyKey: `rollback:${rollbackJob.id}:${item.productId}`,
            });
            break;
          }
          case 'INVENTORY_UPDATE': {
            const target = Number(before.totalStock);
            if (!Number.isFinite(target) || target < 0) {
              throw new Error(
                `beforeState.totalStock is not a valid number (got ${before.totalStock})`,
              );
            }
            const product = await this.prisma.product.findUnique({
              where: { id: item.productId },
              select: { totalStock: true },
            });
            if (!product) throw new Error('Product no longer exists');
            const change = target - (product.totalStock ?? 0);
            if (change !== 0) {
              await applyStockMovement({
                productId: item.productId,
                change,
                reason: 'MANUAL_ADJUSTMENT',
                referenceType: 'BulkActionJobRollback',
                referenceId: rollbackJob.id,
                actor: 'bulk-action-rollback',
                notes: `Rollback of bulk job ${originalJobId}`,
              });
            }
            break;
          }
          case 'STATUS_UPDATE': {
            const target = before.status;
            const VALID = ['DRAFT', 'ACTIVE', 'INACTIVE'] as const;
            if (
              typeof target !== 'string' ||
              !(VALID as readonly string[]).includes(target)
            ) {
              throw new Error(
                `beforeState.status invalid (got ${target})`,
              );
            }
            // TECH_DEBT #53: rollback also needs to fan out to
            // ChannelListing + queue a marketplace push, not just
            // flip Product.status. Same rationale as forward path.
            await this.masterStatusService.update(
              item.productId,
              target as 'DRAFT' | 'ACTIVE' | 'INACTIVE',
              {
                actor: 'bulk-action-rollback',
                reason: `Rollback of bulk job ${originalJobId}`,
              },
            );
            break;
          }
          case 'ATTRIBUTE_UPDATE': {
            // C.9 — replay processAttributeUpdate with the captured
            // beforeState as the new value. Re-runs the same
            // OutboundSyncQueue fanout so live channels learn about
            // the reversal. attributeName comes from beforeState
            // (extractItemState writes it under that key).
            const attributeName =
              typeof before.attributeName === 'string'
                ? before.attributeName
                : null
            if (!attributeName) {
              throw new Error(
                'beforeState.attributeName missing — cannot rollback ATTRIBUTE_UPDATE without it',
              )
            }
            // Read current Product so processAttributeUpdate can
            // compute its idempotent skip. Single indexed read.
            const product = await this.prisma.product.findUnique({
              where: { id: item.productId! },
            })
            if (!product) throw new Error('Product no longer exists')
            await this.processAttributeUpdate(
              product as Product,
              { attributeName, value: before.value },
              rollbackJob.id,
            )
            break
          }
          default:
            // Already gated above; defensive.
            throw new Error(
              `Unexpected actionType in rollback: ${original.actionType}`,
            );
        }

        await this.prisma.bulkActionItem.create({
          data: {
            jobId: rollbackJob.id,
            productId: item.productId,
            status: 'SUCCEEDED',
            beforeState: rollbackBeforeState as any,
            afterState: rollbackAfterState as any,
            completedAt: new Date(),
          },
        });
        succeeded++;
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : String(err);
        await this.prisma.bulkActionItem.create({
          data: {
            jobId: rollbackJob.id,
            productId: item.productId,
            status: 'FAILED',
            errorMessage,
            completedAt: new Date(),
          },
        });
        errors.push({
          itemId: item.id,
          error: errorMessage,
          timestamp: new Date(),
        });
        failed++;
        logger.warn('Rollback failed for item', {
          rollbackJobId: rollbackJob.id,
          originalItemId: item.id,
          productId: item.productId,
          error: errorMessage,
        });
      }
    }

    // Final status on the rollback job.
    let finalStatus: BulkActionStatus;
    if (failed === 0) {
      finalStatus = succeeded > 0 ? 'COMPLETED' : 'FAILED';
    } else if (succeeded > 0) {
      finalStatus = 'PARTIALLY_COMPLETED';
    } else {
      finalStatus = 'FAILED';
    }

    await this.prisma.bulkActionJob.update({
      where: { id: rollbackJob.id },
      data: {
        status: finalStatus,
        processedItems: succeeded,
        failedItems: failed,
        skippedItems: skipped,
        progressPercent: 100,
        completedAt: new Date(),
        errorLog: errors.length > 0 ? (errors as any) : undefined,
        lastError: errors.length > 0 ? errors[errors.length - 1].error : null,
      },
    });

    // Link the original to its rollback so the UI can render
    // "rolled back via rollback-job-X".
    await this.prisma.bulkActionJob.update({
      where: { id: originalJobId },
      data: { rollbackJobId: rollbackJob.id },
    });

    return {
      rollbackJobId: rollbackJob.id,
      succeeded,
      failed,
      skipped,
    };
  }

  /**
   * Create a new BulkActionJob targeting the FAILED items of an
   * existing job. Same actionType + actionPayload + channel; scope
   * narrowed to the failed items' polymorphic targets.
   *
   * The retry is a fresh job (separate id, separate item rows) so
   * the original audit trail stays intact. Useful when failures
   * were transient (DB hiccup, marketplace rate limit, etc.) — the
   * user fixes the cause and re-runs only the items that failed.
   */
  async retryFailedItems(jobId: string, actor: string | null = null): Promise<BulkActionJob> {
    const original = await this.prisma.bulkActionJob.findUnique({
      where: { id: jobId },
    });
    if (!original) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const failed = await this.prisma.bulkActionItem.findMany({
      where: { jobId, status: 'FAILED' },
      select: {
        productId: true,
        variationId: true,
        channelListingId: true,
      },
    });
    if (failed.length === 0) {
      throw new Error(
        `No failed items to retry for job ${jobId}`,
      );
    }

    // Extract polymorphic target IDs based on the original action's
    // target entity. ACTION_ENTITY tells us which column was set.
    const target =
      ACTION_ENTITY[original.actionType as BulkActionType];
    let targetProductIds: string[] = [];
    let targetVariationIds: string[] = [];
    // C.9 — 'variation' branch removed; ProductVariation is empty in
    // production and no live action types target it. targetVariationIds
    // stays in the response shape (kept empty) for back-compat with
    // any caller that reads it.
    if (target === 'product') {
      targetProductIds = Array.from(
        new Set(failed.map((f) => f.productId).filter(Boolean) as string[]),
      );
    } else if (target === 'channelListing') {
      // ChannelListing-targeted: re-scope by the parent productIds so
      // the new job's getItemsForJob can re-resolve the listings.
      const listingIds = Array.from(
        new Set(
          failed
            .map((f) => f.channelListingId)
            .filter(Boolean) as string[],
        ),
      );
      const listings = await this.prisma.channelListing.findMany({
        where: { id: { in: listingIds } },
        select: { productId: true },
      });
      targetProductIds = Array.from(
        new Set(listings.map((l) => l.productId)),
      );
    }

    if (
      targetProductIds.length === 0 &&
      targetVariationIds.length === 0
    ) {
      throw new Error(
        `Cannot retry: failed items had no resolvable target IDs (entities may have been deleted)`,
      );
    }

    return await this.createJob({
      jobName: `${original.jobName} (retry)`,
      actionType: original.actionType as BulkActionType,
      channel: original.channel ?? undefined,
      targetProductIds,
      targetVariationIds,
      // A channel-listing retry keeps the original's market scope: re-scoped by product id alone, a retry of
      // one failed Amazon DE row would run on every Amazon market of that product.
      ...(target === 'channelListing' && original.filters
        ? { filters: original.filters as Record<string, any> }
        : {}),
      actionPayload: original.actionPayload as Record<string, any>,
      // The retry acts for the person who asked for it (bulk-action-actor.ts), never the original's stored name.
      createdBy: actor ?? undefined,
    });
  }

  /** The history's jobs with the name of who ran each (`createdByName`: a person's display name or a system label). */
  async withActorNames<T extends Pick<BulkActionJob, 'createdBy'>>(jobs: T[]): Promise<Array<T & { createdByName: string | null }>> {
    const names = await bulkActorNames(this.prisma, jobs.map((j) => j.createdBy));
    return jobs.map((j) => ({ ...j, createdByName: (j.createdBy && names.get(j.createdBy)) || null }));
  }

  /**
   * Job History: paginated list of jobs ordered by createdAt DESC.
   * Powers the /bulk-operations/history page.
   */
  async listJobs(filters: {
    limit?: number;
    status?: string;
    actionType?: string;
    since?: Date;
  } = {}): Promise<BulkActionJob[]> {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
    const where: Prisma.BulkActionJobWhereInput = {};
    if (filters.status) {
      // Convenience aliases: 'active' = pre-terminal; 'terminal' = post.
      // W1.1 — CANCELLING is a transient pre-terminal state set when an
      // operator cancels an IN_PROGRESS job; the worker observes the
      // flag between items and finalizes as CANCELLED. Include it in
      // 'active' so the strip keeps the spinner up while the cancel
      // flushes through the loop.
      if (filters.status === 'active') {
        where.status = {
          in: ['PENDING', 'QUEUED', 'IN_PROGRESS', 'CANCELLING'],
        };
      } else if (filters.status === 'terminal') {
        where.status = {
          in: [
            'COMPLETED',
            'PARTIALLY_COMPLETED',
            'FAILED',
            'CANCELLED',
          ],
        };
      } else {
        where.status = filters.status;
      }
    }
    if (filters.actionType) {
      where.actionType = filters.actionType;
    }
    if (filters.since) {
      where.createdAt = { gte: filters.since };
    }
    return await this.prisma.bulkActionJob.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Per-job drill-down: returns BulkActionItem rows for a job, joined
   * with the human-readable SKU / channel info for each polymorphic
   * target. Powers the per-job items modal on the history page.
   */
  async listItems(
    jobId: string,
    filters: { status?: string; limit?: number } = {},
  ): Promise<
    Array<{
      id: string;
      jobId: string;
      productId: string | null;
      variationId: string | null;
      channelListingId: string | null;
      status: string;
      errorMessage: string | null;
      beforeState: any;
      afterState: any;
      createdAt: Date;
      completedAt: Date | null;
      // W10.2 — wall-clock per-handler time. Populated by the
      // bulk-action processor; null on rows from earlier waves.
      durationMs: number | null;
      // Human-readable target info (joined client-side for the audit
      // history pattern — no FK exists on the polymorphic columns).
      sku: string | null;
      channelLabel: string | null;
    }>
  > {
    const limit = Math.min(Math.max(filters.limit ?? 200, 1), 1000);
    const where: Prisma.BulkActionItemWhereInput = { jobId };
    if (filters.status) where.status = filters.status;

    const rows = await this.prisma.bulkActionItem.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    // Bulk-resolve SKUs / channel labels in parallel. No FK on the
    // polymorphic columns means we accept null when the entity has
    // since been deleted (audit-history-preserving behavior).
    const productIds = Array.from(
      new Set(rows.map((r) => r.productId).filter(Boolean) as string[]),
    );
    const variationIds = Array.from(
      new Set(rows.map((r) => r.variationId).filter(Boolean) as string[]),
    );
    const channelListingIds = Array.from(
      new Set(
        rows.map((r) => r.channelListingId).filter(Boolean) as string[],
      ),
    );

    const [products, variations, channelListings] = await Promise.all([
      productIds.length > 0
        ? this.prisma.product.findMany({
            where: { id: { in: productIds } },
            select: { id: true, sku: true },
          })
        : Promise.resolve([]),
      variationIds.length > 0
        ? this.prisma.productVariation.findMany({
            where: { id: { in: variationIds } },
            select: { id: true, sku: true },
          })
        : Promise.resolve([]),
      channelListingIds.length > 0
        ? this.prisma.channelListing.findMany({
            where: { id: { in: channelListingIds } },
            select: {
              id: true,
              channel: true,
              marketplace: true,
              productId: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const productSkuById = new Map(products.map((p) => [p.id, p.sku]));
    const variationSkuById = new Map(variations.map((v) => [v.id, v.sku]));
    const channelById = new Map(
      channelListings.map((cl) => [
        cl.id,
        {
          label: `${cl.channel}${cl.marketplace ? ` · ${cl.marketplace}` : ''}`,
          productId: cl.productId,
        },
      ]),
    );
    // Listings → SKUs require one more lookup
    const listingProductIds = Array.from(
      new Set(channelListings.map((cl) => cl.productId)),
    );
    const listingProducts = listingProductIds.length > 0
      ? await this.prisma.product.findMany({
          where: { id: { in: listingProductIds } },
          select: { id: true, sku: true },
        })
      : [];
    const listingProductSkuById = new Map(
      listingProducts.map((p) => [p.id, p.sku]),
    );

    return rows.map((r) => {
      let sku: string | null = null;
      let channelLabel: string | null = null;
      if (r.productId) sku = productSkuById.get(r.productId) ?? null;
      else if (r.variationId)
        sku = variationSkuById.get(r.variationId) ?? null;
      else if (r.channelListingId) {
        const cl = channelById.get(r.channelListingId);
        if (cl) {
          channelLabel = cl.label;
          sku = listingProductSkuById.get(cl.productId) ?? null;
        }
      }
      return {
        id: r.id,
        jobId: r.jobId,
        productId: r.productId,
        variationId: r.variationId,
        channelListingId: r.channelListingId,
        status: r.status,
        errorMessage: r.errorMessage,
        beforeState: r.beforeState,
        afterState: r.afterState,
        createdAt: r.createdAt,
        completedAt: r.completedAt,
        durationMs: r.durationMs ?? null,
        sku,
        channelLabel,
      };
    });
  }

  /**
   * Create a rollback job for a failed or completed job
   */
  async createRollbackJob(originalJobId: string): Promise<BulkActionJob> {
    try {
      const originalJob = await this.prisma.bulkActionJob.findUnique({
        where: { id: originalJobId }
      });

      if (!originalJob) {
        throw new Error(`Original job not found: ${originalJobId}`);
      }

      if (!originalJob.isRollbackable) {
        throw new Error(`Job is not rollbackable: ${originalJobId}`);
      }

      if (!originalJob.rollbackData) {
        throw new Error(`No rollback data available for job: ${originalJobId}`);
      }

      logger.info(`Creating rollback job`, {
        originalJobId,
        actionType: originalJob.actionType
      });

      const rollbackJob = await this.prisma.bulkActionJob.create({
        data: {
          jobName: `Rollback: ${originalJob.jobName}`,
          actionType: originalJob.actionType,
          channel: originalJob.channel,
          targetProductIds: originalJob.targetProductIds,
          targetVariationIds: originalJob.targetVariationIds,
          filters: originalJob.filters,
          actionPayload: originalJob.rollbackData,
          status: 'PENDING',
          totalItems: originalJob.totalItems,
          createdBy: originalJob.createdBy,
          isRollbackable: false
        }
      });

      // Link rollback job to original
      await this.prisma.bulkActionJob.update({
        where: { id: originalJobId },
        data: { rollbackJobId: rollbackJob.id }
      });

      logger.info(`Rollback job created successfully`, {
        rollbackJobId: rollbackJob.id,
        originalJobId
      });

      return rollbackJob;
    } catch (error) {
      logger.error('Failed to create rollback job', {
        originalJobId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Cancel a job. Supported transitions:
   *   PENDING / QUEUED  → CANCELLED   (terminal, immediate)
   *   IN_PROGRESS       → CANCELLING  (cooperative — the per-item loop
   *                                    in `processJob` re-reads status
   *                                    every progress flush and exits
   *                                    cleanly, finalising the job as
   *                                    CANCELLED with whatever partial
   *                                    results have already been
   *                                    written to BulkActionItem)
   *   anything else     → error
   *
   * W1.1 (2026-05-09) — operator could not cancel a hung IN_PROGRESS
   * job; only PENDING / QUEUED were cancellable. The cooperative
   * CANCELLING transition lets the worker checkpoint mid-loop without
   * losing the partial audit trail.
   */
  async cancelJob(jobId: string): Promise<BulkActionJob> {
    try {
      const job = await this.prisma.bulkActionJob.findUnique({
        where: { id: jobId }
      });

      if (!job) {
        throw new Error(`Job not found: ${jobId}`);
      }

      const cancellableNow = job.status === 'PENDING' || job.status === 'QUEUED';
      const cancellableInFlight = job.status === 'IN_PROGRESS';

      if (!cancellableNow && !cancellableInFlight) {
        throw new Error(`Cannot cancel job with status: ${job.status}`);
      }

      if (cancellableNow) {
        logger.info(`Cancelling job (terminal)`, { jobId, fromStatus: job.status });
        return await this.prisma.bulkActionJob.update({
          where: { id: jobId },
          data: {
            status: 'CANCELLED',
            completedAt: new Date(),
            updatedAt: new Date()
          }
        });
      }

      // IN_PROGRESS — flag CANCELLING; processJob loop will finalize.
      logger.info(`Cancelling job (cooperative)`, { jobId, fromStatus: job.status });
      return await this.prisma.bulkActionJob.update({
        where: { id: jobId },
        data: {
          status: 'CANCELLING',
          updatedAt: new Date(),
        },
      });
    } catch (error) {
      logger.error('Failed to cancel job', {
        jobId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Preview a job without writing. Returns the affected count plus
   * a sample of N items showing current → new values per the action
   * payload. Used by the frontend scope picker so the user can
   * review changes before clicking Execute.
   *
   * Same input shape as createJob — same Zod validation should run
   * at the route layer before reaching this method.
   */
  async previewJob(
    input: CreateJobInput,
    sampleSize = 10,
  ): Promise<{
    affectedCount: number;
    translation?: import('@nexus/shared/products-grid').CatalogTranslatePreview;
    sampleItems: Array<{
      id: string;
      sku: string | null;
      name: string | null;
      currentValue: unknown;
      newValue: unknown;
      status: 'processed' | 'skipped';
      /** Why a skipped row is skipped, in the job item's own words (PRICING_UPDATE). */
      reason?: string;
    }>;
  }> {
    if (input.actionType === 'AI_TRANSLATE_PRODUCT') {
      const payload = input.actionPayload as any
      if (!payload?.scope) throw new Error('Use Translate from the catalogue or readiness page to preview the current filter.')
      const preview = await previewCatalogTranslation({ scope: payload.scope, language: payload.language ?? payload.targetLanguages?.[0], fields: payload.fields ?? ['title'] }, input.createdBy ?? null)
      return { affectedCount: preview.total, sampleItems: [], translation: preview }
    }
    const target = ACTION_ENTITY[input.actionType];

    // ── Affected count (no DB write, no item load) ────────────────
    let affectedCount = 0;
    if (target === 'channelListing') {
      // E.5a — direct count of ChannelListing rows in scope.
      if (input.targetProductIds?.length) {
        affectedCount = await this.prisma.channelListing.count({
          where: this.buildChannelListingWhere(
            { channel: input.channel ?? null } as BulkActionJob,
            { productIds: input.targetProductIds, filters: input.filters as ScopeFilters | undefined },
          ),
        });
      } else if (input.targetVariationIds?.length) {
        const variations = await this.prisma.productVariation.findMany({
          where: { id: { in: input.targetVariationIds } },
          select: { productId: true },
        });
        const productIds = Array.from(
          new Set(variations.map((v) => v.productId)),
        );
        affectedCount = await this.prisma.channelListing.count({
          where: this.buildChannelListingWhere(
            { channel: input.channel ?? null } as BulkActionJob,
            { productIds, filters: input.filters as ScopeFilters | undefined },
          ),
        });
      } else if (input.filters) {
        affectedCount = await this.countItemsByFilters(
          input.filters as ScopeFilters,
          target,
          input.channel,
        );
      }
    } else if (target === 'product') {
      if (input.targetProductIds?.length) {
        affectedCount = input.targetProductIds.length;
      } else if (input.targetVariationIds?.length) {
        // Distinct parent products — match the resolution
        // getItemsForJob does for the same case.
        const variations = await this.prisma.productVariation.findMany({
          where: { id: { in: input.targetVariationIds } },
          select: { productId: true },
        });
        affectedCount = new Set(variations.map((v) => v.productId)).size;
      } else if (input.filters) {
        affectedCount = await this.countItemsByFilters(
          input.filters as ScopeFilters,
          target,
        );
      }
    } else {
      // variation
      if (input.targetVariationIds?.length) {
        affectedCount = input.targetVariationIds.length;
      } else if (input.targetProductIds?.length) {
        // All variations of these products
        affectedCount = await this.prisma.productVariation.count({
          where: { productId: { in: input.targetProductIds } },
        });
      } else if (input.filters) {
        affectedCount = await this.countItemsByFilters(
          input.filters as ScopeFilters,
          target,
        );
      }
    }

    // ── Sample items via getItemsForJob with a take cap ───────────
    // Build a synthetic job-shaped object so we can reuse the
    // existing entity-resolution logic without persisting anything.
    const synthetic = {
      id: 'preview',
      actionType: input.actionType,
      // The job's channel scope: without it a channel-listing preview sampled every channel's listings.
      channel: input.channel ?? null,
      targetProductIds: input.targetProductIds ?? [],
      targetVariationIds: input.targetVariationIds ?? [],
      filters: input.filters ?? null,
    } as unknown as BulkActionJob;
    const samples = await this.getItemsForJob(synthetic, {
      limit: sampleSize,
    });

    const payload = (input.actionPayload ?? {}) as Record<string, any>;
    const sampleItems = samples.map((item) => {
      const computed = this.computePreview(item, input.actionType, payload);
      return {
        id: item.id,
        sku: 'sku' in item ? item.sku : null,
        name: 'name' in item ? item.name : null,
        currentValue: computed.currentValue,
        newValue: computed.newValue,
        status: computed.status,
        ...(computed.reason ? { reason: computed.reason } : {}),
      };
    });

    return { affectedCount, sampleItems };
  }

  /**
   * Pure compute: given an item + action + payload, return what the
   * handler WOULD write, without writing. Mirrors the math in each
   * processX handler. If the handlers' math drifts from this, the
   * preview lies — keep them in sync (B-3 + B-6 are the canonical
   * pair).
   */
  private computePreview(
    item: Product | ProductVariation,
    actionType: BulkActionType,
    payload: Record<string, any>,
  ): { currentValue: unknown; newValue: unknown; status: 'processed' | 'skipped'; reason?: string } {
    switch (actionType) {
      case 'PRICING_UPDATE': {
        // The run's own rule on the run's own row (`bulk-action/pricing-update.ts`): a PRICING_UPDATE item is a whole
        // Product row (`getItemsForJob`) — `basePrice` and its own floor / ceiling (`minPrice` / `maxPrice`). Reading
        // `variation.price` here showed "NaN" before.
        const product = item as Product;
        const outcome = pricingUpdateOutcome(product, payload);
        return {
          currentValue: currentBasePrice(product).toFixed(2),
          newValue: outcome.newPrice.toFixed(2),
          status: outcome.status,
          // The same sentence the run stores on the skipped item.
          ...(outcome.status === 'skipped' ? { reason: outcome.reason } : {}),
        };
      }

      case 'INVENTORY_UPDATE': {
        const variation = item as ProductVariation;
        const currentStock = variation.stock ?? 0;
        const adjustmentType = payload.adjustmentType;
        const value = Number(payload.value);
        if (Number.isNaN(value)) {
          throw new Error(
            'Invalid INVENTORY_UPDATE payload: numeric value required',
          );
        }
        let newStock: number;
        switch (adjustmentType) {
          case 'ABSOLUTE':
            newStock = value;
            break;
          case 'DELTA':
            newStock = currentStock + value;
            break;
          default:
            throw new Error(
              `Invalid INVENTORY_UPDATE adjustmentType: ${adjustmentType}`,
            );
        }
        newStock = Math.max(0, Math.floor(newStock));
        return {
          currentValue: currentStock,
          newValue: newStock,
          status: 'processed',
        };
      }

      case 'STATUS_UPDATE': {
        // ACTION_ENTITY.STATUS_UPDATE = 'product' so getItemsForJob
        // returns Product. Variation-shaped items shouldn't reach
        // this branch in practice; the type-guard handles the edge
        // case anyway.
        const currentStatus =
          'status' in item && typeof item.status === 'string'
            ? item.status
            : null;
        return {
          currentValue: currentStatus,
          newValue: payload.status,
          status: 'processed',
        };
      }

      case 'ATTRIBUTE_UPDATE': {
        // C.9 — Product-targeting with strict allowlist. The
        // attributeName is either a scalar Product column (one of
        // ATTRIBUTE_SCALAR_ALLOWLIST) or a one-level dot-path into
        // categoryAttributes (e.g., 'categoryAttributes.material').
        // Unknown keys are rejected at the apply step; preview just
        // surfaces what the value would change.
        const product = item as Product;
        const attributeName = String(payload.attributeName ?? '')
        const newValue = payload.value
        const { currentValue, kind } = readProductAttribute(
          product,
          attributeName,
        )
        if (kind === 'unsupported') {
          return {
            currentValue,
            newValue,
            // Surface unsupported as 'skipped' so the operator sees
            // it in the preview without aborting the whole job.
            status: 'skipped',
          }
        }
        // Idempotent skip: if the value already matches, don't fire
        // a no-op update + a redundant queue row.
        const same =
          currentValue === newValue ||
          JSON.stringify(currentValue) === JSON.stringify(newValue)
        return {
          currentValue,
          newValue,
          status: same ? 'skipped' : 'processed',
        }
      }

      case 'MARKETPLACE_OVERRIDE_UPDATE': {
        // The plan the run executes (`marketplaceOverridePlan`). This case was missing, so every preview of this
        // action threw "Unknown action type". Whether a price is a no-op, refused or changed elsewhere is decided
        // by the price door when the job runs, and the job's items say which.
        const listing = item as unknown as ChannelListing;
        const plan = marketplaceOverridePlan(payload);
        const FOLLOWS = 'follows the master price';
        const currentValue: Record<string, unknown> = {};
        const newValue: Record<string, unknown> = {};
        if (plan.price !== undefined) {
          currentValue.price =
            listing.followMasterPrice === false
              ? Number(listing.priceOverride ?? listing.price)
              : FOLLOWS;
          newValue.price = plan.price === null ? FOLLOWS : Math.round(plan.price * 100) / 100;
        }
        // The rule and percent: what the door will be asked for. A following listing's price is recomputed by them
        // (or refused by name) when the job runs, and the job's items say which.
        if (plan.rule?.pricingRule !== undefined) {
          currentValue.pricingRule = listing.pricingRule ?? null;
          newValue.pricingRule = plan.rule.pricingRule;
        }
        if (plan.rule?.priceAdjustmentPercent !== undefined) {
          currentValue.priceAdjustmentPercent = listing.priceAdjustmentPercent == null ? null : Number(listing.priceAdjustmentPercent);
          newValue.priceAdjustmentPercent = plan.rule.priceAdjustmentPercent;
        }
        // Quantity and buffer: what the follow/pin and buffer primitives will be asked for. Whether a row is FBA
        // (refused), an Amazon EU market outside the job's scope (refused) or already so (a no-op) is decided when
        // the job runs, and the job's items say which.
        if (plan.quantity !== undefined) {
          const FOLLOWS_STOCK = 'follows the stock';
          currentValue.quantity = listing.followMasterQuantity === false ? (listing.quantityOverride ?? listing.quantity) : FOLLOWS_STOCK;
          newValue.quantity = plan.quantity.follow
            ? FOLLOWS_STOCK
            : plan.quantity.value ?? 'fixed at the number it shows now';
        }
        if (plan.buffer !== undefined) {
          currentValue.stockBuffer = listing.stockBuffer ?? 0;
          newValue.stockBuffer = plan.buffer;
        }
        for (const [key, value] of Object.entries(plan.columns)) {
          const before = (listing as Record<string, unknown>)[key];
          currentValue[key] = before instanceof Prisma.Decimal ? Number(before) : before ?? null;
          newValue[key] = value;
        }
        return { currentValue, newValue, status: 'processed' };
      }

      case 'LISTING_SYNC': {
        // C.9 — preview returns the count of ChannelListings that
        // would be queued. Channels filter applies if the payload
        // includes channels[]. The count itself isn't fetched here
        // (the service-wide preview is item-level, not row-level);
        // we surface the channel filter in newValue so the operator
        // can sanity-check the scope.
        const channelsFilter = Array.isArray(payload.channels)
          ? (payload.channels as string[]).filter(
              (c) => typeof c === 'string' && c.length > 0,
            )
          : null
        return {
          currentValue: 'product',
          newValue: channelsFilter
            ? `queue (${channelsFilter.join(', ')})`
            : 'queue (all channels)',
          status: 'processed',
        }
      }

      default:
        throw new Error(`Unknown action type: ${actionType}`);
    }
  }

  /**
   * Resolve the items a job will process. Returns Product[] or
   * ProductVariation[] depending on the action's target entity.
   * Targeting precedence:
   *   1. Explicit targetProductIds / targetVariationIds (fast path,
   *      no filter translation needed)
   *   2. ScopeFilters (translated to Prisma where clause)
   *   3. Empty
   *
   * Cross-targeting policy: if a Product-targeted action is given
   * variation ids, walk up to parent products. If a Variation-
   * targeted action is given product ids, expand to all child
   * variations. Keeps the scope-picker UX flexible without forcing
   * the caller to pre-resolve.
   */
  private async getItemsForJob(
    job: BulkActionJob,
    options?: { limit?: number },
  ): Promise<Product[] | ProductVariation[] | ChannelListing[]> {
    try {
      const target = ACTION_ENTITY[job.actionType as BulkActionType];
      const take = options?.limit;

      if (target === 'channelListing') {
        // E.5a — per-marketplace override updates target ChannelListing rows
        // directly. Filters tighten by (channel, marketplace, status); the
        // job.channel + filters.marketplace duo identifies the (channel,
        // marketplace) tuple; targetProductIds expand to "all listings on
        // these products"; targetVariationIds resolve up to parent products
        // first.
        //
        // The filters narrow product-scoped jobs too (buildChannelListingWhere's
        // own contract). They were dropped here, so a job for Amazon DE given
        // product ids — and every retry of failed rows, which re-scopes by
        // product id — ran on every Amazon market of those products. Once the
        // price reaches the channel, that is a DE price sent to IT, FR and UK.
        const filters = (job.filters ?? undefined) as ScopeFilters | undefined;
        if (job.targetProductIds && job.targetProductIds.length > 0) {
          return await this.prisma.channelListing.findMany({
            where: this.buildChannelListingWhere(job, {
              productIds: job.targetProductIds,
              filters,
            }),
            ...(take ? { take } : {}),
          });
        }
        if (job.targetVariationIds && job.targetVariationIds.length > 0) {
          const variations = await this.prisma.productVariation.findMany({
            where: { id: { in: job.targetVariationIds } },
            select: { productId: true },
          });
          const productIds = Array.from(
            new Set(variations.map((v) => v.productId)),
          );
          return await this.prisma.channelListing.findMany({
            where: this.buildChannelListingWhere(job, { productIds, filters }),
            ...(take ? { take } : {}),
          });
        }
        if (job.filters) {
          return await this.prisma.channelListing.findMany({
            where: this.buildChannelListingWhere(job, {
              filters: job.filters as ScopeFilters,
            }),
            ...(take ? { take } : {}),
          });
        }
        return [];
      }

      if (target === 'product') {
        if (job.targetProductIds && job.targetProductIds.length > 0) {
          return await this.prisma.product.findMany({
            where: { id: { in: job.targetProductIds } },
            ...(take ? { take } : {}),
          });
        }
        if (job.targetVariationIds && job.targetVariationIds.length > 0) {
          // Resolve variations → distinct parent product ids
          const variations = await this.prisma.productVariation.findMany({
            where: { id: { in: job.targetVariationIds } },
            select: { productId: true },
          });
          const productIds = Array.from(
            new Set(variations.map((v) => v.productId)),
          );
          return await this.prisma.product.findMany({
            where: { id: { in: productIds } },
            ...(take ? { take } : {}),
          });
        }
        if (job.filters) {
          return await this.prisma.product.findMany({
            where: this.buildProductFilterWhere(
              job.filters as ScopeFilters,
            ),
            ...(take ? { take } : {}),
          });
        }
        return [];
      }

      // target === 'variation'
      if (job.targetVariationIds && job.targetVariationIds.length > 0) {
        return await this.prisma.productVariation.findMany({
          where: { id: { in: job.targetVariationIds } },
          ...(take ? { take } : {}),
        });
      }
      if (job.targetProductIds && job.targetProductIds.length > 0) {
        // Expand parent products → all their variations
        return await this.prisma.productVariation.findMany({
          where: { productId: { in: job.targetProductIds } },
          ...(take ? { take } : {}),
        });
      }
      if (job.filters) {
        return await this.prisma.productVariation.findMany({
          where: this.buildVariationFilterWhere(
            job.filters as ScopeFilters,
          ),
          ...(take ? { take } : {}),
        });
      }
      return [];
    } catch (error) {
      logger.error('Failed to get items for job', {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Private helper: Process a single item based on action type.
   * Casts JsonValue boundaries to Record at the dispatcher so each
   * handler can keep its `Record<string, any>` signature. Phase B-3
   * will replace these casts with per-action-type Zod parses for
   * real validation.
   */
  /**
   * Extract a slim state diff for the given item under the given
   * action type. Used to populate BulkActionItem.beforeState (called
   * before the handler runs) and afterState (called after).
   * Foundation for partial rollback (Commit 12) and conflict
   * detection (Commit 18).
   */
  private extractItemState(
    item: any,
    actionType: BulkActionType,
    payload?: Record<string, any>,
  ): Record<string, any> {
    switch (actionType) {
      case 'PRICING_UPDATE':
        return {
          basePrice:
            item.basePrice != null ? Number(item.basePrice) : null,
        };
      case 'INVENTORY_UPDATE':
        return { totalStock: item.totalStock ?? null };
      case 'STATUS_UPDATE':
        return { status: item.status ?? null };
      case 'ATTRIBUTE_UPDATE': {
        // C.9 — capture the attribute slice the job is targeting so
        // rollback can restore it precisely. attributeName is in the
        // job payload; fall back to a full categoryAttributes snapshot
        // if missing (defensive — should never happen post-validation).
        const attributeName = String(payload?.attributeName ?? '')
        if (!attributeName) {
          return { categoryAttributes: item.categoryAttributes ?? null }
        }
        const { currentValue, kind, jsonKey } = readProductAttribute(
          item as ProductLike,
          attributeName,
        )
        return {
          attributeName,
          kind,
          jsonKey: jsonKey ?? null,
          value: currentValue,
        }
      }
      case 'MARKETPLACE_OVERRIDE_UPDATE':
        return {
          // `price` is the column the channel push reads; the history diff shows it beside the override.
          price: item.price != null ? Number(item.price) : null,
          priceOverride:
            item.priceOverride != null ? Number(item.priceOverride) : null,
          // `quantity` is the number the channel push sends; the diff shows it beside the override.
          quantity: item.quantity ?? null,
          quantityOverride: item.quantityOverride ?? null,
          stockBuffer: item.stockBuffer ?? null,
          followMasterPrice: item.followMasterPrice ?? null,
          followMasterQuantity: item.followMasterQuantity ?? null,
          pricingRule: item.pricingRule ?? null,
          priceAdjustmentPercent:
            item.priceAdjustmentPercent != null
              ? Number(item.priceAdjustmentPercent)
              : null,
        };
      case 'LISTING_SYNC':
        return {};
      case 'AI_TRANSLATE_PRODUCT':
        // W11.1 — capture the master copy that the AI saw at request
        // time + the requested language list, so the diff drawer
        // shows what was translated and into which locales.
        return {
          targetLanguages: Array.isArray(payload?.targetLanguages)
            ? payload?.targetLanguages
            : [],
          fields: Array.isArray(payload?.fields)
            ? payload?.fields
            : ['name', 'description', 'bulletPoints'],
          masterName: typeof item.name === 'string' ? item.name : null,
          masterDescription:
            typeof item.description === 'string'
              ? item.description.slice(0, 200)
              : null,
          masterBulletCount: Array.isArray(item.bulletPoints)
            ? item.bulletPoints.length
            : 0,
        };
      case 'AI_SEO_REGEN':
        // W11.2 — capture which locales the operator targeted +
        // the master fields the model receives.
        return {
          locales: Array.isArray(payload?.locales) ? payload?.locales : [],
          masterName: typeof item.name === 'string' ? item.name : null,
          masterKeywords: Array.isArray(item.keywords) ? item.keywords : [],
        };
      case 'AI_ALT_TEXT':
        // W11.3 — capture the policy + locale; the per-image
        // before-snapshot is too much for the audit row, the
        // afterState lookup handles the per-image diff.
        return {
          onlyEmpty: payload?.onlyEmpty !== false,
          locale: typeof payload?.locale === 'string' ? payload?.locale : 'en',
          masterName: typeof item.name === 'string' ? item.name : null,
        };
      case 'CHANNEL_BATCH':
        // W12.4 — capture the channel + operation + the master
        // values that the batch service receives.
        return {
          channel: typeof payload?.channel === 'string' ? payload?.channel : null,
          operation: typeof payload?.operation === 'string' ? payload?.operation : null,
          marketplace: typeof payload?.marketplace === 'string' ? payload?.marketplace : null,
          masterPrice: item.basePrice != null ? Number(item.basePrice) : null,
          masterStock: item.totalStock ?? null,
        };
      default:
        return {};
    }
  }

  /**
   * Refetch the entity from DB after the handler has run, returning
   * the slim state diff for the post-mutation values. Cheap (one
   * indexed-by-id read per item).
   */
  private async refetchAfterState(
    itemId: string,
    actionType: BulkActionType,
    payload?: Record<string, any>,
  ): Promise<Record<string, any>> {
    switch (actionType) {
      case 'PRICING_UPDATE':
      case 'INVENTORY_UPDATE':
      case 'STATUS_UPDATE': {
        const fresh = await this.prisma.product.findUnique({
          where: { id: itemId },
          select: { basePrice: true, totalStock: true, status: true },
        });
        return fresh ? this.extractItemState(fresh, actionType) : {};
      }
      case 'ATTRIBUTE_UPDATE': {
        // C.9 — Product (was ProductVariation). Re-reads the slice
        // the payload's attributeName targets so afterState mirrors
        // the captured beforeState shape.
        // P1 #52 — variantAttributes now part of the readback so the
        // new variantAttribute kind round-trips through the audit
        // trail symmetrically.
        const fresh = await this.prisma.product.findUnique({
          where: { id: itemId },
          select: {
            name: true,
            brand: true,
            manufacturer: true,
            productType: true,
            hsCode: true,
            countryOfOrigin: true,
            fulfillmentMethod: true,
            weightValue: true,
            weightUnit: true,
            dimLength: true,
            dimWidth: true,
            dimHeight: true,
            dimUnit: true,
            categoryAttributes: true,
            variantAttributes: true,
          },
        });
        return fresh ? this.extractItemState(fresh, actionType, payload) : {};
      }
      case 'MARKETPLACE_OVERRIDE_UPDATE': {
        const fresh = await this.prisma.channelListing.findUnique({
          where: { id: itemId },
          select: {
            price: true,
            priceOverride: true,
            quantity: true,
            quantityOverride: true,
            stockBuffer: true,
            followMasterPrice: true,
            followMasterQuantity: true,
            pricingRule: true,
            priceAdjustmentPercent: true,
          },
        });
        return fresh ? this.extractItemState(fresh, actionType) : {};
      }
      case 'LISTING_SYNC':
        return {};
      case 'AI_TRANSLATE_PRODUCT': {
        // W11.1 — return the language → source/sourceModel pairs
        // that now exist for this product. The diff drawer can show
        // "wrote it/de/fr · gemini-2.0-flash" as the after-snapshot.
        const rows = await this.prisma.productTranslation.findMany({
          where: { productId: itemId },
          select: { language: true, source: true, sourceModel: true, reviewedAt: true },
        });
        return {
          translations: rows.map((r) => ({
            language: r.language,
            source: r.source,
            sourceModel: r.sourceModel,
            reviewed: !!r.reviewedAt,
          })),
        };
      }
      case 'AI_SEO_REGEN': {
        // W11.2 — return the locale → metaTitle/metaDescription
        // pairs that now exist. Surfaces the SERP-bound output to
        // the diff drawer for review.
        const rows = await this.prisma.productSeo.findMany({
          where: { productId: itemId },
          select: {
            locale: true,
            metaTitle: true,
            metaDescription: true,
          },
        });
        return {
          seo: rows.map((r) => ({
            locale: r.locale,
            metaTitle: r.metaTitle,
            metaDescription: r.metaDescription,
          })),
        };
      }
      case 'AI_ALT_TEXT': {
        // W11.3 — return per-image alt previews so the diff drawer
        // shows what the model wrote. Trimmed to first 80 chars
        // per row to keep the JSON column compact for jobs that
        // touch many images.
        const images = await this.prisma.productImage.findMany({
          where: { productId: itemId },
          select: { id: true, type: true, alt: true, sortOrder: true },
          orderBy: { sortOrder: 'asc' },
        });
        return {
          images: images.map((i) => ({
            id: i.id,
            type: i.type,
            alt: typeof i.alt === 'string' ? i.alt.slice(0, 80) : null,
          })),
        };
      }
      case 'CHANNEL_BATCH': {
        // W12.4 — surface the resolved ChannelListing snapshot for
        // the diff drawer. The actual outcome of the batch
        // submission lives in the channel side (Amazon feed report,
        // Shopify currentBulkOperation poll, eBay per-op result),
        // beyond what this audit row captures; recording the
        // post-submit listing values is enough to confirm the
        // local-side state is consistent.
        const ch = (payload?.channel as string | undefined)?.toUpperCase();
        if (!ch) return {};
        const listing = await this.prisma.channelListing.findFirst({
          where: { productId: itemId, channel: ch },
          select: {
            channel: true,
            marketplace: true,
            externalListingId: true,
            price: true,
            quantity: true,
          },
        });
        return { listing };
      }
      default:
        return {};
    }
  }

  /**
   * Map an item.id to the BulkActionItem polymorphic target column
   * for the action type. Mirrors ACTION_ENTITY.
   */
  private targetColumnsFor(
    itemId: string,
    actionType: BulkActionType,
  ): {
    productId?: string;
    variationId?: string;
    channelListingId?: string;
  } {
    const target = ACTION_ENTITY[actionType];
    // C.9 — 'variation' was a possible value before; removed since
    // every live action type now targets 'product' or 'channelListing'.
    switch (target) {
      case 'product':
        return { productId: itemId };
      case 'channelListing':
        return { channelListingId: itemId };
    }
  }

  private async processItem(
    item: any,
    job: BulkActionJob
  ): Promise<{ status: 'processed' | 'skipped'; reason?: string }> {
    const payload = (job.actionPayload ?? {}) as Record<string, any>;
    const channel = job.channel ?? undefined;
    // Dispatcher casts to the entity each handler expects. Phase B-4
    // will replace these casts with a typed-getItemsForJob that
    // returns the right entity per action type, so the cast becomes
    // redundant + the compiler can verify the dispatch.
    switch (job.actionType) {
      case 'PRICING_UPDATE':
        return await this.processPricingUpdate(
          item as Product,
          payload,
          job.id,
        );
      case 'INVENTORY_UPDATE':
        return await this.processInventoryUpdate(
          item as Product,
          payload,
          job.id,
        );
      case 'STATUS_UPDATE':
        return await this.processStatusUpdate(
          item as Product | ProductVariation,
          payload,
          job.id,
        );
      case 'ATTRIBUTE_UPDATE':
        return await this.processAttributeUpdate(
          item as Product,
          payload,
          job.id,
        );
      case 'LISTING_SYNC':
        return await this.processListingSync(
          item as Product,
          payload,
          job.id,
        );
      case 'MARKETPLACE_OVERRIDE_UPDATE':
        return await this.processMarketplaceOverrideUpdate(
          item as ChannelListing,
          payload,
          job,
        );
      case 'AI_TRANSLATE_PRODUCT':
        return await this.processAiTranslate(item as Product, payload);
      case 'AI_SEO_REGEN':
        return await this.processAiSeoRegen(item as Product, payload);
      case 'AI_ALT_TEXT':
        return await this.processAiAltText(item as Product, payload);
      case 'CHANNEL_BATCH':
        return await this.processChannelBatch(item as Product, payload, job.channel);
      default:
        throw new Error(`Unknown action type: ${job.actionType}`);
    }
  }

  /**
   * W12.4 — CHANNEL_BATCH per-item handler.
   *
   * Payload:
   *   channel: 'AMAZON' | 'EBAY' | 'SHOPIFY'
   *   operation: 'price' | 'stock'
   *   marketplace?: string  (e.g. 'IT', 'DE' for Amazon; ignored for Shopify)
   *
   * Resolves the master Product to its ChannelListing on the
   * (channel, marketplace) tuple, builds the channel-specific batch
   * operation, and submits via the W12.1-3 batch services. v0 fires
   * one submission per item — a follow-up can aggregate multiple
   * items into a single batch for true cross-item efficiency.
   *
   * Skips when:
   *   - no ChannelListing for this product on the requested channel/marketplace
   *   - (price ops) the listing has no price to send — its send price, as the price door answers it — or its market
   *     has no currency, or the price is not above 0 or is outside the product's floor/ceiling: said by name on the
   *     item (`reason`, the item's message)
   */
  private async processChannelBatch(
    item: Product,
    payload: Record<string, any>,
    jobChannel: string | null,
  ): Promise<{ status: 'processed' | 'skipped'; reason?: string }> {
    const channel = String(payload.channel ?? jobChannel ?? '').toUpperCase();
    if (!['AMAZON', 'EBAY', 'SHOPIFY'].includes(channel)) {
      throw new Error(
        `CHANNEL_BATCH: payload.channel must be AMAZON | EBAY | SHOPIFY; got "${channel}"`,
      );
    }
    const operation = String(payload.operation ?? '').toLowerCase();
    if (!['price', 'stock'].includes(operation)) {
      throw new Error(
        `CHANNEL_BATCH: payload.operation must be 'price' | 'stock'; got "${operation}"`,
      );
    }
    const marketplace =
      typeof payload.marketplace === 'string' && payload.marketplace.length > 0
        ? payload.marketplace
        : undefined;
    const listing = await this.prisma.channelListing.findFirst({
      where: {
        productId: item.id,
        channel,
        ...(marketplace ? { marketplace } : {}),
      },
    });
    if (!listing) return { status: 'skipped' };

    // The SKU is read from Product.sku; a stock op's quantity falls back to the product's sellable total.
    const sku = item.sku;
    // Round 7 (2026-10-01) — a price op sends THE send price (`listingSendPrice`: a pin's own price, a follower's rule
    // price from the current master in the master currency, else the price it holds — the price door's and the
    // publishers' answer), in the listing market's OWN currency, held to the product's floor and ceiling as every
    // other price sender holds it (`priceBoundsRefusal`, the check `priceRefusalFor` makes; read through this job's own
    // client). It sent `listing.price ?? product.basePrice` in a hard-coded EUR: a pin's own price could be ignored, a
    // "master +10%" follower could get the master, and eBay UK the EUR number. Nothing to send is a skip with its
    // reason (the item's message), never a guess.
    const channelName = channel === 'AMAZON' ? 'Amazon' : channel === 'EBAY' ? 'eBay' : 'Shopify';
    const sendable = async (row: ChannelListing): Promise<{ value: number; currency: string } | { skip: string }> => {
      const where = `${channelName} ${row.marketplace}`;
      // Unreadable or unconfigured, the market has no currency: nothing is sent there (refuse, don't guess).
      let marketCur: string | null = null;
      try {
        const rows = await this.prisma.marketplace.findMany({ where: { channel: row.channel }, select: { channel: true, code: true, currency: true } });
        marketCur = marketCurrency(row.channel, row.marketplace, rows);
      } catch { marketCur = null; }
      const send = listingSendPrice(row, { masterPrice: item.basePrice, marketCurrency: marketCur, where });
      if (send.price == null) return { skip: `${sku}: ${send.reason} Nothing was sent.` };
      if (!marketCur) return { skip: `${sku}: no currency is configured for ${where}. Set the market's currency. Nothing was sent.` };
      const zero = zeroPriceReason(send.price);
      if (zero) return { skip: `${sku}: ${zero}. Nothing was sent.` };
      // A floor or ceiling that cannot be read is no bound, as `loadPriceBounds` treats it (it guards one that exists).
      let bounds: { minPrice?: unknown; maxPrice?: unknown } | null = null;
      try { bounds = await this.prisma.product.findUnique({ where: { id: item.id }, select: { minPrice: true, maxPrice: true } }); } catch { bounds = null; }
      const outside = priceBoundsRefusal({ price: send.price, bounds: priceBoundsOf(bounds ?? {}), channel: channelName, sku, currency: marketCur, masterCurrency: masterCurrency() });
      if (outside) return { skip: outside };
      return { value: send.price, currency: marketCur };
    };

    if (channel === 'AMAZON') {
      const { submitAmazonListingsBatch } = await import(
        './channel-batch/amazon-batch-feed.service.js'
      );
      const sellerId =
        (await getAmazonSellerId());
      if (!sellerId) {
        throw new Error(
          'CHANNEL_BATCH AMAZON: AMAZON_SELLER_ID env required',
        );
      }
      // P0.7 — the feed goes through the default seller: this listing must belong to it.
      {
        const account = await import('../lib/amazon-sp-client.js').then((m) => m.amazonAccount({ sellerId })).catch(() => null);
        if (account) await assertWriteAccount('AMAZON', account.id, { listingIds: [listing.id] });
      }
      const marketplaceIds = marketplace ? [marketplace] : [];
      if (operation === 'price') {
        const sent = await sendable(listing);
        if ('skip' in sent) return { status: 'skipped', reason: sent.skip };
        await submitAmazonListingsBatch({
          marketplaceIds,
          sellerId,
          operations: [{ type: 'price', sku, currency: sent.currency, value: sent.value }],
        });
      } else {
        // FBA-flip fix — a batch stock op emits fulfillment_channel_code:DEFAULT,
        // which flips an FBA offer to FBM. Never push merchant quantity for an FBA
        // listing; skip (fail-closed) on any FBA signal incl. FBA stock on hand.
        const fbaAgg = await this.prisma.stockLevel
          .aggregate({
            where: { productId: item.id, location: { code: 'AMAZON-EU-FBA' } },
            _sum: { quantity: true },
          })
          .catch(() => null);
        if (isFbaListing(listing, item, { fbaStockQty: fbaAgg?._sum.quantity ?? null })) {
          return { status: 'skipped' };
        }
        const qty = Number(listing.quantity ?? (await sellableQuantity(this.prisma as never, [item])).get(item.id) ?? 0);
        await submitAmazonListingsBatch({
          marketplaceIds,
          sellerId,
          operations: [{ type: 'stock', sku, quantity: qty }],
        });
      }
      return { status: 'processed' };
    }

    if (channel === 'EBAY') {
      const { submitEbayParallelBatch } = await import(
        './channel-batch/ebay-parallel-batch.service.js'
      );
      // MAP.3 — DECLARED. A bulk batch spans many SKUs with no single owning row,
      // so there is nothing to derive from at this point.
      const connection = await tryResolveConnection({ channel: 'EBAY', primary: true });
      if (!connection) {
        throw new Error('CHANNEL_BATCH EBAY: no active eBay connection');
      }
      // P0.7 — this batch can only use the primary account: the listing must belong to it.
      await assertWriteAccount('EBAY', connection.id, { listingIds: [listing.id] });
      const offerId = listing.externalListingId;
      let batch: Awaited<ReturnType<typeof submitEbayParallelBatch>>;
      if (operation === 'price') {
        if (!offerId) return { status: 'skipped' };
        const sent = await sendable(listing);
        if ('skip' in sent) return { status: 'skipped', reason: sent.skip };
        batch = await submitEbayParallelBatch({
          connectionId: connection.id,
          operations: [{ type: 'price', sku, offerId, currency: sent.currency, value: sent.value.toFixed(2) }],
        });
      } else {
        const qty = Number(listing.quantity ?? (await sellableQuantity(this.prisma as never, [item])).get(item.id) ?? 0);
        batch = await submitEbayParallelBatch({
          connectionId: connection.id,
          operations: [{ type: 'stock', sku, quantity: qty }],
        });
      }
      // P0.1 — a failed or refused operation must not read as "processed".
      const failure = batch.results.find((r) => r.status === 'failed');
      if (failure) throw new Error(failure.errorMessage ?? 'eBay did not accept this change.');
      return { status: 'processed' };
    }

    // SHOPIFY — P1.4b: each listing through its own account on the 2026-07 GraphQL client, the same
    // code as the outbound queue (services/shopify/listing-write.service.ts; a native family through
    // offer-sync). It replaces a bulk operation on the env credentials that set ONE env inventory item
    // (SHOPIFY_DEFAULT_INVENTORY_ITEM_GID) for every product and used the removed productVariantUpdate.
    const shopifyListings = await this.prisma.channelListing.findMany({
      where: { productId: item.id, channel: 'SHOPIFY', ...(marketplace ? { marketplace } : {}) },
    });
    const accounts = [...new Set(shopifyListings.map((l) => l.channelConnectionId ?? ''))];
    if (accounts.length > 1) {
      // D7 — refuse loudly; never pick one of several shops.
      throw new Error('CHANNEL_BATCH SHOPIFY: this product is on more than one Shopify account (or one listing records none). Nothing was sent.');
    }
    const shopifyListing = shopifyListings[0];
    // The push lock (paused, closed, ended, Presence intent) — the bulk operation checked it per line.
    const refusal = assertPushAllowed(shopifyListing);
    if (refusal) throw Object.assign(new Error(`${refusal.code}: ${refusal.sentence}`), { code: refusal.code, refusal });
    let accountId = shopifyListing.channelConnectionId;
    if (!accountId) {
      const active = await listActiveConnections('SHOPIFY');
      if (active.length !== 1) throw new Error('CHANNEL_BATCH SHOPIFY: the listing records no Shopify account and Nexus cannot tell which one it is. Nothing was sent.');
      accountId = active[0].id;
    }
    const syncType = operation === 'price' ? 'PRICE_UPDATE' : 'QUANTITY_UPDATE';
    const shopifyRow = { id: `bulk-${shopifyListing.id}-${operation}`, syncType, product: item, channelListing: shopifyListing, payload: {} as Record<string, unknown> };
    const platform = (shopifyListing.platformAttributes ?? {}) as Record<string, unknown>;
    if (platform.nexusFamilyId) {
      const { syncNativeShopifyOffer } = await import('./shopify/offer-sync.service.js');
      await syncNativeShopifyOffer(shopifyRow);
      return { status: 'processed' };
    }
    const { syncShopifyLinkedListing } = await import('./shopify/listing-write.service.js');
    if (operation === 'price') {
      const sent = await sendable(shopifyListing);
      if ('skip' in sent) return { status: 'skipped', reason: sent.skip };
      const value = sent.value;
      await syncShopifyLinkedListing(shopifyRow, accountId, { price: value });
    } else {
      await syncShopifyLinkedListing(shopifyRow, accountId, { quantity: Number(shopifyListing.quantity ?? (await sellableQuantity(this.prisma as never, [item])).get(item.id) ?? 0) });
    }
    return { status: 'processed' };
  }

  /**
   * W11.3 — AI bulk alt-text handler.
   *
   * Payload:
   *   onlyEmpty?: boolean   (default true — never overwrites an
   *     operator-authored alt. Set false to redo every image.)
   *   locale?: string       (BCP 47 lowercase; default 'en')
   *
   * For each ProductImage on the master Product:
   *   - Skip when onlyEmpty=true and the row already has alt text.
   *   - Otherwise call generateAltText with the product's master
   *     copy + the image's role (MAIN / ALT / LIFESTYLE / SWATCH).
   *   - Update ProductImage.alt with the returned string.
   *
   * Returns 'skipped' when the product has no images or every
   * image already has alt text.
   */
  private async processAiAltText(
    item: Product,
    payload: Record<string, any>,
  ): Promise<{ status: 'processed' | 'skipped' }> {
    const { generateAltText } = await import('./ai/alt-text.service.js');
    const onlyEmpty = payload.onlyEmpty !== false;
    const locale =
      typeof payload.locale === 'string'
        ? payload.locale.trim().toLowerCase()
        : 'en';
    if (!/^[a-z]{2}(-[a-z0-9]{2,8})?$/.test(locale)) {
      throw new Error(
        `AI_ALT_TEXT: payload.locale must be BCP 47 lowercase; got "${locale}"`,
      );
    }
    const product = await this.prisma.product.findUnique({
      where: { id: item.id },
    });
    if (!product || !product.name?.trim()) return { status: 'skipped' };
    const images = await this.prisma.productImage.findMany({
      where: { productId: product.id },
      orderBy: { sortOrder: 'asc' },
    });
    if (images.length === 0) return { status: 'skipped' };
    let didWriteAny = false;
    for (const img of images) {
      if (onlyEmpty && img.alt && img.alt.trim().length > 0) continue;
      const out = await generateAltText({
        source: {
          name: product.name,
          brand: product.brand,
          productType: product.productType ?? null,
          imageType: img.type,
        },
        locale,
        productId: product.id,
        imageId: img.id,
        feature: 'bulk-alt-text',
      });
      if (!out.alt) continue;
      await this.prisma.productImage.update({
        where: { id: img.id },
        data: { alt: out.alt },
      });
      didWriteAny = true;
    }
    return { status: didWriteAny ? 'processed' : 'skipped' };
  }

  /**
   * W11.2 — AI bulk SEO regen handler.
   *
   * Payload:
   *   locales: string[]   (BCP 47 lowercase, e.g. ['en','it','de-de'])
   *   keepHandle?: boolean   (default true — never overwrite urlHandle.
   *     SEO regen rewrites titles/descriptions/og pairs only; the URL
   *     slug is operator-curated and changing it breaks inbound links.)
   *
   * For each locale: calls regenerateProductSeo, upserts ProductSeo
   * keyed on (productId, locale). The handler skips a row when:
   *   - the master product has no name (regen needs a source).
   */
  private async processAiSeoRegen(
    item: Product,
    payload: Record<string, any>,
  ): Promise<{ status: 'processed' | 'skipped' }> {
    const { regenerateProductSeo } = await import('./ai/seo-regen.service.js');
    const locales = Array.isArray(payload.locales)
      ? (payload.locales as unknown[])
          .filter((l): l is string => typeof l === 'string')
          .map((l) => l.trim().toLowerCase())
          .filter((l) => /^[a-z]{2}(-[a-z0-9]{2,8})?$/.test(l))
      : [];
    if (locales.length === 0) {
      throw new Error(
        'AI_SEO_REGEN: payload.locales required (BCP 47 lowercase)',
      );
    }
    const product = await this.prisma.product.findUnique({
      where: { id: item.id },
    });
    if (!product || !product.name?.trim()) return { status: 'skipped' };

    let didWriteAny = false;
    for (const locale of locales) {
      const seo = await regenerateProductSeo({
        source: {
          name: product.name,
          description: product.description,
          bulletPoints: product.bulletPoints,
          brand: product.brand,
          productType: product.productType ?? null,
          keywords: product.keywords,
        },
        locale,
        productId: product.id,
        feature: 'bulk-seo-regen',
      });
      await this.prisma.productSeo.upsert({
        where: {
          productId_locale: workspaceKey({ productId: product.id, locale }),
        },
        create: {
          productId: product.id,
          locale,
          metaTitle: seo.metaTitle,
          metaDescription: seo.metaDescription,
          ogTitle: seo.ogTitle,
          ogDescription: seo.ogDescription,
        },
        update: {
          metaTitle: seo.metaTitle,
          metaDescription: seo.metaDescription,
          ogTitle: seo.ogTitle,
          ogDescription: seo.ogDescription,
          // Note: do NOT touch urlHandle / canonicalUrl / schemaOrgJson —
          // those are operator-curated. SEO regen is title/desc only.
        },
      });
      didWriteAny = true;
    }
    return { status: didWriteAny ? 'processed' : 'skipped' };
  }

  /**
   * W11.1 — AI bulk translate handler.
   *
   * Payload:
   *   targetLanguages: string[]                  (ISO 639-1 lowercase)
   *   fields?: ('name'|'description'|'bulletPoints')[]
   *   skipReviewed?: boolean                     (default true — never
   *     overwrite operator-reviewed copy. Set false when redoing.)
   *
   * For each requested target language: calls translateProductCopy
   * once, upserts ProductTranslation. Skips the row when:
   *   - the source product has no copy in any of the requested fields
   *     (nothing to translate)
   *   - skipReviewed=true AND the existing ProductTranslation has a
   *     non-null reviewedAt for that language (operator already
   *     reviewed; respecting their work).
   */
  private async processAiTranslate(
    item: Product,
    payload: Record<string, any>,
  ): Promise<{ status: 'processed' | 'skipped' }> {
    return requireTranslationGeneration();
  }

  // ── Operation handlers ──────────────────────────────────────────────
  //
  // Each handler:
  //   - Validates payload shape inline (throw on bad input → counted
  //     as a failed item by processJob's try/catch)
  //   - Operates on its target entity (PRICING/INVENTORY/ATTRIBUTE
  //     write to ProductVariation; STATUS writes to Product)
  //   - Returns 'processed' on success, 'skipped' for soft-validation
  //     failures (e.g. price below configured floor)
  //
  // Marketplace sync (the `_channel` arg) is deferred to v2 — the
  // existing sync helpers in this file are kept but unwired. v1 only
  // updates the local DB.

  /**
   * PRICING_UPDATE — set / adjust Product.basePrice with full
   * channel cascade. Delegates to MasterPriceService.update so the
   * write atomically updates Product.basePrice, fans out to every
   * ChannelListing per the followMasterPrice / pricingRule contract,
   * enqueues OutboundSyncQueue rows, and writes an AuditLog entry.
   * See DEVELOPMENT.md "Master-data cascade" for the propagation rules.
   *
   * Payload:
   *   adjustmentType: 'ABSOLUTE' | 'PERCENT' | 'DELTA' | 'ROUND_DOWN_TO_99'
   *   value: number              (the multiplier / delta / absolute; none for ROUND_DOWN_TO_99)
   *   minPrice?: number          (skip if computed price below floor)
   *   maxPrice?: number          (skip if computed price above ceiling)
   *
   * ROUND_DOWN_TO_99: the largest X.99 at or below the current price
   * (`bulk-action/price-rounding.ts`); skipped when there is none
   * (under 0.99) or the price already ends in .99.
   * Every mode also skips a price it would store as 0 or below, and a
   * price outside the product's own floor / ceiling (Product.minPrice /
   * maxPrice) — the push would refuse it after Nexus stored it.
   * Every mode's rule: `bulk-action/pricing-update.ts`, shared with
   * the preview.
   */
  private async processPricingUpdate(
    item: Product,
    payload: Record<string, any>,
    jobId: string,
  ): Promise<{ status: 'processed' | 'skipped'; reason?: string }> {
    // The preview's own rule (`computePreview`) on the same row (a whole
    // Product: basePrice, minPrice, maxPrice): the new price in stored
    // cents, or a skip — below zero, outside the job's minPrice /
    // maxPrice, nothing to round, a stored price of 0 or below, or
    // outside the product's own floor / ceiling — with the reason in
    // plain words, kept on the skipped item. Soft constraints skip
    // rather than fail so the rest of the job continues; a payload no
    // row can run throws (the item fails).
    const outcome = pricingUpdateOutcome(item, payload);
    if (outcome.status === 'skipped') return { status: 'skipped', reason: outcome.reason };

    try {
      await this.masterPriceService.update(item.id, outcome.newPrice, {
        actor: 'bulk-action',
        reason: 'bulk-pricing-job',
        idempotencyKey: `${jobId}:${item.id}`,
      });
    } catch (err) {
      // The product's floor or ceiling changed after this job read the row: the master-price write refuses the whole
      // edit with the same "Not changed: …" sentence, and the row is skipped with it, as the preview skips it.
      if (err instanceof MasterPriceRefusedError) return { status: 'skipped', reason: err.message };
      throw err;
    }

    return { status: 'processed' };
  }

  /**
   * INVENTORY_UPDATE — set / adjust Product.totalStock with full
   * channel cascade. Delegates to applyStockMovement so the write
   * goes through the StockLevel ledger, recomputes Product.totalStock
   * = SUM(StockLevel), fans out to every ChannelListing per the
   * followMasterQuantity / stockBuffer contract, enqueues
   * OutboundSyncQueue rows, and writes a StockMovement audit row.
   * See DEVELOPMENT.md "Master-data cascade" for propagation rules.
   *
   * Payload:
   *   adjustmentType: 'ABSOLUTE' | 'DELTA'
   *   value: number              (set-to or delta)
   */
  private async processInventoryUpdate(
    item: Product,
    payload: Record<string, any>,
    jobId: string,
  ): Promise<{ status: 'processed' | 'skipped' }> {
    const adjustmentType = payload.adjustmentType as
      | 'ABSOLUTE'
      | 'DELTA'
      | undefined;
    const rawValue = payload.value;
    const value =
      typeof rawValue === 'number' ? rawValue : Number(rawValue);
    if (!adjustmentType || Number.isNaN(value)) {
      throw new Error(
        'Invalid INVENTORY_UPDATE payload: adjustmentType + numeric value required',
      );
    }

    const currentStock = item.totalStock ?? 0;
    let targetStock: number;
    switch (adjustmentType) {
      case 'ABSOLUTE':
        targetStock = value;
        break;
      case 'DELTA':
        targetStock = currentStock + value;
        break;
    }
    targetStock = Math.max(0, Math.floor(targetStock));

    // applyStockMovement requires a non-zero change. Same-value writes
    // (set-to current, or delta=0) are no-ops — skip.
    const change = targetStock - currentStock;
    if (change === 0) return { status: 'skipped' };

    await applyStockMovement({
      productId: item.id,
      change,
      reason: 'MANUAL_ADJUSTMENT',
      referenceType: 'BulkActionJob',
      referenceId: jobId,
      actor: 'bulk-action',
    });

    return { status: 'processed' };
  }

  /**
   * STATUS_UPDATE — set product status (DRAFT / ACTIVE / INACTIVE).
   *
   * Payload:
   *   status: 'DRAFT' | 'ACTIVE' | 'INACTIVE'
   *
   * Status lives on Product. `item` may be a Product (when scope is
   * targetProductIds) or a ProductVariation (when scope is filters /
   * targetVariationIds). Resolve to parent productId via the
   * `productId` field present on variations only.
   */
  private async processStatusUpdate(
    item: Product | ProductVariation,
    payload: Record<string, any>,
    jobId: string,
  ): Promise<{ status: 'processed' | 'skipped' }> {
    const VALID = ['DRAFT', 'ACTIVE', 'INACTIVE'] as const;
    const newStatus = payload.status as 'DRAFT' | 'ACTIVE' | 'INACTIVE';
    if (!VALID.includes(newStatus)) {
      throw new Error(
        `Invalid STATUS_UPDATE payload: status must be one of ${VALID.join(', ')}`,
      );
    }

    // ProductVariation has `productId`; Product does not. Use that as
    // the type discriminator without depending on a class instance.
    const productId =
      'productId' in item && item.productId ? item.productId : item.id;

    // TECH_DEBT #53: route through MasterStatusService so the change
    // cascades to ChannelListing.listingStatus + OutboundSyncQueue +
    // AuditLog atomically. Without this, the marketplace continues to
    // show items in the old state until the next manual sync.
    await this.masterStatusService.update(productId, newStatus, {
      actor: 'bulk-action',
      reason: `bulk-job:${jobId}`,
    });

    return { status: 'processed' };
  }

  /**
   * ATTRIBUTE_UPDATE — set one key inside ProductVariation.variationAttributes.
   *
   * Payload:
   *   attributeName: string      (the JSON key to write)
   *   value: any                 (the value — primitive or object/array)
   *
   * C.9 — Product-targeting with strict allowlist for scalar columns
   * + one-level dot-paths into categoryAttributes. Persists the change
   * + enqueues OutboundSyncQueue rows for each ChannelListing of the
   * product so the cron worker can push the new value to live channels.
   */
  private async processAttributeUpdate(
    item: Product,
    payload: Record<string, any>,
    jobId: string,
  ): Promise<{ status: 'processed' | 'skipped' }> {
    const attributeName = payload.attributeName
    if (
      typeof attributeName !== 'string' ||
      attributeName.trim().length === 0
    ) {
      throw new Error(
        'Invalid ATTRIBUTE_UPDATE payload: attributeName required (non-empty string)',
      )
    }
    const newValue = payload.value
    const { kind, jsonKey, currentValue } = readProductAttribute(
      item as ProductLike,
      attributeName,
    )
    if (kind === 'unsupported') {
      throw new Error(
        `Invalid ATTRIBUTE_UPDATE attributeName "${attributeName}": not in scalar allowlist + not a categoryAttributes path`,
      )
    }
    // Idempotent skip — same as previewItem.
    if (
      currentValue === newValue ||
      JSON.stringify(currentValue) === JSON.stringify(newValue)
    ) {
      return { status: 'skipped' }
    }

    if (kind === 'scalar') {
      await this.prisma.product.update({
        where: { id: item.id },
        data: { [attributeName]: newValue } as any,
      })
    } else if (kind === 'categoryAttribute') {
      // categoryAttributes JSON merge.
      const raw = (item as ProductLike).categoryAttributes
      const current =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {}
      const merged = { ...current, [jsonKey!]: newValue }
      await this.prisma.product.update({
        where: { id: item.id },
        data: { categoryAttributes: merged as any },
      })
    } else {
      // P1 #52 — variantAttributes JSON merge. Mirrors the
      // categoryAttributes path but writes per-variant values on
      // Product (used for child products that carry Color / Size /
      // material values for Amazon variation themes).
      // R-23 (Step 2.6c-2) — the path keeps its name, but the value goes to the one store
      // (`categoryAttributes.variations`); the legacy bag loses the axis and is never written.
      await writeVariationValues(this.prisma, item.id, variationValuesPlan({ categoryAttributes: (item as ProductLike).categoryAttributes, variantAttributes: (item as ProductLike).variantAttributes }, { [jsonKey!]: newValue }))
    }

    // Enqueue per-ChannelListing OutboundSyncQueue rows so the cron
    // worker pushes the new attribute to live channels. Same pattern
    // PRICING_UPDATE uses via MasterPriceService.
    const listings = await this.prisma.channelListing.findMany({
      where: { productId: item.id },
      select: { id: true, channel: true, marketplace: true },
    })
    if (listings.length > 0) {
      // RT.2 — instant lane (no holdUntil ⇒ delay 0); cron backstops.
      const { enqueueOutboundRowsInstant } = await import('./outbound-enqueue.js')
      await enqueueOutboundRowsInstant(
        this.prisma,
        listings.map((l) => ({
          productId: item.id,
          channelListingId: l.id,
          // ChannelListing.channel is String; SyncChannel is an enum.
          // Cast through unknown so the runtime value (already
          // 'AMAZON'/'EBAY'/'SHOPIFY'/'WOOCOMMERCE') maps cleanly.
          targetChannel: l.channel as unknown as 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'WOOCOMMERCE',
          targetRegion: l.marketplace,
          // syncType is the column-level discriminator the cron worker
          // dispatches on. LISTING_SYNC is the closest match for a
          // generic attribute push (no dedicated ATTRIBUTE_UPDATE
          // value in the worker's switch yet); the JSON payload carries
          // the actual attribute name + value.
          syncType: 'LISTING_SYNC',
          payload: {
            kind: 'ATTRIBUTE_UPDATE',
            attributeName,
            value: newValue,
            source: 'bulk-action',
            bulkJobId: jobId,
          } as any,
          syncStatus: 'PENDING',
        })),
        { source: 'bulk-action' },
      )
    }

    return { status: 'processed' }
  }

  /**
   * C.9 — LISTING_SYNC: queue a full-state push for every ChannelListing
   * of the product. No Product mutation. Optional channels[] payload
   * filter scopes the queue rows to a subset (e.g. ['AMAZON']) so an
   * operator can resync just one channel without touching others.
   * Skipped when the product has no ChannelListings (nothing to sync).
   */
  private async processListingSync(
    item: Product,
    payload: Record<string, any>,
    jobId: string,
  ): Promise<{ status: 'processed' | 'skipped' }> {
    const channelsFilter = Array.isArray(payload.channels)
      ? (payload.channels as unknown[])
          .filter((c): c is string => typeof c === 'string' && c.length > 0)
          .map((c) => c.toUpperCase())
      : null
    const syncType =
      typeof payload.syncType === 'string' &&
      ['FULL_SYNC', 'PRICE_UPDATE', 'QUANTITY_UPDATE', 'ATTRIBUTE_UPDATE'].includes(
        payload.syncType,
      )
        ? (payload.syncType as
            | 'FULL_SYNC'
            | 'PRICE_UPDATE'
            | 'QUANTITY_UPDATE'
            | 'ATTRIBUTE_UPDATE')
        : 'FULL_SYNC'

    const listings = await this.prisma.channelListing.findMany({
      where: {
        productId: item.id,
        ...(channelsFilter ? { channel: { in: channelsFilter as any[] } } : {}),
      },
      select: { id: true, channel: true, marketplace: true },
    })
    if (listings.length === 0) {
      return { status: 'skipped' }
    }
    // RT.2 — instant lane (no holdUntil ⇒ delay 0); cron backstops.
    const { enqueueOutboundRowsInstant } = await import('./outbound-enqueue.js')
    await enqueueOutboundRowsInstant(
      this.prisma,
      listings.map((l) => ({
        productId: item.id,
        channelListingId: l.id,
        targetChannel: l.channel as unknown as
          | 'AMAZON'
          | 'EBAY'
          | 'SHOPIFY'
          | 'WOOCOMMERCE',
        targetRegion: l.marketplace,
        // Column-level discriminator the cron worker switches on.
        // The payload's syncType (passed through from the job) is the
        // operator-chosen variant for the sync run.
        syncType,
        payload: {
          kind: 'LISTING_SYNC',
          syncType,
          source: 'bulk-listing-sync',
          bulkJobId: jobId,
        } as any,
        syncStatus: 'PENDING',
      })),
      { source: 'bulk-listing-sync' },
    )
    return { status: 'processed' }
  }

  /**
   * E.5a — MARKETPLACE_OVERRIDE_UPDATE — write per-marketplace overrides
   * on a ChannelListing row. Lets the seller, in one bulk pass,
   * adjust 200 listings on Amazon DE without touching their IT counterparts.
   *
   * Payload (one or more keys; missing keys are no-ops; read by `marketplaceOverridePlan`):
   *   priceOverride?: number | null    — pins the channel price; null hands it back to the master price
   *   followMasterPrice?: boolean      — true = the same hand-back; false needs priceOverride
   *   quantityOverride?: number | null — fixes the quantity at a whole number; null follows the stock again
   *   followMasterQuantity?: boolean   — true = follow the stock; false = fix it at the number it shows now
   *   stockBuffer?: number             — overselling-protection units
   *   followMasterTitle?: boolean      — when false, keep titleOverride
   *   followMasterDescription?: boolean
   *   followMasterImages?: boolean
   *   followMasterBulletPoints?: boolean
   *   pricingRule?: 'FIXED' | 'MATCH_AMAZON' | 'PERCENT_OF_MASTER'
   *   priceAdjustmentPercent?: number  — paired with PERCENT_OF_MASTER rule
   *   isPublished                      — refused, as the single-listing edit refuses it
   *
   * 🔴 Every field reaches the channel the way the app's single-listing edit of it does, never by a path of its own:
   *   - the price through the ONE channel price write (`writeChannelPrices`): `price` + `priceOverride` +
   *     `followMasterPrice`, the override audit row, the price timeline row and one PRICE_UPDATE row on the 30 s grace
   *     window. Before, this wrote `priceOverride` alone and the channel never got the price.
   *   - the quantity through the follow/pin primitive (`setFollowMasterQuantity`, the Studio matrix's and Sync
   *     Control's) and the buffer through `setStockBuffer`: the three quantity columns written together and one
   *     QUANTITY_UPDATE row. Before, `quantityOverride` / `stockBuffer` were written alone and nothing was sent.
   *     FBA is never touched (refused by name); an Amazon EU quantity is one number for every EU market, so it
   *     changes the SKU's whole EU group at once, and only when the job holds every row of that group.
   *
   *   - the pricing rule and percent through the same door's follower mode (2026-10-01): written in the price's
   *     compare-and-set; a following listing's price is recomputed by them and sent, or refused by name (outside the
   *     product's floor or ceiling) with nothing written. Before, they were plain columns and nothing was sent.
   *
   * Every refusal is decided BEFORE anything is written. The price and the other columns then land in one
   * transaction (the queue row is sent after the commit); the quantity and buffer follow through their primitives'
   * own transactions. The price's compare-and-set is against the listing as this job read it (the matrix verb's
   * rule, A-17): a price changed elsewhere during the run is not overwritten — the row fails and says so.
   */
  private async processMarketplaceOverrideUpdate(
    item: ChannelListing,
    payload: Record<string, any>,
    job: Pick<BulkActionJob, 'id' | 'createdBy'>,
  ): Promise<{ status: 'processed' | 'skipped' }> {
    const plan = marketplaceOverridePlan(payload)
    const actor = job.createdBy ?? 'bulk-action'
    const hasColumns = Object.keys(plan.columns).length > 0
    const hasInventory = plan.quantity !== undefined || plan.buffer !== undefined
    // Refusals first — nothing is written for a row that cannot be done whole.
    const group = hasInventory ? await this.inventoryGroupFor(item, job.id) : null

    const writeColumns = (db: Pick<PrismaClient, 'channelListing'> | Prisma.TransactionClient) =>
      db.channelListing.update({
        where: { id: item.id },
        // Bump audit-trail timestamp for any non-trivial write.
        data: { ...plan.columns, lastOverrideAt: new Date() },
      })

    let changed = false
    if (plan.price !== undefined || plan.rule !== undefined) {
      const seen = ownPriceAsRead(item)
      changed = await inDatabaseTransaction(this.prisma, async () => {
        const written = await writeChannelPrices({
          targets: [{
            listingId: item.id,
            ...(plan.price !== undefined ? { price: plan.price } : {}),
            ...(plan.rule !== undefined ? { rule: plan.rule } : {}),
            expectedVersion: item.version,
            ...(seen !== undefined ? { expectedPrice: seen } : {}),
          }],
          actor,
          source: 'BULK_OVERRIDE',
          reason: `Bulk action ${job.id}`,
        })
        const outcome = written.results[0]
        if (!outcome) throw new Error('The price write returned no outcome for this listing.')
        if (outcome.outcome === 'conflict') {
          throw new Error(
            'The price of this listing changed after the job read it, so it was not overwritten. Retry the failed rows to apply this job\'s price over it.',
          )
        }
        if (outcome.outcome === 'refused') {
          throw new Error(outcome.reason ?? 'The price write refused this listing.')
        }
        if (hasColumns) await writeColumns(activeDatabaseTransaction() ?? this.prisma)
        return outcome.outcome === 'applied' || hasColumns
      })
    } else if (hasColumns) {
      await writeColumns(this.prisma)
      changed = true
    }

    if (group) {
      try {
        if (await this.applyInventory(item, group, plan, actor, job.id)) changed = true
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        throw new Error(changed ? `The price and other fields were saved; the quantity change failed: ${why}` : why)
      }
    }
    return { status: changed ? 'processed' : 'skipped' }
  }

  /**
   * The rows a quantity or buffer change on `item` must land on — the item itself, or on an Amazon EU market the SKU's
   * whole open EU group (Amazon keeps ONE merchant quantity per SKU across the EU markets). Throws the refusal when
   * the change cannot be made whole: a channel the primitives do not serve, an FBA listing, or an EU group the job
   * does not hold entirely. Nothing has been written when it throws.
   */
  private async inventoryGroupFor(item: ChannelListing, jobId: string): Promise<ListingCoordinate[]> {
    if (item.channel !== 'AMAZON' && item.channel !== 'EBAY') {
      throw new Error('A fixed quantity or a stock buffer is set on Amazon and eBay listings only, so nothing was changed.')
    }
    const fbaStock = async (productId: string) => (await this.prisma.stockLevel.aggregate({
      where: { productId, location: { type: 'AMAZON_FBA' } }, _sum: { quantity: true },
    }))._sum.quantity ?? 0
    const product = await this.prisma.product.findUnique({ where: { id: item.productId }, select: { fulfillmentMethod: true } })
    const coordinate = (row: Pick<ChannelListing, 'productId' | 'channel' | 'marketplace' | 'channelConnectionId' | 'aliasKey'>): ListingCoordinate =>
      ({ productId: row.productId, channel: row.channel, marketplace: row.marketplace, channelConnectionId: row.channelConnectionId, aliasKey: row.aliasKey })

    if (item.channel === 'AMAZON') {
      const fbaQty = await fbaStock(item.productId)
      // Owner rule: FBA quantity is untouchable. The same fail-closed evidence the primitives use.
      if (isFbaListing(item, product, { fbaStockQty: fbaQty })) {
        throw new Error('Amazon manages this listing\'s quantity (FBA). Nexus never changes an FBA quantity, so nothing was changed.')
      }
      if (item.offerClosedAt) {
        throw new Error('This Amazon market\'s offer is closed, and a quantity change never reopens it (reopen the offer first), so nothing was changed.')
      }
      if (AMAZON_EU_SHARED_MARKETS.has(item.marketplace.toUpperCase())) {
        const siblings = await this.prisma.channelListing.findMany({
          where: {
            productId: item.productId, channel: 'AMAZON', channelConnectionId: item.channelConnectionId, aliasKey: item.aliasKey,
            marketplace: { in: [...AMAZON_EU_SHARED_MARKETS] }, listingStatus: { notIn: ['ENDED', 'REMOVED'] },
            // SCT.6 — a closed market offer expresses no quantity and is never reopened by a quantity change.
            offerClosedAt: null,
          },
        })
        // FBA rows never take part in the shared merchant number (amazon-eu-quantity-guard `intentOf`).
        const group = siblings.filter((row) => !isFbaListing(row, product, { fbaStockQty: fbaQty }))
        const scope = this.overrideRuns.get(jobId)?.scope
        const outside = group.filter((row) => row.id !== item.id && !scope?.has(row.id))
        if (outside.length > 0) {
          const markets = [...new Set(outside.map((row) => row.marketplace.toUpperCase()))].sort().join(', ')
          throw new Error(
            `Amazon keeps ONE quantity per SKU across the EU markets, so this change also covers ${markets}. ` +
              'Include every EU market of this listing in the job (no market filter) — nothing was changed.',
          )
        }
        return group.map(coordinate)
      }
    }
    return [coordinate(item)]
  }

  /**
   * The buffer, then the quantity, through the primitives the single-listing edit uses. Buffer first, so a listing
   * that follows the stock is recomputed with its new buffer. Returns whether anything changed. An EU group is
   * changed once per job, at its first row; its other rows report the change they were part of.
   */
  private async applyInventory(
    item: ChannelListing,
    group: ListingCoordinate[],
    plan: MarketplaceOverridePlan,
    actor: string,
    jobId: string,
  ): Promise<boolean> {
    const run = this.overrideRuns.get(jobId)
    if (run?.inventoryDone.has(item.id)) return true
    const channel = item.channel as FollowMasterChannel
    const markets = [...new Set(group.map((c) => c.marketplace))]
    const base = { productIds: [item.productId], channel, markets, actor, coordinates: group }
    const check = (r: { skippedFba: number; error?: string }) => {
      if (r.skippedFba > 0) throw new Error('Amazon manages this listing\'s quantity (FBA). Nexus never changes an FBA quantity, so nothing was changed.')
      if (r.error) throw new Error(r.error)
    }
    let changed = false
    if (plan.buffer !== undefined) {
      const r = await setStockBuffer({ ...base, buffer: plan.buffer })
      check(r)
      if (r.updated > 0) changed = true
    }
    if (plan.quantity !== undefined) {
      if (!plan.quantity.follow && plan.quantity.value !== undefined) {
        // The matrix's typed number (D-MX3): stage it in `quantity`; the PIN then fixes exactly that number.
        await this.prisma.channelListing.updateMany({
          where: { OR: group.map(whereCoordinate) },
          data: { quantity: plan.quantity.value },
        })
      }
      const r = await setFollowMasterQuantity({ ...base, follow: plan.quantity.follow })
      check(r)
      if (r.updated > 0) changed = true
    }
    if (run) {
      const ids = await this.prisma.channelListing.findMany({ where: { OR: group.map(whereCoordinate) }, select: { id: true } })
      for (const row of ids) run.inventoryDone.add(row.id)
    }
    return changed
  }
  /**
   * Count items matching the given ScopeFilters, scoped to the
   * action's target entity. Used by createJob to populate totalItems
   * up front (so the progress bar has a denominator from the start).
   */
  private async countItemsByFilters(
    filters: ScopeFilters,
    target: 'product' | 'variation' | 'channelListing',
    channel?: string | null,
  ): Promise<number> {
    try {
      if (target === 'channelListing') {
        const where: Prisma.ChannelListingWhereInput = {};
        if (channel) where.channel = channel;
        if (filters.marketplace) where.marketplace = filters.marketplace;
        if (filters.brand || filters.productType || filters.status) {
          const productClause: Prisma.ProductWhereInput = {};
          if (filters.brand) productClause.brand = filters.brand;
          if (filters.productType) productClause.productType = filters.productType;
          if (filters.status) productClause.status = filters.status;
          where.product = productClause;
        }
        return await this.prisma.channelListing.count({ where });
      }
      if (target === 'product') {
        return await this.prisma.product.count({
          where: this.buildProductFilterWhere(filters),
        });
      }
      return await this.prisma.productVariation.count({
        where: this.buildVariationFilterWhere(filters),
      });
    } catch (error) {
      logger.warn('Failed to count items by filters, returning 0', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Translate ScopeFilters → Prisma.ProductWhereInput.
   * Used by STATUS_UPDATE (and any other Product-targeted action).
   *
   *   - brand / productType / status → direct columns on Product
   *   - marketplace → some ChannelListing on this product matches
   *   - stockMin / stockMax → Product.totalStock (aggregate)
   */
  private buildProductFilterWhere(
    filters: ScopeFilters,
  ): Prisma.ProductWhereInput {
    const where: Prisma.ProductWhereInput = {};
    if (filters.brand) where.brand = filters.brand;
    if (filters.productType) where.productType = filters.productType;
    if (filters.status) where.status = filters.status;
    if (filters.marketplace) {
      where.channelListings = {
        some: { marketplace: filters.marketplace },
      };
    }
    if (filters.stockMin !== undefined || filters.stockMax !== undefined) {
      const stockClause: Prisma.IntFilter = {};
      if (filters.stockMin !== undefined) stockClause.gte = filters.stockMin;
      if (filters.stockMax !== undefined) stockClause.lte = filters.stockMax;
      where.totalStock = stockClause;
    }
    return where;
  }

  /**
   * Translate ScopeFilters → Prisma.ProductVariationWhereInput.
   * Used by PRICING / INVENTORY / ATTRIBUTE updates.
   *
   *   - brand / productType / status / marketplace → routed through
   *     the .product relation (those columns live on the parent)
   *   - stockMin / stockMax → ProductVariation.stock (per-variant)
   */
  /**
   * E.5a — Translate (job.channel, scope, filters) → ChannelListingWhereInput.
   * Used by MARKETPLACE_OVERRIDE_UPDATE. The job's `channel` field is the
   * target channel ("AMAZON", "EBAY"); filters.marketplace narrows to a
   * specific marketplace ("DE", "IT"); productIds (when scope is products)
   * tighten further. Listings without a channel match are excluded — this
   * action only ever touches the rows it's authorized to.
   */
  private buildChannelListingWhere(
    job: BulkActionJob,
    args: { productIds?: string[]; filters?: ScopeFilters },
  ): Prisma.ChannelListingWhereInput {
    const where: Prisma.ChannelListingWhereInput = {};
    if (job.channel) where.channel = job.channel;
    if (args.productIds && args.productIds.length > 0) {
      where.productId = { in: args.productIds };
    }
    const f = args.filters;
    if (f) {
      if (f.marketplace) where.marketplace = f.marketplace;
      if (f.brand || f.productType || f.status) {
        const productClause: Prisma.ProductWhereInput = {};
        if (f.brand) productClause.brand = f.brand;
        if (f.productType) productClause.productType = f.productType;
        if (f.status) productClause.status = f.status;
        where.product = productClause;
      }
    }
    return where;
  }

  private buildVariationFilterWhere(
    filters: ScopeFilters,
  ): Prisma.ProductVariationWhereInput {
    const where: Prisma.ProductVariationWhereInput = {};
    const productClause: Prisma.ProductWhereInput = {};
    let useProductClause = false;
    if (filters.brand) {
      productClause.brand = filters.brand;
      useProductClause = true;
    }
    if (filters.productType) {
      productClause.productType = filters.productType;
      useProductClause = true;
    }
    if (filters.status) {
      productClause.status = filters.status;
      useProductClause = true;
    }
    if (filters.marketplace) {
      productClause.channelListings = {
        some: { marketplace: filters.marketplace },
      };
      useProductClause = true;
    }
    if (useProductClause) where.product = productClause;
    if (filters.stockMin !== undefined || filters.stockMax !== undefined) {
      const stockClause: Prisma.IntFilter = {};
      if (filters.stockMin !== undefined) stockClause.gte = filters.stockMin;
      if (filters.stockMax !== undefined) stockClause.lte = filters.stockMax;
      where.stock = stockClause;
    }
    return where;
  }

  /**
   * Resolve a CreateJobInput to the set of distinct productIds it would
   * touch. Used by `findConflictingJobs` to compute set intersection
   * across simultaneously-active jobs.
   *
   * Resolution caps at `limit` (default 5000) — for the rare mass jobs
   * we don't want this helper to scan 50k rows on every conflict check.
   * Truncation is signalled in the return tuple so the caller can
   * surface "we couldn't be exhaustive — overlap may be larger" to the
   * operator.
   *
   * Channel-targeted ChannelListing actions still resolve to product
   * IDs; conflict detection is a coarse-grained "two operators editing
   * the same SKUs" check, not per-listing.
   */
  private async resolveTargetProductIdsFromInput(
    input: { actionType: BulkActionType; channel?: string | null; targetProductIds?: string[]; targetVariationIds?: string[]; filters?: Record<string, any> | null },
    limit = 5000,
  ): Promise<{ productIds: string[]; truncated: boolean }> {
    if (input.targetProductIds && input.targetProductIds.length > 0) {
      const truncated = input.targetProductIds.length > limit;
      return {
        productIds: truncated
          ? input.targetProductIds.slice(0, limit)
          : input.targetProductIds,
        truncated,
      };
    }
    if (input.targetVariationIds && input.targetVariationIds.length > 0) {
      const variations = await this.prisma.productVariation.findMany({
        where: { id: { in: input.targetVariationIds } },
        select: { productId: true },
        take: limit + 1,
      });
      const set = Array.from(new Set(variations.map((v) => v.productId)));
      const truncated = variations.length > limit;
      return {
        productIds: truncated ? set.slice(0, limit) : set,
        truncated,
      };
    }
    if (input.filters) {
      const filters = input.filters as ScopeFilters;
      const target = ACTION_ENTITY[input.actionType];
      let productIds: string[] = [];
      let truncated = false;
      if (target === 'channelListing') {
        const rows = await this.prisma.channelListing.findMany({
          where: this.buildChannelListingWhere(
            { channel: input.channel } as BulkActionJob,
            { filters },
          ),
          select: { productId: true },
          take: limit + 1,
        });
        productIds = Array.from(new Set(rows.map((r) => r.productId)));
        truncated = rows.length > limit;
      } else if (target === 'product') {
        const rows = await this.prisma.product.findMany({
          where: this.buildProductFilterWhere(filters),
          select: { id: true },
          take: limit + 1,
        });
        productIds = rows.map((r) => r.id);
        truncated = rows.length > limit;
      } else {
        const rows = await this.prisma.productVariation.findMany({
          where: this.buildVariationFilterWhere(filters),
          select: { productId: true },
          take: limit + 1,
        });
        productIds = Array.from(new Set(rows.map((r) => r.productId)));
        truncated = rows.length > limit;
      }
      return {
        productIds: truncated ? productIds.slice(0, limit) : productIds,
        truncated,
      };
    }
    return { productIds: [], truncated: false };
  }

  /**
   * Conflict detection — find every active job that touches the same
   * actionType + at least one overlapping productId.
   *
   * Active = status in (PENDING, QUEUED, IN_PROGRESS). COMPLETED /
   * FAILED / CANCELLED jobs are not conflicts (their writes already
   * committed; new job sees the new state).
   *
   * Same-actionType only: a PRICING job and an INVENTORY job on the
   * same SKUs are NOT a conflict — they touch different fields. A
   * STATUS_UPDATE and a STATUS_UPDATE on the same SKU IS a conflict.
   *
   * The result set is pruned to entries with overlapCount > 0 — jobs
   * that share an actionType but no overlapping products are not
   * conflicts. Ordered by createdAt desc so the most recent contender
   * is first.
   *
   * Note: this helper resolves filter-based jobs lazily on each call.
   * For tight loops (e.g. a UI re-checking on every keystroke) the
   * caller should debounce.
   */
  async findConflictingJobs(
    input: CreateJobInput,
  ): Promise<ConflictingJob[]> {
    const ACTIVE_STATUSES = ['PENDING', 'QUEUED', 'IN_PROGRESS'];
    const candidate = await this.resolveTargetProductIdsFromInput(input);
    if (candidate.productIds.length === 0) return [];
    const candidateSet = new Set(candidate.productIds);

    const activeJobs = await this.prisma.bulkActionJob.findMany({
      where: {
        status: { in: ACTIVE_STATUSES },
        actionType: input.actionType,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    if (activeJobs.length === 0) return [];

    const conflicts: ConflictingJob[] = [];
    for (const job of activeJobs) {
      const other = await this.resolveTargetProductIdsFromInput({
        actionType: job.actionType as BulkActionType,
        channel: job.channel,
        targetProductIds: job.targetProductIds ?? undefined,
        targetVariationIds: job.targetVariationIds ?? undefined,
        filters: (job.filters as Record<string, any> | null) ?? undefined,
      });
      let overlapCount = 0;
      for (const id of other.productIds) {
        if (candidateSet.has(id)) overlapCount++;
      }
      if (overlapCount === 0) continue;
      conflicts.push({
        jobId: job.id,
        jobName: job.jobName,
        actionType: job.actionType as BulkActionType,
        status: job.status,
        startedAt: job.startedAt ?? null,
        createdAt: job.createdAt,
        createdBy: job.createdBy ?? null,
        totalItems: job.totalItems,
        progressPercent: job.progressPercent,
        overlapCount,
        overlapTruncated: candidate.truncated || other.truncated,
      });
    }
    return conflicts;
  }
}
