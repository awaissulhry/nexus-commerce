/**
 * The credential key preflight, and the rotation it guards.
 *
 * The scenario these exist for: an IAM policy that grants `kms:GenerateDataKey` but
 * not `kms:Decrypt`. Wrapping succeeds, so envelopes store cleanly — and nothing can
 * ever open them. Since CX.1 nulled the plaintext columns, that means re-consenting
 * every channel. `cx-credentials-rotate` rewrites EVERY credential, so it would do
 * that to all of them at once.
 */
import { randomBytes } from 'node:crypto'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FakeKms, FAKE_KMS_KEY_ID } from '../test-support/fake-kms.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

process.env.NEXUS_CREDENTIAL_ENC_KEY = randomBytes(32).toString('base64')
delete process.env.NEXUS_KMS_KEY_ID

let fake: FakeKms
const rows: Array<Record<string, unknown>> = []
const updates: Array<{ where: unknown; data: Record<string, unknown> }> = []
const appRows: Array<Record<string, unknown>> = []
const appUpdates: Array<{ where: unknown; data: Record<string, unknown> }> = []

const prismaMock = {
  channelConnection: {
    findMany: vi.fn(async (args?: { where?: { workspaceId?: string; isActive?: boolean } }) => rows.filter(row =>
      (!args?.where?.workspaceId || row.workspaceId === args.where.workspaceId) && (args?.where?.isActive === undefined || row.isActive === args.where.isActive))),
    updateMany: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
      updates.push(args)
      return { count: 1 }
    }),
  },
  channelApp: {
    findMany: vi.fn(async () => appRows),
    updateMany: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
      appUpdates.push(args)
      return { count: 1 }
    }),
  },
}
vi.mock('../db.js', () => ({ default: prismaMock }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../utils/cron-observability.js', () => ({ recordCronRun: async (_n: string, fn: () => Promise<string>) => fn() }))
vi.mock('../services/cx/events.service.js', () => ({ recordConnectionEvent: vi.fn(async () => {}), SYSTEM_ACTOR: { kind: 'system' } }))

const crypto = await import('../lib/crypto.js')
const maintenance = await import('./cx-credentials-rotate.job.js')
const { verifyCurrentKey } = maintenance
const owned = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const runCredentialsPreflight = () => owned(maintenance.runCredentialsPreflight)
const runCredentialsRotate = () => owned(maintenance.runCredentialsRotate)
const runCredentialsStatus = () => owned(maintenance.runCredentialsStatus)

beforeEach(() => {
  rows.length = 0
  updates.length = 0
  appRows.length = 0
  appUpdates.length = 0
  vi.restoreAllMocks()
  delete process.env.NEXUS_KMS_KEY_ID
  fake = new FakeKms()
  crypto.__cryptoTest.resetDekCache()
  crypto.__cryptoTest.setKmsClient(fake as never)
})

describe('verifyCurrentKey', () => {
  it('passes on the env key and reports the mode it actually used', async () => {
    const v = await verifyCurrentKey()
    expect(v).toMatchObject({ ok: true, mode: 'env', keyId: 'env' })
  })

  it('FAILS when the key can wrap but not unwrap — the partial-IAM case', async () => {
    vi.spyOn(crypto, 'decryptCredentials').mockRejectedValueOnce(new Error('AccessDeniedException: kms:Decrypt'))
    const v = await verifyCurrentKey()
    expect(v.ok).toBe(false)
    expect(v.error).toContain('kms:Decrypt')
  })

  it('FAILS when the round-trip returns something other than what went in', async () => {
    vi.spyOn(crypto, 'decryptCredentials').mockResolvedValueOnce({ preflight: 'tampered', at: 'x' } as never)
    const v = await verifyCurrentKey()
    expect(v.ok).toBe(false)
    expect(v.error).toMatch(/did not match/)
  })

  it('never puts a real credential at risk — it round-trips a marker', async () => {
    const spy = vi.spyOn(crypto, 'encryptCredentials')
    await verifyCurrentKey()
    expect(spy.mock.calls[0][0]).toMatchObject({ preflight: 'nexus-credential-key-check' })
  })
})

describe('runCredentialsPreflight', () => {
  it('reports ok with the mode when the key round-trips', async () => {
    await expect(runCredentialsPreflight()).resolves.toMatch(/^ok mode=env/)
  })

  it('says do NOT rotate when the round-trip fails', async () => {
    vi.spyOn(crypto, 'decryptCredentials').mockRejectedValueOnce(new Error('AccessDenied'))
    await expect(runCredentialsPreflight()).rejects.toThrow('do NOT rotate')
  })

  it('fails when the configured KMS key is not actually used', async () => {
    // A wrong key id or a missing GenerateDataKey permission falls back to the env
    // key silently. "Configured" and "working" are different things.
    process.env.NEXUS_KMS_KEY_ID = 'alias/does-not-exist'
    fake.failGenerate = true
    await expect(runCredentialsPreflight()).rejects.toThrow('NOT being used')
  })
})

describe('runCredentialsRotate — the guard', () => {
  beforeEach(async () => {
    const { blob, keyId } = await crypto.encryptCredentials({ refreshToken: 'r' })
    rows.push({ id: 'c1', workspaceId: LEGACY_WORKSPACE_ID, channelType: 'EBAY', credentialsEnc: blob, credentialsKeyId: keyId })
  })

  it('REFUSES and changes nothing when the key cannot round-trip', async () => {
    vi.spyOn(crypto, 'decryptCredentials').mockRejectedValue(new Error('AccessDeniedException: kms:Decrypt'))
    await expect(runCredentialsRotate()).rejects.toThrow(/^REFUSED/)
    expect(updates).toHaveLength(0)
  })

  it('REFUSES when KMS is configured but encryption silently used the env key', async () => {
    // Rotating here would rewrite every credential under the ENV key while the
    // operator believed they had just enabled KMS.
    process.env.NEXUS_KMS_KEY_ID = 'alias/does-not-exist'
    fake.failGenerate = true
    await expect(runCredentialsRotate()).rejects.toThrow('would rewrite every credential under the ENV key')
    expect(updates).toHaveLength(0)
  })

  it('is idempotent: an envelope already on the target key is left alone', async () => {
    const out = await runCredentialsRotate()
    expect(out).toContain('alreadyCurrent=1')
    expect(out).toContain('rotated=0')
    expect(updates).toHaveLength(0)
  })

  it('a failure on one connection leaves that credential untouched', async () => {
    rows.push({ id: 'c2', workspaceId: LEGACY_WORKSPACE_ID, channelType: 'AMAZON_ADS', credentialsEnc: 'not-a-blob', credentialsKeyId: 'env' })
    await expect(runCredentialsRotate()).rejects.toThrow('failed=1')
    expect(updates.find((u) => (u.where as { id: string }).id === 'c2')).toBeUndefined()
  })
})

describe('runCredentialsStatus', () => {
  it('answers the question in one line, including the not-working combination', async () => {
    rows.push(
      { id: 'a', workspaceId: LEGACY_WORKSPACE_ID, channelType: 'EBAY', credentialsEnc: (await crypto.encryptCredentials({ synthetic: 'valid-format' })).blob, credentialsKeyId: 'env', isActive: true },
      { id: 'b', workspaceId: LEGACY_WORKSPACE_ID, channelType: 'AMAZON', credentialsEnc: null, credentialsKeyId: null, isActive: true },
    )
    const out = await runCredentialsStatus()
    expect(out).toContain('withEnvelope=1')
    expect(out).toContain('onEnvKey=1')
    expect(out).toContain('noEnvelope=1')
  })
})

/**
 * 2026-09-21 — the half the job did not cover.
 *
 * `ChannelApp.clientSecretEnc` / `signingKeyEnc` are written by the same
 * `encryptCredentials` as a connection's grant, and nothing rotated or counted them.
 * The consequence was not a missing feature but a WRONG REPORT: `onEnvKey=0` while the
 * application client secrets — the credentials that mint new tokens — sat on the
 * environment key, and would have stayed there, because an app secret is not refreshed
 * on a timer the way a connection grant is.
 */
describe('runCredentialsRotate — the application secrets', () => {
  it('keeps an app secret already on the environment key unchanged', async () => {
    // Force a rotation by storing a blob under a key the job will not reproduce: the
    // marker is that the stored form is v1 while the job writes v1 too, so instead we
    // assert the idempotent path below and drive the rotation with a stale v1 blob
    // that decrypts. A round trip through the CURRENT key is the only honest fixture.
    const { blob } = await crypto.encryptCredentials({ clientSecret: 's3cret' })
    appRows.push({ id: 'app1', channelKey: 'EBAY', environment: 'production', clientSecretEnc: blob, signingKeyEnc: null })
    const out = await runCredentialsRotate()
    // Already on the env key and the target IS the env key ⇒ nothing to write.
    expect(out).toContain('appSecrets=1')
    expect(out).toContain('appAlreadyCurrent=1')
    expect(out).toContain('appRotated=0')
    expect(appUpdates).toHaveLength(0)
  })

  it('counts BOTH fields of one app, not one row', async () => {
    const a = await crypto.encryptCredentials({ clientSecret: 's' })
    const b = await crypto.encryptCredentials({ signingKeyId: 'k', jwe: 'j', privateKey: 'p', cipher: 'c' })
    appRows.push({ id: 'app1', channelKey: 'EBAY', environment: 'production', clientSecretEnc: a.blob, signingKeyEnc: b.blob })
    const out = await runCredentialsRotate()
    expect(out).toContain('appSecrets=2')
  })

  it('a field that cannot be re-encrypted leaves that app row unwritten, and is reported', async () => {
    appRows.push({ id: 'app1', channelKey: 'EBAY', environment: 'production', clientSecretEnc: 'not-a-blob', signingKeyEnc: null })
    await expect(runCredentialsRotate()).rejects.toThrow('appFailed=1')
    expect(appUpdates).toHaveLength(0)
  })

  it('still runs when there are no connections at all — app secrets alone are work', async () => {
    const { blob } = await crypto.encryptCredentials({ clientSecret: 's' })
    appRows.push({ id: 'app1', channelKey: 'EBAY', environment: 'production', clientSecretEnc: blob, signingKeyEnc: null })
    const out = await runCredentialsRotate()
    expect(out).not.toBe('no owned connection credentials or app secrets — quarantine not examined')
    expect(out).toContain('connections=0')
  })

  it('reports nothing to rotate only when BOTH tables are empty', async () => {
    await expect(runCredentialsRotate()).resolves.toBe('no owned connection credentials or app secrets — quarantine not examined')
  })

  it('WRITES the row and counts appRotated when the produced key differs from the stored one', async () => {
    // The other app tests all land on alreadyCurrent or on a failure, so neither the
    // prisma write nor the appRotated counter would be exercised by them. Drive the
    // rotating branch directly: a stored v1 blob against a produced KMS envelope is
    // exactly the shape of the real migration.
    const { blob } = await crypto.encryptCredentials({ clientSecret: 's' })
    appRows.push({ id: 'app1', channelKey: 'EBAY', environment: 'production', clientSecretEnc: blob, signingKeyEnc: null })
    process.env.NEXUS_KMS_KEY_ID = FAKE_KMS_KEY_ID
    const out = await runCredentialsRotate()
    expect(out).toContain('appRotated=1')
    expect(out).toContain('appAlreadyCurrent=0')
    expect(appUpdates).toHaveLength(1)
    expect(appUpdates[0]).toMatchObject({ where: { id: 'app1' }, data: { clientSecretEnc: expect.stringMatching(/^v2:/) } })
    // The untouched column must not be written at all — an undefined signingKeyEnc in
    // the update payload would blank a secret that was simply absent.
    expect(Object.keys(appUpdates[0].data)).toEqual(['clientSecretEnc'])
  })

  it('REFUSES before touching an app secret when the key cannot round-trip', async () => {
    const { blob } = await crypto.encryptCredentials({ clientSecret: 's' })
    appRows.push({ id: 'app1', channelKey: 'EBAY', environment: 'production', clientSecretEnc: blob, signingKeyEnc: null })
    vi.spyOn(crypto, 'decryptCredentials').mockRejectedValue(new Error('AccessDeniedException: kms:Decrypt'))
    await expect(runCredentialsRotate()).rejects.toThrow(/^REFUSED/)
    expect(appUpdates).toHaveLength(0)
  })
})

describe('runCredentialsStatus — counts come from the BLOB, not the column', () => {
  it('counts a v1 envelope as env even when the key id column was never written', async () => {
    // The regression this replaces: `credentialsKeyId === 'env'` counted a null column
    // as KMS-protected, so the migration reported itself finished while an env-keyed
    // envelope was still in the table. The column is nullable; the blob prefix is not.
    rows.push({ workspaceId: LEGACY_WORKSPACE_ID, channelType: 'EBAY', credentialsEnc: (await crypto.encryptCredentials({ synthetic: 'valid-format' })).blob, credentialsKeyId: null, isActive: true })
    const out = await runCredentialsStatus()
    expect(out).toContain('onEnvKey=1')
    expect(out).toContain('onKms=0')
  })

  it('keeps an unclassifiable value out of both counts', async () => {
    rows.push({ workspaceId: LEGACY_WORKSPACE_ID, channelType: 'EBAY', credentialsEnc: 'garbage', credentialsKeyId: 'env', isActive: true })
    const out = await runCredentialsStatus()
    expect(out).toContain('unreadable=1')
    expect(out).toContain('onEnvKey=0')
    expect(out).toContain('onKms=0')
  })

  it('reports the app secrets beside the connections', async () => {
    const { blob } = await crypto.encryptCredentials({ clientSecret: 's' })
    appRows.push({ clientSecretEnc: blob, signingKeyEnc: null })
    const out = await runCredentialsStatus()
    expect(out).toContain('appSecrets=1')
    expect(out).toContain('appOnEnvKey=1')
    expect(out).toContain('appOnKms=0')
  })

  it('an app row with no secrets at all contributes nothing', async () => {
    appRows.push({ clientSecretEnc: null, signingKeyEnc: null })
    const out = await runCredentialsStatus()
    expect(out).toContain('appSecrets=0')
  })
})


describe('maintenance target and inventory safety', () => {
  it.each(['connection', 'app'])('refuses a mid-run KMS fallback for a %s after successful preflight', async kind => {
    process.env.NEXUS_KMS_KEY_ID = FAKE_KMS_KEY_ID
    const original = await crypto.encryptCredentials({ synthetic: 'retained' })
    if (kind === 'connection') rows.push({ id: 'owned', workspaceId: LEGACY_WORKSPACE_ID, channelType: 'EBAY', credentialsEnc: original.blob })
    else appRows.push({ id: 'owned-app', channelKey: 'EBAY', clientSecretEnc: original.blob, signingKeyEnc: null })
    const reencrypt = crypto.reencryptCredentials
    vi.spyOn(crypto, 'reencryptCredentials').mockImplementationOnce(async blob => { fake.failGenerate = true; return reencrypt(blob) })
    await expect(runCredentialsRotate()).rejects.toThrow(/failed=1|appFailed=1/)
    expect(updates).toEqual([]); expect(appUpdates).toEqual([])
  })

  it('refuses a changed target key after preflight', async () => {
    const old = await crypto.encryptCredentials({ synthetic: 'retained' })
    rows.push({ id: 'owned', workspaceId: LEGACY_WORKSPACE_ID, channelType: 'EBAY', credentialsEnc: old.blob })
    process.env.NEXUS_KMS_KEY_ID = 'alias/current'
    const reencrypt = crypto.reencryptCredentials
    vi.spyOn(crypto, 'reencryptCredentials').mockImplementationOnce(async blob => { fake.keyId = 'unexpected-target'; return reencrypt(blob) })
    await expect(runCredentialsRotate()).rejects.toThrow('failed=1')
    expect(updates).toEqual([])
  })

  it('cannot downgrade KMS history when the target configuration disappears', async () => {
    process.env.NEXUS_KMS_KEY_ID = FAKE_KMS_KEY_ID
    const old = await crypto.encryptCredentials({ synthetic: 'retained' })
    rows.push({ id: 'owned', workspaceId: LEGACY_WORKSPACE_ID, channelType: 'EBAY', credentialsEnc: old.blob })
    delete process.env.NEXUS_KMS_KEY_ID
    await expect(runCredentialsRotate()).rejects.toThrow('failed=1')
    expect(updates).toEqual([])
  })

  it('includes inactive owned credentials and identifies the unexamined quarantine/recovery scope', async () => {
    const { blob } = await crypto.encryptCredentials({ synthetic: 'inactive' })
    rows.push({ id: 'inactive', workspaceId: LEGACY_WORKSPACE_ID, channelType: 'EBAY', credentialsEnc: blob, isActive: false })
    const status = await runCredentialsStatus()
    expect(status).toContain('withEnvelope=1')
    expect(status).toContain('active=0')
    expect(status).toContain('quarantine=not-examined')
    expect(status).toContain('recovery=not-verified')
  })

  it('does not classify a truncated v1 prefix as a valid encrypted envelope', async () => {
    rows.push({ id: 'broken', workspaceId: LEGACY_WORKSPACE_ID, credentialsEnc: 'v1:x', isActive: true })
    expect(await runCredentialsStatus()).toContain('unreadable=1')
    expect(await runCredentialsStatus()).toContain('onEnvKey=0')
  })
})
