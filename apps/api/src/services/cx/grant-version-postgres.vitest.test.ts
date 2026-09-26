import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_t, key) => (database.client as any)[key] }) }))
vi.mock('./apps.service.js', () => ({ getChannelApp: async () => ({ clientId: 'synthetic-app', clientSecret: 'synthetic-secret' }) }))
vi.mock('../monitoring/alert.service.js', () => ({ alertService: { createAlert: vi.fn() }, AlertType: { CONNECTION_HEALTH: 'CONNECTION_HEALTH' } }))
const { storeGrant, getAccessToken, inspectEbayRefreshGrant } = await import('./token.service.js')
const { decryptCredentials } = await import('../../lib/crypto.js')
const OWNER = 'nexus_legacy_workspace', GUEST = randomUUID()
const inProfile = <T>(workspaceId: string, work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const inOwner = <T>(work: () => Promise<T>) => inProfile(OWNER, work)
const grant = (key = randomUUID()) => ({ accessToken: `synthetic-access-${key}`, refreshToken: `synthetic-refresh-${key}`, expiresInSec: 7200, grantedScopes: [], identity: null })
const actor = { kind: 'operator' as const }
async function seed() {
  const id = randomUUID()
  await database.pool.query('INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","externalAccountId","isActive","updatedAt") VALUES ($1,$2,\'EBAY\',$1,true,now())', [id, OWNER])
  return id
}
async function stored(id: string) { return inOwner(() => database.client.channelConnection.findUniqueOrThrow({ where: { id } })) }

describe.skipIf(!concurrentDatabaseUrl())('grant generations in real PostgreSQL', () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', randomBytes(32).toString('base64'))
    vi.stubEnv('NEXUS_KMS_KEY_ID', '')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network request in grant test') }))
    database = await concurrentDatabase({ maxConnections: 8 })
    await import('./connectors/ebay/spec.js')
    await database.pool.query('ALTER TABLE "ChannelConnection" DROP COLUMN "grantVersion"')
    await database.pool.query('INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","externalAccountId","isActive","authStatus","updatedAt") VALUES (\'legacy-grant\',$1,\'EBAY\',\'legacy-grant\',true,\'connected\',now())', [OWNER])
    await database.pool.query(readFileSync(new URL('../../../../../packages/database/prisma/migrations/20260923b_cx_grant_versions/migration.sql', import.meta.url), 'utf8'))
    await database.pool.query('INSERT INTO "Workspace" (id,name,"createdByUserId","creationKey","updatedAt") VALUES ($1,\'Grant test guest\',\'test\',$1,now())', [GUEST])
  }, 180_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals() }, 60_000)

  it('migrates existing grants to version zero without changing account state', async () => {
    expect(await stored('legacy-grant')).toMatchObject({ grantVersion: 0, authStatus: 'connected', isActive: true, credentialsEnc: null })
    await expect(database.pool.query('UPDATE "ChannelConnection" SET "grantVersion"=-1 WHERE id=\'legacy-grant\''))
      .rejects.toMatchObject({ code: '23514' })
  })

  it('persists new credentials and the first version in the same grant write', async () => {
    const id = await seed(), input = grant()
    await inOwner(() => storeGrant(id, input, actor, 'grant'))
    const row = await stored(id)
    expect(row).toMatchObject({ grantVersion: 1, authStatus: 'connected', isActive: true })
    expect(await decryptCredentials(row.credentialsEnc!)).toMatchObject({ accessToken: input.accessToken, refreshToken: input.refreshToken })
  })

  it('advances for every reconsent and adoption even when the token strings repeat', async () => {
    const id = await seed(), input = grant()
    for (const [index, event] of ['grant', 'reconsent', 'adopt'].entries()) {
      await inOwner(() => storeGrant(id, input, actor, event as 'grant' | 'reconsent' | 'adopt'))
      expect((await stored(id)).grantVersion).toBe(index + 1)
    }
  })

  it('serializes concurrent replacements into distinct versions paired with their credentials', async () => {
    const id = await seed(), versions: number[] = []
    const blocker = await database.pool.connect()
    await blocker.query('BEGIN')
    const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    await blocker.query('SELECT id FROM "ChannelConnection" WHERE id=$1 FOR UPDATE', [id])
    const replacements = Promise.all(Array.from({ length: 6 }, (_, i) => inOwner(async () => {
      const input = grant(String(i))
      await storeGrant(id, input, actor, 'reconsent', async tx => {
        const row = await tx.channelConnection.findUniqueOrThrow({ where: { id } })
        versions.push(row.grantVersion)
        expect(await decryptCredentials(row.credentialsEnc!)).toMatchObject({ refreshToken: input.refreshToken })
      })
    })))
    let waiting = 0
    try {
      const deadline = Date.now() + 3_000
      while (waiting < 6 && Date.now() < deadline) {
        // PostgreSQL reports both the hard blocker and queued soft blockers.
        // Every replacement must have read version zero before releasing them.
        waiting = Number((await database.pool.query('SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type=\'Lock\' AND pid<>$1', [pid])).rows[0].n)
        if (waiting < 6) await new Promise(resolve => setTimeout(resolve, 20))
      }
    } finally { await blocker.query('COMMIT'); blocker.release() }
    await replacements
    expect(waiting).toBe(6)
    expect(versions.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6])
    expect((await stored(id)).grantVersion).toBe(6)
  })

  it('rolls version and credentials back together when related grant persistence fails', async () => {
    const id = await seed()
    await inOwner(() => storeGrant(id, grant(), actor, 'grant'))
    const before = await stored(id)
    await expect(inOwner(() => storeGrant(id, grant(), actor, 'reconsent', async tx => {
      expect((await tx.channelConnection.findUniqueOrThrow({ where: { id } })).grantVersion).toBe(2)
      throw new Error('Synthetic related-persistence failure')
    }))).rejects.toThrow('Synthetic related-persistence failure')
    expect(await stored(id)).toEqual(before)
    expect(await inOwner(() => database.client.connectionEvent.count({ where: { connectionId: id, type: 'reconsent' } }))).toBe(0)
  })

  it('keeps the generation during an ordinary access-token refresh', async () => {
    const id = await seed()
    await inOwner(() => storeGrant(id, grant(), actor, 'grant'))
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'synthetic-refreshed-access', expires_in: 7200 }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    await expect(inOwner(() => getAccessToken(id, { forceRefresh: true }))).resolves.toBe('synthetic-refreshed-access')
    expect((await stored(id)).grantVersion).toBe(1)
  })

  it('does not allow a read guest to replace the owned grant or version', async () => {
    const id = await seed()
    await inOwner(() => storeGrant(id, grant(), actor, 'grant'))
    await database.pool.query('INSERT INTO "ChannelAccountGrant" ("connectionId","workspaceId","ownerWorkspaceId",mode,"grantedByUserId","grantedAt") VALUES ($1,$2,$3,\'read\',\'test\',now())', [id, GUEST, OWNER])
    expect(await inProfile(GUEST, () => database.client.channelConnection.findUnique({ where: { id } }))).toMatchObject({ id, workspaceId: OWNER })
    const before = await stored(id)
    await expect(inProfile(GUEST, () => storeGrant(id, grant(), actor, 'reconsent'))).rejects.toThrow()
    expect(await stored(id)).toEqual(before)
  })

  it('inspects the real owned grant without mutating it, including an inactive refresh token', async () => {
    const id = await seed(), input = grant()
    await inOwner(() => storeGrant(id, input, actor, 'grant'))
    const before = await stored(id)
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ active: false }), { status: 200 }))
    expect(await inOwner(() => inspectEbayRefreshGrant(id))).toEqual({ connectionId: id, workspaceId: OWNER, grantVersion: 1, active: false })
    const call = vi.mocked(fetch).mock.calls.at(-1)!
    expect(new URLSearchParams(String(call[1]?.body)).get('token')).toBe(input.refreshToken)
    expect(await stored(id)).toEqual(before)
  })

  it('retains the inspected generation when a real reconnect commits during the remote read', async () => {
    const id = await seed(), next = grant()
    await inOwner(() => storeGrant(id, grant(), actor, 'grant'))
    vi.mocked(fetch).mockImplementationOnce(async () => {
      await inOwner(() => storeGrant(id, next, actor, 'reconsent'))
      return new Response(JSON.stringify({ active: false }), { status: 200 })
    })
    expect(await inOwner(() => inspectEbayRefreshGrant(id))).toMatchObject({ grantVersion: 1, active: false })
    const current = await stored(id)
    expect(current.grantVersion).toBe(2)
    expect(await decryptCredentials(current.credentialsEnc!)).toMatchObject({ refreshToken: next.refreshToken })
  })

  it('refuses lifecycle inspection to a readable publish guest without a channel call', async () => {
    const id = await seed()
    await inOwner(() => storeGrant(id, grant(), actor, 'grant'))
    await database.pool.query('INSERT INTO "ChannelAccountGrant" ("connectionId","workspaceId","ownerWorkspaceId",mode,"grantedByUserId","grantedAt") VALUES ($1,$2,$3,\'publish\',\'test\',now())', [id, GUEST, OWNER])
    expect(await inProfile(GUEST, () => database.client.channelConnection.findUnique({ where: { id } }))).toMatchObject({ id, workspaceId: OWNER })
    const before = vi.mocked(fetch).mock.calls.length
    await expect(inProfile(GUEST, () => inspectEbayRefreshGrant(id))).rejects.toMatchObject({ code: 'account_not_owned' })
    expect(fetch).toHaveBeenCalledTimes(before)
  })
})
