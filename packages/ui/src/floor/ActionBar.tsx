'use client'

/**
 * FloorActionBar — the big action bar at the bottom of a floor screen (gap G5, SCR-090): one to three actions, the
 * main one LAST, so it always sits bottom right, under the thumb (A2 §3.1 "One job per screen": the same action
 * always in the same place).
 *
 *   <FloorActionBar
 *     start={<span>12 / 40</span>}
 *     actions={[
 *       { label: 'Pausa', icon: <Pause />, onPress: pause },
 *       { label: 'Scarto', icon: <Trash2 />, onPress: scrap, variant: 'warning' },
 *       { label: 'Fine', icon: <Check />, onPress: finish, variant: 'success' },
 *     ]}
 *   />
 *
 * - The type allows one, two or three actions, no more.
 * - Every action is the main-action height (`--nds-density-control-h-primary`, 64 px on the floor tier) with 8 mm
 *   between them; the main one is wider. When they do not fit they wrap, the main one last; in a phone-wide
 *   `FloorFrame` the main action takes its own full row at the bottom.
 * - `start`: a short status at the other end (a count, the step) — not another action.
 * - Held actions (`heldReason`) stay focusable and say why; show the reason on screen too.
 */
import type { ReactNode } from 'react'

import { FloorButton, type FloorButtonVariant } from './FloorButton'
import './floor.css'

export interface FloorAction {
  label: string
  icon?: ReactNode
  onPress: () => void
  /** Default: `primary` for the main (last) action, `secondary` for the others. */
  variant?: FloorButtonVariant
  heldReason?: string | null
  /** A stable key when labels can repeat. */
  id?: string
}

/** One, two or three actions; the last is the main one. */
export type FloorActions =
  | readonly [FloorAction]
  | readonly [FloorAction, FloorAction]
  | readonly [FloorAction, FloorAction, FloorAction]

export interface FloorActionBarProps {
  actions: FloorActions
  /** The group's name for a screen reader. */
  label?: string
  /** A short status at the start side. */
  start?: ReactNode
}

export function FloorActionBar({ actions, label, start }: FloorActionBarProps) {
  const main = actions.length - 1
  return (
    <div className="nds-floor-actionbar" role="group" aria-label={label}>
      {start ? <div className="nds-floor-actionbar-start">{start}</div> : null}
      <div className="nds-floor-actionbar-actions">
        {actions.map((a, i) => (
          <FloorButton
            key={a.id ?? a.label}
            size="lg"
            variant={a.variant ?? (i === main ? 'primary' : 'secondary')}
            icon={a.icon}
            heldReason={a.heldReason}
            onClick={a.onPress}
            className={i === main ? 'is-main' : undefined}
          >
            {a.label}
          </FloorButton>
        ))}
      </div>
    </div>
  )
}
