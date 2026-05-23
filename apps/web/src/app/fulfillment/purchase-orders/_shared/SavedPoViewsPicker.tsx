'use client'

// PO-Plus.7 — User-saved named views for /fulfillment/purchase-orders.
//
// Sits next to the built-in SavedViewChips (Late / Awaiting / This
// week / Drafts / Received). Operator hits "Save view…" to capture
// the current URL search params under a name; the dropdown lists
// every saved view + a Default star. Click any to apply.
//
// Backend is the existing /api/saved-views CRUD with
// surface='purchase-orders'; userId is the placeholder 'default-user'
// until a real auth model lands. The filters JSON is the verbatim
// URLSearchParams string (no fancy deserialization) so future filter
// additions just work without touching this component.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  Bookmark,
  BookmarkPlus,
  Check,
  ChevronDown,
  Loader2,
  Star,
  Trash2,
  X,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface SavedView {
  id: string
  name: string
  filters: { qs: string } // the URLSearchParams string snapshot
  isDefault: boolean
  createdAt: string
}

const SURFACE = 'purchase-orders'

export function SavedPoViewsPicker({
  currentSearchParams,
  onApply,
}: {
  /** The current URLSearchParams.toString() (no leading ?). */
  currentSearchParams: string
  onApply: (qs: string) => void
}) {
  const [views, setViews] = useState<SavedView[] | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showSavePrompt, setShowSavePrompt] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDefault, setNewDefault] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/saved-views?surface=${SURFACE}`,
        { cache: 'no-store' },
      )
      if (res.ok) {
        const data = await res.json()
        setViews(data.items ?? [])
      }
    } catch {
      setViews([])
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Outside-click closes dropdown.
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
        setShowSavePrompt(false)
      }
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  const save = async () => {
    if (!newName.trim()) {
      setError('Name required')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/saved-views`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          surface: SURFACE,
          filters: { qs: currentSearchParams },
          isDefault: newDefault,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      setNewName('')
      setNewDefault(false)
      setShowSavePrompt(false)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const apply = (view: SavedView) => {
    const qs = view.filters?.qs ?? ''
    onApply(qs)
    setOpen(false)
  }

  const remove = async (view: SavedView) => {
    if (!window.confirm(`Delete saved view "${view.name}"?`)) return
    try {
      await fetch(`${getBackendUrl()}/api/saved-views/${view.id}`, {
        method: 'DELETE',
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const setAsDefault = async (view: SavedView) => {
    try {
      await fetch(`${getBackendUrl()}/api/saved-views/${view.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isDefault: !view.isDefault }),
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const count = views?.length ?? 0
  const hasDefault = views?.some((v) => v.isDefault) ?? false

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'h-7 px-2 inline-flex items-center gap-1 text-sm rounded border transition-colors',
          count > 0 || hasDefault
            ? 'border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
            : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800',
        )}
        title="Saved views"
      >
        <Bookmark className="w-3 h-3" />
        Saved
        {count > 0 && <span className="text-xs tabular-nums">{count}</span>}
        <ChevronDown className={cn('w-3 h-3 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-40 w-72 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded shadow-lg">
          <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
              Saved views
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200"
              aria-label="Close"
            >
              <X size={12} />
            </button>
          </div>

          <div className="max-h-64 overflow-y-auto">
            {views == null ? (
              <div className="px-3 py-3 text-sm text-slate-500 dark:text-slate-400 inline-flex items-center gap-2">
                <Loader2 className="w-3 h-3 animate-spin" /> Loading…
              </div>
            ) : views.length === 0 ? (
              <div className="px-3 py-3 text-sm text-slate-500 dark:text-slate-400">
                No saved views yet. Filter the list, then click "Save current"
                below to bookmark this view.
              </div>
            ) : (
              <ul>
                {views.map((v) => (
                  <li
                    key={v.id}
                    className="border-b border-slate-100 dark:border-slate-800 last:border-0 group"
                  >
                    <div className="px-3 py-1.5 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => apply(v)}
                        className="flex-1 text-left text-base text-slate-900 dark:text-slate-100 hover:underline truncate"
                      >
                        {v.name}
                      </button>
                      <button
                        type="button"
                        onClick={() => setAsDefault(v)}
                        className={cn(
                          'h-6 w-6 inline-flex items-center justify-center rounded',
                          v.isDefault
                            ? 'text-amber-500'
                            : 'text-slate-300 dark:text-slate-600 hover:text-amber-500',
                        )}
                        title={v.isDefault ? 'Default view' : 'Make default'}
                      >
                        <Star className="w-3 h-3" fill={v.isDefault ? 'currentColor' : 'none'} />
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(v)}
                        className="h-6 w-6 inline-flex items-center justify-center rounded text-slate-300 dark:text-slate-600 hover:text-rose-600 dark:hover:text-rose-400 opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Delete saved view"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="border-t border-slate-200 dark:border-slate-700">
            {showSavePrompt ? (
              <div className="p-3 space-y-2">
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !busy && newName.trim()) {
                      e.preventDefault()
                      save()
                    }
                  }}
                  placeholder='e.g. "My Acme drafts"'
                  autoFocus
                  className="w-full h-8 px-2 text-base border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900"
                />
                <label className="inline-flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400">
                  <input
                    type="checkbox"
                    checked={newDefault}
                    onChange={(e) => setNewDefault(e.target.checked)}
                    className="w-3.5 h-3.5"
                  />
                  Make default
                </label>
                {error && (
                  <div className="text-sm text-red-700 dark:text-red-300 inline-flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" /> {error}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={save}
                    disabled={busy || !newName.trim()}
                    className="h-7 px-3 text-sm rounded bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 border border-slate-900 hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1"
                  >
                    {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowSavePrompt(false)
                      setNewName('')
                      setError(null)
                    }}
                    disabled={busy}
                    className="h-7 px-3 text-sm rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setShowSavePrompt(true)
                  setError(null)
                }}
                className="w-full px-3 py-2 text-sm text-left text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5"
              >
                <BookmarkPlus className="w-3.5 h-3.5" />
                Save current view…
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
