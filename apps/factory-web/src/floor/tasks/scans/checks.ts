import type { Counts } from './model'
import { goodOf, reworkOf, scrapOf } from './model'

/**
 * Checks before it counts on SCR-090 (design floor.operation "Checks before it counts", "Scan what you used", "Steps in this
 * operation", pop-up "Team leader override"; MES-070, -097, -098, -102, -114): what `GET /production/guards/check` and
 * `GET /production/checklists/state` answer right after the scan, and the rules the screen applies without a call. Pure, so the
 * tests hold them. The API decides again when the report arrives: these rules only stop a mistake earlier, with a clear screen.
 */

export type RuleMode = 'FREE' | 'WARN' | 'STRICT'

export interface CheckFinding {
  readonly kind: 'QUANTITY' | 'SKIPPED_OPERATION' | 'WRONG_BUNDLE'
  readonly mode: 'WARN' | 'STRICT'
  readonly code: string
  readonly message: string
  readonly fix: string
  readonly overridable: boolean
}

export interface OverrideTile {
  readonly code: string
  readonly label: { readonly it: string; readonly en: string }
  readonly needsNote: boolean
}

export interface AskedComponent {
  readonly itemId: string
  readonly code: string
  readonly name: string
}

export interface OperationCheck {
  readonly modes: { readonly quantityGuard: RuleMode; readonly skippedOperationRule: RuleMode }
  /** The garments that reached the operation (null: nothing to say). */
  readonly expected: number | null
  readonly beyondBundle: boolean
  readonly findings: readonly CheckFinding[]
  readonly components: { readonly asked: readonly AskedComponent[]; readonly traceable: readonly (AskedComponent & { readonly asked: boolean })[] }
  readonly overrideReasons: readonly OverrideTile[]
}

/** What stops the report for a team leader (STRICT); a WARN finding lets it count. */
export const heldFindings = (check: Pick<OperationCheck, 'findings'> | null): readonly CheckFinding[] => check?.findings.filter((finding) => finding.mode === 'STRICT') ?? []
export const toldFindings = (check: Pick<OperationCheck, 'findings'> | null): readonly CheckFinding[] => check?.findings.filter((finding) => finding.mode === 'WARN') ?? []

/** A refusal or finding the screen shows on its red screen. */
export interface GuardLine {
  readonly code: string
  readonly message: string
  readonly fix: string | null
  readonly overridable: boolean
}

export const lineOf = (finding: CheckFinding): GuardLine => ({ code: finding.code, message: finding.message, fix: finding.fix, overridable: finding.overridable })

/** A team leader may lift them: every line held is overridable (a line no override lifts stops it). */
export const overridable = (lines: readonly GuardLine[]): boolean => lines.length > 0 && lines.every((line) => line.overridable)

/** The refusals of a report a team leader may override (factory-domain production/guards OVERRIDABLE_REFUSALS). */
const OVERRIDABLE = new Set(['PREVIOUS_NOT_REPORTED', 'MORE_THAN_PASSED', 'LESS_THAN_TAKEN', 'WRONG_BUNDLE'])
export const isOverridable = (code: string): boolean => OVERRIDABLE.has(code)

/** More than the operation before passed, by the site's rule (MES-097): held for a PIN, told to the team leader, or nothing. */
export function quantityRule(check: Pick<OperationCheck, 'modes' | 'expected'> | null, total: number): 'held' | 'told' | null {
  if (!check || check.expected === null || total <= check.expected) return null
  return check.modes.quantityGuard === 'STRICT' ? 'held' : check.modes.quantityGuard === 'WARN' ? 'told' : null
}

// ---- the steps of the operation (MES-102) --------------------------------------------------------------------------------------

export type StepOutcome = 'DONE' | 'NOT_APPLICABLE'

export interface OperationStepRow {
  readonly code: string
  readonly words: string
  readonly required: boolean
  readonly tick: { readonly outcome: StepOutcome; readonly at: string; readonly mine: boolean; readonly by: string | null } | null
}

export interface OperationSteps {
  readonly steps: readonly OperationStepRow[]
  /** The required steps with no tick: Finish is held until 0. */
  readonly open: number
}

export const openSteps = (steps: readonly OperationStepRow[]): number => steps.filter((step) => step.required && step.tick === null).length

/** A step ticked on this tablet (the queue sends it before the report that needs it). */
export function tickStep(list: OperationSteps, code: string, outcome: StepOutcome, at: Date, by: string | null): OperationSteps {
  const steps = list.steps.map((step) => (step.code === code ? { ...step, tick: { outcome, at: at.toISOString(), mine: true, by } } : step))
  return { steps, open: openSteps(steps) }
}

// ---- the lots scanned at the operation (MES-114) -----------------------------------------------------------------------------

export interface LotLine {
  readonly code: string
  /** The lot's item; null: scanned offline, the office checks it when the report arrives. */
  readonly itemId: string | null
  /** The garments this lot covers, said by hand on any lot but an item's last (0: not said yet); the last takes the rest. */
  readonly garments: number | null
}

/** The garments that go on from the operation carry the lots (good and rework; the scrapped ones never leave it). */
export function garmentsOn(counts: Counts, expected: number): number {
  return goodOf(counts, expected) + reworkOf(counts)
}

export const sameLot = (a: string, b: string): boolean => a.trim().toUpperCase() === b.trim().toUpperCase()

/** The row a lot scanned offline counts for: the first asked component with no lot yet. */
function rowOf(line: LotLine, asked: readonly AskedComponent[], lots: readonly LotLine[]): string | null {
  if (line.itemId) return line.itemId
  const taken = new Set(lots.filter((other) => other !== line && other.itemId).map((other) => other.itemId))
  const unknown = lots.filter((other) => !other.itemId)
  const free = asked.filter((component) => !taken.has(component.itemId))
  return free[Math.min(unknown.indexOf(line), free.length - 1)]?.itemId ?? null
}

export interface ComponentRow {
  readonly component: AskedComponent
  readonly lots: readonly (LotLine & { readonly covers: number })[]
  readonly covered: number
}

/** The asked components with their lots: an item's last lot takes the garments the others leave. */
export function componentRows(asked: readonly AskedComponent[], lots: readonly LotLine[], garments: number): readonly ComponentRow[] {
  return asked.map((component) => {
    const mine = lots.filter((line) => rowOf(line, asked, lots) === component.itemId)
    const set = mine.slice(0, -1).reduce((total, line) => total + (line.garments ?? 0), 0)
    const rows = mine.map((line, index) => ({ ...line, covers: index === mine.length - 1 ? Math.max(0, garments - set) : (line.garments ?? 0) }))
    return { component, lots: rows, covered: rows.reduce((total, line) => total + line.covers, 0) }
  })
}

/** What the report's `components` says: each lot with its garments (lots of a material that was not asked take them all). */
export function componentLines(asked: readonly AskedComponent[], lots: readonly LotLine[], garments: number): readonly { readonly code: string; readonly garments: number }[] {
  const rows = componentRows(asked, lots, garments).flatMap((row) => row.lots)
  const placed = new Set(rows.map((row) => row.code))
  const extra = lots.filter((line) => !placed.has(line.code))
  const groups = new Map<string, LotLine[]>()
  for (const line of extra) groups.set(line.itemId ?? line.code, [...(groups.get(line.itemId ?? line.code) ?? []), line])
  const others = [...groups.values()].flatMap((group) => {
    const set = group.slice(0, -1).reduce((total, line) => total + (line.garments ?? 0), 0)
    return group.map((line, index) => ({ code: line.code, garments: index === group.length - 1 ? Math.max(0, garments - set) : (line.garments ?? 0) }))
  })
  return [...rows.map((row) => ({ code: row.code, garments: row.covers })), ...others].filter((line) => line.garments > 0)
}

/** The first asked component the lots do not cover, or null. */
export function componentMissing(asked: readonly AskedComponent[], lots: readonly LotLine[], garments: number): ComponentRow | null {
  if (garments <= 0) return null
  return componentRows(asked, lots, garments).find((row) => row.covered !== garments) ?? null
}

/**
 * One more lot of an item: it is that item's last, so it takes what the others leave; the lot before it must now say how many
 * garments it covers (0: not said yet, Finish waits). A guess here would be a wrong trace on protective equipment (EN 1621).
 */
export function addLot(asked: readonly AskedComponent[], lots: readonly LotLine[], line: LotLine, garments: number): readonly LotLine[] {
  if (lots.some((other) => sameLot(other.code, line.code))) return lots
  const next = [...lots, line]
  const item = rowOf(line, asked, next)
  const before = componentRows(asked, lots, garments).find((row) => row.component.itemId === item)?.lots.at(-1)
  return before ? next.map((other) => (other.code === before.code ? { ...other, garments: 0 } : other)) : next
}

/** A lot's garments stepped by hand, from one to `most` (the item's last lot follows). */
export function stepLot(lots: readonly LotLine[], code: string, delta: 1 | -1, most: number): readonly LotLine[] {
  return lots.map((line) => (line.code === code ? { ...line, garments: Math.min(most, Math.max(1, (line.garments ?? 0) + delta)) } : line))
}

export const dropLot = (lots: readonly LotLine[], code: string): readonly LotLine[] => lots.filter((line) => line.code !== code).map((line) => ({ ...line, garments: lots.length === 2 ? null : line.garments }))

// ---- why Finish waits ----------------------------------------------------------------------------------------------------------

export type WorkHold = { readonly key: 'steps'; readonly count: number } | { readonly key: 'component'; readonly code: string; readonly covered: number; readonly garments: number } | { readonly key: 'lotCount'; readonly code: string }

/** What Finish waits for besides the counts: the required steps, the lots. Never anything for an operation without them (F3). */
export function workHold(input: { readonly steps: OperationSteps | null; readonly asked: readonly AskedComponent[]; readonly lots: readonly LotLine[]; readonly counts: Counts; readonly expected: number }): WorkHold | null {
  if (input.steps && input.steps.open > 0) return { key: 'steps', count: input.steps.open }
  const garments = garmentsOn(input.counts, input.expected)
  const missing = componentMissing(input.asked, input.lots, garments)
  if (missing) return { key: 'component', code: missing.component.code, covered: missing.covered, garments }
  const unsaid = garments > 0 ? componentRows(input.asked, input.lots, garments).flatMap((row) => row.lots.slice(0, -1)).find((line) => line.covers === 0) : undefined
  return unsaid ? { key: 'lotCount', code: unsaid.code } : null
}

/** The counts as the override's "what is being overridden" says them. */
export const overrideCounts = (counts: Counts, expected: number) => ({ good: goodOf(counts, expected), scrap: scrapOf(counts), rework: reworkOf(counts) })
