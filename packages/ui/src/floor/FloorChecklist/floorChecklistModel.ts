/**
 * FloorChecklist's rules (B-W2b-78, design part FloorChecklist): grouped pass / fail checks on a floor tablet — the
 * final inspection's four groups, first piece, cutting, incoming components, an operation's steps, a machine job.
 *
 * - **An answer** is pass or fail. A fail carries the reason the person picked (and a photo when asked). Every item is
 *   required unless the app says `required: false`.
 * - **A group** is `failed` when one of its checks failed, `open` when nothing is answered, `passed` when every required
 *   check is answered, else `partly`. It is done when every required check is answered (a failed one counts: the
 *   inspection may still be signed as failed).
 * - **Group passes** (one tap after looking): every check of the group not answered yet passes — never a failed one,
 *   never a held one.
 * - **The main action is held** until every required check is answered, with what is left in words ("2 required checks
 *   left: Care label, CE mark"). A checklist with no checks is held too.
 */

export type ChecklistResult = 'pass' | 'fail'
export type ChecklistGroupState = 'open' | 'partly' | 'passed' | 'failed'

export interface ChecklistAnswerInput {
  result: ChecklistResult
}

export type ChecklistAnswers = Readonly<Record<string, ChecklistAnswerInput | undefined>>

export interface ChecklistItemInput {
  id: string
  label: string
  /** Default true. */
  required?: boolean
  heldReason?: string | null
}

export interface ChecklistGroupInput {
  id: string
  items: readonly ChecklistItemInput[]
}

export const isRequired = (item: Pick<ChecklistItemInput, 'required'>): boolean => item.required !== false

export function groupState(group: ChecklistGroupInput, answers: ChecklistAnswers): ChecklistGroupState {
  const given = group.items.map((item) => answers[item.id]).filter((a): a is ChecklistAnswerInput => a !== undefined)
  if (given.some((a) => a.result === 'fail')) return 'failed'
  if (given.length === 0) return 'open'
  return groupDone(group, answers) ? 'passed' : 'partly'
}

/** Every required check of the group is answered. */
export const groupDone = (group: ChecklistGroupInput, answers: ChecklistAnswers): boolean => group.items.every((item) => !isRequired(item) || answers[item.id] !== undefined)

/** What "Group passes" passes: the checks not answered yet that are not held. */
export const groupPassIds = (group: ChecklistGroupInput, answers: ChecklistAnswers): string[] =>
  group.items.filter((item) => answers[item.id] === undefined && !item.heldReason?.trim()).map((item) => item.id)

export interface ChecklistProgress {
  groups: number
  groupsDone: number
  /** Checks answered, of all checks. */
  answered: number
  total: number
  passed: number
  failed: number
  /** The required checks not answered yet, in the list's order. */
  requiredLeft: ChecklistItemInput[]
}

export function checklistProgress(groups: readonly ChecklistGroupInput[], answers: ChecklistAnswers): ChecklistProgress {
  const items = groups.flatMap((g) => g.items)
  const given = items.map((item) => answers[item.id])
  return {
    groups: groups.length,
    groupsDone: groups.filter((g) => groupDone(g, answers)).length,
    answered: given.filter((a) => a !== undefined).length,
    total: items.length,
    passed: given.filter((a) => a?.result === 'pass').length,
    failed: given.filter((a) => a?.result === 'fail').length,
    requiredLeft: items.filter((item) => isRequired(item) && answers[item.id] === undefined),
  }
}

export interface FloorChecklistWords {
  /** "2 required checks left: Care label, CE mark". */
  left: (count: number, names: readonly string[]) => string
  /** A checklist with nothing to check (never a free pass). */
  none: string
}

/** Why the main action is held, or null when every required check is answered. */
export function checklistHeld(groups: readonly ChecklistGroupInput[], answers: ChecklistAnswers, words: FloorChecklistWords): string | null {
  const p = checklistProgress(groups, answers)
  if (p.total === 0) return words.none
  return p.requiredLeft.length ? words.left(p.requiredLeft.length, p.requiredLeft.map((item) => item.label)) : null
}

/** The next group after `fromId` (wrapping) that is not done, or null when every group is done. */
export function nextOpenGroup(groups: readonly ChecklistGroupInput[], answers: ChecklistAnswers, fromId?: string): string | null {
  const start = Math.max(0, groups.findIndex((g) => g.id === fromId))
  for (let step = 1; step <= groups.length; step++) {
    const group = groups[(start + step) % groups.length]!
    if (!groupDone(group, answers)) return group.id
  }
  return null
}

/** Answers after "Group passes" (for an app that keeps them in memory). */
export function withGroupPassed<A extends ChecklistAnswerInput>(group: ChecklistGroupInput, answers: Readonly<Record<string, A | undefined>>, pass: () => NoInfer<A>): Record<string, A | undefined> {
  const next: Record<string, A | undefined> = { ...answers }
  for (const id of groupPassIds(group, answers)) next[id] = pass()
  return next
}
