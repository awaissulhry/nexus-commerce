'use client'

/**
 * GDS — the one density control: Compact · Cozy · Spacious, a DS `SegmentedControl` in the
 * toolbar's right slot. Its value is the same `GridDensityName` the grid, the thumbnails and
 * `useGridState` speak.
 */
import { memo, useMemo } from 'react'

import { SegmentedControl, type SegmentedOption } from '../../primitives'
import type { GridDensityName } from '../../tokens/grid'
import { mergeLabels } from '../../lib/labels'
import { GRID_DENSITY_TOGGLE_LABELS, type GridDensityToggleLabels } from './GridDensityToggleLabels'

const densityOptions = (words: GridDensityToggleLabels): SegmentedOption[] => [
  { value: 'compact', label: words.compact },
  { value: 'cozy', label: words.cozy },
  { value: 'spacious', label: words.spacious },
]

export const GRID_DENSITY_OPTIONS: SegmentedOption[] = densityOptions(GRID_DENSITY_TOGGLE_LABELS)

export interface GridDensityToggleProps {
  value: GridDensityName
  onChange: (next: GridDensityName) => void
  /** Its words in the person's language (B-W2b-04): the three densities. Default English. */
  labels?: Partial<GridDensityToggleLabels>
}

export const GridDensityToggle = memo(function GridDensityToggle({ value, onChange, labels }: GridDensityToggleProps) {
  const { compact, cozy, spacious } = mergeLabels(GRID_DENSITY_TOGGLE_LABELS, labels)
  const options = useMemo(() => (labels ? densityOptions({ compact, cozy, spacious }) : GRID_DENSITY_OPTIONS), [labels, compact, cozy, spacious])
  return <SegmentedControl options={options} value={value} onChange={(v) => onChange(v as GridDensityName)} size="sm" />
})
