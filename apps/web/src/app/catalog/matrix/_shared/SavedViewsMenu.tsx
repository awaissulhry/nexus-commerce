'use client'

/**
 * PIM C.6 — Saved views menu.
 *
 * Header dropdown listing built-in + custom views. Clicking a view
 * applies it (parent receives id via onApply and pushes column/search
 * state). Operator can save current state as a new custom view via
 * an inline name prompt, or delete a custom view.
 *
 * Built-in views are read-only; the delete affordance is hidden for
 * them. Saving over a built-in name is allowed; the new view goes
 * into the custom list with the same name.
 */

import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  Eye,
  Plus,
  Trash2,
  BookMarked,
  Bookmark,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  BUILTIN_VIEWS,
  loadCustomViews,
  createCustomView,
  deleteCustomView,
  type SavedView,
} from './savedViews'

interface Props {
  activeViewId: string | null
  onApply: (view: SavedView) => void
  /** Snapshot of current matrix state used when operator hits "Save
   *  current as view…" */
  currentState: {
    columnIds: string[]
    search: string
  }
}

export default function SavedViewsMenu({ activeViewId, onApply, currentState }: Props) {
  const [open, setOpen] = useState(false)
  const [customViews, setCustomViews] = useState<SavedView[]>([])
  const [naming, setNaming] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draftName, setDraftName] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  // C.6b — fetch custom views server-side. Refresh whenever the menu
  // opens so cross-operator changes appear without a page reload.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void loadCustomViews().then((views) => {
      if (!cancelled) setCustomViews(views)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setNaming(false)
      }
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [open])

  const allViews = [...BUILTIN_VIEWS, ...customViews]
  const activeView = allViews.find((v) => v.id === activeViewId) ?? null

  const handleApply = (v: SavedView) => {
    onApply(v)
    setOpen(false)
  }

  const handleSaveAs = async () => {
    const name = draftName.trim()
    if (name === '') return
    setSaving(true)
    try {
      const v = await createCustomView({
        name,
        columnIds: currentState.columnIds,
        search: currentState.search,
      })
      if (!v) return // toast covered by parent caller's onApply path
      setCustomViews((prev) => [...prev, v])
      setDraftName('')
      setNaming(false)
      onApply(v)
      setOpen(false)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    const ok = await deleteCustomView(id)
    if (!ok) return
    setCustomViews((prev) => prev.filter((v) => v.id !== id))
    // If the deleted view was active, fall back to built-in default.
    if (id === activeViewId) {
      onApply(BUILTIN_VIEWS[0])
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        <BookMarked className="w-3 h-3" />
        <span className="text-xs">{activeView?.name ?? 'View'}</span>
        <ChevronDown className="w-3 h-3" />
      </button>

      {open && (
        <div
          className={cn(
            'absolute right-0 top-full mt-1 z-30 w-64',
            'bg-white dark:bg-zinc-900 rounded-lg shadow-xl',
            'border border-zinc-200 dark:border-zinc-800',
          )}
        >
          <div className="px-3 py-2 border-b border-zinc-100 dark:border-zinc-800 text-[10px] uppercase tracking-wide text-zinc-500 font-semibold">
            Built-in
          </div>
          {BUILTIN_VIEWS.map((v) => (
            <ViewRow
              key={v.id}
              view={v}
              active={v.id === activeViewId}
              onApply={handleApply}
            />
          ))}

          {customViews.length > 0 && (
            <>
              <div className="px-3 py-2 border-t border-zinc-100 dark:border-zinc-800 text-[10px] uppercase tracking-wide text-zinc-500 font-semibold">
                My views
              </div>
              {customViews.map((v) => (
                <ViewRow
                  key={v.id}
                  view={v}
                  active={v.id === activeViewId}
                  onApply={handleApply}
                  onDelete={(id) => void handleDelete(id)}
                />
              ))}
            </>
          )}

          <div className="border-t border-zinc-100 dark:border-zinc-800">
            {naming ? (
              <div className="p-2 flex items-center gap-1.5">
                <input
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  placeholder="View name…"
                  className="flex-1 px-2 py-1 text-xs rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-blue-400"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void handleSaveAs()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      setNaming(false)
                      setDraftName('')
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => void handleSaveAs()}
                  disabled={draftName.trim() === '' || saving}
                  className="px-2 py-1 text-xs rounded bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300 disabled:opacity-40"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setNaming(true)}
                className="w-full px-3 py-2 text-left text-xs text-blue-600 hover:bg-zinc-50 dark:hover:bg-zinc-800 inline-flex items-center gap-1.5"
              >
                <Plus className="w-3 h-3" />
                Save current as view…
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ViewRow({
  view,
  active,
  onApply,
  onDelete,
}: {
  view: SavedView
  active: boolean
  onApply: (view: SavedView) => void
  onDelete?: (id: string) => void
}) {
  return (
    <div
      className={cn(
        'group flex items-center justify-between px-3 py-1.5 text-sm cursor-pointer',
        'hover:bg-zinc-50 dark:hover:bg-zinc-800',
        active && 'bg-blue-50 dark:bg-blue-900/20',
      )}
      onClick={() => onApply(view)}
    >
      <div className="flex items-center gap-2 min-w-0">
        {active ? (
          <Eye className="w-3 h-3 text-blue-600 flex-shrink-0" />
        ) : (
          <Bookmark className="w-3 h-3 text-zinc-400 flex-shrink-0" />
        )}
        <span className="truncate text-zinc-800 dark:text-zinc-200">{view.name}</span>
      </div>
      {onDelete && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onDelete(view.id)
          }}
          aria-label={`Delete ${view.name}`}
          className="opacity-0 group-hover:opacity-100 text-zinc-400 hover:text-red-600 transition-opacity"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      )}
    </div>
  )
}
