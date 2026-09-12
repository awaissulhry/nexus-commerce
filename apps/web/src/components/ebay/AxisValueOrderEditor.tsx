'use client'

import type { ReactNode } from 'react'
import { OrderedList } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { sortClothing } from '@/app/products/ebay-flat-file/variationValueOrder.pure'

export interface AxisEntry {
  /** Opaque stable storage key (synonym key or raw name — parent's choice). */
  key: string
  /** Human label shown as the panel heading. */
  displayName: string
  /** Distinct values for this axis (the fallback order when axisOrder has none). */
  values: string[]
}

export interface AxisValueOrderEditorProps {
  /** Axes to render value panels for (one panel each). */
  axes: AxisEntry[]
  /** Ordered axis-identifier strings for the "buyer picks in this order" list. */
  axisSeq: string[]
  /** Per-axis value order, keyed by AxisEntry.key. Missing → axis.values. */
  axisOrder: Record<string, string[]>
  /** Reorder of the axis sequence. */
  onAxisSeqChange: (seq: string[]) => void
  /** New value order for one axis (full array; key = AxisEntry.key). */
  onAxisOrderChange: (key: string, values: string[]) => void
  /** 'drag' = dnd-kit grip rows; 'arrows' = up/down button rows. */
  interaction: 'drag' | 'arrows'
  /** Show the Clothing / A→Z / Z→A / Reverse preset buttons. */
  showPresetSorts?: boolean
  /** Extra content beside an axis's heading (e.g. an eBay-only rename input). */
  renderAxisExtra?: (axisKey: string) => ReactNode
  /** Extra content in a value row (e.g. an eBay-only value rename input). */
  renderValueExtra?: (axisKey: string, value: string) => ReactNode
}


/** Domain sorting and opaque axis keys stay here; the shared control owns reorder interactions. */
export function AxisValueOrderEditor({ axes, axisSeq, axisOrder, onAxisSeqChange, onAxisOrderChange, interaction, showPresetSorts, renderAxisExtra, renderValueExtra }: AxisValueOrderEditorProps) {
  return <div style={{ display: 'grid', gap: 'var(--nds-space-16)' }}>
    <section aria-label="Variation axis order">
      <h3>Buyer selects variations in this order</h3>
      <OrderedList label="Variation axes" items={axisSeq} onChange={onAxisSeqChange} draggable={interaction === 'drag'} />
    </section>
    {axes.map(axis => {
      const values = axisOrder[axis.key] ?? axis.values
      return <section key={axis.key} aria-label={`${axis.displayName} value order`}>
        <h3>{axis.displayName}</h3>{renderAxisExtra?.(axis.key)}
        {showPresetSorts && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--nds-space-6)', marginBlock: 'var(--nds-space-8)' }}>
          <Button size="sm" variant="quiet" onClick={() => onAxisOrderChange(axis.key, sortClothing(values))}>Clothing sizes</Button>
          <Button size="sm" variant="quiet" onClick={() => onAxisOrderChange(axis.key, [...values].sort((a,b) => a.localeCompare(b)))}>A–Z</Button>
          <Button size="sm" variant="quiet" onClick={() => onAxisOrderChange(axis.key, [...values].sort((a,b) => b.localeCompare(a)))}>Z–A</Button>
          <Button size="sm" variant="quiet" onClick={() => onAxisOrderChange(axis.key, [...values].reverse())}>Reverse</Button>
        </div>}
        <OrderedList label={`${axis.displayName} values`} items={values} onChange={next => onAxisOrderChange(axis.key, next)} draggable={interaction === 'drag'}
          renderItem={value => <>{value}{renderValueExtra?.(axis.key, value)}</>} />
      </section>
    })}
  </div>
}
