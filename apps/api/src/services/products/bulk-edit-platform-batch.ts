import type { ChannelListing } from '@prisma/client'
import prisma from '../../db.js'
import { afterDatabaseCommitBatch } from '../../lib/database-context.js'
import { applyPlatformMutations, type ChannelValueMutation } from '../pim/channel-value-mutation.js'
import { produceReadinessForProducts } from '../pim/readiness-index.service.js'
import { productReadCacheService } from '../product-read-cache.service.js'
import { writeBulkEditReceipts, type BulkReceiptChange } from './bulk-edit-receipts.js'
import type { ProductBulkChangeError, ProductBulkChangeWarning, ProductBulkContext, ProductBulkInput } from './bulk-edit.service.js'
import type { BulkSaveUnit, BulkSaveUnitResult } from './bulk-save.service.js'

/** Internal signal: roll the tentative batch back and use each unit's canonical row path. */
export class UnsupportedPlatformBatch extends Error {}

export interface PlatformBulkPlan {
  changes: Array<BulkReceiptChange & { cascade: boolean; reset?: boolean }>
  errors: ProductBulkChangeError[]
  warnings: ProductBulkChangeWarning[]
  normalizedChanges: Array<{ id: string; field: string; value: unknown }>
  noOpKeys: Set<string>
  listings: Map<string, Pick<ChannelListing, 'id' | 'version' | 'updatedAt' | 'platformAttributes'>>
  mutations: Map<string, ChannelValueMutation[]>
  coordinate: NonNullable<ProductBulkInput['marketplaceContexts']>[number]
  accountId: string | null
}

/** Eligibility only. The row writer still owns every value, reference, scope and editability check. */
export function platformBatchGroup(units: BulkSaveUnit[], start: number): BulkSaveUnit[] {
  const group: BulkSaveUnit[] = []
  const owners = new Set<string>()
  let coordinate: string | undefined
  let cells = 0
  for (const unit of units.slice(start)) {
    const contexts = unit.marketplaceContexts?.length ? unit.marketplaceContexts : unit.marketplaceContext ? [unit.marketplaceContext] : []
    const id = unit.changes[0]?.id
    // Token 0 means create-only, even if a legacy existing listing itself still has version 0.
    if (unit.dryRun || !Number.isInteger(unit.expectedVersion) || unit.expectedVersion! < 1 || contexts.length !== 1 || typeof id !== 'string' || !id || owners.has(id) ||
      unit.changes.some(change => !change || change.id !== id || change.target !== 'channel' || typeof change.field !== 'string' || !change.field.startsWith('attr_') || change.field.includes('[') || change.cascade)) break
    const key = JSON.stringify(contexts[0])
    if (coordinate !== undefined && coordinate !== key || cells + unit.changes.length > 1000) break
    coordinate = key; cells += unit.changes.length; owners.add(id); group.push(unit)
  }
  return group.length > 1 ? group : []
}

/** Persist only plans produced by the canonical validator. All original owner tokens are guarded in the one UPDATE. */
export async function writePlatformBatch(units: BulkSaveUnit[], plan: PlatformBulkPlan, context: ProductBulkContext): Promise<BulkSaveUnitResult[]> {
  const started = Date.now()
  const prepared = units.map(unit => {
    const id = unit.changes[0].id
    return { unit, id, changes: plan.changes.filter(change => change.id === id), errors: plan.errors.filter(error => error.id === id),
      warnings: plan.warnings.filter(warning => warning.id === id), normalizedChanges: plan.normalizedChanges.filter(change => change.id === id),
      unchanged: [...new Set(unit.changes.map(change => `${id}:${change.field}`))].filter(key => plan.noOpKeys.has(key)).length, listing: plan.listings.get(id) }
  })
  const changed = prepared.filter(row => row.changes.length)
  const patches = changed.map(row => {
    if (!row.listing) throw new UnsupportedPlatformBatch('A missing listing needs the draft writer.')
    const mutations = plan.mutations.get(row.id) ?? []
    return { id: row.listing.id, version: row.unit.expectedVersion, updatedAt: row.listing.updatedAt,
      bag: applyPlatformMutations(row.listing.platformAttributes, mutations.flatMap(mutation => mutation.platform)),
      remove: mutations.flatMap(mutation => mutation.overrideRemove) }
  }).sort((a, b) => a.id.localeCompare(b.id))
  const written = patches.length ? await prisma.$queryRaw<Array<{ id: string; version: number }>>`
    UPDATE "ChannelListing" AS listing
    SET "platformAttributes" = patch.bag,
        "overrideData" = COALESCE(listing."overrideData", '{}'::jsonb) - patch.remove,
        "version" = listing."version" + 1, "updatedAt" = now()
    FROM jsonb_to_recordset(${JSON.stringify(patches)}::jsonb)
      AS patch(id text, version integer, "updatedAt" timestamp, bag jsonb, remove text[])
    WHERE listing.id = patch.id AND listing.version = patch.version
      AND listing."updatedAt" = patch."updatedAt"
    RETURNING listing.id, listing.version
  ` : []
  // A partial match is undone before the row path identifies each stale owner with its exact current-version receipt.
  if (written.length !== patches.length) throw new UnsupportedPlatformBatch('An original listing token no longer matches.')
  const versions = new Map(written.map(row => [row.id, row.version]))
  const operations = changed.length ? await prisma.bulkOperation.createManyAndReturn({ data: changed.map(row => ({
    changeCount: row.unit.changes.length, productCount: 1, changes: row.changes as never,
    status: row.errors.length ? 'PARTIAL' : 'SUCCESS', expectedVersion: row.unit.expectedVersion,
    ...(row.errors.length ? { errors: row.errors as never } : {}), cascadeCount: 0, affectedChildren: [],
  })), select: { id: true, changes: true } }) : []
  // RETURNING has no order contract. Match each opaque operation id to the product in its own stored receipt.
  const operationIds = new Map(operations.map(operation => [((operation.changes as unknown as BulkReceiptChange[])[0]).id, operation.id]))
  await writeBulkEditReceipts(changed.map(row => ({ operationId: operationIds.get(row.id)!, changes: row.changes })), {
    userId: context.userId ?? null, ip: context.ip, capturePrevious: false, priorById: new Map(),
    contexts: [plan.coordinate], accounts: new Map(plan.accountId ? [[plan.coordinate.channel, plan.accountId]] : []),
  })
  const ids = changed.map(row => row.id)
  const readiness = ids.length ? await produceReadinessForProducts(ids, { channel: plan.coordinate.channel, market: plan.coordinate.marketplace, accountId: plan.accountId }) : { pending: 0 }
  if (ids.length) await afterDatabaseCommitBatch('product-cache:bulk-edit', ids, productIds => productReadCacheService.refreshMany(productIds)).catch(err => {
    context.logger.warn({ err, productIds: ids }, '[products/bulk] cache refresh failed')
  })
  return prepared.map(row => {
    const common = { ...(row.warnings.length ? { warnings: row.warnings } : {}), ...(row.normalizedChanges.length ? { normalizedChanges: row.normalizedChanges } : {}) }
    if (!row.changes.length) {
      if (row.errors.length || !row.unchanged) return { key: row.unit.key, status: 400, body: { errors: row.errors } }
      if (!row.listing) throw new UnsupportedPlatformBatch('A no-op needs its stored owner version.')
      return { key: row.unit.key, status: 200, body: { success: true, updated: 0, unchanged: row.unchanged, ...common,
        cascadeCount: 0, affectedChildren: 0, elapsedMs: 0, expectedVersion: row.unit.expectedVersion,
        currentVersion: row.listing.version, versionOf: 'channelListing' } }
    }
    return { key: row.unit.key, status: 200, body: { success: true, operationId: operationIds.get(row.id), updated: row.changes.length,
      ...common, cascadeCount: 0, affectedChildren: 0, ...(row.errors.length ? { errors: row.errors } : {}), elapsedMs: Date.now() - started,
      ...(readiness.pending ? { readinessPendingFamilies: readiness.pending } : {}), currentVersion: versions.get(row.listing!.id), versionOf: 'channelListing' } }
  })
}
