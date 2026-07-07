/**
 * MasterContentService — A4. The companion to MasterPriceService for master
 * CONTENT fields (Product.name=title, description, bulletPoints). The headline
 * feature ("edit master → propagate to channels") was wired through dead code
 * (outbound-sync-phase9.detectAndQueueChanges, never called), so only price +
 * status reached channels; title/description/bullets never did. This closes that
 * gap with the same proven pattern: one transactional cascade that snapshots the
 * master onto each ChannelListing, enqueues an OutboundSyncQueue CONTENT_UPDATE
 * for every listing that follows master, audits, and (post-commit) adds the
 * BullMQ job. The now-correct consumer (buildAmazonListingPatch, A4.0; eBay
 * mergeEbayInventoryItem, Phase 0.1) pushes the values to the marketplace.
 *
 * Cascade per ChannelListing × field:
 *   followMaster<field>=true  → snapshot master<field> + enqueue a push of the
 *                               new value (effective value = master).
 *   followMaster<field>=false → snapshot master<field> only (drift baseline);
 *                               the listing keeps its override, no push.
 *
 * quantity is already propagated via stock-movement (QUANTITY_UPDATE); images via
 * their own cascade. CONTENT_UPDATE is enqueued for content-capable channels —
 * Amazon, eBay, and (B3) Shopify (title → product.title, description → body_html).
 */

import type { PrismaClient } from '@prisma/client'
import { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { outboundSyncQueue, addJobSafely } from '../lib/queue.js'
import { logger } from '../utils/logger.js'

const DEFAULT_HOLD_MS = 30 * 1000
const CONTENT_CHANNELS = new Set(['AMAZON', 'EBAY', 'SHOPIFY']) // B3 — Shopify content push live (title + body_html)

export interface MasterContentChanges {
  /** Product.name (the master title). */
  title?: string | null
  description?: string | null
  bulletPoints?: string[]
}

export interface MasterContentUpdateContext {
  actor?: string | null
  reason?: string
  idempotencyKey?: string
  applyGrace?: boolean
  tx?: Prisma.TransactionClient
  /**
   * The caller already wrote the master content (e.g. PATCH /products/bulk writes
   * Product.name/description/bulletPoints in its own transaction, then calls us
   * only to fan out). Skip the master write + the diff-vs-current no-op check and
   * cascade exactly the provided fields.
   */
  masterAlreadyWritten?: boolean
}

export interface MasterContentUpdateResult {
  changed: boolean
  changedFields: string[]
  cascadedListingIds: string[]
  snapshottedListingIds: string[]
  queuedSyncIds: string[]
  auditLogId: string | null
}

interface ListingForContentCascade {
  id: string
  channel: string
  region: string
  marketplace: string
  externalListingId: string | null
  platformAttributes: Prisma.JsonValue | null
  followMasterTitle: boolean
  followMasterDescription: boolean
  followMasterBulletPoints: boolean
}

const arraysEqual = (a: string[] | null | undefined, b: string[] | null | undefined): boolean => {
  const x = a ?? []
  const y = b ?? []
  return x.length === y.length && x.every((v, i) => v === y[i])
}

/**
 * Pure per-listing resolution: which master snapshots to write, and which values
 * to push (only fields this listing follows). No side effects — unit-testable.
 */
export function resolveContentCascade(
  changed: { title: boolean; description: boolean; bulletPoints: boolean },
  values: MasterContentChanges,
  listing: Pick<ListingForContentCascade, 'followMasterTitle' | 'followMasterDescription' | 'followMasterBulletPoints'>,
): { snapshot: Record<string, any>; push: Record<string, any> } {
  const snapshot: Record<string, any> = {}
  const push: Record<string, any> = {}
  if (changed.title) {
    snapshot.masterTitle = values.title ?? null
    if (listing.followMasterTitle) push.title = values.title ?? ''
  }
  if (changed.description) {
    snapshot.masterDescription = values.description ?? null
    if (listing.followMasterDescription) push.description = values.description ?? ''
  }
  if (changed.bulletPoints) {
    snapshot.masterBulletPoints = values.bulletPoints ?? []
    if (listing.followMasterBulletPoints) push.bulletPoints = values.bulletPoints ?? []
  }
  return { snapshot, push }
}

export class MasterContentService {
  constructor(private readonly client: PrismaClient = prisma) {}

  async update(
    productId: string,
    changes: MasterContentChanges,
    ctx: MasterContentUpdateContext = {},
  ): Promise<MasterContentUpdateResult> {
    const holdUntil = ctx.applyGrace === false ? null : new Date(Date.now() + DEFAULT_HOLD_MS)

    const runner = async (tx: Prisma.TransactionClient | PrismaClient): Promise<MasterContentUpdateResult> => {
      const product = await tx.product.findUnique({
        where: { id: productId },
        select: { id: true, sku: true, name: true, description: true, bulletPoints: true },
      })
      if (!product) throw new Error(`MasterContentService.update: product ${productId} not found`)

      // Which fields to cascade. masterAlreadyWritten → cascade exactly the
      // provided fields; otherwise diff vs the current master and skip no-ops.
      const already = ctx.masterAlreadyWritten === true
      const changed = {
        title: already ? changes.title !== undefined : (changes.title !== undefined && changes.title !== product.name),
        description: already ? changes.description !== undefined : (changes.description !== undefined && (changes.description ?? null) !== (product.description ?? null)),
        bulletPoints: already ? changes.bulletPoints !== undefined : (changes.bulletPoints !== undefined && !arraysEqual(changes.bulletPoints, product.bulletPoints)),
      }
      const changedFields = Object.entries(changed).filter(([, v]) => v).map(([k]) => k)
      if (changedFields.length === 0) {
        return { changed: false, changedFields: [], cascadedListingIds: [], snapshottedListingIds: [], queuedSyncIds: [], auditLogId: null }
      }

      const after: Record<string, any> = {}
      if (changed.title) after.name = changes.title
      if (changed.description) after.description = changes.description
      if (changed.bulletPoints) after.bulletPoints = changes.bulletPoints

      const before: Record<string, any> = {}
      if (!already) {
        if (changed.title) before.name = product.name
        if (changed.description) before.description = product.description
        if (changed.bulletPoints) before.bulletPoints = product.bulletPoints
        await tx.product.update({ where: { id: productId }, data: after })
      }

      const listings = (await tx.channelListing.findMany({
        where: { productId },
        select: {
          id: true, channel: true, region: true, marketplace: true, externalListingId: true,
          platformAttributes: true,
          followMasterTitle: true, followMasterDescription: true, followMasterBulletPoints: true,
        },
      })) as unknown as ListingForContentCascade[]

      const cascadedListingIds: string[] = []
      const snapshottedListingIds: string[] = []
      const queueRows: Prisma.OutboundSyncQueueCreateManyInput[] = []

      for (const listing of listings) {
        const { snapshot, push } = resolveContentCascade(changed, changes, listing)
        const pushable = Object.keys(push).length > 0 && CONTENT_CHANNELS.has(listing.channel)

        await tx.channelListing.update({
          where: { id: listing.id },
          data: pushable
            ? { ...snapshot, lastSyncStatus: 'PENDING', lastSyncedAt: null, version: { increment: 1 } }
            : snapshot,
        })

        if (pushable) {
          cascadedListingIds.push(listing.id)
          queueRows.push({
            productId,
            channelListingId: listing.id,
            targetChannel: listing.channel as any,
            targetRegion: listing.region,
            syncStatus: 'PENDING' as any,
            syncType: 'CONTENT_UPDATE',
            holdUntil,
            externalListingId: listing.externalListingId,
            payload: {
              source: 'MASTER_CONTENT_CHANGE',
              productId,
              productSku: product.sku,
              channel: listing.channel,
              marketplace: listing.marketplace,
              productType: (listing.platformAttributes as any)?.productType ?? null,
              ...push,
              reason: ctx.reason ?? null,
              idempotencyKey: ctx.idempotencyKey ?? null,
            } as Prisma.InputJsonValue,
          })
        } else {
          snapshottedListingIds.push(listing.id)
        }
      }

      let queuedSyncIds: string[] = []
      if (queueRows.length > 0) {
        await tx.outboundSyncQueue.createMany({ data: queueRows })
        const justEnqueued = await tx.outboundSyncQueue.findMany({
          where: { channelListingId: { in: cascadedListingIds }, syncType: 'CONTENT_UPDATE', syncStatus: 'PENDING' },
          orderBy: { createdAt: 'desc' },
          take: cascadedListingIds.length,
          select: { id: true },
        })
        queuedSyncIds = justEnqueued.map((r) => r.id)
      }

      const audit = await tx.auditLog.create({
        data: {
          entityType: 'Product',
          entityId: productId,
          action: 'update',
          userId: ctx.actor ?? null,
          before,
          after,
          metadata: {
            fields: changedFields,
            reason: ctx.reason ?? null,
            idempotencyKey: ctx.idempotencyKey ?? null,
            cascadedListingIds,
            snapshottedListingIds,
            queuedSyncIds,
          },
          createdAt: new Date(),
        },
        select: { id: true },
      })

      return { changed: true, changedFields, cascadedListingIds, snapshottedListingIds, queuedSyncIds, auditLogId: audit.id }
    }

    const result = ctx.tx ? await runner(ctx.tx) : await this.client.$transaction(runner)

    // Post-commit BullMQ enqueue (jobId=queueId dedup). If Redis is down the DB
    // rows stay PENDING for the next drain — never lose work. Skipped when inside
    // a caller transaction (not yet committed); the cron drains after commit.
    if (!ctx.tx && result.queuedSyncIds.length > 0) {
      const delay = ctx.applyGrace === false ? 0 : DEFAULT_HOLD_MS
      for (const queueId of result.queuedSyncIds) {
        // Bounded + circuit-broken: unreachable Redis can't hang the request.
        await addJobSafely(outboundSyncQueue, 'sync-job', { queueId, productId, syncType: 'CONTENT_UPDATE', source: 'MASTER_CONTENT_CHANGE' }, { delay, jobId: queueId })
      }
    }

    if (result.changed) {
      logger.info('MasterContentService.update', {
        productId, fields: result.changedFields,
        cascaded: result.cascadedListingIds.length, snapshotted: result.snapshottedListingIds.length, queued: result.queuedSyncIds.length,
        actor: ctx.actor ?? null, reason: ctx.reason ?? null,
      })
    }
    return result
  }
}

export const masterContentService = new MasterContentService()
