import type { Issue } from '../../core/errors'
import { PLANT_LIMITS, type MachineStatus } from '../rules'

/**
 * Machines in depth (B-W2b-136; QHS-164, QHS-165, QHS-167; design plant.machines "Change status", "Status & downtime",
 * "Documents & CE", "Tag", "Status wall"). The rules every caller shares for a machine's status changed by hand from the
 * office, and the refusals of the step in words.
 *
 * A machine's status moves by itself with the work (a report marks it down or unsafe, a job puts it under maintenance and
 * hands it back, a technician signs it safe: B-W2a-35, B-W2b-96). "Change status" is the office's hand on it, with a reason
 * every time (the status history copies it: MachineStatusEvent, written by the database's trigger, never by the API):
 *
 *   - RETIRED is never a target here (Retire is its own act, with its plans ended) and a retired machine never moves;
 *   - a machine locked as unsafe (an unsafe request not signed safe) stays DO_NOT_USE until a technician signs THAT request
 *     safe (Owner answer H1; D.Lgs. 81/2008 art. 71): no hand change frees it;
 *   - DO_NOT_USE set by hand also needs a reason, and only a technician releases it (plant.signSafe, with a fresh code:
 *     the same signing act as a sign-safe);
 *   - IDLE is not a status yet (it comes with machine signals, Later).
 *
 * No person is named anywhere in a status or its history (Statuto dei Lavoratori art. 4: machine data can show a
 * worker's activity): the audit row keeps who changed it, the history keeps what and why.
 */

/** The statuses the office may set by hand. */
export const SETTABLE_STATUSES = ['RUNNING', 'DOWN', 'UNDER_MAINTENANCE', 'DO_NOT_USE'] as const satisfies readonly MachineStatus[]
export type SettableStatus = (typeof SETTABLE_STATUSES)[number]

export const STATUS_REASON_MIN = 3

/** The refusals of machines in depth: a 409 with `refusal/<CODE>` and `fix`, as every plant refusal. */
export const MACHINE_DEPTH_REFUSALS = [
  // Change status (QHS-167)
  'MACHINE_RETIRED',
  'SAME_STATUS',
  'LOCKED_UNSAFE',
  // Documents & CE (QHS-165)
  'DOCUMENT_KIND',
  // Print QR tags (QHS-164)
  'TAG_RETIRED',
  'TAG_OTHER_SITE',
] as const
export type MachineDepthRefusalCode = (typeof MACHINE_DEPTH_REFUSALS)[number]

export interface MachineDepthRefusal {
  readonly code: MachineDepthRefusalCode
  /** What happened and why, in words (never a person's name). */
  readonly message: string
  /** The one thing to do about it. */
  readonly fix: string
}

const refusal = (code: MachineDepthRefusalCode, message: string, fix: string): MachineDepthRefusal => ({ code, message, fix })

export const machineRetired = (assetNumber: string): MachineDepthRefusal =>
  refusal('MACHINE_RETIRED', `Machine ${assetNumber} is retired: its status no longer changes.`, 'It stays for its history; register the machine that replaced it.')
export const sameStatus = (assetNumber: string): MachineDepthRefusal => refusal('SAME_STATUS', `Machine ${assetNumber} is in this status already.`, 'Pick another status.')
export const lockedUnsafe = (assetNumber: string): MachineDepthRefusal =>
  refusal(
    'LOCKED_UNSAFE',
    `Machine ${assetNumber} is locked as unsafe: it stays do-not-use until a technician signs its request safe (Owner answer H1).`,
    'Open the request that locked it in Machine requests; a technician signs it safe there.',
  )
export const documentKind = (): MachineDepthRefusal =>
  refusal('DOCUMENT_KIND', 'A CE declaration or a manual is a document (PDF) or a certificate; a photo goes under Photos.', 'Pick the group that fits the file, or upload it as another document.')
export const tagRetired = (assetNumber: string): MachineDepthRefusal =>
  refusal('TAG_RETIRED', `Machine ${assetNumber} is retired: its tag no longer offers "Report a problem".`, 'Leave it out of the tags to print.')
export const tagOtherSite = (assetNumber: string): MachineDepthRefusal =>
  refusal('TAG_OTHER_SITE', `Machine ${assetNumber} stands at another site than the label printer.`, 'Print its tag on a label printer of its own site.')

export interface StatusChange {
  readonly assetNumber: string
  readonly status: MachineStatus
  /** An unsafe request waits for its sign-safe (H1). */
  readonly locked: boolean
  readonly to: SettableStatus
}

/** Why a hand change is refused, or null. A release from DO_NOT_USE is not a refusal: it asks for a technician (see `releasesDoNotUse`). */
export function statusChangeRefusal(change: StatusChange): MachineDepthRefusal | null {
  if (change.status === 'RETIRED') return machineRetired(change.assetNumber)
  if (change.locked) return lockedUnsafe(change.assetNumber)
  if (change.status === change.to) return sameStatus(change.assetNumber)
  return null
}

/** Moving a machine out of DO_NOT_USE by hand: only a technician, with a fresh code (as a sign-safe). */
export const releasesDoNotUse = (from: MachineStatus, to: SettableStatus): boolean => from === 'DO_NOT_USE' && to !== 'DO_NOT_USE'

/** The reason of a hand change: always said, a few words at least, at most a note's length. */
export function statusReasonProblems(reason: string | undefined, path = 'reason'): Issue[] {
  const text = (reason ?? '').trim()
  if (text.length < STATUS_REASON_MIN) return [{ path, message: `Say why the status changes (at least ${STATUS_REASON_MIN} characters).` }]
  if (text.length > PLANT_LIMITS.note) return [{ path, message: `At most ${PLANT_LIMITS.note} characters.` }]
  return []
}
