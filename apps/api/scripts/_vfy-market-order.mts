// READ-ONLY: does buildEbayFamilyRows read a NON-active market's itemSpecifics?
const { default: prisma } = await import('../src/db.js')
const out: string[] = []
const parent = await prisma.product.findFirst({ where: { sku: 'WATERPROOF-OVERJACKET-BLACK-MEN' }, select: { id: true } })
const kids = await prisma.product.findMany({
  where: { OR: [{ id: parent!.id }, { parentId: parent!.id }], deletedAt: null },
  select: { sku: true, channelListings: { where: { channel: 'EBAY' }, select: { region: true, platformAttributes: true } } },
  orderBy: { sku: 'asc' },
})
for (const k of kids) {
  const parts = k.channelListings.map((l) => {
    const sp = ((l.platformAttributes as any)?.itemSpecifics ?? {}) as Record<string, string>
    const axisKeys = Object.keys(sp).filter((n) => /^(colore|color|taglia|size)$/i.test(n))
    return `${l.region}{${axisKeys.map((n) => `${n}=${sp[n]}`).join(';')}}`
  })
  out.push(`${k.sku}  listings[0]=${k.channelListings[0]?.region}  ${parts.join('  ')}`)
}
const { writeFileSync } = await import('node:fs')
writeFileSync('/private/tmp/claude-501/-Users-awais-nexus-commerce/d027119c-29ec-42b4-9052-5dab9e08b3ce/scratchpad/mktorder.txt', out.join('\n'))
console.log('WROTE')
process.exit(0)
