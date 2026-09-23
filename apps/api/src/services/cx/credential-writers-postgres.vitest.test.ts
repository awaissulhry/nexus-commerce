import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_t, key) => (database.client as any)[key] }) }))
vi.mock('./apps.service.js', () => ({ getChannelApp: async () => ({ clientId: 'synthetic-app', clientSecret: 'synthetic-secret' }) }))
vi.mock('../../utils/cron-observability.js', () => ({ recordCronRun: async (_name: string, work: () => Promise<string>) => work() }))
vi.mock('../monitoring/alert.service.js', () => ({ alertService: { createAlert: vi.fn() }, AlertType: { CONNECTION_HEALTH: 'CONNECTION_HEALTH' } }))
const crypto = await import('../../lib/crypto.js')
const { storeGrant, getAccessToken, revoke, encryptLegacyRow, restorePlaintextRow } = await import('./token.service.js')
const { runCredentialsRotate } = await import('../../jobs/cx-credentials-rotate.job.js')
const OWNER = 'nexus_legacy_workspace'
const inOwner = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: OWNER, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const grant = (key = randomUUID()) => ({ accessToken: `synthetic-access-${key}`, refreshToken: `synthetic-refresh-${key}`, expiresInSec: 7200, grantedScopes: [], identity: null })
const actor = { kind: 'operator' as const }
async function seed() {
  const id = randomUUID()
  await database.pool.query('INSERT INTO "ChannelConnection" (id,"workspaceId","channelType","externalAccountId","isActive","updatedAt") VALUES ($1,$2,\'EBAY\',$1,true,now())', [id, OWNER])
  await inOwner(() => storeGrant(id, grant(), actor, 'grant'))
  return id
}
async function stored(id: string) { return inOwner(() => database.client.channelConnection.findUniqueOrThrow({ where: { id } })) }
function barrier() {
  let enter!: () => void, release!: () => void
  return { entered: new Promise<void>(r => { enter = r }), released: new Promise<void>(r => { release = r }), enter: () => enter(), release: () => release() }
}
function pauseReencryption() {
  const gate = barrier(), original = crypto.reencryptCredentials
  vi.spyOn(crypto, 'reencryptCredentials').mockImplementationOnce(async blob => {
    const result = await original(blob)
    gate.enter(); await gate.released
    // A synthetic target-key result exercises the real guarded DB writer without
    // any AWS call. Ciphertext uses the real local crypto; this is not KMS proof.
    return { ...result, mode: 'kms', keyId: 'synthetic-target-key' }
  })
  return gate
}

describe.skipIf(!concurrentDatabaseUrl())('credential writer races in real PostgreSQL', () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', randomBytes(32).toString('base64'))
    vi.stubEnv('NEXUS_KMS_KEY_ID', '')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network request in credential test') }))
    database = await concurrentDatabase({ maxConnections: 8 })
    await import('./connectors/ebay/spec.js')
  }, 180_000)
  beforeEach(async () => {
    vi.restoreAllMocks()
    await database.pool.query('DELETE FROM "ChannelConnection"')
    await database.pool.query('DELETE FROM "ChannelApp"')
  })
  afterAll(async () => { await database?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals() }, 60_000)

  it('does not restore the old grant when reconnect wins during re-encryption', async () => {
    const id = await seed(), gate = pauseReencryption()
    const rotation = inOwner(() => runCredentialsRotate())
    await gate.entered
    const input = grant('reconnected')
    try { await inOwner(() => storeGrant(id, input, actor, 'reconsent')) } finally { gate.release() }
    const result = await rotation
    const row = await stored(id)
    expect(row.grantVersion).toBe(2)
    expect(await crypto.decryptCredentials(row.credentialsEnc!)).toMatchObject({ refreshToken: input.refreshToken })
    expect(result).toContain('contended=1')
    expect(await inOwner(() => database.client.connectionEvent.count({ where: { connectionId: id, type: 'secret_rotated' } }))).toBe(0)
  })

  it('does not overwrite an access-token refresh with the older encrypted snapshot', async () => {
    const id = await seed(), gate = pauseReencryption()
    const rotation = inOwner(() => runCredentialsRotate())
    await gate.entered
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'synthetic-current-access', expires_in: 7200 }), { status: 200 }))
    try { await inOwner(() => getAccessToken(id, { forceRefresh: true })) } finally { gate.release() }
    const result = await rotation
    const row = await stored(id)
    expect(row.grantVersion).toBe(1)
    expect(await crypto.decryptCredentials(row.credentialsEnc!)).toMatchObject({ accessToken: 'synthetic-current-access' })
    expect(result).toContain('contended=1')
  })

  it('does not restore credentials cleared by disconnect while re-encryption was running', async () => {
    const id = await seed(), gate = pauseReencryption()
    const rotation = inOwner(() => runCredentialsRotate())
    await gate.entered
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 200 }))
    try { await inOwner(() => revoke(id, actor, 'operator')) } finally { gate.release() }
    const result = await rotation
    expect(await stored(id)).toMatchObject({ credentialsEnc: null, credentialsKeyId: null, isActive: false, authStatus: 'disconnected' })
    expect(result).toContain('contended=1')
  })

  it('still persists uncontested re-encryption without advancing the grant version', async () => {
    const id = await seed(), before = await stored(id), gate = pauseReencryption()
    const rotation = inOwner(() => runCredentialsRotate())
    await gate.entered; gate.release()
    expect(await rotation).toContain('rotated=1')
    const row = await stored(id)
    expect(row.grantVersion).toBe(1)
    expect(row.credentialsEnc).not.toBe(before.credentialsEnc)
    expect(await crypto.decryptCredentials(row.credentialsEnc!)).toEqual(await crypto.decryptCredentials(before.credentialsEnc!))
    expect(await inOwner(() => database.client.connectionEvent.count({ where: { connectionId: id, type: 'secret_rotated' } }))).toBe(1)
  })

  it('preserves concurrent app-secret replacement instead of restoring its old value', async () => {
    const original = await crypto.encryptCredentials({ clientSecret: 'synthetic-old-secret' })
    const replacement = await crypto.encryptCredentials({ clientSecret: 'synthetic-new-secret' })
    const signing = await crypto.encryptCredentials({ signingKey: 'synthetic-signing-key' })
    const id = randomUUID()
    await database.pool.query('INSERT INTO "ChannelApp" (id,"channelKey","clientId","clientSecretEnc","signingKeyEnc","updatedAt") VALUES ($1,\'EBAY\',\'synthetic-app\',$2,$3,now())', [id, original.blob, signing.blob])
    const gate = pauseReencryption(), rotation = inOwner(() => runCredentialsRotate())
    await gate.entered
    try { await database.pool.query('UPDATE "ChannelApp" SET "clientSecretEnc"=$1 WHERE id=$2', [replacement.blob, id]) } finally { gate.release() }
    const result = await rotation
    const row = (await database.pool.query('SELECT "clientSecretEnc","signingKeyEnc" FROM "ChannelApp" WHERE id=$1', [id])).rows[0]
    expect(row).toEqual({ clientSecretEnc: replacement.blob, signingKeyEnc: signing.blob })
    expect(result).toContain('appContended=1')
  })

  it('does not encrypt stale plaintext after another writer replaces the legacy tokens', async () => {
    const id = await seed()
    await database.pool.query('UPDATE "ChannelConnection" SET "credentialsEnc"=NULL,"accessToken"=\'legacy-access\',"refreshToken"=\'legacy-refresh\' WHERE id=$1', [id])
    const gate = barrier(), encrypt = crypto.encryptCredentials
    vi.spyOn(crypto, 'encryptCredentials').mockImplementationOnce(async data => {
      const result = await encrypt(data); gate.enter(); await gate.released; return result
    })
    const backfill = inOwner(() => encryptLegacyRow(id))
    await gate.entered
    try { await database.pool.query('UPDATE "ChannelConnection" SET "accessToken"=\'new-legacy-access\',"refreshToken"=\'new-legacy-refresh\' WHERE id=$1', [id]) } finally { gate.release() }
    expect(await backfill).toBe('skipped')
    expect(await stored(id)).toMatchObject({ credentialsEnc: null, accessToken: 'new-legacy-access', refreshToken: 'new-legacy-refresh' })
  })

  it('does not restore stale plaintext after reconnect replaces the encrypted grant', async () => {
    const id = await seed(), gate = barrier(), decrypt = crypto.decryptCredentials
    vi.spyOn(crypto, 'decryptCredentials').mockImplementationOnce(async blob => {
      const result = await decrypt(blob); gate.enter(); await gate.released; return result
    })
    const restoring = inOwner(() => restorePlaintextRow(id))
    await gate.entered
    const input = grant('newer')
    try { await inOwner(() => storeGrant(id, input, actor, 'reconsent')) } finally { gate.release() }
    expect(await restoring).toBe(false)
    const row = await stored(id)
    expect(row).toMatchObject({ grantVersion: 2, accessToken: null, refreshToken: null, ebayAccessToken: null, ebayRefreshToken: null })
    expect(await crypto.decryptCredentials(row.credentialsEnc!)).toMatchObject({ refreshToken: input.refreshToken })
  })

  it('does not resurrect a legacy credential cleared during backfill encryption', async () => {
    const id = await seed()
    await database.pool.query('UPDATE "ChannelConnection" SET "credentialsEnc"=NULL,"accessToken"=\'legacy-access\',"refreshToken"=\'legacy-refresh\' WHERE id=$1', [id])
    const gate = barrier(), encrypt = crypto.encryptCredentials
    vi.spyOn(crypto, 'encryptCredentials').mockImplementationOnce(async data => {
      const result = await encrypt(data); gate.enter(); await gate.released; return result
    })
    const backfill = inOwner(() => encryptLegacyRow(id))
    await gate.entered
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 200 }))
    try { await inOwner(() => revoke(id, actor, 'operator')) } finally { gate.release() }
    expect(await backfill).toBe('skipped')
    expect(await stored(id)).toMatchObject({ credentialsEnc: null, accessToken: null, refreshToken: null, isActive: false, authStatus: 'disconnected' })
  })

  it('does not replace an expiry correction using an older plaintext snapshot', async () => {
    const id = await seed(), corrected = new Date('2031-01-02T03:04:05Z')
    await database.pool.query('UPDATE "ChannelConnection" SET "credentialsEnc"=NULL,"accessToken"=\'legacy-access\',"refreshToken"=\'legacy-refresh\' WHERE id=$1', [id])
    const gate = barrier(), encrypt = crypto.encryptCredentials
    vi.spyOn(crypto, 'encryptCredentials').mockImplementationOnce(async data => {
      const result = await encrypt(data); gate.enter(); await gate.released; return result
    })
    const backfill = inOwner(() => encryptLegacyRow(id))
    await gate.entered
    try { await database.pool.query('UPDATE "ChannelConnection" SET "tokenExpiresAt"=$1 WHERE id=$2', [corrected.toISOString(), id]) } finally { gate.release() }
    expect(await backfill).toBe('skipped')
    expect(await stored(id)).toMatchObject({ credentialsEnc: null, accessToken: 'legacy-access', tokenExpiresAt: corrected })
  })

  it('does not restore plaintext after disconnect during decryption', async () => {
    const id = await seed(), gate = barrier(), decrypt = crypto.decryptCredentials
    vi.spyOn(crypto, 'decryptCredentials').mockImplementationOnce(async blob => {
      const result = await decrypt(blob); gate.enter(); await gate.released; return result
    })
    const restoring = inOwner(() => restorePlaintextRow(id))
    await gate.entered
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 200 }))
    try { await inOwner(() => revoke(id, actor, 'operator')) } finally { gate.release() }
    expect(await restoring).toBe(false)
    expect(await stored(id)).toMatchObject({ credentialsEnc: null, accessToken: null, refreshToken: null, ebayAccessToken: null, ebayRefreshToken: null, isActive: false })
  })

  it('preserves the intentional plaintext rollback when its snapshot is still current', async () => {
    const id = await seed(), before = await stored(id)
    const credentials = await crypto.decryptCredentials(before.credentialsEnc!)
    expect(await inOwner(() => restorePlaintextRow(id))).toBe(true)
    expect(await stored(id)).toMatchObject({ grantVersion: before.grantVersion, credentialsEnc: before.credentialsEnc, accessToken: credentials.accessToken, refreshToken: credentials.refreshToken })
  })
})
