'use client'

/**
 * RDX/B3 — a schedule's week, readable at a glance from the list.
 *
 * The Windows column used to render `windows.length`. "3" tells you a schedule has three windows
 * and nothing about WHEN it pushes — so comparing two schedules, or spotting the one that still
 * runs all night, meant opening each in the builder.
 *
 * This is a 7×24 micro-grid: one row per weekday (Mon→Sun, matching the big heatmap above), one
 * cell per hour, coloured by the rank target that governs that hour. Untouched hours take the
 * baseline colour, so an evening-only plan reads as a vertical band on the right and a
 * weekday-only plan as five filled rows over two empty ones.
 *
 * The window→grid compilation and the colour rules come from the builder's own `rank-grid-model`,
 * NOT a second copy: a cell here must mean exactly what the same cell means in the paint grid, and
 * a divergence would be invisible until someone acted on it. That module is pure — importing it
 * changes nothing about the builder.
 */
import { useMemo } from 'react'
import { gridFromWindows, describeRankGrid, BASELINE_COLOR, type RankWin } from '../_rank/rank-grid-model'

// Mon-first display order mapped to real dow (0=Sun), same as DaypartingHeatmap so the two grids
// on this page are read the same way round.
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0]
const DOW_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

export function WeekShape({ windows, baselineKey, colorOf, nameOf, baselineName }: {
  windows: unknown[]
  baselineKey: string
  /** targetKey → swatch colour (the list's resolved RankTarget palette). */
  colorOf: (key: string) => string | null
  /** targetKey → display name, for the hover summary. */
  nameOf: (key: string) => string
  baselineName: string
}) {
  const grid = useMemo(() => gridFromWindows(windows as RankWin[]), [windows])

  const title = useMemo(() => {
    const lines = describeRankGrid(grid, nameOf, baselineName || 'baseline')
    return lines.length ? lines.join('\n') : `${baselineName || 'Baseline'} all week — no windows set.`
  }, [grid, nameOf, baselineName])

  // The baseline tint is deliberately near-neutral: the point of the strip is where the schedule
  // DEPARTS from its baseline, so untouched hours must recede rather than compete.
  const baseTint = baselineKey ? (colorOf(baselineKey) ?? BASELINE_COLOR) : BASELINE_COLOR

  return (
    <span className="h10-wkshape" title={title} role="img" aria-label={title}>
      {DOW_ORDER.map((d) => (
        <span className="row" key={d}>
          <span className="dl" aria-hidden="true">{DOW_SHORT[d]}</span>
          {grid[d]?.map((key, h) => {
            const on = !!key
            return (
              <span
                key={h}
                // Every 6th hour carries a faint divider so 18:00 is findable without an axis —
                // a real hour ruler would double the strip's height for one row of 4px text.
                className={`c${on ? ' on' : ''}${h % 6 === 0 && h > 0 ? ' tick' : ''}`}
                style={{ background: on ? (colorOf(key) ?? '#99a1ac') : baseTint, opacity: on ? 1 : 0.34 }}
              />
            )
          })}
        </span>
      ))}
    </span>
  )
}
