/**
 * R16 (MCP full control, decision D-R2) — what decides an engine, in words: the server env (the outer limit, the
 * Owner's) and this business's own switch under it. The lever drawer shows both side by side, so "why is this off?"
 * never needs a log. Pure: the drawer renders these lines with the design system's KeyValue.
 */
import type { ActionImpact } from '@/design-system/grid/actions/registry'

export type LeverMode = 'OFF' | 'OBSERVE' | 'PROPOSE' | 'AUTO'

export interface LeverControl {
  env: { mode: LeverMode; reason: string }
  switch: { mode: LeverMode; setBy: string; setAt: string; reason: string | null } | null
  switchable: boolean
  /** The levels its switch can be at, lowest first. */
  levels: LeverMode[]
  /** The highest a person may turn it up to: what the server env allows. */
  ceiling: LeverMode | null
}

export interface ControlLine {
  label: string
  value: string
  hint?: string
}

const LABEL: Record<LeverMode, string> = { OFF: 'Off', OBSERVE: 'Observe', PROPOSE: 'Propose', AUTO: 'Auto' }

const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })

/** Who set it, in words: 'user:<id>' is a person in Nexus (or Claude's change a person approved). */
const who = (setBy: string) => (setBy.startsWith('user:') ? 'a person' : setBy)

export function leverControlLines(control: LeverControl | undefined, inForce: LeverMode): ControlLine[] {
  if (!control) return []
  const lines: ControlLine[] = [{ label: 'Server env allows', value: LABEL[control.env.mode], hint: control.env.reason }]
  if (!control.switchable) {
    lines.push({ label: 'This business', value: 'No switch of its own', hint: 'Only the server env switches this engine.' })
  } else if (!control.switch) {
    lines.push({ label: 'This business set', value: 'Not set', hint: 'The env alone decides. Turning it down is instant; turning it up waits for a person.' })
  } else {
    const s = control.switch
    lines.push({
      label: 'This business set',
      value: LABEL[s.mode],
      hint: `By ${who(s.setBy)} on ${day(s.setAt)}${s.reason ? ` — ${s.reason}` : ''}. Turning it up waits for a person, and never past the env.`,
    })
  }
  lines.push({ label: 'In force', value: LABEL[inForce], hint: 'The lower of the two, under the account dial.' })
  return lines
}

// ── R16 — the switch a person moves in the drawer ──────────────────────────────────────────────────────


const ORDER: LeverMode[] = ['OFF', 'OBSERVE', 'PROPOSE', 'AUTO']
const rank = (mode: LeverMode) => ORDER.indexOf(mode)

/**
 * Where this business's switch is set: its row, or (no row) open as far as its top level — the env decides. What a
 * move starts from; never what the control SHOWS (that is `effectiveSwitch`).
 */
export function currentSwitch(control: LeverControl): LeverMode {
  return control.switch?.mode ?? control.levels[control.levels.length - 1] ?? 'OFF'
}

/** The level in force: the lower of this business's switch and what the server setting allows. What the control shows. */
export function effectiveSwitch(control: LeverControl): LeverMode {
  const set = currentSwitch(control)
  const ceiling = control.ceiling ?? 'OFF'
  return rank(set) <= rank(ceiling) ? set : ceiling
}

export interface SwitchOption { value: LeverMode; label: string; disabled: boolean }

/**
 * Its own levels. The one in force is the selected one; when the server setting is what holds it there, its label says
 * so. A level above what the server setting allows is shown and cannot be picked. Never shows a level not in force.
 */
export function switchOptions(control: LeverControl): SwitchOption[] {
  const ceiling = control.ceiling ?? 'OFF'
  const inForce = effectiveSwitch(control)
  const cappedByServer = rank(currentSwitch(control)) > rank(ceiling)
  return control.levels.map((level) => {
    if (rank(level) > rank(ceiling)) return { value: level, label: `${LABEL[level]} — above what the server setting allows`, disabled: true }
    if (level === inForce && cappedByServer) return { value: level, label: `${LABEL[level]} — the server setting allows at most ${LABEL[ceiling]}`, disabled: false }
    return { value: level, label: LABEL[level], disabled: false }
  })
}

/** Down is instant; up asks first. */
export function switchMove(from: LeverMode, to: LeverMode): 'down' | 'up' | 'same' {
  return rank(to) < rank(from) ? 'down' : rank(to) > rank(from) ? 'up' : 'same'
}

/** The confirmation for turning an engine up (ActionConfirm). */
export function raiseImpact(engineName: string, from: LeverMode, to: LeverMode): ActionImpact {
  return {
    level: 'confirm',
    title: `Turn ${engineName} up to ${LABEL[to]} for this business?`,
    consequences: [
      `${engineName} goes from ${LABEL[from]} to ${LABEL[to]} from its next run, in this business only.`,
      to === 'AUTO' ? 'At Auto it writes to the marketplace by itself, inside the write gate and every guardrail.' : 'It records and proposes; it does not write.',
      'The server env still caps it, and the account dial and halt still apply.',
    ],
    reach: 'channel',
    reversal: { verb: 'Turn it down again', fidelity: 'lossy' },
    acknowledge: 'I understand it acts from its next run, and what it changes before I turn it down again stays changed.',
  }
}

/** The drawer's switch, as states and events: what to show (an open confirmation) and what to send. */
export interface SwitchState { raise: { impact: ActionImpact; to: LeverMode } | null }
export type SwitchEvent =
  | { type: 'choose'; to: LeverMode; engineName: string; control: LeverControl }
  | { type: 'cancel' }
  | { type: 'confirm' }

/** Down: send at once. Up: open the confirmation; send only once it is confirmed. Cancel: nothing is sent. */
export function switchStep(state: SwitchState, event: SwitchEvent): { state: SwitchState; send: { to: LeverMode; confirm: boolean } | null } {
  if (event.type === 'cancel') return { state: { raise: null }, send: null }
  if (event.type === 'confirm') return { state: { raise: null }, send: state.raise ? { to: state.raise.to, confirm: true } : null }
  const from = currentSwitch(event.control)
  const move = switchMove(from, event.to)
  if (move === 'down') return { state: { raise: null }, send: { to: event.to, confirm: false } }
  if (move === 'up') return { state: { raise: { impact: raiseImpact(event.engineName, from, event.to), to: event.to } }, send: null }
  return { state, send: null }
}
