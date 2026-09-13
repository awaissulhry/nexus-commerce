import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'; import { parse } from 'dotenv'
const url = parse(readFileSync(new URL('../.env', import.meta.url).pathname, 'utf8')).DATABASE_URL!
if (!/nexus_development/.test(url)) throw new Error('REFUSED')
const prisma = new PrismaClient({ datasources: { db: { url } } })
const fixtures = await prisma.product.count({ where: { sku: { startsWith: 'VTF2-TEST' } } })
const gale = await prisma.product.findFirst({ where: { sku: 'GALE-JACKET' }, select: { version: true } })
const products = await prisma.product.count()
const listings = await prisma.channelListing.count()
const gateUsers = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT COUNT(*)::bigint AS n FROM "UserProfile" WHERE id LIKE 'vtgate%'`)
const gateRoles = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT COUNT(*)::bigint AS n FROM "Role" WHERE id LIKE 'vtgate%' OR name LIKE 'VT_GATE%'`)
console.log(JSON.stringify({ vtf2FixtureRows: fixtures, products, channelListings: listings, galeVersion: gale?.version, orphanGateUsers: Number(gateUsers[0].n), orphanGateRoles: Number(gateRoles[0].n) }))
await prisma.$disconnect()
