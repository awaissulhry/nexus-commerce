'use client'

/**
 * RD.P2 — the runtime columns, rendered once and used by both grains.
 *
 * Every value here is derived server-side from the engine's own functions, so these components
 * only choose words and colour. That split matters: the moment a cell computes something, the page
 * has a second opinion about what the engine is doing, which is the defect this section removes.
 */
import type { RdCeiling, RdMode, RdModeKind } from './types'

/** Tone per mode. Capped and dangling are the two an operator must act on. */
const MODE_TONE: Record<RdModeKind, string> = {
  'dangling-target': 'bad',
  'capped-base': 'bad',
  'capped-floor': 'warn',
  'governed-elsewhere': 'warn',
  'nothing-held': 'muted',
  'not-running': 'muted',
  'min-bid': 'muted',
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

// 2e (Owner D1 = A) — GoalCell and SignalCell are gone: the engine reads no goal and no signal, so
// neither column is shown any more.

/** The CPC ceiling. Bold only when it is actually deciding, so a harmless cap stays quiet. */
export function CeilingCell({ ceiling }: { ceiling: RdCeiling | null }) {
  if (!ceiling) return <span className="rd-none" title="This target sets no CPC ceiling.">—</span>
  return (
    <span
      className={`rd-ceil ${ceiling.binding ? (ceiling.baseAlone ? 'bad' : 'warn') : 'muted'}`}
      title={ceiling.binding
        ? 'The CPC ceiling holds this placement below the value its hour sets.'
        : 'A ceiling is set but is not binding — the hour’s value holds.'}
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
