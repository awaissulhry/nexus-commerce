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
            'h-6 px-2.5 text-sm rounded transition-colors',
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
  // MM — derive parent ids from `isParent` rather than children's
  // parentId pointers. The previous walk only counted parents whose
  // children were also loaded in the same payload, so a parent with
  // unloaded children produced parentIds.size === 0 and "Expand all"
  // appeared to do nothing. Using isParent catches every expandable
  // row regardless of which side of the lazy-load fence its
  // children sit on.
  const parentIds = useMemo(() => {
    const ids = new Set<string>()
    for (const p of products) {
      if (p.isParent) ids.add(p.id)
    }
    return ids
  }, [products])

  const allExpanded =
    parentIds.size > 0 && expandedParents.size >= parentIds.size
  const noParents = parentIds.size === 0

  return (
    <div className="flex items-center gap-2 text-sm text-slate-500">
      <button
        type="button"
        onClick={() => onChange(new Set(parentIds))}
        disabled={noParents || allExpanded}
        title={noParents ? 'No parent products loaded' : 'Expand every parent'}
        className={cn(
          'transition-colors',
          noParents || allExpanded
            ? 'opacity-40 cursor-not-allowed'
            : 'hover:text-slate-900',
        )}
      >
        Expand all
      </button>
      <span className="text-slate-300">·</span>
      <button
        type="button"
        onClick={() => onChange(new Set())}
        disabled={expandedParents.size === 0}
        title="Collapse every parent"
        className={cn(
          'transition-colors',
          expandedParents.size === 0
            ? 'opacity-40 cursor-not-allowed'
            : 'hover:text-slate-900',
        )}
      >
        Collapse all
      </button>
      <span className="text-slate-400 tabular-nums">
        {expandedParents.size}/{parentIds.size} expanded
      </span>
    </div>
  )
}
