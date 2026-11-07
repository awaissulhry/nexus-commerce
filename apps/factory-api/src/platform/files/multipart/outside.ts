import { ApiError } from '../../../core/errors'
import { readFactoryVariables } from '../../../env'
import { processScanner } from '../scan/service'

/**
 * Uploads from outside need the virus scanner (B-W2b-160, follow-up FV1:02 of B-W2a-42; GATE-SPEND): in a live
 * environment (staging, production) an upload from a partner's portal or from a one-off link is refused unless the
 * scanner is ClamAV (FACTORY_VIRUS_SCAN=clamav); local and test runs are not gated (the fake scanner or none). Every
 * route that takes a file from outside calls `assertOutsideUploadsOpen()` before it announces the upload — today the
 * supplier's confirmation PDF on its PO link (modules/purchasing/confirm/upload.ts); the portal and link upload steps
 * (B-W2b-171, -172, -182, -189, -192) call it too, for a single PUT or an upload in parts alike.
 *
 * "Unshared until CLEAN" is held by the status: a portal or a link sees a file only once it is AVAILABLE
 * (files.ts readVisible and listFiles), and with a scanner a file becomes AVAILABLE only when its scan says CLEAN.
 */

export type ScannerKind = 'clamav' | 'fake' | null

/** Why uploads from outside are closed here, in words; null when they are open. */
export function outsideUploadsRefusal(environment: string | undefined, scanner: ScannerKind): string | null {
  const live = environment === 'staging' || environment === 'production'
  if (!live || scanner === 'clamav') return null
  return 'Uploads from outside are closed for now: the virus scanner is not running here yet. Please send the file to your contact by e-mail.'
}

/** The process's scanner, or null when it is off or its configuration is broken (then nothing is scanned). */
function scannerKind(): ScannerKind {
  try {
    return processScanner()?.kind ?? null
  } catch {
    return null
  }
}

/** 503 when uploads from outside are closed (above). */
export function assertOutsideUploadsOpen(environment: string | undefined = readFactoryVariables().FACTORY_ENV): void {
  const refusal = outsideUploadsRefusal(environment, scannerKind())
  if (refusal) throw new ApiError('not_ready', refusal)
}
