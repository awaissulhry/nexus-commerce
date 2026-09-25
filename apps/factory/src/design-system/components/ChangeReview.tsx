'use client'

import { useId, type ReactNode } from 'react'
import { Checkbox } from '../primitives/Checkbox'
import { KeyValue, type KeyValueItem } from './KeyValue'

export interface ChangeReviewItem {
  id: string
  label: ReactNode
  status: ReactNode
  note: ReactNode
  selectable: boolean
  values: KeyValueItem[]
}
export interface ChangeReviewProps {
  label: string
  items: ChangeReviewItem[]
  selectedIds: string[]
  disabled?: boolean
  onSelectionChange(ids: string[]): void
}

/** Accessible field choices and labelled comparison values; unknowns are supplied explicitly by the caller. */
export function ChangeReview({ label, items, selectedIds, disabled = false, onSelectionChange }: ChangeReviewProps) {
  const prefix = useId()
  const selected = new Set(selectedIds)
  return <div className="nds-change-review" role="group" aria-label={label}>
    {items.map((item, index) => {
      const titleId = `${prefix}-field-${index}`, noteId = `${prefix}-note-${index}`
      return <section key={item.id} className="nds-change-review-item" aria-labelledby={titleId}>
        <div className="nds-change-review-heading">
          <Checkbox aria-labelledby={titleId} aria-describedby={noteId} checked={item.selectable && selected.has(item.id)}
            disabled={disabled || !item.selectable} onChange={event => {
              const next = new Set(selected)
              if (event.target.checked) next.add(item.id)
              else next.delete(item.id)
              onSelectionChange(items.filter(row => row.selectable && next.has(row.id)).map(row => row.id))
            }} />
          <strong id={titleId}>{item.label}</strong>
          <span>{item.status}</span>
        </div>
        <p id={noteId} className="nds-change-review-note">{item.note}</p>
        <KeyValue columns={3} dense items={item.values} />
      </section>
    })}
  </div>
}
