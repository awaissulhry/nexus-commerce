/**
 * MCP.6 — Connected apps, on a real PostgreSQL with the production schema (PGlite): who sees which
 * Claude connection, who may end it, and that ending it takes effect on the very next call.
 *
 * The promises: a person sees only their own live connections, in businesses they still belong to;
 * an admin (sessions.manage) sees their business's, with the person; a connection the caller may
 * not see answers 404 and keeps working; a revoke ends every token at once, is audited with the
 * person who did it, and leaves both lists.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID } from '../../lib/workspace-context.js'

let database: Pick<Awaited<ReturnType<typeof formulaDatabase>>, 'client' | 'close'>
vi.mock('../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))

import { generateToken, hashToken } from '../../lib/auth/tokens.js'
import { createWorkspaceService } from '../workspace.service.js'
import { mcpResource } from './oauth-config.js'
import { verifyAccessToken } from './oauth-server.js'
import {
  listBusinessConnectedApps,
  listMyConnectedApps,
  revokeBusinessConnectedApp,
  revokeMyConnectedApp,
  type BusinessAdmin,
} from './oauth-grants.js'

const BUSINESS_A = LEGACY_WORKSPACE_ID
const BUSINESS_B = 'mcp6_business_b'
const BUSINESS_LEFT = 'mcp6_business_left'

type Db = Awaited<ReturnType<typeof formulaDatabase>>['client']
let db: Db
const users = {} as Record<'me' | 'colleague' | 'leaver' | 'adminA' | 'adminB', string>
let operatorRole: string
let adminRole: string

async function member(userId: string, workspaceId: string, roleId: string) {
  const membership = await db.workspaceMembership.create({ data: { workspaceId, userId, status: 'active' } })
  await db.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId } })
}

async function leave(userId: string, workspaceId: string) {
  await db.workspaceMembership.update({ where: { workspaceId_userId: { workspaceId, userId } }, data: { status: 'removed' } })
}

const APPS = {
  claude: { clientName: 'Claude', redirectUris: ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'] },
  claudeCode: { clientName: 'Claude Code', redirectUris: ['http://localhost/callback'] },
}

let clock = Date.parse('2026-09-01T10:00:00Z')
/**
 * A connection with a live access token, as consent + the token exchange leave one. Each is its
 * own registration (dynamic registration issues a new client), since there is one connection per
 * person, business and app.
 */
async function connect(userId: string, workspaceId: string, app: keyof typeof APPS = 'claude') {
  clock += 60_000
  const client = await db.oAuthClient.create({
    data: { clientId: `nxc_${randomUUID().replace(/-/g, '')}`, registration: 'dcr', ...APPS[app], metadata: { client_name: APPS[app].clientName } },
  })
  const grant = await db.oAuthGrant.create({
    data: { workspaceId, userId, clientId: client.id, scopes: ['nexus.read', 'nexus.write'], createdAt: new Date(clock) },
  })
  const access = `nxm_at_${generateToken(32)}`
  const refresh = `nxm_rt_${generateToken(32)}`
  const later = (seconds: number) => new Date(Date.now() + seconds * 1000)
  await db.oAuthToken.createMany({
    data: [
      { tokenHash: hashToken(access), kind: 'access', grantId: grant.id, resource: mcpResource(), scopes: grant.scopes, expiresAt: later(3600) },
      { tokenHash: hashToken(refresh), kind: 'refresh', grantId: grant.id, resource: mcpResource(), scopes: grant.scopes, expiresAt: later(86_400) },
    ],
  })
  return { id: grant.id, access }
}

/** The caller as the workspace hook places them: permissions from their live membership. */
async function adminOf(userId: string, workspaceId: string): Promise<BusinessAdmin> {
  const access = await createWorkspaceService(db).membership(userId, workspaceId)
  return { userId, workspaceId, permissions: { isOwner: access.isOwner, permissions: access.permissions } }
}

async function expectNotFound(work: Promise<unknown>) {
  await expect(work).rejects.toMatchObject({ code: 'not_found', statusCode: 404 })
}

beforeAll(async () => {
  database = await formulaDatabase()
  db = database.client
  vi.stubEnv('NEXUS_OAUTH_API_ORIGIN', 'https://api.example.test')
  vi.stubEnv('NEXUS_MCP_WORKSPACES', '')
  const role = (key: string, permissions: string[]) =>
    db.role.create({ data: { key: `${key}_${randomUUID().slice(0, 8)}`, name: key, description: 'test', permissions, isSystem: false } })
  operatorRole = (await role('MCP6_OPS', ['ai.run', 'products.view'])).id
  adminRole = (await role('MCP6_ADMIN', ['ai.run', 'sessions.manage'])).id
  for (const [key, name] of [['me', 'Ada Person'], ['colleague', 'Colleague'], ['leaver', ''], ['adminA', 'Admin A'], ['adminB', 'Admin B']] as const) {
    users[key] = (await db.userProfile.create({ data: { email: `${key}-${randomUUID().slice(0, 8)}@example.test`, displayName: name, status: 'active' } })).id
  }
  for (const id of [BUSINESS_B, BUSINESS_LEFT]) {
    await db.workspace.create({ data: { id, name: id === BUSINESS_B ? 'Business B' : 'Business I left', createdByUserId: users.adminB, creationKey: randomUUID() } })
  }
  await member(users.me, BUSINESS_A, operatorRole)
  await member(users.me, BUSINESS_B, operatorRole)
  await member(users.me, BUSINESS_LEFT, operatorRole)
  await member(users.colleague, BUSINESS_A, operatorRole)
  await member(users.leaver, BUSINESS_A, operatorRole)
  await member(users.adminA, BUSINESS_A, adminRole)
  await member(users.adminB, BUSINESS_B, adminRole)
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('MCP.6 — a person’s own connected apps', () => {
  it('lists only my live connections, newest first, and never a token, code or redirect URI', async () => {
    const inA = await connect(users.me, BUSINESS_A)
    const inB = await connect(users.me, BUSINESS_B, 'claudeCode')
    const theirs = await connect(users.colleague, BUSINESS_A)
    const ended = await connect(users.me, BUSINESS_A, 'claudeCode')
    await db.oAuthGrant.update({ where: { id: ended.id }, data: { revokedAt: new Date(), revokeReason: 'person' } })

    const mine = await listMyConnectedApps(users.me)
    expect(mine.map((grant) => grant.id)).toEqual([inB.id, inA.id])
    expect(mine.map((grant) => grant.id)).not.toContain(theirs.id)
    expect(mine[1]).toEqual({
      id: inA.id,
      appName: 'Claude',
      appHosts: ['claude.ai', 'claude.com'],
      businessId: BUSINESS_A,
      businessName: expect.any(String),
      scopes: ['nexus.read', 'nexus.write'],
      createdAt: expect.any(Date),
      lastUsedAt: null,
    })
    expect(mine[0]).toMatchObject({ appName: 'Claude Code', appHosts: ['localhost'], businessId: BUSINESS_B, businessName: 'Business B' })
  })

  it('a business I have left is not listed, and I cannot revoke there (404)', async () => {
    const there = await connect(users.me, BUSINESS_LEFT)
    expect((await listMyConnectedApps(users.me)).map((grant) => grant.id)).toContain(there.id)
    await leave(users.me, BUSINESS_LEFT)
    expect((await listMyConnectedApps(users.me)).map((grant) => grant.id)).not.toContain(there.id)
    await expectNotFound(revokeMyConnectedApp(users.me, there.id))
    expect((await db.oAuthGrant.findUniqueOrThrow({ where: { id: there.id } })).revokedAt).toBeNull()
  })

  it('I cannot revoke another person’s connection: 404, and it keeps working', async () => {
    const theirs = await connect(users.colleague, BUSINESS_A)
    await expectNotFound(revokeMyConnectedApp(users.me, theirs.id))
    await expectNotFound(revokeMyConnectedApp(users.me, 'no-such-grant'))
    expect(await verifyAccessToken(theirs.access)).not.toBeNull()
    expect(await db.workspaceAudit.count({ where: { targetId: theirs.id } })).toBe(0)
  })

  it('revoking my own ends its tokens at once, is audited with me, and leaves both lists', async () => {
    const mine = await connect(users.me, BUSINESS_A)
    expect(await verifyAccessToken(mine.access)).toMatchObject({ grantId: mine.id, userId: users.me })

    await revokeMyConnectedApp(users.me, mine.id)

    expect(await verifyAccessToken(mine.access)).toBeNull()
    expect(await db.oAuthToken.count({ where: { grantId: mine.id, revokedAt: null } })).toBe(0)
    expect(await db.oAuthGrant.findUniqueOrThrow({ where: { id: mine.id } })).toMatchObject({ revokedBy: users.me, revokeReason: 'person' })
    const audit = await db.workspaceAudit.findMany({ where: { targetId: mine.id } })
    expect(audit).toEqual([expect.objectContaining({ workspaceId: BUSINESS_A, actorUserId: users.me, action: 'oauth.revoked', metadata: { reason: 'person' } })])
    expect((await listMyConnectedApps(users.me)).map((grant) => grant.id)).not.toContain(mine.id)
    const business = await listBusinessConnectedApps(await adminOf(users.adminA, BUSINESS_A))
    expect(business.map((grant) => grant.id)).not.toContain(mine.id)
    // Twice is not found: it already ended.
    await expectNotFound(revokeMyConnectedApp(users.me, mine.id))
  })
})

describe('MCP.6 — a business’s connected apps, for an admin', () => {
  it('lists every live connection of this business with the person, and none of another business', async () => {
    const mineA = await connect(users.me, BUSINESS_A)
    const theirsA = await connect(users.colleague, BUSINESS_A)
    const mineB = await connect(users.me, BUSINESS_B)

    const listed = await listBusinessConnectedApps(await adminOf(users.adminA, BUSINESS_A))
    const ids = listed.map((grant) => grant.id)
    expect(ids).toEqual(expect.arrayContaining([mineA.id, theirsA.id]))
    expect(ids).not.toContain(mineB.id)
    expect(listed.every((grant) => grant.businessId === BUSINESS_A)).toBe(true)
    const row = listed.find((grant) => grant.id === mineA.id)!
    expect(row.person).toEqual({ name: 'Ada Person', email: expect.stringMatching(/^me-.*@example\.test$/), active: true })
    expect(Object.keys(row).sort()).toEqual(['appHosts', 'appName', 'businessId', 'businessName', 'createdAt', 'id', 'lastUsedAt', 'person', 'scopes'])
  })

  it('still shows the connection of someone who left, marked, so it can be ended', async () => {
    const theirs = await connect(users.leaver, BUSINESS_A)
    await leave(users.leaver, BUSINESS_A)
    expect(await verifyAccessToken(theirs.access)).toBeNull()
    const row = (await listBusinessConnectedApps(await adminOf(users.adminA, BUSINESS_A))).find((grant) => grant.id === theirs.id)
    expect(row?.person).toEqual({ name: null, email: expect.stringMatching(/^leaver-/), active: false })
    await revokeBusinessConnectedApp(await adminOf(users.adminA, BUSINESS_A), theirs.id)
    expect((await db.oAuthGrant.findUniqueOrThrow({ where: { id: theirs.id } })).revokeReason).toBe('admin')
  })

  it('an admin of A cannot see or revoke a connection in B (404), and it keeps working', async () => {
    const inB = await connect(users.me, BUSINESS_B)
    const adminA = await adminOf(users.adminA, BUSINESS_A)
    expect((await listBusinessConnectedApps(adminA)).map((grant) => grant.id)).not.toContain(inB.id)
    await expectNotFound(revokeBusinessConnectedApp(adminA, inB.id))
    expect(await verifyAccessToken(inB.access)).not.toBeNull()
    // B's own admin sees it.
    expect((await listBusinessConnectedApps(await adminOf(users.adminB, BUSINESS_B))).map((grant) => grant.id)).toContain(inB.id)
  })

  it('a person without sessions.manage can neither list nor revoke the business’s connections (403)', async () => {
    const theirs = await connect(users.colleague, BUSINESS_A)
    const me = await adminOf(users.me, BUSINESS_A)
    await expect(listBusinessConnectedApps(me)).rejects.toMatchObject({ code: 'forbidden', statusCode: 403 })
    await expect(revokeBusinessConnectedApp(me, theirs.id)).rejects.toMatchObject({ code: 'forbidden', statusCode: 403 })
    expect(await verifyAccessToken(theirs.access)).not.toBeNull()
  })

  it('an admin’s revoke ends the tokens at once and the audit names the admin', async () => {
    const theirs = await connect(users.colleague, BUSINESS_A)
    await revokeBusinessConnectedApp(await adminOf(users.adminA, BUSINESS_A), theirs.id)
    expect(await verifyAccessToken(theirs.access)).toBeNull()
    expect(await db.oAuthGrant.findUniqueOrThrow({ where: { id: theirs.id } })).toMatchObject({ revokedBy: users.adminA, revokeReason: 'admin' })
    expect(await db.workspaceAudit.findFirst({ where: { targetId: theirs.id } })).toMatchObject({
      workspaceId: BUSINESS_A, actorUserId: users.adminA, action: 'oauth.revoked', metadata: { reason: 'admin' },
    })
    expect((await listMyConnectedApps(users.colleague)).map((grant) => grant.id)).not.toContain(theirs.id)
    await expectNotFound(revokeBusinessConnectedApp(await adminOf(users.adminA, BUSINESS_A), theirs.id))
  })

  it('an admin ending their own connection from the business list is recorded as the person’s', async () => {
    const own = await connect(users.adminA, BUSINESS_A)
    await revokeBusinessConnectedApp(await adminOf(users.adminA, BUSINESS_A), own.id)
    expect(await db.oAuthGrant.findUniqueOrThrow({ where: { id: own.id } })).toMatchObject({ revokedBy: users.adminA, revokeReason: 'person' })
  })
})
