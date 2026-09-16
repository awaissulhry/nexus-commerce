/**
 * BP.S2 — per-person account access.
 *
 * Real disposable PostgreSQL with the real generated policies. The service states the
 * limit; the RESTRICTIVE policy `nexus_account_restriction` is what enforces it. Only
 * running both together shows whether a limit that saved actually bites.
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
const WS = 'ws_bps2'
const OTHER_WS = 'ws_bps2_other'

describe('BP.S2 — which accounts one person may reach', () => {
  let service: typeof import('./member-account-access.service.js')
  let ownerUser: string, staffUser: string, secondOwner: string
  let staffMembership: string, ownerMembership: string, secondOwnerMembership: string
  let allowed: string, denied: string, elsewhere: string

  const asOwner = <T>(work: () => Promise<T>) =>
    withWorkspace({ workspaceId: WS, actorUserId: ownerUser, membershipId: null, roleKeys: ['OWNER'] }, work)
  const asStaff = <T>(work: () => Promise<T>) =>
    withWorkspace({ workspaceId: WS, actorUserId: staffUser, membershipId: null, roleKeys: ['VIEWER'] }, work)
  const visible = () => database.client.channelConnection.findMany({ select: { id: true } }).then(r => r.map(x => x.id).sort())

  beforeAll(async () => {
    database = await formulaDatabase()
    process.env.NEXUS_WORKSPACES_ENABLED = '1'
    service = await import('./member-account-access.service.js')

    const ownerRole = randomUUID(), viewerRole = randomUUID()
    await database.db.query(`INSERT INTO "Role" (id,key,name,"isSystem","updatedAt") VALUES ($1,'OWNER','Owner',true,CURRENT_TIMESTAMP)`, [ownerRole])
    await database.db.query(`INSERT INTO "Role" (id,key,name,"isSystem",permissions,"updatedAt") VALUES ($1,'VIEWER','Viewer',true,ARRAY['products.view'],CURRENT_TIMESTAMP)`, [viewerRole])
    ownerUser = randomUUID(); staffUser = randomUUID(); secondOwner = randomUUID()
    for (const id of [ownerUser, staffUser, secondOwner]) {
      await database.db.query(`INSERT INTO "UserProfile" (id,email,status,"updatedAt") VALUES ($1,$2,'active',CURRENT_TIMESTAMP)`, [id, `${id}@example.test`])
    }
    for (const [id, name] of [[WS, 'Business'], [OTHER_WS, 'Somebody else']]) {
      await database.db.query(`INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$2,'active','bps2',$1,CURRENT_TIMESTAMP)`, [id, name])
    }
    const member = async (ws: string, user: string, role: string) => {
      const id = randomUUID()
      await database.db.query(`INSERT INTO "WorkspaceMembership" (id,"workspaceId","userId",status,"updatedAt") VALUES ($1,$2,$3,'active',CURRENT_TIMESTAMP)`, [id, ws, user])
      await database.db.query(`INSERT INTO "WorkspaceMemberRole" ("membershipId","roleId") VALUES ($1,$2)`, [id, role])
      return id
    }
    ownerMembership = await member(WS, ownerUser, ownerRole)
    staffMembership = await member(WS, staffUser, viewerRole)
    secondOwnerMembership = await member(WS, secondOwner, ownerRole)

    const connection = async (ws: string, seller: string) => {
      const id = randomUUID()
      await database.db.query(
        `INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","managedBy","authStatus","isActive","externalAccountId","updatedAt")
         VALUES ($1,$2,'EBAY','oauth','connected',true,$3,CURRENT_TIMESTAMP)`, [id, ws, seller])
      return id
    }
    allowed = await connection(WS, 'seller-allowed')
    denied = await connection(WS, 'seller-denied')
    elsewhere = await connection(OTHER_WS, 'seller-elsewhere')
  }, 180_000)

  afterAll(async () => {
    if (flagBefore === undefined) delete process.env.NEXUS_WORKSPACES_ENABLED
    else process.env.NEXUS_WORKSPACES_ENABLED = flagBefore
    await database?.close()
  }, 30_000)

  it('CONTROL — with no limit set, a plain member sees every account', async () => {
    expect(await asStaff(visible)).toEqual([allowed, denied].sort())
  })

  it('an owner limits the member to one account', async () => {
    const saved = await asOwner(() => service.setMemberAccountAccess({ membershipId: staffMembership, restricted: true, connectionIds: [allowed] }))
    expect(saved).toMatchObject({ membershipId: staffMembership, restricted: true, connectionIds: [allowed] })
  })

  it('and the limit BITES — the member now sees only that account', async () => {
    expect(await asStaff(visible)).toEqual([allowed])
  })

  it('the member cannot reach the denied account even by naming its id', async () => {
    expect(await asStaff(() => database.client.channelConnection.findUnique({ where: { id: denied } }))).toBeNull()
  })

  it('the member cannot WRITE the denied account', async () => {
    const changed = await asStaff(() => database.client.channelConnection.updateMany({ where: { id: denied }, data: { accountLabel: 'hijack' } }))
    expect(changed.count).toBe(0)
  })

  it('CONTROL — the member can still write the ALLOWED account, so 0 above means refused', async () => {
    const changed = await asStaff(() => database.client.channelConnection.updateMany({ where: { id: allowed }, data: { accountLabel: 'mine' } }))
    expect(changed.count).toBe(1)
  })

  it('CONTROL — the owner is unaffected', async () => {
    expect(await asOwner(visible)).toEqual([allowed, denied].sort())
  })

  it('CONTROL — a job with no person is unrestricted', async () => {
    const seen = await withWorkspace({ workspaceId: WS, actorUserId: null, membershipId: null, roleKeys: [] }, visible)
    expect(seen).toEqual([allowed, denied].sort())
  })

  it('🔴 restricted with an EMPTY list means NO accounts, not all of them', async () => {
    await asOwner(() => service.setMemberAccountAccess({ membershipId: staffMembership, restricted: true, connectionIds: [] }))
    expect(await asStaff(visible)).toEqual([])
  })

  it('lifting the limit restores every account', async () => {
    await asOwner(() => service.setMemberAccountAccess({ membershipId: staffMembership, restricted: false }))
    expect(await asStaff(visible)).toEqual([allowed, denied].sort())
  })

  it('an unknown account id is REFUSED, never silently dropped', async () => {
    await expect(asOwner(() => service.setMemberAccountAccess({ membershipId: staffMembership, restricted: true, connectionIds: [allowed, randomUUID()] })))
      .rejects.toMatchObject({ code: 'unknown_account', statusCode: 400 })
  })

  it("another business's account cannot be put on the list", async () => {
    await expect(asOwner(() => service.setMemberAccountAccess({ membershipId: staffMembership, restricted: true, connectionIds: [elsewhere] })))
      .rejects.toMatchObject({ code: 'unknown_account' })
  })

  it('🔴 an owner cannot limit THEMSELVES out of their own accounts', async () => {
    await expect(asOwner(() => service.setMemberAccountAccess({ membershipId: ownerMembership, restricted: true, connectionIds: [] })))
      .rejects.toMatchObject({ code: 'owner_self_restriction', statusCode: 409 })
  })

  it('nor limit another OWNER, who reaches everything by role anyway', async () => {
    await expect(asOwner(() => service.setMemberAccountAccess({ membershipId: secondOwnerMembership, restricted: true, connectionIds: [allowed] })))
      .rejects.toMatchObject({ code: 'owner_not_restrictable', statusCode: 409 })
  })

  it('a member who is not an owner cannot set anyone’s limit', async () => {
    await expect(asStaff(() => service.setMemberAccountAccess({ membershipId: staffMembership, restricted: false })))
      .rejects.toMatchObject({ code: 'workspace_owner_required' })
  })

  it('an API key context has no person, so it cannot set a limit', async () => {
    await expect(withWorkspace({ workspaceId: WS, actorUserId: null, membershipId: null, roleKeys: [] },
      () => service.setMemberAccountAccess({ membershipId: staffMembership, restricted: false })),
    ).rejects.toMatchObject({ code: 'session_required' })
  })

  it('a membership from another business is 404, not an id that happens to work', async () => {
    const outsider = randomUUID()
    await database.db.query(`INSERT INTO "WorkspaceMembership" (id,"workspaceId","userId",status,"updatedAt") VALUES ($1,$2,$3,'active',CURRENT_TIMESTAMP)`, [outsider, OTHER_WS, secondOwner])
    await expect(asOwner(() => service.setMemberAccountAccess({ membershipId: outsider, restricted: true, connectionIds: [] })))
      .rejects.toMatchObject({ code: 'member_unavailable', statusCode: 404 })
  })

  it('the list reads back what was set, for the whole team', async () => {
    await asOwner(() => service.setMemberAccountAccess({ membershipId: staffMembership, restricted: true, connectionIds: [allowed] }))
    const rows = await asOwner(() => service.listMemberAccountAccess())
    const staff = rows.find(r => r.membershipId === staffMembership)
    expect(staff).toMatchObject({ restricted: true, connectionIds: [allowed] })
    expect(rows.find(r => r.membershipId === ownerMembership)).toMatchObject({ restricted: false, connectionIds: [] })
  })

  it('🔴 the restricted member can still read their OWN allow-list — hiding it would lock them out entirely', async () => {
    const own = await asStaff(() => database.client.workspaceMemberAccount.findMany({ where: { membershipId: staffMembership } }))
    expect(own.map(r => r.connectionId)).toEqual([allowed])
  })

  it('🔴 the restricted member cannot delete their own limit row and free themselves', async () => {
    const removed = await asStaff(() => database.client.workspaceMemberAccountLimit.deleteMany({ where: { membershipId: staffMembership } }))
    expect(removed.count).toBe(0)
    expect(await asStaff(visible)).toEqual([allowed])
  })

  it('deleting an account removes it from every allow-list, so a re-used id cannot re-grant access', async () => {
    const throwaway = randomUUID()
    await database.db.query(
      `INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","managedBy","authStatus","isActive","externalAccountId","updatedAt")
       VALUES ($1,$2,'ETSY','oauth','connected',true,$3,CURRENT_TIMESTAMP)`, [throwaway, WS, 'seller-throwaway'])
    await asOwner(() => service.setMemberAccountAccess({ membershipId: staffMembership, restricted: true, connectionIds: [allowed, throwaway] }))
    await database.db.query(`DELETE FROM "ChannelConnection" WHERE id = $1`, [throwaway])
    const rows = await asOwner(() => service.listMemberAccountAccess())
    expect(rows.find(r => r.membershipId === staffMembership)?.connectionIds).toEqual([allowed])
  })
})
