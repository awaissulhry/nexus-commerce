import type { Issue } from '../../core/errors'
import { depthRefusal, type DepthRefusal } from '../requests/refusals'

/**
 * The one-screen close and the line lead's confirmation (B-W2b-96; QHS-190, QHS-180; design floor.machine "Close on one
 * screen": "Action tiles (adjusted, replaced part, cleaned, other), failure code tiles, time from acknowledgement to close
 * (auto), before and after photos"; plant.jobs "Hand-back": "what was done · failure code · time (automatic from start to
 * done) · machine after", "Line lead confirms"). Pure.
 *
 *   hand back   what was done (an action tile, or words, or both), the failure code (a tile, optional until the code list
 *               of QHS-188), the machine after; the minutes are the API's: from the job's start to the hand-back (never
 *               typed, never summed per person: Statuto art. 4). Taking the work back clears them with the hand-back.
 *   confirm     the line lead (floor.lead on the floor, a triager in the office) confirms the machine works, once, while the
 *               job is HANDED_BACK (before the office closes it).
 */

export const HAND_BACK_ACTIONS = [
  { code: 'ADJUSTED', labelEn: 'Adjusted', labelIt: 'Regolata' },
  { code: 'REPLACED_PART', labelEn: 'Replaced a part', labelIt: 'Sostituito un pezzo' },
  { code: 'CLEANED', labelEn: 'Cleaned', labelIt: 'Pulita' },
  { code: 'OTHER', labelEn: 'Other', labelIt: 'Altro' },
] as const
export type HandBackAction = (typeof HAND_BACK_ACTIONS)[number]['code']
export const HAND_BACK_ACTION_CODES = HAND_BACK_ACTIONS.map((action) => action.code) as unknown as readonly [HandBackAction, ...HandBackAction[]]

/** The failure code tiles until QHS-188's list (the database takes any code of this shape). */
export const FAILURE_CODES = [
  { code: 'LOOSE_PART', labelEn: 'Loose part', labelIt: 'Pezzo allentato' },
  { code: 'WORN_PART', labelEn: 'Worn part', labelIt: 'Pezzo usurato' },
  { code: 'BROKEN_PART', labelEn: 'Broken part', labelIt: 'Pezzo rotto' },
  { code: 'ELECTRICAL', labelEn: 'Electrical fault', labelIt: 'Guasto elettrico' },
  { code: 'LUBRICATION', labelEn: 'Lubrication', labelIt: 'Lubrificazione' },
  { code: 'SETTINGS', labelEn: 'Settings', labelIt: 'Regolazioni' },
  { code: 'WRONG_USE', labelEn: 'Wrong use', labelIt: 'Uso non corretto' },
  { code: 'OTHER', labelEn: 'Other', labelIt: 'Altro' },
] as const

/** A failure code (the guard's pattern, at most 40 characters). */
export const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,39}$/
/** The most minutes a job may count (the guard's: one year). */
export const MAX_MINUTES = 525_600
export const CLOSE_LIMITS = Object.freeze({ workDone: 2000 })

/** The minutes from the job's start to the hand-back (0 when it never started: the hand-back starts nothing). */
export function minutesSpentOf(startedAt: Date | null, handedBackAt: Date): number {
  if (startedAt === null) return 0
  return Math.min(MAX_MINUTES, Math.max(0, Math.floor((handedBackAt.getTime() - startedAt.getTime()) / 60_000)))
}

/** What was done in words: the action tile's words, then the technician's words. */
export function workDoneOf(action: HandBackAction | undefined, words: string | undefined): string | null {
  const tile = action && action !== 'OTHER' ? HAND_BACK_ACTIONS.find((entry) => entry.code === action)!.labelEn : null
  const typed = words?.trim() || null
  const parts = [tile, typed].filter((part): part is string => part !== null)
  return parts.length === 0 ? null : parts.join(': ').slice(0, CLOSE_LIMITS.workDone)
}

/** The hand-back's own problems (paths without `body/`): what was done is named; a failure code of the right shape. */
export function handBackProblems(input: { readonly action?: HandBackAction | undefined; readonly workDone?: string | undefined; readonly failureCode?: string | null | undefined }): Issue[] {
  const problems: Issue[] = []
  if (workDoneOf(input.action, input.workDone) === null || (input.action === 'OTHER' && !input.workDone?.trim())) {
    problems.push({ path: 'workDone', message: input.action === 'OTHER' ? 'Say what was done.' : 'Pick what was done, or say it.' })
  }
  if (input.failureCode !== undefined && input.failureCode !== null && !FAILURE_CODE.test(input.failureCode)) {
    problems.push({ path: 'failureCode', message: 'A failure code is upper-case letters, digits and underscores, from a letter (LOOSE_PART).' })
  }
  return problems
}

/** Why the line lead may not confirm the job now, or null. */
export function leadConfirmRefusal(job: { readonly number: string; readonly status: string; readonly leadConfirmedAt: Date | null }): DepthRefusal | null {
  if (job.leadConfirmedAt !== null) return depthRefusal('LEAD_CONFIRMED', `The line lead confirmed job ${job.number} already.`, 'Read it again.')
  if (job.status !== 'HANDED_BACK') {
    return depthRefusal('NOT_HANDED_BACK', `Job ${job.number} is ${job.status.toLowerCase().replace('_', ' ')}: the line lead confirms the machine once it is handed back, before the office closes the job.`, job.status === 'CLOSED' ? 'Read it again.' : 'Confirm once the technician has handed the machine back.')
  }
  return null
}

/** What the close screen shows before the hand-back: the minutes so far, and why "Hand back running" is held, if it is. */
export function closeFacts(input: { readonly status: string; readonly startedAt: Date | null; readonly locked: boolean }, now: Date): { readonly minutesSoFar: number | null; readonly runningHeld: boolean; readonly canHandBack: boolean } {
  return {
    minutesSoFar: input.startedAt ? minutesSpentOf(input.startedAt, now) : null,
    runningHeld: input.locked,
    canHandBack: input.status === 'IN_PROGRESS',
  }
}

/** A file added to a job that is closed or cancelled: refused. */
export function filesClosed(number: string, status: string): DepthRefusal {
  return depthRefusal('FILES_CLOSED', `Job ${number} is ${status.toLowerCase()}: it takes no more photos or voice notes.`, 'Add them to the machine’s new request or job.')
}

/** A file added to a request that is merged or closed: refused. */
export function requestFilesClosed(status: string): DepthRefusal {
  return depthRefusal('FILES_CLOSED', `This request is ${status === 'MERGED' ? 'merged into another' : 'closed'}: it takes no more photos or voice notes.`, status === 'MERGED' ? 'Add them to the request it was merged into, or to its job.' : 'Report a new problem if the machine still has it.')
}
