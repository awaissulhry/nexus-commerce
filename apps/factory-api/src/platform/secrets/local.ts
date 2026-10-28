import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { DataKey, EncryptionContext, KmsPort } from '@nexus/factory-domain/ports/kms'
import type { FactoryEnv } from '../../env'
import { SecretError } from './envelope'

/**
 * The LOCAL key provider (plan A1 §5.4): data keys wrapped with AES-256-GCM under a master key from
 * apps/factory-api/.env (FACTORY_SECRETS_MASTER_KEY), for local and test runs only. Staging and production wrap with
 * AWS KMS (aws-kms.ts): this provider refuses to be made there, and env.ts refuses the variable there too.
 *
 * Key id: `local:<first 16 hex of SHA-256(master key)>`, so two master keys never share an id and a value sealed with
 * one is never tried with another. A wrapped key is iv (12) | tag (16) | ciphertext (32); the GCM additional data is
 * the encryption context (sorted JSON), so a key wrapped for one tenant or purpose does not unwrap for another.
 */

export const LOCAL_KEY_PREFIX = 'local:'
const KEY_BYTES = 32

export class LocalKeyRefusedError extends SecretError {
  override name = 'LocalKeyRefusedError'
}

const contextBytes = (context: EncryptionContext): Buffer =>
  Buffer.from(JSON.stringify(Object.keys(context).sort().map((key) => [key, context[key]])), 'utf8')

export interface LocalKeyOptions {
  /** 32 bytes. */
  readonly masterKey: Uint8Array
  /** Refused with staging or production. */
  readonly environment: FactoryEnv['FACTORY_ENV']
}

export function localKeyProvider({ masterKey, environment }: LocalKeyOptions): KmsPort {
  if (environment !== 'local' && environment !== 'test') {
    throw new LocalKeyRefusedError(`A local master key is refused with FACTORY_ENV=${environment}; secrets are wrapped by AWS KMS there.`)
  }
  const master = Buffer.from(masterKey ?? [])
  if (master.length !== KEY_BYTES) throw new SecretError('The local master key must be 32 bytes.')
  const keyId = `${LOCAL_KEY_PREFIX}${createHash('sha256').update(master).digest('hex').slice(0, 16)}`

  return Object.freeze({
    keyId,
    holds: (other: string) => other === keyId,
    async generateDataKey(context: EncryptionContext): Promise<DataKey> {
      const plaintext = randomBytes(KEY_BYTES)
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', master, iv, { authTagLength: 16 })
      cipher.setAAD(contextBytes(context))
      const wrapped = Buffer.concat([cipher.update(plaintext), cipher.final()])
      return { keyId, plaintext, wrapped: Buffer.concat([iv, cipher.getAuthTag(), wrapped]) }
    },
    async decryptDataKey(wrapped: Uint8Array, wrappedBy: string, context: EncryptionContext): Promise<Uint8Array> {
      if (wrappedBy !== keyId) throw new SecretError(`Key ${wrappedBy} is not this local master key.`)
      const blob = Buffer.from(wrapped)
      if (blob.length !== 12 + 16 + KEY_BYTES) throw new SecretError('The wrapped data key is malformed.')
      const decipher = createDecipheriv('aes-256-gcm', master, blob.subarray(0, 12), { authTagLength: 16 })
      decipher.setAAD(contextBytes(context))
      decipher.setAuthTag(blob.subarray(12, 28))
      return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()])
    },
  })
}
