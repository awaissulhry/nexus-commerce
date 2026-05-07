/**
 * CR.1 — AES-256-GCM credential encryption.
 *
 * Symmetric envelope for sensitive secrets persisted to the database
 * (Carrier credentials today; ChannelConnection tokens later). All
 * cipher state lives in a self-describing string so the schema stays
 * a single TEXT column and we can rotate the algorithm or key without
 * a migration.
 *
 * Wire format:
 *   v1:<base64url(iv12)>.<base64url(authTag16)>.<base64url(ciphertext)>
 *
 *   v1                = format version. Future v2/v3 add new ciphers
 *                       without breaking decrypt of older rows.
 *   iv12              = 12-byte GCM nonce, random per encrypt() call.
 *                       Reusing an IV with the same key in GCM is
 *                       catastrophic, so it MUST be random.
 *   authTag16         = 16-byte GCM authentication tag — verifies the
 *                       ciphertext hasn't been tampered with at rest.
 *   ciphertext        = AES-256-GCM(key, iv, plaintext-utf8).
 *
 * Key:
 *   process.env.NEXUS_CREDENTIAL_ENC_KEY must be a base64-encoded
 *   32-byte (256-bit) key. Generate with:
 *     openssl rand -base64 32
 *   Setting it WRONG (length != 32 after decode) throws at startup
 *   the first time encrypt/decrypt is called — fail loudly rather
 *   than silently using a half-key.
 *
 * Plaintext detection:
 *   isEncrypted(value) returns true iff the string starts with "v1:".
 *   Callers use this to detect legacy plaintext-JSON rows (pre-CR.1)
 *   and re-encrypt in place. resolveCredentials in the Sendcloud
 *   public surface is the single migration path; we do not run a
 *   one-shot data migration because per-row encrypt-on-read keeps
 *   the rotation surface tiny + lets us deploy without coordinating
 *   a backfill window.
 */

import crypto from 'node:crypto'

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
