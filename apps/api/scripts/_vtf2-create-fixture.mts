/**
 * VT.F2 — create the two disposable DRAFT fixture families. LOCAL `nexus_development` ONLY; the URL is stated,
 * not inherited, and the script REFUSES anything else before a single write.
 */
import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'
import { parse } from 'dotenv'
const url = parse(readFileSync(new URL('../.env', import.meta.url).pathname, 'utf8')).DATABASE_URL!
if (!/nexus_development/.test(url) || !/127\.0\.0\.1|localhost/.test(url)) throw new Error('REFUSED: not the local database')
const prisma = new PrismaClient({ datasources: { db: { url } } })

const WS = 'nexus_legacy_workspace'
const CAT_JACKETS = 'cmtny43ru002lnjfbr4kp9os3'
const AMZ = 'cmothu9bo0000nz01asw6wx8j'
const EBAY = 'cmr4aaqb00025nz016k18rup9'

const db = await prisma.$queryRawUnsafe<Array<{ db: string }>>(`SELECT current_database()::text AS db`)
const gale = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET' }, select: { version: true } })
const before = await prisma.product.count()
if (db[0].db !== 'nexus_development') throw new Error(`REFUSED: current_database() = ${db[0].db}`)
console.log('DISCRIMINATOR', JSON.stringify({ current_database: db[0].db, products: before, galeVersion: gale?.version }))

/**
 * IDEMPOTENT by construction: a first run failed on a missing required column AFTER creating the parent and its
 * four children, so this script removes any `VTF2-TEST%` rows it finds before creating. Addressing them by SKU
 * PREFIX and by parentId both ways (`reference_clean_up_by_value_not_by_row`).
 */
{
  const mine = await prisma.product.findMany({ where: { sku: { startsWith: 'VTF2-TEST' } }, select: { id: true } })
  if (mine.length) {
    const ids = mine.map((m) => m.id)
    const listings = await prisma.channelListing.deleteMany({ where: { productId: { in: ids } } })
    const cats = await prisma.productCategory.deleteMany({ where: { productId: { in: ids } } })
    const kids = await prisma.product.deleteMany({ where: { parentId: { in: ids } } })
    const parents = await prisma.product.deleteMany({ where: { sku: { startsWith: 'VTF2-TEST' } } })
    console.log('PRE-CLEAN', JSON.stringify({ found: mine.length, listings: listings.count, cats: cats.count, kids: kids.count, parents: parents.count }))
  }
}

const CHILDREN = [
  { sku: 'VTF2-TEST-3AX-1', attrs: { Colore: 'Nero', Taglia: 'M', 'Fit Type': 'Regular' } },
  { sku: 'VTF2-TEST-3AX-2', attrs: { Colore: 'Nero', Taglia: 'L', 'Fit Type': 'Regular' } },
  { sku: 'VTF2-TEST-3AX-3', attrs: { Colore: 'Rosso', Taglia: 'M', 'Fit Type': 'Slim' } },
  { sku: 'VTF2-TEST-3AX-4', attrs: { Colore: 'Rosso', Taglia: 'L', 'Fit Type': 'Slim' } },
]

const parent = await prisma.product.create({ data: {
  workspaceId: WS, sku: 'VTF2-TEST-3AX', name: 'VT.F2 fixture — three axes (disposable)', status: 'DRAFT',
  productType: 'OUTERWEAR', isParent: true, isMaster: true, basePrice: 10, totalStock: 0,
  variationAxes: ['Colore', 'Taglia', 'Fit Type'], variationTheme: null,
  categoryAttributes: { parentage_level: 'parent' },
} })
await prisma.productCategory.create({ data: { workspaceId: WS, productId: parent.id, categoryId: CAT_JACKETS, isPrimary: true } })
const children: Array<{ id: string; sku: string }> = []
for (const c of CHILDREN) {
  const child = await prisma.product.create({ data: {
    workspaceId: WS, sku: c.sku, name: `VT.F2 fixture ${c.sku}`, status: 'DRAFT', productType: 'OUTERWEAR',
    parentId: parent.id, basePrice: 10, totalStock: 0, variantAttributes: c.attrs,
    categoryAttributes: { ...c.attrs, parentage_level: 'child' },
  } })
  await prisma.productCategory.create({ data: { workspaceId: WS, productId: child.id, categoryId: CAT_JACKETS, isPrimary: true } })
  children.push({ id: child.id, sku: child.sku })
}

const coords: Array<{ channel: string; marketplace: string; conn: string }> = [
  { channel: 'AMAZON', marketplace: 'IT', conn: AMZ },
  { channel: 'AMAZON', marketplace: 'DE', conn: AMZ },
  { channel: 'EBAY', marketplace: 'IT', conn: EBAY },
]
let listingCount = 0
for (const coord of coords) {
  for (const member of [{ id: parent.id, sku: parent.sku }, ...children]) {
    await prisma.channelListing.create({ data: {
      workspaceId: WS, productId: member.id, channel: coord.channel, marketplace: coord.marketplace,
      channelConnectionId: coord.conn, aliasKey: '', listingStatus: 'DRAFT', isPublished: false,
      // Required, and it is a composite of the two above — read from the 1003 existing rows, never invented:
      // every row has `channelMarket = '<CHANNEL>_<MARKET>'` and `region = '<MARKET>'`.
      channelMarket: `${coord.channel}_${coord.marketplace}`, region: coord.marketplace,
      title: `VT.F2 ${member.sku}`, price: 10, quantity: 0, platformAttributes: {},
    } })
    listingCount++
  }
}

// Family B — children, NO axes: reading (a) `Set axes…` on master.
const noax = await prisma.product.create({ data: {
  workspaceId: WS, sku: 'VTF2-TEST-NOAX', name: 'VT.F2 fixture — children, no axes (disposable)', status: 'DRAFT',
  productType: 'OUTERWEAR', isParent: true, isMaster: true, basePrice: 10, totalStock: 0, variationAxes: [],
} })
await prisma.productCategory.create({ data: { workspaceId: WS, productId: noax.id, categoryId: CAT_JACKETS, isPrimary: true } })
const noaxKids: Array<{ id: string; sku: string }> = []
for (const sku of ['VTF2-TEST-NOAX-1', 'VTF2-TEST-NOAX-2']) {
  const kid = await prisma.product.create({ data: {
    workspaceId: WS, sku, name: `VT.F2 fixture ${sku}`, status: 'DRAFT', productType: 'OUTERWEAR',
    parentId: noax.id, basePrice: 10, totalStock: 0, variantAttributes: {},
  } })
  noaxKids.push({ id: kid.id, sku: kid.sku })
}

const after = await prisma.product.count()
console.log('CREATED', JSON.stringify({
  parent: { id: parent.id, sku: parent.sku, version: parent.version },
  children, listings: listingCount,
  noax: { id: noax.id, sku: noax.sku }, noaxKids,
  products: `${before} → ${after}`,
}, null, 1))
await prisma.$disconnect()
