'use client'

// MC.2.4 — saved views dropdown.
//
// Sits next to the Filters button in the toolbar. Lists saved views
// + "Save current view…" + per-row delete. Clicking a row applies
// it (search + filter overwrite). Persistence is localStorage today;
// server-side SavedView model lands when MC.2 promotes it.
//
// State pattern: this component owns the open/closed dropdown state,
// the parent owns search + filter. apply() calls back to the parent
// which sets both setters. Save asks for a name via prompt() —
// minimal UX in this commit; MC.2-follow-up replaces with an inline
// rename row.

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Bookmark, Plus, Trash2, Check } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useTranslations } from '@/lib/i18n/use-translations'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import {
  listSavedViews,
  createSavedView,
  deleteSavedView,
  type SavedView,
  type SavedViewPayload,
} from '../_lib/saved-views'
import type { FilterState } from './FilterSidebar'

interface Props {
  search: string
  filter: FilterState
  onApply: (search: string, filter: FilterState) => void
}

export default function SavedViewsMenu({
  search,
  filter,
  onApply,
}: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const confirm = useConfirm()
  const [open, setOpen] = useState(false)
  const [views, setViews] = useState<SavedView[]>([])
  const containerRef = useRef<HTMLDivElement>(null)

  const refresh = () => setViews(listSavedViews())

  useEffect(() => {
    refresh()
  }, [])

  useEffect(() => {
    if (!open) return
    refresh()
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const saveCurrent = () => {
    const name = window.prompt(t('marketingContent.savedViews.namePrompt'))
    if (!name?.trim()) return
    const payload: SavedViewPayload = { search, filter }
    createSavedView(name, payload)
    toast.success(
      t('marketingContent.savedViews.saved', { name: name.trim() }),
    )
    refresh()
  }

  const onDelete = async (view: SavedView) => {
    const ok = await confirm({
      title: t('marketingContent.savedViews.deleteTitle', {
        name: view.name,
      }),
      description: t('marketingContent.savedViews.deleteBody'),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!ok) return
    deleteSavedView(view.id)
    refresh()
  }

  // Match a saved view against the current state — used to mark the
  // active row with a checkmark so the operator knows what they're
  // viewing.
  const currentMatchesView = (v: SavedView): boolean => {
    if (v.search !== search) return false
    if (v.filter.usage !== filter.usage) return false
    if (v.filter.dateRange !== filter.dateRange) return false
    if (v.filter.missingAlt !== filter.missingAlt) return false
    if (v.filter.types.length !== filter.types.length) return false
    if (v.filter.sources.length !== filter.sources.length) return false
    const aTypes = new Set(v.filter.types)
    if (filter.types.some((t) => !aTypes.has(t))) return false
    const aSources = new Set(v.filter.sources)
    if (filter.sources.some((s) => !aSources.has(s))) return false
    return true
  }

  return (
    <div ref={containerRef} className="relative">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Bookmark className="w-4 h-4" />
        <span className="hidden sm:inline ml-1">
          {t('marketingContent.savedViews.button')}
        </span>
        <ChevronDown className="w-3.5 h-3.5 ml-1 opacity-60" />
      </Button>
      {open && (
        <div
          role="listbox"
          aria-label={t('marketingContent.savedViews.listLabel')}
          className="absolute right-0 top-full z-30 mt-1 w-72 rounded-md border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          <button
            type="button"
            onClick={() => {
              saveCurrent()
              setOpen(false)
            }}
            className="flex w-full items-center gap-2 border-b border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            <Plus className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <span className="flex-1 text-left font-medium">
              {t('marketingContent.savedViews.saveCurrent')}
            </span>
          </button>
          {views.length === 0 ? (
            <p className="px-3 py-3 text-xs text-slate-500 dark:text-slate-400">
              {t('marketingContent.savedViews.empty')}
            </p>
          ) : (
            <ul className="max-h-72 overflow-y-auto py-1">
              {views.map((v) => {
                const active = currentMatchesView(v)
                return (
                  <li key={v.id}>
                    <div
                      className={`flex items-center gap-1 px-1.5 py-1 ${
                        active
                          ? 'bg-blue-50 dark:bg-blue-950/40'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800'
                      }`}
                    >
                      <button
                        type="button"
                        role="option"
                        aria-selected={active}
                        onClick={() => {
                          onApply(v.search, v.filter)
                          setOpen(false)
                        }}
                        className="flex flex-1 items-center gap-2 px-1.5 py-0.5 text-left text-sm text-slate-700 dark:text-slate-200"
                      >
                        <Check
                          className={`w-3.5 h-3.5 flex-shrink-0 ${
                            active
                              ? 'text-blue-600 dark:text-blue-400'
                              : 'text-transparent'
                          }`}
                        />
                        <span className="truncate">{v.name}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete(v)}
                        aria-label={t(
                          'marketingContent.savedViews.deleteAriaLabel',
                          { name: v.name },
                        )}
                        className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-slate-800 dark:hover:text-red-400"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
