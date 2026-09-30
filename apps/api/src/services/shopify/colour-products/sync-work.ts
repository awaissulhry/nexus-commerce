import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { Prisma, ShopifyColourSync } from '@prisma/client'
import prisma from '../../../db.js'
import { WorkspaceScopeError } from '../../pim/workspace-destination.js'
import type { ShopifyGraphql } from '../admin-client.js'
import { requireWorkspace } from '../../../lib/workspace-context.js'

export interface ColourCoordinate { familyId: string; accountId: string; marketplace: string; aliasKey?: string | null }
export type ColourClaim = ShopifyColourSync & { leaseToken: string }
export class ColourSyncBusyError extends WorkspaceScopeError {
  readonly code = 'SHOPIFY_COLOUR_SYNC_BUSY'
  constructor() { super('This colour family is already syncing. Try again when that run ends.') }
}
const LEASE_MS = 15 * 60_000 // Renewed before and after each Shopify call; that client times out after 60 seconds.
const active = new AsyncLocalStorage<ColourClaim>()
const coordinate = (d: ColourCoordinate) => ({ familyId: d.familyId, channelConnectionId: d.accountId, marketplace: d.marketplace, aliasKey: d.aliasKey ?? '' })

export async function ensureColourSync(d: ColourCoordinate) {
  const where = coordinate(d)
  return prisma.shopifyColourSync.upsert({ where: { colour_sync: { ...where, workspaceId: requireWorkspace().workspaceId } }, create: where, update: {} })
}

/** A durable row lock, shared by manual operations and both background runners. No transaction spans the network. */
export async function claimColourSync(id: string, onlyDue = false): Promise<ColourClaim | null> {
  const token = randomUUID(), now = new Date()
  const won = await prisma.shopifyColourSync.updateMany({ where: { id, ...(onlyDue ? { dueAt: { lte: now } } : {}), OR: [{ leaseToken: null }, { leaseUntil: { lt: now } }] },
    data: { leaseToken: token, leaseUntil: new Date(now.getTime() + LEASE_MS) } })
  if (!won.count) return null
  const row = await prisma.shopifyColourSync.findFirst({ where: { id, leaseToken: token } })
  return row ? { ...row, leaseToken: token } : null
}

export const inColourSync = <T>(claim: ColourClaim, work: () => Promise<T>) => active.run(claim, work)

/** Call inside the local commit too: the request row is locked until that commit finishes. */
export async function assertColourSyncCurrent(db: Pick<Prisma.TransactionClient, 'shopifyColourSync'> = prisma) {
  const run = active.getStore()
  if (!run) return
  const won = await db.shopifyColourSync.updateMany({ where: { id: run.id, leaseToken: run.leaseToken, revision: run.revision }, data: { leaseUntil: new Date(Date.now() + LEASE_MS) } })
  if (won.count !== 1) throw new WorkspaceScopeError('This colour family changed during sync. Its new work stays pending; retry with the current family.', 409)
}

/** Accept only this run's own committed structural changes. Other writers cannot pass the request lock meanwhile. */
export async function commitColourSyncChange<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const claim = active.getStore()
  const result = await prisma.$transaction(async tx => {
    await assertColourSyncCurrent(tx)
    const value = await work(tx)
    const row = claim ? await tx.shopifyColourSync.findFirstOrThrow({ where: { id: claim.id, leaseToken: claim.leaseToken } }) : null
    return { value, revision: row?.revision }
  })
  if (claim && result.revision !== undefined) claim.revision = result.revision
  return result.value
}

export function guardedColourGraphql(graphql: ShopifyGraphql): ShopifyGraphql {
  return async (query, variables) => {
    await assertColourSyncCurrent()
    const result = await graphql(query, variables)
    await assertColourSyncCurrent()
    return result
  }
}

export async function finishColourSync(claim: ColourClaim, done: boolean, error?: string) {
  await prisma.$transaction(async tx => {
    // A new edit's deadline and error must never be replaced by an older run's result.
    await tx.shopifyColourSync.updateMany({ where: { id: claim.id, leaseToken: claim.leaseToken, revision: claim.revision },
      data: done ? { dueAt: null, lastError: null } : error ? { dueAt: new Date(Date.now() + 30_000), lastError: error.slice(0, 2000) } : {} })
    await tx.shopifyColourSync.updateMany({ where: { id: claim.id, leaseToken: claim.leaseToken }, data: { leaseToken: null, leaseUntil: null } })
  })
}

export async function withColourSyncLock<T>(d: ColourCoordinate, work: () => Promise<T>): Promise<T> {
  const current = active.getStore()
  if (current) {
    const wanted = coordinate(d)
    if (Object.entries(wanted).some(([key, value]) => current[key] !== value)) throw new WorkspaceScopeError('A colour sync cannot change its destination.')
    return work()
  }
  const row = await ensureColourSync(d), claim = await claimColourSync(row.id)
  if (!claim) throw new ColourSyncBusyError()
  try { return await inColourSync(claim, work) }
  finally { await finishColourSync(claim, false) }
}
