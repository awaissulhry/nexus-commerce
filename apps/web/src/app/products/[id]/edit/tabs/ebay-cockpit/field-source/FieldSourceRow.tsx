'use client'

// EC.2.3 — FieldSourceRow.
//
// Glue component each card mounts to render one Field-Source-aware
// field. Wraps the consumer's input children with the badge, source
// switcher, lock, and undo controls in a consistent layout.

import type React from 'react'
import FieldSourceBadge from './FieldSourceBadge'
import SourceSwitcher from './SourceSwitcher'
import FieldLock from './FieldLock'
import UndoFieldButton from './UndoFieldButton'
import { useFieldSource } from './useFieldSource'
import type { FieldSource, ResolveValue } from './types'

interface Props {
  fieldKey: string
  label: string
  initial: { source: FieldSource; value: string }
  resolveValue: ResolveValue
  availableSources: FieldSource[]
  preview?: (source: FieldSource) => string | null
  /** Render the input. Receives the current value + onChange that
   *  routes through useFieldSource.setValue (which flips source to
   *  manual on type). */
  children: (input: { value: string; onChange: (next: string) => void; locked: boolean }) => React.ReactNode
}

export default function FieldSourceRow({
  fieldKey,
  label,
  initial,
  resolveValue,
  availableSources,
  preview,
  children,
}: Props) {
  const fs = useFieldSource(fieldKey, { label, initial, resolveValue })
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <label className="text-[11px] font-medium text-slate-700 dark:text-slate-300">
          {label}
        </label>
        <div className="flex items-center gap-1">
          <FieldSourceBadge source={fs.state.source} />
          <SourceSwitcher
            current={fs.state.source}
            available={availableSources}
            locked={fs.state.locked}
            onSwitch={(next) => { void fs.switchSource(next) }}
            preview={preview}
          />
          <FieldLock locked={fs.state.locked} onToggle={() => (fs.state.locked ? fs.unlock() : fs.lock())} />
          <UndoFieldButton
            canUndo={fs.canUndo}
            lastEntry={fs.state.history[0]}
            onUndo={() => fs.undo()}
          />
        </div>
      </div>
      {children({
        value: fs.state.value,
        onChange: fs.setValue,
        locked: false, // value is always editable; lock only freezes source
      })}
    </div>
  )
}
