/**
 * The rules of `CheckList` (B-W2b-09; the design's CheckList / ReadinessChecklist: B-W2a-28, -46, -51, -58, -64, -67,
 * -72, -77 composed one each) — pure, tested in Node.
 *
 * Named checks before an action, each with a state, the reason in words and where to fix it. A check holds the action
 * when its state blocks: `fail` (open), `checking` (being run again — never "passed" before it is known) and `unknown`
 * (it could not be checked) block; `pass`, `warning` and `skipped` do not. A check may say otherwise with `blocks`
 * (a warning the site treats as blocking; an unknown the app accepts). The action's primary button is HELD with the
 * count and the names of the open checks ("Release · 2 checks open"), never disabled.
 */
import { CHECK_LIST_LABELS, type CheckListLabels } from './CheckListLabels'

export const CHECK_STATES = ['pass', 'warning', 'fail', 'checking', 'skipped', 'unknown'] as const
export type CheckState = (typeof CHECK_STATES)[number]

/** The states that hold the action unless a check says otherwise. */
export const BLOCKING_STATES: ReadonlySet<CheckState> = new Set<CheckState>(['fail', 'checking', 'unknown'])

export interface CheckLike {
  id: string
  state: CheckState
  /** The check's name in words, for the held reason ("Lot released"). */
  name?: string
  /** Overrides whether this check holds the action. */
  blocks?: boolean
}

export const checkBlocks = (check: CheckLike): boolean => check.blocks ?? BLOCKING_STATES.has(check.state)

export interface CheckListSummary {
  total: number
  /** Checks that hold the action. */
  open: number
  /** Checks being run again. */
  checking: number
  /** Names of the holding checks, in order (those that have one). */
  openNames: string[]
  /** Nothing holds (and there is at least one check). */
  ready: boolean
  /** The summary line: "All 7 checks pass" / "2 of 7 checks open" / "Checking again…". */
  words: string
}

export function checkListSummary(checks: readonly CheckLike[], words: CheckListLabels = CHECK_LIST_LABELS): CheckListSummary {
  const holding = checks.filter(checkBlocks)
  const checking = checks.filter((check) => check.state === 'checking').length
  const open = holding.length
  const total = checks.length
  const text = total === 0 ? words.none : checking > 0 ? words.checking : open === 0 ? words.allPass(total) : words.open(open, total)
  return {
    total,
    open,
    checking,
    openNames: holding.flatMap((check) => (check.name ? [check.name] : [])),
    ready: total > 0 && open === 0,
    words: text,
  }
}

/**
 * The action's held reason, or null when every check lets it run: "2 checks open: Lot released, Certificate valid".
 * Without names the count alone ("2 checks open: …" falls back to the count words).
 */
export function checkListHeld(checks: readonly CheckLike[], words: CheckListLabels = CHECK_LIST_LABELS): string | null {
  const summary = checkListSummary(checks, words)
  if (summary.open === 0) return null
  if (summary.checking > 0 && summary.open === summary.checking) return words.checking
  return words.held(summary.open, summary.openNames.length > 0 ? words.join(summary.openNames) : String(summary.open))
}

/** The action's primary words: "Release" when ready, "Release · 2 checks open" while checks hold it. */
export function checkListButton(action: string, checks: readonly CheckLike[], words: CheckListLabels = CHECK_LIST_LABELS): string {
  const summary = checkListSummary(checks, words)
  return summary.open === 0 ? action : words.button(action, summary.open)
}
