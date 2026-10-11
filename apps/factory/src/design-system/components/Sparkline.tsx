'use client'

import { SPARK_BOX, sparkGeometry, sparkSummary, type SparkShape, type SparkValue } from './sparklineModel'

export interface SparklineProps {
  /** Readings in time order, oldest first. A null keeps its place and breaks the line. */
  values: ReadonlyArray<SparkValue>
  /** What the line is, for its accessible name and hover line: "Bid, 14 days". */
  label: string
  /** `step` (default): the value holds until the next reading — a bid. `line`: it moves between readings. */
  shape?: SparkShape
  /** How a reading is said: `(n) => €${n.toFixed(2)}`. */
  format?: (n: number) => string
  /** Said, and drawn as a dotted rule, when there is nothing to draw. Default "No changes". */
  emptyLabel?: string
  /** CSS px. Default 88 × 22 (a grid cell). */
  width?: number
  height?: number
  className?: string
}

/**
 * A small chart for a cell or a line of text (bid page DS lane, 2026-10-10; promoted from the parked `BidSpark`).
 * Tokens only: the line is `currentColor` (`--nds-primary` by default, `.nds-spark`), the empty rule is muted. One
 * accessible name says what it is and its low, high and latest reading; the drawing itself is hidden from assistive
 * technology. The model and its rules (step by default, nothing to draw is a mark) are `sparklineModel.ts`.
 */
export function Sparkline({ values, label, shape = 'step', format, emptyLabel = 'No changes', width = SPARK_BOX.width, height = SPARK_BOX.height, className }: SparklineProps) {
  const box = { width, height, pad: SPARK_BOX.pad }
  const g = sparkGeometry(values, shape, box)
  const name = sparkSummary(label, values, format, emptyLabel)
  const cls = ['nds-spark', g.count === 0 ? 'is-empty' : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <span className={cls} role="img" aria-label={name} title={name} style={{ width, height }}>
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden focusable="false">
        {g.count === 0
          ? <line className="nds-spark-empty" x1={box.pad} y1={height / 2} x2={width - box.pad} y2={height / 2} />
          : <>
              {g.path && <path className="nds-spark-line" d={g.path} />}
              {g.dots.map((d, i) => <circle key={i} className="nds-spark-dot" cx={d.x} cy={d.y} r={1.8} />)}
              {g.last && <circle className="nds-spark-dot" cx={g.last.x} cy={g.last.y} r={1.8} />}
            </>}
      </svg>
    </span>
  )
}
