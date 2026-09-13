/** LX.FIN item 5 (R-LX-26) — what the store channels' connections say on LOCAL. READ ONLY. */
import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'
const url = readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').find(l => l.startsWith('DATABASE_URL='))!.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '')
const prisma = new PrismaClient({ datasources: { db: { url } } })
console.log('current_database', (await prisma.$queryRawUnsafe<any[]>('SELECT current_database()::text AS db'))[0])
const conns = await prisma.channelConnection.findMany({ where: { channelType: { in: ['SHOPIFY', 'ETSY', 'WOOCOMMERCE'] } } })
for (const c of conns) {
  const redacted: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(c)) redacted[k] = /token|secret|password|key/i.test(k) ? (v ? '<set>' : null) : v
  console.log(JSON.stringify(redacted))
}
console.log('connections:', conns.length)
await prisma.$disconnect()
