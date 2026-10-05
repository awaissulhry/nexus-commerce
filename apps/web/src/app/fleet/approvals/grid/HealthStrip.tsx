'use client'

/**
 * Approvals grid — the health strip (PLAN §2, §6): Needs you · Running · Failed · Ran by rule today · Oldest waiting,
 * from `GET /queue/counts`. Each tile is a filter on the grid: the active one shows pressed, a second click clears it.
 * On a phone the same tiles are one row of `FilterChip`s (PublishRuns' rule: five full tiles fill the first screen).
 */
import { memo, useMemo } from 'react'
import type { QueueCounts } from '@nexus/shared/approval-queue'

import { FilterChip } from '@/design-system/primitives'
import { MetricStrip, type Metric } from '@/design-system/components'
import { TILE_LABEL, TILE_ORDER, tileValue, type QueueTile } from './queueWords'

export interface HealthStripProps {
  counts: QueueCounts | null
  active: QueueTile | null
  onTile(tile: QueueTile | null): void
  /** Phone width: chips instead of tiles. */
  narrow: boolean
  /** The read's clock, so "Oldest waiting" ages with the list. */
  now: number
}

/** The tile's key colour, through the DS status tokens (MetricStrip takes a CSS colour). */
const ACCENT: Partial<Record<QueueTile, string>> = {
  needsYou: 'var(--nds-info)',
  running: 'var(--nds-warning)',
  failed: 'var(--nds-danger)',
  ranByRule: 'var(--nds-success)',
}

const HINT: Record<QueueTile, (c: QueueCounts) => string | null> = {
  needsYou: (c) => (c.backToYou ? `${c.waiting} waiting · ${c.backToYou} back to you` : null),
  running: (c) => (c.starting ? `${c.starting} about to run` : null),
  failed: () => null,
  ranByRule: () => null,
  oldest: () => null,
}

export const HealthStrip = memo(function HealthStrip({ counts, active, onTile, narrow, now }: HealthStripProps) {
  const metrics = useMemo<Metric[]>(
    () =>
      TILE_ORDER.map((tile) => ({
        label: TILE_LABEL[tile],
        value: tileValue(tile, counts, now),
        hint: counts ? HINT[tile](counts) : null,
        accent: ACCENT[tile],
        active: active === tile,
        onClick: () => onTile(active === tile ? null : tile),
      })),
    [counts, active, onTile, now],
  )

  if (narrow) {
    return (
      <div className="aqg-chips" role="group" aria-label="Filter the requests">
        {TILE_ORDER.map((tile) => (
          <FilterChip key={tile} size="md" pressed={active === tile} count={tileValue(tile, counts, now)} onClick={() => onTile(active === tile ? null : tile)}>
            {TILE_LABEL[tile]}
          </FilterChip>
        ))}
      </div>
    )
  }
  return <MetricStrip className="aqg-strip" metrics={metrics} />
})
