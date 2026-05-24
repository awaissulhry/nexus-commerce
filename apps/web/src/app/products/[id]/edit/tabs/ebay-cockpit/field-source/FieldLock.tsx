'use client'

// EC.2.3 — FieldLock toggle.
//
// Padlock that prevents source-re-resolves from overwriting a field.
// Lock applies to the source binding, not the value — a locked
// manual-source field is still editable; a locked master-source field
// stops following master.

import { Lock, Unlock } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  locked: boolean
  onToggle: () => void
}

export default function FieldLock({ locked, onToggle }: Props) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'inline-flex items-center justify-center w-6 h-6 rounded border transition-colors',
        locked
          ? 'border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400'
          : 'border-slate-200 dark:border-slate-700 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200',
      )}
      title={locked ? 'Locked — source refreshes will skip this field' : 'Lock against source refresh'}
      aria-pressed={locked}
    >
      {locked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
    </button>
  )
}
