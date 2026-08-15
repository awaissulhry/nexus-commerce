'use client'

/**
 * RD.P2 — the four columns that carry the whole argument, rendered once and used by both grains.
 *
 * Every value here is derived server-side from the engine's own functions, so these components
 * only choose words and colour. That split matters: the moment a cell computes something, the page
 * has a second opinion about what the engine is doing, which is the defect this section removes.
 */
import type { RdCeiling, RdGoal, RdMode, RdModeKind, RdSignal } from './types'

/** Tone per mode. Capped and dangling are the two an operator must act on. */
const MODE_TONE: Record<RdModeKind, string> = {
  'dangling-target': 'bad',
  'capped-base': 'bad',
  'capped-floor': 'warn',
  'governed-elsewhere': 'warn',
  'nothing-held': 'muted',
  'not-running': 'muted',
  'min-bid': 'muted',
  'all-out': 'allout',
  chasing: 'ok',
  holding: 'hold',
}

export function ModeCell({ mode }: { mode: RdMode | null }) {
  if (!mode) return <span className="rd-none" title="No runtime resolved for this row yet.">—</span>
  return <span className={`rd-mode ${MODE_TONE[mode.kind]}`} title={mode.detail}>{mode.label}</span>
}

/** The group grain's mode: a spread of its members, never one collapsed word. */
export function ModeSpreadCell({ summary, mixed, members }: { summary: string; mixed: boolean; members: number }) {
  if (!summary || summary === '—') return <span className="rd-none">—</span>
  return (
    <span
      className={`rd-mode ${mixed ? 'mixed' : 'hold'}`}
      title={mixed
        ? `The ${members} campaigns in this schedule are not in the same state. Switch to the Campaigns grain to see which is which.`
        : `All ${members} campaigns in this schedule are in the same state.`}
    >
      {summary}
    </span>
  )
}

/**
 * Goal vs actual — and a DASH where the goal is not read.
 *
 * Printing a live-looking goal on a target the controller never consults is the lie the page
 * currently tells on 33 rows. There are two different reasons for it (the ceiling equals the floor,
 * or the target is all-out and ignores the goal), and the tooltip says which.
 */
export function GoalCell({ goal }: { goal: RdGoal | null }) {
  if (!goal || goal.targetPct == null) {
    return <span className="rd-none" title="This target carries no impression-share goal.">—</span>
  }
  if (!goal.live) {
    return (
      <span className="rd-goal dead" title={goal.deadReason ?? 'The controller does not read this goal.'}>
        <span className="v">—</span>
        <span className="was">goal {goal.targetPct}% not read</span>
      </span>
    )
  }
  return (
    <span className="rd-goal" title={`Chasing ${goal.targetPct}% impression share; ${goal.actualPct == null ? 'no measurement yet' : `currently ${goal.actualPct}%`}.`}>
      <b>{goal.targetPct}%</b>
      <span className="vs">vs</span>
      <span className="v">{goal.actualPct == null ? '—' : `${goal.actualPct}%`}</span>
      <span className="unit">IS</span>
    </span>
  )
}

const SIGNAL_TONE: Record<RdSignal['kind'], string> = {
  'top-is': 'ok', sqp: 'ok', 'none-by-design': 'muted',
  'no-signal': 'warn', 'no-coverage': 'bad', 'not-applicable': 'muted',
}

/**
 * Signal — named by the lane the ACTIVE target drives.
 *
 * `no signal` and `no coverage` are deliberately different states. A feed that lapsed is a cron
 * problem; ASINs that have never appeared in Brand Analytics at all are an onboarding problem, and
 * merging them sends the operator to the wrong place. Full freshness treatment — the stale chip and
 * row-count-against-norm — is P4's; this renders the value, the age and the lane.
 */
export function SignalCell({ signal }: { signal: RdSignal | null }) {
  if (!signal) return <span className="rd-none">—</span>
  return <span className={`rd-sig ${SIGNAL_TONE[signal.kind]}`} title={signal.detail || signal.label}>{signal.label}</span>
}

/** The CPC ceiling. Bold only when it is actually deciding, so a harmless cap stays quiet. */
export function CeilingCell({ ceiling }: { ceiling: RdCeiling | null }) {
  if (!ceiling) return <span className="rd-none" title="This target sets no CPC ceiling.">—</span>
  return (
    <span
      className={`rd-ceil ${ceiling.binding ? (ceiling.baseAlone ? 'bad' : 'warn') : 'muted'}`}
      title={ceiling.binding
        ? 'The CPC ceiling is deciding this placement, not the rank target.'
        : 'A ceiling is set but is not binding — the target decides.'}
    >
      {ceiling.label}
    </span>
  )
}

/** Live placement multipliers, the outcome the Placement page owns and this page only reports. */
export function PlacementCell({ p }: { p: { top: number | null; rest: number | null; product: number | null } | null }) {
  if (!p) return <span className="rd-none">—</span>
  const seg = (label: string, v: number | null) => (
    <span className={`s ${v == null ? 'off' : v === 0 ? 'zero' : ''}`} title={`${label}: ${v == null ? 'not set' : `${v}%`}`}>
      <em>{label}</em>{v == null ? '—' : `${v}%`}
    </span>
  )
  return <span className="rd-place">{seg('T', p.top)}{seg('R', p.rest)}{seg('P', p.product)}</span>
}
