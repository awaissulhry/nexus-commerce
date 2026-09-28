/**
 * BP.S1c — sharing a seller account with another business.
 *
 * Real disposable PostgreSQL with the real generated policies, for the same reason
 * as BP.S1b: the service's rules and the RLS backstop have to be checked together.
 * A mocked prisma would let one pass while the other was wrong.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { formulaDatabase } from '../test-support/formula-database.js'
import { withWorkspace } from '../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({
  default: new Proxy({} as Record<string, unknown>, {
    get: (_t, property) => (database.client as unknown as Record<string, unknown>)[property as string],
  }),
}))

const flagBefore = process.env.NEXUS_WORKSPACES_ENABLED
const A = 'ws_a_bps1c' // owns the account
const B = 'ws_b_bps1c' // the guest
const C = 'ws_c_bps1c' // a third business the actor does NOT own
const D = 'ws_d_bps1c' // a fourth the actor DOES own, so a refusal can only be about the account

describe('BP.S1c — share, list and revoke', () => {
  let service: typeof import('./channel-account-grant.service.js')
  let connectionId: string
  let ownerUser: string
  let staffUser: string

  const asOwnerOfA = <T>(work: () => Promise<T>) =>
    withWorkspace({ workspaceId: A, actorUserId: ownerUser, membershipId: null, roleKeys: ['OWNER'] }, work)

  beforeAll(async () => {
    database = await formulaDatabase()
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    service = await import('./channel-account-grant.service.js')

    const ownerRole = randomUUID()
    const viewerRole = randomUUID()
    await database.db.query(`INSERT INTO "Role" (id, key, name, "isSystem", "updatedAt") VALUES ($1,'OWNER','Owner',true,CURRENT_TIMESTAMP)`, [ownerRole])
    await database.db.query(`INSERT INTO "Role" (id, key, name, "isSystem", permissions, "updatedAt") VALUES ($1,'VIEWER','Viewer',true,ARRAY['products.view'],CURRENT_TIMESTAMP)`, [viewerRole])

    ownerUser = randomUUID()
    staffUser = randomUUID()
    for (const id of [ownerUser, staffUser]) {
      await database.db.query(`INSERT INTO "UserProfile" (id, email, status, "updatedAt") VALUES ($1,$2,'active',CURRENT_TIMESTAMP)`, [id, `${id}@example.test`])
    }
    for (const [id, name] of [[A, 'Business A'], [B, 'Business B'], [C, 'Business C'], [D, 'Business D']]) {
      await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1,$2,'active','bps1c',$1,CURRENT_TIMESTAMP)`, [id, name])
    }
    const member = async (workspaceId: string, userId: string, roleId: string) => {
      const id = randomUUID()
      await database.db.query(`INSERT INTO "WorkspaceMembership" (id, "workspaceId", "userId", status, "updatedAt") VALUES ($1,$2,$3,'active',CURRENT_TIMESTAMP)`, [id, workspaceId, userId])
      await database.db.query(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [id, roleId])
    }
    await member(A, ownerUser, ownerRole)
    await member(B, ownerUser, ownerRole)
    await member(C, ownerUser, viewerRole) // a member of C, but NOT its owner
    await member(D, ownerUser, ownerRole)
    await member(A, staffUser, viewerRole) // in A, but not its owner

    connectionId = randomUUID()
    await database.db.query(
      `INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","managedBy","authStatus","isActive","externalAccountId","updatedAt")
       VALUES ($1,$2,'EBAY','oauth','connected',true,$3,CURRENT_TIMESTAMP)`,
      [connectionId, A, 'seller-bps1c'],
    )
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 30_000)

  it('CONTROL — an owner of both businesses shares the account', async () => {
    const grant = await asOwnerOfA(() => service.shareAccount({ connectionId, destinationWorkspaceId: B }))
    expect(grant).toMatchObject({ connectionId, workspaceId: B, ownerWorkspaceId: A, mode: 'read', revokedAt: null })
    expect(grant.workspaceName).toBe('Business B')
  })

  it('writes an audit record in BOTH businesses', async () => {
    const rows = await database.db.query<{ workspaceId: string; action: string }>(
      `SELECT "workspaceId", action FROM "WorkspaceAudit" WHERE action = 'account.shared' ORDER BY "workspaceId"`,
    )
    expect(rows.rows.map(r => r.workspaceId)).toEqual([A, B])
  })

  it('the owner lists the share, with the guest business named', async () => {
    const grants = await asOwnerOfA(() => service.listSharesFor(connectionId))
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({ workspaceId: B, workspaceName: 'Business B', revokedAt: null })
  })

  it('the guest can see what was shared with it, and by whom', async () => {
    const shared = await withWorkspace({ workspaceId: B, actorUserId: ownerUser, membershipId: null, roleKeys: ['OWNER'] },
      () => service.listSharedWithCurrent())
    expect(shared).toEqual([{ connectionId, ownerWorkspaceId: A, ownerWorkspaceName: 'Business A', mode: 'read', marketplaces: [] }])
  })

  // The destination is a business this actor genuinely OWNS, so the only thing left
  // to refuse is the account itself. Pointed at C (owned by nobody here) this passed
  // for the wrong reason — 'workspace_owner_required', a true refusal saying
  // something untrue.
  it('🔴 the guest CANNOT share on further an account it only borrows', async () => {
    await expect(withWorkspace({ workspaceId: B, actorUserId: ownerUser, membershipId: null, roleKeys: ['OWNER'] },
      () => service.shareAccount({ connectionId, destinationWorkspaceId: D })),
    ).rejects.toMatchObject({ code: 'account_not_owned', statusCode: 403 })
  })

  it('CONTROL — the same actor CAN share that destination an account it owns', async () => {
    const grant = await asOwnerOfA(() => service.shareAccount({ connectionId, destinationWorkspaceId: D }))
    expect(grant).toMatchObject({ workspaceId: D, ownerWorkspaceId: A })
    await asOwnerOfA(() => service.revokeShare({ connectionId, workspaceId: D }))
  })

  it('a member of the owning business who is not its OWNER is refused', async () => {
    await expect(withWorkspace({ workspaceId: A, actorUserId: staffUser, membershipId: null, roleKeys: ['VIEWER'] },
      () => service.shareAccount({ connectionId, destinationWorkspaceId: B })),
    ).rejects.toMatchObject({ code: 'workspace_owner_required' })
  })

  it('an owner here gets no authority in a business they merely belong to', async () => {
    await expect(asOwnerOfA(() => service.shareAccount({ connectionId, destinationWorkspaceId: C })))
      .rejects.toMatchObject({ code: 'workspace_owner_required' })
  })

  it('an API key context has no actor, so it can never share', async () => {
    await expect(withWorkspace({ workspaceId: A, actorUserId: null, membershipId: null, roleKeys: [] },
      () => service.shareAccount({ connectionId, destinationWorkspaceId: B })),
    ).rejects.toMatchObject({ code: 'session_required' })
  })

  // BP.S3 turned 'publish' on. What must still be refused is a mode nobody defined.
  it("accepts 'publish' since BP.S3, and refuses a mode nobody defined", async () => {
    const granted = await asOwnerOfA(() => service.shareAccount({ connectionId, destinationWorkspaceId: B, mode: 'publish' }))
    expect(granted.mode).toBe('publish')
    await expect(asOwnerOfA(() => service.shareAccount({ connectionId, destinationWorkspaceId: B, mode: 'delete-everything' })))
      .rejects.toMatchObject({ code: 'grant_mode_unavailable', statusCode: 400 })
    // leave it as it was for the arms below
    await asOwnerOfA(() => service.shareAccount({ connectionId, destinationWorkspaceId: B, mode: 'read' }))
  })

  it('refuses a share to the owning business itself', async () => {
    await expect(asOwnerOfA(() => service.shareAccount({ connectionId, destinationWorkspaceId: A })))
      .rejects.toMatchObject({ code: 'invalid_destination' })
  })

  it('refuses a malformed marketplace list rather than silently widening the share', async () => {
    for (const bad of ['IT', [{}], ['IT', 'a space'], ['IT', '']]) {
      await expect(asOwnerOfA(() => service.shareAccount({ connectionId, destinationWorkspaceId: B, marketplaces: bad })))
        .rejects.toMatchObject({ code: 'invalid_marketplaces' })
    }
  })

  it('narrows a share to named marketplaces, de-duplicated', async () => {
    const grant = await asOwnerOfA(() => service.shareAccount({ connectionId, destinationWorkspaceId: B, marketplaces: ['IT', 'DE', 'IT'] }))
    expect(grant.marketplaces).toEqual(['IT', 'DE'])
  })

  it('revokes, and a second revoke reports that it changed nothing', async () => {
    expect(await asOwnerOfA(() => service.revokeShare({ connectionId, workspaceId: B }))).toEqual({ revoked: true })
    expect(await asOwnerOfA(() => service.revokeShare({ connectionId, workspaceId: B }))).toEqual({ revoked: false })
  })

  it('the guest loses the account the moment the share is revoked', async () => {
    await withWorkspace({ workspaceId: B, actorUserId: ownerUser, membershipId: null, roleKeys: ['OWNER'] }, async () => {
      expect(await database.client.channelConnection.findUnique({ where: { id: connectionId } })).toBeNull()
      expect(await service.listSharedWithCurrent()).toEqual([])
    })
  })

  it('re-sharing reuses the SAME row and clears the revocation, so history stays in one place', async () => {
    const grant = await asOwnerOfA(() => service.shareAccount({ connectionId, destinationWorkspaceId: B }))
    expect(grant.revokedAt).toBeNull()
    const rows = await database.db.query<{ n: number }>(`SELECT count(*)::int n FROM "ChannelAccountGrant" WHERE "connectionId" = $1 AND "workspaceId" = $2`, [connectionId, B])
    expect(rows.rows[0].n).toBe(1)
    // and the marketplaces from the narrowed share above were replaced, not merged
    expect(grant.marketplaces).toEqual([])
  })

  it('a missing account is 404, not a leak of whether it exists elsewhere', async () => {
    await expect(asOwnerOfA(() => service.listSharesFor(randomUUID())))
      .rejects.toMatchObject({ code: 'account_unavailable', statusCode: 404 })
  })

  it('the guest\'s primary and "only account" are its own; a shared account is used only when named (2026-09-28)', async () => {
    const resolver = await import('./connection-resolver.service.js')
    const asB = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: B, actorUserId: ownerUser, membershipId: null, roleKeys: ['OWNER'] }, work)
    // A's account is A's primary; B has a primary eBay account of its own; the share above is active.
    await database.db.query(`UPDATE "ChannelConnection" SET "isPrimary" = true WHERE id = $1`, [connectionId])
    const own = randomUUID()
    await database.db.query(
      `INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","managedBy","authStatus","isActive","isPrimary","externalAccountId","updatedAt")
       VALUES ($1,$2,'EBAY','oauth','connected',true,true,$3,CURRENT_TIMESTAMP)`,
      [own, B, 'seller-bps1c-b'],
    )
    // CONTROL — B does see both accounts, each its owner's primary: before 2026-09-28 every primary lookup of B threw.
    const seen = await asB(() => resolver.listActiveConnections('EBAY'))
    expect(seen.map((r) => [r.id, r.isPrimary])).toEqual([[own, true], [connectionId, true]])
    expect((await asB(() => resolver.resolveConnection({ channel: 'EBAY', primary: true }))).id).toBe(own)
    expect(Object.fromEntries(await asB(() => resolver.primaryConnectionIds(['EBAY'])))).toEqual({ EBAY: own })
    // Named, the shared account still resolves.
    expect((await asB(() => resolver.resolveConnection({ accountId: connectionId }))).id).toBe(connectionId)
    // With no account of its own, B has no primary: the shared one never stands in for it.
    await database.db.query(`UPDATE "ChannelConnection" SET "isActive" = false, "isPrimary" = false WHERE id = $1`, [own])
    await expect(asB(() => resolver.resolveConnection({ channel: 'EBAY', primary: true }))).rejects.toBeInstanceOf(resolver.NoConnectionError)
    expect(Object.fromEntries(await asB(() => resolver.primaryConnectionIds(['EBAY'])))).toEqual({ EBAY: null })
    // A is unchanged: its account is its primary.
    expect((await asOwnerOfA(() => resolver.resolveConnection({ channel: 'EBAY', primary: true }))).id).toBe(connectionId)
  })
})
