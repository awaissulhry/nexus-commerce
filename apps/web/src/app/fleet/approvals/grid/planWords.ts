/**
 * Approvals grid — a change plan's words in the request drawer (PlanSteps.tsx renders them; the API's
 * change-plan.service.ts decides). Moved here from the old card's `planWords.ts` and `approval-words.ts` (clean-up F,
 * 2026-10-05): only what the drawer uses.
 *
 *   kindSentence  one line per KIND of change: how many, what, where it lands, whether it can be put back
 *   stepWhat      one step in one line, from the preview the reader may see; never raw JSON
 *   stepMatches   the step filter
 *   rovingTarget  the step list is ONE tab stop; the arrow keys move between its Keep ticks
 *   STEP_STATUS   a step's fate in words
 */

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

/** GET /api/agent/fleet/approvals/:id/plan. */
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

/** The sentence for one kind of change: how many, what, where it lands, whether it can be put back. */
export function kindSentence(kind: PlanKind): string {
  const one = kind.count === 1
  const where = kind.outbound ? `${one ? 'reaches' : 'reach'} a marketplace or a buyer` : `${one ? 'stays' : 'stay'} in Nexus`
  const back = kind.reversibility === 'none' ? 'cannot be undone' : kind.reversibility === 'partial' ? 'can be partly undone' : 'can be undone'
  return `${kind.count} × ${kind.title} — ${where}; ${back}`
}

/**
 * A value in words, never raw JSON: a short list reads as itself, a flat object as "key: value", anything deeper is
 * counted. Nothing at all is "—".
 */
export function plainValue(value: unknown, depth = 0): string {
  if (value == null || value === '') return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (Array.isArray(value)) {
    if (value.length === 0) return '—'
    // A short list of plain values reads as itself, inside an object too; a list of objects is counted.
    const flat = value.every((item) => item == null || ['string', 'number', 'boolean'].includes(typeof item))
    if (depth > 1 || (depth > 0 && !flat)) return plural(value.length, 'item')
    const shown = value.slice(0, 3).map((item) => plainValue(item, depth + 1))
    return `${shown.join(', ')}${value.length > 3 ? ` and ${value.length - 3} more` : ''}`
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return '—'
    if (depth > 0) return plural(entries.length, 'field')
    const shown = entries.slice(0, 4).map(([key, item]) => `${key}: ${plainValue(item, depth + 1)}`)
    return `${shown.join(', ')}${entries.length > 4 ? ` and ${entries.length - 4} more` : ''}`
  }
  return '—'
}

/** A value in a step line: an empty list is "(none)". */
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

/** The step filter: the step number, the change, what it touches; any case. */
export function stepMatches(step: PlanStep, filter: string): boolean {
  const needle = filter.trim().toLowerCase()
  if (!needle) return true
  return [String(step.step), step.tool, step.title, stepWhat(step), step.status].some((text) => text.toLowerCase().includes(needle))
}

/**
 * The step list is ONE tab stop (the 2026-10-02 browser check: a grid of steps took Tab through every cell). The arrow
 * keys move between the steps' Keep ticks, Home and End to the ends; no wrap. Null: not a key the list moves on (Tab,
 * Space and the rest keep their own meaning).
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

/** A step's fate, in words. */
export const STEP_STATUS: Record<string, string> = {
  pending: 'To run',
  executing: 'Running',
  done: 'Done',
  skipped: 'Skipped',
  failed: 'Failed',
}
