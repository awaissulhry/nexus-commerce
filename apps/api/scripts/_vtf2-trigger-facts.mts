import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'
import { parse } from 'dotenv'
const url = parse(readFileSync(new URL('../.env', import.meta.url).pathname, 'utf8')).DATABASE_URL!
if (!/nexus_development/.test(url)) throw new Error('REFUSED: not local')
const prisma = new PrismaClient({ datasources: { db: { url } } })
const trig = await prisma.$queryRawUnsafe<any[]>(`
  SELECT event_object_table::text AS tbl, trigger_name::text AS name, action_timing::text AS timing, event_manipulation::text AS ev, action_statement::text AS stmt
  FROM information_schema.triggers WHERE event_object_table IN ('ChannelListing','Product','ProductCategory') ORDER BY 1,2`)
console.log('TRIGGERS:', JSON.stringify(trig, null, 1))
const conns = await prisma.channelConnection.findMany({ select: { id: true, channelType: true, displayName: true, isActive: true } })
console.log('CONNECTIONS:', JSON.stringify(conns))
const listings = await prisma.channelListing.groupBy({ by: ['channel', 'marketplace', 'channelConnectionId'], _count: { id: true } })
console.log('LISTING COORDINATES:', JSON.stringify(listings.map(l => [l.channel, l.marketplace, l.channelConnectionId, l._count.id])))
const mk = await prisma.marketplace.findMany({ select: { channel: true, code: true, language: true, isActive: true } })
console.log('MARKETPLACES:', JSON.stringify(mk.map(m => [m.channel, m.code, m.language, m.isActive])))
await prisma.$disconnect()
