import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { workspacePrisma } from '@nexus/database/workspace-router'
import { withWorkspace } from '@nexus/database/workspace-context'
import { expect } from 'vitest'
import type { ListingCoordinate } from '../lib/listing-coordinate.js'

/** Announced disposable XAVIA rows only; never imports a channel writer. */
export async function withPresenceFixture(channel: 'AMAZON' | 'EBAY', run: (fixture: {
  db: ReturnType<typeof workspacePrisma>
  coordinate: ListingCoordinate
  sibling: ListingCoordinate
  marker: string
  sku: string
  readBack: () => Promise<any[]>
}) => Promise<void>) {
  const url = new URL(process.env.DATABASE_URL!)
  expect(`${url.hostname}:${url.port}${url.pathname}`).toBe('127.0.0.1:55439/nexus_development')
  console.log(`PR.3 LOCAL fixture host=${url.host}${url.pathname}`)
  const pool = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 5_000 })
  const db = workspacePrisma(pool)
  const marker = `PR3-SITE-${randomUUID()}`
  const residue = { OR: [{ externalListingId: { startsWith: marker } }, { aliasKey: { startsWith: marker } }] }
  const products = { OR: [{ sku: { startsWith: marker } }, { name: { startsWith: marker } }] }
  await withWorkspace({ workspaceId: 'nexus_legacy_workspace', actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
    try {
      const identity = await db.$queryRaw<Array<{ db: string }>>`SELECT current_database()::text AS db`
      expect(identity[0].db).toBe('nexus_development')
      const gale = await db.product.findFirstOrThrow({ where: { id: 'cmokmy3a40078pm0p1fvnu523', sku: 'GALE-JACKET' }, select: { id: true, familyId: true } })
      expect(gale.familyId).toBe('cmtny43jv002jnjfbb6hnijqx')
      const connection = await db.channelListing.findFirstOrThrow({ where: { productId: gale.id, channel, marketplace: 'IT', aliasKey: '' }, select: { channelConnectionId: true } })
      expect(connection.channelConnectionId).toBeTruthy()
      const product = await db.product.create({ data: { sku: marker, name: marker, status: 'DRAFT', basePrice: 10, familyId: gale.familyId, fulfillmentMethod: 'FBM', fulfillmentChannel: 'FBM', productType: 'AUTO_ACCESSORY' }, select: { id: true } })
      const coordinate: ListingCoordinate = { productId: product.id, channel, marketplace: 'IT', channelConnectionId: connection.channelConnectionId, aliasKey: `${marker}-a` }
      const sibling: ListingCoordinate = { ...coordinate, channelConnectionId: null, aliasKey: `${marker}-b` }
      await db.channelListing.createMany({ data: [coordinate, sibling].map((c, index) => ({
        ...c, channelMarket: `${channel}_IT`, region: 'IT', externalListingId: `${marker}-${index}`,
        listingStatus: 'DRAFT', isPublished: false, syncPaused: true, fulfillmentMethod: 'FBM', quantity: 5,
        price: 10, offerActive: true, platformAttributes: { productType: 'AUTO_ACCESSORY' },
      })) })
      expect(await db.channelListing.count({ where: { productId: product.id, channel, marketplace: 'IT' } })).toBe(2)
      await run({ db, coordinate, sibling, marker, sku: marker, readBack: async () => {
        await delay(8_000)
        return db.channelListing.findMany({ where: { productId: product.id }, orderBy: { aliasKey: 'asc' } })
      } })
    } finally {
      await db.channelListing.deleteMany({ where: residue })
      expect(await db.channelListing.count({ where: residue })).toBe(0)
      await db.product.deleteMany({ where: products })
      expect(await db.product.count({ where: products })).toBe(0)
      console.log('PR.3 sentinel cleanup: listing=0 product=0')
      await db.$disconnect()
      await pool.end()
    }
  })
}
