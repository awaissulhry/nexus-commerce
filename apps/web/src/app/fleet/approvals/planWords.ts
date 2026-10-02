/**
 * MCP full control C9 — the change-plan card's words and its one counted button (section 05 §3.1): one summary
 * sentence (Nexus wrote it), one tick per KIND of consequence, a table of steps a person may filter and untick, and
 * ONE button — "Approve N changes" when every kind is ticked and every step kept; "Make a plan of the N ticked
 * changes" when steps were unticked (the API re-checks the smaller plan, which is then approved the same way).
 * Pure: PlanCard.tsx renders it; the API (change-plan.service.ts) decides.
 */
import { plainValue } from './approval-words'

/** One kind of consequence: every step of one tool (the API's PlanKind). */
export interface PlanKind {
  tool: string
  title: string
  count: number
  outbound: boolean
  reversibility: string
}

/** One step as GET /api/agent/fleet/approvals/:id/plan returns it. */
export interface PlanStep {
  step: number
  tool: string
  title: string
  status: string
  reason: string | null
  changeId: string | null
  undoesChangeId: string | null
  outbound: boolean
  preview?: unknown
  previewHidden?: string
}

export interface PlanDetail {
  approvalId: string
  status: string
  title: string
  summary: string | null
  planHash: string | null
  kinds: PlanKind[]
  steps: number
  byStatus: Record<string, number>
  list: PlanStep[]
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The sentence beside a kind's tick: how many, what, where it lands, whether it can be put back. */
export function kindSentence(kind: PlanKind): string {
  const one = kind.count === 1
  const where = kind.outbound ? `${one ? 'reaches' : 'reach'} a marketplace or a buyer` : `${one ? 'stays' : 'stay'} in Nexus`
  const back = kind.reversibility === 'none' ? 'cannot be undone' : kind.reversibility === 'partial' ? 'can be partly undone' : 'can be undone'
  return `${kind.count} × ${kind.title} — ${where}; ${back}`
}

export interface PlanButton {
  label: string
  /** approve: the plan as it is; amend: a smaller plan of the ticked steps first. */
  action: 'approve' | 'amend'
  disabled: boolean
  /** Why it waits, when it does. */
  waiting: string | null
}

/** The one counted button, from what the person ticked. */
export function planButton(input: { total: number; kept: number; kinds: PlanKind[]; ticked: ReadonlySet<string>; busy: boolean }): PlanButton {
  if (input.kept < input.total) {
    if (input.kept === 0) {
      return { label: 'Make a plan of the 0 ticked changes', action: 'amend', disabled: true, waiting: 'Keep at least one change, or reject the plan.' }
    }
    return { label: `Make a plan of the ${plural(input.kept, 'ticked change')}`, action: 'amend', disabled: input.busy, waiting: null }
  }
  const missing = input.kinds.filter((kind) => !input.ticked.has(kind.tool)).length
  return {
    label: `Approve ${plural(input.total, 'change')}`,
    action: 'approve',
    disabled: input.busy || missing > 0,
    waiting: missing > 0 ? `Tick each kind of change above to approve: ${missing} not ticked yet.` : null,
  }
}

/** A value in words (the generic card's plainValue), never raw JSON; an empty list is "(none)". */
const shown = (value: unknown) => (Array.isArray(value) && value.length === 0 ? '(none)' : plainValue(value))

/** One step in one line: what it touches and what it changes, from the preview the reader may see. */
export function stepWhat(step: PlanStep): string {
  if (step.preview == null) return step.previewHidden ?? '—'
  const preview = step.preview as { sku?: unknown; changes?: Record<string, { from?: unknown; to?: unknown }>; effect?: unknown }
  const changes = preview.changes && typeof preview.changes === 'object' ? Object.entries(preview.changes) : []
  if (changes.length) {
    const what = changes.slice(0, 2).map(([field, c]) => `${field}: ${shown(c?.from)} → ${shown(c?.to)}`).join('; ')
    const more = changes.length > 2 ? `; and ${changes.length - 2} more` : ''
    return `${typeof preview.sku === 'string' ? `${preview.sku} · ` : ''}${what}${more}`
  }
  if (typeof preview.effect === 'string') return preview.effect
  return step.title
}

/** The table's filter: the step number, the change, what it touches; any case. */
export function stepMatches(step: PlanStep, filter: string): boolean {
  const needle = filter.trim().toLowerCase()
  if (!needle) return true
  return [String(step.step), step.tool, step.title, stepWhat(step), step.status].some((text) => text.toLowerCase().includes(needle))
}

/**
 * The step list is ONE tab stop (the 2026-10-02 browser check: a grid of steps took Tab through every cell, and the
 * counted button was out of reach). The arrow keys move between the steps' Keep ticks, Home and End to the ends; no
 * wrap. Null: not a key the list moves on (Tab, Space and the rest keep their own meaning).
 */
export function rovingTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null
  const last = count - 1
  const at = Math.min(Math.max(index, 0), last)
  switch (key) {
    case 'ArrowDown': return Math.min(at + 1, last)
    case 'ArrowUp': return Math.max(at - 1, 0)
    case 'Home': return 0
    case 'End': return last
    default: return null
  }
}

/** A step's fate, in words (after it ran). */
export const STEP_STATUS: Record<string, string> = {
  pending: 'To run',
  executing: 'Running',
  done: 'Done',
  skipped: 'Skipped',
  failed: 'Failed',
}
