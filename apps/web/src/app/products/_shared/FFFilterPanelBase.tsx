import { type ReactNode, useEffect, useRef } from 'react'
import { Button } from '@/design-system/primitives/Button'
import { cn } from '@/lib/utils'

// ── Shared section + radio helpers (re-exported for consumers that extend the filter panel)

export function FFFilterSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">{label}</div>
      <div className="space-y-1">{children}</div>
    </div>
  )
}

export function FFFilterRadio({ checked, onChange, label, inline }: { checked: boolean; onChange: () => void; label: string; inline?: boolean }) {
  return (
    <label className={cn('flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer', inline && 'inline-flex')}>
      <input type="radio" checked={checked} onChange={onChange} className="w-3.5 h-3.5 border-slate-300 text-blue-600 focus:ring-blue-500" />
      {label}
    </label>
  )
}

export interface FFFilterPanelBaseProps {
  open: boolean
  onOpenChange: (v: boolean) => void
  missingRequired: boolean
  onMissingRequiredChange: (v: boolean) => void
  children: ReactNode
  onReset: () => void
  activeCount: number
}

export function FFFilterPanelBase({
  open,
  onOpenChange,
  missingRequired,
  onMissingRequiredChange,
  children,
  onReset,
  activeCount,
}: FFFilterPanelBaseProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    function handleMouseDown(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        onOpenChange(false)
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onOpenChange(false)
      }
    }

    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, onOpenChange])

  if (!open) return null
  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label="Filter rows"
      className="absolute left-3 top-10 z-30 w-72 rounded-xl border border-default bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900"
    >
      <div className="flex items-center justify-between border-b border-subtle px-4 py-2.5 dark:border-slate-800">
        <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          Filters{activeCount > 0 && <span className="ml-1 text-blue-500">({activeCount})</span>}
        </span>
        <Button variant="ghost" size="sm" onClick={onReset}>Reset</Button>
      </div>
      <div className="space-y-4 px-4 py-3">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={missingRequired}
            onChange={(e) => onMissingRequiredChange(e.target.checked)}
            className="rounded"
          />
          <span className="text-sm text-slate-700 dark:text-slate-300">Missing required fields</span>
        </label>
        {children}
      </div>
    </div>
  )
}
