import crypto from 'node:crypto'
export const FAKE_KMS_KEY_ID = 'arn:aws:kms:eu-west-1:123456789012:key/0f3d2a1c-7b6e-4d5f-9a8b-1c2d3e4f5a6b'

interface KmsInput {
  KeyId?: string
  KeySpec?: string
  CiphertextBlob?: Uint8Array
  EncryptionContext?: Record<string, string>
}

export function kmsError(name: string, message: string): Error {
  const err = new Error(message)
  err.name = name
  return err
}

function sameContext(a: Record<string, string> | undefined, b: Record<string, string>): boolean {
  if (!a) return false
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k])
}

/**
 * Enough of KMS to test against. Wrapped DEK = iv(12) | tag(16) | ct,
 * AES-256-GCM under a random master key, AAD = canonical JSON of the
 * EncryptionContext used at GenerateDataKey time.
 */
export class FakeKms {
  private readonly master = crypto.randomBytes(32)
  keyId: string
  /** When set, Decrypt refuses any context that does not deep-equal this. */
  requiredContext: Record<string, string> | null = null
  failGenerate = false
  generateCalls: KmsInput[] = []
  decryptCalls: KmsInput[] = []
  /** The last plaintext DEK handed out — so tests can prove it never leaks. */
  lastDek: Buffer | null = null

  constructor(keyId = FAKE_KMS_KEY_ID) {
    this.keyId = keyId
  }

  async send(command: { constructor: { name: string }; input: KmsInput }): Promise<unknown> {
    const kind = command.constructor?.name
    const input = command.input
    if (kind === 'GenerateDataKeyCommand' || (kind === undefined && input.KeySpec)) {
      this.generateCalls.push(input)
      if (this.failGenerate) throw kmsError('KMSInternalException', 'simulated KMS outage')
      if (input.KeySpec !== 'AES_256') throw kmsError('ValidationException', 'bad KeySpec')
      if (!input.KeyId) throw kmsError('ValidationException', 'KeyId required')
      const dek = crypto.randomBytes(32)
      this.lastDek = Buffer.from(dek)
      return {
        Plaintext: new Uint8Array(dek),
        CiphertextBlob: new Uint8Array(this.wrap(dek, input.EncryptionContext ?? {})),
        KeyId: this.keyId,
      }
    }
    if (kind === 'DecryptCommand' || (kind === undefined && input.CiphertextBlob)) {
      this.decryptCalls.push(input)
      if (this.requiredContext && !sameContext(input.EncryptionContext, this.requiredContext)) {
        throw kmsError('InvalidCiphertextException', 'encryption context mismatch')
      }
      const dek = this.unwrap(Buffer.from(input.CiphertextBlob ?? new Uint8Array()), input.EncryptionContext ?? {})
      return { Plaintext: new Uint8Array(dek), KeyId: this.keyId }
    }
    throw new Error(`FakeKms: unknown command ${kind}`)
  }

  private aad(ctx: Record<string, string>): Buffer {
    const sorted = Object.keys(ctx).sort().map((k) => [k, ctx[k]])
    return Buffer.from(JSON.stringify(sorted), 'utf8')
  }

  private wrap(dek: Buffer, ctx: Record<string, string>): Buffer {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.master, iv)
    cipher.setAAD(this.aad(ctx))
    const ct = Buffer.concat([cipher.update(dek), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), ct])
  }

  private unwrap(wrapped: Buffer, ctx: Record<string, string>): Buffer {
    if (wrapped.length < 28) throw kmsError('InvalidCiphertextException', 'ciphertext too short')
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.master, wrapped.subarray(0, 12))
      decipher.setAAD(this.aad(ctx))
      decipher.setAuthTag(wrapped.subarray(12, 28))
      return Buffer.concat([decipher.update(wrapped.subarray(28)), decipher.final()])
    } catch {
      throw kmsError('InvalidCiphertextException', 'ciphertext or context invalid')
    }
  }
}

/** Split a v2 blob into editable pieces and put it back together. */
