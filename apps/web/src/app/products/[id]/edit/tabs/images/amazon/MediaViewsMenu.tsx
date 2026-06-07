'use client'

// MM.7 — server-saved view layouts. Named, cross-device column layouts for the
// Amazon matrix, persisted via the generic /api/saved-views CRUD with
// surface='product-media'. The view's `filters` JSON holds the ColPref[] layout.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Bookmark, Trash2, Plus, ChevronDown, Loader2 } from 'lucide-react'
import { beFetch } from '../api'
import type { ColPref } from './matrixColumnPrefs'

interface SavedView {
  id: string
  name: string
  filters: ColPref[]
  isDefault: boolean
}

export function MediaViewsMenu({
  currentPrefs,
  onApply,
}: {
  currentPrefs: ColPref[]
  onApply: (prefs: ColPref[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [views, setViews] = useState<SavedView[]>([])
  const [loading, setLoading] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await beFetch('/api/saved-views?surface=product-media')
      const d = await res.json()
      setViews(
        (d.items ?? []).map((v: { id: string; name: string; filters: ColPref[]; isDefault: boolean }) => ({
          id: v.id,
          name: v.name,
          filters: v.filters,
          isDefault: v.isDefault,
        })),
      )
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  async function saveCurrent() {
    const name = window.prompt('Save current column layout as:')
    if (!name?.trim()) return
    try {
      const res = await beFetch('/api/saved-views', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surface: 'product-media', name: name.trim(), filters: currentPrefs }),
      })
      if (res.status === 409) {
        window.alert('A view with this name already exists')
        return
      }
      await load()
    } catch {
      /* ignore */
    }
  }

  async function remove(id: string) {
    try {
      await beFetch(`/api/saved-views/${id}`, { method: 'DELETE' })
      await load()
    } catch {
      /* ignore */
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700"
      >
        <Bookmark className="w-3.5 h-3.5" /> Views <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div className="absolute z-40 mt-1 w-60 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl p-1.5 text-sm">
          <button
            type="button"
            onClick={saveCurrent}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <Plus className="w-3.5 h-3.5 text-slate-400" /> Save current layout…
          </button>
          <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
          {loading ? (
            <div className="px-2 py-2 text-xs text-slate-400 flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
            </div>
          ) : views.length === 0 ? (
            <div className="px-2 py-2 text-xs text-slate-400">No saved views yet</div>
          ) : (
            views.map((v) => (
              <div key={v.id} className="group flex items-center gap-1 rounded-lg px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800">
                <button type="button" onClick={() => { onApply(v.filters); setOpen(false) }} className="flex-1 text-left truncate">
                  {v.name}
                  {v.isDefault && <span className="ml-1 text-[10px] text-emerald-600">default</span>}
                </button>
                <button
                  type="button"
                  onClick={() => remove(v.id)}
                  title="Delete view"
                  className="text-slate-300 hover:text-rose-600 opacity-0 group-hover:opacity-100"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
