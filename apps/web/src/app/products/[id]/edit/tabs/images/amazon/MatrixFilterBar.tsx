'use client'

// IE.11 — Filter + group-by bar above the Amazon Color×Slot matrix.
//
// Two filter dimensions today (more land in IE.12+):
//   • Axis values — multi-select. Default = all values shown.
//     Lets the operator scope to "Giallo only" while editing the
//     yellow variant's slots without losing the matrix structure.
//   • Cell status — single-select. 'all' = no filter; 'empty' /
//     'inherited' / 'override' narrows the matrix to cells in that
//     resolveCell origin. The matrix dims non-matching cells
//     instead of hiding them so the row structure stays intact.
//
// URL-persisted so deep-links + bookmarks reflect the operator's
// current scope.

import { useEffect, useState } from 'react'
import { Bookmark, Filter, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export type CellStatus = 'all' | 'empty' | 'inherited' | 'override'

// IE.13 — localStorage-backed presets so the operator can recall
// frequent filter combinations ("Giallo + Empty cells", "Just
// overrides") with one click. Per-browser today; a DB-backed
// version that syncs across devices lands in IE.13b.
const PRESETS_KEY = 'ie.matrix.filterPresets.v1'

interface FilterPreset {
  name: string
  values: string[]
  status: CellStatus
}

function loadPresets(): FilterPreset[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(PRESETS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (p): p is FilterPreset =>
        !!p &&
        typeof p === 'object' &&
        typeof (p as FilterPreset).name === 'string' &&
        Array.isArray((p as FilterPreset).values) &&
        typeof (p as FilterPreset).status === 'string',
    )
  } catch {
    return []
  }
}

function savePresets(presets: FilterPreset[]): void {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(PRESETS_KEY, JSON.stringify(presets)) } catch { /* quota / disabled storage — silent */ }
}

interface Props {
  /** All possible values for the active axis (e.g. ["Nero", "Giallo"]). */
  allValues: string[]
  /** Currently selected values. Empty Set = all values. */
  activeValues: Set<string>
  onActiveValuesChange: (next: Set<string>) => void

  cellStatus: CellStatus
  onCellStatusChange: (next: CellStatus) => void

  /** axis label (e.g. "Color") for the chip group header. */
  axisLabel: string
}

const STATUS_OPTIONS: { value: CellStatus; label: string; description: string }[] = [
  { value: 'all',       label: 'All',       description: 'No status filter' },
  { value: 'empty',     label: 'Empty',     description: 'Cells with no master + no listing-image row' },
  { value: 'inherited', label: 'Inherited', description: 'Cells showing master fallback (no override)' },
  { value: 'override',  label: 'Override',  description: 'Cells with explicit variant or marketplace overrides' },
]

export default function MatrixFilterBar({
  allValues,
  activeValues,
  onActiveValuesChange,
  cellStatus,
  onCellStatusChange,
  axisLabel,
}: Props) {
  // IE.13 — saved presets state
  const [presets, setPresets] = useState<FilterPreset[]>(() => loadPresets())
  const [presetMenuOpen, setPresetMenuOpen] = useState(false)
  const [savingNew, setSavingNew] = useState(false)
  const [newPresetName, setNewPresetName] = useState('')

  function applyPreset(p: FilterPreset) {
    onActiveValuesChange(new Set(p.values))
    onCellStatusChange(p.status)
    setPresetMenuOpen(false)
  }
  function commitNewPreset() {
    const name = newPresetName.trim()
    if (!name) return
    // Replace existing preset with the same name so saving the same
    // name twice updates rather than duplicates.
    const next = [...presets.filter((p) => p.name !== name), {
      name,
      values: Array.from(activeValues),
      status: cellStatus,
    }]
    setPresets(next)
    savePresets(next)
    setSavingNew(false)
    setNewPresetName('')
  }
  function deletePreset(name: string) {
    const next = presets.filter((p) => p.name !== name)
    setPresets(next)
    savePresets(next)
  }
  // URL persist — the AmazonPanel owner reads ?img.values + ?img.status
  // on mount and seeds state from them. Here we write back on change.
  useEffect(() => {
    const url = new URL(window.location.href)
    if (activeValues.size > 0) {
      url.searchParams.set('img.values', Array.from(activeValues).join(','))
    } else {
      url.searchParams.delete('img.values')
    }
    if (cellStatus !== 'all') {
      url.searchParams.set('img.status', cellStatus)
    } else {
      url.searchParams.delete('img.status')
    }
    // replaceState (not pushState) — we don't want the back button to
    // step through every filter toggle.
    window.history.replaceState({}, '', url.toString())
  }, [activeValues, cellStatus])

  function toggleValue(v: string) {
    const next = new Set(activeValues)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    onActiveValuesChange(next)
  }

  const hasFilter = activeValues.size > 0 || cellStatus !== 'all'

  return (
    <div className="flex items-center gap-2 flex-wrap text-xs">
      <Filter className="w-3.5 h-3.5 text-slate-400" />

      <span className="text-[11px] uppercase tracking-wide text-slate-400 font-medium">
        {axisLabel}
      </span>
      <div className="flex items-center gap-1 flex-wrap">
        {allValues.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => toggleValue(v)}
            className={cn(
              'text-[11px] px-2 py-0.5 rounded-full border transition-colors',
              activeValues.has(v)
                ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-400 text-blue-700 dark:text-blue-300'
                : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
            )}
          >
            {v}
          </button>
        ))}
      </div>

      <span className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1" />

      <span className="text-[11px] uppercase tracking-wide text-slate-400 font-medium">
        Status
      </span>
      <select
        value={cellStatus}
        onChange={(e) => onCellStatusChange(e.target.value as CellStatus)}
        className="text-[11px] border border-slate-200 dark:border-slate-700 rounded px-1.5 py-0.5 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-400"
        title={STATUS_OPTIONS.find((o) => o.value === cellStatus)?.description}
      >
        {STATUS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value} title={o.description}>{o.label}</option>
        ))}
      </select>

      {hasFilter && (
        <button
          type="button"
          onClick={() => {
            onActiveValuesChange(new Set())
            onCellStatusChange('all')
          }}
          className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-700 dark:hover:text-slate-200"
          title="Clear all filters"
        >
          <X className="w-3 h-3" />
          Clear
        </button>
      )}

      {/* IE.13 — Saved presets. Bookmark icon opens a dropdown with
          the operator's named filter combinations. "Save current"
          captures the present (axis values + status) under a name
          for one-click recall later. */}
      <div className="relative ml-auto">
        <button
          type="button"
          onClick={() => setPresetMenuOpen((v) => !v)}
          className={cn(
            'inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border transition-colors',
            presetMenuOpen
              ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-400 text-amber-700 dark:text-amber-300'
              : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
          )}
          title="Saved filter presets"
        >
          <Bookmark className="w-3 h-3" />
          Presets
          {presets.length > 0 && (
            <span className="text-[10px] text-slate-400">({presets.length})</span>
          )}
        </button>
        {presetMenuOpen && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => { setPresetMenuOpen(false); setSavingNew(false) }} />
            <div className="absolute right-0 top-7 z-30 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl py-1 min-w-[220px] text-xs">
              {presets.length === 0 && !savingNew && (
                <div className="px-3 py-2 text-slate-400 italic">No saved presets yet</div>
              )}
              {presets.map((p) => (
                <div
                  key={p.name}
                  className="flex items-center justify-between px-3 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-700 group"
                >
                  <button
                    type="button"
                    onClick={() => applyPreset(p)}
                    className="flex-1 text-left flex flex-col"
                  >
                    <span className="font-medium text-slate-700 dark:text-slate-200 truncate" title={p.name}>{p.name}</span>
                    <span className="text-[10px] text-slate-400">
                      {p.values.length === 0 ? 'all values' : `${p.values.length} value${p.values.length === 1 ? '' : 's'}`}
                      {p.status !== 'all' && ` · ${p.status}`}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => deletePreset(p.name)}
                    aria-label="Delete preset"
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 text-slate-400 hover:text-red-500"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
              <div className="h-px bg-slate-100 dark:bg-slate-700 my-1" />
              {savingNew ? (
                <div className="px-2 py-1.5 flex items-center gap-1">
                  <input
                    autoFocus
                    type="text"
                    value={newPresetName}
                    onChange={(e) => setNewPresetName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitNewPreset()
                      if (e.key === 'Escape') { setSavingNew(false); setNewPresetName('') }
                    }}
                    placeholder="Preset name…"
                    className="flex-1 text-[11px] border border-slate-200 dark:border-slate-700 rounded px-1.5 py-1 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-400"
                  />
                  <button
                    type="button"
                    onClick={commitNewPreset}
                    disabled={!newPresetName.trim()}
                    className="text-[11px] px-2 py-1 rounded bg-blue-600 text-white disabled:opacity-50"
                  >
                    Save
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setSavingNew(true)}
                  disabled={!hasFilter}
                  className="w-full text-left px-3 py-1.5 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/30 disabled:opacity-50 disabled:cursor-not-allowed"
                  title={hasFilter ? 'Save the current filter combination' : 'Set a filter first'}
                >
                  + Save current as preset…
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Parse URL params into initial filter state. Caller seeds React
 * state from this on first render so a deep-link lands on the
 * filtered view without the operator re-applying the toggles.
 */
export function readFilterFromUrl(): { values: Set<string>; status: CellStatus } {
  if (typeof window === 'undefined') return { values: new Set(), status: 'all' }
  const sp = new URLSearchParams(window.location.search)
  const valuesRaw = sp.get('img.values')
  const values = new Set<string>(valuesRaw ? valuesRaw.split(',').filter(Boolean) : [])
  const statusRaw = sp.get('img.status') as CellStatus | null
  const status: CellStatus = statusRaw && STATUS_OPTIONS.some((o) => o.value === statusRaw) ? statusRaw : 'all'
  return { values, status }
}
