/**
 * CR.1 / CX.1 — credential encryption at rest.
 *
 * Symmetric envelopes for sensitive secrets persisted to the database
 * (Carrier credentials; ChannelConnection tokens via the CX token
 * service). All cipher state lives in a self-describing string so the
 * schema stays a single TEXT column and we can rotate the algorithm or
 * key without a migration. Two formats coexist; both decrypt forever.
 *
 * ── v1 — single env key (CR.1) ─────────────────────────────────────────
 *
 *   v1:<base64url(iv12)>.<base64url(authTag16)>.<base64url(ciphertext)>
 *
 *   iv12       = 12-byte GCM nonce, random per encrypt() call. Reusing an
 *                IV with the same key in GCM is catastrophic, so it MUST
 *                be random.
 *   authTag16  = 16-byte GCM authentication tag — verifies the ciphertext
 *                hasn't been tampered with at rest.
 *   ciphertext = AES-256-GCM(key, iv, plaintext-utf8).
 *
 *   Key: process.env.NEXUS_CREDENTIAL_ENC_KEY, a base64-encoded 32-byte
 *   key (`openssl rand -base64 32`). A wrong-shaped key throws the first
 *   time encrypt/decrypt is called — fail loudly, never use a half-key.
 *
 * ── v2 — KMS envelope encryption (CX.1) ────────────────────────────────
 *
 *   v2:<kid>:<base64url(wrappedDek)>.<base64url(iv12)>.<base64url(authTag16)>.<base64url(ciphertext)>
 *
 *   kid        = the KMS KeyId that GenerateDataKey answered with — the
 *                master key that wrapped this blob's data key, version
 *                included (an ARN, `…:key/<uuid>`). A kid is written raw
 *                when it is made only of [A-Za-z0-9_-/]; otherwise (any
 *                ':' or '.', which every ARN has) it is base64url-encoded
 *                and prefixed `b64.` so the envelope stays parseable: the
 *                kid is delimited by the first ':' after `v2:`, and the
 *                four trailing parts are split on '.'. credentialsKeyIdOf
 *                returns the DECODED kid.
 *   wrappedDek = KMS CiphertextBlob: the per-blob 256-bit data key (DEK),
 *                encrypted under the master key with EncryptionContext
 *                { app: 'nexus', purpose: 'credentials' }. Only KMS can
 *                unwrap it; the plaintext DEK is never persisted.
 *   iv12 / authTag16 / ciphertext = AES-256-GCM(dek, iv, plaintext-utf8)
 *                with AAD = the string `v2:<kid>` exactly as it appears in
 *                the envelope, so a swapped or edited kid fails the tag.
 *
 *   Per encrypt: one KMS GenerateDataKey (KeyId = NEXUS_KMS_KEY_ID,
 *   KeySpec AES_256) → fresh DEK + wrappedDek. Per decrypt: one KMS
 *   Decrypt of wrappedDek (the KeyId is NOT needed — the wrapped DEK
 *   carries it), cached in memory keyed by sha256(wrappedDek) for ten
 *   minutes in a bounded LRU of 256 entries, then a local GCM verify.
 *
 *   Why this shape (the enterprise rationale):
 *     • The master key lives in KMS and never leaves it. A database dump
 *       plus every env var on the box still cannot decrypt a v2 row.
 *     • KMS rotates the master key annually (automatic rotation keeps
 *       every prior version), and rotation needs NO re-encrypt and NO
 *       downtime: each wrapped DEK carries the key version that made it,
 *       so old rows keep decrypting while new rows use the new version.
 *       reencryptCredentials exists for the deliberate rotation job that
 *       wants old rows moved forward, not for correctness.
 *     • Every Decrypt is a CloudTrail event with the EncryptionContext,
 *       so "who read which credential, when" is auditable outside our
 *       own logs. The DEK cache trades a little of that audit granularity
 *       for not calling KMS on every request; ten minutes is the ceiling.
 *     • A blob encrypted under context A cannot be decrypted with context
 *       B — the context is authenticated by KMS, so a wrapped DEK lifted
 *       from this table cannot be unwrapped by another service's code.
 *
 *   Fallback: when NEXUS_KMS_KEY_ID is unset (local dev, tests) or KMS
 *   fails on GenerateDataKey, encryptCredentials writes a v1 blob under
 *   the env key and fires onCredentialsKmsFallback ONCE per process (plus
 *   logger.warn) so the token service can raise an alert. Decrypt never
 *   falls back: a v2 blob needs KMS, full stop.
 *
 *   Access: only the CX token service may call decryptCredentials /
 *   reencryptCredentials. Routes and jobs get tokens from that service,
 *   never from this module, so the decrypt surface stays one file wide.
 *
 * Plaintext detection:
 *   isEncrypted(value) is true iff the string starts with "v1:" (the
 *   Sendcloud resolveCredentials migration path relies on it and is left
 *   untouched). isCredentialsBlob(value) is true for "v1:" OR "v2:".
 */

import crypto from 'node:crypto'
import {
  KMSClient,
  GenerateDataKeyCommand,
  DecryptCommand,
  type GenerateDataKeyCommandOutput,
  type DecryptCommandOutput,
} from '@aws-sdk/client-kms'
import { logger } from '../utils/logger.js'

const ALGO = 'aes-256-gcm' as const
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const VERSION = 'v1'

let cachedKey: Buffer | null = null

/**
 * Resolve and validate the symmetric key. Cached after first call so
 * the base64 decode + length check don't happen on every operation.
 * Throws a clear error if the env var is missing or wrong-shaped.
 */
function getKey(): Buffer {
  if (cachedKey) return cachedKey
  const raw = process.env.NEXUS_CREDENTIAL_ENC_KEY
  if (!raw) {
    throw new Error(
      'NEXUS_CREDENTIAL_ENC_KEY is not set. Generate one with `openssl rand -base64 32` and add it to .env. See apps/api/src/lib/crypto.ts for the format.',
    )
  }
  let buf: Buffer
  try {
    buf = Buffer.from(raw, 'base64')
  } catch {
    throw new Error('NEXUS_CREDENTIAL_ENC_KEY is not valid base64.')
  }
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `NEXUS_CREDENTIAL_ENC_KEY must decode to ${KEY_BYTES} bytes (got ${buf.length}). Regenerate with \`openssl rand -base64 32\`.`,
    )
  }
  cachedKey = buf
  return buf
}

/**
 * Encrypt a UTF-8 string. Output format documented at file top.
 *
 * The IV is generated per-call from crypto.randomBytes; never reused.
 * GCM auth tag is concatenated alongside ciphertext so decrypt can
 * verify integrity in one pass.
 */
export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encryptSecret expects a string')
  }
  const key = getKey()
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${VERSION}:${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`
}

/**
 * Decrypt a string produced by encryptSecret. Throws if the string
 * isn't in the expected envelope or the auth tag doesn't verify.
 *
 * Callers that need to handle legacy plaintext should branch on
 * isEncrypted() before calling — this function is strict on purpose
 * so a corrupt or tampered row fails loudly rather than returning
 * garbage.
 */
export function decryptSecret(envelope: string): string {
  if (!isEncrypted(envelope)) {
    throw new Error('decryptSecret called on non-v1 envelope; check isEncrypted() first')
  }
  const body = envelope.slice(VERSION.length + 1) // strip "v1:"
  const parts = body.split('.')
  if (parts.length !== 3) {
    throw new Error('Malformed v1 envelope: expected iv.tag.ciphertext')
  }
  const [ivB64, tagB64, ctB64] = parts
  const iv = Buffer.from(ivB64, 'base64url')
  const tag = Buffer.from(tagB64, 'base64url')
  const ct = Buffer.from(ctB64, 'base64url')
  if (iv.length !== IV_BYTES) throw new Error('Bad IV length')
  if (tag.length !== TAG_BYTES) throw new Error('Bad auth tag length')
  const key = getKey()
  const decipher = crypto.createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  const pt = Buffer.concat([decipher.update(ct), decipher.final()])
  return pt.toString('utf8')
}

/** True if the value looks like a v1 envelope produced by encryptSecret. */
export function isEncrypted(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(`${VERSION}:`)
}

/**
 * Test-only — clear the cached key so a subsequent call re-reads
 * NEXUS_CREDENTIAL_ENC_KEY. Tests rotate the env between cases.
 */
export const __test = { resetKeyCache: () => { cachedKey = null } }

// ═══════════════════════════════════════════════════════════════════════
// CX.1 — v2 KMS envelope encryption for credential blobs
// ═══════════════════════════════════════════════════════════════════════

const V2 = 'v2'
const V2_PREFIX = `${V2}:`
const KID_B64_PREFIX = 'b64.'
const RAW_KID_OK = /^[A-Za-z0-9_\-/]+$/
const KMS_KEY_SPEC = 'AES_256' as const
const KMS_ENCRYPTION_CONTEXT: Readonly<Record<string, string>> = Object.freeze({
  app: 'nexus',
  purpose: 'credentials',
})
const DEK_CACHE_TTL_MS = 10 * 60 * 1000
const DEK_CACHE_MAX_ENTRIES = 256

export type CredentialsMode = 'kms' | 'env'
export type CredentialsDecryptErrorCode = 'bad_format' | 'kms_unavailable' | 'auth_tag' | 'key_missing'

export interface EncryptCredentialsResult {
  blob: string
  /** The KMS KeyId (decoded) for `kms`; the literal 'env' for a v1 fallback blob. */
  keyId: string
  mode: CredentialsMode
}

/**
 * The one error decryptCredentials throws. Messages are fixed strings —
 * they never quote the blob, the DEK, the plaintext, or the KMS response —
 * and toJSON exposes only name/code/message, so an error that reaches a
 * log line or an HTTP body carries nothing worth stealing.
 */
export class CredentialsDecryptError extends Error {
  readonly code: CredentialsDecryptErrorCode

  constructor(code: CredentialsDecryptErrorCode, message: string) {
    super(message)
    this.name = 'CredentialsDecryptError'
    this.code = code
  }

  toJSON(): { name: string; code: CredentialsDecryptErrorCode; message: string } {
    return { name: this.name, code: this.code, message: this.message }
  }
}

/**
 * The slice of KMSClient this module uses. Tests inject a plain object
 * with a `send(command)` method through __cryptoTest.setKmsClient; the
 * real client satisfies it structurally.
 */
export interface KmsClientLike {
  send(command: GenerateDataKeyCommand): Promise<GenerateDataKeyCommandOutput>
  send(command: DecryptCommand): Promise<DecryptCommandOutput>
}

let kmsClient: KmsClientLike | null = null

/** Lazily build the KMS client: region from env, default credential chain. */
function getKms(): KmsClientLike {
  if (!kmsClient) {
    kmsClient = new KMSClient({ region: process.env.AWS_REGION ?? 'eu-west-1' })
  }
  return kmsClient
}

// ── DEK cache: sha256(wrappedDek) → plaintext DEK, TTL + LRU ─────────────

interface DekCacheEntry { dek: Buffer; expiresAt: number }
const dekCache = new Map<string, DekCacheEntry>()

function dekCacheKey(wrappedDek: Buffer): string {
  return crypto.createHash('sha256').update(wrappedDek).digest('hex')
}

function dekCacheGet(key: string): Buffer | null {
  const hit = dekCache.get(key)
  if (!hit) return null
  if (hit.expiresAt <= Date.now()) {
    dekCache.delete(key)
    hit.dek.fill(0)
    return null
  }
  // Re-insert so Map iteration order doubles as LRU order.
  dekCache.delete(key)
  dekCache.set(key, hit)
  return hit.dek
}

function dekCacheSet(key: string, dek: Buffer): void {
  const existing = dekCache.get(key)
  if (existing) {
    dekCache.delete(key)
    existing.dek.fill(0)
  }
  while (dekCache.size >= DEK_CACHE_MAX_ENTRIES) {
    const oldest = dekCache.keys().next().value
    if (oldest === undefined) break
    dekCache.get(oldest)?.dek.fill(0)
    dekCache.delete(oldest)
  }
  dekCache.set(key, { dek, expiresAt: Date.now() + DEK_CACHE_TTL_MS })
}

function dekCacheClear(): void {
  for (const entry of dekCache.values()) entry.dek.fill(0)
  dekCache.clear()
}

// ── Fallback notice: once per process ──────────────────────────────────

type FallbackListener = (reason: string) => void
let fallbackListeners: FallbackListener[] = []
let fallbackNoticedReason: string | null = null

/**
 * Register a hook that fires the first time this process writes a v1
 * blob because KMS was unavailable (NEXUS_KMS_KEY_ID unset, or KMS threw
 * on GenerateDataKey). The CX token service wires it to the alert
 * service; this module only logs. If the fallback already happened
 * before the hook was registered, the hook is called immediately so a
 * late subscriber still hears about it. Returns an unsubscribe function.
 */
export function onCredentialsKmsFallback(fn: FallbackListener): () => void {
  fallbackListeners.push(fn)
  if (fallbackNoticedReason !== null) safeNotify(fn, fallbackNoticedReason)
  return () => {
    fallbackListeners = fallbackListeners.filter((l) => l !== fn)
  }
}

function safeNotify(fn: FallbackListener, reason: string): void {
  try {
    fn(reason)
  } catch (err) {
    logger.warn('credentials: KMS fallback hook threw', { error: errorName(err) })
  }
}

function noteKmsFallback(reason: string): void {
  if (fallbackNoticedReason !== null) return
  fallbackNoticedReason = reason
  logger.warn('credentials: encrypting with the v1 env key instead of KMS', { reason })
  for (const fn of fallbackListeners) safeNotify(fn, reason)
}

/** name + message of an unknown error — never the payload it may carry. */
function errorName(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return typeof err === 'string' ? err : 'unknown error'
}

// ── kid encoding ───────────────────────────────────────────────────────

function encodeKid(keyId: string): string {
  if (RAW_KID_OK.test(keyId)) return keyId
  return `${KID_B64_PREFIX}${Buffer.from(keyId, 'utf8').toString('base64url')}`
}

function decodeKid(kid: string): string {
  if (!kid.startsWith(KID_B64_PREFIX)) return kid
  return Buffer.from(kid.slice(KID_B64_PREFIX.length), 'base64url').toString('utf8')
}

// ── v2 envelope parse ──────────────────────────────────────────────────

interface ParsedV2 { kid: string; wrappedDek: Buffer; iv: Buffer; tag: Buffer; ct: Buffer }

function parseV2(blob: string): ParsedV2 {
  const body = blob.slice(V2_PREFIX.length)
  const sep = body.indexOf(':')
  if (sep <= 0) throw new CredentialsDecryptError('bad_format', 'Malformed v2 envelope: missing key id')
  const kid = body.slice(0, sep)
  const parts = body.slice(sep + 1).split('.')
  if (parts.length !== 4 || parts.some((p) => p.length === 0)) {
    throw new CredentialsDecryptError('bad_format', 'Malformed v2 envelope: expected wrappedDek.iv.tag.ciphertext')
  }
  const [wrappedDek, iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64url'))
  if (wrappedDek.length === 0) throw new CredentialsDecryptError('bad_format', 'Malformed v2 envelope: empty wrapped data key')
  if (iv.length !== IV_BYTES) throw new CredentialsDecryptError('bad_format', 'Malformed v2 envelope: bad IV length')
  if (tag.length !== TAG_BYTES) throw new CredentialsDecryptError('bad_format', 'Malformed v2 envelope: bad auth tag length')
  return { kid, wrappedDek, iv, tag, ct }
}

function toBuffer(bytes: Uint8Array | undefined): Buffer | null {
  if (!bytes || bytes.length === 0) return null
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

// ── v2 encrypt / decrypt ───────────────────────────────────────────────

async function encryptV2(plaintext: string, kmsKeyId: string): Promise<EncryptCredentialsResult> {
  const out = await getKms().send(
    new GenerateDataKeyCommand({
      KeyId: kmsKeyId,
      KeySpec: KMS_KEY_SPEC,
      EncryptionContext: { ...KMS_ENCRYPTION_CONTEXT },
    }),
  )
  const dek = toBuffer(out.Plaintext)
  const wrappedDek = toBuffer(out.CiphertextBlob)
  const keyId = out.KeyId
  if (!dek || dek.length !== KEY_BYTES || !wrappedDek || !keyId) {
    dek?.fill(0)
    throw new Error('KMS GenerateDataKey returned an unusable data key')
  }
  try {
    const kid = encodeKid(keyId)
    const iv = crypto.randomBytes(IV_BYTES)
    const cipher = crypto.createCipheriv(ALGO, dek, iv)
    cipher.setAAD(Buffer.from(`${V2_PREFIX}${kid}`, 'utf8'))
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    const blob =
      `${V2_PREFIX}${kid}:${wrappedDek.toString('base64url')}.${iv.toString('base64url')}` +
      `.${tag.toString('base64url')}.${ct.toString('base64url')}`
    return { blob, keyId, mode: 'kms' }
  } finally {
    dek.fill(0)
  }
}

async function unwrapDek(wrappedDek: Buffer): Promise<Buffer> {
  const cacheKey = dekCacheKey(wrappedDek)
  const cached = dekCacheGet(cacheKey)
  if (cached) return cached
  let out: DecryptCommandOutput
  try {
    out = await getKms().send(
      new DecryptCommand({
        CiphertextBlob: wrappedDek,
        EncryptionContext: { ...KMS_ENCRYPTION_CONTEXT },
      }),
    )
  } catch (err) {
    logger.warn('credentials: KMS Decrypt failed', { error: errorName(err) })
    throw new CredentialsDecryptError('kms_unavailable', 'KMS could not unwrap the data key')
  }
  const dek = toBuffer(out.Plaintext)
  if (!dek || dek.length !== KEY_BYTES) {
    dek?.fill(0)
    throw new CredentialsDecryptError('kms_unavailable', 'KMS returned an unusable data key')
  }
  dekCacheSet(cacheKey, dek)
  return dek
}

async function decryptV2(blob: string): Promise<string> {
  const { kid, wrappedDek, iv, tag, ct } = parseV2(blob)
  const dek = await unwrapDek(wrappedDek)
  try {
    const decipher = crypto.createDecipheriv(ALGO, dek, iv)
    decipher.setAAD(Buffer.from(`${V2_PREFIX}${kid}`, 'utf8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  } catch {
    throw new CredentialsDecryptError('auth_tag', 'Credential blob failed authentication')
  }
}

function decryptV1ForCredentials(blob: string): string {
  try {
    return decryptSecret(blob)
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (msg.includes('NEXUS_CREDENTIAL_ENC_KEY')) {
      throw new CredentialsDecryptError('key_missing', 'NEXUS_CREDENTIAL_ENC_KEY is missing or malformed')
    }
    if (msg.startsWith('Malformed') || msg.startsWith('Bad ')) {
      throw new CredentialsDecryptError('bad_format', 'Malformed v1 envelope')
    }
    throw new CredentialsDecryptError('auth_tag', 'Credential blob failed authentication')
  }
}

function parseCredentialsJson(plaintext: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    throw new CredentialsDecryptError('bad_format', 'Decrypted credentials are not JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CredentialsDecryptError('bad_format', 'Decrypted credentials are not a JSON object')
  }
  return parsed as Record<string, unknown>
}

// ── Public surface ─────────────────────────────────────────────────────

/** True for any blob this module can decrypt: a v1 or v2 envelope. */
export function isCredentialsBlob(value: unknown): value is string {
  return typeof value === 'string' && (value.startsWith(`${VERSION}:`) || value.startsWith(V2_PREFIX))
}

/**
 * Which key protects a blob, without decrypting it. v1 blobs have no
 * key id (the env key is anonymous); v2 blobs carry the decoded KMS
 * KeyId. Throws bad_format for anything that is not a credentials blob.
 */
export function credentialsKeyIdOf(blob: string): { version: 'v1' | 'v2'; keyId: string | null } {
  if (typeof blob !== 'string') throw new CredentialsDecryptError('bad_format', 'Not a credentials blob')
  if (blob.startsWith(`${VERSION}:`)) return { version: 'v1', keyId: null }
  if (blob.startsWith(V2_PREFIX)) {
    return { version: 'v2', keyId: decodeKid(parseV2(blob).kid) }
  }
  throw new CredentialsDecryptError('bad_format', 'Not a credentials blob')
}

/**
 * Encrypt a credentials object for storage. KMS envelope (v2) when
 * NEXUS_KMS_KEY_ID is set and KMS answers; otherwise the v1 env key,
 * with the fallback hook fired once per process. See the file header.
 */
export async function encryptCredentials(obj: Record<string, unknown>): Promise<EncryptCredentialsResult> {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new TypeError('encryptCredentials expects a plain object')
  }
  const plaintext = JSON.stringify(obj)
  const kmsKeyId = process.env.NEXUS_KMS_KEY_ID
  if (!kmsKeyId) {
    noteKmsFallback('NEXUS_KMS_KEY_ID is not set')
  } else {
    try {
      return await encryptV2(plaintext, kmsKeyId)
    } catch (err) {
      const reason = `KMS GenerateDataKey failed (${errorName(err)})`
      logger.warn('credentials: KMS GenerateDataKey failed; falling back to the v1 env key', { error: errorName(err) })
      noteKmsFallback(reason)
    }
  }
  return { blob: encryptSecret(plaintext), keyId: 'env', mode: 'env' }
}

/**
 * Decrypt a v1 or v2 credentials blob back to the object that was
 * encrypted. Only the CX token service should call this. Throws
 * CredentialsDecryptError — never a raw crypto/KMS error.
 */
export async function decryptCredentials(blob: string): Promise<Record<string, unknown>> {
  if (typeof blob !== 'string') throw new CredentialsDecryptError('bad_format', 'Credential blob must be a string')
  if (blob.startsWith(`${VERSION}:`)) return parseCredentialsJson(decryptV1ForCredentials(blob))
  if (blob.startsWith(V2_PREFIX)) return parseCredentialsJson(await decryptV2(blob))
  throw new CredentialsDecryptError('bad_format', 'Not a credentials blob')
}

/**
 * Decrypt with whatever protected the blob, re-encrypt with the current
 * key. The rotation job walks rows with this; a v1 row becomes v2 once
 * NEXUS_KMS_KEY_ID is set, and a v2 row moves to the current master key
 * version.
 */
export async function reencryptCredentials(blob: string): Promise<EncryptCredentialsResult> {
  return encryptCredentials(await decryptCredentials(blob))
}

/**
 * Test-only seams. setKmsClient(null) drops the injected client so the
 * next KMS call lazily builds the real one; resetFallbackNotice clears
 * the once-per-process notice AND the registered listeners.
 */
export const __cryptoTest = {
  setKmsClient: (client: KmsClientLike | null) => { kmsClient = client },
  resetDekCache: () => { dekCacheClear() },
  resetFallbackNotice: () => { fallbackNoticedReason = null; fallbackListeners = [] },
  dekCacheSize: () => dekCache.size,
}
