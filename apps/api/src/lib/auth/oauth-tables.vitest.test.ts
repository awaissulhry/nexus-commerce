/**
 * MCP.4 — the tables behind "connect Claude to Nexus", on a real PostgreSQL with the production
 * schema, grants and business policies (PGlite), business profiles ON.
 *
 * The OAuth tables are global on purpose: the token endpoint and /mcp must find a token before
 * they know its business. These tests prove that works as the restricted runtime role, that a
 * person has one connection per business and app, that removing a connection removes its secrets,
 * and that an agent run records the front door a request came through.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
let userId: string
let clientRowId: string

const inBusiness = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)

const hash = () => randomUUID().replace(/-/g, '')

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  userId = (await database.client.userProfile.create({
    data: { email: `${randomUUID()}@example.test`, status: 'active' },
  })).id
  clientRowId = (await database.client.oAuthClient.create({
    data: {
      clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
      registration: 'cimd',
      clientName: 'Claude Code',
      redirectUris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    },
  })).id
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

async function newGrant() {
  await database.client.oAuthGrant.deleteMany({ where: { userId, clientId: clientRowId } })
  return database.client.oAuthGrant.create({
    data: { workspaceId: LEGACY_WORKSPACE_ID, userId, clientId: clientRowId, scopes: ['nexus.read'] },
  })
}

describe('MCP.4 — the OAuth tables', () => {
  it('a token is found by its hash with no business selected, and names its business', async () => {
    const grant = await newGrant()
    const tokenHash = hash()
    await database.client.oAuthToken.create({
      data: {
        tokenHash,
        kind: 'access',
        grantId: grant.id,
        resource: 'https://nexusapi.example.test/mcp',
        scopes: ['nexus.read'],
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })
    // No withWorkspace here: this is the /mcp request before it knows anything.
    const found = await database.client.oAuthToken.findUnique({
      where: { tokenHash },
      include: { grant: { select: { workspaceId: true, userId: true } } },
    })
    expect(found?.grant).toEqual({ workspaceId: LEGACY_WORKSPACE_ID, userId })
  })

  it('one connection per person, business and app', async () => {
    await newGrant()
    await expect(
      database.client.oAuthGrant.create({
        data: { workspaceId: LEGACY_WORKSPACE_ID, userId, clientId: clientRowId, scopes: ['nexus.write'] },
      }),
    ).rejects.toMatchObject({ code: 'P2002' })
  })

  it('removing a connection removes its codes and tokens', async () => {
    const grant = await newGrant()
    await database.client.oAuthAuthorizationCode.create({
      data: {
        codeHash: hash(),
        grantId: grant.id,
        redirectUri: 'https://claude.ai/api/mcp/auth_callback',
        codeChallenge: 'challenge',
        resource: 'https://nexusapi.example.test/mcp',
        scopes: ['nexus.read'],
        expiresAt: new Date(Date.now() + 60_000),
      },
    })
    await database.client.oAuthToken.create({
      data: {
        tokenHash: hash(),
        kind: 'refresh',
        grantId: grant.id,
        resource: 'https://nexusapi.example.test/mcp',
        scopes: ['nexus.read'],
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    })
    await database.client.oAuthGrant.delete({ where: { id: grant.id } })
    expect(await database.client.oAuthAuthorizationCode.count({ where: { grantId: grant.id } })).toBe(0)
    expect(await database.client.oAuthToken.count({ where: { grantId: grant.id } })).toBe(0)
  })

  it('an agent run records the front door and the connection, inside its business', async () => {
    const grant = await newGrant()
    const run = await inBusiness(() =>
      database.client.agentRun.create({
        data: { agentKey: 'mcp', trigger: 'manual', userId, via: 'claude', oauthGrantId: grant.id },
      }),
    )
    const read = await inBusiness(() =>
      database.client.agentRun.findUnique({ where: { id: run.id }, select: { via: true, oauthGrantId: true } }),
    )
    expect(read).toEqual({ via: 'claude', oauthGrantId: grant.id })
    // No foreign key: the record outlives the connection.
    await database.client.oAuthGrant.delete({ where: { id: grant.id } })
    const after = await inBusiness(() =>
      database.client.agentRun.findUnique({ where: { id: run.id }, select: { oauthGrantId: true } }),
    )
    expect(after?.oauthGrantId).toBe(grant.id)
  })
})
