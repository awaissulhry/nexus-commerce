/**
 * R16 (MCP full control, decision D-R2) — what decides an engine, in words: the server setting (the outer limit, the
 * Owner's) and this business's own switch under it. The engine drawer shows both side by side, so "why is this off?"
 * never needs a log. Pure: the drawer renders these lines with the design system's KeyValue.
 *
 * CR rebuild 2: the Control Room's one level scale (levelWords.ts), plain words instead of the server's variable names
 * (those stay in the drawer's Technical details), and BOTH directions ask first — turning a brake such as Budget
 * enforcement down used to be one click with no question (report 7 §5).
 */
import type { ActionImpact } from '@/design-system/grid/actions/registry'
import { LEVEL_WORD, levelRank, type Level } from './levelWords'

export type LeverMode = Level

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

const LABEL = LEVEL_WORD

const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })

/** Who set it, in words: 'user:<id>' is a person in Nexus (or Claude's change a person approved). */
const who = (setBy: string) => (setBy.startsWith('user:') ? 'a person' : setBy)

/** What decides the engine. "In force" is not repeated here: the drawer says it once, at the top ("May do now"). */
export function leverControlLines(control: LeverControl | undefined): ControlLine[] {
  if (!control) return []
  const lines: ControlLine[] = [{ label: 'The server allows', value: LABEL[control.env.mode], hint: 'Set on the server. Only a deploy changes it.' }]
  if (!control.switchable) {
    lines.push({ label: 'This business', value: 'No level of its own', hint: 'Only the server decides this engine.' })
  } else if (!control.switch) {
    lines.push({ label: 'This business set', value: 'Not set', hint: 'The server’s level applies.' })
  } else {
    const s = control.switch
    lines.push({
      label: 'This business set',
      value: LABEL[s.mode],
      hint: `By ${who(s.setBy)} on ${day(s.setAt)}${s.reason ? ` — ${s.reason}` : ''}. Never above the server setting.`,
    })
  }
  return lines
}

// ── R16 — the switch a person moves in the drawer ──────────────────────────────────────────────────────


const rank = levelRank

/**
 * Where this business's switch is set: its row, or (no row) open as far as its top level — the env decides. Never what
 * the control SHOWS, nor what a confirmation says a move starts from: both are `effectiveSwitch`, the level in force.
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

/** Which way a move goes. Both ways ask first; only up needs the tick and the server's `confirm: true`. */
export function switchMove(from: LeverMode, to: LeverMode): 'down' | 'up' | 'same' {
  return rank(to) < rank(from) ? 'down' : rank(to) > rank(from) ? 'up' : 'same'
}

/** The confirmation for turning an engine up (ActionConfirm). Only Auto changes the ads, so only Auto needs the tick. */
export function raiseImpact(engineName: string, from: LeverMode, to: LeverMode): ActionImpact {
  const consequences = [
    `${engineName} goes from ${LABEL[from]} to ${LABEL[to]} from its next run, in this business only.`,
    to === 'AUTO' ? 'At Auto it changes your ads by itself, inside your limits.' : 'It records what it would change. It changes nothing by itself.',
    'The server setting still caps it, and the account level and Stop now still apply.',
  ]
  const reversal = { verb: `Set it back to ${LABEL[from]}`, fidelity: to === 'AUTO' ? 'lossy' as const : 'exact' as const }
  return to === 'AUTO'
    ? {
      level: 'confirm', title: `Raise ${engineName} to Auto for this business?`, consequences, reach: 'channel', reversal,
      acknowledge: 'I understand it changes my ads by itself from its next run, and what it changes stays changed.',
      confirmLabel: 'Raise to Auto',
    }
    : { level: 'confirm', title: `Raise ${engineName} to ${LABEL[to]} for this business?`, consequences, reach: 'local', reversal, confirmLabel: `Raise to ${LABEL[to]}` }
}

/** The confirmation for turning an engine down: a plain question, no tick — a brake stays one confirm away. */
export function lowerImpact(engineName: string, from: LeverMode, to: LeverMode): ActionImpact {
  return {
    level: 'confirm',
    title: `Lower ${engineName} to ${LABEL[to]} for this business?`,
    consequences: [
      `${engineName} goes from ${LABEL[from]} to ${LABEL[to]} from its next run, in this business only.`,
      to === 'OFF'
        ? 'It stops running. Whatever it protects — a budget, a bid floor — is no longer protected by it.'
        : 'It stops changing your ads by itself.',
      'What it changed before stays as it is.',
    ],
    reach: 'local',
    reversal: { verb: `Set it back to ${LABEL[from]}`, fidelity: 'exact' },
    confirmLabel: `Lower to ${LABEL[to]}`,
  }
}

/** The drawer's switch, as states and events: what to show (an open confirmation) and what to send. */
export interface SwitchState { pending: { impact: ActionImpact; to: LeverMode; up: boolean } | null }
export type SwitchEvent =
  | { type: 'choose'; to: LeverMode; engineName: string; control: LeverControl }
  | { type: 'cancel' }
  | { type: 'confirm' }

/** A move opens its confirmation; it is sent only once confirmed. Cancel: nothing is sent. */
export function switchStep(state: SwitchState, event: SwitchEvent): { state: SwitchState; send: { to: LeverMode; confirm: boolean } | null } {
  if (event.type === 'cancel') return { state: { pending: null }, send: null }
  if (event.type === 'confirm') return { state: { pending: null }, send: state.pending ? { to: state.pending.to, confirm: state.pending.up } : null }
  const from = effectiveSwitch(event.control)
  const move = switchMove(from, event.to)
  if (move === 'same') return { state, send: null }
  const up = move === 'up'
  const impact = up ? raiseImpact(event.engineName, from, event.to) : lowerImpact(event.engineName, from, event.to)
  return { state: { pending: { impact, to: event.to, up } }, send: null }
}

/**
 * The confirmation before Run now. It runs the schedule's own work once, now — and for an engine that changes the ads,
 * that is a change to the ads, so it asks with the tick. Before, Run now ran on the first click (report 7 §2.4).
 */
export function runNowImpact(engineName: string): ActionImpact {
  return {
    level: 'confirm',
    title: `Run ${engineName} now?`,
    consequences: [
      'It runs the same work its schedule runs, once, now.',
      'Every change it makes still passes your limits, the account level and Stop now.',
    ],
    reach: 'channel',
    reversal: { verb: 'Undo its changes in History', fidelity: 'lossy' },
    acknowledge: 'I understand it may change my ads now.',
    confirmLabel: 'Run now',
  }
}
