/**
 * LX.FIN item 5 (R-LX-26) — what each STORE reports as its own language. READ ONLY: a GraphQL `query`
 * (never a mutation, so `assertWritable` and the publish-mode gate are not even reached) and a GET.
 */
import { readFileSync } from 'node:fs'
const env = readFileSync(new URL('../.env', import.meta.url), 'utf8')
for (const line of env.split('\n')) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '') }
await import('../src/services/cx/connectors/index.js') // the ChannelSpec registry, as `index.ts:189` does
const { default: prisma } = await import('../src/db.js')
const db = (await prisma.$queryRawUnsafe<any[]>('SELECT current_database()::text AS db'))[0]
console.log('current_database', db)
const conns = await prisma.channelConnection.findMany({ where: { channelType: { in: ['SHOPIFY', 'ETSY', 'WOOCOMMERCE'] }, isActive: true }, select: { id: true, channelType: true, displayName: true, externalAccountId: true, authStatus: true } })
console.log('store connections:', JSON.stringify(conns))

for (const c of conns) {
  if (c.channelType === 'SHOPIFY') {
    try {
      const { shopifyAdmin } = await import('../src/services/shopify/admin-client.js')
      const admin = await shopifyAdmin(c.id)
      const data = await admin.graphql<{ shopLocales: Array<{ locale: string; primary: boolean; published: boolean }> }>('query NexusLxfinShopLocales { shopLocales { locale primary published } }')
      console.log(`SHOPIFY ${c.displayName} (${admin.domain}) shopLocales = ${JSON.stringify(data.shopLocales)}`)
    } catch (e: any) { console.log(`SHOPIFY ${c.displayName} REFUSED: ${e?.message}`) }
  }
  if (c.channelType === 'ETSY') {
    try {
      const { etsyReader } = await import('../src/services/etsy/read-client.js')
      const reader = await etsyReader(c.id)
      const shop = await reader.get<Record<string, unknown>>(`/shops/${reader.shopId}`)
      console.log('ETSY shopId', reader.shopId, 'languages =', JSON.stringify(shop.languages), '· shop_name =', JSON.stringify(shop.shop_name), '· url =', JSON.stringify(shop.url))
    } catch (e: any) { console.log(`ETSY ${c.displayName} REFUSED: ${e?.message}`) }
  }
}
await prisma.$disconnect()
