import type { FloorLook } from '../../auth/floor/literacy'
import type { Issue } from '../../core/errors'
import { DISCARD_REASON_MAX } from '../rules'

/**
 * Offline conflicts go to the lead (B-W2b-52; MES-196: "W1 lists refused scans; a lead conflict list comes later"; design
 * floor.supervisor "Waiting for you": "A sync conflict (one bundle-operation reported on two tablets) shows both
 * reports; pick the one that stands"). A conflict is a queued action the floor sync refused because ANOTHER tablet
 * recorded the same thing first: today, a report of a bundle at an operation (production.scan.report) refused with
 * ALREADY_REPORTED while the standing report came from another device (or the office's correction). The tablet's own
 * double scans stay the operator's own refusals (Waiting to send), as in W1.
 *
 * The team leader of the line (floor.lead at the device's site) sees both reports and decides:
 *   KEEP_RECORDED   the report recorded first stands: the refused one is discarded with the lead's reason (and the scan
 *                   module's own record of it with it). A signing act on the floor: the PIN (c.c. art. 2101: a record of
 *                   work is kept, never rewritten without a trace).
 *   SEND_TO_OFFICE  the refused one should stand: changing a recorded report is a correction the office approves (W1,
 *                   B-W1-42; the original stays), so the conflict goes to the office with the lead's reason and stays
 *                   open in the refused lists until the office corrects the recorded report or discards this one.
 * A reason is always picked from tiles (icon and tone first, MES-188), never typed.
 *
 * Statuto dei Lavoratori art. 4 (Owner answers W1, F2): a list of conflicts names stations and tablets, never a worker;
 * one conflict names its two reporters only where the site names workers.
 */

export const CONFLICT_KINDS = ['DOUBLE_REPORT'] as const
export type ConflictKind = (typeof CONFLICT_KINDS)[number]

/** The queued kind and the module's refusal code of each conflict kind. */
export const CONFLICT_SOURCES: Readonly<Record<ConflictKind, { readonly kind: string; readonly code: string }>> = Object.freeze({
  DOUBLE_REPORT: { kind: 'production.scan.report', code: 'ALREADY_REPORTED' },
})

/** The conflict kind a refused queued action may be (before the standing record is looked at), or null. */
export function conflictKindOf(refused: { readonly kind: string; readonly code: string }): ConflictKind | null {
  for (const kind of CONFLICT_KINDS) {
    const source = CONFLICT_SOURCES[kind]
    if (refused.kind === source.kind && refused.code === source.code) return kind
  }
  return null
}

/** Another tablet (or the office) recorded the standing report: a conflict for the lead, not the operator's own double scan. */
export const isCrossTablet = (refusedDeviceId: string, standing: { readonly deviceId: string | null }): boolean => standing.deviceId !== refusedDeviceId

export const CONFLICT_DECISIONS = ['KEEP_RECORDED', 'SEND_TO_OFFICE'] as const
export type ConflictDecision = (typeof CONFLICT_DECISIONS)[number]

export interface ConflictReason {
  readonly code: string
  readonly look: FloorLook
  /** The words kept with the decision (the discard's reason, the audit row): English, as every stored reason. */
  readonly words: string
}

/** The reason tiles of each decision. */
export const CONFLICT_REASONS: Readonly<Record<ConflictDecision, readonly ConflictReason[]>> = Object.freeze({
  KEEP_RECORDED: [
    { code: 'SAME_WORK', look: { icon: 'copy', tone: 'info' }, words: 'both tablets reported the same work' },
    { code: 'SCANNED_TWICE', look: { icon: 'repeat', tone: 'warning' }, words: 'the bundle was scanned again by mistake' },
    { code: 'WRONG_TABLET', look: { icon: 'tablet', tone: 'neutral' }, words: 'it was reported on the wrong tablet' },
  ],
  SEND_TO_OFFICE: [
    { code: 'COUNTS_WRONG', look: { icon: 'hash', tone: 'warning' }, words: 'the counts recorded first are wrong' },
    { code: 'OTHER_STATION', look: { icon: 'map-pin', tone: 'info' }, words: 'the work was done where the refused report was sent from' },
  ],
})

export const reasonOf = (decision: ConflictDecision, code: string): ConflictReason | null => CONFLICT_REASONS[decision].find((reason) => reason.code === code) ?? null

/** The reason must be one of the decision's tiles (path `reason`). */
export function conflictReasonProblem(decision: ConflictDecision, code: string): Issue | null {
  return reasonOf(decision, code) ? null : { path: 'reason', message: `Pick one of the reasons offered for ${decision === 'KEEP_RECORDED' ? 'keeping the recorded report' : 'sending it to the office'}.` }
}

/** The words a KEEP_RECORDED discard keeps (the refused action's discard reason: at most DISCARD_REASON_MAX characters). */
export function keepRecordedWords(reason: ConflictReason): string {
  return `The team leader kept the report recorded first: ${reason.words}.`.slice(0, DISCARD_REASON_MAX)
}

/** The words a SEND_TO_OFFICE keeps on the refused action's history. */
export function sendToOfficeWords(reason: ConflictReason): string {
  return `The team leader asks the office to let this report stand: ${reason.words}.`.slice(0, DISCARD_REASON_MAX)
}

/** The audit action a SEND_TO_OFFICE writes on the refused action: the conflict's state "with the office" is read from it. */
export const SENT_TO_OFFICE_ACTION = 'floorsync.conflictToOffice'

/** Where a conflict stands for the lead: waiting for them, or sent to the office (still open there). */
export type ConflictState = 'OPEN' | 'WITH_OFFICE'

/** Icon and tone first (MES-188): the conflict kind and the two decisions. */
export const CONFLICT_LOOK: Readonly<Record<ConflictKind, FloorLook>> = Object.freeze({ DOUBLE_REPORT: { icon: 'git-compare', tone: 'warning' } })
export const DECISION_LOOK: Readonly<Record<ConflictDecision, FloorLook>> = Object.freeze({
  KEEP_RECORDED: { icon: 'check-circle', tone: 'success' },
  SEND_TO_OFFICE: { icon: 'send', tone: 'info' },
})
