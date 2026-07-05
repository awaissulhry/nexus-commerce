const PRIMARY = 'IT'

export function sortMarkets(codes: string[]): string[] {
  const uniq = [...new Set(codes.filter(Boolean))]
  return uniq.sort((a, b) => (a === PRIMARY ? -1 : b === PRIMARY ? 1 : a.localeCompare(b)))
}

export async function discoverMarkets(prisma: any, channel: 'AMAZON' | 'EBAY' | 'SHOPIFY'): Promise<string[]> {
  const [present, configured] = await Promise.all([
    prisma.channelListing.findMany({ where: { channel }, select: { marketplace: true }, distinct: ['marketplace'] }),
    prisma.marketplace.findMany({ where: { channel, isActive: true }, select: { code: true } }),
  ])
  return sortMarkets([...present.map((p: any) => p.marketplace), ...configured.map((c: any) => c.code)])
    .filter(m => m && m !== 'DEFAULT' && m !== 'GLOBAL' || channel === 'SHOPIFY')
}
