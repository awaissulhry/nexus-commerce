import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool } from 'pg'
import { workspacePrisma } from '@nexus/database/workspace-router'
import { withWorkspace } from '@nexus/database/workspace-context'
import { describe, expect, it } from 'vitest'
import { whereCoordinate } from './listing-coordinate.js'

// Deliberate opt-in: writes only disposable DRAFT rows under XAVIA on local
// nexus_development. Announce the fixture in the ledger BEFORE opting in.
describe.runIf(process.env.PR3_LOCAL_DB_TESTS === '1')('whereCoordinate / local PostgreSQL', () => {
  it('explicit NULL matches only NULL; both readers and writers preserve the sibling', async () => {
    const url = new URL(process.env.DATABASE_URL!)
    expect(url.hostname).toBe('127.0.0.1')
    expect(url.port).toBe('55439')
    expect(url.pathname).toBe('/nexus_development')
    console.log(`PR.3 fixture DB host=${url.host}${url.pathname}`)
    const pool = new Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 5_000 })
    const db = workspacePrisma(pool)
    const marker = `PR3-COORD-${randomUUID()}`
    const residue = { OR: [{ externalListingId: { startsWith: marker } }, { aliasKey: { startsWith: marker } }] }
    await withWorkspace({ workspaceId: 'nexus_legacy_workspace', actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
      try {
        const identity = await db.$queryRaw<Array<{ db: string; role: string }>>`SELECT current_database()::text AS db, current_user::text AS role`
        expect(identity[0].db).toBe('nexus_development')
        console.log('server identity', identity)
        const gale = await db.product.findFirstOrThrow({ where: { id: 'cmokmy3a40078pm0p1fvnu523', sku: 'GALE-JACKET' }, select: { id: true, familyId: true } })
        expect(gale.familyId).toBe('cmtny43jv002jnjfbb6hnijqx')
        const connection = await db.channelListing.findFirstOrThrow({ where: { productId: gale.id, channel: 'AMAZON', marketplace: 'IT', aliasKey: '' }, select: { channelConnectionId: true } })
        expect(connection.channelConnectionId).toBeTruthy()
        const product = await db.product.create({ data: { sku: marker, name: marker, status: 'DRAFT', basePrice: 1, familyId: gale.familyId }, select: { id: true } })
        const c = { productId: product.id, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: null, aliasKey: `${marker}-a` }
        const attributed = { ...c, channelConnectionId: connection.channelConnectionId }
        const seed = (coordinate: typeof c, suffix: string) => ({ ...coordinate, channelMarket: 'AMAZON_IT', region: 'IT', externalListingId: `${marker}-${suffix}`, listingStatus: 'DRAFT' as const, isPublished: false, syncPaused: true })
        expect(await db.channelListing.count({ where: residue })).toBe(0)
        // Exercise rollback BEFORE the committed fixture: no append-only event.
        const rollback = new Error('PR3_FIXTURE_ROLLBACK')
        await expect(db.$transaction(async tx => { await tx.channelListing.create({ data: seed(c, 'rollback') }); throw rollback })).rejects.toThrow(rollback)
        expect(await db.channelListing.count({ where: residue })).toBe(0)
        await db.channelListing.createMany({ data: [seed(c, 'null'), seed(attributed, 'account')] })
        await delay(8_000)
        const all = await db.channelListing.findMany({ where: residue, select: { id: true, channelConnectionId: true, aliasKey: true } })
        expect(all).toHaveLength(2)
        expect(await db.channelListing.findMany({ where: whereCoordinate(c), select: { channelConnectionId: true } })).toEqual([{ channelConnectionId: null }])
        expect(await db.channelListing.count({ where: whereCoordinate(attributed) })).toBe(1)
        const before = await db.channelListing.findMany({ where: whereCoordinate(c), select: { id: true } })
        const written = await db.channelListing.updateMany({ where: whereCoordinate(c), data: { quantityOverride: 37 } })
        expect(written.count).toBe(before.length)
        expect(written.count).toBe(1)
        await delay(8_000)
        const after = await db.channelListing.findMany({ where: residue, select: { channelConnectionId: true, quantityOverride: true } })
        expect(after.find(row => row.channelConnectionId === null)?.quantityOverride).toBe(37)
        expect(after.find(row => row.channelConnectionId !== null)?.quantityOverride).toBeNull()
        // Alias isolation is independent of NULL-account isolation. The legacy
        // index disallows two aliases on one account: do not drop it for a test.
        expect((await db.channelListing.updateMany({ where: whereCoordinate(attributed), data: { aliasKey: `${marker}-b` } })).count).toBe(1)
        expect(await db.channelListing.count({ where: whereCoordinate(attributed) })).toBe(0)
        expect(await db.channelListing.count({ where: whereCoordinate({ ...attributed, aliasKey: `${marker}-b` }) })).toBe(1)
        console.log(JSON.stringify({ seeded: all.length, nullRead: before.length, narrowedWrite: written.count, siblingQuantity: after.find(row => row.channelConnectionId !== null)?.quantityOverride, aliasMismatch: 0, aliasMatch: 1 }))
      } finally {
        await db.channelListing.deleteMany({ where: residue })
        expect(await db.channelListing.count({ where: residue })).toBe(0)
        const products = { OR: [{ sku: { startsWith: marker } }, { name: { startsWith: marker } }] }
        await db.product.deleteMany({ where: products })
        expect(await db.product.count({ where: products })).toBe(0)
        console.log('PR.3 cleanup by sentinel externalListingId OR aliasKey / product sku OR name: 0 remaining')
        await db.$disconnect()
        await pool.end()
      }
    })
  }, 60_000)
})
