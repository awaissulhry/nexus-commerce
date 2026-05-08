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
import { amazonProvider } from '../providers/amazon.provider.js';
import { ebayProvider } from '../providers/ebay.provider.js';
import type { MarketplaceProvider } from '../providers/types.js';
import { MasterPriceService } from './master-price.service.js';
import { MasterStatusService } from './master-status.service.js';
import { applyStockMovement } from './stock-movement.service.js';

// (Removed: a stubbed Decimal mock class whose `.plus()` returned
// `this`, breaking every PRICING_UPDATE math op silently. Phase B-3
// rewrites the pricing handler with plain JS arithmetic.)

export type BulkActionType =
  | 'PRICING_UPDATE'
  | 'INVENTORY_UPDATE'
  | 'STATUS_UPDATE'
  | 'ATTRIBUTE_UPDATE'
  | 'LISTING_SYNC'
  | 'MARKETPLACE_OVERRIDE_UPDATE';

/**
 * C.9 — strict allowlist for ATTRIBUTE_UPDATE scalar Product columns.
 * Anything else in the attributeName payload is interpreted as a
 * one-level dot-path inside categoryAttributes (e.g.
 * `categoryAttributes.material`). FK columns / IDs / version /
 * status / pricing fields are intentionally excluded — those have
 * dedicated action types (STATUS_UPDATE, PRICING_UPDATE, …) or are
 * not safe for bulk write.
 */
const ATTRIBUTE_SCALAR_ALLOWLIST: ReadonlySet<string> = new Set([
  'name',
  'brand',
  'manufacturer',
  'productType',
  'hsCode',
  'countryOfOrigin',
  'fulfillmentMethod',
  'weightValue',
  'weightUnit',
  'dimLength',
  'dimWidth',
  'dimHeight',
  'dimUnit',
])

const CATEGORY_ATTRIBUTES_PREFIX = 'categoryAttributes.'
// P1 #52 — variantAttributes path lets bulk ATTRIBUTE_UPDATE write
// per-child-row variant values (e.g., Color, Size) on Product child
// rows. Same shape as categoryAttributes but on a different JSON
// column. Use `variantAttributes.Color` etc. as the attributeName.
const VARIANT_ATTRIBUTES_PREFIX = 'variantAttributes.'

type ProductLike = {
  categoryAttributes?: unknown
  variantAttributes?: unknown
  [key: string]: unknown
}

/**
 * Read the current value of the attribute referenced by attributeName.
 * Returns kind='unsupported' for keys outside the allowlist + the
 * categoryAttributes / variantAttributes prefixes so callers can
 * surface a clear preview skip without writing.
 */
function readProductAttribute(
  product: ProductLike,
  attributeName: string,
): {
  currentValue: unknown
  kind: 'scalar' | 'categoryAttribute' | 'variantAttribute' | 'unsupported'
  /** When kind is a JSON-path variant, the inner key (after the prefix). */
  jsonKey?: string
} {
  if (ATTRIBUTE_SCALAR_ALLOWLIST.has(attributeName)) {
    return {
      currentValue: product[attributeName] ?? null,
      kind: 'scalar',
    }
  }
  if (attributeName.startsWith(CATEGORY_ATTRIBUTES_PREFIX)) {
    const jsonKey = attributeName.slice(CATEGORY_ATTRIBUTES_PREFIX.length)
    if (jsonKey.length === 0) {
      return { currentValue: null, kind: 'unsupported' }
    }
    const raw = product.categoryAttributes
    const obj =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {}
    return { currentValue: obj[jsonKey] ?? null, kind: 'categoryAttribute', jsonKey }
  }
  if (attributeName.startsWith(VARIANT_ATTRIBUTES_PREFIX)) {
    const jsonKey = attributeName.slice(VARIANT_ATTRIBUTES_PREFIX.length)
    if (jsonKey.length === 0) {
      return { currentValue: null, kind: 'unsupported' }
    }
    const raw = product.variantAttributes
    const obj =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {}
    return { currentValue: obj[jsonKey] ?? null, kind: 'variantAttribute', jsonKey }
  }
  return { currentValue: null, kind: 'unsupported' }
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

export class BulkActionService {
  private readonly masterPriceService: MasterPriceService;
  private readonly masterStatusService: MasterStatusService;

  constructor(private prisma: PrismaClient = prisma) {
    this.masterPriceService = new MasterPriceService(prisma);
    this.masterStatusService = new MasterStatusService(prisma);
  }

  /**
   * Create a new bulk action job
   * Initializes job with PENDING status and calculates total items to process
   */
  async createJob(input: CreateJobInput): Promise<BulkActionJob> {
    try {
      // Audit-fix #3 — MARKETPLACE_OVERRIDE_UPDATE writes to ChannelListing
      // rows; without `channel` the filter spans every channel (could blast
      // Shopify rows when targeting Amazon DE). Refuse the job rather than
      // letting the caller miss the constraint.
      if (
        input.actionType === 'MARKETPLACE_OVERRIDE_UPDATE' &&
        (!input.channel || input.channel.trim().length === 0)
      ) {
        throw new Error(
          'MARKETPLACE_OVERRIDE_UPDATE requires `channel` to be set (e.g. "AMAZON"). Refusing to run without a channel scope.',
        );
      }

      // Calculate total items to process
      let totalItems = 0;

      if (input.targetVariationIds?.length) {
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
        throw new Error('No items found matching the specified criteria');
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

      logger.debug(`Updating job progress`, {
        jobId,
        progressPercent,
        processedItems: input.processedItems,
        failedItems: input.failedItems,
        skippedItems: input.skippedItems
      });

      const updatedJob = await this.prisma.bulkActionJob.update({
        where: { id: jobId },
        data: {
          processedItems: input.processedItems,
          failedItems: input.failedItems,
          skippedItems: input.skippedItems,
          progressPercent,
          errorLog: input.errors && input.errors.length > 0 ? input.errors : null,
          lastError: input.errors?.[0]?.error || null,
          updatedAt: new Date()
        }
      });

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

      let processedItems = 0;
      let failedItems = 0;
      let skippedItems = 0;
      const errors: Array<{ itemId: string; error: string; timestamp: Date }> = [];

      // Process each item. For each: insert a BulkActionItem row in
      // PENDING with the beforeState snapshot, run the handler, then
      // update the row with terminal status + afterState (or
      // errorMessage on throw). The errorLog JSON on BulkActionJob
      // is still populated for backwards compat.
      const actionType = job.actionType as BulkActionType;
      const jobPayload = (job.actionPayload ?? {}) as Record<string, any>;
      for (const item of items) {
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
              afterState,
              completedAt: new Date(),
            },
          });

          if (result.status === 'processed') {
            processedItems++;
          } else if (result.status === 'skipped') {
            skippedItems++;
          }
        } catch (itemError) {
          failedItems++;
          const errorMessage = itemError instanceof Error ? itemError.message : String(itemError);
          errors.push({
            itemId: item.id,
            error: errorMessage,
            timestamp: new Date()
          });

          await this.prisma.bulkActionItem.update({
            where: { id: itemRow.id },
            data: {
              status: 'FAILED',
              errorMessage,
              completedAt: new Date(),
            },
          });

          logger.warn(`Failed to process item`, {
            jobId,
            itemId: item.id,
            error: errorMessage
          });
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

      // Final progress update
      await this.updateProgress(jobId, {
        processedItems,
        failedItems,
        skippedItems,
        errors: errors.length > 0 ? errors : undefined
      });

      // Determine final status
      let finalStatus: BulkActionStatus;
      if (failedItems === 0) {
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

      logger.info(`Job processing completed`, {
        jobId,
        status: finalStatus,
        processedItems,
        failedItems,
        skippedItems,
        totalItems: job.totalItems
      });

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
   *
   * Like processPricingUpdate / processInventoryUpdate, we pass
   * skipBullMQEnqueue=true so the cron worker drains the resulting
   * sync queue rows. Same eventual-consistency property as the
   * forward path.
   */
  async rollbackBulkActionJob(originalJobId: string): Promise<{
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
        createdBy: 'bulk-action-rollback',
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
              skipBullMQEnqueue: true,
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
                skipBullMQEnqueue: true,
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
                skipBullMQEnqueue: true,
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
  async retryFailedItems(jobId: string): Promise<BulkActionJob> {
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
      actionPayload: original.actionPayload as Record<string, any>,
      createdBy: original.createdBy ?? undefined,
    });
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
      if (filters.status === 'active') {
        where.status = { in: ['PENDING', 'QUEUED', 'IN_PROGRESS'] };
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
   * Cancel a pending job
   */
  async cancelJob(jobId: string): Promise<BulkActionJob> {
    try {
      const job = await this.prisma.bulkActionJob.findUnique({
        where: { id: jobId }
      });

      if (!job) {
        throw new Error(`Job not found: ${jobId}`);
      }

      if (job.status !== 'PENDING' && job.status !== 'QUEUED') {
        throw new Error(`Cannot cancel job with status: ${job.status}`);
      }

      logger.info(`Cancelling job`, { jobId });

      return await this.prisma.bulkActionJob.update({
        where: { id: jobId },
        data: {
          status: 'CANCELLED',
          completedAt: new Date(),
          updatedAt: new Date()
        }
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
    sampleItems: Array<{
      id: string;
      sku: string | null;
      name: string | null;
      currentValue: unknown;
      newValue: unknown;
      status: 'processed' | 'skipped';
    }>;
  }> {
    const target = ACTION_ENTITY[input.actionType];

    // ── Affected count (no DB write, no item load) ────────────────
    let affectedCount = 0;
    if (target === 'channelListing') {
      // E.5a — direct count of ChannelListing rows in scope.
      if (input.targetProductIds?.length) {
        affectedCount = await this.prisma.channelListing.count({
          where: this.buildChannelListingWhere(
            { channel: input.channel ?? null } as BulkActionJob,
            { productIds: input.targetProductIds },
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
            { productIds },
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
  ): { currentValue: unknown; newValue: unknown; status: 'processed' | 'skipped' } {
    switch (actionType) {
      case 'PRICING_UPDATE': {
        const variation = item as ProductVariation;
        const currentPrice = Number(variation.price);
        const adjustmentType = payload.adjustmentType;
        const value = Number(payload.value);
        if (Number.isNaN(value)) {
          throw new Error(
            'Invalid PRICING_UPDATE payload: numeric value required',
          );
        }
        let newPrice: number;
        switch (adjustmentType) {
          case 'ABSOLUTE':
            newPrice = value;
            break;
          case 'PERCENT':
            newPrice = currentPrice * (1 + value / 100);
            break;
          case 'DELTA':
            newPrice = currentPrice + value;
            break;
          default:
            throw new Error(
              `Invalid PRICING_UPDATE adjustmentType: ${adjustmentType}`,
            );
        }
        let status: 'processed' | 'skipped' = 'processed';
        if (newPrice < 0) status = 'skipped';
        else if (
          typeof payload.minPrice === 'number' &&
          newPrice < payload.minPrice
        )
          status = 'skipped';
        else if (
          typeof payload.maxPrice === 'number' &&
          newPrice > payload.maxPrice
        )
          status = 'skipped';
        return {
          currentValue: currentPrice.toFixed(2),
          newValue: newPrice.toFixed(2),
          status,
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
        if (job.targetProductIds && job.targetProductIds.length > 0) {
          return await this.prisma.channelListing.findMany({
            where: this.buildChannelListingWhere(job, {
              productIds: job.targetProductIds,
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
            where: this.buildChannelListingWhere(job, { productIds }),
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
          priceOverride:
            item.priceOverride != null ? Number(item.priceOverride) : null,
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
            priceOverride: true,
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
  ): Promise<{ status: 'processed' | 'skipped' }> {
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
        );
      default:
        throw new Error(`Unknown action type: ${job.actionType}`);
    }
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
   * skipBullMQEnqueue=true — bulk-action runs detached from the HTTP
   * request (fire-and-forget processJob). The post-commit
   * outboundSyncQueue.add() awaited from this context hangs indefinitely
   * (root cause TBD; tracked in TECH_DEBT #54). The DB row in
   * OutboundSyncQueue still lands; the per-minute cron worker
   * (sync.worker.ts) drains PENDING rows.
   *
   * Payload:
   *   adjustmentType: 'ABSOLUTE' | 'PERCENT' | 'DELTA'
   *   value: number              (the multiplier / delta / absolute)
   *   minPrice?: number          (skip if computed price below floor)
   *   maxPrice?: number          (skip if computed price above ceiling)
   */
  private async processPricingUpdate(
    item: Product,
    payload: Record<string, any>,
    jobId: string,
  ): Promise<{ status: 'processed' | 'skipped' }> {
    const adjustmentType = payload.adjustmentType as
      | 'ABSOLUTE'
      | 'PERCENT'
      | 'DELTA'
      | undefined;
    const rawValue = payload.value;
    const value =
      typeof rawValue === 'number' ? rawValue : Number(rawValue);
    if (!adjustmentType || Number.isNaN(value)) {
      throw new Error(
        'Invalid PRICING_UPDATE payload: adjustmentType + numeric value required',
      );
    }

    // basePrice is a Decimal column — coerce to number for math.
    const currentPrice = item.basePrice != null ? Number(item.basePrice) : 0;
    let newPrice: number;
    switch (adjustmentType) {
      case 'ABSOLUTE':
        newPrice = value;
        break;
      case 'PERCENT':
        newPrice = currentPrice * (1 + value / 100);
        break;
      case 'DELTA':
        newPrice = currentPrice + value;
        break;
    }

    // Soft constraints — skip rather than fail so the rest of the job
    // continues. Hard constraint: never write a negative price.
    if (newPrice < 0) return { status: 'skipped' };
    if (
      typeof payload.minPrice === 'number' &&
      newPrice < payload.minPrice
    ) {
      return { status: 'skipped' };
    }
    if (
      typeof payload.maxPrice === 'number' &&
      newPrice > payload.maxPrice
    ) {
      return { status: 'skipped' };
    }

    await this.masterPriceService.update(item.id, newPrice, {
      actor: 'bulk-action',
      reason: 'bulk-pricing-job',
      idempotencyKey: `${jobId}:${item.id}`,
      skipBullMQEnqueue: true,
    });

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
   * skipBullMQEnqueue=true — symmetric to processPricingUpdate. The
   * cron sync worker drains PENDING rows.
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
      skipBullMQEnqueue: true,
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
    //
    // skipBullMQEnqueue mirrors the pricing/inventory paths — the
    // detached bulk-action context has hit a Queue.add() hang
    // (TECH_DEBT #54), so we let the per-minute cron drain the
    // PENDING rows. Workaround until #54 lands.
    await this.masterStatusService.update(productId, newStatus, {
      actor: 'bulk-action',
      reason: `bulk-job:${jobId}`,
      skipBullMQEnqueue: true,
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
      const raw = (item as ProductLike).variantAttributes
      const current =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {}
      const merged = { ...current, [jsonKey!]: newValue }
      await this.prisma.product.update({
        where: { id: item.id },
        data: { variantAttributes: merged as any },
      })
    }

    // Enqueue per-ChannelListing OutboundSyncQueue rows so the cron
    // worker pushes the new attribute to live channels. Same pattern
    // PRICING_UPDATE uses via MasterPriceService.
    const listings = await this.prisma.channelListing.findMany({
      where: { productId: item.id },
      select: { id: true, channel: true, marketplace: true },
    })
    if (listings.length > 0) {
      await this.prisma.outboundSyncQueue.createMany({
        data: listings.map((l) => ({
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
      })
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
    await this.prisma.outboundSyncQueue.createMany({
      data: listings.map((l) => ({
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
    })
    return { status: 'processed' }
  }

  /**
   * E.5a — MARKETPLACE_OVERRIDE_UPDATE — write per-marketplace overrides
   * directly on a ChannelListing row. Lets the seller, in one bulk pass,
   * adjust 200 listings on Amazon DE without touching their IT counterparts.
   *
   * Payload (one or more keys; missing keys are no-ops):
   *   priceOverride?: number | null    — overrides master price; null clears
   *   quantityOverride?: number | null — overrides master quantity; null clears
   *   stockBuffer?: number             — overselling-protection units
   *   followMasterTitle?: boolean      — when false, keep titleOverride
   *   followMasterDescription?: boolean
   *   followMasterPrice?: boolean
   *   followMasterQuantity?: boolean
   *   followMasterImages?: boolean
   *   followMasterBulletPoints?: boolean
   *   isPublished?: boolean            — master toggle for marketplace push
   *   pricingRule?: 'FIXED' | 'MATCH_AMAZON' | 'PERCENT_OF_MASTER'
   *   priceAdjustmentPercent?: number  — paired with PERCENT_OF_MASTER rule
   */
  private async processMarketplaceOverrideUpdate(
    item: ChannelListing,
    payload: Record<string, any>,
  ): Promise<{ status: 'processed' | 'skipped' }> {
    const data: Prisma.ChannelListingUpdateInput = {}
    let touched = false

    const numOrNull = (v: unknown): number | null | undefined => {
      if (v === null) return null
      if (typeof v === 'number' && !Number.isNaN(v)) return v
      if (typeof v === 'string' && v.length > 0 && !Number.isNaN(Number(v))) {
        return Number(v)
      }
      return undefined
    }

    if ('priceOverride' in payload) {
      const v = numOrNull(payload.priceOverride)
      if (v !== undefined) {
        data.priceOverride = v === null ? null : v.toFixed(2)
        touched = true
      }
    }
    if ('quantityOverride' in payload) {
      const v = numOrNull(payload.quantityOverride)
      if (v !== undefined) {
        data.quantityOverride = v === null ? null : Math.max(0, Math.floor(v))
        touched = true
      }
    }
    if (typeof payload.stockBuffer === 'number') {
      data.stockBuffer = Math.max(0, Math.floor(payload.stockBuffer))
      touched = true
    }

    const followKeys = [
      'followMasterTitle',
      'followMasterDescription',
      'followMasterPrice',
      'followMasterQuantity',
      'followMasterImages',
      'followMasterBulletPoints',
    ] as const
    for (const k of followKeys) {
      if (typeof payload[k] === 'boolean') {
        ;(data as any)[k] = payload[k]
        touched = true
      }
    }

    if (typeof payload.isPublished === 'boolean') {
      data.isPublished = payload.isPublished
      touched = true
    }

    const VALID_RULES = ['FIXED', 'MATCH_AMAZON', 'PERCENT_OF_MASTER'] as const
    if (
      typeof payload.pricingRule === 'string' &&
      (VALID_RULES as readonly string[]).includes(payload.pricingRule)
    ) {
      data.pricingRule = payload.pricingRule as Prisma.ChannelListingUpdateInput['pricingRule']
      touched = true
    }
    if (typeof payload.priceAdjustmentPercent === 'number') {
      data.priceAdjustmentPercent = payload.priceAdjustmentPercent.toFixed(2)
      touched = true
    }

    if (!touched) {
      throw new Error(
        'Invalid MARKETPLACE_OVERRIDE_UPDATE payload: at least one override field required',
      )
    }

    // Bump audit-trail timestamp for any non-trivial write.
    data.lastOverrideAt = new Date()

    await this.prisma.channelListing.update({
      where: { id: item.id },
      data,
    })

    return { status: 'processed' }
  }

  /**
   * Sync price to marketplace
   * Handles rate limiting and retries
   */
  private async syncPriceToMarketplace(
    sku: string,
    price: any,
    channel: string
  ): Promise<void> {
    try {
      const provider = this.getMarketplaceProvider(channel);
      if (!provider) {
        logger.warn(`No provider configured for channel: ${channel}`);
        return;
      }

      const response = await provider.updatePrice({
        sku,
        price: typeof price === 'number' ? price : parseFloat(String(price)),
      });

      if (!response.success) {
        if (response.retryable) {
          logger.warn(`Retryable error syncing price to ${channel}`, {
            sku,
            error: response.error,
          });
        } else {
          logger.error(`Failed to sync price to ${channel}`, {
            sku,
            error: response.error,
          });
        }
      } else {
        logger.info(`Price synced to ${channel}`, { sku, price });
      }
    } catch (error) {
      logger.error(`Error syncing price to marketplace`, {
        sku,
        channel,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Sync stock to marketplace
   * Handles rate limiting and retries
   */
  private async syncStockToMarketplace(
    sku: string,
    quantity: number,
    channel: string
  ): Promise<void> {
    try {
      const provider = this.getMarketplaceProvider(channel);
      if (!provider) {
        logger.warn(`No provider configured for channel: ${channel}`);
        return;
      }

      const response = await provider.updateStock({
        sku,
        quantity,
      });

      if (!response.success) {
        if (response.retryable) {
          logger.warn(`Retryable error syncing stock to ${channel}`, {
            sku,
            error: response.error,
          });
        } else {
          logger.error(`Failed to sync stock to ${channel}`, {
            sku,
            error: response.error,
          });
        }
      } else {
        logger.info(`Stock synced to ${channel}`, { sku, quantity });
      }
    } catch (error) {
      logger.error(`Error syncing stock to marketplace`, {
        sku,
        channel,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Sync complete listing to marketplace
   */
  private async syncListingToMarketplace(
    item: any,
    channel: string
  ): Promise<void> {
    try {
      const provider = this.getMarketplaceProvider(channel);
      if (!provider) {
        logger.warn(`No provider configured for channel: ${channel}`);
        return;
      }

      const response = await provider.syncListing({
        sku: item.sku,
        title: item.name || '',
        description: item.description || '',
        price: typeof item.price === 'number' ? item.price : parseFloat(String(item.price)),
        quantity: item.stock || 0,
        imageUrls: item.imageUrl ? [item.imageUrl] : [],
        attributes: item.marketplaceMetadata || {},
      });

      if (!response.success) {
        if (response.retryable) {
          logger.warn(`Retryable error syncing listing to ${channel}`, {
            sku: item.sku,
            error: response.error,
          });
        } else {
          logger.error(`Failed to sync listing to ${channel}`, {
            sku: item.sku,
            error: response.error,
          });
        }
      } else {
        logger.info(`Listing synced to ${channel}`, { sku: item.sku });
      }
    } catch (error) {
      logger.error(`Error syncing listing to marketplace`, {
        sku: item.sku,
        channel,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get marketplace provider by channel
   */
  private getMarketplaceProvider(channel: string): MarketplaceProvider | null {
    switch (channel?.toLowerCase()) {
      case 'amazon':
        return amazonProvider.isConfigured() ? amazonProvider : null;
      case 'ebay':
        return ebayProvider.isConfigured() ? ebayProvider : null;
      default:
        return null;
    }
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
