'use client'

/**
 * One-click "Nexus wins" (Owner 2026-10-04, SIMPLIFY item 3) — the one summary line at the top of a market's tab:
 * "12 values on Amazon · IT differ from Nexus. Publish replaces them." (`differsSummary`), with ONE switch "Keep
 * Amazon's values". Switching it on unticks every ticked change of the market whose `replaces` is set (the lines that
 * would replace a value on the channel); switching it off ticks them back. The per-line warnings stay in the table.
 *
 * A Full update row's fields (`locked`) are left alone: such a row sends everything or nothing, by its own tick.
 */
import { differsSummary, isPhotoChangeId, type StudioPublishChange, type StudioPublishReview } from '@nexus/shared/studio-publication'
import { channelLabel } from '@nexus/shared/channel-label'
import { Toggle } from '@/design-system/primitives'
import { Banner } from '@/design-system/components'
import styles from './DiffersSummary.module.css'

type Change = Pick<StudioPublishChange, 'id' | 'selectable' | 'locked' | 'replaces'>

/** The changes the switch governs: they replace a channel value, can be ticked, and are not a Full update row's. */
export function keepChannelIds(changes: readonly Change[] | null | undefined, photosOnly = false): string[] {
  return (changes ?? []).filter(c => !!c.replaces && c.selectable && !c.locked && (!photosOnly || isPhotoChangeId(c.id))).map(c => c.id)
}

/** The switch reads on when every governed change is unticked (and there is one). */
export function keepingChannelValues(changes: readonly Change[] | null | undefined, selectedIds: readonly string[], photosOnly = false): boolean {
  const ids = keepChannelIds(changes, photosOnly)
  return ids.length > 0 && ids.every(id => !selectedIds.includes(id))
}

/** The ticks after the switch: on unticks every governed change, off ticks them all again; every other tick stays. */
export function withChannelValuesKept(changes: readonly Change[] | null | undefined, selectedIds: readonly string[], keep: boolean, photosOnly = false): string[] {
  const ids = new Set(keepChannelIds(changes, photosOnly))
  const others = selectedIds.filter(id => !ids.has(id))
  return keep ? others : [...others, ...ids]
}

/** "Keep Amazon's values". */
export const keepChannelWords = (channel: string) => `Keep ${channelLabel(channel)}’s values`

export interface DiffersSummaryProps {
  review: Pick<StudioPublishReview, 'id' | 'scope' | 'changes' | 'photosOnly'>
  selectedIds: string[]
  locked: boolean
  onSelectionChange(ids: string[]): void
}

export function DiffersSummary({ review, selectedIds, locked, onSelectionChange }: DiffersSummaryProps) {
  const summary = differsSummary(review.changes, `${channelLabel(review.scope.channel)} · ${review.scope.marketplace}`, selectedIds)
  if (!summary) return null
  const photosOnly = !!review.photosOnly
  const governed = keepChannelIds(review.changes, photosOnly)
  const keeping = keepingChannelValues(review.changes, selectedIds, photosOnly)
  return <Banner tone={summary.ticked ? 'warning' : 'neutral'} title={summary.sentence}>
    {/* The label names the switch, and a click on its words flips it. */}
    {governed.length > 0 && <label className={styles.row}>
      <Toggle size="sm" checked={keeping} disabled={locked || !review.id}
        onChange={next => onSelectionChange(withChannelValuesKept(review.changes, selectedIds, next, photosOnly))} />
      <span>{keepChannelWords(review.scope.channel)}</span>
    </label>}
  </Banner>
}
