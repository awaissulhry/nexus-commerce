import type { Issue } from '../../core/errors'

/**
 * Shift handover notes (B-W2b-49; MES-033 "Lead writes notes per line for the next shift (problems, half-done bundles,
 * machine issues); shown at the next sign-in"; design floor.supervisor "Handover note", floor.signin), pure. One note per
 * line and shift (andon.prisma HandoverNote): topics and a short text; never deleted, edited with its version. Nobody's
 * reading is recorded: "new since your last shift" is worked out from the person's previous session, nothing about them
 * is stored (Statuto dei Lavoratori art. 4).
 */

export const HANDOVER_TOPICS = ['PROBLEMS', 'HALF_DONE_BUNDLES', 'MACHINES', 'MATERIAL', 'QUALITY', 'OTHER'] as const
export type HandoverTopic = (typeof HANDOVER_TOPICS)[number]

export const HANDOVER_LIMITS = Object.freeze({ text: 1000, shiftLabel: 40, listDays: 7, listNotes: 20, firstLookBackHours: 24 })

export const HANDOVER_LOOK: Readonly<Record<HandoverTopic, { readonly icon: string; readonly tone: 'danger' | 'warning' | 'info' | 'neutral'; readonly labelIt: string; readonly labelEn: string }>> = Object.freeze({
  PROBLEMS: { icon: 'alert-triangle', tone: 'danger', labelIt: 'Problemi', labelEn: 'Problems' },
  HALF_DONE_BUNDLES: { icon: 'layers', tone: 'warning', labelIt: 'Mazzi a metà', labelEn: 'Half-done bundles' },
  MACHINES: { icon: 'wrench', tone: 'warning', labelIt: 'Macchine', labelEn: 'Machines' },
  MATERIAL: { icon: 'package', tone: 'info', labelIt: 'Materiale', labelEn: 'Material' },
  QUALITY: { icon: 'shield-check', tone: 'info', labelIt: 'Qualità', labelEn: 'Quality' },
  OTHER: { icon: 'message-square', tone: 'neutral', labelIt: 'Altro', labelEn: 'Other' },
})

export function handoverProblems(input: { readonly topics: readonly string[]; readonly text?: string | null | undefined; readonly shiftLabel?: string | null | undefined }): Issue[] {
  const issues: Issue[] = []
  const text = input.text?.trim() ?? ''
  if (input.topics.length === 0 && text === '') issues.push({ path: 'topics', message: 'Pick a topic or write a few words.' })
  if (new Set(input.topics).size !== input.topics.length) issues.push({ path: 'topics', message: 'Each topic once.' })
  if (text.length > HANDOVER_LIMITS.text) issues.push({ path: 'text', message: `At most ${HANDOVER_LIMITS.text} characters.` })
  if (input.shiftLabel !== undefined && input.shiftLabel !== null && (input.shiftLabel.trim() === '' || input.shiftLabel.trim().length > HANDOVER_LIMITS.shiftLabel)) issues.push({ path: 'shiftLabel', message: `Name the shift, in at most ${HANDOVER_LIMITS.shiftLabel} characters.` })
  return issues
}

export interface ShiftOfDay {
  readonly label: string | null
  readonly start: Date
  readonly end: Date
}

/** The day's words for a shift when its pattern has none. */
const labelOf = (shifts: readonly ShiftOfDay[], shift: ShiftOfDay): string => shift.label?.trim() || `Shift ${shifts.indexOf(shift) + 1}`

/** The shift a note written now belongs to: the running one, else the last that began, else the first; no shift: "Day". */
export function shiftLabelAt(shifts: readonly ShiftOfDay[], now: Date): string {
  if (shifts.length === 0) return 'Day'
  const running = shifts.find((shift) => shift.start.getTime() <= now.getTime() && now.getTime() < shift.end.getTime())
  const begun = [...shifts].reverse().find((shift) => shift.start.getTime() <= now.getTime())
  return labelOf(shifts, running ?? begun ?? shifts[0]!)
}

/** Since when a note is new for someone signing in: their previous session's end, else the look-back from now. */
export function newSince(previousSession: { readonly startedAt: Date; readonly endedAt: Date | null; readonly lastSeenAt: Date } | null, now: Date): Date {
  if (!previousSession) return new Date(now.getTime() - HANDOVER_LIMITS.firstLookBackHours * 3_600_000)
  return previousSession.endedAt ?? previousSession.lastSeenAt
}
