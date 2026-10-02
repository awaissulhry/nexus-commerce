/** Shared content writes cascade only to following listings carrying that language.
 * Language-specific follow markers mask legacy snapshots without rewriting them.
 * The caller's transaction owns values, versions, audit and outbound queue rows.
 */

import { createOutboundRow } from './outbound-rows.js'
import { produceReadiness } from './pim/readiness-index.service.js'
import { recordContentWrite } from './pim/content-version-receipt-capture.js'
import type { PrismaClient } from '@prisma/client'
import { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { contentAddress, type ContentAddress } from '@nexus/shared/content-language'
import { CONTENT_COLUMNS, PRIMARY_CONTENT_LOCALE } from './pim/content-locale.js'
import { normalizeLanguage } from './pim/content-language.js'
import { contentField, listingFollowsContent, resolveContent } from './pim/content-resolver.js'
import { marketLanguages } from './pim/market-languages.js'
import { isStillDraftListing } from '@nexus/shared/push-lock'

const DEFAULT_HOLD_MS = 30 * 1000
const CONTENT_CHANNELS = new Set(['AMAZON', 'EBAY', 'SHOPIFY']) // B3 — Shopify content push live (title + body_html)

export interface MasterContentChanges {
  [field: string]: unknown
  /** Product.name (the master title). */
  title?: string | null
  description?: string | null
  bulletPoints?: string[]
}

export interface MasterContentUpdateContext {
  address?: ContentAddress
  reviewed?: boolean
  locale?: string
  actor?: string | null
  reason?: string
  idempotencyKey?: string
  applyGrace?: boolean
  /**
   * PSIE (the Owner's D1 (a), 2026-09-26) — `false` = cascade the values but queue NO channel update: the product
   * sheet's import saves Nexus only, and sending is its own step. Default: queue, exactly as before.
   */
  queueOutbound?: boolean
  tx?: Prisma.TransactionClient
  /**
   * The caller already wrote the master content (e.g. PATCH /products/bulk writes
   * Product.name/description/bulletPoints in its own transaction, then calls us
   * only to fan out). Skip the master write + the diff-vs-current no-op check and
   * cascade exactly the provided fields.
   */
  masterAlreadyWritten?: boolean
  /** Source values captured by the authoring boundary before its mutation. */
  previousValues?: Record<string, unknown>
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
  channelConnectionId: string | null
  aliasKey: string
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

  async update(productId: string, changes: MasterContentChanges, ctx: MasterContentUpdateContext = {}): Promise<MasterContentUpdateResult> {
    const address = contentAddress(ctx.address, Object.keys(changes)[0] ?? 'Content')
    const language = address.tier === 'source' ? PRIMARY_CONTENT_LOCALE : normalizeLanguage(address.language)
    if (address.tier === 'pin' || ctx.locale && normalizeLanguage(ctx.locale) !== language) throw Object.assign(new Error('Content cascade needs the shared language address.'), { statusCode: 400 })
    if (!ctx.masterAlreadyWritten) {
      const { writeContent } = await import('./pim/content-write.js')
      await writeContent({ productId, address, values: changes, userId: ctx.actor, label: Object.keys(changes)[0] ?? 'Content' })
      return { changed: true, changedFields: Object.keys(changes), cascadedListingIds: [], snapshottedListingIds: [], queuedSyncIds: [], auditLogId: null }
    }
    const runner = async (tx: Prisma.TransactionClient | PrismaClient): Promise<MasterContentUpdateResult> => {
      const fields = Object.keys(changes).map(contentField)
      const product = await tx.product.findUniqueOrThrow({ where: { id: productId }, include: { translations: true } })
      const [listings, markets] = await Promise.all([
        tx.channelListing.findMany({ where: { product: { OR: [{ id: productId }, { parentId: productId }] } }, include: { translations: true, product: { include: { translations: true } } } }),
        tx.marketplace.findMany({ select: { channel: true, code: true, languages: true, language: true } }),
      ])
      const cascadedListingIds: string[] = [], snapshottedListingIds: string[] = [], queuedSyncIds: string[] = []
      for (const listing of listings) {
        const market = !listing.marketplace || listing.marketplace === 'DEFAULT' ? listing.region : listing.marketplace
        if (!marketLanguages(listing.channel, market, markets).includes(language)) continue
        const pin = listing.translations.find(row => row.language === language)
        const following = fields.filter(field => {
          if (listing.productId !== productId) {
            const inherited = resolveContent({ product: listing.product as any, parent: product as any, field, localizableKeys: fields, address: { requested: language } })
            if (inherited.ownerId !== productId) return false
          }
          return listingFollowsContent(listing, field, language, marketLanguages(listing.channel, market, markets))
        })
        if (!following.length) { snapshottedListingIds.push(listing.id); continue }
        // Language-specific following intent masks stale legacy snapshots. Never
        // write an untagged title/description or turn an operator pin into shared text.
        const follows = [...new Set([...(pin?.follows ?? []), ...following])]
        if (pin) await tx.channelListingTranslation.update({ where: { id: pin.id }, data: { follows, version: { increment: 1 } } })
        else await tx.channelListingTranslation.create({ data: { channelListingId: listing.id, language, follows, version: 1 } })
        // The existing content sync queue consumes a language-qualified payload.
        // Caller transactions leave scheduling to the drain after commit.
        // A paused listing (an operator's pause, or an inert draft) follows the text but is not
        // queued, as in the stock cascade: the push lock refused its row at dispatch anyway. A
        // still-draft (never published, no channel id) is held the same way even when it is not
        // paused: only Publish sends it, and it sends the text it follows.
        const queues = CONTENT_CHANNELS.has(listing.channel) && ctx.reviewed !== false && ctx.queueOutbound !== false && !listing.syncPaused && !isStillDraftListing(listing)
        // MCP full control T1 — "Pending" only when a row is queued below. A Nexus-only write (queueOutbound false), a
        // paused or still-draft listing, or a draft write queue nothing, and the listing must not read as waiting to send.
        await tx.channelListing.update({ where: { id: listing.id }, data: { version: { increment: 1 }, ...(queues ? { lastSyncStatus: 'PENDING', lastSyncedAt: null } : {}) } })
        // Qualified receipts: this following listing's own content row moved, from the pair read above.
        recordContentWrite({ tier: 'pin', productId: listing.productId, listingId: listing.id, language }, { ownerVersion: listing.version, contentVersion: pin?.version ?? 0 })
        cascadedListingIds.push(listing.id)
        if (queues) {
          const payload = Object.fromEntries(following.map(field => [field, resolveContent({ product: listing.product as any, parent: listing.productId === productId ? undefined : product as any, field, localizableKeys: fields, address: { requested: language } }).value]))
          const queue = await createOutboundRow(tx, { data: { productId: listing.productId, channelListingId: listing.id, channelConnectionId: listing.channelConnectionId, targetChannel: listing.channel as any,
            targetRegion: listing.region, externalListingId: listing.externalListingId, syncStatus: 'PENDING', syncType: 'CONTENT_UPDATE',
            holdUntil: ctx.applyGrace === false ? null : new Date(Date.now() + DEFAULT_HOLD_MS), payload: { source: 'MASTER_CONTENT_CHANGE', productId: listing.productId, productSku: listing.product.sku,
              channel: listing.channel, marketplace: market, channelConnectionId: listing.channelConnectionId, aliasKey: listing.aliasKey,
              locale: language, language, ...payload } as Prisma.InputJsonValue }, select: { id: true } })
          queuedSyncIds.push(queue.id)
        }
      }
      const audit = await tx.auditLog.create({ data: { entityType: 'Product', entityId: productId, action: 'update', userId: ctx.actor ?? null,
        before: (ctx.previousValues ?? {}) as Prisma.InputJsonValue, after: changes as Prisma.InputJsonValue,
        metadata: { fields, language, contentTier: address.tier, layer: address.tier === 'source' ? 'master' : 'language-cascade', reason: ctx.reason ?? null, cascadedListingIds, queuedSyncIds } }, select: { id: true } })
      await produceReadiness(productId)
      return { changed: fields.length > 0, changedFields: fields, cascadedListingIds, snapshottedListingIds, queuedSyncIds, auditLogId: audit.id }
    }
    return ctx.tx ? runner(ctx.tx) : this.client.$transaction(runner)
  }
}

export const masterContentService = new MasterContentService()
