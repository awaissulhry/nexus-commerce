'use client'

import { useEffect, useRef, useState } from 'react'
import { Bookmark, BookMarked, Check, ChevronDown, Plus, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FFFilterState } from './FFFilterPanel'
import type { ConditionalRule } from '@/app/bulk-operations/lib/conditional-format'

// ── Types ──────────────────────────────────────────────────────────────

interface SortLevel { id: string; colId: string; mode: 'asc' | 'desc' | 'custom'; customOrder: string[] }

export interface FFViewState {
  closedGroups: string[]
  ffFilter: FFFilterState
  sortConfig: SortLevel[]
  cfRules: ConditionalRule[]
  frozenColCount: number
}

export interface FFSavedView {
  id: string
  name: string
  state: FFViewState
  createdAt: number
  isBuiltIn?: boolean
}

// ── Storage ────────────────────────────────────────────────────────────

const STORAGE_KEY = 'ff-saved-views-v1'

const FF_FILTER_DEFAULT: FFFilterState = { parentage: 'any', hasAsin: 'any', missingRequired: false }

const BUILT_IN_VIEWS: FFSavedView[] = [
  {
    id: 'builtin-default',
    name: 'Default',
    isBuiltIn: true,
    createdAt: 0,
    state: { closedGroups: [], ffFilter: FF_FILTER_DEFAULT, sortConfig: [], cfRules: [], frozenColCount: 1 },
  },
  {
    id: 'builtin-missing',
    name: 'Missing required fields',
    isBuiltIn: true,
    createdAt: 0,
    state: { closedGroups: [], ffFilter: { parentage: 'any', hasAsin: 'any', missingRequired: true }, sortConfig: [], cfRules: [], frozenColCount: 1 },
  },
  {
    id: 'builtin-parents',
    name: 'Parents only',
    isBuiltIn: true,
    createdAt: 0,
    state: { closedGroups: [], ffFilter: { parentage: 'parent', hasAsin: 'any', missingRequired: false }, sortConfig: [], cfRules: [], frozenColCount: 1 },
  },
]

function loadViews(): FFSavedView[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as FFSavedView[]) : []
  } catch { return [] }
}

function saveViews(views: FFSavedView[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(views)) } catch {}
}

// ── Props ──────────────────────────────────────────────────────────────

interface Props {
  currentState: FFViewState
  onApply: (state: FFViewState) => void
}

// ── Component ──────────────────────────────────────────────────────────

export function FFSavedViews({ currentState, onApply }: Props) {
  const [open, setOpen] = useState(false)
  const [userViews, setUserViews] = useState<FFSavedView[]>([])
  const [activeId, setActiveId] = useState<string>('builtin-default')
  const [saving, setSaving] = useState(false)
  const [newName, setNewName] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef   = useRef<HTMLDivElement>(null)
  const nameRef    = useRef<HTMLInputElement>(null)

  useEffect(() => { setUserViews(loadViews()) }, [])

  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      if (triggerRef.current?.contains(e.target as Node)) return
      if (panelRef.current?.contains(e.target as Node)) return
      setOpen(false)
      setSaving(false)
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setSaving(false) } }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [open])

  useEffect(() => {
    if (saving && open) nameRef.current?.focus()
  }, [saving, open])

  const allViews = [...BUILT_IN_VIEWS, ...userViews]
  const activeView = allViews.find((v) => v.id === activeId)

  const handleSelect = (view: FFSavedView) => {
    setActiveId(view.id)
    onApply(view.state)
    setOpen(false)
  }

  const handleSave = () => {
    const name = newName.trim()
    if (!name) return
    const view: FFSavedView = {
      id: `view-${Date.now()}`,
      name,
      state: currentState,
      createdAt: Date.now(),
    }
    const next = [...userViews, view]
    setUserViews(next)
    saveViews(next)
    setActiveId(view.id)
    setNewName('')
    setSaving(false)
  }

  const handleDelete = (id: string) => {
    const next = userViews.filter((v) => v.id !== id)
    setUserViews(next)
    saveViews(next)
    if (activeId === id) setActiveId('builtin-default')
  }

  const handleUpdate = (id: string) => {
    const next = userViews.map((v) =>
      v.id === id ? { ...v, state: currentState } : v,
    )
    setUserViews(next)
    saveViews(next)
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => { setOpen((o) => !o); setSaving(false) }}
        className={cn(
          'inline-flex items-center gap-1.5 h-7 px-2 text-xs border rounded-md transition-colors',
          open
            ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
            : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700',
        )}
        title="Saved views"
      >
        <Bookmark className="w-3 h-3" />
        <span className="max-w-[96px] truncate">{activeView?.name ?? 'Views'}</span>
        <ChevronDown className="w-3 h-3 opacity-60" />
      </button>

      {open && (
        <div
          ref={panelRef}
          className="absolute left-0 top-full mt-1 w-64 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg z-30 overflow-hidden"
        >
          {/* Built-in views */}
          <div className="px-2 pt-2 pb-1">
            <div className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider px-1 mb-1">
              Built-in
            </div>
            {BUILT_IN_VIEWS.map((v) => (
              <ViewRow
                key={v.id}
                view={v}
                active={activeId === v.id}
                onSelect={() => handleSelect(v)}
              />
            ))}
          </div>

          {/* User views */}
          {userViews.length > 0 && (
            <div className="px-2 pb-1 border-t border-slate-100 dark:border-slate-800 pt-2">
              <div className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider px-1 mb-1">
                Saved
              </div>
              {userViews.map((v) => (
                <ViewRow
                  key={v.id}
                  view={v}
                  active={activeId === v.id}
                  onSelect={() => handleSelect(v)}
                  onDelete={() => handleDelete(v.id)}
                  onUpdate={() => handleUpdate(v.id)}
                />
              ))}
            </div>
          )}

          {/* Save current */}
          <div className="border-t border-slate-100 dark:border-slate-800 p-2">
            {saving ? (
              <div className="flex items-center gap-1.5">
                <input
                  ref={nameRef}
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSave()
                    if (e.key === 'Escape') { setSaving(false); setNewName('') }
                  }}
                  placeholder="View name…"
                  className="flex-1 h-6 px-2 text-xs border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={!newName.trim()}
                  className="h-6 w-6 inline-flex items-center justify-center rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
                >
                  <Check className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  onClick={() => { setSaving(false); setNewName('') }}
                  className="h-6 w-6 inline-flex items-center justify-center rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setSaving(true)}
                className="w-full inline-flex items-center gap-1.5 h-7 px-2 text-xs text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 rounded transition-colors"
              >
                <Plus className="w-3 h-3" />
                Save current view
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
  onSelect,
  onDelete,
  onUpdate,
}: {
  view: FFSavedView
  active: boolean
  onSelect: () => void
  onDelete?: () => void
  onUpdate?: () => void
}) {
  return (
    <div className="group/vrow flex items-center gap-1 px-1 py-0.5 rounded hover:bg-slate-50 dark:hover:bg-slate-800">
      <button
        type="button"
        onClick={onSelect}
        className="flex-1 flex items-center gap-1.5 text-xs text-left text-slate-700 dark:text-slate-300 truncate"
      >
        {active
          ? <BookMarked className="w-3 h-3 text-blue-500 flex-shrink-0" />
          : <Bookmark className="w-3 h-3 text-slate-300 dark:text-slate-600 flex-shrink-0" />
        }
        <span className={cn('truncate', active && 'font-medium text-blue-600 dark:text-blue-400')}>
          {view.name}
        </span>
      </button>
      {!view.isBuiltIn && (
        <div className="hidden group-hover/vrow:flex items-center gap-0.5">
          {onUpdate && (
            <button
              type="button"
              onClick={onUpdate}
              className="h-5 w-5 inline-flex items-center justify-center rounded text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/30"
              title="Update with current state"
            >
              <Check className="w-3 h-3" />
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              onClick={onDelete}
              className="h-5 w-5 inline-flex items-center justify-center rounded text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
              title="Delete view"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
      )}
    </div>
  )
}
