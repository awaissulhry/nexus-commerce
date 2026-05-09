'use client'

/**
 * L.15.1 — saved-search picker.
 *
 * Reusable dropdown + save button for any /sync-logs sub-route. The
 * surface prop scopes the saved searches to the calling page so each
 * surface's dropdown only shows relevant pinned filter sets.
 *
 *   <SavedSearchPicker
 *     surface="api-calls"
 *     currentFilters={{ channel: urlChannel, errorType: urlErrorType, ... }}
 *     onApply={(filters) => updateUrl(filters)}
 *   />
 *
 * Backed by /api/sync-logs/saved-searches. The picker fetches the
 * list once on mount + after every save/delete.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BookmarkPlus,
  Bookmark,
  ChevronDown,
  Loader2,
  Trash2,
  X,
} from 'lucide-react'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'

export type Surface = 'api-calls' | 'errors' | 'webhooks'

export interface SavedSearch {
  id: string
  name: string
  surface: Surface
  filters: Record<string, string>
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export default function SavedSearchPicker({
  surface,
  currentFilters,
  onApply,
}: {
  surface: Surface
  currentFilters: Record<string, string>
  onApply: (filters: Record<string, string>) => void
}) {
  const { toast } = useToast()
  const { t } = useTranslations()
  const [items, setItems] = useState<SavedSearch[]>([])
  const [open, setOpen] = useState(false)
  const [savePromptOpen, setSavePromptOpen] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const fetchList = useCallback(async () => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/sync-logs/saved-searches?surface=${surface}`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { items: SavedSearch[] }
      setItems(json.items)
    } catch {
      // Silent — picker is non-critical UX
    }
  }, [surface])

  useEffect(() => {
    void fetchList()
  }, [fetchList])

  // Close dropdowns on outside click.
  useEffect(() => {
    if (!open && !savePromptOpen) return
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
        setSavePromptOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, savePromptOpen])

  const save = useCallback(async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      // Strip empty values so the saved filter set is minimal —
      // operators don't want every saved search to reset every URL
      // param to its empty default on apply.
      const filters: Record<string, string> = {}
      for (const [k, v] of Object.entries(currentFilters)) {
        if (v) filters[k] = v
      }
      const res = await fetch(
        `${getBackendUrl()}/api/sync-logs/saved-searches`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim(), surface, filters }),
        },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast.success(t('syncLogs.savedSearch.savedToast', { name: name.trim() }))
      setName('')
      setSavePromptOpen(false)
      void fetchList()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [name, surface, currentFilters, fetchList, toast, t])

  const remove = useCallback(
    async (id: string, displayName: string) => {
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/sync-logs/saved-searches/${id}`,
          { method: 'DELETE' },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        toast.success(t('syncLogs.savedSearch.deletedToast', { name: displayName }))
        void fetchList()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e))
      }
    },
    [fetchList, toast, t],
  )

  return (
    <div className="relative inline-flex items-center gap-1" ref={containerRef}>
      {/* Saved-list dropdown */}
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v)
          setSavePromptOpen(false)
        }}
        disabled={items.length === 0}
        className={cn(
          'h-7 px-2 text-sm font-medium rounded border inline-flex items-center gap-1.5 transition-colors',
          'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800',
          'hover:border-slate-300 dark:hover:border-slate-700',
          'disabled:opacity-50 disabled:cursor-not-allowed',
        )}
        title={
          items.length === 0
            ? t('syncLogs.savedSearch.tooltipNoSaved')
            : t('syncLogs.savedSearch.tooltipApply')
        }
      >
        <Bookmark className="w-3 h-3" />
        {t('syncLogs.savedSearch.saved')}{' '}
        {items.length > 0 && <span className="opacity-70">{items.length}</span>}
        <ChevronDown className="w-3 h-3" />
      </button>

      {/* Save-current-filters button */}
      <button
        type="button"
        onClick={() => {
          setSavePromptOpen((v) => !v)
          setOpen(false)
        }}
        className={cn(
          'h-7 px-2 text-sm font-medium rounded border inline-flex items-center gap-1.5 transition-colors',
          'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800',
          'hover:border-slate-300 dark:hover:border-slate-700',
        )}
        title={t('syncLogs.savedSearch.tooltipSave')}
      >
        <BookmarkPlus className="w-3 h-3" />
        {t('syncLogs.savedSearch.save')}
      </button>

      {/* Saved-list popover */}
      {open && items.length > 0 && (
        <div className="absolute top-9 right-0 z-20 w-72 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-lg overflow-hidden">
          <ul className="max-h-72 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
            {items.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-2 px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <button
                  type="button"
                  onClick={() => {
                    onApply(s.filters)
                    setOpen(false)
                  }}
                  className="flex-1 min-w-0 text-left"
                >
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                    {s.name}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-500 mt-0.5 truncate font-mono">
                    {Object.entries(s.filters)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(' · ') || t('syncLogs.savedSearch.noFilters')}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => void remove(s.id, s.name)}
                  className="p-1 text-slate-400 hover:text-rose-600 dark:hover:text-rose-400"
                  title={t('syncLogs.savedSearch.tooltipDelete')}
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Save-prompt popover */}
      {savePromptOpen && (
        <div className="absolute top-9 right-0 z-20 w-72 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-lg p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">
              {t('syncLogs.savedSearch.savePromptHeading')}
            </span>
            <button
              type="button"
              onClick={() => setSavePromptOpen(false)}
              className="p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-300"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
              if (e.key === 'Escape') setSavePromptOpen(false)
            }}
            placeholder={t('syncLogs.savedSearch.savePromptPlaceholder')}
            autoFocus
            className="w-full px-2 py-1 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:border-slate-400 dark:focus:border-slate-500"
          />
          <div className="text-xs text-slate-500 dark:text-slate-500 mt-1.5 font-mono truncate">
            {Object.entries(currentFilters)
              .filter(([, v]) => v)
              .map(([k, v]) => `${k}=${v}`)
              .join(' · ') || t('syncLogs.savedSearch.noFiltersSet')}
          </div>
          <div className="flex justify-end gap-1 mt-2">
            <button
              type="button"
              onClick={() => setSavePromptOpen(false)}
              className="h-7 px-2 text-sm font-medium rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-600"
            >
              {t('syncLogs.savedSearch.savePromptCancel')}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || !name.trim()}
              className="h-7 px-2 text-sm font-medium rounded border border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-1"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              {t('syncLogs.savedSearch.savePromptSave')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
