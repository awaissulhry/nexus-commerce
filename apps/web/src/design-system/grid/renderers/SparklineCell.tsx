'use client'

/**
 * SparklineCell — the cell of `sparklineColumn` (bid page DS lane, 2026-10-10): the DS `Sparkline` (step by default)
 * of the readings at the column's field, named for the row ("Bid of giacca moto, 14 days").
 */
import { memo } from 'react'
import type { ICellRendererParams } from 'ag-grid-community'

import { Sparkline } from '../../components/Sparkline'
import type { SparkShape, SparkValue } from '../../components/sparklineModel'

export interface SparklineCellParams<T = unknown> {
  /** What the line is for this row: its accessible name and hover line. */
  label: (row: T) => string
  shape?: SparkShape
  format?: (n: number) => string
  emptyLabel?: string
  width?: number
}

/** The cell value as readings: an array of numbers (a null keeps its place), anything else is no readings. */
export const sparkValuesOf = (value: unknown): SparkValue[] => (Array.isArray(value) ? (value as SparkValue[]) : [])

function SparklineCellView<T>(p: ICellRendererParams<T> & SparklineCellParams<T>) {
  if (!p.data) return null
  return (
    <span className="nds-cell-spark">
      <Sparkline values={sparkValuesOf(p.value)} label={p.label(p.data)} shape={p.shape} format={p.format} emptyLabel={p.emptyLabel} width={p.width} />
    </span>
  )
}

export const SparklineCell = memo(SparklineCellView) as typeof SparklineCellView
