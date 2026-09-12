import prisma from '../../db.js'
import { resolveChannelConnectionId } from '../connection-resolver.service.js'

export class WorkspaceScopeError extends Error {
  readonly code = 'WORKSPACE_SCOPE_MISMATCH'
  constructor(message: string, readonly statusCode = 409) { super(message) }
}

export interface WorkspaceDestinationInput {
  productId: string
  channel: string
  marketplace: string
  accountId?: string
  listingId?: string
  aliasKey?: string
}

/** Resolve an explicit workspace destination. A listing's missing attribution is never
 * repaired by choosing today's primary account. No credentials leave this boundary. */
export async function resolveWorkspaceDestination(input: WorkspaceDestinationInput) {
  if (!input.channel || !input.marketplace || !input.productId)
    throw new WorkspaceScopeError('Choose a product, channel and market.', 400)
  if (input.accountId !== undefined && !input.accountId.trim())
    throw new WorkspaceScopeError('Choose a connected account.', 400)
  if (input.listingId !== undefined && !input.listingId.trim())
    throw new WorkspaceScopeError('Choose an attributed listing or clear the listing selection.', 400)
  const product = await prisma.product.findFirst({ where: { id: input.productId, deletedAt: null }, select: { id: true, parentId: true } })
  if (!product) throw new WorkspaceScopeError('This product is unavailable.', 404)
  const familyId = product.parentId ?? product.id
  const market = await prisma.marketplace.findFirst({ where: { channel: input.channel, code: input.marketplace, isActive: true }, select: { id: true, currency: true } })
  if (!market) throw new WorkspaceScopeError('This channel is unavailable in the selected market.', 400)

  const select = { id: true, productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, version: true } as const
  let listing = input.listingId ? await prisma.channelListing.findUnique({ where: { id: input.listingId }, select }) : null
  // Retain existing alias links, resolving them only inside the named account and root family.
  // External listing IDs can be shared by variants, so only a root may supply this legacy link.
  if (input.listingId && !listing && input.accountId) {
    const matches = await prisma.channelListing.findMany({ where: {
      productId: familyId, channel: input.channel, marketplace: input.marketplace, channelConnectionId: input.accountId,
      OR: [{ aliasKey: input.listingId }, { externalListingId: input.listingId }],
    }, select, take: 2 })
    if (matches.length === 1) listing = matches[0]
  }
  if (input.listingId && !listing) throw new WorkspaceScopeError('The selected listing is unavailable in this product, account and market.', 404)
  if (listing) {
    const owner = await prisma.product.findFirst({ where: { id: listing.productId, deletedAt: null }, select: { id: true, parentId: true } })
    if (!owner || (owner.parentId ?? owner.id) !== familyId || listing.channel !== input.channel || listing.marketplace !== input.marketplace
      || (input.accountId !== undefined && listing.channelConnectionId !== input.accountId)
      || (input.aliasKey !== undefined && listing.aliasKey !== input.aliasKey))
      throw new WorkspaceScopeError('The selected listing does not belong to this product, account and market.')
    if (!listing.channelConnectionId) throw new WorkspaceScopeError('This listing has no account attribution. Select an attributed listing to continue.')
  }
  const accountId = input.accountId ?? listing?.channelConnectionId
  if (!accountId) throw new WorkspaceScopeError('Choose an explicit connected account.', 400)
  const connectionId = await resolveChannelConnectionId(input.channel, accountId)
  const aliasKey = listing?.aliasKey ?? input.aliasKey
  if (aliasKey) {
    const alias = await prisma.productListingAlias.findFirst({ where: {
      id: aliasKey, productId: familyId, channel: input.channel, marketplace: input.marketplace,
      channelConnectionId: connectionId, status: 'ACTIVE',
    }, select: { id: true } })
    if (!alias) throw new WorkspaceScopeError('This listing customization is unavailable in the selected destination.')
  }
  return { productId: input.productId, familyId, channel: input.channel, marketplace: input.marketplace,
    accountId, currency: market.currency, aliasKey: aliasKey ?? null, listing: listing ? { id: listing.id, productId: listing.productId, aliasKey: listing.aliasKey, version: listing.version } : null }
}

export type WorkspaceDestination = Awaited<ReturnType<typeof resolveWorkspaceDestination>>

export async function resolveWorkspaceListing(productId: string, listingId: string, accountId?: string) {
  const listing = await prisma.channelListing.findUnique({ where: { id: listingId }, select: { productId: true, channel: true, marketplace: true } })
  if (!listing || listing.productId !== productId) throw new WorkspaceScopeError('This listing does not belong to the requested product.', 404)
  return resolveWorkspaceDestination({ productId, listingId, accountId, channel: listing.channel, marketplace: listing.marketplace })
}

export function workspaceListingWhere(destination: WorkspaceDestination) {
  return { channel: destination.channel, marketplace: destination.marketplace, channelConnectionId: destination.accountId,
    ...(destination.listing ? { id: destination.listing.id } : {}),
    ...(destination.aliasKey !== null ? { aliasKey: destination.aliasKey } : {}) }
}
