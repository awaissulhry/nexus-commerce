import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Clock } from '@nexus/factory-domain/ports/clock'
import type { EncryptionContext, KmsPort } from '@nexus/factory-domain/ports/kms'
import { serverClock } from '../../core/time'

/**
 * Envelope encryption of the factory's secrets (plan A1 §5.4; features PLT-197, PLT-224; GDPR art. 32), the pattern of
 * Commerce's apps/api/src/lib/crypto.ts v2 envelopes:
 *
 *   seal     a fresh 256-bit data key per value (the key provider's generateDataKey, bound to the context) →
 *            AES-256-GCM(data key, random 96-bit nonce, plaintext, AAD) → { keyId, wrapped data key, iv, ciphertext,
 *            tag }. The plain data key is dropped; only the wrapped one is kept.
 *   open     the provider that holds `keyId` unwraps the data key for the same context → GCM decrypt with the same AAD.
 *            A changed byte anywhere (ciphertext, tag, iv, wrapped key, key id) or another tenant or purpose fails.
 *   rotate   open, then seal again under the current key with a new data key.
 *
 * The context is the tenant (null: a platform secret) and the purpose (`integration.credentials`, `auth.totp`): it is
 * the GCM additional data (with the key id) and the key provider's encryption context, so a value copied to another
 * tenant or another purpose never opens. Key providers: AWS KMS (aws-kms.ts; staging, production) and the local master
 * key (local.ts; local, test). The first provider seals; every provider given can open what it holds (rotation).
 *
 * Unwrapped data keys are cached in memory (5 minutes, 256 entries), so a gateway call does not cost a KMS Decrypt each
 * time (Commerce caches 10 minutes). Error messages never carry a secret.
 *
 * Two forms: SealedSecret (the columns of a SecretValue row, store.ts) and a self-describing string for a column of
 * another table (`s1.<keyId>.<wrapped>.<iv>.<ciphertext>.<tag>`, base64url parts).
 */

export const SECRET_ALGORITHM = 'AES-256-GCM'
const STRING_VERSION = 's1'
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const PURPOSE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/

/** Where a secret belongs: its tenant (null for a platform secret) and what it is for. */
export interface SecretContext {
  readonly tenantId: string | null
  /** `<area>.<what>`: `integration.credentials`, `integration.webhook`, `auth.totp`. */
  readonly purpose: string
}

/** A sealed value: what a SecretValue row stores. */
export interface SealedSecret {
  readonly keyId: string
  readonly algorithm: typeof SECRET_ALGORITHM
  readonly wrappedKey: Uint8Array
  readonly iv: Uint8Array
  readonly ciphertext: Uint8Array
  readonly authTag: Uint8Array
}

/** A secret could not be sealed or opened. The message names the cause, never the value. */
export class SecretError extends Error {
  override name = 'SecretError'
}

export interface SecretsService {
  /** The key new values are sealed with. */
  readonly keyId: string
  seal(plaintext: string, context: SecretContext): Promise<SealedSecret>
  open(sealed: SealedSecret, context: SecretContext): Promise<string>
  /** Seals the plaintext of `sealed` again under the current key, with a new data key. */
  rotate(sealed: SealedSecret, context: SecretContext): Promise<SealedSecret>
  /** True when the value was sealed with another key than the current one. */
  needsRotation(sealed: Pick<SealedSecret, 'keyId'>): boolean
  /** The string form, for a column of another table (a TOTP secret on its factor row). */
  sealToString(plaintext: string, context: SecretContext): Promise<string>
  openString(sealed: string, context: SecretContext): Promise<string>
  rotateString(sealed: string, context: SecretContext): Promise<string>
}

export interface SecretsServiceOptions {
  /** The key providers: the first seals, every one opens what it holds (current key first, older keys after). */
  readonly providers: readonly KmsPort[]
  readonly clock?: Clock
  /** How long an unwrapped data key stays in memory. Default 5 minutes; 0 caches nothing. */
  readonly cacheMs?: number
}

function checkContext(context: SecretContext): SecretContext {
  if (context === null || typeof context !== 'object') throw new SecretError('A secret needs its context (tenant and purpose).')
  if (context.tenantId !== null && !isUuid(context.tenantId)) throw new SecretError('The secret context names a tenant that is not a UUID.')
  if (typeof context.purpose !== 'string' || !PURPOSE.test(context.purpose)) {
    throw new SecretError('The secret context needs a purpose such as integration.credentials.')
  }
  return context
}

/** The key provider's encryption context: KMS checks it on every unwrap (and logs it in CloudTrail). */
export function encryptionContext(context: SecretContext): EncryptionContext {
  return { app: 'nexus-factory', tenant: context.tenantId ?? '-', purpose: context.purpose }
}

/** The GCM additional data of a value: the context and the key id, so neither can be swapped. */
function additionalData(context: SecretContext, keyId: string): Buffer {
  return Buffer.from(`factory-secret v1|tenant=${context.tenantId ?? '-'}|purpose=${context.purpose}|key=${keyId}`, 'utf8')
}

const sha256 = (...parts: (string | Uint8Array)[]): string => {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part).update('\u0000')
  return hash.digest('hex')
}

const asBytes = (value: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(value)

export function createSecretsService(options: SecretsServiceOptions): SecretsService {
  const providers = [...(options.providers ?? [])]
  const current = providers[0]
  if (!current) throw new SecretError('The secrets service needs at least one key provider.')
  const clock = options.clock ?? serverClock
  const cacheMs = options.cacheMs ?? 5 * 60_000
  const cache = new Map<string, { readonly key: Buffer; readonly until: number }>()

  async function dataKey(sealed: SealedSecret, context: SecretContext): Promise<Buffer> {
    const provider = providers.find((entry) => entry.holds(sealed.keyId))
    if (!provider) throw new SecretError(`No key provider holds key ${sealed.keyId}; the value cannot be opened here.`)
    const at = clock.now().getTime()
    const cacheKey = sha256(sealed.keyId, sealed.wrappedKey, JSON.stringify(encryptionContext(context)))
    const hit = cache.get(cacheKey)
    if (hit && hit.until > at) return hit.key
    let key: Buffer
    try {
      key = Buffer.from(await provider.decryptDataKey(sealed.wrappedKey, sealed.keyId, encryptionContext(context)))
    } catch (error) {
      if (error instanceof SecretError) throw error
      throw new SecretError(`The data key did not unwrap (another tenant or purpose, or a changed value): ${(error as Error).name}.`)
    }
    if (key.length !== KEY_BYTES) throw new SecretError('The key provider returned a data key of the wrong size.')
    if (cacheMs > 0) {
      cache.delete(cacheKey)
      cache.set(cacheKey, { key, until: at + cacheMs })
      while (cache.size > 256) cache.delete(cache.keys().next().value as string)
    }
    return key
  }

  async function seal(plaintext: string, context: SecretContext): Promise<SealedSecret> {
    checkContext(context)
    if (typeof plaintext !== 'string') throw new SecretError('Only text is sealed (JSON.stringify an object first).')
    const generated = await current!.generateDataKey(encryptionContext(context))
    const key = Buffer.from(generated.plaintext)
    try {
      if (key.length !== KEY_BYTES) throw new SecretError('The key provider returned a data key of the wrong size.')
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
      cipher.setAAD(additionalData(context, generated.keyId))
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return Object.freeze({
        keyId: generated.keyId,
        algorithm: SECRET_ALGORITHM,
        wrappedKey: asBytes(generated.wrapped),
        iv: asBytes(iv),
        ciphertext: asBytes(ciphertext),
        authTag: asBytes(cipher.getAuthTag()),
      })
    } finally {
      key.fill(0)
    }
  }

  async function open(sealed: SealedSecret, context: SecretContext): Promise<string> {
    checkContext(context)
    if (sealed?.algorithm !== SECRET_ALGORITHM) throw new SecretError(`Unknown secret algorithm ${JSON.stringify(sealed?.algorithm)}.`)
    if (sealed.iv?.length !== IV_BYTES || sealed.authTag?.length !== TAG_BYTES) throw new SecretError('The sealed value is malformed.')
    const key = await dataKey(sealed, context)
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv, { authTagLength: TAG_BYTES })
      decipher.setAAD(additionalData(context, sealed.keyId))
      decipher.setAuthTag(sealed.authTag)
      return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8')
    } catch {
      throw new SecretError('The sealed value does not open: it was changed, or it belongs to another tenant or purpose.')
    }
  }

  const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')
  const toText = (sealed: SealedSecret): string =>
    [STRING_VERSION, b64(Buffer.from(sealed.keyId, 'utf8')), b64(sealed.wrappedKey), b64(sealed.iv), b64(sealed.ciphertext), b64(sealed.authTag)].join('.')
  function fromText(text: string): SealedSecret {
    const parts = typeof text === 'string' ? text.split('.') : []
    if (parts.length !== 6 || parts[0] !== STRING_VERSION || parts.some((part) => !/^[A-Za-z0-9_-]*$/.test(part))) {
      throw new SecretError('Not a sealed secret string (s1.…).')
    }
    const [, keyId, wrappedKey, iv, ciphertext, authTag] = parts.map((part) => Buffer.from(part, 'base64url'))
    return { keyId: keyId!.toString('utf8'), algorithm: SECRET_ALGORITHM, wrappedKey: wrappedKey!, iv: iv!, ciphertext: ciphertext!, authTag: authTag! }
  }

  return Object.freeze({
    keyId: current.keyId,
    seal,
    open,
    async rotate(sealed: SealedSecret, context: SecretContext) {
      return seal(await open(sealed, context), context)
    },
    needsRotation: (sealed: Pick<SealedSecret, 'keyId'>) => sealed.keyId !== current.keyId,
    sealToString: async (plaintext: string, context: SecretContext) => toText(await seal(plaintext, context)),
    openString: async (sealed: string, context: SecretContext) => open(fromText(sealed), context),
    rotateString: async (sealed: string, context: SecretContext) => toText(await seal(await open(fromText(sealed), context), context)),
  })
}

/** A service that refuses every call, with the reason (no key configured). Opening and sealing fail; nothing else does. */
export function unconfiguredSecrets(reason: string): SecretsService {
  const refuse = async (): Promise<never> => {
    throw new SecretError(reason)
  }
  return Object.freeze({
    keyId: 'none',
    seal: refuse,
    open: refuse,
    rotate: refuse,
    needsRotation: () => false,
    sealToString: refuse,
    openString: refuse,
    rotateString: refuse,
  })
}
