import type { CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import { EMPTY_INTAKE, intakeFieldProblems, type Door, type FieldProblems, type IntakeDraft } from './intake'
import type { SafetyPhotosModel } from './view/SafetyPhotos'

/**
 * The report dialog from outside (B-W2b-357: links.doc › Report a problem and the portal's Report a safety incident; the claim
 * form's safety path), pure: tell us (the shared form), check and send, then the number and the photos. One model for both
 * doors (the Links and Portal views may not import each other: it lives here).
 */

export type ReportStep = 'form' | 'review'
export const REPORT_STEPS: readonly ReportStep[] = ['form', 'review']

export interface ReportDialogModel {
  readonly step: ReportStep
  readonly draft: IntakeDraft
  /** Next or Send was pressed: the problems are shown at their fields. */
  readonly tried: boolean
  /** The API named these fields (a 400 after the send). */
  readonly refusedFields: FieldProblems
  readonly busy: boolean
  /** A device check is being solved (a 429 `challenge`, the public door). */
  readonly checking: boolean
  /** Why the send failed (a key), with the wait of a 429. */
  readonly refusal: { readonly key: string; readonly wait: { readonly unit: 'seconds' | 'minutes'; readonly count: number } | null } | null
  /** Close was asked with typed work. */
  readonly discard: boolean
  readonly scanning: boolean
  /** The end: the number the API gave. */
  readonly sent: { readonly number: string } | null
  /** The photos after the send; null: none on this door (the portal role cannot upload). */
  readonly photos: SafetyPhotosModel | null
}

export const FRESH_DIALOG: ReportDialogModel = Object.freeze({ step: 'form', draft: EMPTY_INTAKE, tried: false, refusedFields: {}, busy: false, checking: false, refusal: null, discard: false, scanning: false, sent: null, photos: null })

export interface ReportDialogActions {
  onDraft?: (patch: Partial<IntakeDraft>) => void
  onNext?: () => void
  onBack?: () => void
  onSend?: () => void
  onClose?: () => void
  onDiscard?: () => void
  onStay?: () => void
  onScan?: (open: boolean) => void
  onScanned?: (code: string) => void
  photos?: {
    onAdd?: () => void
    onCapture?: (photo: CapturedPhoto) => void | Promise<void>
    onCloseCapture?: () => void
    onRetry?: (key: string) => void
  }
}

/** The form's problems shown now: the rules' after Next or Send, the API's after a refusal. */
export function shownProblems(dialog: ReportDialogModel, door: Door, today: string, fixedBatch: string | null): FieldProblems {
  return { ...(dialog.tried ? intakeFieldProblems(dialog.draft, door, today, fixedBatch) : {}), ...dialog.refusedFields }
}

/** Why Send waits (a key), or null. */
export function sendHeld(dialog: ReportDialogModel, offline = false): string | null {
  if (dialog.busy) return dialog.checking ? 'dialog.checking' : 'dialog.sending'
  if (dialog.refusal?.wait) return 'held.wait'
  if (offline) return 'held.offline'
  return null
}
