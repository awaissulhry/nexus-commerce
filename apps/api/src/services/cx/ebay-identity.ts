import type { Prisma } from '@prisma/client'

export interface EbaySellerIdentity { environment: 'production' | 'sandbox'; userId: string }

export class EbayIdentityChanged extends Error {
  readonly reason = 'grant_changed'
  constructor() { super('The current eBay seller authorization must be checked again.'); this.name = 'EbayIdentityChanged' }
}

export function ebaySellerIdentity(row: { externalAccountId: string | null; connectionMetadata: unknown }): EbaySellerIdentity {
  const environment = (row.connectionMetadata as { environment?: unknown } | null)?.environment ?? 'production'
  const userId = row.externalAccountId
  if ((environment !== 'production' && environment !== 'sandbox') || !userId || userId.length > 1024
    || userId !== userId.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(userId)) throw new EbayIdentityChanged()
  return { environment, userId }
}

/** Covers a seller even before a connection or ownership-index row exists. */
export async function lockEbaySeller(tx: Prisma.TransactionClient, identity: EbaySellerIdentity): Promise<void> {
  const key = JSON.stringify(['nexus-ebay-identity', identity.environment, identity.userId])
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
}

/** Call under the seller lock, after its wait, in a ReadCommitted transaction. */
export async function assertNoOtherActiveEbayAccount(tx: Prisma.TransactionClient, identity: EbaySellerIdentity, workspaceId: string, connectionId: string): Promise<void> {
  const others = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "ChannelConnection" WHERE "workspaceId"=${workspaceId} AND "channelType"='EBAY'
      AND "externalAccountId"=${identity.userId} AND "isActive"=true AND id<>${connectionId}
      AND COALESCE("connectionMetadata"->>'environment','production')=${identity.environment} LIMIT 1`
  if (others.length) throw new EbayIdentityChanged()
}

/** Receipt → seller → account; never acquire the seller lock after an account lock. */
export async function lockOwnedEbayAccount(tx: Prisma.TransactionClient, workspaceId: string, connectionId: string) {
  const snapshot = await tx.channelConnection.findFirst({ where: { id: connectionId, workspaceId, channelType: 'EBAY' },
    select: { externalAccountId: true, connectionMetadata: true } })
  if (!snapshot) throw new Error('The stored eBay receipt account is not owned by this business profile.')
  const identity = ebaySellerIdentity(snapshot)
  await lockEbaySeller(tx, identity)
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "ChannelConnection" WHERE id=${connectionId} AND "workspaceId"=${workspaceId}
      AND "channelType"='EBAY' FOR UPDATE`
  if (!locked.length) throw new Error('The stored eBay receipt account is not owned by this business profile.')
  const row = await tx.channelConnection.findUniqueOrThrow({ where: { id: connectionId } })
  const current = ebaySellerIdentity(row)
  if (current.userId !== identity.userId || current.environment !== identity.environment || row.managedBy === 'transferred') throw new EbayIdentityChanged()
  await assertNoOtherActiveEbayAccount(tx, identity, workspaceId, connectionId)
  return row
}
