/**
 * owb-fl6 — the basket page's seams to the Steps window and the leader's row (design § 5zg: the step bar → the Steps window → Undo;
 * § 5zf C: Give to… · Do this first · Will be late). STUBS in owb-fl5; owb-fl6 (the same builder) makes them real.
 *
 * While `STEPS_READY` is false the step bar's "Change" and the dock's "Change the step" are not drawn (never a dead button), and the
 * leader's row draws nothing.
 */
import type { ReactElement } from 'react'
import type { BasketView } from '../model'

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

/** fl6 sets true when the Steps window is built. */
export const STEPS_READY: boolean = false

/** The Steps window of one basket (a tap on a step puts the basket there). */
export function StepsWindow(_props: StepsWindowProps): ReactElement | null {
  return null
}

/** The leader's row on the basket page: Give to… · Do this first · Will be late. */
export function LeaderRow(_props: StepsPartProps): ReactElement | null {
  return null
}
