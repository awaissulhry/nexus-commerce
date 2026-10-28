/**
 * The words and rules of `modeColumn` (bid page DS lane, 2026-10-10) — pure, tested in Node.
 *
 * A mode is ONE step on an ordered scale: Off · Watch · Ask me · Auto by default (the Owner's words for what an
 * automation may do). A row can hold two facts: the step a person SET, and the step that ACTS today. They differ when
 * something above the row holds it lower (an account dial, a cap, an allowlist, another owner); the cell then shows a
 * small "held" mark whose accessible name says what acts and why. Picking a step only reaches the host's draft
 * (`context.current.onMode`); nothing here writes.
 */

/** One step of the scale. `value` is what the host stores ('OFF'); `label` is what a person reads ('Off'). */
export interface ModeStep { value: string; label: string; note?: string }

/** The default scale, lowest first: the order decides "lower". */
export const MODE_STEPS: readonly ModeStep[] = [
  { value: 'OFF', label: 'Off' },
  { value: 'WATCH', label: 'Watch' },
  { value: 'ASK', label: 'Ask me' },
  { value: 'AUTO', label: 'Auto' },
]

/** What holds a row below its set step: `label` names it ("the account dial", "Brain owns this campaign"). */
export interface ModeHold { kind?: string; label: string }

/** A cell value: the set step alone, or the set step with the acting one and what holds it. */
export type ModeCellValue = string | { set: string; acts?: string | null; heldBy?: ModeHold | null } | null | undefined

export interface ModeReading {
  set: string | null
  /** The step that acts today; equal to `set` when nothing holds it. */
  acts: string | null
  heldBy: ModeHold | null
}

/** Reads either shape; an unknown or empty value reads as no step at all (never as Off). */
export function readMode(value: ModeCellValue): ModeReading {
  if (typeof value === 'string') return { set: value || null, acts: value || null, heldBy: null }
  if (!value || typeof value !== 'object') return { set: null, acts: null, heldBy: null }
  const set = typeof value.set === 'string' && value.set ? value.set : null
  const acts = typeof value.acts === 'string' && value.acts ? value.acts : set
  return { set, acts, heldBy: value.heldBy && typeof value.heldBy.label === 'string' ? value.heldBy : null }
}

/** The step's place on the scale; -1 when it is not on it. */
export const modeIndex = (steps: readonly ModeStep[], value: string | null | undefined): number =>
  value == null ? -1 : steps.findIndex((s) => s.value === value)

/** What a person reads; an unknown stored value is shown as it is rather than hidden. */
export function modeWord(steps: readonly ModeStep[], value: string | null | undefined): string {
  if (value == null || value === '') return ''
  return steps.find((s) => s.value === value)?.label ?? value
}

/** True when the acting step is LOWER than the set one — the only case the held mark is drawn. */
export function isModeHeld(steps: readonly ModeStep[], reading: ModeReading): boolean {
  const set = modeIndex(steps, reading.set)
  const acts = modeIndex(steps, reading.acts)
  return set >= 0 && acts >= 0 && acts < set
}

/** The held mark's accessible name and tooltip: "Acts as Ask me: held by the account dial". */
export function modeHeldSentence(steps: readonly ModeStep[], reading: ModeReading): string | null {
  if (!isModeHeld(steps, reading)) return null
  const acts = modeWord(steps, reading.acts)
  return reading.heldBy?.label ? `Acts as ${acts}: held by ${reading.heldBy.label}` : `Acts as ${acts}`
}

/**
 * The meter: one bar per step above the lowest (Off draws none). A bar is `on` up to the acting step, `held` between the
 * acting step and the set one (set higher, held lower), and `off` above.
 */
export type ModeBar = 'on' | 'held' | 'off'
export function modeBars(steps: readonly ModeStep[], reading: ModeReading): ModeBar[] {
  const set = modeIndex(steps, reading.set)
  const actsAt = modeIndex(steps, reading.acts)
  const acts = actsAt < 0 ? set : actsAt
  return steps.slice(1).map((_, i) => {
    const at = i + 1
    if (at <= acts) return 'on'
    if (at <= set) return 'held'
    return 'off'
  })
}

/**
 * The cell's one sentence for the column tooltip, the CSV-free screen-reader line and the catalog:
 * "Ask me", "Auto · acts as Ask me: held by the account dial", "Watch · locked: Needs the ads permission".
 */
export function modeCellText(steps: readonly ModeStep[], reading: ModeReading, lockReason?: string | null): string {
  const parts = [modeWord(steps, reading.set) || 'Not set']
  const held = modeHeldSentence(steps, reading)
  if (held) parts.push(held.charAt(0).toLowerCase() + held.slice(1))
  if (lockReason) parts.push(`locked: ${lockReason}`)
  return parts.join(' · ')
}

export interface ModeOption { value: string; label: string; heldReason?: string; note?: string }

/**
 * The list the picker opens on: every step, in order. A step the row cannot take is HELD (reachable, announced, never
 * picked) with its reason as the visible line under it; the set step carries the held sentence when it does not act.
 */
export function modeOptions(
  steps: readonly ModeStep[],
  reading: ModeReading,
  heldOption?: (value: string) => string | null | undefined,
): ModeOption[] {
  const heldSentence = modeHeldSentence(steps, reading)
  return steps.map((s) => {
    const heldReason = heldOption?.(s.value) || undefined
    const note = heldReason ?? (s.value === reading.set && heldSentence ? heldSentence : s.note)
    return { value: s.value, label: s.label, ...(heldReason ? { heldReason } : {}), ...(note ? { note } : {}) }
  })
}

/** Sort by the scale (unknown values last), so a sorted column reads Off → Auto. */
export function compareModes(steps: readonly ModeStep[], a: ModeCellValue, b: ModeCellValue): number {
  const rank = (v: ModeCellValue) => {
    const i = modeIndex(steps, readMode(v).set)
    return i < 0 ? steps.length : i
  }
  return rank(a) - rank(b)
}

interface KeyLike { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }
const isSpace = (e: KeyLike) => (e.key === ' ' || e.key === 'Spacebar') && !e.ctrlKey && !e.metaKey && !e.altKey

/**
 * The column's `suppressKeyboardEvent`: Space belongs to the cell (it opens the list), never to AG — AG would tick the
 * row. Enter, arrows, Tab and Escape stay AG's (Enter opens the editor of an editable cell). Never while editing.
 */
export function suppressModeKeys({ event, editing }: { event: KeyLike; editing?: boolean }): boolean {
  return !editing && isSpace(event)
}

/** The cell's own key: Space opens the list; on a locked cell Space and Enter show why. Only for a key ON the cell. */
export function modeCellKey(
  event: KeyLike & { target: unknown; repeat?: boolean },
  cell: unknown,
  locked: boolean,
): 'open' | 'explain' | null {
  if (event.target !== cell || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return null
  if (locked) return isSpace(event) || event.key === 'Enter' ? 'explain' : null
  return isSpace(event) ? 'open' : null
}
