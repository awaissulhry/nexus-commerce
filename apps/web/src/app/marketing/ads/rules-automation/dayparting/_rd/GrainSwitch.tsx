'use client'

/**
 * RD.P2 — the grain switch: `Schedules (16) ⇄ Campaigns (45)`.
 *
 * Decision D2, operator-approved: ONE grid, one segmented control, not two grids. Scope, filters
 * and the URL stay in one place, and the control lives in the grid's own toolbar because it selects
 * what the grid is showing — putting it above the card would separate the control from its subject.
 *
 * The DS `SegmentedControl` rather than a hand-rolled pair of buttons: it already has the
 * `role="radiogroup"` semantics and roving arrow-key selection this needs.
 */
import { SegmentedControl } from '@/design-system/primitives/SegmentedControl'
import { useRdUrlState } from './useRdUrlState'

export function GrainSwitch({ schedules, campaigns, skewMinutes }: {
  schedules: number
  campaigns: number
  /** Container-vs-database clock skew, surfaced only when it could change what a row says. */
  skewMinutes?: number | null
}) {
  const { state, set } = useRdUrlState()
  // A grain change is a view change, not a navigation — `replace`, so Back leaves the page rather
  // than walking through every toggle. Row selection is cleared by dropping `row`: a group id in
  // one grain is not a campaign id in the other.
  const onChange = (v: string) => set({ grain: v as 'schedules' | 'campaigns', row: '', drawer: '' })

  return (
    <span className="rd-grain">
      <SegmentedControl
        size="sm"
        value={state.grain}
        onChange={onChange}
        options={[
          { value: 'schedules', label: `Schedules (${schedules})` },
          { value: 'campaigns', label: `Campaigns (${campaigns})` },
        ]}
      />
      {/* The engine resolves windows on the DATABASE clock. If this process disagrees by more than
          a few minutes, every "now holding" on screen is for a different hour than the one the
          engine acted on — so it is stated rather than left to be discovered. */}
      {skewMinutes != null && Math.abs(skewMinutes) >= 5 && (
        <span className="rd-clock" title="The engine resolves each window against the database clock. This browser's clock differs, so what you see may be an hour the engine has not reached.">
          clock skew {skewMinutes > 0 ? '+' : ''}{skewMinutes}m
        </span>
      )}
    </span>
  )
}
