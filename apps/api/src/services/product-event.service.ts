/**
 * ES.2 — Append-only product event emitter.
 *
 * Two call modes:
 *   emitTx / emitManyTx — write inside an existing Prisma transaction
 *     (preferred: event is atomic with the mutation it describes).
 *   emit / emitMany — fire-and-forget outside a transaction, fail-open
 *     (use when the caller has no tx or it's already committed).
 *
 * Rules:
 *   • Never UPDATE or DELETE ProductEvent rows.
 *   • Pass only changed fields in `data`, not full snapshots.
 *   • Always set metadata.source so the Timeline UI can group/filter.
 */

import prisma from '../db.js'
import type { Prisma } from '@prisma/client'
import { readCacheQueue } from '../lib/queue.js'

// ── Types ────────────────────────────────────────────────────────────

export type EventSource =
  | 'OPERATOR'
  | 'API'
  | 'WEBHOOK'
  | 'AUTOMATION'
  | 'AI'
  | 'FLAT_FILE_IMPORT'
  | 'SYSTEM'

export type ProductEventType =
  | 'PRODUCT_CREATED'
  | 'PRODUCT_UPDATED'
  | 'PRODUCT_DELETED'
  | 'PRICE_CHANGED'
  | 'STOCK_ADJUSTED'
  | 'TITLE_UPDATED'
  | 'BULLETS_UPDATED'
  | 'DESCRIPTION_UPDATED'
  | 'IMAGES_UPDATED'
  | 'CHANNEL_LISTING_CREATED'
  | 'CHANNEL_LISTING_UPDATED'
  | 'CHANNEL_LISTING_PUBLISHED'
  | 'CHANNEL_LISTING_SUPPRESSED'
  | 'SYNC_QUEUED'
  | 'SYNC_SUCCEEDED'
  | 'SYNC_FAILED'
  | 'BULK_OP_APPLIED'
  | 'AUTOMATION_RULE_FIRED'
  | 'AI_CONTENT_GENERATED'
  | 'AI_CONTENT_APPROVED'
  | 'WORKFLOW_STAGE_CHANGED'
  | 'FLAT_FILE_IMPORTED'

export interface EventMetadata {
  userId?: string | null
  ip?: string | null
  source: EventSource
  // Flat-file context (populated when source = FLAT_FILE_IMPORT)
  fileName?: string
  flatFileType?: string // "AMAZON_INVENTORY_LOADER" | "EBAY_FLAT_FILE" | ...
  rowIndex?: number
  importJobId?: string
  // Batch context
  bulkOperationId?: string
  automationRuleId?: string
  [key: string]: unknown
}

export interface ProductEventInput {
  aggregateId: string
  aggregateType: 'Product' | 'ChannelListing' | 'StockLevel' | 'Order'
  eventType: ProductEventType
  data?: unknown
  metadata?: EventMetadata
}

// Prisma interactive-transaction client type
type TxClient = Omit<
  typeof prisma,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>

// ── Service ──────────────────────────────────────────────────────────

export class ProductEventService {
  /** Enqueue a debounced cache refresh for a product aggregate. */
  private enqueueRefresh(input: ProductEventInput): void {
    if (input.aggregateType !== 'Product') return
    // jobId deduplication: if a refresh job already exists for this
    // product, BullMQ silently drops the duplicate. The 2s delay
    // batches rapid successive mutations (e.g. a flat-file row saving
    // title + price + qty in quick succession) into one rebuild.
    void readCacheQueue
      .add(
        'refresh',
        { productId: input.aggregateId },
        { jobId: `cache:refresh:${input.aggregateId}`, delay: 2000 },
      )
      .catch((err) =>
        console.warn(
          '[ProductEvent] readCacheQueue.add failed:',
          err instanceof Error ? err.message : String(err),
        ),
      )
  }

  /** Emit one event inside an existing Prisma transaction (atomic). */
  async emitTx(tx: TxClient, input: ProductEventInput): Promise<void> {
    await tx.productEvent.create({
      data: {
        aggregateId: input.aggregateId,
        aggregateType: input.aggregateType,
        eventType: input.eventType,
        data: input.data != null ? (input.data as Prisma.InputJsonValue) : undefined,
        metadata: input.metadata != null ? (input.metadata as Prisma.InputJsonValue) : undefined,
      },
    })
  }

  /** Emit N events inside an existing transaction (flat-file batches). */
  async emitManyTx(tx: TxClient, inputs: ProductEventInput[]): Promise<void> {
    if (inputs.length === 0) return
    await tx.productEvent.createMany({
      data: inputs.map((i) => ({
        aggregateId: i.aggregateId,
        aggregateType: i.aggregateType,
        eventType: i.eventType,
        data: i.data != null ? (i.data as Prisma.InputJsonValue) : undefined,
        metadata: i.metadata != null ? (i.metadata as Prisma.InputJsonValue) : undefined,
      })),
    })
  }

  /** Fire-and-forget emit outside a transaction. Fail-open: never throws. */
  async emit(input: ProductEventInput): Promise<void> {
    try {
      await prisma.productEvent.create({
        data: {
          aggregateId: input.aggregateId,
          aggregateType: input.aggregateType,
          eventType: input.eventType,
          data: input.data != null ? (input.data as Prisma.InputJsonValue) : undefined,
          metadata: input.metadata != null ? (input.metadata as Prisma.InputJsonValue) : undefined,
        },
      })
      this.enqueueRefresh(input)
    } catch (err) {
      // NEVER throw — event logging must not poison the underlying write.
      console.warn(
        '[ProductEvent] emit failed:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  /** Bulk fire-and-forget for hot paths (one round trip). Fail-open. */
  async emitMany(inputs: ProductEventInput[]): Promise<void> {
    if (inputs.length === 0) return
    try {
      await prisma.productEvent.createMany({
        data: inputs.map((i) => ({
          aggregateId: i.aggregateId,
          aggregateType: i.aggregateType,
          eventType: i.eventType,
          data: i.data != null ? (i.data as Prisma.InputJsonValue) : undefined,
          metadata: i.metadata != null ? (i.metadata as Prisma.InputJsonValue) : undefined,
        })),
      })
      // Enqueue one debounced refresh per distinct product aggregate.
      const seen = new Set<string>()
      for (const i of inputs) {
        if (i.aggregateType === 'Product' && !seen.has(i.aggregateId)) {
          seen.add(i.aggregateId)
          this.enqueueRefresh(i)
        }
      }
    } catch (err) {
      console.warn(
        '[ProductEvent] emitMany failed:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }
}

export const productEventService = new ProductEventService()
