'use client'

/**
 * W9.6i — Saved-views button + menu (server-backed
 * ReplenishmentSavedView table).
 *
 * Extracted from ReplenishmentWorkspace.tsx. Operator-saved
 * filter+sort presets named bookmarks. Clicking the button opens a
 * menu listing existing views with load / set-default / delete
 * actions. "Save current" form captures the active workspace state
 * passed in via the currentState prop.
 *
 * Adds dark-mode classes throughout the chrome (button surface,
 * menu panel, save form, list rows, action icons).
 */

import { useCallback, useEffect, useState } from 'react'
import { Bookmark, Plus, Loader2, Check, Star, Trash2 } from 'lucide-react'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'

export interface ReplenishmentViewState {
  filter: 'ALL' | 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'NEEDS_REORDER'
  channelFilter: string
  marketplaceFilter: string
  search: string
  sortBy: 'urgency' | 'daysOfCover' | 'velocity' | 'qty' | 'stock' | 'sku' | 'name'
  sortDir: 'asc' | 'desc'
}

interface SavedView {
  id: string
  name: string
  description: string | null
  filterState: ReplenishmentViewState
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

export function SavedViewsButton({
  currentState,
  onLoad,
}: {
  currentState: ReplenishmentViewState
  onLoad: (state: ReplenishmentViewState) => void
}) {
  const { toast } = useToast()
  const askConfirm = useConfirm()
  const [open, setOpen] = useState(false)
  const [views, setViews] = useState<SavedView[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [showSaveForm, setShowSaveForm] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveDefault, setSaveDefault] = useState(false)
  const [saving, setSaving] = useState(false)

  const fetchViews = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment-views`,
        { cache: 'no-store' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const json = await res.json()
      setViews(json.views ?? [])
    } catch (err) {
      toast.error(
        `Load views failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    if (open && views === null) void fetchViews()
  }, [open, views, fetchViews])

  const handleSave = async () => {
    if (!saveName.trim()) {
      toast.error('Name required')
      return
    }
    setSaving(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment-views`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: saveName.trim(),
            filterState: currentState,
            isDefault: saveDefault,
          }),
        },
      )
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      toast.success(`Saved view "${saveName}"`)
      setShowSaveForm(false)
      setSaveName('')
      setSaveDefault(false)
      await fetchViews()
    } catch (err) {
      toast.error(
        `Save failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (view: SavedView) => {
    if (
      !(await askConfirm({
        title: `Delete saved view "${view.name}"?`,
        confirmLabel: 'Delete',
        tone: 'danger',
      }))
    )
      return
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment-views/${view.id}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      toast.success(`Deleted "${view.name}"`)
      await fetchViews()
    } catch (err) {
      toast.error(
        `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const handleSetDefault = async (view: SavedView) => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment-views/${view.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isDefault: !view.isDefault }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      toast.success(
        view.isDefault ? 'Default cleared' : `"${view.name}" set as default`,
      )
      await fetchViews()
    } catch (err) {
      toast.error(
        `Update failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-8 px-2.5 text-base border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5"
      >
        <Bookmark size={12} />
        Views
        {views && views.length > 0 && (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            ({views.length})
          </span>
        )}
      </button>

      {open && (
        <>
          {/* Backdrop closes the menu on outside click */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => {
              setOpen(false)
              setShowSaveForm(false)
            }}
          />
          <div className="absolute right-0 mt-1 z-50 w-72 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md shadow-lg">
            <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide">
                Saved Views
              </span>
              <button
                type="button"
                onClick={() => setShowSaveForm((v) => !v)}
                className="text-sm text-blue-700 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300 inline-flex items-center gap-0.5"
              >
                <Plus size={11} /> Save current
              </button>
            </div>

            {showSaveForm && (
              <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 space-y-2">
                <input
                  type="text"
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  placeholder='e.g. "CRITICAL on Amazon IT"'
                  className="w-full h-7 px-2 text-base border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 rounded"
                  autoFocus
                />
                <label className="flex items-center gap-1.5 text-sm text-slate-700 dark:text-slate-300">
                  <input
                    type="checkbox"
                    checked={saveDefault}
                    onChange={(e) => setSaveDefault(e.target.checked)}
                  />
                  Auto-load on first visit
                </label>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void handleSave()}
                    disabled={saving || !saveName.trim()}
                    className="h-7 px-2.5 text-sm bg-slate-900 dark:bg-slate-700 text-white rounded hover:bg-slate-800 dark:hover:bg-slate-600 disabled:opacity-50 inline-flex items-center gap-1"
                  >
                    {saving ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Check size={11} />
                    )}
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowSaveForm(false)
                      setSaveName('')
                      setSaveDefault(false)
                    }}
                    className="h-7 px-2 text-sm border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 rounded hover:bg-white dark:hover:bg-slate-800"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <div className="max-h-80 overflow-y-auto">
              {loading && (
                <div className="px-3 py-3 text-base text-slate-500 dark:text-slate-400 inline-flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" /> Loading…
                </div>
              )}
              {!loading && views && views.length === 0 && (
                <div className="px-3 py-3 text-sm text-slate-500 dark:text-slate-400 italic">
                  No saved views yet — click "Save current" to add one.
                </div>
              )}
              {!loading && views && views.length > 0 && (
                <ul>
                  {views.map((v) => (
                    <li
                      key={v.id}
                      className="border-b border-slate-100 dark:border-slate-800 last:border-0 group"
                    >
                      <div className="flex items-center gap-1 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                        <button
                          type="button"
                          onClick={() => {
                            onLoad(v.filterState)
                            setOpen(false)
                            toast.success(`Loaded "${v.name}"`)
                          }}
                          className="flex-1 text-left px-3 py-2 min-w-0"
                        >
                          <div className="text-base font-medium text-slate-900 dark:text-slate-100 truncate inline-flex items-center gap-1.5">
                            {v.isDefault && (
                              <Star
                                size={10}
                                className="text-amber-500 fill-amber-500"
                              />
                            )}
                            {v.name}
                          </div>
                          {v.description && (
                            <div className="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">
                              {v.description}
                            </div>
                          )}
                        </button>
                        <div className="opacity-0 group-hover:opacity-100 flex items-center pr-1.5 gap-0.5">
                          <button
                            type="button"
                            onClick={() => void handleSetDefault(v)}
                            title={v.isDefault ? 'Clear default' : 'Set as default'}
                            className="h-6 w-6 flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-amber-600 dark:hover:text-amber-400 rounded"
                          >
                            <Star
                              size={11}
                              className={
                                v.isDefault ? 'fill-amber-500 text-amber-500' : ''
                              }
                            />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDelete(v)}
                            title="Delete"
                            className="h-6 w-6 flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-red-600 dark:hover:text-red-400 rounded"
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
