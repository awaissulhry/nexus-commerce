import type { Report } from '../api'
import { closeHeld, injuryHeld, reasonHeld, reviseDraftOf, reviseProblems, type ReviseField } from '../model'
import type { FactsDraft, RecordDialog } from './view-model'

/**
 * The record's dialogs (B-W2b-357), pure: each dialog's first draft, its problems by field, and why its button waits. The
 * rules are the API's (factory-domain rules: closeProblems, eraseReasonProblems, injuryProblems, revisionProblems), said here
 * before the call so a refusal is rare.
 */

export function factsDraftOf(report: Report): FactsDraft {
  return { serial: report.serial ?? '', batchNumber: report.batchNumber ?? '', size: report.size ?? '', occurredOn: report.occurredOn ?? '', worn: report.wornAsIntended === true ? 'yes' : report.wornAsIntended === false ? 'no' : 'unsure' }
}

/** The facts' body: only what changed. */
export function factsPatchOf(draft: FactsDraft, report: Report): { serial?: string | null; batchNumber?: string | null; size?: string | null; occurredOn?: string | null; wornAsIntended?: boolean | null } {
  const patch: ReturnType<typeof factsPatchOf> = {}
  const text = (value: string) => (value.trim() === '' ? null : value.trim())
  if (text(draft.serial) !== report.serial) patch.serial = text(draft.serial)
  if (text(draft.batchNumber) !== report.batchNumber) patch.batchNumber = text(draft.batchNumber)
  if (text(draft.size) !== report.size) patch.size = text(draft.size)
  if ((draft.occurredOn || null) !== report.occurredOn) patch.occurredOn = draft.occurredOn || null
  const worn = draft.worn === 'yes' ? true : draft.worn === 'no' ? false : null
  if (worn !== report.wornAsIntended) patch.wornAsIntended = worn
  return patch
}

/** A dialog as it opens. */
export function dialogFor(kind: RecordDialog['kind'], report: Report): RecordDialog {
  switch (kind) {
    case 'close':
      return { kind, note: '' }
    case 'revise':
      return { kind, draft: reviseDraftOf(report), first: report.accidentLog.revisions === 0, told: false }
    case 'eraseReporter':
      return { kind, reason: '' }
    case 'eraseInjury':
      return { kind, reason: '' }
    case 'recordInjury':
      return { kind, draft: { injured: null, consent: false, words: '' } }
    case 'facts':
      return { kind, draft: factsDraftOf(report) }
    case 'file':
      return { kind }
  }
}

/** "The authority was told…": a revision that records the day, from the newest revision. */
export const toldDialogFor = (report: Report, today: string): RecordDialog => ({ kind: 'revise', draft: reviseDraftOf(report, true, today), first: report.accidentLog.revisions === 0, told: true })

/** A revision's problems by field. */
export function reviseFieldProblems(dialog: Extract<RecordDialog, { kind: 'revise' }>, report: Report, today: string): Partial<Record<ReviseField, string>> {
  const problems = reviseProblems(dialog.draft, { first: dialog.first, receivedOn: report.receivedAt.slice(0, 10), today })
  if (dialog.told && !dialog.draft.toldOn) problems.toldOn = 'problem.revise.toldOn'
  return problems
}

/** Why the dialog's button waits (a key), or null. */
export function dialogHeld(dialog: RecordDialog, report: Report, today: string): string | null {
  switch (dialog.kind) {
    case 'close':
      return closeHeld(dialog.note)
    case 'eraseReporter':
    case 'eraseInjury':
      return reasonHeld(dialog.reason)
    case 'recordInjury':
      return injuryHeld(dialog.draft)
    case 'revise': {
      const problems = reviseFieldProblems(dialog, report, today)
      return Object.keys(problems).length > 0 ? 'problem.revise.fields' : null
    }
    case 'facts':
      return Object.keys(factsPatchOf(dialog.draft, report)).length === 0 ? 'problem.facts.nothing' : dialog.draft.occurredOn > today ? 'problem.occurredOnFuture' : null
    case 'file':
      return null
  }
}
