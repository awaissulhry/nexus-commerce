import { ScannerUnavailableError, type ScanVerdict, type VirusScanner } from './port'

/**
 * The FAKE virus scanner (local and test; PLT-245): deterministic, no network.
 *   - a file that holds the EICAR test string (the industry's harmless test file) → INFECTED `Eicar-Test-Signature`;
 *   - a file that holds FAKE_SCAN_FAIL → FAILED (what a real scanner says of an archive it cannot open);
 *   - `down()` → every scan throws ScannerUnavailableError until `up()` (a scanner that is not running);
 *   - anything else → CLEAN.
 * Each call is counted (`scans`), so a test sees that a file was (or was not) scanned again.
 */

/**
 * The EICAR anti-virus test file's content (https://www.eicar.org): harmless, every scanner reports it. Joined at run
 * time, so this source file itself is never flagged by a scanner on a developer's machine.
 */
export const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS', '-TEST-FILE!$H+H*'].join('')
/** A made-up marker the fake scanner cannot judge. */
export const FAKE_SCAN_FAIL = 'NEXUS-FAKE-SCAN-CANNOT-READ'
export const FAKE_ENGINE = 'Fake scanner 1'

export interface FakeScanner extends VirusScanner {
  readonly kind: 'fake'
  readonly scans: number
  down(): void
  up(): void
}

const holds = (bytes: Uint8Array, text: string): boolean => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(Buffer.from(text, 'latin1'))

export function fakeScanner(): FakeScanner {
  let available = true
  let scans = 0
  return {
    kind: 'fake',
    get scans() {
      return scans
    },
    down() {
      available = false
    },
    up() {
      available = true
    },
    async scan(bytes): Promise<ScanVerdict> {
      scans++
      if (!available) throw new ScannerUnavailableError('The fake scanner is down.')
      if (holds(bytes, EICAR)) return { verdict: 'INFECTED', engine: FAKE_ENGINE, finding: 'Eicar-Test-Signature' }
      if (holds(bytes, FAKE_SCAN_FAIL)) return { verdict: 'FAILED', engine: FAKE_ENGINE, finding: 'The scanner could not read this file.' }
      return { verdict: 'CLEAN', engine: FAKE_ENGINE }
    },
  }
}
