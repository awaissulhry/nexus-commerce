/**
 * MCP full control P4 — business-overview, channel-connections, channel-health and team-access, run for real through
 * the one door (call-tool.ts) on PGlite with the production schema and the business-isolation policies.
 *
 *   · each tool refuses a person without its permission, and a wrongly made call;
 *   · no token, secret, app id or person's e-mail ever comes back, even when the rows hold them;
 *   · a shared account is named only to its members: the business it is shared with sees it (and by whom), a
 *     business it is not shared with does not, and a revoked share takes it away;
 *   · business-overview never writes (the route's GET creates a missing brand row; this read does not);
 *   · profiles off: one business, the global team, no sharing.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Pick<Awaited<ReturnType<typeof formulaDatabase>>, 'client' | 'close'>
vi.mock('../../../db.js', async () => {
  const { contextualDatabase } = await import('../../../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
})

// Nothing here enqueues; without this the queue module dials Redis on import.
vi.mock('../../../lib/queue.js', () => ({ outboundSyncQueue: null, bulkJobQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }))

import { callTool, ToolAccessError, type UserPrincipal } from '../call-tool.js'

const A = LEGACY_WORKSPACE_ID
const B = 'p4_business_bravo'
const C = 'p4_business_charlie'
/** Values that must never reach Claude: credentials, app ids, people's e-mails. */
const SECRETS = {
  accessToken: 'v^1.1#i^1#P4-ACCESS-SECRET',
  refreshToken: 'Atzr|P4-REFRESH-SECRET',
  credentialsEnc: 'P4-ENCRYPTED-BLOB',
  credentialsKeyId: 'P4-KMS-KEY-ID',
  ebayAppId: 'P4-EBAY-APP-ID',
  ebayDevId: 'P4-EBAY-DEV-ID',
  eventToken: 'P4-EVENT-TOKEN-VALUE',
  memberEmail: 'p4-member@example.test',
  inviteEmail: 'p4-invitee@example.test',
  identityEmail: 'p4-seller@example.test',
}

const business = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inside = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace(business(workspaceId), work)

function person(permissions: string[], workspaceId: string | null = A): UserPrincipal {
  return {
    kind: 'user',
    userId: 'u-p4',
    label: 'P4 test',
    permissions: { isOwner: false, permissions: new Set([FEATURES.aiRun, ...permissions]) },
    ...(workspaceId ? { workspace: business(workspaceId) } : {}),
    via: 'claude',
  }
}
const everything = (workspaceId: string | null = A) => person([...Object.values(FEATURES), ...Object.values(FIELDS)], workspaceId)

async function run(who: UserPrincipal, tool: string, args: Record<string, unknown> = {}) {
  try {
    const call = await callTool(who, tool, args)
    return { result: call.visible, refused: null as ToolAccessError | null }
  } catch (error) {
    if (error instanceof ToolAccessError) return { result: null, refused: error }
    throw error
  }
}
const data = async (who: UserPrincipal, tool: string, args: Record<string, unknown> = {}) => {
  const { result, refused } = await run(who, tool, args)
  if (refused) throw refused
  expect(result?.ok, JSON.stringify(result)).toBe(true)
  return result!.data as any
}

const ids = { aOwn: '', aOff: '', bShared: '', bPrivate: '', memberUser: '' }

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  const db = database.client
  const owner = await db.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active', displayName: 'P4 Owner' } })
  for (const [id, name] of [[B, 'Bravo P4'], [C, 'Charlie P4']] as const) {
    await db.workspace.create({ data: { id, name, createdByUserId: owner.id, creationKey: randomUUID() } })
  }
  await inside(A, async () => {
    await db.accountSettings.upsert({
      where: { workspaceId: A },
      create: { businessName: 'Alpha P4 Srl', country: 'IT', currency: 'EUR', timezone: 'Europe/Rome', primaryMarketplace: 'IT' },
      update: { businessName: 'Alpha P4 Srl', country: 'IT', currency: 'EUR', timezone: 'Europe/Rome', primaryMarketplace: 'IT' },
    })
    await db.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'eBay Italy', region: 'EU', currency: 'EUR', language: 'it', languages: ['it'], marketplaceId: 'EBAY_IT' } })
    const own = await db.channelConnection.create({
      data: {
        channelType: 'EBAY', managedBy: 'oauth', isActive: true, isPrimary: true, accountLabel: 'Alpha eBay', authStatus: 'connected',
        accessToken: SECRETS.accessToken, refreshToken: SECRETS.refreshToken, credentialsEnc: SECRETS.credentialsEnc,
        credentialsKeyId: SECRETS.credentialsKeyId, ebayAppId: SECRETS.ebayAppId, ebayDevId: SECRETS.ebayDevId,
        identity: { email: SECRETS.identityEmail, userId: 'seller-1' }, grantedScopes: ['https://api.ebay.com/oauth/api_scope'],
        lastError: `refresh failed for Bearer ${SECRETS.accessToken}`, refreshTokenExpiresAt: new Date('2027-01-01T00:00:00Z'),
      },
    })
    ids.aOwn = own.id
    ids.aOff = (await db.channelConnection.create({ data: { channelType: 'SHOPIFY', managedBy: 'oauth', isActive: false, accountLabel: 'Alpha old shop', authStatus: 'disconnected' } })).id
    await db.connectionEvent.create({
      data: { connectionId: own.id, channelKey: 'ebay', type: 'token.refreshed', detail: { refreshToken: SECRETS.eventToken, note: `owner ${SECRETS.memberEmail}`, scopes: 3 } },
    })
    await db.outboundApiCallLog.create({ data: { channel: 'EBAY', operation: 'P4-ALPHA-OP', success: false, latencyMs: 120, traceId: 'p4-trace-a', errorMessage: `401 for ${SECRETS.accessToken}` } })
  })
  await inside(B, async () => {
    ids.bShared = (await db.channelConnection.create({ data: { channelType: 'AMAZON', managedBy: 'oauth', isActive: true, accountLabel: 'Bravo shared Amazon', authStatus: 'connected', externalAccountId: 'TEST-SELLER-B1' } })).id
    ids.bPrivate = (await db.channelConnection.create({ data: { channelType: 'AMAZON', managedBy: 'oauth', isActive: true, accountLabel: 'BRAVO private Amazon', authStatus: 'connected', externalAccountId: 'TEST-SELLER-B2' } })).id
    await db.outboundApiCallLog.create({ data: { channel: 'EBAY', operation: 'BRAVO-OP', success: true, latencyMs: 80, traceId: 'p4-trace-b' } })
  })
  // B shares one account with A (an owner's act in B); C is shared nothing.
  await inside(B, () => db.channelAccountGrant.create({
    data: { connectionId: ids.bShared, workspaceId: A, ownerWorkspaceId: B, grantedByUserId: owner.id, mode: 'read', marketplaces: ['IT'] },
  }))

  // The team of A: a custom role, a member limited to one account, an invitation waiting.
  const role = await db.role.create({ data: { workspaceId: A, key: `business_${randomUUID()}`, name: 'P4 catalog editor', permissions: [FEATURES.productsView, FEATURES.productsEdit] } })
  const member = await db.userProfile.create({ data: { email: SECRETS.memberEmail, status: 'active', displayName: 'Paola Quattro' } })
  ids.memberUser = member.id
  const nameless = await db.userProfile.create({ data: { email: `nameless-${randomUUID()}@example.test`, status: 'active' } })
  const membership = await db.workspaceMembership.create({ data: { workspaceId: A, userId: member.id, status: 'active', roles: { create: [{ roleId: role.id }] } } })
  await db.workspaceMembership.create({ data: { workspaceId: A, userId: nameless.id, status: 'active', roles: { create: [{ roleId: role.id }] } } })
  await db.workspaceMembership.create({ data: { workspaceId: B, userId: owner.id, status: 'active' } })
  await inside(A, async () => {
    await db.workspaceMemberAccountLimit.create({ data: { membershipId: membership.id, setByUserId: owner.id } })
    await db.workspaceMemberAccount.create({ data: { membershipId: membership.id, connectionId: ids.aOwn, grantedByUserId: owner.id } })
  })
  await db.workspaceInvitation.create({
    data: { workspaceId: A, email: SECRETS.inviteEmail, roleIds: [role.id], tokenHash: randomUUID(), invitedByUserId: owner.id, expiresAt: new Date(Date.now() + 86_400_000) },
  })
}, 120_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

const noSecretIn = (value: unknown) => {
  const text = JSON.stringify(value)
  for (const [name, secret] of Object.entries(SECRETS)) expect(text, `${name} leaked`).not.toContain(secret)
  expect(text).not.toMatch(/ebayAppId|ebayDevId|credentials/)
}

describe('P4 — every tool refuses what it should', () => {
  it('a person without the permission is refused, before anything runs', async () => {
    expect((await run(person([FEATURES.productsView]), 'business-overview')).refused?.code).toBe('forbidden')
    expect((await run(person([FEATURES.productsView]), 'channel-connections')).refused?.code).toBe('forbidden')
    expect((await run(person([FEATURES.settingsView]), 'channel-health')).refused?.code).toBe('forbidden')
    // team-access needs both: users.manage alone is not enough.
    expect((await run(person([FEATURES.usersManage]), 'team-access')).refused?.code).toBe('forbidden')
    // Control: with the permissions each runs.
    expect((await run(person([FEATURES.settingsView]), 'business-overview')).result?.ok).toBe(true)
    expect((await run(person([FEATURES.usersManage, FEATURES.rolesManage]), 'team-access')).result?.ok).toBe(true)
  })

  it('a wrongly made call is refused by its schema', async () => {
    expect((await run(everything(), 'channel-connections', { channel: 'NOPE' })).refused?.code).toBe('invalid_arguments')
    expect((await run(everything(), 'channel-health', { hours: 500 })).refused?.code).toBe('invalid_arguments')
    expect((await run(everything(), 'channel-health', { hours: 0 })).refused?.code).toBe('invalid_arguments')
  })
})

describe('P4 — business-overview', () => {
  it('names the business, its settings, markets and accounts; reads without writing the brand row', async () => {
    const before = await inside(A, () => database.client.brandSettings.count())
    const overview = await data(everything(), 'business-overview')
    expect(overview).toMatchObject({
      settings: { businessName: 'Alpha P4 Srl', country: 'IT', currency: 'EUR', timezone: 'Europe/Rome', primaryMarketplace: 'IT' },
      brand: {},
      markets: [{ channel: 'EBAY', code: 'IT', currency: 'EUR', languages: ['it'], active: true }],
    })
    // Own live accounts and the one shared in are connected; the disconnected one is not counted.
    expect(overview.connectedAccounts).toEqual({ AMAZON: 1, EBAY: 1 })
    expect(await inside(A, () => database.client.brandSettings.count())).toBe(before)
  })

  it('shows the company and legal details once they are set', async () => {
    await inside(A, () => database.client.brandSettings.create({ data: { companyName: 'Alpha P4 Srl', piva: '01234567890', contactEmail: 'shop@example.test', signatureBlockText: 'not shown' } }))
    const overview = await data(everything(), 'business-overview')
    expect(overview.brand).toEqual({ companyName: 'Alpha P4 Srl', piva: '01234567890', contactEmail: 'shop@example.test' })
  })
})

describe('P4 — channel-connections', () => {
  it('lists the live accounts with health and sharing, and never a token, secret, app id or e-mail', async () => {
    const { accounts, notConnected } = await data(everything(), 'channel-connections')
    expect(accounts.map((a: any) => a.label).sort()).toEqual(['Alpha eBay', 'Bravo shared Amazon'])
    const own = accounts.find((a: any) => a.id === ids.aOwn)
    expect(own).toMatchObject({ channel: 'EBAY', ownedHere: true, isPrimary: true, authStatus: 'connected', signInExpiresAt: '2027-01-01T00:00:00.000Z' })
    expect(own.lastError).toBe('refresh failed for [hidden]')
    expect(notConnected).toEqual(['SHOPIFY'])
    noSecretIn(accounts)
  })

  it('a shared account is named only to its members, and a revoked share takes it away', async () => {
    const inA = await data(everything(A), 'channel-connections')
    expect(inA.accounts.find((a: any) => a.id === ids.bShared)).toMatchObject({ ownedHere: false, sharedBy: 'Bravo P4', shareMode: 'read', shareMarketplaces: ['IT'], isPrimary: false })
    expect(JSON.stringify(inA)).not.toContain('BRAVO private')
    // The owner sees its account as shared out; a business it is not shared with sees nothing of it.
    const inB = await data(everything(B), 'channel-connections')
    expect(inB.accounts.find((a: any) => a.id === ids.bShared)).toMatchObject({ ownedHere: true, sharedWithBusinesses: 1 })
    const inC = await data(everything(C), 'channel-connections')
    expect(inC.accounts).toEqual([])
    expect((await run(everything(C), 'channel-connections', { connectionId: ids.bShared })).result).toEqual({ ok: false, error: 'Account not found' })
    const share = (revokedAt: Date | null) => inside(B, () => database.client.channelAccountGrant.update({ where: { connectionId_workspaceId: { connectionId: ids.bShared, workspaceId: A } }, data: { revokedAt } }))
    await share(new Date())
    try {
      const after = await data(everything(A), 'channel-connections')
      expect(after.accounts.map((a: any) => a.id)).toEqual([ids.aOwn])
    } finally {
      await share(null)
    }
  })

  it('one account: its events, with secret keys and e-mails hidden; another business’s account is not found', async () => {
    const one = await data(everything(), 'channel-connections', { connectionId: ids.aOwn })
    expect(one.account.id).toBe(ids.aOwn)
    expect(one.events).toEqual([{ type: 'token.refreshed', at: expect.any(String), detail: { refreshToken: '[hidden]', note: 'owner p***@example.test', scopes: 3 } }])
    noSecretIn(one)
    expect((await run(everything(), 'channel-connections', { connectionId: ids.bPrivate })).result).toEqual({ ok: false, error: 'Account not found' })
    // A disconnected account is reached by its id (profiles on), and the channel filter narrows the list.
    expect((await data(everything(), 'channel-connections', { connectionId: ids.aOff })).account).toMatchObject({ isActive: false, health: 'error' })
    expect((await data(everything(), 'channel-connections', { channel: 'ebay' })).accounts.map((a: any) => a.id)).toEqual([ids.aOwn])
  })
})

describe('P4 — channel-health', () => {
  it('reports the window per channel, and the calls of one trace in this business only', async () => {
    const health = await data(everything(), 'channel-health', { channel: 'EBAY', hours: 48, traceId: 'p4-trace-a' })
    expect(health.hours).toBe(48)
    expect(health.channels).toHaveLength(1)
    expect(health.channels[0]).toMatchObject({ channel: 'EBAY', calls: 1, errorRate: { value: 100, verdict: 'missing' } })
    expect(health.channels[0].worstOperations[0].operation).toBe('P4-ALPHA-OP')
    expect(health.trace).toEqual([expect.objectContaining({ operation: 'P4-ALPHA-OP', success: false, errorMessage: '401 for [hidden]' })])
    expect(JSON.stringify(health)).not.toContain('BRAVO')
    // B's trace from A: nothing.
    const other = await data(everything(), 'channel-health', { traceId: 'p4-trace-b' })
    expect(other.trace).toBe('No channel call carries this trace id in this business.')
    noSecretIn(health)
  })
})

describe('P4 — team-access', () => {
  it('names the members, their roles and account limits; counts invitations; never an e-mail', async () => {
    const team = await data(person([FEATURES.usersManage, FEATURES.rolesManage]), 'team-access')
    expect(team.members).toEqual([
      { name: 'Paola Quattro', status: 'active', roles: ['P4 catalog editor'], accounts: ['EBAY · Alpha eBay'] },
      { name: 'a team member', status: 'active', roles: ['P4 catalog editor'], accounts: 'all' },
    ])
    expect(team.roles).toContainEqual({ name: 'P4 catalog editor', key: expect.any(String), system: false, description: null, permissions: [FEATURES.productsEdit, FEATURES.productsView] })
    expect(team.pendingInvitations).toBe(1)
    expect(JSON.stringify(team)).not.toContain('@example.test')
    // Another business's team is its own: B has its one member and none of A's.
    const inB = await data(everything(B), 'team-access')
    expect(inB.members).toEqual([{ name: 'P4 Owner', status: 'active', roles: [], accounts: 'all' }])
    expect(inB.pendingInvitations).toBe(0)
  })
})

describe('P4 — business profiles off: one business', () => {
  it('runs without a business: the global team, no sharing, no disconnected accounts', async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '0')
    try {
      const team = await data(everything(null), 'team-access')
      expect(team.members.map((m: any) => m.name)).toEqual(expect.arrayContaining(['P4 Owner', 'Paola Quattro', 'a team member']))
      expect(team).not.toHaveProperty('pendingInvitations')
      expect(JSON.stringify(team)).not.toContain('@example.test')
      const { accounts } = await data(everything(null), 'channel-connections', { includeDisconnected: true })
      expect(accounts.every((a: any) => a.isActive && a.ownedHere)).toBe(true)
      noSecretIn(accounts)
      expect((await run(everything(null), 'business-overview')).result?.ok).toBe(true)
    } finally {
      vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    }
  })
})
