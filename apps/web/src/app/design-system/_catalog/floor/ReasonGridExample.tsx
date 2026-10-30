'use client'

import { useState } from 'react'
import { CircleDot, Droplets, Hammer, CircleHelp, Layers, Ruler, Scissors, Spline, SquareSplitHorizontal, Sun, Wrench, Zap } from 'lucide-react'

import { FloorActionBar, FloorFrame } from '@/design-system/floor'
import { ReasonGrid, type ReasonTile } from '@/design-system/floor/ReasonGrid'
import { SegmentedControl } from '@/design-system/primitives'

/*
 * 2026-10-30 — the floor's icon reason grid (factory gap D20, `packages/ui/src/floor/ReasonGrid`), on the floor density
 * tier, with made-up defect reasons. Verify: Pick — Tab to the group, arrows move and pick (↑ ↓ by row), the picked tile
 * has a tick and a thick bar; "Pinhole" is held with its reason; More reasons opens page 2 and the focus goes to its first
 * tile; "Other" needs a photo. Count — each tap adds one, the count is big on the tile, − takes one off, the total is
 * written; never over 24 (the bundle). Light and dark, 1440 and 390.
 */

const reasons: ReasonTile[] = [
  { id: 'hole', label: 'Hole', hint: 'in the leather', icon: <CircleDot />, tone: 'danger' },
  { id: 'scratch', label: 'Scratch', icon: <Spline />, tone: 'warning' },
  { id: 'pinhole', label: 'Pinhole', icon: <Zap />, tone: 'warning', heldReason: 'Not checked at this station' },
  { id: 'stain', label: 'Stain', icon: <Droplets />, tone: 'info' },
  { id: 'seam', label: 'Open seam', icon: <Scissors />, tone: 'danger' },
  { id: 'size', label: 'Wrong size', icon: <Ruler />, tone: 'primary' },
  { id: 'layers', label: 'Loose lining', icon: <Layers />, tone: 'info' },
  { id: 'fade', label: 'Faded colour', icon: <Sun />, tone: 'warning' },
  { id: 'split', label: 'Split panel', icon: <SquareSplitHorizontal />, tone: 'danger' },
  { id: 'rivet', label: 'Bad rivet', icon: <Hammer />, tone: 'neutral' },
  { id: 'zip', label: 'Broken zip', icon: <Wrench />, tone: 'neutral' },
  { id: 'other', label: 'Other', icon: <CircleHelp />, photoNeeded: true },
]

export function ReasonGridExample() {
  const [mode, setMode] = useState<'pick' | 'count'>('pick')
  const [picked, setPicked] = useState<string | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>({ hole: 2 })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--nds-space-12)' }}>
      <SegmentedControl
        ariaLabel="Mode"
        value={mode}
        onChange={(value: string) => setMode(value === 'count' ? 'count' : 'pick')}
        options={[
          { value: 'pick', label: 'Pick one (pause, symptom)' },
          { value: 'count', label: 'Count (scrap, defects)' },
        ]}
      />
      <div style={{ maxWidth: 820 }}>
        <FloorFrame
          fill={false}
          landmarks={false}
          label="Reason grid (example)"
          actions={<FloorActionBar actions={[{ label: mode === 'pick' ? 'Confirm' : 'Save counts', onPress: () => undefined, heldReason: mode === 'pick' && !picked ? 'Choose a reason first' : null }]} />}
        >
          {mode === 'pick' ? (
            <ReasonGrid label="Why did you stop?" reasons={reasons} value={picked} onChange={(id) => setPicked(id)} />
          ) : (
            <ReasonGrid mode="count" label="Defects in this bundle" reasons={reasons} counts={counts} onCountChange={(next) => setCounts(next)} max={24} />
          )}
        </FloorFrame>
      </div>
    </div>
  )
}
