'use client'

/**
 * OL.H.3b — Matrix sort panel.
 *
 * A faithful replica of the Amazon flat-file SortPanel UX (multi-level
 * sort; each level A→Z / Z→A / Custom drag-ordered values; drag a level
 * to reprioritise) — rebuilt as a standalone, generic component so the
 * Matrix tab gets the same experience WITHOUT importing from or touching
 * /products/amazon-flat-file (untouchable). Typed to a generic field +
 * valuesFor model rather than the flat-file Row/ColumnGroup types.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { GripVertical, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'

export interface MatrixSortLevel {
  id: string
  colId: string
  mode: 'asc' | 'desc' | 'custom'
  customOrder: string[]
}

export interface MatrixSortField {
  id: string
  label: string
  /** Optional group heading (e.g. "Variant", "Pricing"). */
  group?: string
}

interface Props {
  fields: MatrixSortField[]
  /** Distinct values of a column across the current rows (for Custom mode). */
  valuesFor: (colId: string) => string[]
  initial: MatrixSortLevel[]
  onApply: (levels: MatrixSortLevel[]) => void
  onClose: () => void
}

function DraggableValueList({ values, onReorder }: { values: string[]; onReorder: (from: number, to: number) => void }) {
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
          onDrop={(e) => { e.preventDefault(); if (draggingIdx !== null && draggingIdx !== i) onReorder(draggingIdx, i); setDraggingIdx(null) }}
          className={cn('flex items-center gap-1.5 px-2 py-1 cursor-grab select-none transition-colors',
            draggingIdx === i ? 'opacity-40' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50')}
        >
          <GripVertical className="w-3 h-3 text-slate-300 dark:text-slate-600 flex-shrink-0" />
          <span className="text-xs text-slate-700 dark:text-slate-300 flex-1 truncate">{val || <span className="italic text-tertiary">empty</span>}</span>
          <span className="text-[9px] font-mono text-slate-300 dark:text-slate-600 flex-shrink-0">#{i + 1}</span>
        </div>
      ))}
    </div>
  )
}

export default function MatrixSortPanel({ fields, valuesFor, initial, onApply, onClose }: Props) {
  const [levels, setLevels] = useState<MatrixSortLevel[]>(initial)
  const [draggingLevelId, setDraggingLevelId] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // Group fields for the column <optgroup>s, preserving order.
  const grouped = useMemo(() => {
    const out: { group: string; fields: MatrixSortField[] }[] = []
    for (const f of fields) {
      const g = f.group ?? 'Columns'
      let bucket = out.find((b) => b.group === g)
      if (!bucket) { bucket = { group: g, fields: [] }; out.push(bucket) }
      bucket.fields.push(f)
    }
    return out
  }, [fields])

  useEffect(() => {
    function handle(e: MouseEvent) { if (!panelRef.current?.contains(e.target as Node)) onClose() }
    document.addEventListener('mousedown', handle, true)
    return () => document.removeEventListener('mousedown', handle, true)
  }, [onClose])

  const newId = () => `${levels.length}-${fields.length}-${levels.reduce((s, l) => s + l.colId.length, 0)}`

  function addLevel() {
    const first = fields[0]
    if (!first) return
    setLevels((prev) => [...prev, { id: `lvl-${prev.length}-${first.id}`, colId: first.id, mode: 'asc', customOrder: [] }])
  }
  function removeLevel(id: string) { setLevels((prev) => prev.filter((l) => l.id !== id)) }
  function changeCol(id: string, colId: string) {
    setLevels((prev) => prev.map((l) => l.id === id ? { ...l, colId, mode: 'asc', customOrder: [] } : l))
  }
  function changeMode(id: string, mode: MatrixSortLevel['mode']) {
    setLevels((prev) => prev.map((l) => l.id === id
      ? { ...l, mode, customOrder: mode === 'custom' ? valuesFor(l.colId) : l.customOrder }
      : l))
  }
  function reorderValues(levelId: string, fromIdx: number, toIdx: number) {
    setLevels((prev) => prev.map((l) => {
      if (l.id !== levelId) return l
      const next = [...l.customOrder]; const [item] = next.splice(fromIdx, 1); next.splice(toIdx, 0, item)
      return { ...l, customOrder: next }
    }))
  }
  function reorderLevels(fromId: string, toId: string) {
    setLevels((prev) => {
      const from = prev.findIndex((l) => l.id === fromId); const to = prev.findIndex((l) => l.id === toId)
      if (from < 0 || to < 0) return prev
      const next = [...prev]; const [item] = next.splice(from, 1); next.splice(to, 0, item); return next
    })
  }
  void newId

  return (
    <div ref={panelRef}
      className="absolute left-0 top-full mt-1 z-50 w-[430px] bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded-xl shadow-xl overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-subtle dark:border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">Sort variants</div>
          <div className="text-xs text-tertiary">Levels applied top → bottom. Drag ⠿ to reprioritize.</div>
        </div>
        <button onClick={onClose} className="text-tertiary hover:text-slate-600"><X className="w-4 h-4" /></button>
      </div>

      {/* Levels */}
      <div className="max-h-[60vh] overflow-y-auto">
        {levels.length === 0 && (
          <p className="px-4 py-6 text-center text-xs text-tertiary italic">No sort levels — add one below.</p>
        )}
        {levels.map((level, i) => (
          <div
            key={level.id}
            draggable
            onDragStart={(e) => { setDraggingLevelId(level.id); e.dataTransfer.effectAllowed = 'move' }}
            onDragEnd={() => setDraggingLevelId(null)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); if (draggingLevelId && draggingLevelId !== level.id) reorderLevels(draggingLevelId, level.id); setDraggingLevelId(null) }}
            className={cn('border-b border-subtle dark:border-slate-800 last:border-0', draggingLevelId === level.id && 'opacity-40')}
          >
            <div className="flex items-center gap-2 px-3 py-2.5">
              <GripVertical className="w-3.5 h-3.5 text-slate-300 dark:text-slate-600 cursor-grab flex-shrink-0" />
              <span className="text-[10px] font-mono text-tertiary w-3 text-center flex-shrink-0">{i + 1}</span>
              <select
                value={level.colId}
                onChange={(e) => changeCol(level.id, e.target.value)}
                className="flex-1 min-w-0 text-xs border border-default dark:border-slate-700 rounded px-1.5 py-0.5 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {grouped.map((g) => (
                  <optgroup key={g.group} label={g.group}>
                    {g.fields.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                  </optgroup>
                ))}
              </select>
              <div className="flex border border-default dark:border-slate-700 rounded overflow-hidden flex-shrink-0">
                {(['asc', 'desc', 'custom'] as const).map((m, mi) => (
                  <button key={m} type="button" onClick={() => changeMode(level.id, m)}
                    className={cn('text-[10px] px-1.5 py-0.5 transition-colors',
                      mi > 0 && 'border-l border-default dark:border-slate-700',
                      level.mode === m ? 'bg-blue-500 text-white' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800')}>
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
              <div className="mx-3 mb-2.5 rounded-lg border border-default dark:border-slate-700 overflow-hidden">
                <div className="px-2 py-1 bg-slate-50 dark:bg-slate-800/60 border-b border-default dark:border-slate-700 flex items-center justify-between">
                  <span className="text-[10px] font-medium text-slate-500 dark:text-slate-400">Custom order — drag to arrange</span>
                  <span className="text-[10px] text-tertiary tabular-nums">{level.customOrder.length} values</span>
                </div>
                {level.customOrder.length === 0
                  ? <p className="px-3 py-2 text-xs text-tertiary italic text-center">No values in current rows for this column.</p>
                  : <DraggableValueList values={level.customOrder} onReorder={(from, to) => reorderValues(level.id, from, to)} />}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-subtle dark:border-slate-800 flex items-center gap-2">
        <button type="button" onClick={addLevel} disabled={fields.length === 0}
          className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 font-medium disabled:opacity-40">
          + Add sort level
        </button>
        <div className="flex-1" />
        {levels.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => { setLevels([]); onApply([]) }}>Reset</Button>
        )}
        <Button size="sm" onClick={() => onApply(levels)} disabled={levels.length === 0}>Apply sort</Button>
      </div>
    </div>
  )
}
