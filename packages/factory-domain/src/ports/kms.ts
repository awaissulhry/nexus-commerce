/**
 * The key provider of the factory's envelope encryption (plan A1 §5.4; features PLT-197, PLT-224; GDPR art. 32). Every
 * secret is encrypted (AES-256-GCM) under its own random data key; only the data key WRAPPED by this port is stored
 * beside it. Implementations (apps/factory-api/src/platform/secrets):
 *   - AWS KMS (staging, production): GenerateDataKey / Decrypt with the factory's KMS key in eu-south-1; the master key
 *     never leaves KMS, and every unwrap is a CloudTrail event with its encryption context;
 *   - a local master key from apps/factory-api/.env (local and test only; refused in staging and production).
 *
 * The encryption context (tenant and purpose) binds a wrapped key to where it belongs: a data key wrapped for one
 * tenant or purpose does not unwrap for another.
 *
 * Pure types: no I/O.
 */

/** Key → value pairs bound to a wrapped key (KMS EncryptionContext; the local provider's GCM additional data). */
export type EncryptionContext = Readonly<Record<string, string>>

/** A fresh data key: the plain one (used once, in memory) and its wrapped form (stored). */
export interface DataKey {
  /** The key that wrapped it, as stored beside the value: `local:<fingerprint>`, `kms:<key id>`. */
  readonly keyId: string
  /** 32 bytes. Never stored, never logged. */
  readonly plaintext: Uint8Array
  readonly wrapped: Uint8Array
}

export interface KmsPort {
  /** The key id new data keys are wrapped with. */
  readonly keyId: string
  /** True when this provider can unwrap data keys wrapped by `keyId` (its current key, or an older one it still holds). */
  holds(keyId: string): boolean
  /** A new 256-bit data key, wrapped under the current key for this context. */
  generateDataKey(context: EncryptionContext): Promise<DataKey>
  /** The plain data key of a wrapped one; refuses another context, another key or a changed blob. */
  decryptDataKey(wrapped: Uint8Array, keyId: string, context: EncryptionContext): Promise<Uint8Array>
}
