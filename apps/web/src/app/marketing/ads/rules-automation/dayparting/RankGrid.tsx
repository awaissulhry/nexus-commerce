'use client'

/**
 * RD.P2 — P2's section: one grid, two grains, one segmented control.
 *
 * The switch lives in each grid's toolbar (see `GrainSwitch`), so this component only decides which
 * grain is mounted. Both read the same scope from the URL and the same rows from the page's one
 * data layer, so the two can never disagree about what is in scope.
 *
 * The palette is built once here rather than inside each grain: passing a fresh object down would
 * re-run the drawer's diff memo on every keystroke in either grid's search box.
 */
import { useMemo } from 'react'
import { RankGoalsList } from '../tabs/RankGoalsList'
import { RankCampaignsGrid } from './RankCampaignsGrid'
import { useRdData } from './_rd/RdData'
import { useRdUrlState } from './_rd/useRdUrlState'

export function RankGrid() {
  const { targets } = useRdData()
  const { state } = useRdUrlState()

  const palette = useMemo(() => ({
    color: (k: string) => targets[k]?.color ?? null,
    name: (k: string) => targets[k]?.name ?? k,
  }), [targets])

  return state.grain === 'campaigns' ? <RankCampaignsGrid palette={palette} /> : <RankGoalsList />
}
