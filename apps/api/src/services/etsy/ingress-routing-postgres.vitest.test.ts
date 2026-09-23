import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_t, p) => (database.client as any)[p] }) }))
const { verifiedChannelWorkspace } = await import('../../lib/workspace-ingress.js')
const WS = 'nexus_legacy_workspace'
const other = randomUUID()
const existing = randomUUID()
const migration = (name: string) => readFileSync(new URL(`../../../../../packages/database/prisma/migrations/${name}/migration.sql`, import.meta.url), 'utf8')
async function connection(id: string, workspace: string, channel: string, externalId: string, identity: object) {
  await database.pool.query(`INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","externalAccountId",identity,"isActive","updatedAt") VALUES ($1,$2,$3,$4,$5,true,now())`, [id, workspace, channel, externalId, JSON.stringify(identity)])
}

describe.skipIf(!concurrentDatabaseUrl())('Etsy shop routing in real PostgreSQL', () => {
  beforeAll(async () => {
    database = await concurrentDatabase({ maxConnections: 4 })
    await database.pool.query(migration('20260920b_p21_inbound_route_aliases'))
    await database.pool.query(migration('20260920c_p26_ebay_inbound_alias'))
    await database.pool.query(`INSERT INTO "Workspace" (id,name,"createdByUserId","creationKey","updatedAt") VALUES ($1,'Motovento test','test',$1,now())`, [other])
    await connection(existing, other, 'ETSY', '1051233836', { userId: '1051233836', extra: { shopId: '57783036' } })
    await database.pool.query(migration('20260922a_cx_etsy_shop_alias'))
  }, 180_000)
  afterAll(async () => { await database?.close() }, 60_000)

  it('routes an already-connected shop to its owner by shop ID', async () => {
    expect(await verifiedChannelWorkspace('ETSY', '57783036')).toMatchObject({ connectionId: existing, workspaceId: other })
  })
  it('updates the alias when a verified shop identity changes', async () => {
    const id = randomUUID()
    await connection(id, WS, 'ETSY', '7001', { extra: { shopId: '8001' } })
    await database.pool.query(`UPDATE "ChannelConnection" SET identity=$2 WHERE id=$1`, [id, JSON.stringify({ extra: { shopId: '8002' } })])
    await expect(verifiedChannelWorkspace('ETSY', '8001')).rejects.toMatchObject({ code: 'ingress_account_ambiguous' })
    expect(await verifiedChannelWorkspace('ETSY', '8002')).toMatchObject({ connectionId: id, workspaceId: WS })
  })
  it('retains eBay and Shopify aliases', async () => {
    const ebay = randomUUID(), shopify = randomUUID()
    await connection(ebay, WS, 'EBAY', 'ebay-user', { username: 'seller-name', userId: 'ebay-user' })
    await connection(shopify, WS, 'SHOPIFY', 'gid://shopify/Shop/1', { extra: { myshopifyDomain: 'test.myshopify.com' } })
    expect(await verifiedChannelWorkspace('EBAY', 'seller-name')).toMatchObject({ connectionId: ebay })
    expect(await verifiedChannelWorkspace('SHOPIFY', 'test.myshopify.com')).toMatchObject({ connectionId: shopify })
  })
  it('refuses ambiguous shop aliases instead of choosing a profile', async () => {
    await connection(randomUUID(), WS, 'ETSY', '9001', { extra: { shopId: '9999' } })
    await connection(randomUUID(), other, 'ETSY', '9002', { extra: { shopId: '9999' } })
    await expect(verifiedChannelWorkspace('ETSY', '9999')).rejects.toMatchObject({ code: 'ingress_account_ambiguous' })
  })
  it('does not confuse an Etsy user ID with an unrelated shop ID', async () => {
    await connection(randomUUID(), WS, 'ETSY', '123123', { extra: { shopId: '456456' } })
    await expect(verifiedChannelWorkspace('ETSY', '123123')).rejects.toMatchObject({ code: 'ingress_account_ambiguous' })
  })
})
