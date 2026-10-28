import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms'
import type { DataKey, EncryptionContext, KmsPort } from '@nexus/factory-domain/ports/kms'
import { SecretError } from './envelope'

/**
 * The AWS KMS key provider (plan A1 §5.4): staging and production wrap every data key with the factory's own KMS key
 * in eu-south-1 (GenerateDataKey, KeySpec AES_256) and unwrap it with Decrypt, both with the encryption context
 * (app, tenant, purpose), which KMS checks and CloudTrail records. The master key never leaves KMS. KMS rotates its key
 * material yearly under the same key ARN, so nothing here needs a re-encrypt for that; `rotate` (envelope.ts) re-seals
 * values only when the factory moves to another key.
 *
 * This is the one factory file outside platform/gateway/ and src/adapters/ that imports an AWS SDK
 * (scripts/factory/check-integration-calls.mjs names it): KMS is platform infrastructure, not a tenant's integration
 * account, so its calls have no IntegrationCall row. The client gets its region and credentials explicitly
 * (FACTORY_AWS_…, env.ts), never from a profile or another variable. Tests pass a fake `client` and never reach AWS.
 *
 * Key id stored with each value: `kms:<the key ARN KMS answered with>`. Set FACTORY_KMS_KEY_ID to the key ARN (an
 * alias works, but then every value counts as sealed with "another key" for needsRotation).
 */

export const KMS_KEY_PREFIX = 'kms:'
const KEY_BYTES = 32

/** What the provider needs of a KMS client: `send` (the SDK's KMSClient, or a fake in tests). */
export interface KmsClientLike {
  send(command: GenerateDataKeyCommand): Promise<{ KeyId?: string; Plaintext?: Uint8Array; CiphertextBlob?: Uint8Array }>
  send(command: DecryptCommand): Promise<{ KeyId?: string; Plaintext?: Uint8Array }>
}

export interface AwsKmsOptions {
  readonly client: KmsClientLike
  /** The KMS key (its ARN) that wraps new data keys. */
  readonly keyId: string
}

export function awsKmsKeyProvider({ client, keyId }: AwsKmsOptions): KmsPort {
  if (typeof keyId !== 'string' || keyId === '') throw new SecretError('The KMS key provider needs FACTORY_KMS_KEY_ID.')
  return Object.freeze({
    keyId: `${KMS_KEY_PREFIX}${keyId}`,
    holds: (other: string) => other.startsWith(KMS_KEY_PREFIX) && other.length > KMS_KEY_PREFIX.length,
    async generateDataKey(context: EncryptionContext): Promise<DataKey> {
      const answer = await client.send(new GenerateDataKeyCommand({ KeyId: keyId, KeySpec: 'AES_256', EncryptionContext: { ...context } }))
      if (!answer.Plaintext || answer.Plaintext.length !== KEY_BYTES || !answer.CiphertextBlob || !answer.KeyId) {
        throw new SecretError('KMS answered GenerateDataKey without a 256-bit data key.')
      }
      return { keyId: `${KMS_KEY_PREFIX}${answer.KeyId}`, plaintext: answer.Plaintext, wrapped: answer.CiphertextBlob }
    },
    async decryptDataKey(wrapped: Uint8Array, wrappedBy: string, context: EncryptionContext): Promise<Uint8Array> {
      if (!wrappedBy.startsWith(KMS_KEY_PREFIX)) throw new SecretError(`Key ${wrappedBy} is not a KMS key.`)
      const answer = await client.send(
        new DecryptCommand({ CiphertextBlob: wrapped, KeyId: wrappedBy.slice(KMS_KEY_PREFIX.length), EncryptionContext: { ...context } }),
      )
      if (!answer.Plaintext || answer.Plaintext.length !== KEY_BYTES) throw new SecretError('KMS answered Decrypt without a 256-bit data key.')
      return answer.Plaintext
    },
  })
}

export interface AwsKmsClientOptions {
  readonly region: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
}

/** The real KMS client, for staging and production (secretsFromEnv). Making it sends nothing. */
export function createAwsKmsClient({ region, accessKeyId, secretAccessKey }: AwsKmsClientOptions): KmsClientLike {
  return new KMSClient({ region, credentials: { accessKeyId, secretAccessKey }, maxAttempts: 3 }) as KmsClientLike
}
