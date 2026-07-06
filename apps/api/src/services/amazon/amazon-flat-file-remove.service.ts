// apps/api/src/services/amazon/amazon-flat-file-remove.service.ts
/**
 * Market-scoped Amazon listing removal. Deletes the AMAZON ChannelListing(s)
 * for a product (and its children when it is a parent) in ONE marketplace,
 * best-effort delists, and NEVER modifies the Product (inventory invariant).
 */
import { dispatchChannelDelist } from '../channel-delist.service.js'

export interface RemoveAmazonTarget { productId: string; marketplace: string }
export interface RemoveAmazonResult {
  productId: string
  marketplace: string
  channelListingsRemoved: number
  delisted: boolean
  error?: string
}

interface RemovePrisma {
  product: {
    findFirst(a: unknown): Promise<unknown>
    findMany(a: unknown): Promise<unknown[]>
  }
  channelListing: {
    findMany(a: unknown): Promise<unknown[]>
    deleteMany(a: unknown): Promise<{ count: number }>
  }
  $transaction<T>(
    fn: (tx: { channelListing: { deleteMany(a: unknown): Promise<{ count: number }> } }) => Promise<T>,
  ): Promise<T>
}

export async function removeAmazonListing(
  prisma: RemovePrisma,
  target: RemoveAmazonTarget,
): Promise<RemoveAmazonResult> {
  const { productId, marketplace } = target

  const product = (await prisma.product.findFirst({
    where: { id: productId },
    select: { id: true },
  } as any)) as { id: string } | null

  if (!product) {
    return { productId, marketplace, channelListingsRemoved: 0, delisted: false, error: `Product not found: ${productId}` }
  }

  const children = (await prisma.product.findMany({
    where: { parentId: product.id, deletedAt: null },
    select: { id: true },
  } as any)) as Array<{ id: string }>
  const ids = [product.id, ...children.map((c) => c.id)]

  const listings = (await prisma.channelListing.findMany({
    where: { productId: { in: ids }, channel: 'AMAZON', marketplace },
    select: { externalListingId: true },
  } as any)) as Array<{ externalListingId: string | null }>

  let channelListingsRemoved = 0
  await prisma.$transaction(async (tx) => {
    const del = await tx.channelListing.deleteMany({
      where: { productId: { in: ids }, channel: 'AMAZON', marketplace },
    } as any)
    channelListingsRemoved = (del as { count: number }).count
    // Product intentionally untouched.
  })

  let delisted = false
  for (const l of listings) {
    if (!l.externalListingId) continue
    try {
      const r = await dispatchChannelDelist({
        queueId: `amz-rm-${product.id}-${marketplace}`,
        productId: product.id,
        channelListingId: null,
        targetChannel: 'AMAZON',
        targetRegion: marketplace,
        externalListingId: l.externalListingId,
        syncType: 'DELETE_LISTING',
        payload: { channelAction: 'delete' },
      } as any)
      if ((r as { success?: boolean })?.success) delisted = true
    } catch { /* best-effort; never blocks the committed removal */ }
  }

  return { productId, marketplace, channelListingsRemoved, delisted }
}
