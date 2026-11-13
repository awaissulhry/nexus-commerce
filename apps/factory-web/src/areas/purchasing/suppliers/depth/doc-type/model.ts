import { isApiError, issuePath } from '../../../../../lib/api/errors'
import type { PickerReason } from '../../../../_shared/reasons/api'

/**
 * The document-type picker of a supplier's vault (B-W2b-382, the screen gap B-W2b-377 left; SCM-020). A document in force
 * says what it is — a code of the tenant's SUPPLIER_DOCUMENT_TYPE list (a DURC, an LWG audit, a chromium VI test report …) —
 * or nothing: an untyped document still meets any ask of its kind (as before B-W2b-377), a typed one only the asks of its
 * code (a DURC is never taken for an ISO certificate; the PO gate's chromium VI report is a test report typed so, or
 * untyped). The type's words are the list's own; a code no longer in the list is said by its code until someone changes it.
 * Typing is files.upload's. PURE.
 */

export const WORDS_NS = 'words-followups-w2b5'

export interface DocTypeDialog {
  readonly fileId: string
  readonly name: string
  /** The type it has now (null: not said). */
  readonly current: string | null
  /** The code chosen ('' : not said). */
  readonly chosen: string
  /** The file's version as read when the dialog opened (null: being read). */
  readonly version: number | null
  readonly busy: boolean
  readonly problem: string | null
}

/** A code's words in the person's language (the list's own), else the code itself (a code the list no longer has). */
export function typeWords(code: string, types: readonly PickerReason[] | null, locale: string): string {
  const reason = types?.find((entry) => entry.code === code)
  if (!reason) return code
  return reason.labelI18n?.[locale] ?? (locale === 'it' ? reason.labelIt : reason.labelEn)
}

/** Why Save of the type waits, or null. */
export function docTypeHeld(dialog: DocTypeDialog, input: { readonly mayType: boolean; readonly offline: boolean }): string | null {
  if (!input.mayType) return 'docType.held.noRight'
  if (input.offline) return 'docType.held.offline'
  if (dialog.version === null) return 'docType.held.reading'
  if (dialog.busy) return 'docType.held.busy'
  if ((dialog.chosen || null) === dialog.current) return 'docType.held.same'
  return null
}

/** A refusal of the type, in words (a key of words-followups-w2b5); `reload`: read the vault again. */
export function docTypeProblem(error: unknown): { key: string; reload: boolean } {
  if (!isApiError(error)) return { key: 'docType.problem.failed', reload: false }
  const paths = error.issues.map(issuePath)
  if (paths.some((path) => path.includes('documentTypeCode'))) return { key: 'docType.problem.code', reload: true }
  if (error.kind === 'conflict') return { key: 'docType.problem.moved', reload: true }
  if (error.kind === 'forbidden' || error.kind === 'step_up') return { key: 'docType.held.noRight', reload: false }
  if (error.kind === 'not_found') return { key: 'docType.problem.gone', reload: true }
  if (error.kind === 'unavailable') return { key: 'docType.held.offline', reload: false }
  return { key: 'docType.problem.failed', reload: false }
}
