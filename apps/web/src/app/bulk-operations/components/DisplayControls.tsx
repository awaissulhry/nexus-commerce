// Toolbar bits that drive the display mode (flat / hierarchy / grouped)
// and parent expand/collapse shortcuts.

import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import type { DisplayMode } from '../lib/hierarchy'
import type { BulkProduct } from '../lib/types'

export function DisplayModeToggle({
  mode,
  onChange,
}: {
  mode: DisplayMode
  onChange: (m: DisplayMode) => void
}) {
  const opts: Array<{
    id: DisplayMode
    label: string
    tooltip: string
    disabled?: boolean
  }> = [
    { id: 'flat', label: 'Flat', tooltip: 'All products in a single list' },
    {
      id: 'hierarchy',
      label: 'Hierarchy',
      tooltip: 'Parents and children grouped — click chevrons to expand',
    },
    {
      id: 'grouped',
      label: 'Grouped Edit',
      tooltip: 'Hierarchical with cascade editing — ships in D.3c',
      disabled: true,
    },
  ]
  return (
    <div className="flex items-center gap-0.5 border border-slate-200 rounded-md p-0.5 bg-white">
      {opts.map((o) => (
        <button
          key={o.id}
          type="button"
          disabled={o.disabled}
          onClick={() => !o.disabled && onChange(o.id)}
          title={o.tooltip}
          className={cn(
            'h-6 px-2.5 text-[11px] rounded transition-colors',
            mode === o.id
              ? 'bg-slate-100 text-slate-900 font-semibold'
              : 'text-slate-600 hover:text-slate-900',
            o.disabled && 'opacity-40 cursor-not-allowed',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function ExpandCollapseControls({
  products,
  expandedParents,
  onChange,
}: {
  products: BulkProduct[]
  expandedParents: Set<string>
  onChange: (s: Set<string>) => void
}) {
  // Compute parent IDs from products (those that are parented BY children).
  const parentIds = useMemo(() => {
    const ids = new Set<string>()
    for (const p of products) {
      if (p.parentId) ids.add(p.parentId)
    }
    return ids
  }, [products])

  return (
    <div className="flex items-center gap-2 text-[11px] text-slate-500">
      <button
        type="button"
        onClick={() => onChange(new Set(parentIds))}
        className="hover:text-slate-900"
      >
        Expand all
      </button>
      <span className="text-slate-300">·</span>
      <button
        type="button"
        onClick={() => onChange(new Set())}
        className="hover:text-slate-900"
      >
        Collapse all
      </button>
      <span className="text-slate-400 tabular-nums">
        {expandedParents.size}/{parentIds.size} expanded
      </span>
    </div>
  )
}
