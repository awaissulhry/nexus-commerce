/**
 * The virus scanner port (PLT-245; B-W2a-42): what a scanner does for the files platform. Two implementations:
 * `adapters/clamav` (clamd's INSTREAM protocol over a TCP socket: a ClamAV container beside the API, platform
 * infrastructure like the KMS key, not a tenant's account) and `fake.ts` (local and test: the EICAR test file is
 * infected, nothing else). Live scanning needs the Owner's spend yes (GATE-SPEND: the scanner service).
 *
 * A scanner answers about the BYTES only; the scan flow (scan.ts) decides what the file becomes. A scanner that cannot be
 * reached throws ScannerUnavailableError: the file stays held (QUARANTINED, scan PENDING) and is never "clean" by
 * default; a later try (the person's "Try again", the sweep cron) scans it.
 */

export type ScanVerdict =
  | { readonly verdict: 'CLEAN'; readonly engine: string }
  /** `finding`: the signature's name ("Eicar-Test-Signature"). */
  | { readonly verdict: 'INFECTED'; readonly engine: string; readonly finding: string }
  /** The scanner read the request but could not judge the file (too large for it, an archive it cannot open, a time-out). */
  | { readonly verdict: 'FAILED'; readonly engine: string; readonly finding: string }

export interface VirusScanner {
  /** `clamav` or `fake`: what the security page and the notes say is on. */
  readonly kind: 'clamav' | 'fake'
  scan(bytes: Uint8Array): Promise<ScanVerdict>
}

/** The scanner did not answer (refused, unreachable, closed before an answer): nothing is known about the file. */
export class ScannerUnavailableError extends Error {
  override name = 'ScannerUnavailableError'
}
