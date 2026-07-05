'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { ChevronUp, ChevronDown } from 'lucide-react'
import { Modal } from '@/design-system/components'
import { Button, Checkbox } from '@/design-system/primitives'

export interface CustomizableColumn {
  key: string
  label: ReactNode
  visible: boolean
  /** locked columns can't be hidden or moved (e.g. the name column) */
  locked?: boolean
}

export interface ColumnCustomizerProps {
  open: boolean
  onClose: () => void
  columns: CustomizableColumn[]
  onApply: (columns: CustomizableColumn[]) => void
  className?: string
}

/**
 * Column visibility + reorder, inside a Modal (H10 "Customize columns"). Edits a
 * local draft; Apply commits. Reorder via up/down (no dnd dependency).
 */
export function ColumnCustomizer({ open, onClose, columns, onApply, className }: ColumnCustomizerProps) {
  const [draft, setDraft] = useState<CustomizableColumn[]>(columns)
  useEffect(() => {
    if (open) setDraft(columns)
  }, [open, columns])

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= draft.length) return
    const next = [...draft]
    ;[next[i], next[j]] = [next[j], next[i]]
    setDraft(next)
  }
  const toggle = (key: string) => setDraft((d) => d.map((c) => (c.key === key ? { ...c, visible: !c.visible } : c)))

  return (
    <Modal
      open={open}
      onClose={onClose}
      className={className}
      title="Customize columns"
      subtitle="Toggle visibility and reorder."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              onApply(draft)
              onClose()
            }}
          >
            Apply
          </Button>
        </>
      }
    >
      <div className="h10-ds-colcust">
        {draft.map((c, i) => (
          <div className="h10-ds-colcust-row" key={c.key}>
            <span className="grip">
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0 || c.locked} aria-label="Move up">
                <ChevronUp size={14} />
              </button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === draft.length - 1 || c.locked} aria-label="Move down">
                <ChevronDown size={14} />
              </button>
            </span>
            <Checkbox checked={c.visible} disabled={c.locked} onChange={() => toggle(c.key)} label={c.label} />
          </div>
        ))}
      </div>
    </Modal>
  )
}
