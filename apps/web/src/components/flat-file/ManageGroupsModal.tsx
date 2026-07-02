'use client'
// Shared Manage Groups modal — rename / recolour / reorder / delete custom SKU
// groups for the FlatFileGrid. Edits mutate a LOCAL draft (instant); committed
// via onChange when the modal closes. (Port of the Amazon page's modal, using
// the shared group-model.)
import { useEffect, useState } from 'react'
import { ChevronUp, ChevronDown, Trash2, X } from 'lucide-react'
import { GROUP_PALETTE, type CustomGroup, type GroupColorName } from './group-model'

const SWATCH: Record<GroupColorName, string> = {
  blue: 'bg-blue-400', purple: 'bg-purple-400', emerald: 'bg-emerald-400',
  orange: 'bg-orange-400', teal: 'bg-teal-400', amber: 'bg-amber-400',
}

export function ManageGroupsModal({
  open, groups, onChange, onClose,
}: {
  open: boolean
  groups: CustomGroup[]
  onChange: (groups: CustomGroup[]) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<CustomGroup[]>(groups)
  // Snapshot on open; this modal is the sole editor while open.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) setDraft(groups) }, [open])

  const commitAndClose = () => { onChange(draft); onClose() }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') commitAndClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }) // no dep array: closure always sees the latest draft
  if (!open) return null

  const ordered = [...draft].sort((a, b) => a.order - b.order)
  const rename = (id: string, name: string) => setDraft((d) => d.map((g) => (g.id === id ? { ...g, name } : g)))
  const recolor = (id: string, color: GroupColorName) => setDraft((d) => d.map((g) => (g.id === id ? { ...g, color } : g)))
  const del = (id: string) => setDraft((d) => d.filter((g) => g.id !== id))
  const move = (id: string, dir: -1 | 1) => setDraft((d) => {
    const arr = [...d].sort((a, b) => a.order - b.order)
    const i = arr.findIndex((g) => g.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= arr.length) return d
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
    return arr.map((g, idx) => ({ ...g, order: idx }))
  })

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/25" onClick={commitAndClose}>
      <div
        className="w-[480px] max-h-[80vh] flex flex-col bg-white dark:bg-slate-900 border border-default dark:border-slate-700 rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Manage groups"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-default dark:border-slate-700">
          <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">Manage groups</div>
          <button type="button" onClick={commitAndClose} aria-label="Close" className="text-tertiary hover:text-slate-600">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-3 space-y-2">
          {ordered.length === 0 && (
            <div className="text-xs text-tertiary text-center py-8">
              No groups yet. Tick rows in the grid, then click “Group N…”.
            </div>
          )}
          {ordered.map((g, idx) => (
            <div key={g.id} className="flex items-center gap-2 p-2 rounded-lg border border-subtle dark:border-slate-800">
              <div className="flex flex-col">
                <button type="button" aria-label="Move up" disabled={idx === 0}
                  onClick={() => move(g.id, -1)}
                  className="text-slate-300 hover:text-slate-600 disabled:opacity-30"><ChevronUp className="w-3.5 h-3.5" /></button>
                <button type="button" aria-label="Move down" disabled={idx === ordered.length - 1}
                  onClick={() => move(g.id, 1)}
                  className="text-slate-300 hover:text-slate-600 disabled:opacity-30"><ChevronDown className="w-3.5 h-3.5" /></button>
              </div>
              <input
                value={g.name}
                onChange={(e) => rename(g.id, e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                className="flex-1 text-sm px-2 py-1 border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900"
              />
              <div className="flex items-center gap-1">
                {GROUP_PALETTE.map((c) => (
                  <button key={c} type="button" aria-label={c} onClick={() => recolor(g.id, c)}
                    className={`w-5 h-5 rounded-full ${SWATCH[c]} ${g.color === c ? 'ring-2 ring-offset-1 ring-slate-400' : ''}`} />
                ))}
              </div>
              <span className="text-[11px] text-tertiary tabular-nums w-14 text-right">
                {g.memberSkus.length} SKU{g.memberSkus.length === 1 ? '' : 's'}
              </span>
              <button type="button" aria-label="Delete group" onClick={() => del(g.id)}
                className="text-slate-300 hover:text-red-500"><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
        </div>

        <div className="px-4 py-3 border-t border-default dark:border-slate-700 flex justify-end">
          <button type="button" onClick={commitAndClose} className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-700">Done</button>
        </div>
      </div>
    </div>
  )
}
