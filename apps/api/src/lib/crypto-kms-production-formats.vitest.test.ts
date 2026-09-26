/**
 * Package A crypto against the KMS-on production formats (the Owner's condition, 2026-09-26).
 *
 * KMS went ON in production on 2026-09-26. MAIN's crypto (94382f060) then rewrote every
 * stored credential into a v2 KMS envelope; values written before that are v1 env-key
 * envelopes. Package A replaces lib/crypto.ts and adds one more KMS writer on the request
 * path: every quarantined eBay notice is sealed with its own GenerateDataKey. This file
 * proves, with MAIN's code frozen in test-support/crypto-main-94382f060.ts:
 *   A. every format main writes and reads decrypts identically with the branch;
 *   B. the branch's per-notice sealing round-trips through the real receiver, and a KMS
 *      failure never loses a notice (env-key fallback + 200, or 503 so eBay redelivers);
 *   C. the branch still reads values written before KMS was switched on;
 *   and the reverse (main reads what the branch writes), because rollback runs older crypto.
 *
 * No network and no AWS account: the REAL @aws-sdk/client-kms client (its own JSON 1.1
 * serialization, error mapping and default retry policy) talks to an in-process handler
 * that answers the way the KMS service does. GenerateDataKey resolves an alias to its key
 * ARN and returns the plaintext data key plus an opaque CiphertextBlob naming that key;
 * Decrypt uses the key named in the blob, checks an optional KeyId, the EncryptionContext,
 * and the IAM condition production's policy sets (kms:EncryptionContext app=nexus,
 * purpose=credentials). Faults: AccessDenied, throttling, KMS internal error, disabled key,
 * network failure. Account id, key ids and every payload here are synthetic.
 */
import crypto from 'node:crypto'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KMSClient } from '@aws-sdk/client-kms'

const db = vi.hoisted(() => {
  type Row = Record<string, any>
  const quarantine = new Map<string, Row>()
  const keyOf = (value: { environment: string; signatureOk: boolean; externalId: string }) => `${value.environment}|${value.signatureOk}|${value.externalId}`
  const client: Record<string, any> = {
    ebayNoticeQuarantine: {
      findUnique: async ({ where }: any) => {
        const row = where.environment_signatureOk_externalId ? quarantine.get(keyOf(where.environment_signatureOk_externalId)) : undefined
        return row ? { ...row } : null
      },
      create: async ({ data }: any) => {
        if (quarantine.has(keyOf(data))) throw new Error('unique violation')
        quarantine.set(keyOf(data), { ...data, deliveries: 1, receivedAt: new Date(), lastReceivedAt: new Date(), resolvedWorkspaceId: null, resolvedReceiptId: null })
        return { id: data.id }
      },
      update: async ({ where, data }: any) => {
        const row = [...quarantine.values()].find(candidate => candidate.id === where.id)
        if (!row) throw new Error('missing row')
        row.deliveries += data.deliveries?.increment ?? 0
        row.lastReceivedAt = data.lastReceivedAt
        return { ...row }
      },
    },
    webhookEvent: { findUnique: async () => null },
    $executeRaw: async () => 1,
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('?')
      if (/nexus_ebay_notice_workspace|nexus_lock_ebay_notice_owner|ChannelAccountOwnership/.test(sql)) return []
      if (sql.includes('clock_timestamp')) return [{ now: new Date() }]
      throw new Error('unexpected SQL in the database stub')
    },
  }
  client.$transaction = async (work: (tx: unknown) => unknown) => work(client)
  return { client, quarantine }
})
vi.mock('../db.js', () => ({ default: db.client }))
vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../services/connection-resolver.service.js', () => ({ listActiveConnections: async () => [] }))
// Provider signature verification is not under test: every notice here is a verified one.
vi.mock('../services/cx/ingress/ebay-signature.js', () => ({
  verifyEbayNotification: async () => ({ ok: true, reason: 'ok', kid: 'synthetic-ebay-key' }),
  ebayChallengeResponse: () => 'synthetic-challenge-response',
}))

const branch = await import('./crypto.js')
const main = await import('../test-support/crypto-main-94382f060.js')
const { openEbayQuarantineBody } = await import('../services/cx/ingress/ebay-quarantine-crypto.js')
const routes = (await import('../routes/ebay-notification.routes.js')).default
const Fastify = (await import('fastify')).default
const { logger } = await import('../utils/logger.js')

// ── An in-process KMS service on the AWS JSON 1.1 wire ────────────────────────────────

const ACCOUNT = '111122223333'
const REGION = 'us-east-1'
const ALIAS = 'alias/nexus-credentials-production'
const PRODUCTION_CONTEXT = { app: 'nexus', purpose: 'credentials' }
const PROVIDER_DETAIL = 'synthetic-provider-detail'
const PRINCIPAL = `arn:aws:iam::${ACCOUNT}:user/nexus-api-production`
const arnOf = (uuid: string) => `arn:aws:kms:${REGION}:${ACCOUNT}:key/${uuid}`
type Operation = 'GenerateDataKey' | 'Decrypt'
type Fault = 'AccessDeniedException' | 'ThrottlingException' | 'KMSInternalException' | 'network' | 'hang'

class KmsError extends Error {
  constructor(readonly type: string, message: string, readonly status = 400) { super(message) }
}

class KmsService {
  private readonly keys = new Map<string, { material: Buffer[]; enabled: boolean }>()
  private readonly aliases = new Map<string, string>()
  readonly faults: Partial<Record<Operation, Fault>> = {}
  /** Every HTTP attempt, SDK retries included. */
  readonly wire: Array<{ op: string; keyId?: string; context?: Record<string, string> }> = []
  private readonly hung = new Set<(error: Error) => void>()
  /** Real KMS answers with the key ARN. Main can also read a raw id, so the fake can produce one. */
  keyIdStyle: 'arn' | 'uuid' = 'arn'

  createKey(alias?: string): string {
    const uuid = crypto.randomUUID()
    this.keys.set(uuid, { material: [crypto.randomBytes(32)], enabled: true })
    if (alias) this.aliases.set(alias, uuid)
    return arnOf(uuid)
  }
  /** Automatic rotation: new material under the same key id; old material still decrypts. */
  rotate(arn: string) { this.key(arn).material.push(crypto.randomBytes(32)) }
  setEnabled(arn: string, enabled: boolean) { this.key(arn).enabled = enabled }
  releaseHung() { for (const reject of this.hung) reject(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })); this.hung.clear() }
  calls(op: Operation) { return this.wire.filter(call => call.op === op) }

  readonly handler = { handle: (request: any, options?: { abortSignal?: AbortSignal }) => this.handle(request, options) }

  private key(arnOrUuid: string) {
    const entry = this.keys.get(arnOrUuid.replace(/^.*:key\//, ''))
    if (!entry) throw new KmsError('NotFoundException', `Key '${arnOrUuid}' does not exist`)
    return entry
  }
  private resolve(keyId: string): string {
    const alias = keyId.startsWith('alias/') ? keyId : keyId.includes(':alias/') ? keyId.slice(keyId.indexOf(':alias/') + 1) : null
    const uuid = alias ? this.aliases.get(alias) : keyId.replace(/^arn:aws:kms:[^:]+:\d{12}:key\//, '')
    if (!uuid || !this.keys.has(uuid)) throw new KmsError('NotFoundException', `Key '${keyId}' does not exist`)
    return uuid
  }
  private authorize(op: Operation, uuid: string, context: Record<string, string> | undefined) {
    if (context?.app !== PRODUCTION_CONTEXT.app || context?.purpose !== PRODUCTION_CONTEXT.purpose) {
      throw new KmsError('AccessDeniedException', `User: ${PRINCIPAL} is not authorized to perform: kms:${op} on resource: ${arnOf(uuid)} because no identity-based policy allows the kms:${op} action`)
    }
  }
  private static aad(uuid: string, context: Record<string, string> = {}) {
    return Buffer.from(JSON.stringify([uuid, Object.keys(context).sort().map(name => [name, context[name]])]), 'utf8')
  }

  private generateDataKey(input: { KeyId?: string; KeySpec?: string; NumberOfBytes?: number; EncryptionContext?: Record<string, string> }) {
    if (!input.KeyId) throw new KmsError('ValidationException', 'KeyId is required')
    const uuid = this.resolve(input.KeyId)
    this.authorize('GenerateDataKey', uuid, input.EncryptionContext)
    const entry = this.keys.get(uuid)!
    if (!entry.enabled) throw new KmsError('DisabledException', `${arnOf(uuid)} is disabled.`)
    if (input.KeySpec !== 'AES_256' && input.NumberOfBytes !== 32) throw new KmsError('ValidationException', 'KeySpec must be AES_256')
    const dataKey = crypto.randomBytes(32), version = entry.material.length - 1, iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', entry.material[version], iv)
    cipher.setAAD(KmsService.aad(uuid, input.EncryptionContext))
    const wrapped = Buffer.concat([cipher.update(dataKey), cipher.final()])
    const blob = Buffer.concat([Buffer.from('FKMS'), Buffer.from([version]), Buffer.from(uuid, 'ascii'), iv, cipher.getAuthTag(), wrapped])
    return { KeyId: this.keyIdStyle === 'arn' ? arnOf(uuid) : uuid, Plaintext: dataKey.toString('base64'), CiphertextBlob: blob.toString('base64') }
  }

  private decrypt(input: { CiphertextBlob?: string; KeyId?: string; EncryptionContext?: Record<string, string> }) {
    const blob = Buffer.from(input.CiphertextBlob ?? '', 'base64')
    if (blob.length !== 4 + 1 + 36 + 12 + 16 + 32 || blob.subarray(0, 4).toString() !== 'FKMS') throw new KmsError('InvalidCiphertextException', '')
    const version = blob[4], uuid = blob.subarray(5, 41).toString('ascii')
    if (input.KeyId && this.resolve(input.KeyId) !== uuid) throw new KmsError('IncorrectKeyException', 'The key ID in the request does not identify a KMS key that can perform this operation.')
    const entry = this.keys.get(uuid)
    if (!entry) throw new KmsError('AccessDeniedException', `User: ${PRINCIPAL} is not authorized to perform: kms:Decrypt`)
    this.authorize('Decrypt', uuid, input.EncryptionContext)
    if (!entry.enabled) throw new KmsError('DisabledException', `${arnOf(uuid)} is disabled.`)
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', entry.material[version], blob.subarray(41, 53))
      decipher.setAAD(KmsService.aad(uuid, input.EncryptionContext))
      decipher.setAuthTag(blob.subarray(53, 69))
      const dataKey = Buffer.concat([decipher.update(blob.subarray(69)), decipher.final()])
      return { KeyId: arnOf(uuid), Plaintext: dataKey.toString('base64'), EncryptionAlgorithm: 'SYMMETRIC_DEFAULT' }
    } catch { throw new KmsError('InvalidCiphertextException', '') }
  }

  private async handle(request: any, options?: { abortSignal?: AbortSignal }) {
    const headers: Record<string, string> = Object.fromEntries(Object.entries(request.headers ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)]))
    const op = (headers['x-amz-target'] ?? '').replace(/^TrentService\./, '')
    const body = request.body instanceof Uint8Array ? new TextDecoder().decode(request.body) : String(request.body ?? '')
    const input = JSON.parse(body || '{}')
    this.wire.push({ op, keyId: input.KeyId, context: input.EncryptionContext })
    const fault = this.faults[op as Operation]
    if (fault === 'hang') {
      return new Promise<never>((_resolve, reject) => {
        this.hung.add(reject)
        options?.abortSignal?.addEventListener?.('abort', () => reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' })))
      })
    }
    if (fault === 'network') throw Object.assign(new Error(`read ECONNRESET ${PROVIDER_DETAIL}`), { code: 'ECONNRESET' })
    let status = 200, payload: unknown
    try {
      if (fault === 'AccessDeniedException') throw new KmsError(fault, `User: ${PRINCIPAL} is not authorized to perform: kms:${op} (${PROVIDER_DETAIL})`)
      if (fault === 'ThrottlingException') throw new KmsError(fault, `Rate exceeded (${PROVIDER_DETAIL})`)
      if (fault === 'KMSInternalException') throw new KmsError(fault, `Internal error (${PROVIDER_DETAIL})`, 500)
      if (op === 'GenerateDataKey') payload = this.generateDataKey(input)
      else if (op === 'Decrypt') payload = this.decrypt(input)
      else throw new KmsError('UnknownOperationException', op)
    } catch (error) {
      if (!(error instanceof KmsError)) throw error
      status = error.status
      payload = { __type: error.type, message: error.message }
    }
    return { response: {
      statusCode: status,
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amzn-requestid': crypto.randomUUID() },
      body: Buffer.from(JSON.stringify(payload), 'utf8'),
    } }
  }
}

// ── Fixtures ───────────────────────────────────────────────────────────────────────────

const ENV_KEY = crypto.randomBytes(32).toString('base64')
const PAYLOADS: Record<string, Record<string, unknown>> = {
  'eBay OAuth grant': { accessToken: 'synthetic-access-token', refreshToken: 'synthetic-refresh-token', accessTokenExpiresAt: '2026-09-26T12:00:00.000Z', scopes: ['https://api.ebay.com/oauth/api_scope'] },
  'Amazon Ads grant': { refreshToken: 'synthetic-ads-refresh', clientId: 'synthetic-client', profileIds: [1, 2, 3] },
  'ChannelApp client secret': { clientSecret: 'synthetic-client-secret' },
  'ChannelApp signing key': { signingKey: { jwe: 'synthetic.jwe.value', privateKeyDer: crypto.randomBytes(64).toString('base64'), expiresAt: null } },
  'non-ASCII and nesting': { note: 'Città — naïve café ✓ 🚲', nested: { list: [1, { deep: null }], flag: true, zero: 0 } },
  'empty object': {},
  'large value': { blob: 'x'.repeat(64 * 1024) },
}
const CASES = Object.entries(PAYLOADS)

let kms: KmsService
let client: KMSClient
let keyArn: string
let fallbackReasons: string[]

/** Production builds `new KMSClient({ region })` with default retries and timeouts; only credentials and transport differ. */
function sdkClient(service: KmsService) {
  return new KMSClient({ region: REGION, credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' }, requestHandler: service.handler as never })
}

function resetModules() {
  for (const module of [branch, main]) {
    module.__test.resetKeyCache()
    module.__cryptoTest.resetDekCache()
    module.__cryptoTest.resetFallbackNotice()
  }
}

function coldCaches() { branch.__cryptoTest.resetDekCache(); main.__cryptoTest.resetDekCache() }

function logText() {
  return JSON.stringify([vi.mocked(logger.warn).mock.calls, vi.mocked(logger.error).mock.calls, vi.mocked(logger.info).mock.calls])
}

beforeEach(() => {
  vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', ENV_KEY)
  vi.stubEnv('NEXUS_KMS_KEY_ID', ALIAS)
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  resetModules()
  kms = new KmsService()
  keyArn = kms.createKey(ALIAS)
  client = sdkClient(kms)
  branch.__cryptoTest.setKmsClient(client)
  main.__cryptoTest.setKmsClient(client)
  fallbackReasons = []
  branch.onCredentialsKmsFallback(reason => fallbackReasons.push(reason))
  db.quarantine.clear()
  vi.mocked(logger.warn).mockClear(); vi.mocked(logger.error).mockClear(); vi.mocked(logger.info).mockClear()
})

afterEach(() => {
  kms.releaseHung()
  client.destroy()
  branch.__cryptoTest.setKmsClient(null)
  main.__cryptoTest.setKmsClient(null)
  resetModules()
  vi.unstubAllEnvs()
})

// ── A. Main-written values on the branch ──────────────────────────────────────────────

describe('A. every credential format main writes decrypts identically with the Package A crypto', () => {
  it.each(CASES)('v2 KMS envelope written by main in production mode (alias → key ARN): %s', async (_name, payload) => {
    const written = await main.encryptCredentials(payload)
    expect(written).toMatchObject({ mode: 'kms', keyId: keyArn })
    expect(written.blob.startsWith('v2:b64.')).toBe(true)
    expect(kms.calls('GenerateDataKey')).toEqual([{ op: 'GenerateDataKey', keyId: ALIAS, context: PRODUCTION_CONTEXT }])
    coldCaches()
    expect(await branch.decryptCredentials(written.blob)).toEqual(payload)
    expect(await branch.decryptCredentials(written.blob, { bypassKmsCache: true })).toEqual(payload)
    expect(branch.credentialsKeyIdOf(written.blob)).toEqual({ version: 'v2', keyId: keyArn })
    expect(branch.credentialsKeyIdOf(written.blob)).toEqual(main.credentialsKeyIdOf(written.blob))
    expect(branch.isCredentialsBlob(written.blob)).toBe(true)
  })

  it.each(CASES)('v1 env-key envelope written by main before KMS was configured: %s', async (_name, payload) => {
    vi.stubEnv('NEXUS_KMS_KEY_ID', '')
    const written = await main.encryptCredentials(payload)
    expect(written).toMatchObject({ mode: 'env', keyId: 'env' })
    expect(written.blob.startsWith('v1:')).toBe(true)
    vi.stubEnv('NEXUS_KMS_KEY_ID', ALIAS)
    expect(await branch.decryptCredentials(written.blob)).toEqual(payload)
    expect(branch.credentialsKeyIdOf(written.blob)).toEqual(main.credentialsKeyIdOf(written.blob))
    expect(kms.wire).toHaveLength(0)
  })

  it.each(['AccessDeniedException', 'ThrottlingException', 'KMSInternalException', 'network'] as const)(
    'v1 written by main while KMS failed GenerateDataKey (%s) decrypts on the branch', async fault => {
      kms.faults.GenerateDataKey = fault
      const written = await main.encryptCredentials(PAYLOADS['eBay OAuth grant'])
      expect(written).toMatchObject({ mode: 'env', keyId: 'env' })
      delete kms.faults.GenerateDataKey
      expect(await branch.decryptCredentials(written.blob)).toEqual(PAYLOADS['eBay OAuth grant'])
      expect(branch.credentialsKeyIdOf(written.blob)).toEqual({ version: 'v1', keyId: null })
    }, 20_000)

  it.each(['', 'plain', 'Città ✓ 🚲', JSON.stringify({ publicKey: 'synthetic', privateKey: 'synthetic' })])(
    'v1 from main encryptSecret (carrier credentials) decrypts on the branch: %j', async plaintext => {
      const written = main.encryptSecret(plaintext)
      expect(branch.isEncrypted(written)).toBe(true)
      expect(branch.decryptSecret(written)).toBe(plaintext)
      // The branch validates v1 shape strictly; a value main wrote must never classify as unreadable.
      expect(branch.credentialsKeyIdOf(written)).toEqual(main.credentialsKeyIdOf(written))
    })

  it('v2 with a raw (unencoded) key id, which main can read, decrypts on the branch', async () => {
    kms.keyIdStyle = 'uuid'
    const written = await main.encryptCredentials(PAYLOADS['Amazon Ads grant'])
    const uuid = keyArn.replace(/^.*:key\//, '')
    expect(written.blob.startsWith(`v2:${uuid}:`)).toBe(true)
    coldCaches()
    expect(await branch.decryptCredentials(written.blob)).toEqual(PAYLOADS['Amazon Ads grant'])
    expect(branch.credentialsKeyIdOf(written.blob)).toEqual(main.credentialsKeyIdOf(written.blob))
  })

  it('main’s 2026-09-26 migration output (v1 → v2 by reencryptCredentials) decrypts on the branch', async () => {
    vi.stubEnv('NEXUS_KMS_KEY_ID', '')
    const before = await main.encryptCredentials(PAYLOADS['eBay OAuth grant'])
    vi.stubEnv('NEXUS_KMS_KEY_ID', ALIAS)
    const migrated = await main.reencryptCredentials(before.blob)
    expect(migrated).toMatchObject({ mode: 'kms', keyId: keyArn })
    coldCaches()
    expect(await branch.decryptCredentials(migrated.blob)).toEqual(PAYLOADS['eBay OAuth grant'])
    expect(branch.credentialsKeyIdOf(migrated.blob)).toEqual({ version: 'v2', keyId: keyArn })
  })

  it('envelopes from before and after KMS key rotation both decrypt, under one key id', async () => {
    const older = await main.encryptCredentials({ generation: 'before rotation' })
    kms.rotate(keyArn)
    const newer = await main.encryptCredentials({ generation: 'after rotation' })
    coldCaches()
    expect(await branch.decryptCredentials(older.blob)).toEqual({ generation: 'before rotation' })
    expect(await branch.decryptCredentials(newer.blob)).toEqual({ generation: 'after rotation' })
    expect(branch.credentialsKeyIdOf(older.blob).keyId).toBe(branch.credentialsKeyIdOf(newer.blob).keyId)
  })

  it('a warm DEK cache serves repeated reads with one KMS Decrypt and never hands out a wiped key', async () => {
    const written = await main.encryptCredentials(PAYLOADS['ChannelApp client secret'])
    coldCaches()
    for (let read = 0; read < 3; read++) expect(await branch.decryptCredentials(written.blob)).toEqual(PAYLOADS['ChannelApp client secret'])
    expect(kms.calls('Decrypt')).toHaveLength(1)
  })

  it.each(['AccessDeniedException', 'ThrottlingException', 'KMSInternalException', 'network'] as const)(
    'a KMS Decrypt outage (%s) fails closed exactly like main, leaks no provider text, and the stored value reads after recovery', async fault => {
      const written = await main.encryptCredentials(PAYLOADS['eBay OAuth grant'])
      coldCaches()
      kms.faults.Decrypt = fault
      await expect(branch.decryptCredentials(written.blob)).rejects.toMatchObject({ name: 'CredentialsDecryptError', code: 'kms_unavailable' })
      // Read the branch's log lines before main runs: main logs the provider message verbatim.
      expect(vi.mocked(logger.warn).mock.calls.some(call => call[0] === 'credentials: KMS Decrypt failed')).toBe(true)
      expect(logText()).not.toContain(PROVIDER_DETAIL)
      expect(logText()).not.toContain(PRINCIPAL)
      await expect(main.decryptCredentials(written.blob)).rejects.toMatchObject({ name: 'CredentialsDecryptError', code: 'kms_unavailable' })
      delete kms.faults.Decrypt
      expect(await branch.decryptCredentials(written.blob)).toEqual(PAYLOADS['eBay OAuth grant'])
    }, 20_000)

  it('a disabled key fails closed with kms_unavailable and reads again once re-enabled', async () => {
    const written = await main.encryptCredentials(PAYLOADS['Amazon Ads grant'])
    coldCaches()
    kms.setEnabled(keyArn, false)
    await expect(branch.decryptCredentials(written.blob)).rejects.toMatchObject({ code: 'kms_unavailable' })
    kms.setEnabled(keyArn, true)
    expect(await branch.decryptCredentials(written.blob)).toEqual(PAYLOADS['Amazon Ads grant'])
  })

  it('every KMS request either version makes carries exactly the context the production IAM policy requires', async () => {
    const byMain = await main.encryptCredentials({ side: 'main' })
    const byBranch = await branch.encryptCredentials({ side: 'branch' })
    coldCaches()
    await branch.decryptCredentials(byMain.blob); await main.decryptCredentials(byBranch.blob)
    expect(kms.wire.length).toBe(4)
    for (const call of kms.wire) expect(call.context).toEqual(PRODUCTION_CONTEXT)
  })
})

// ── Rollback: branch-written values on main's code ────────────────────────────────────

describe('rollback: main’s code (the recovery build) reads what the Package A crypto writes', () => {
  it.each(CASES)('branch v2 envelope → main: %s', async (_name, payload) => {
    const written = await branch.encryptCredentials(payload)
    expect(written).toMatchObject({ mode: 'kms', keyId: keyArn })
    coldCaches()
    expect(await main.decryptCredentials(written.blob)).toEqual(payload)
    expect(main.credentialsKeyIdOf(written.blob)).toEqual(branch.credentialsKeyIdOf(written.blob))
  })

  it('branch v1 fallback written during a KMS outage → main', async () => {
    kms.faults.GenerateDataKey = 'AccessDeniedException'
    const written = await branch.encryptCredentials(PAYLOADS['eBay OAuth grant'])
    expect(written).toMatchObject({ mode: 'env', keyId: 'env' })
    expect(await main.decryptCredentials(written.blob)).toEqual(PAYLOADS['eBay OAuth grant'])
  })

  it('branch legacy re-encrypt (rotate job, no pinned target) of a pre-KMS value → main', async () => {
    const before = main.encryptSecret(JSON.stringify(PAYLOADS['Amazon Ads grant']))
    const moved = await branch.reencryptCredentials(before)
    expect(moved).toMatchObject({ mode: 'kms', keyId: keyArn })
    coldCaches()
    expect(await main.decryptCredentials(moved.blob)).toEqual(PAYLOADS['Amazon Ads grant'])
  })

  it('branch strict maintenance re-encrypt to the pinned key ARN → main', async () => {
    const source = await main.encryptCredentials(PAYLOADS['ChannelApp signing key'])
    const moved = await branch.reencryptCredentials(source.blob, keyArn)
    expect(moved).toMatchObject({ mode: 'kms', keyId: keyArn })
    coldCaches()
    expect(await main.decryptCredentials(moved.blob)).toEqual(PAYLOADS['ChannelApp signing key'])
  })
})

// ── C. Values written before KMS was switched on ─────────────────────────────────────

describe('C. the branch, with KMS ON, still reads values written before KMS was switched on', () => {
  it('pre-KMS v1 values decrypt without any KMS call, even while KMS refuses every request', async () => {
    vi.stubEnv('NEXUS_KMS_KEY_ID', '')
    const written = await Promise.all(CASES.map(([, payload]) => main.encryptCredentials(payload)))
    vi.stubEnv('NEXUS_KMS_KEY_ID', ALIAS)
    kms.faults.GenerateDataKey = 'AccessDeniedException'; kms.faults.Decrypt = 'AccessDeniedException'
    for (const [index, [, payload]] of CASES.entries()) expect(await branch.decryptCredentials(written[index].blob)).toEqual(payload)
    expect(kms.wire).toHaveLength(0)
  })

  it('the credentials status classification of pre-KMS values is unchanged (env key, never unreadable)', async () => {
    vi.stubEnv('NEXUS_KMS_KEY_ID', '')
    const values = [...(await Promise.all(CASES.map(([, payload]) => main.encryptCredentials(payload)))).map(result => result.blob), main.encryptSecret('')]
    for (const value of values) {
      expect(branch.isCredentialsBlob(value)).toBe(main.isCredentialsBlob(value))
      expect(branch.credentialsKeyIdOf(value)).toEqual({ version: 'v1', keyId: null })
    }
  })

  it('the rotate path moves a pre-KMS value onto the production key with identical contents', async () => {
    vi.stubEnv('NEXUS_KMS_KEY_ID', '')
    const before = await main.encryptCredentials(PAYLOADS['non-ASCII and nesting'])
    vi.stubEnv('NEXUS_KMS_KEY_ID', ALIAS)
    const moved = await branch.reencryptCredentials(before.blob)
    expect(moved).toMatchObject({ mode: 'kms', keyId: keyArn })
    coldCaches()
    expect(await branch.decryptCredentials(moved.blob)).toEqual(PAYLOADS['non-ASCII and nesting'])
  })
})

// ── B. Per-notice sealing through the real eBay receiver ───────────────────────────────

function notice(id: string, topic = 'MARKETPLACE_ACCOUNT_DELETION') {
  return JSON.stringify({
    metadata: { topic, schemaVersion: '1.0', deprecated: false },
    notification: { notificationId: id, eventDate: '2026-09-26T08:00:00.000Z', publishDate: '2026-09-26T08:00:01.000Z', publishAttemptCount: 1,
      data: { username: 'synthetic-buyer', userId: `synthetic-user-${id}`, eiasToken: 'synthetic-eias' } },
  })
}

async function deliver(body: string) {
  const app = Fastify()
  await app.register(routes as never)
  try {
    const started = Date.now()
    const response = await app.inject({ method: 'POST', url: '/webhooks/ebay-notification', headers: { 'content-type': 'application/json', 'x-ebay-signature': 'synthetic-signature' }, payload: body })
    return { status: response.statusCode, json: response.json(), ms: Date.now() - started }
  } finally { await app.close() }
}

function storedRow(id: string) {
  const row = [...db.quarantine.values()].find(candidate => candidate.externalId === id)
  if (!row) throw new Error(`no quarantine row for ${id}`)
  return row
}

describe('B. quarantined eBay notices: one KMS data key per notice, and no notice is lost when KMS fails', () => {
  it('KMS healthy: 200 only after the encrypted body is stored; one GenerateDataKey; the body opens byte-exact', async () => {
    const body = notice('n-healthy')
    const answer = await deliver(body)
    expect(answer).toMatchObject({ status: 200, json: { received: true } })
    const row = storedRow('n-healthy')
    expect(row.payloadEnc.startsWith('v2:b64.')).toBe(true)
    expect(row.payloadKeyId).toBe(keyArn)
    expect(kms.calls('GenerateDataKey')).toEqual([{ op: 'GenerateDataKey', keyId: ALIAS, context: PRODUCTION_CONTEXT }])
    coldCaches()
    expect((await openEbayQuarantineBody(row as never)).equals(Buffer.from(body))).toBe(true)
    expect(fallbackReasons).toEqual([])
  })

  it('an unknown-owner revocation is sealed the same way', async () => {
    const body = notice('n-revocation', 'AUTHORIZATION_REVOCATION')
    expect((await deliver(body)).status).toBe(200)
    const row = storedRow('n-revocation')
    expect(row.reason).toBe('owner_unknown')
    expect((await openEbayQuarantineBody(row as never)).equals(Buffer.from(body))).toBe(true)
  })

  it('KMS volume follows distinct notices: three notices cost three data keys, a redelivery costs none', async () => {
    for (const id of ['n-1', 'n-2', 'n-3', 'n-1']) expect((await deliver(notice(id))).status).toBe(200)
    expect(kms.calls('GenerateDataKey')).toHaveLength(3)
    expect(storedRow('n-1').deliveries).toBe(2)
  })

  it.each([
    ['AccessDeniedException', 1],
    ['ThrottlingException', 3],
    ['KMSInternalException', 3],
    ['network', 3],
  ] as const)('KMS %s on GenerateDataKey: still 200, sealed under the env key, opens byte-exact, static reason only', async (fault, attempts) => {
    kms.faults.GenerateDataKey = fault
    const body = notice(`n-${fault}`)
    const answer = await deliver(body)
    expect(answer).toMatchObject({ status: 200, json: { received: true } })
    // The SDK's default policy retries throttling, server and network errors, never AccessDenied.
    expect(kms.calls('GenerateDataKey')).toHaveLength(attempts)
    const row = storedRow(`n-${fault}`)
    expect(row.payloadEnc.startsWith('v1:')).toBe(true)
    expect(row.payloadKeyId).toBe('env')
    expect(fallbackReasons).toHaveLength(1)
    expect(fallbackReasons[0]).toMatch(/^KMS GenerateDataKey failed \([A-Za-z]+\)$/)
    expect(logText()).not.toContain(PROVIDER_DETAIL)
    expect(logText()).not.toContain(PRINCIPAL)
    delete kms.faults.GenerateDataKey
    expect((await openEbayQuarantineBody(row as never)).equals(Buffer.from(body))).toBe(true)
  }, 20_000)

  it('a disabled key: still 200, sealed under the env key', async () => {
    kms.setEnabled(keyArn, false)
    expect((await deliver(notice('n-disabled'))).status).toBe(200)
    expect(storedRow('n-disabled').payloadKeyId).toBe('env')
    expect(fallbackReasons[0]).toBe('KMS GenerateDataKey failed (DisabledException)')
  })

  it('KMS failing and no env key: 503 so eBay redelivers, nothing is half-written, and the redelivery is stored after recovery', async () => {
    vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', '')
    branch.__test.resetKeyCache()
    kms.faults.GenerateDataKey = 'AccessDeniedException'
    const body = notice('n-no-key')
    const refused = await deliver(body)
    expect(refused).toMatchObject({ status: 503, json: { error: 'Notification could not be stored safely. Retry delivery.' } })
    expect(db.quarantine.size).toBe(0)
    delete kms.faults.GenerateDataKey
    const redelivered = await deliver(body)
    expect(redelivered.status).toBe(200)
    const row = storedRow('n-no-key')
    expect(row.payloadKeyId).toBe(keyArn)
    expect((await openEbayQuarantineBody(row as never)).equals(Buffer.from(body))).toBe(true)
  })
})

// ── D. A KMS that never answers, through the client crypto.ts builds for production ─────

/** The same fake KMS behind a loopback HTTP listener, so the production-built SDK client
 * (its own transport, timeouts and retry budget) is what talks to it. Nothing leaves 127.0.0.1. */
async function kmsOverLoopback(service: KmsService) {
  const sockets = new Set<Socket>()
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    try {
      const { response: answer } = await service.handler.handle({ headers: request.headers as IncomingHttpHeaders, body: new Uint8Array(Buffer.concat(chunks)) })
      response.writeHead(answer.statusCode, answer.headers)
      response.end(answer.body)
    } catch { response.destroy() }
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a loopback listener')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      service.releaseHung()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

/** A silent KMS must be bounded well inside this; an unbounded client fails the assertion, not the test timeout. */
const SILENT_KMS_BOUND_MS = 10_000
const NO_ANSWER = Symbol('no answer within the bound')
async function withinBound<T>(work: Promise<T>): Promise<{ value: T | typeof NO_ANSWER; ms: number }> {
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const value = await Promise.race([work, new Promise<typeof NO_ANSWER>(resolve => { timer = setTimeout(() => resolve(NO_ANSWER), SILENT_KMS_BOUND_MS) })])
  clearTimeout(timer)
  return { value, ms: Date.now() - started }
}

describe('D. a KMS that never answers is bounded by the production client', () => {
  let loopback: Awaited<ReturnType<typeof kmsOverLoopback>>
  beforeEach(async () => {
    loopback = await kmsOverLoopback(kms)
    vi.stubEnv('AWS_ENDPOINT_URL_KMS', loopback.url)
    vi.stubEnv('AWS_REGION', REGION)
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'synthetic')
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'synthetic')
    vi.stubEnv('AWS_SESSION_TOKEN', '')
    vi.stubEnv('AWS_PROFILE', '')
    vi.stubEnv('AWS_CONFIG_FILE', '/nonexistent/aws-config')
    vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', '/nonexistent/aws-credentials')
    vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true')
    branch.__cryptoTest.setKmsClient(null) // crypto.ts now builds its own production client
  })
  afterEach(async () => { await loopback.close(); branch.__cryptoTest.setKmsClient(null) })

  it('GenerateDataKey never answers: the notice is sealed under the env key and eBay gets 200 within the bound', async () => {
    kms.faults.GenerateDataKey = 'hang'
    const body = notice('n-silent-kms')
    const pending = deliver(body)
    try {
      const { value, ms } = await withinBound(pending)
      expect(value).not.toBe(NO_ANSWER)
      expect(value).toMatchObject({ status: 200, json: { received: true } })
      expect(ms).toBeLessThan(SILENT_KMS_BOUND_MS)
      expect(kms.calls('GenerateDataKey')).toHaveLength(2)
      expect(fallbackReasons).toEqual(['KMS GenerateDataKey failed (TimeoutError)'])
      const row = storedRow('n-silent-kms')
      expect(row.payloadKeyId).toBe('env')
      delete kms.faults.GenerateDataKey
      expect((await openEbayQuarantineBody(row as never)).equals(Buffer.from(body))).toBe(true)
    } finally {
      delete kms.faults.GenerateDataKey
      kms.releaseHung()
      await pending.catch(() => undefined)
    }
  }, 30_000)

  it('Decrypt never answers: the read fails closed with kms_unavailable within the bound, and reads again afterwards', async () => {
    const written = await branch.encryptCredentials(PAYLOADS['eBay OAuth grant'])
    expect(written).toMatchObject({ mode: 'kms', keyId: keyArn })
    coldCaches()
    kms.faults.Decrypt = 'hang'
    const pending = branch.decryptCredentials(written.blob).then(value => ({ value }), error => ({ error }))
    try {
      const { value, ms } = await withinBound(pending)
      expect(value).not.toBe(NO_ANSWER)
      expect(value).toMatchObject({ error: { name: 'CredentialsDecryptError', code: 'kms_unavailable' } })
      expect(ms).toBeLessThan(SILENT_KMS_BOUND_MS)
      expect(kms.calls('Decrypt')).toHaveLength(2)
      expect(logText()).not.toContain(PROVIDER_DETAIL)
    } finally {
      delete kms.faults.Decrypt
      kms.releaseHung()
      await pending
    }
    expect(await branch.decryptCredentials(written.blob)).toEqual(PAYLOADS['eBay OAuth grant'])
  }, 30_000)
})
