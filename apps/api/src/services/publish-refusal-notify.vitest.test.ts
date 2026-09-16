/**
 * A refused publish into a shared seller account must reach a person — the right
 * people, only them, and not a thousand times.
 *
 * Real disposable PostgreSQL with the real generated policies: who can read a
 * notification is decided by the Notification isolation policy as much as by this
 * service, and only both together say whether the right person sees it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { formulaDatabase } from '../test-support/formula-database.js'
import { withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({} as Record<string, unknown>, { get: (_t, p) => (database.client as unknown as Record<string, unknown>)[p as string] }),
}))

const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const GUEST = 'ws_guest_notify'
const OWNER_BIZ = 'ws_ownerbiz_notify'

describe('a refused publish reaches a person', () => {
  let notify: typeof import('./publish-refusal-notify.service.js')
  let guestOwner: string, guestStaff: string, otherBizOwner: string, strangerUser: string
  let listingId: string, productId: string

  const inGuest = <T>(actor: string | null, work: () => Promise<T>) =>
    withWorkspace({ workspaceId: GUEST, actorUserId: actor, membershipId: null, roleKeys: [] }, work)
  const bell = (workspaceId: string, userId: string) =>
    withWorkspace({ workspaceId, actorUserId: userId, membershipId: null, roleKeys: [] },
      () => database.client.notification.findMany({ where: { userId, type: 'publish-refused-shared-account' } }))

  beforeAll(async () => {
    database = await formulaDatabase()
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    notify = await import('./publish-refusal-notify.service.js')

    const ownerRole = randomUUID(), viewerRole = randomUUID()
    await database.db.query(`INSERT INTO "Role" (id,key,name,"isSystem","updatedAt") VALUES ($1,'OWNER','Owner',true,CURRENT_TIMESTAMP)`, [ownerRole])
    await database.db.query(`INSERT INTO "Role" (id,key,name,"isSystem",permissions,"updatedAt") VALUES ($1,'VIEWER','Viewer',true,ARRAY['products.view'],CURRENT_TIMESTAMP)`, [viewerRole])
    guestOwner = randomUUID(); guestStaff = randomUUID(); otherBizOwner = randomUUID(); strangerUser = randomUUID()
    for (const id of [guestOwner, guestStaff, otherBizOwner, strangerUser]) {
      await database.db.query(`INSERT INTO "UserProfile" (id,email,status,"updatedAt") VALUES ($1,$2,'active',CURRENT_TIMESTAMP)`, [id, `${id}@example.test`])
    }
    for (const [id, name] of [[GUEST, 'Guest business'], [OWNER_BIZ, 'Owner business']]) {
      await database.db.query(`INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$2,'active','n',$1,CURRENT_TIMESTAMP)`, [id, name])
    }
    const member = async (ws: string, user: string, role: string) => {
      const m = randomUUID()
      await database.db.query(`INSERT INTO "WorkspaceMembership" (id,"workspaceId","userId",status,"updatedAt") VALUES ($1,$2,$3,'active',CURRENT_TIMESTAMP)`, [m, ws, user])
      await database.db.query(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [m, role])
    }
    await member(GUEST, guestOwner, ownerRole)
    await member(GUEST, guestStaff, viewerRole)
    await member(OWNER_BIZ, otherBizOwner, ownerRole)
    // strangerUser belongs to no business at all

    productId = randomUUID(); listingId = randomUUID()
    await database.db.query(`INSERT INTO "Product" (id,"workspaceId",sku,name,"basePrice","updatedAt") VALUES ($1,$2,'SKU-N','Race Jacket',0,CURRENT_TIMESTAMP)`, [productId, GUEST])
    await database.db.query(
      `INSERT INTO "ChannelListing" (id,"workspaceId","productId","channelMarket",channel,region,marketplace,"updatedAt")
       VALUES ($1,$2,$3,'EBAY_IT','EBAY','IT','IT',CURRENT_TIMESTAMP)`, [listingId, GUEST, productId])
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 30_000)

  const refusal = () => [{
    channelListingId: listingId, sellerSku: 'SKU-N', marketplace: 'IT',
    reason: 'held', heldByWorkspaceName: 'Owner business',
  }]

  it('a background refusal (no actor) reaches the refused business’s OWNER', async () => {
    const result = await inGuest(null, () => notify.notifyPublishRefused(refusal()))
    expect(result.created).toBe(1)
    const rows = await bell(GUEST, guestOwner)
    expect(rows).toHaveLength(1)
  })

  it('and it says what happened, who holds it, and the two ways out', async () => {
    const [row] = await bell(GUEST, guestOwner)
    expect(row.severity).toBe('warn')
    expect(row.title).toBe('Race Jacket was not published')
    expect(row.body).toContain('Owner business already publishes SKU-N')
    expect(row.body).toContain('Use a different seller SKU')
    expect(row.body).toContain('ask Owner business')
    expect(row.href).toBe(`/products/${productId}/edit`)
  })

  it('🔴 it does NOT reach a non-owner who did not cause it', async () => {
    expect(await bell(GUEST, guestStaff)).toHaveLength(0)
  })

  it('🔴 and NEVER reaches another business — the notice names it, so this would leak', async () => {
    expect(await bell(OWNER_BIZ, otherBizOwner)).toHaveLength(0)
  })

  it('🔴 nor someone who belongs to no business (the old notifier’s every-user fan-out)', async () => {
    const all = await database.db.query(`SELECT count(*)::int n FROM "Notification" WHERE "userId" = $1`, [strangerUser])
    expect(all.rows[0].n).toBe(0)
  })

  it('🔴 re-firing on every edit does NOT stack — one unread notice per listing', async () => {
    for (let i = 0; i < 25; i++) await inGuest(null, () => notify.notifyPublishRefused(refusal()))
    expect(await bell(GUEST, guestOwner)).toHaveLength(1)
  })

  it('once the owner has READ it, a recurrence is new information and notifies again', async () => {
    await database.db.query(`UPDATE "Notification" SET "readAt" = now() WHERE "userId" = $1`, [guestOwner])
    const again = await inGuest(null, () => notify.notifyPublishRefused(refusal()))
    expect(again.created).toBe(1)
    expect(await bell(GUEST, guestOwner)).toHaveLength(2)
  })

  it('when a PERSON caused it, they are told too — even if they are not an owner', async () => {
    const result = await inGuest(guestStaff, () => notify.notifyPublishRefused(refusal()))
    expect(await bell(GUEST, guestStaff)).toHaveLength(1)
    expect(result.created).toBeGreaterThanOrEqual(1)
  })

  it('a listing with no single seller SKU gets its own, accurate explanation', async () => {
    const otherListing = randomUUID()
    await database.db.query(
      `INSERT INTO "ChannelListing" (id,"workspaceId","productId","channelMarket",channel,region,marketplace,"updatedAt")
       VALUES ($1,$2,$3,'EBAY_DE','EBAY','DE','DE',CURRENT_TIMESTAMP)`, [otherListing, GUEST, productId])
    await inGuest(null, () => notify.notifyPublishRefused([{ channelListingId: otherListing, sellerSku: null, marketplace: 'DE', reason: 'x' }]))
    const rows = await withWorkspace({ workspaceId: GUEST, actorUserId: guestOwner, membershipId: null, roleKeys: [] },
      () => database.client.notification.findMany({ where: { userId: guestOwner, entityId: otherListing } }))
    expect(rows[0].body).toContain('more than one seller SKU')
    expect(rows[0].body).toContain('eBay DE')
    expect(rows[0].body).not.toContain('EBAY')
  })

  it('the account phrase never doubles or dangles a word, whatever is missing', () => {
    expect(notify.accountPhrase('EBAY', 'IT')).toBe('the shared eBay IT account')
    expect(notify.accountPhrase('AMAZON', 'DE')).toBe('the shared Amazon DE account')
    expect(notify.accountPhrase('SHOPIFY', 'GLOBAL')).toBe('the shared Shopify account')
    expect(notify.accountPhrase('EBAY', 'DEFAULT')).toBe('the shared eBay account')
    expect(notify.accountPhrase(undefined, 'IT')).toBe('the shared account')
    expect(notify.accountPhrase(null, null)).toBe('the shared account')
  })

  it('never throws — a notify failure must not turn a refused publish into a failed request', async () => {
    // No business context at all: requireWorkspace() throws inside. It must be swallowed.
    await expect(notify.notifyPublishRefused(refusal())).resolves.toEqual({ created: 0, deduped: 0 })
  })
})
