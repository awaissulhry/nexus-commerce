/**
 * `DocumentSeal`'s words (B-W2b-28). English by default; a host passes the words it translates.
 */
export interface DocumentSealLabels {
  version: string
  fingerprint: string
  sealedAt: string
  source: string
  sealedBy: string
  signers: string
  /** "Signed 3 Nov 2026". */
  signedOn: (date: string) => string
  waiting: string
  /** "2 of 4 signed". */
  signedCount: (signed: number, total: number) => string
  verify: string
  verifyNote: string
  reading: string
  /** "lul-2026-10.pdf matches the sealed document". */
  match: (file: string) => string
  /** "lul-2026-10.pdf does NOT match: it differs from the sealed document". */
  mismatch: (file: string) => string
  failed: string
  copy: string
  copied: string
  copyFailed: string
  /** The seal's name for a screen reader. */
  region: string
}

export const DOCUMENT_SEAL_LABELS: DocumentSealLabels = {
  version: 'Version',
  fingerprint: 'SHA-256 fingerprint',
  sealedAt: 'Sealed',
  source: 'Time from',
  sealedBy: 'Sealed by',
  signers: 'Signatures',
  signedOn: (date) => `Signed ${date}`,
  waiting: 'Waiting to sign',
  signedCount: (signed, total) => `${signed} of ${total} signed`,
  verify: 'Verify a file',
  verifyNote: 'The file stays on this device: only its fingerprint is computed.',
  reading: 'Computing the fingerprint…',
  match: (file) => `${file} matches the sealed document`,
  mismatch: (file) => `${file} does NOT match: it differs from the sealed document`,
  failed: 'The file could not be read',
  copy: 'Copy',
  copied: 'Copied',
  copyFailed: 'Could not copy',
  region: 'Document seal',
}
