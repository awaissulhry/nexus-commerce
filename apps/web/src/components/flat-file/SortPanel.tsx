'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { GripVertical, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'

// ── Shared types ───────────────────────────────────────────────────────────

export interface SortLevel {
  id: string
  colId: string
  mode: 'asc' | 'desc' | 'custom'
  customOrder: string[]
}

/** Generic group shape accepted by SortPanel. Callers adapt their own types. */
export interface SortGroup {
  id: string
  label: string
  columns: Array<{ id: string; label: string }>
}

// ── Helpers ────────────────────────────────────────────────────────────────

function uniqueVals(rows: Array<Record<string, unknown>>, colId: string): string[] {
  const seen = new Set<string>()
  for (const row of rows) {
    const v = String(row[colId] ?? '').trim()
    if (v) seen.add(v)
  }
  return [...seen].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
}

// ── DraggableValueList ─────────────────────────────────────────────────────

function DraggableValueList({
  values, onReorder,
}: { values: string[]; onReorder: (from: number, to: number) => void }) {
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null)
  return (
    <div className="max-h-40 overflow-y-auto">
      {values.map((val, i) => (
        <div
          key={`${val}-${i}`}
          draggable
          onDragStart={(e) => { setDraggingIdx(i); e.dataTransfer.effectAllowed = 'move' }}
          onDragEnd={() => setDraggingIdx(null)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            if (draggingIdx !== null && draggingIdx !== i) onReorder(draggingIdx, i)
            setDraggingIdx(null)
          }}
          className={cn(
            'flex items-center gap-1.5 px-2 py-1 cursor-grab select-none transition-colors',
            draggingIdx === i ? 'opacity-40' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50',
          )}
        >
          <GripVertical className="w-3 h-3 text-slate-300 dark:text-slate-600 flex-shrink-0" />
          <span className="text-xs text-slate-700 dark:text-slate-300 flex-1 truncate">
            {val || <span className="italic text-slate-400">empty</span>}
          </span>
          <span className="text-[9px] font-mono text-slate-300 dark:text-slate-600 flex-shrink-0">#{i + 1}</span>
        </div>
      ))}
    </div>
  )
}

// ── SortPanel ──────────────────────────────────────────────────────────────

interface SortPanelProps {
  rows: Array<Record<string, unknown>>
  groups: SortGroup[]
  initial: SortLevel[]
  onApply: (levels: SortLevel[]) => void
  onClose: () => void
}

export function SortPanel({ rows, groups, initial, onApply, onClose }: SortPanelProps) {
  const [levels, setLevels] = useState<SortLevel[]>(initial)
  const [draggingLevelId, setDraggingLevelId] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const allCols = useMemo(() => groups.flatMap((g) => g.columns), [groups])

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (!panelRef.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handle, true)
    return () => document.removeEventListener('mousedown', handle, true)
  }, [onClose])

  function addLevel() {
    const first = allCols[0]
    if (!first) return
    setLevels((prev) => [
      ...prev,
      { id: Math.random().toString(36).slice(2), colId: first.id, mode: 'asc', customOrder: [] },
    ])
  }

  function removeLevel(id: string) {
    setLevels((prev) => prev.filter((l) => l.id !== id))
  }

  function changeCol(id: string, colId: string) {
    setLevels((prev) => prev.map((l) => l.id === id ? { ...l, colId, mode: 'asc', customOrder: [] } : l))
  }

  function changeMode(id: string, mode: SortLevel['mode']) {
    setLevels((prev) => prev.map((l) => {
      if (l.id !== id) return l
      return { ...l, mode, customOrder: mode === 'custom' ? uniqueVals(rows, l.colId) : l.customOrder }
    }))
  }

  function reorderValues(levelId: string, fromIdx: number, toIdx: number) {
    setLevels((prev) => prev.map((l) => {
      if (l.id !== levelId) return l
      const next = [...l.customOrder]
      const [item] = next.splice(fromIdx, 1)
      next.splice(toIdx, 0, item)
      return { ...l, customOrder: next }
    }))
  }

  function reorderLevels(fromId: string, toId: string) {
    setLevels((prev) => {
      const from = prev.findIndex((l) => l.id === fromId)
      const to   = prev.findIndex((l) => l.id === toId)
      const next = [...prev]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      return next
    })
  }

  return (
    <div ref={panelRef}
      className="absolute left-0 top-full mt-1 z-50 w-[430px] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl overflow-hidden">

      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">Sort rows</div>
          <div className="text-xs text-slate-400">Levels applied top → bottom. Drag ⠿ to reprioritize.</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
      </div>

      {/* Levels */}
      <div className="max-h-[60vh] overflow-y-auto">
        {levels.length === 0 && (
          <p className="px-4 py-6 text-center text-xs text-slate-400 italic">No sort levels — add one below.</p>
        )}
        {levels.map((level, i) => (
          <div
            key={level.id}
            draggable
            onDragStart={(e) => { setDraggingLevelId(level.id); e.dataTransfer.effectAllowed = 'move' }}
            onDragEnd={() => setDraggingLevelId(null)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              if (draggingLevelId && draggingLevelId !== level.id) reorderLevels(draggingLevelId, level.id)
              setDraggingLevelId(null)
            }}
            className={cn('border-b border-slate-100 dark:border-slate-800 last:border-0', draggingLevelId === level.id && 'opacity-40')}
          >
            <div className="flex items-center gap-2 px-3 py-2.5">
              <GripVertical className="w-3.5 h-3.5 text-slate-300 dark:text-slate-600 cursor-grab flex-shrink-0" />
              <span className="text-[10px] font-mono text-slate-400 w-3 text-center flex-shrink-0">{i + 1}</span>

              <select
                value={level.colId}
                onChange={(e) => changeCol(level.id, e.target.value)}
                className="flex-1 min-w-0 text-xs border border-slate-200 dark:border-slate-700 rounded px-1.5 py-0.5 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {groups.map((g) => (
                  <optgroup key={g.id} label={g.label}>
                    {g.columns.map((c) => (
                      <option key={c.id} value={c.id}>{c.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>

              <div className="flex border border-slate-200 dark:border-slate-700 rounded overflow-hidden flex-shrink-0">
                {(['asc', 'desc', 'custom'] as const).map((m, mi) => (
                  <button key={m} type="button" onClick={() => changeMode(level.id, m)}
                    className={cn('text-[10px] px-1.5 py-0.5 transition-colors',
                      mi > 0 && 'border-l border-slate-200 dark:border-slate-700',
                      level.mode === m
                        ? 'bg-blue-500 text-white'
                        : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800',
                    )}>
                    {m === 'asc' ? 'A→Z' : m === 'desc' ? 'Z→A' : 'Custom'}
                  </button>
                ))}
              </div>

              <button type="button" onClick={() => removeLevel(level.id)}
                className="text-slate-300 hover:text-red-400 dark:text-slate-600 dark:hover:text-red-400 flex-shrink-0">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {level.mode === 'custom' && (
              <div className="mx-3 mb-2.5 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
                <div className="px-2 py-1 bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
                  <span className="text-[10px] font-medium text-slate-500 dark:text-slate-400">Custom order — drag to arrange</span>
                  <span className="text-[10px] text-slate-400 tabular-nums">{level.customOrder.length} values</span>
                </div>
                {level.customOrder.length === 0
                  ? <p className="px-3 py-2 text-xs text-slate-400 italic text-center">No values in current rows for this column.</p>
                  : <DraggableValueList
                      values={level.customOrder}
                      onReorder={(from, to) => reorderValues(level.id, from, to)}
                    />
                }
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-slate-100 dark:border-slate-800 flex items-center gap-2">
        <button type="button" onClick={addLevel} disabled={allCols.length === 0}
          className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 font-medium disabled:opacity-40">
          + Add sort level
        </button>
        <div className="flex-1" />
        {levels.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => { setLevels([]); onApply([]) }}>Reset</Button>
        )}
        <Button size="sm" onClick={() => onApply(levels)} disabled={levels.length === 0}>
          Apply sort
        </Button>
      </div>
    </div>
  )
}

// ── Sort comparator (shared) ───────────────────────────────────────────────

export function applySortLevels<T extends Record<string, unknown>>(rows: T[], levels: SortLevel[]): T[] {
  if (levels.length === 0) return rows
  return [...rows].sort((a, b) => {
    for (const level of levels) {
      if (!level.colId) continue
      const aVal = String(a[level.colId] ?? '')
      const bVal = String(b[level.colId] ?? '')
      let cmp = 0
      if (level.mode === 'asc') {
        cmp = aVal.localeCompare(bVal, undefined, { numeric: true, sensitivity: 'base' })
      } else if (level.mode === 'desc') {
        cmp = bVal.localeCompare(aVal, undefined, { numeric: true, sensitivity: 'base' })
      } else {
        const ai = level.customOrder.indexOf(aVal)
        const bi = level.customOrder.indexOf(bVal)
        cmp = (ai === -1 ? 1e9 : ai) - (bi === -1 ? 1e9 : bi)
      }
      if (cmp !== 0) return cmp
    }
    return 0
  })
}
