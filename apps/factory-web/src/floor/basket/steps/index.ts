/**
 * owb-fl6 — the basket page's seams to the Steps window and the leader's row (design § 5zg: the step bar → the Steps window → Undo;
 * § 5zf C: Give to… · Do this first · Will be late). Made in owb-fl5 as stubs; real since owb-fl6 (the same builder).
 */
import { createElement, type ReactElement } from 'react'
import type { BasketView } from '../model'
import { LeaderRow as LeaderRowPart } from '../leader/LeaderRow'
import { StepsWindowOf } from './StepsWindow'

export interface StepsPartProps {
  readonly view: BasketView
  readonly leader: boolean
  /** Re-read the basket after a move, a route change, a flag. */
  readonly onChanged: () => void
}

export interface StepsWindowProps extends StepsPartProps {
  readonly open: boolean
  readonly onClose: () => void
}

/** The Steps window is built: the step bar's "Change" and the dock's "Change the step" are drawn. */
export const STEPS_READY: boolean = true

/** The Steps window of one basket (a tap on a step puts the basket there). */
export function StepsWindow({ view, leader, onChanged, open, onClose }: StepsWindowProps): ReactElement | null {
  return createElement(StepsWindowOf, { open, onClose, target: { kind: 'view', view }, leader, onChanged })
}

/** The leader's row on the basket page: Give to… · Do this first · Will be late. */
export function LeaderRow({ view, onChanged }: StepsPartProps): ReactElement | null {
  return createElement(LeaderRowPart, { view, onChanged })
}
