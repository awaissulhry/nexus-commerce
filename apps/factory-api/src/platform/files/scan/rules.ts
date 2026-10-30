import type { ScanVerdict } from './port'

/**
 * The virus scan's moves on a StoredFile (PLT-245; B-W2a-42), pure: the …_platform_w2a_guards trigger holds the same
 * rules for every login (scan NOT_SCANNED → PENDING → CLEAN | INFECTED | FAILED, FAILED | CLEAN → PENDING; a verdict has
 * its time and scanner; INFECTED and FAILED say what; INFECTED is never AVAILABLE; QUARANTINED → AVAILABLE only from
 * `scan_pending` with PENDING → CLEAN).
 *
 *   confirm with a scanner   PENDING_UPLOAD → QUARANTINED `scan_pending`, scan PENDING (never AVAILABLE before the scan)
 *   CLEAN                    → AVAILABLE (availableAt, the reason cleared) — or stays AVAILABLE on a rescan
 *   INFECTED                 → QUARANTINED `virus_found` with the signature (an AVAILABLE file moves back too)
 *   FAILED                   → stays QUARANTINED, `scan_failed` with why (an AVAILABLE file stays: it was clean before)
 *   try again                FAILED → PENDING, `scan_pending` again (the verdict's time, scanner and finding cleared)
 *   scanner down             nothing changes: PENDING until a scanner answers (the person's Try again, the sweep)
 */

export const SCAN_REASONS = Object.freeze({ pending: 'scan_pending', infected: 'virus_found', failed: 'scan_failed' } as const)
export const SCAN_QUARANTINE_REASONS = [SCAN_REASONS.pending, SCAN_REASONS.infected, SCAN_REASONS.failed] as const

export type ScanStatus = 'NOT_SCANNED' | 'PENDING' | 'CLEAN' | 'INFECTED' | 'FAILED'

export interface ScannedFile {
  readonly status: string
  readonly scanStatus: ScanStatus
  readonly quarantineReason: string | null
}

/** The confirm's change when the upload matched and a scanner is on: held until its scan. */
export const heldForScan = () => ({ status: 'QUARANTINED' as const, quarantineReason: SCAN_REASONS.pending, scanStatus: 'PENDING' as const })

/** The file waits for a scan (PENDING) or for a try again (FAILED) while held: a confirm scans it again. */
export const waitsForScan = (file: ScannedFile): boolean =>
  file.status === 'QUARANTINED' && ((file.scanStatus === 'PENDING' && file.quarantineReason === SCAN_REASONS.pending) || (file.scanStatus === 'FAILED' && file.quarantineReason === SCAN_REASONS.failed))

/** The change a verdict makes to a PENDING file. */
export function verdictChange(file: ScannedFile, verdict: ScanVerdict, now: Date) {
  const stamp = { scannedAt: now, scanEngine: verdict.engine }
  if (verdict.verdict === 'CLEAN') {
    return file.status === 'QUARANTINED'
      ? { ...stamp, scanStatus: 'CLEAN' as const, scanFinding: null, status: 'AVAILABLE' as const, availableAt: now, quarantineReason: null }
      : { ...stamp, scanStatus: 'CLEAN' as const, scanFinding: null }
  }
  if (verdict.verdict === 'INFECTED') return { ...stamp, scanStatus: 'INFECTED' as const, scanFinding: verdict.finding, status: 'QUARANTINED' as const, quarantineReason: SCAN_REASONS.infected }
  return file.status === 'QUARANTINED'
    ? { ...stamp, scanStatus: 'FAILED' as const, scanFinding: verdict.finding, quarantineReason: SCAN_REASONS.failed }
    : { ...stamp, scanStatus: 'FAILED' as const, scanFinding: verdict.finding }
}

/** Try again after FAILED: back to PENDING (and `scan_pending`, so a CLEAN verdict may make it AVAILABLE). */
export const retryChange = () => ({ scanStatus: 'PENDING' as const, scannedAt: null, scanEngine: null, scanFinding: null, quarantineReason: SCAN_REASONS.pending })
