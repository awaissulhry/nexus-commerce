import { createHash } from 'node:crypto'
import { assertCredentialsMaintenanceKey, checkCredentialsCancellation, CredentialsDecryptError, credentialsKeyIdOf, decryptCredentials, isCredentialsCancellation, reencryptCredentials } from '../../../lib/crypto.js'

/** Original sealed fields only. Assignment/delivery history is not a crypto input. */
export interface QuarantineCipher {
  environment: string
  signatureOk: boolean
  externalId: string
  topic: string
  subjectHash: string | null
  payloadDigest: string
  payloadEnc: string | null
  payloadKeyId: string | null
}

export class QuarantineCipherError extends Error {
  readonly code = 'quarantine_cipher_invalid'
  /** access: a key or KMS was unavailable; integrity: the envelope did not verify. */
  constructor(readonly reason: 'access' | 'integrity' = 'integrity') { super('The original quarantine body could not be verified.'); this.name = 'QuarantineCipherError' }
}

/** Private bytes, never a diagnostic response. Unsupported/malformed provider bodies
 * remain recoverable: integrity is separate from eligibility for account adoption. */
export async function openEbayQuarantineBody(row: QuarantineCipher, options?: { bypassKmsCache?: boolean; signal?: AbortSignal }): Promise<Buffer> {
  try {
    checkCredentialsCancellation(options?.signal)
    if (!row.signatureOk || !row.payloadEnc || !row.payloadKeyId
      || !['production', 'sandbox'].includes(row.environment)) throw new QuarantineCipherError()
    const metadata = credentialsKeyIdOf(row.payloadEnc)
    if (row.payloadKeyId !== (metadata.version === 'v1' ? 'env' : metadata.keyId)) throw new QuarantineCipherError()
    const saved = await decryptCredentials(row.payloadEnc, options)
    checkCredentialsCancellation(options?.signal)
    const expected = { environment: row.environment, signatureOk: row.signatureOk, externalId: row.externalId,
      topic: row.topic, subjectHash: row.subjectHash, payloadDigest: row.payloadDigest }
    if (saved.version !== 1 || !saved.binding || typeof saved.binding !== 'object' || Array.isArray(saved.binding)
      || Object.entries(expected).some(([key, value]) => (saved.binding as Record<string, unknown>)[key] !== value)
      || typeof saved.rawBody !== 'string' || saved.rawBody.length > 4 * Math.ceil(1_048_576 / 3)) throw new QuarantineCipherError()
    const rawBody = Buffer.from(saved.rawBody, 'base64')
    if (!rawBody.length || rawBody.length > 1_048_576 || rawBody.toString('base64') !== saved.rawBody
      || createHash('sha256').update(rawBody).digest('hex') !== row.payloadDigest) throw new QuarantineCipherError()
    return rawBody
  } catch (error) {
    if (isCredentialsCancellation(error)) throw error
    throw new QuarantineCipherError(error instanceof CredentialsDecryptError && (error.code === 'key_missing' || error.code === 'kms_unavailable') ? 'access' : 'integrity')
  }
}

/** Prepares a verified replacement only; the separate privileged CAS owns persistence. */
export async function reencryptEbayQuarantine(row: QuarantineCipher, targetKeyArn: string, options?: { signal?: AbortSignal }) {
  assertCredentialsMaintenanceKey(targetKeyArn)
  // Proof opens only; wipe the returned byte copies (intermediate strings are GC-bound).
  ;(await openEbayQuarantineBody(row, { bypassKmsCache: true, signal: options?.signal })).fill(0)
  const replacement = await reencryptCredentials(row.payloadEnc!, targetKeyArn, options)
  if (replacement.mode !== 'kms' || replacement.keyId !== targetKeyArn) throw new QuarantineCipherError()
  ;(await openEbayQuarantineBody({ ...row, payloadEnc: replacement.blob, payloadKeyId: replacement.keyId }, { bypassKmsCache: true, signal: options?.signal })).fill(0)
  checkCredentialsCancellation(options?.signal)
  return replacement
}
