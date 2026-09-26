/**
 * Recovery build: a KMS that never answers is bounded (the Owner's KMS condition, 2026-09-26).
 *
 * The recovery branch runs main's application code, whose crypto.ts had SDK defaults (no connection
 * or socket timeout, three attempts). Adapted from Package A's crypto-kms-production-formats test:
 * the same in-process KMS on the AWS JSON 1.1 wire, served on loopback so the client crypto.ts builds
 * for production (transport, timeouts, retry budget) is what talks to it. A silent GenerateDataKey
 * must fall back to the env key within the bound; a silent Decrypt must fail closed (kms_unavailable)
 * within the bound, as errors already did. Nothing leaves 127.0.0.1; all ids are synthetic.
 */
import crypto from 'node:crypto'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
const recovery = await import('./crypto.js')
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


const ENV_KEY = crypto.randomBytes(32).toString('base64')
let kms: KmsService
let keyArn: string
let loopback: Awaited<ReturnType<typeof kmsOverLoopback>>
let fallbackReasons: string[]
const logText = () => JSON.stringify([vi.mocked(logger.warn).mock.calls, vi.mocked(logger.error).mock.calls])

describe('a KMS that never answers is bounded by the recovery build\'s production client', () => {
  beforeEach(async () => {
    kms = new KmsService()
    keyArn = kms.createKey(ALIAS)
    loopback = await kmsOverLoopback(kms)
    vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', ENV_KEY)
    vi.stubEnv('NEXUS_KMS_KEY_ID', ALIAS)
    vi.stubEnv('AWS_ENDPOINT_URL_KMS', loopback.url)
    vi.stubEnv('AWS_REGION', REGION)
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'synthetic')
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'synthetic')
    vi.stubEnv('AWS_SESSION_TOKEN', '')
    vi.stubEnv('AWS_PROFILE', '')
    vi.stubEnv('AWS_CONFIG_FILE', '/nonexistent/aws-config')
    vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', '/nonexistent/aws-credentials')
    vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true')
    recovery.__test.resetKeyCache(); recovery.__cryptoTest.resetDekCache(); recovery.__cryptoTest.resetFallbackNotice()
    recovery.__cryptoTest.setKmsClient(null) // crypto.ts builds its own production client
    fallbackReasons = []
    recovery.onCredentialsKmsFallback(reason => fallbackReasons.push(reason))
    vi.mocked(logger.warn).mockClear(); vi.mocked(logger.error).mockClear()
  })
  afterEach(async () => {
    await loopback.close()
    recovery.__cryptoTest.setKmsClient(null)
    recovery.__cryptoTest.resetFallbackNotice()
    vi.unstubAllEnvs()
  })

  it('GenerateDataKey never answers: the credential is written under the env key within the bound', async () => {
    kms.faults.GenerateDataKey = 'hang'
    const pending = recovery.encryptCredentials({ refreshToken: 'synthetic-refresh' })
    try {
      const { value, ms } = await withinBound(pending)
      expect(value).not.toBe(NO_ANSWER)
      expect(value).toMatchObject({ mode: 'env', keyId: 'env' })
      expect(ms).toBeLessThan(SILENT_KMS_BOUND_MS)
      expect(kms.calls('GenerateDataKey')).toHaveLength(2)
      expect(fallbackReasons).toHaveLength(1)
      expect(await recovery.decryptCredentials((value as { blob: string }).blob)).toEqual({ refreshToken: 'synthetic-refresh' })
    } finally {
      delete kms.faults.GenerateDataKey
      kms.releaseHung()
      await pending.catch(() => undefined)
    }
  }, 30_000)

  it('Decrypt never answers: the read fails closed with kms_unavailable within the bound, and reads again afterwards', async () => {
    const written = await recovery.encryptCredentials({ refreshToken: 'synthetic-refresh' })
    expect(written).toMatchObject({ mode: 'kms', keyId: keyArn })
    recovery.__cryptoTest.resetDekCache()
    kms.faults.Decrypt = 'hang'
    const pending = recovery.decryptCredentials(written.blob).then(value => ({ value }), error => ({ error }))
    try {
      const { value, ms } = await withinBound(pending)
      expect(value).not.toBe(NO_ANSWER)
      expect(value).toMatchObject({ error: { name: 'CredentialsDecryptError', code: 'kms_unavailable' } })
      expect(ms).toBeLessThan(SILENT_KMS_BOUND_MS)
      expect(kms.calls('Decrypt')).toHaveLength(2)
    } finally {
      delete kms.faults.Decrypt
      kms.releaseHung()
      await pending
    }
    expect(await recovery.decryptCredentials(written.blob)).toEqual({ refreshToken: 'synthetic-refresh' })
    void logText
  }, 30_000)
})
