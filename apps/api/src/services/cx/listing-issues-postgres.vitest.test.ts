import Fastify from 'fastify'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => (database.client as any)[key] }) }))
vi.mock('../../jobs/cx-heartbeat.job.js', () => ({ runHeartbeatFor: vi.fn() }))
vi.mock('./token.service.js', () => ({ refreshNow: vi.fn(), revoke: vi.fn(), RefreshFailed: class extends Error {}, RefreshContended: class extends Error {} }))
vi.mock('./ingress/ebay-admission.js', () => ({ listOwnEbayQuarantine: vi.fn(), adoptEbayQuarantine: vi.fn(), EbayAdmissionError: class extends Error {} }))
const { default: routes } = await import('../../routes/cx-connections.routes.js')
const A = 'nexus_legacy_workspace', B = randomUUID(), C = randomUUID()
const inProfile = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const app = Fastify()
const ids: Record<string, string> = {}
const time = new Date('2026-09-25T01:00:00.000Z')
const read = (account: string, query = '', workspace = A) => app.inject({ url: `/api/cx/connections/${account}/listing-issues${query}`, headers: { 'x-test-workspace': workspace } })

describe.skipIf(!concurrentDatabaseUrl())('saved listing issues under PostgreSQL RLS', () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No vendor calls in a stored issue read') }))
    database = await concurrentDatabase()
    for (const id of [B, C]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [id])
    for (const [name, workspace] of [['a', A], ['other', A], ['b', B]] as const) {
      await inProfile(workspace, async () => {
        const connection = await database.client.channelConnection.create({ data: { channelType: 'AMAZON' } })
        const product = await database.client.product.create({ data: { sku: `sku-${name}`, name, basePrice: 12 } })
        const listing = await database.client.channelListing.create({ data: { productId: product.id, channel: 'AMAZON', channelMarket: 'AMAZON_IT', region: 'EU', marketplace: 'IT', channelConnectionId: connection.id } })
        ids[name] = connection.id; ids[`${name}Listing`] = listing.id
        for (const [index, resolvedAt] of [null, null, null, time].entries()) {
          const issue = await database.client.listingIssue.create({ data: { listingId: listing.id, code: `issue-${index}`, message: `${name}-${index}`, fingerprint: `${index}`, attributeNames: ['size'], categories: [], resolvedAt, firstSeenAt: time, lastSeenAt: index === 2 ? new Date(time.getTime() - 60_000) : time } })
          ids[`${name}Issue${index}`] = issue.id
        }
      })
    }
    // A guest can see the shared account, but only its own listings and issues.
    await database.pool.query('INSERT INTO "ChannelAccountGrant" ("connectionId","workspaceId","ownerWorkspaceId",mode,"grantedByUserId") VALUES ($1,$2,$3,\'publish\',\'test\')', [ids.a, B, A])
    await inProfile(B, async () => {
      const product = await database.client.product.create({ data: { sku: 'guest-sku', name: 'Guest product', basePrice: 12 } })
      const listing = await database.client.channelListing.create({ data: { productId: product.id, channel: 'AMAZON', channelMarket: 'AMAZON_IT', region: 'EU', marketplace: 'IT', channelConnectionId: ids.a } })
      ids.guestListing = listing.id
      const issue = await database.client.listingIssue.create({ data: { listingId: listing.id, code: 'guest', message: 'Guest issue', fingerprint: 'guest', attributeNames: [], categories: [] } })
      ids.guestIssue = issue.id
    })
    app.addHook('onRequest', (request, _reply, done) => inProfile(String(request.headers['x-test-workspace']), done))
    await app.register(routes, { prefix: '/api' }); await app.ready()
  }, 180_000)
  afterAll(async () => { await app.close(); await database?.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals() }, 60_000)

  it('reads only unresolved findings for the selected account and current profile', async () => {
    const response = await read(ids.a)
    expect(response.statusCode).toBe(200)
    expect(response.json().items.map((row: any) => row.id).sort()).toEqual([ids.aIssue0, ids.aIssue1, ids.aIssue2].sort())
    expect(response.json().items.every((row: any) => row.productSku === 'sku-a')).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('denies another profile’s private account', async () => {
    expect((await read(ids.b)).statusCode).toBe(404)
    expect((await read(ids.a, '', C)).statusCode).toBe(404)
  })
  it('shows guest-owned issues on a shared account without disclosing owner issues', async () => {
    const response = await read(ids.a, '', B)
    expect(response.statusCode).toBe(200)
    expect(response.json().items.map((row: any) => row.id)).toEqual([ids.guestIssue])
  })
  it('uses a deterministic tie-breaker across bounded pages', async () => {
    const found: string[] = []; let after: string | null = null
    for (let i = 0; i < 3; i++) {
      const response = await read(ids.a, `?take=1${after ? `&after=${encodeURIComponent(after)}` : ''}`)
      expect(response.statusCode).toBe(200)
      const page = response.json(); expect(page.items).toHaveLength(1)
      found.push(page.items[0].id); after = page.nextCursor
    }
    expect(found).toEqual([... [ids.aIssue0, ids.aIssue1].sort(), ids.aIssue2])
    expect(after).toBeNull()
  })
  it('rejects a cursor reused for another account, profile or listing filter', async () => {
    const cursor = (await read(ids.a, '?take=1')).json().nextCursor
    expect(typeof cursor).toBe('string')
    for (const [account, workspace, extra] of [[ids.other, A, ''], [ids.a, B, ''], [ids.a, A, `&listingId=${ids.aListing}`]]) {
      expect((await read(account, `?after=${encodeURIComponent(cursor)}${extra}`, workspace)).statusCode).toBe(400)
    }
  })
  it('filters by a listing without escaping account or profile ownership', async () => {
    expect((await read(ids.a, `?listingId=${ids.aListing}`)).json().items).toHaveLength(3)
    expect((await read(ids.a, `?listingId=${ids.bListing}`)).json().items).toEqual([])
    expect((await read(ids.a, `?listingId=${ids.otherListing}`)).json().items).toEqual([])
  })
  it('continues after a cursor row is resolved between requests', async () => {
    const first = (await read(ids.a, '?take=1')).json()
    expect(first.items).toHaveLength(1)
    await database.pool.query('UPDATE "ListingIssue" SET "resolvedAt"=now() WHERE id=$1', [first.items[0].id])
    try {
      const page = await read(ids.a, `?after=${encodeURIComponent(first.nextCursor)}`)
      expect(page.statusCode).toBe(200)
      expect(page.json().items.map((row: any) => row.id).sort()).toEqual([ids.aIssue0, ids.aIssue1, ids.aIssue2].filter(id => id !== first.items[0].id).sort())
    } finally { await database.pool.query('UPDATE "ListingIssue" SET "resolvedAt"=NULL WHERE id=$1', [first.items[0].id]) }
  })
})
