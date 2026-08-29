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

process.env.NEXUS_CREDENTIAL_ENC_KEY = randomBytes(32).toString('base64')
delete process.env.NEXUS_KMS_KEY_ID

const rows: Array<Record<string, unknown>> = []
const updates: Array<{ where: unknown; data: Record<string, unknown> }> = []

const prismaMock = {
  channelConnection: {
    findMany: vi.fn(async () => rows),
    update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
      updates.push(args)
      return args
    }),
  },
}
vi.mock('../db.js', () => ({ default: prismaMock }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../utils/cron-observability.js', () => ({ recordCronRun: async (_n: string, fn: () => Promise<string>) => fn() }))
vi.mock('../services/cx/events.service.js', () => ({ recordConnectionEvent: vi.fn(async () => {}), SYSTEM_ACTOR: { kind: 'system' } }))

const crypto = await import('../lib/crypto.js')
const { verifyCurrentKey, runCredentialsPreflight, runCredentialsRotate, runCredentialsStatus } = await import('./cx-credentials-rotate.job.js')

beforeEach(() => {
  rows.length = 0
  updates.length = 0
  vi.restoreAllMocks()
  delete process.env.NEXUS_KMS_KEY_ID
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
    const out = await runCredentialsPreflight()
    expect(out).toMatch(/^FAILED/)
    expect(out).toContain('do NOT rotate')
  })

  it('WARNS on the state that looks fine and is not: key set, KMS not used', async () => {
    // A wrong key id or a missing GenerateDataKey permission falls back to the env
    // key silently. "Configured" and "working" are different things.
    process.env.NEXUS_KMS_KEY_ID = 'alias/does-not-exist'
    const out = await runCredentialsPreflight()
    expect(out).toMatch(/^WARNING/)
    expect(out).toContain('NOT being used')
  })
})

describe('runCredentialsRotate — the guard', () => {
  beforeEach(async () => {
    const { blob, keyId } = await crypto.encryptCredentials({ refreshToken: 'r' })
    rows.push({ id: 'c1', channelType: 'EBAY', credentialsEnc: blob, credentialsKeyId: keyId })
  })

  it('REFUSES and changes nothing when the key cannot round-trip', async () => {
    vi.spyOn(crypto, 'decryptCredentials').mockRejectedValue(new Error('AccessDeniedException: kms:Decrypt'))
    const out = await runCredentialsRotate()
    expect(out).toMatch(/^REFUSED/)
    expect(updates).toHaveLength(0)
  })

  it('REFUSES when KMS is configured but encryption silently used the env key', async () => {
    // Rotating here would rewrite every credential under the ENV key while the
    // operator believed they had just enabled KMS.
    process.env.NEXUS_KMS_KEY_ID = 'alias/does-not-exist'
    const out = await runCredentialsRotate()
    expect(out).toMatch(/^REFUSED/)
    expect(out).toContain('would rewrite every credential under the ENV key')
    expect(updates).toHaveLength(0)
  })

  it('is idempotent: an envelope already on the target key is left alone', async () => {
    const out = await runCredentialsRotate()
    expect(out).toContain('alreadyCurrent=1')
    expect(out).toContain('rotated=0')
    expect(updates).toHaveLength(0)
  })

  it('a failure on one connection leaves that credential untouched', async () => {
    rows.push({ id: 'c2', channelType: 'AMAZON_ADS', credentialsEnc: 'not-a-blob', credentialsKeyId: 'env' })
    const out = await runCredentialsRotate()
    expect(out).toContain('failed=1')
    expect(updates.find((u) => (u.where as { id: string }).id === 'c2')).toBeUndefined()
  })
})

describe('runCredentialsStatus', () => {
  it('answers the question in one line, including the not-working combination', async () => {
    rows.push(
      { id: 'a', channelType: 'EBAY', credentialsEnc: 'v1:x', credentialsKeyId: 'env', isActive: true },
      { id: 'b', channelType: 'AMAZON', credentialsEnc: null, credentialsKeyId: null, isActive: true },
    )
    const out = await runCredentialsStatus()
    expect(out).toContain('withEnvelope=1')
    expect(out).toContain('onEnvKey=1')
    expect(out).toContain('noEnvelope=1')
  })
})
