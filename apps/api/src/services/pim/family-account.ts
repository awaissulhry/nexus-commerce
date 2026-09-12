import prisma from '../../db.js'

/** Attribution wins over account defaults. Ambiguous families remain unresolved. */
export function familyAccountId(active: readonly string[], attributed: readonly (string | null)[]): string | null {
  const owners = [...new Set(attributed.filter((id): id is string => !!id && active.includes(id)))]
  return owners.length === 1 ? owners[0] : owners.length > 1 ? null : active.length === 1 ? active[0] : null
}

export async function readFamilyAccountId(productId: string, channel: string, marketplace: string): Promise<string> {
  const root = await prisma.product.findFirst({ where: { id: productId, deletedAt: null }, select: { id: true, parentId: true } })
  if (!root) throw new Error('This product is unavailable.')
  const familyId = root.parentId ?? root.id
  const [connections, listings] = await Promise.all([
    prisma.channelConnection.findMany({ where: { channelType: channel, isActive: true }, select: { id: true } }),
    prisma.channelListing.findMany({ where: { channel, marketplace, product: { OR: [{ id: familyId }, { parentId: familyId }], deletedAt: null } }, select: { channelConnectionId: true } }),
  ])
  const accountId = familyAccountId(connections.map(c => c.id), listings.map(l => l.channelConnectionId))
  if (!accountId) throw new Error(`Choose an account for ${channel} · ${marketplace}.`)
  return accountId
}
