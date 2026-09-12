import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { formulaDatabase } from '../test-support/formula-database.js'
import { createWorkspaceService, validateWorkspaceInput } from './workspace.service.js'
import { captureWorkspace, requireWorkspace, withWorkspace, workspaceContext } from '../lib/workspace-context.js'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { createWorkspaceHook } from '../lib/workspace-hook.js'
import { sessionCookieName } from '../lib/auth/cookies.js'

describe('business profile boundaries with PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof formulaDatabase>>
  let service: ReturnType<typeof createWorkspaceService>
  let ownerId: string
  let viewerId: string
  const details = () => ({ name: 'Xavia Racing', country: 'IT', currency: 'EUR', timezone: 'Europe/Rome', creationKey: randomUUID() })
  const person = async () => database.client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active' } })

  beforeAll(async () => {
    database = await formulaDatabase()
    service = createWorkspaceService(database.client)
    ownerId = (await database.client.role.create({ data: { key: 'OWNER', name: 'Owner', isSystem: true } })).id
    viewerId = (await database.client.role.create({ data: { key: 'VIEWER', name: 'Viewer', isSystem: true, permissions: ['products.view'] } })).id
  }, 120_000)
  afterAll(async () => { await database?.close() }, 30_000)

  it('carries the verified identity into both SQL statements and SQL transactions', async () => {
    const context = { workspaceId: 'scope_database_test', actorUserId: 'actor_database_test', membershipId: null, roleKeys: [] }
    await withWorkspace(context, async () => {
      const query = () => database.client.$queryRaw<Array<{ workspace: string; actor: string }>>`SELECT current_setting('nexus.workspace_id') AS workspace, current_setting('nexus.actor_id') AS actor`
      expect(await query()).toEqual([{ workspace: context.workspaceId, actor: context.actorUserId }])
      await database.client.$transaction(async tx => {
        expect(await tx.$queryRaw`SELECT current_setting('nexus.workspace_id') AS workspace, current_setting('nexus.actor_id') AS actor`).toEqual([{ workspace: context.workspaceId, actor: context.actorUserId }])
        for (const statement of ['COMMIT', 'ROLLBACK', 'TRUNCATE "Product"', 'RESET ROLE', "SELECT set_config('nexus.workspace_id', 'foreign', true)", 'SELECT 1; RESET ROLE']) {
          await expect(Promise.resolve().then(() => tx.$executeRawUnsafe(statement))).rejects.toMatchObject({ code: 'workspace_scope_immutable' })
        }
      })
    })
  })

  it('creates settings and the owner together, with no channel accounts copied', async () => {
    const user = await person()
    const result = await service.create(user.id, details())
    const access = await service.membership(user.id, result.id)
    expect(access.isOwner).toBe(true)
    expect(access.context.workspaceId).toBe(result.id)
    const row = await withWorkspace(access.context, () => database.client.workspace.findUniqueOrThrow({ where: { id: result.id }, include: { settings: true, accounts: true, audit: true } }))
    expect(row.settings).toMatchObject({ currency: 'EUR', country: 'IT', timezone: 'Europe/Rome' })
    expect(row.accounts).toEqual([])
    expect(row.audit.map(event => event.action)).toEqual(['workspace.created'])
    const locations = await withWorkspace(access.context, () => database.client.stockLocation.findMany({ include: { warehouse: true } }))
    expect(locations).toHaveLength(1)
    expect(locations[0]).toMatchObject({ code: 'IT-MAIN', type: 'WAREHOUSE', warehouse: { isDefault: true, country: 'IT' } })
  })

  it('creates an independent default warehouse for the new business’s country', async () => {
    const user = await person()
    const a = await service.create(user.id, details())
    const b = await service.create(user.id, { ...details(), country: 'US', currency: 'USD', timezone: 'America/New_York' })
    const ca = (await service.membership(user.id, a.id)).context, cb = (await service.membership(user.id, b.id)).context
    const us = await withWorkspace(cb, () => database.client.stockLocation.findMany({ include: { warehouse: true } }))
    expect(us).toHaveLength(1)
    expect(us[0]).toMatchObject({ code: 'US-MAIN', warehouse: { country: 'US', isDefault: true } })
    expect(await withWorkspace(ca, () => database.client.stockLocation.findUnique({ where: { id: us[0].id } }))).toBeNull()
  })

  it('retries creation without duplicating a business, but rejects changed request contents', async () => {
    const user = await person()
    const input = details()
    const first = await service.create(user.id, input)
    const again = await service.create(user.id, input)
    expect(again.id).toBe(first.id)
    expect(await service.list(user.id)).toHaveLength(1)
    await expect(service.create(user.id, { ...input, currency: 'GBP' })).rejects.toMatchObject({ code: 'creation_conflict' })
  })

  it('does not let an owner in one business read or rename another business', async () => {
    const a = await person(), b = await person()
    await service.create(a.id, details())
    const foreign = await service.create(b.id, details())
    await expect(service.membership(a.id, foreign.id)).rejects.toMatchObject({ code: 'workspace_unavailable' })
    await expect(service.rename(a.id, foreign.id, 'Changed', 1)).rejects.toMatchObject({ code: 'workspace_unavailable' })
    expect(await service.list(a.id)).toHaveLength(1)
  })

  it('checks live membership and the user status without a permission cache', async () => {
    const user = await person()
    const profile = await service.create(user.id, details())
    const access = await service.membership(user.id, profile.id)
    await database.client.workspaceMembership.update({ where: { id: access.id }, data: { status: 'revoked' } })
    await expect(service.membership(user.id, profile.id)).rejects.toMatchObject({ code: 'workspace_unavailable' })
    await expect(service.create(user.id, { ...details(), creationKey: (await database.client.workspace.findUniqueOrThrow({ where: { id: profile.id } })).creationKey })).rejects.toMatchObject({ code: 'workspace_unavailable' })
    expect(await service.list(user.id)).toEqual([])
    await database.client.workspaceMembership.update({ where: { id: access.id }, data: { status: 'active' } })
    await database.client.userProfile.update({ where: { id: user.id }, data: { status: 'deactivated' } })
    await expect(service.membership(user.id, profile.id)).rejects.toMatchObject({ code: 'workspace_unavailable' })
  })

  it('offers connection destinations using each business membership, without combining roles', async () => {
    const user = await person(), otherOwner = await person()
    const owned = await service.create(user.id, details())
    const viewed = await service.create(otherOwner.id, details())
    const managed = await service.create(otherOwner.id, details())
    await database.client.workspaceMembership.create({ data: { workspaceId: viewed.id, userId: user.id, roles: { create: { roleId: viewerId } } } })
    const connector = await service.saveRole(otherOwner.id, managed.id, { name: 'Account connector', permissions: ['channels.connect'] })
    const grant = await service.invite(otherOwner.id, managed.id, { email: user.email, roleIds: [connector.id] })
    await service.acceptInvitation(user.id, grant.token)
    const destinations = await service.list(user.id)
    expect(destinations.find(profile => profile.id === owned.id)).toMatchObject({ canConnectAccounts: true, isOwner: true })
    expect(destinations.find(profile => profile.id === viewed.id)).toMatchObject({ canConnectAccounts: false, isOwner: false })
    expect(destinations.find(profile => profile.id === managed.id)).toMatchObject({ canConnectAccounts: true, isOwner: false })
    expect((await service.listPage(user.id, { permission: 'connect' })).workspaces.map(profile => profile.id).sort()).toEqual([owned.id, managed.id].sort())
    expect((await service.listPage(user.id, { permission: 'owner' })).workspaces.map(profile => profile.id)).toEqual([owned.id])
    await service.saveRole(otherOwner.id, managed.id, { name: 'Account connector', permissions: [], version: 1 }, connector.id)
    expect((await service.list(user.id)).find(profile => profile.id === managed.id)?.canConnectAccounts).toBe(false)
  })

  it('pages all profiles, searches past the first page and keeps cursors scoped to their filter', async () => {
    const user = await person(), stranger = await person()
    const ids: string[] = []
    for (let index = 0; index < 13; index++) ids.push((await service.create(user.id, { ...details(), name: `Xavia team ${index.toString().padStart(2, '0')}` })).id)
    await service.create(stranger.id, { ...details(), name: 'Xavia team private' })
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await service.listPage(user.id, { limit: '4', cursor })
      expect(page.workspaces.length).toBeLessThanOrEqual(4)
      seen.push(...page.workspaces.map(profile => profile.id))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(seen.sort()).toEqual(ids.sort())
    const result = await service.listPage(user.id, { q: 'XAVIA TEAM 00', limit: 1 })
    expect(result.workspaces.map(profile => profile.name)).toEqual(['Xavia team 00'])
    const first = await service.listPage(user.id, { limit: 1 })
    await expect(service.listPage(user.id, { q: 'changed', cursor: first.nextCursor })).rejects.toMatchObject({ code: 'invalid_profile_query' })
    for (const input of [{ limit: 0 }, { limit: 101 }, { limit: ['2'] }, { status: ['archived'] }, { permission: ['owner'] }, { q: 'x'.repeat(81) }, { cursor: 'bad-cursor' }]) {
      await expect(service.listPage(user.id, input)).rejects.toMatchObject({ code: 'invalid_profile_query' })
    }
  })

  it('supports multiple seller accounts of one channel in a profile without combining their identities', async () => {
    const user = await person(), profile = await service.create(user.id, details())
    const access = await service.membership(user.id, profile.id)
    await withWorkspace(access.context, async () => {
      const sellerIds = [randomUUID(), randomUUID()]
      for (const externalAccountId of sellerIds) await database.client.channelConnection.create({ data: { channelType: 'EBAY', externalAccountId, isActive: true } })
      expect((await database.client.channelConnection.findMany()).map(account => account.externalAccountId).sort()).toEqual(sellerIds.sort())
      expect(await database.client.channelAccountOwnership.count({ where: { workspaceId: profile.id } })).toBe(2)
    })
  })

  it('assigns unused disconnected accounts with new IDs, fresh sign-in, scoped history and retry safety for every channel', async () => {
    const user = await person()
    const a = await service.create(user.id, details()), b = await service.create(user.id, details())
    const ca = (await service.membership(user.id, a.id)).context, cb = (await service.membership(user.id, b.id)).context
    for (const channelType of ['EBAY', 'AMAZON', 'AMAZON_ADS', 'SHOPIFY', 'ETSY', 'FUTURE_CHANNEL']) {
      const original = await withWorkspace(ca, () => database.client.channelConnection.create({ data: { channelType, accountLabel: `Xavia ${channelType}`, externalAccountId: randomUUID(), isActive: false, authStatus: 'disconnected' } }))
      const event = await withWorkspace(ca, () => database.client.connectionEvent.create({ data: { connectionId: original.id, channelKey: channelType, type: 'disconnect' } }))
      const input = { destinationId: b.id, ...(await service.assignAccount(user.id, a.id, original.id, { destinationId: b.id })) }
      expect(input).toMatchObject({ eligible: true, blockers: [] })
      const moved = await service.assignAccount(user.id, a.id, original.id, input, true)
      expect(moved).toMatchObject({ assigned: true, destinationId: b.id })
      expect(moved.connectionId).not.toBe(original.id)
      expect(await service.assignAccount(user.id, a.id, original.id, input, true)).toEqual(moved)
      await withWorkspace(ca, async () => {
        expect(await database.client.channelConnection.findUnique({ where: { id: String(moved.connectionId) } })).toBeNull()
        expect(await database.client.connectionEvent.findUnique({ where: { id: event.id } })).toMatchObject({ connectionId: original.id, workspaceId: a.id })
        expect(await database.client.channelConnection.findUnique({ where: { id: original.id } })).toMatchObject({ managedBy: 'transferred', isActive: false, externalAccountId: null })
        await expect(database.client.channelConnection.update({ where: { id: original.id }, data: { isActive: true } })).rejects.toThrow()
        await expect(database.client.channelConnection.create({ data: { channelType, externalAccountId: original.externalAccountId, isActive: true } })).rejects.toThrow()
      })
      await withWorkspace(cb, async () => {
        expect(await database.client.channelConnection.findUnique({ where: { id: String(moved.connectionId) } })).toMatchObject({ workspaceId: b.id, externalAccountId: original.externalAccountId, accountLabel: original.accountLabel, isActive: false, isPrimary: false, credentialsEnc: null, accessToken: null, refreshToken: null })
        expect(await database.client.connectionEvent.findUnique({ where: { id: event.id } })).toBeNull()
      })
      expect(await database.client.channelAccountRoute.findUnique({ where: { connectionId: String(moved.connectionId) } })).toBeNull()
    }
    expect(await database.client.workspaceAudit.count({ where: { action: 'account.assigned', workspaceId: { in: [a.id, b.id] } } })).toBe(12)
  })

  it('rechecks assignment blockers and refuses stale review, history, active grants and pending OAuth', async () => {
    const user = await person(), a = await service.create(user.id, details()), b = await service.create(user.id, details())
    const ca = (await service.membership(user.id, a.id)).context
    const account = await withWorkspace(ca, () => database.client.channelConnection.create({ data: { channelType: 'EBAY', externalAccountId: randomUUID(), isActive: false } }))
    const preview = await service.assignAccount(user.id, a.id, account.id, { destinationId: b.id })
    await withWorkspace(ca, () => database.client.channelConnection.update({ where: { id: account.id }, data: { accountLabel: 'Changed' } }))
    await expect(service.assignAccount(user.id, a.id, account.id, { ...preview, destinationId: b.id }, true)).rejects.toMatchObject({ code: 'assignment_changed' })
    await withWorkspace(ca, () => database.client.channelConnection.update({ where: { id: account.id }, data: { isActive: true, credentialsEnc: 'test-envelope' } }))
    expect(await service.assignAccount(user.id, a.id, account.id, { destinationId: b.id })).toMatchObject({ eligible: false, blockers: expect.arrayContaining([expect.stringContaining('Disconnect')]) })
    await withWorkspace(ca, () => database.client.channelConnection.update({ where: { id: account.id }, data: { isActive: false, credentialsEnc: null } }))
    const clean = await service.assignAccount(user.id, a.id, account.id, { destinationId: b.id })
    await database.client.oAuthSession.create({ data: { id: randomUUID(), workspaceId: a.id, channelKey: 'EBAY', intent: 'connect', redirectUri: 'http://example.test', cookieNonce: 'fixture', expiresAt: new Date(Date.now() + 60_000) } })
    await expect(service.assignAccount(user.id, a.id, account.id, { ...clean, destinationId: b.id }, true)).rejects.toMatchObject({ code: 'assignment_blocked' })
    await withWorkspace(ca, async () => {
      const product = await database.client.product.create({ data: { sku: 'ASSIGN-HISTORY', name: 'History', basePrice: 10 } })
      await database.client.channelListing.create({ data: { productId: product.id, channel: 'EBAY', channelMarket: 'EBAY_IT', region: 'IT', channelConnectionId: account.id } })
    })
    const history = await service.assignAccount(user.id, a.id, account.id, { destinationId: b.id })
    expect(history).toMatchObject({ eligible: false, references: expect.arrayContaining(['ChannelListing']) })
    expect(await database.client.channelAccountOwnership.findFirst({ where: { externalAccountId: account.externalAccountId! } })).toMatchObject({ workspaceId: a.id })
  })

  it('requires live ownership of both profiles, even when the assignment function is called directly', async () => {
    const user = await person(), stranger = await person()
    const a = await service.create(user.id, details()), b = await service.create(stranger.id, details())
    const ca = (await service.membership(user.id, a.id)).context
    const account = await withWorkspace(ca, () => database.client.channelConnection.create({ data: { channelType: 'EBAY', externalAccountId: randomUUID() } }))
    await expect(service.assignAccount(user.id, a.id, account.id, { destinationId: b.id })).rejects.toMatchObject({ code: 'workspace_owner_required' })
    const results = await withWorkspace(ca, () => database.client.$queryRaw<Array<{ result: { code: string } }>>`SELECT nexus_assign_channel_account(${account.id}::text, ${b.id}::text, NULL::text) AS result`)
    expect(results[0]?.result.code).toBe('workspace_owner_required')
    await expect(service.assignAccount(user.id, a.id, account.id, { destinationId: a.id })).rejects.toMatchObject({ code: 'invalid_assignment' })
    const own = await service.create(user.id, details())
    await expect(service.assignAccount(user.id, own.id, account.id, { destinationId: a.id })).rejects.toMatchObject({ code: 'account_unavailable' })
    await expect(service.assignAccount(user.id, a.id, account.id, { destinationId: own.id, version: 'bad' }, true)).rejects.toMatchObject({ code: 'invalid_assignment' })
  })

  it('assigns through a function owner without RLS bypass and restores the source scope inside the same transaction', async () => {
    const user = await person(), a = await service.create(user.id, details()), b = await service.create(user.id, details())
    const ca = (await service.membership(user.id, a.id)).context
    const account = await withWorkspace(ca, () => database.client.channelConnection.create({ data: { channelType: 'EBAY', externalAccountId: randomUUID() } }))
    await database.db.exec(`CREATE ROLE assignment_migration_owner NOLOGIN NOSUPERUSER NOBYPASSRLS IN ROLE nexus_workspace_runtime;
      GRANT UPDATE ON "ChannelAccountOwnership" TO assignment_migration_owner;
      ALTER FUNCTION nexus_assign_channel_account(text, text, text) OWNER TO assignment_migration_owner;`)
    try {
      const preview = await service.assignAccount(user.id, a.id, account.id, { destinationId: b.id })
      await withWorkspace(ca, () => database.client.$transaction(async tx => {
        const rows = await tx.$queryRaw<Array<{ result: { assigned: boolean; connectionId: string } }>>`SELECT nexus_assign_channel_account(${account.id}::text, ${b.id}::text, ${String(preview.version)}::text) AS result`
        expect(rows[0]?.result.assigned).toBe(true)
        expect(await tx.$queryRaw`SELECT current_setting('nexus.workspace_id') AS workspace`).toEqual([{ workspace: a.id }])
        expect(await tx.channelConnection.findUnique({ where: { id: rows[0]!.result.connectionId } })).toBeNull()
      }))
    } finally { await database.db.exec('ALTER FUNCTION nexus_assign_channel_account(text, text, text) OWNER TO CURRENT_USER') }
  })

  it('does not report a stale destination when retrying after the account has moved again', async () => {
    const user = await person(), a = await service.create(user.id, details()), b = await service.create(user.id, details())
    const ca = (await service.membership(user.id, a.id)).context
    const account = await withWorkspace(ca, () => database.client.channelConnection.create({ data: { channelType: 'EBAY', externalAccountId: randomUUID() } }))
    const outward = await service.assignAccount(user.id, a.id, account.id, { destinationId: b.id })
    const moved = await service.assignAccount(user.id, a.id, account.id, outward, true)
    const inward = await service.assignAccount(user.id, b.id, String(moved.connectionId), { destinationId: a.id })
    await service.assignAccount(user.id, b.id, String(moved.connectionId), inward, true)
    await expect(service.assignAccount(user.id, a.id, account.id, outward, true)).rejects.toMatchObject({ code: 'assignment_changed' })
  })

  it('refuses stale edits and preserves the last owner', async () => {
    const user = await person()
    const profile = await service.create(user.id, details())
    const access = await service.membership(user.id, profile.id)
    expect(await service.rename(user.id, profile.id, 'Xavia Motorsport', 1)).toMatchObject({ version: 2 })
    await expect(service.rename(user.id, profile.id, 'Stale name', 1)).rejects.toMatchObject({ code: 'profile_changed' })
    await expect(service.changeMember(user.id, profile.id, access.id, { roleIds: [viewerId], status: 'active', version: 1 })).rejects.toMatchObject({ code: 'last_owner' })
    expect((await service.membership(user.id, profile.id)).isOwner).toBe(true)
  })

  it('serializes competing owner removals so one owner always remains', async () => {
    const user = await person(), second = await person()
    const profile = await service.create(user.id, details())
    const first = await service.membership(user.id, profile.id)
    const other = await database.client.workspaceMembership.create({ data: { workspaceId: profile.id, userId: second.id, roles: { create: { roleId: ownerId } } } })
    const results = await Promise.allSettled([
      service.changeMember(user.id, profile.id, first.id, { roleIds: [viewerId], status: 'active', version: 1 }),
      service.changeMember(second.id, profile.id, other.id, { roleIds: [viewerId], status: 'active', version: 1 }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(await database.client.workspaceMembership.count({ where: { workspaceId: profile.id, status: 'active', roles: { some: { roleId: ownerId } } } })).toBe(1)
  })

  it('does not let an owner mutate a membership from another workspace', async () => {
    const user = await person()
    const a = await service.create(user.id, details()), b = await service.create(user.id, details())
    const other = await service.membership(user.id, b.id)
    await expect(service.changeMember(user.id, a.id, other.id, { roleIds: [viewerId], status: 'revoked', version: 1 })).rejects.toMatchObject({ code: 'membership_changed' })
    expect((await service.membership(user.id, b.id)).isOwner).toBe(true)
  })

  it('isolates duplicate SKUs, direct IDs, nested references and raw SQL for an owner of both profiles', async () => {
    const user = await person()
    const a = await service.create(user.id, details()), b = await service.create(user.id, details())
    const ca = (await service.membership(user.id, a.id)).context, cb = (await service.membership(user.id, b.id)).context
    const pa = await withWorkspace(ca, () => database.client.product.create({ data: { sku: 'SAME-SKU', name: 'Business A', basePrice: 10 } }))
    const pb = await withWorkspace(cb, () => database.client.product.create({ data: { sku: 'SAME-SKU', name: 'Business B', basePrice: 20 } }))
    expect(pa.workspaceId).toBe(a.id)
    expect(pb.workspaceId).toBe(b.id)
    await withWorkspace(ca, async () => {
      expect((await database.client.product.findMany()).map(row => row.id)).toEqual([pa.id])
      expect(await database.client.product.findUnique({ where: { id: pb.id } })).toBeNull()
      expect(await database.client.$queryRaw`SELECT id FROM "Product" WHERE id = ${pb.id}`).toEqual([])
      await expect(database.client.product.update({ where: { id: pb.id }, data: { name: 'Wrong business' } })).rejects.toThrow()
      await expect(database.client.product.update({ where: { id: pa.id }, data: { parentId: pb.id } })).rejects.toThrow()
      await expect(database.client.$executeRaw`UPDATE "Product" SET "workspaceId" = ${b.id} WHERE id = ${pa.id}`).rejects.toThrow()
    })
    expect((await withWorkspace(cb, () => database.client.product.findUniqueOrThrow({ where: { id: pb.id } }))).name).toBe('Business B')
  })

  it('rejects mixed-profile transactions before executing their writes', async () => {
    const user = await person()
    const a = await service.create(user.id, details()), b = await service.create(user.id, details())
    const ca = (await service.membership(user.id, a.id)).context, cb = (await service.membership(user.id, b.id)).context
    const first = withWorkspace(ca, () => database.client.product.create({ data: { sku: 'TRANSACTION-A', name: 'A', basePrice: 10 } }))
    const second = withWorkspace(cb, () => database.client.product.create({ data: { sku: 'TRANSACTION-B', name: 'B', basePrice: 10 } }))
    await expect(withWorkspace(ca, () => database.client.$transaction([first, second]))).rejects.toMatchObject({ code: 'workspace_transaction_changed' })
    expect(await withWorkspace(ca, () => database.client.product.count())).toBe(0)
    expect(await withWorkspace(cb, () => database.client.product.count())).toBe(0)
    await expect(withWorkspace(ca, () => database.client.$transaction(async tx => {
      await withWorkspace(cb, () => tx.product.create({ data: { sku: 'CHANGED', name: 'Changed', basePrice: 10 } }))
    }))).rejects.toMatchObject({ code: 'workspace_transaction_changed' })
  })

  it('rechecks membership inside database policies even when an engine was already cached', async () => {
    const user = await person(), second = await person()
    const profile = await service.create(user.id, details())
    const owner = (await service.membership(user.id, profile.id)).context
    await withWorkspace(owner, () => database.client.product.create({ data: { sku: 'PRIVATE', name: 'Private', basePrice: 10 } }))
    const member = await database.client.workspaceMembership.create({ data: { workspaceId: profile.id, userId: second.id, roles: { create: { roleId: viewerId } } } })
    const context = (await service.membership(second.id, profile.id)).context
    expect(await withWorkspace(context, () => database.client.product.count())).toBe(1)
    await database.client.workspaceMembership.update({ where: { id: member.id }, data: { status: 'revoked' } })
    expect(await withWorkspace(context, () => database.client.product.count())).toBe(0)
    await expect(withWorkspace(context, () => database.client.product.create({ data: { sku: 'REVOKED', name: 'Revoked', basePrice: 10 } }))).rejects.toThrow()
  })

  it('adds the invited login only to its intended profile and consumes an invitation once', async () => {
    const owner = await person(), invited = await person(), wrong = await person()
    const a = await service.create(owner.id, details()), b = await service.create(owner.id, details())
    const grant = await service.invite(owner.id, a.id, { email: invited.email, roleIds: [viewerId] })
    await expect(service.acceptInvitation(wrong.id, grant.token)).rejects.toMatchObject({ code: 'invitation_email_mismatch' })
    expect((await service.acceptInvitation(invited.id, grant.token)).workspaceId).toBe(a.id)
    expect((await service.membership(invited.id, a.id)).roleKeys).toEqual(['VIEWER'])
    await expect(service.membership(invited.id, b.id)).rejects.toMatchObject({ code: 'workspace_unavailable' })
    await expect(service.acceptInvitation(invited.id, grant.token)).rejects.toMatchObject({ code: 'invalid_invitation' })
  })

  it('does not let a stale invitation replace an existing member’s roles', async () => {
    const owner = await person(), invited = await person()
    const profile = await service.create(owner.id, details())
    const grant = await service.invite(owner.id, profile.id, { email: invited.email, roleIds: [viewerId] })
    await database.client.workspaceMembership.create({ data: { workspaceId: profile.id, userId: invited.id, roles: { create: { roleId: ownerId } } } })
    await service.acceptInvitation(invited.id, grant.token)
    expect((await service.membership(invited.id, profile.id)).isOwner).toBe(true)
  })

  it('refuses revoked invitations and invitations whose sender lost owner access', async () => {
    const owner = await person(), invited = await person(), second = await person()
    const profile = await service.create(owner.id, details())
    const grant = await service.invite(owner.id, profile.id, { email: invited.email, roleIds: [viewerId] })
    await service.revokeInvitation(owner.id, profile.id, grant.invitation.id)
    await expect(service.acceptInvitation(invited.id, grant.token)).rejects.toMatchObject({ code: 'invalid_invitation' })
    const replacement = await service.invite(owner.id, profile.id, { email: invited.email, roleIds: [viewerId] })
    await database.client.workspaceMembership.create({ data: { workspaceId: profile.id, userId: second.id, roles: { create: { roleId: ownerId } } } })
    const current = await service.membership(owner.id, profile.id)
    await service.changeMember(second.id, profile.id, current.id, { roleIds: [viewerId], status: 'active', version: current.version })
    await expect(service.acceptInvitation(invited.id, replacement.token)).rejects.toMatchObject({ code: 'invalid_invitation' })
  })

  it('creates a new identity and its invited membership in one transaction', async () => {
    const owner = await person()
    const profile = await service.create(owner.id, details())
    const email = `${randomUUID()}@example.test`
    const grant = await service.invite(owner.id, profile.id, { email, roleIds: [viewerId] })
    const accepted = await service.acceptInvitation(null, grant.token, { displayName: 'New colleague', passwordHash: 'test-only-already-hashed' })
    expect((await service.membership(accepted.userId, profile.id)).roleKeys).toEqual(['VIEWER'])
    expect((await database.client.userProfile.findUniqueOrThrow({ where: { id: accepted.userId } })).email).toBe(email)
  })

  it('archives without deleting history and rejects cached access or a late invitation', async () => {
    const owner = await person(), invited = await person()
    const profile = await service.create(owner.id, details())
    const scope = (await service.membership(owner.id, profile.id)).context
    const product = await withWorkspace(scope, () => database.client.product.create({ data: { sku: 'ARCHIVE', name: 'Retained history', basePrice: 10 } }))
    const grant = await service.invite(owner.id, profile.id, { email: invited.email, roleIds: [viewerId] })
    await expect(service.archive(owner.id, profile.id, { name: 'wrong', version: 1 })).rejects.toMatchObject({ code: 'archive_confirmation' })
    await service.archive(owner.id, profile.id, { name: profile.name, version: 1 })
    expect(await service.list(owner.id)).toEqual([])
    expect(await withWorkspace(scope, () => database.client.product.count())).toBe(0)
    await expect(service.acceptInvitation(invited.id, grant.token)).rejects.toMatchObject({ code: 'invalid_invitation' })
    const rows = await database.db.query<{ id: string }>('SELECT id FROM "Product" WHERE id = $1', [product.id])
    expect(rows.rows).toEqual([{ id: product.id }])
  })

  it('rolls back array transactions and refuses replaying an already executed operation', async () => {
    const user = await person(), profile = await service.create(user.id, details())
    const scope = (await service.membership(user.id, profile.id)).context
    await withWorkspace(scope, async () => {
      await expect(database.client.$transaction([
        database.client.product.create({ data: { sku: 'ROLLBACK', name: 'First', basePrice: 1 } }),
        database.client.product.create({ data: { sku: 'ROLLBACK', name: 'Duplicate', basePrice: 2 } }),
      ])).rejects.toThrow()
      expect(await database.client.product.count()).toBe(0)
      const operation = database.client.product.create({ data: { sku: 'ONCE', name: 'Once', basePrice: 1 } })
      await operation
      await expect(database.client.$transaction([operation])).rejects.toMatchObject({ code: 'invalid_transaction' })
      expect(await database.client.product.count()).toBe(1)
      const inTransaction = database.client.product.create({ data: { sku: 'TRANSACTION-ONCE', name: 'One execution', basePrice: 1 } })
      const [saved] = await database.client.$transaction([inTransaction])
      expect((await inTransaction).id).toBe(saved.id)
      expect(await database.client.product.count()).toBe(2)
      const duplicate = database.client.product.create({ data: { sku: 'DUPLICATE-OP', name: 'No execution', basePrice: 1 } })
      await expect(database.client.$transaction([duplicate, duplicate])).rejects.toMatchObject({ code: 'invalid_transaction' })
    })
  })

  it('restores retained data only for an owner and invalidates older automation', async () => {
    const owner = await person(), stranger = await person()
    const profile = await service.create(owner.id, details())
    const scope = (await service.membership(owner.id, profile.id)).context
    await withWorkspace(scope, () => database.client.product.create({ data: { sku: 'RESTORE', name: 'Retained', basePrice: 1 } }))
    await service.archive(owner.id, profile.id, { name: profile.name, version: 1 })
    expect(await service.archived(stranger.id)).toEqual([])
    await expect(service.restore(stranger.id, profile.id, { name: profile.name, version: 2 })).rejects.toThrow()
    await service.restore(owner.id, profile.id, { name: profile.name, version: 2 })
    const restored = await database.client.workspace.findUniqueOrThrow({ where: { id: profile.id } })
    expect(restored).toMatchObject({ status: 'active', version: 3, archivedAt: null })
    expect(restored.automationResumedAt).toBeInstanceOf(Date)
    expect(await withWorkspace(scope, () => database.client.product.count())).toBe(1)
    await expect(service.restore(owner.id, profile.id, { name: profile.name, version: 2 })).rejects.toThrow()
  })

  it('retains external account ownership after disconnect and routes only active destinations', async () => {
    const user = await person(), a = await service.create(user.id, details()), b = await service.create(user.id, details())
    const ca = (await service.membership(user.id, a.id)).context, cb = (await service.membership(user.id, b.id)).context
    const externalAccountId = randomUUID()
    const account = await withWorkspace(ca, () => database.client.channelConnection.create({ data: { channelType: 'AMAZON_ADS', externalAccountId, isActive: true } }))
    await withWorkspace(ca, () => database.client.connectionScope.create({ data: { connectionId: account.id, kind: 'profile', externalId: 'ADS-PROFILE', metadata: { accountId: 'ADVERTISER-ID' } } }))
    expect((await database.client.channelAccountRoute.findUniqueOrThrow({ where: { connectionId: account.id } })).destinationIds.sort()).toEqual(['ADS-PROFILE', 'ADVERTISER-ID'])
    await withWorkspace(ca, () => database.client.channelConnection.update({ where: { id: account.id }, data: { isActive: false } }))
    expect(await database.client.channelAccountRoute.findUnique({ where: { connectionId: account.id } })).toBeNull()
    await expect(withWorkspace(cb, () => database.client.channelConnection.create({ data: { channelType: 'AMAZON_ADS', externalAccountId, isActive: true } }))).rejects.toThrow()
    expect((await database.client.channelAccountOwnership.findMany({ where: { externalAccountId } })).map(row => row.workspaceId)).toEqual([a.id])
    await withWorkspace(ca, () => database.client.channelConnection.update({ where: { id: account.id }, data: { isActive: true } }))
    expect((await database.client.channelAccountRoute.findUniqueOrThrow({ where: { connectionId: account.id } })).destinationIds.sort()).toEqual(['ADS-PROFILE', 'ADVERTISER-ID'])
  })

  it('keeps simultaneous HTTP requests scoped and refuses missing, forged or conflicting selectors', async () => {
    const user = await person(), stranger = await person()
    const a = await service.create(user.id, details()), b = await service.create(user.id, details()), foreign = await service.create(stranger.id, details())
    const app = Fastify()
    await app.register(cookie)
    app.addHook('preHandler', createWorkspaceHook(service, async raw => raw === 'test-session' ? {
      sessionId: 'session', mfaSatisfied: true,
      user: { id: user.id, email: user.email, displayName: 'Operator', status: 'active', mfaRequired: false, twoFactorEnabledAt: null, permissionsVersion: 1, roleKeys: ['OWNER'] },
    } : null))
    app.get('/api/products', async () => { await new Promise(resolve => setTimeout(resolve, 1)); return { workspaceId: requireWorkspace().workspaceId } })
    app.post('/api/products', async () => ({ workspaceId: requireWorkspace().workspaceId }))
    const session = { cookie: `${sessionCookieName()}=test-session; nexus_csrf=csrf-test` }
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    try {
      const responses = await Promise.all([a, b].map(profile => app.inject({ url: '/api/products', headers: { ...session, 'x-nexus-workspace-id': profile.id } })))
      expect(responses.map(response => response.json().workspaceId)).toEqual([a.id, b.id])
      expect((await app.inject({ url: '/api/products', headers: session })).statusCode).toBe(400)
      expect((await app.inject({ url: '/api/products', headers: { ...session, 'x-nexus-workspace-id': foreign.id } })).statusCode).toBe(403)
      expect((await app.inject({ url: `/api/products?workspaceId=${b.id}`, headers: { ...session, 'x-nexus-workspace-id': a.id } })).statusCode).toBe(400)
      expect((await app.inject({ method: 'POST', url: '/api/products', headers: { ...session, 'x-nexus-workspace-id': a.id } })).statusCode).toBe(403)
      expect((await app.inject({ method: 'POST', url: '/api/products', headers: { ...session, 'x-nexus-workspace-id': a.id, 'x-nexus-csrf': 'csrf-test' } })).json()).toEqual({ workspaceId: a.id })
      expect(workspaceContext()).toBeUndefined()
    } finally { vi.unstubAllEnvs(); await app.close() }
  })

  it('keeps custom roles inside their business and invalidates membership versions on a permission edit', async () => {
    const user = await person(), member = await person()
    const a = await service.create(user.id, details()), b = await service.create(user.id, details())
    const role = await service.saveRole(user.id, a.id, { name: 'Catalog editor', permissions: ['products.view'] })
    await expect(service.invite(user.id, b.id, { email: member.email, roleIds: [role.id] })).rejects.toMatchObject({ code: 'invalid_roles' })
    await expect(service.saveRole(user.id, b.id, { name: 'Wrong business', permissions: [], version: 1 }, role.id)).rejects.toMatchObject({ code: 'role_changed' })
    const grant = await service.invite(user.id, a.id, { email: member.email, roleIds: [role.id] })
    await service.acceptInvitation(member.id, grant.token)
    const before = await service.membership(member.id, a.id)
    await service.saveRole(user.id, a.id, { name: 'Catalog editor', permissions: ['products.view', 'products.edit'], version: 1 }, role.id)
    const after = await service.membership(member.id, a.id)
    expect(after.permissions.has('products.edit')).toBe(true)
    expect(after.version).toBe(before.version + 1)
    await expect(service.saveRole(user.id, a.id, { name: 'Stale', permissions: [], version: 1 }, role.id)).rejects.toMatchObject({ code: 'role_changed' })
  })
})

describe('request and background context', () => {
  it('keeps simultaneous requests and captured background work in their original profiles', async () => {
    const run = (id: string) => withWorkspace({ workspaceId: id, actorUserId: 'user', membershipId: `member-${id}`, roleKeys: ['OWNER'] }, async () => {
      const captured = captureWorkspace()
      await new Promise(resolve => setTimeout(resolve, id === 'a' ? 5 : 1))
      expect(requireWorkspace().workspaceId).toBe(id)
      return captured
    })
    const [a, b] = await Promise.all([run('a'), run('b')])
    expect(workspaceContext()).toBeUndefined()
    expect(a(() => requireWorkspace().workspaceId)).toBe('a')
    expect(b(() => requireWorkspace().workspaceId)).toBe('b')
    expect(() => requireWorkspace()).toThrow('Select a business profile')
  })

  it.each([
    { name: ' ' }, { country: 'ITALY' }, { currency: 'invalid' }, { timezone: '' }, { timezone: 'Mars/Olympus' }, { creationKey: 'short' },
  ])('rejects invalid creation details %j', patch => {
    expect(() => validateWorkspaceInput({ name: 'Xavia Racing', country: 'IT', currency: 'EUR', timezone: 'Europe/Rome', creationKey: randomUUID(), ...patch })).toThrow()
  })
})
