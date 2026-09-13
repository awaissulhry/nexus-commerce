/**
 * VT.1 — create the three-axis rehearsal family `VX-TEST-3AX` on the LOCAL Docker database only.
 * Announced in `docs/pes-claims.md` BEFORE this ran. DRAFT rows, no external ids, nothing publishable.
 *
 *   cd apps/api && npx tsx scripts/_vt1-fixture-create.mts <DATABASE_URL>
 */
const url = process.argv[2]
if (!url) { console.error('usage: tsx _vt1-fixture-create.mts <DATABASE_URL>'); process.exit(2) }
if (url.includes('neon.tech')) { console.error('REFUSED: this script writes. Neon is read-only for this lane.'); process.exit(2) }
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient({ datasources: { db: { url } } })
const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x))

const gale = await p.product.findFirst({ where: { sku: 'GALE-JACKET' }, select: { id: true, version: true, workspaceId: true } })
if (!gale) { console.error('GALE-JACKET not visible — wrong database?'); process.exit(1) }
console.log('DISCRIMINATOR GALE-JACKET version:', gale.version, '(local = 59, Neon prod = 51) | workspaceId:', gale.workspaceId)

const existing = await p.product.findMany({ where: { sku: { startsWith: 'VX-TEST-3AX' } }, select: { id: true, sku: true } })
if (existing.length > 0) { console.log('already present, nothing created:', j(existing)); await p.$disconnect(); process.exit(0) }

const COMBOS: Array<[string, string, string]> = [
  ['Nero', 'M', 'Slim'],
  ['Nero', 'M', 'Regular'],
  ['Nero', 'L', 'Slim'],
  ['Nero', 'L', 'Regular'],
]

const parent = await p.product.create({
  data: {
    sku: 'VX-TEST-3AX',
    name: 'VT.1 rehearsal — three-axis family (DRAFT, delete with VT.F)',
    status: 'DRAFT',
    productType: 'SUIT',
    variationAxes: ['Colore', 'Taglia', 'Fit Type'],
    isParent: true,
    workspaceId: gale.workspaceId,
    basePrice: 1,
    totalStock: 0,
  },
  select: { id: true, sku: true, version: true },
})
console.log('parent created:', j(parent))

const children: Array<{ id: string; sku: string }> = []
for (let i = 0; i < COMBOS.length; i++) {
  const [color, size, fit] = COMBOS[i]
  const child = await p.product.create({
    data: {
      sku: `VX-TEST-3AX-${i + 1}`,
      name: `VT.1 rehearsal child ${color}/${size}/${fit}`,
      status: 'DRAFT',
      productType: 'SUIT',
      parentId: parent.id,
      workspaceId: gale.workspaceId,
      basePrice: 1,
      totalStock: 0,
      categoryAttributes: { variations: { Color: color, Size: size, 'Fit Type': fit } },
      variantAttributes: { Colore: color, Taglia: size, 'Fit Type': fit },
    },
    select: { id: true, sku: true },
  })
  children.push(child)
}
console.log('children created:', j(children))

for (const [channel, marketplace, region] of [['AMAZON', 'IT', 'IT'], ['SHOPIFY', 'GLOBAL', 'GLOBAL']] as const) {
  for (const product of [parent, ...children]) {
    const row = await p.channelListing.create({
      data: {
        productId: product.id,
        channel, marketplace, region,
        channelMarket: `${channel}_${region}`,
        listingStatus: 'DRAFT',
        isPublished: false,
        workspaceId: gale.workspaceId,
      },
      select: { id: true, channel: true, marketplace: true, version: true },
    })
    if (product.id === parent.id) console.log('parent listing:', j(row))
  }
}

const check = await p.product.findMany({
  where: { OR: [{ id: parent.id }, { parentId: parent.id }] },
  select: { sku: true, status: true, variationAxes: true, version: true, categoryAttributes: true,
    channelListings: { select: { channel: true, marketplace: true, listingStatus: true, externalListingId: true, isPublished: true, version: true } } },
  orderBy: { sku: 'asc' },
})
console.log('\nREAD BACK:')
for (const row of check) console.log(' ', row.sku, row.status, 'v' + row.version, j(row.variationAxes), j((row.categoryAttributes as any)?.variations ?? null),
  row.channelListings.map((l) => `${l.channel}/${l.marketplace} ${l.listingStatus} v${l.version} id=${l.externalListingId ?? 'null'} published=${l.isPublished}`).join(' | '))
await p.$disconnect()
