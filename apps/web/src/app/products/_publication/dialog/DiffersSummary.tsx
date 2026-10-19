'use client'

/**
 * One-click "Nexus wins" (Owner 2026-10-04, SIMPLIFY item 3) — the one summary line at the top of a market's tab:
 * "12 values on Amazon · IT differ from Nexus. Publish replaces them." (`differsSummary`), with ONE switch "Keep
 * Amazon's values". Switching it on unticks every ticked change of the market whose `replaces` is set (the lines that
 * would replace a value on the channel); switching it off ticks them back. The per-line warnings stay in the table.
 *
 * A Full update row's fields (`locked`) are left alone: such a row sends everything or nothing, by its own tick.
 */
import { blockedChangeIds, differsSummary, type StudioPublishChange, type StudioPublishReview } from '@nexus/shared/studio-publication'
import { channelLabel } from '@nexus/shared/channel-label'
import { Toggle } from '@/design-system/primitives'
import { Banner } from '@/design-system/components'
import styles from './DiffersSummary.module.css'

type Change = Pick<StudioPublishChange, 'id' | 'selectable' | 'locked' | 'replaces'>

const NONE: ReadonlySet<string> = new Set()

/**
 * The changes the switch governs: they replace a channel value, can be ticked, are not a Full update row's, and no problem
 * leaves them out (`leftOut`, option A).
 */
export function keepChannelIds(changes: readonly Change[] | null | undefined, leftOut: ReadonlySet<string> = NONE): string[] {
  return (changes ?? []).filter(c => !!c.replaces && c.selectable && !c.locked && !leftOut.has(c.id)).map(c => c.id)
}

/** The switch reads on when every governed change is unticked (and there is one). */
export function keepingChannelValues(changes: readonly Change[] | null | undefined, selectedIds: readonly string[], leftOut: ReadonlySet<string> = NONE): boolean {
  const ids = keepChannelIds(changes, leftOut)
  return ids.length > 0 && ids.every(id => !selectedIds.includes(id))
}

/** The ticks after the switch: on unticks every governed change, off ticks them all again; every other tick stays. */
export function withChannelValuesKept(changes: readonly Change[] | null | undefined, selectedIds: readonly string[], keep: boolean, leftOut: ReadonlySet<string> = NONE): string[] {
  const ids = new Set(keepChannelIds(changes, leftOut))
  const others = selectedIds.filter(id => !ids.has(id))
  return keep ? others : [...others, ...ids]
}

/** "Keep Amazon's values". */
export const keepChannelWords = (channel: string) => `Keep ${channelLabel(channel)}’s values`

export interface DiffersSummaryProps {
  review: Pick<StudioPublishReview, 'id' | 'scope' | 'changes' | 'issues'> & Partial<Pick<StudioPublishReview, 'sendsWhole'>>
  selectedIds: string[]
  locked: boolean
  onSelectionChange(ids: string[]): void
}

export function DiffersSummary({ review, selectedIds, locked, onSelectionChange }: DiffersSummaryProps) {
  const summary = differsSummary(review.changes, `${channelLabel(review.scope.channel)} · ${review.scope.marketplace}`, selectedIds)
  if (!summary) return null
  const leftOut = blockedChangeIds(review)
  const governed = keepChannelIds(review.changes, leftOut)
  const keeping = keepingChannelValues(review.changes, selectedIds, leftOut)
  return <Banner tone={summary.ticked ? 'warning' : 'neutral'} title={summary.sentence}>
    {/* The label names the switch, and a click on its words flips it. */}
    {governed.length > 0 && <label className={styles.row}>
      <Toggle size="sm" checked={keeping} disabled={locked || !review.id}
        onChange={next => onSelectionChange(withChannelValuesKept(review.changes, selectedIds, next, leftOut))} />
      <span>{keepChannelWords(review.scope.channel)}</span>
    </label>}
  </Banner>
}
