'use client'

/**
 * GDS — the one density control: Compact · Cozy · Spacious, a DS `SegmentedControl` in the
 * toolbar's right slot. Its value is the same `GridDensityName` the grid, the thumbnails and
 * `useGridState` speak.
 */
import { memo } from 'react'

import { SegmentedControl, type SegmentedOption } from '../../primitives'
import type { GridDensityName } from '../../tokens/grid'

export const GRID_DENSITY_OPTIONS: SegmentedOption[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'cozy', label: 'Cozy' },
  { value: 'spacious', label: 'Spacious' },
]

export interface GridDensityToggleProps {
  value: GridDensityName
  onChange: (next: GridDensityName) => void
}

export const GridDensityToggle = memo(function GridDensityToggle({ value, onChange }: GridDensityToggleProps) {
  return <SegmentedControl options={GRID_DENSITY_OPTIONS} value={value} onChange={(v) => onChange(v as GridDensityName)} size="sm" />
})
