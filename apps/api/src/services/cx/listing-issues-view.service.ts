import type { Prisma, PrismaClient } from '@prisma/client'
import type { ChannelListingIssuesPage } from '@nexus/shared/channel-listing-issues'
import prismaDefault from '../../db.js'
import { workspaceIdForQuery } from '../../lib/workspace-context.js'

export class InvalidListingIssueQuery extends Error {}
interface Cursor { v: 1; workspaceId: string; connectionId: string; listingId: string | null; lastSeenAt: string; id: string }
const invalid = () => new InvalidListingIssueQuery('Use a valid cursor, listing identifier and page size from 1 to 50.')
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value

function pageInput(connectionId: string, workspaceId: string, raw: { take?: unknown; after?: unknown; listingId?: unknown }) {
  if (!identifier(connectionId) || (raw.listingId !== undefined && !identifier(raw.listingId))) throw invalid()
  const take = raw.take === undefined ? 25 : Number(raw.take)
  if ((raw.take !== undefined && (typeof raw.take !== 'string' || !/^[0-9]+$/.test(raw.take)))
    || !Number.isSafeInteger(take) || take < 1 || take > 50) throw invalid()
  const listingId = raw.listingId as string | undefined
  let cursor: Cursor | null = null
  if (raw.after !== undefined) {
    if (typeof raw.after !== 'string' || raw.after.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw.after)) throw invalid()
    try { cursor = JSON.parse(Buffer.from(raw.after, 'base64url').toString('utf8')) as Cursor } catch { throw invalid() }
    if (!cursor || cursor.v !== 1 || cursor.workspaceId !== workspaceId || cursor.connectionId !== connectionId
      || cursor.listingId !== (listingId ?? null) || !identifier(cursor.id)
      || typeof cursor.lastSeenAt !== 'string' || !Number.isFinite(Date.parse(cursor.lastSeenAt))
      || new Date(cursor.lastSeenAt).toISOString() !== cursor.lastSeenAt) throw invalid()
  }
  return { take, listingId, cursor }
}

/** Saved open issues only. Account visibility comes from the scoped client; findings always belong to the current business. */
export async function listingIssuesByConnection(
  connectionId: string,
  raw: { take?: unknown; after?: unknown; listingId?: unknown } = {},
  db: PrismaClient = prismaDefault as unknown as PrismaClient,
): Promise<ChannelListingIssuesPage | null> {
  const workspaceId = workspaceIdForQuery()
  const { take, listingId, cursor } = pageInput(connectionId, workspaceId, raw)
  const account = await db.channelConnection.findUnique({ where: { id: connectionId }, select: { id: true, channelType: true } })
  if (!account) return null
  const where: Prisma.ListingIssueWhereInput = {
    workspaceId, resolvedAt: null, ...(listingId ? { listingId } : {}),
    channelListing: { workspaceId, channelConnectionId: connectionId, product: { workspaceId } },
    ...(cursor ? { OR: [
      { lastSeenAt: { lt: new Date(cursor.lastSeenAt) } },
      { lastSeenAt: new Date(cursor.lastSeenAt), id: { gt: cursor.id } },
    ] } : {}),
  }
  const rows = await db.listingIssue.findMany({ where, take: take + 1, orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }], select: {
    id: true, listingId: true, code: true, severity: true, message: true, attributeNames: true, categories: true,
    source: true, firstSeenAt: true, lastSeenAt: true, occurredAt: true,
    channelListing: { select: { productId: true, marketplace: true, externalListingId: true, product: { select: { sku: true } } } },
  } })
  const page = rows.slice(0, take), last = page.at(-1)
  const next: Cursor | null = rows.length > take && last ? {
    v: 1, workspaceId, connectionId, listingId: listingId ?? null, lastSeenAt: last.lastSeenAt.toISOString(), id: last.id,
  } : null
  return {
    connectionId: account.id, workspaceId, channel: account.channelType, readAt: new Date().toISOString(),
    items: page.map(row => ({
      id: row.id, listingId: row.listingId, productId: row.channelListing.productId, productSku: row.channelListing.product.sku,
      marketplace: row.channelListing.marketplace, externalListingId: row.channelListing.externalListingId,
      code: row.code, severity: row.severity, message: row.message, attributeNames: row.attributeNames, categories: row.categories,
      source: row.source, firstSeenAt: row.firstSeenAt.toISOString(), lastSeenAt: row.lastSeenAt.toISOString(), occurredAt: row.occurredAt?.toISOString() ?? null,
    })),
    nextCursor: next ? Buffer.from(JSON.stringify(next)).toString('base64url') : null,
  }
}
