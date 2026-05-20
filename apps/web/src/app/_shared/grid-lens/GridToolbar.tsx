'use client'

import type { ReactNode } from 'react'

/**
 * Canonical chrome toolbar that orchestrates the same controls in the
 * same positions across every list page.
 *
 *   LEFT:  [Search] [quick-filter chips / channel picker]
 *                                                          ml-auto
 *   RIGHT: [Filter] [Sort] [Columns] [Density] │ [Auto-refresh] [Freshness] │ [SavedViews] [Shortcuts]
 *
 * Pages pass primitives into named slots; the toolbar handles spacing,
 * dividers, wrap behavior, and dark-mode borders. Unused slots collapse
 * silently so a page that has no SavedViews simply omits the button.
 */
export interface GridToolbarProps {
  // ── LEFT cluster ──────────────────────────────────────────────────
  /** Search input (consistent placement: leftmost). */
  searchSlot?: ReactNode
  /** Page-specific quick-filter chips, channel pickers, etc. */
  quickFilterSlot?: ReactNode

  // ── RIGHT cluster: view-shaping group ─────────────────────────────
  /** <FilterPopover …/> */
  filter?: ReactNode
  /** <SortStack …/> */
  sort?: ReactNode
  /** <ColumnPicker …/> — typically rendered only in grid lens. */
  columns?: ReactNode
  /** <DensityToggle …/> — typically rendered only in grid lens. */
  density?: ReactNode

  // ── RIGHT cluster: data-time group ────────────────────────────────
  /** <AutoRefreshSelect …/> */
  autoRefresh?: ReactNode
  /** <FreshnessIndicator …/> */
  freshness?: ReactNode

  // ── RIGHT cluster: meta group ─────────────────────────────────────
  /** <SavedViewsButton …/> */
  savedViews?: ReactNode
  /** <KeyboardShortcutsButton …/> */
  shortcuts?: ReactNode

  /** Optional trailing slot for page-specific actions (e.g. "Recompute All"). */
  trailingSlot?: ReactNode

  /** When true, makes the toolbar sticky to the top of its scroll container. */
  sticky?: boolean
  className?: string
}

function Divider() {
  return <span aria-hidden="true" className="w-px h-4 bg-slate-200 dark:bg-slate-700 shrink-0" />
}

export function GridToolbar({
  searchSlot,
  quickFilterSlot,
  filter,
  sort,
  columns,
  density,
  autoRefresh,
  freshness,
  savedViews,
  shortcuts,
  trailingSlot,
  sticky,
  className,
}: GridToolbarProps) {
  const hasView = !!(filter || sort || columns || density)
  const hasTime = !!(autoRefresh || freshness)
  const hasMeta = !!(savedViews || shortcuts)
  const hasRight = hasView || hasTime || hasMeta || !!trailingSlot
  const hasLeft = !!(searchSlot || quickFilterSlot)

  return (
    <div
      className={[
        'flex items-center gap-2 flex-wrap',
        sticky ? 'sticky top-0 z-10 bg-white/95 dark:bg-slate-950/95 backdrop-blur-sm py-2 -mx-1 px-1' : '',
        className ?? '',
      ].filter(Boolean).join(' ')}
    >
      {/* LEFT cluster */}
      {hasLeft && (
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          {searchSlot}
          {quickFilterSlot}
        </div>
      )}

      {/* RIGHT cluster — ml-auto separates from LEFT when both present */}
      {hasRight && (
        <div className={`flex items-center gap-2 flex-wrap ${hasLeft ? 'ml-auto' : ''}`}>
          {hasView && (
            <div className="flex items-center gap-1.5">
              {filter}
              {sort}
              {columns}
              {density}
            </div>
          )}
          {hasView && hasTime && <Divider />}
          {hasTime && (
            <div className="flex items-center gap-1.5">
              {autoRefresh}
              {freshness}
            </div>
          )}
          {(hasView || hasTime) && hasMeta && <Divider />}
          {hasMeta && (
            <div className="flex items-center gap-1.5">
              {savedViews}
              {shortcuts}
            </div>
          )}
          {trailingSlot && (
            <>
              {(hasView || hasTime || hasMeta) && <Divider />}
              {trailingSlot}
            </>
          )}
        </div>
      )}
    </div>
  )
}
