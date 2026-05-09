'use client'

/**
 * W5.3 — Template library + apply panel.
 *
 * Two surfaces in one component:
 *
 *   1. Browse: list of saved BulkActionTemplate rows, sorted by
 *      most-used. Click one to "load" it into the modal — fills the
 *      operation type / channel / actionPayload from the template
 *      and prompts the operator for any required parameters.
 *
 *   2. Save: when the operator has dialled an operation in but
 *      hasn't run it yet, "Save as template" captures the current
 *      modal state into a new template row.
 *
 * The component is presentational and self-contained: the parent
 * passes the current modal state in + receives the loaded template
 * out via callbacks. All template fetches go through /api/bulk-
 * action-templates.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  BookMarked,
  Copy,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

export interface ParameterDecl {
  name: string
  label: string
  type: 'string' | 'number' | 'select' | 'boolean'
  defaultValue?: unknown
  required?: boolean
  helpText?: string
  min?: number
  max?: number
  options?: string[]
}

export interface ServerTemplate {
  id: string
  name: string
  description: string | null
  actionType: string
  channel: string | null
  actionPayload: Record<string, unknown>
  defaultFilters: Record<string, unknown> | null
  parameters: ParameterDecl[]
  category: string | null
  userId: string | null
  isBuiltin: boolean
  usageCount: number
  lastUsedAt: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface TemplateLibraryProps {
  open: boolean
  onClose: () => void
  /** Called when the operator picks a template to load into the
   *  modal. The modal fills its op type / payload from the template
   *  and shows the parameter inputs (if any) inline. */
  onSelect: (template: ServerTemplate) => void
  /** Current modal state, passed in so "Save as template" can
   *  capture it into a new row. Empty when no operation is dialled
   *  in yet — the Save button is disabled in that case. */
  currentDraft?: {
    actionType: string
    channel: string | null
    actionPayload: Record<string, unknown>
    defaultFilters?: Record<string, unknown> | null
  } | null
}

const CATEGORY_LABELS: Record<string, string> = {
  pricing: 'Pricing',
  inventory: 'Inventory',
  status: 'Status',
  translation: 'Translation',
  cleanup: 'Cleanup',
  channel: 'Channel sync',
  other: 'Other',
}

export function TemplateLibrary(props: TemplateLibraryProps) {
  const { open, onClose, onSelect, currentDraft } = props
  const [templates, setTemplates] = useState<ServerTemplate[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [activeTab, setActiveTab] = useState<'browse' | 'save'>('browse')
  const [saveName, setSaveName] = useState('')
  const [saveDescription, setSaveDescription] = useState('')
  const [saveCategory, setSaveCategory] = useState('')
  const [saving, setSaving] = useState(false)

  const fetchTemplates = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/bulk-action-templates`,
        { cache: 'no-store' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const data = await res.json()
      setTemplates(Array.isArray(data.templates) ? data.templates : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      fetchTemplates()
      setActiveTab('browse')
    }
  }, [open, fetchTemplates])

  const filtered = useMemo(() => {
    if (!search.trim()) return templates
    const q = search.toLowerCase()
    return templates.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.description ?? '').toLowerCase().includes(q) ||
        t.actionType.toLowerCase().includes(q) ||
        (t.category ?? '').toLowerCase().includes(q),
    )
  }, [templates, search])

  const grouped = useMemo(() => {
    const buckets = new Map<string, ServerTemplate[]>()
    for (const t of filtered) {
      const key = t.category ?? 'other'
      let arr = buckets.get(key)
      if (!arr) {
        arr = []
        buckets.set(key, arr)
      }
      arr.push(t)
    }
    return buckets
  }, [filtered])

  const handleDelete = async (t: ServerTemplate) => {
    if (t.isBuiltin) return
    if (!confirm(`Delete template "${t.name}"?`)) return
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/bulk-action-templates/${t.id}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      await fetchTemplates()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleDuplicate = async (t: ServerTemplate) => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/bulk-action-templates/${t.id}/duplicate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ namePrefix: 'Copy of ' }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      await fetchTemplates()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSave = async () => {
    if (!currentDraft || !saveName.trim()) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/bulk-action-templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: saveName.trim(),
          description: saveDescription.trim() || null,
          actionType: currentDraft.actionType,
          channel: currentDraft.channel,
          actionPayload: currentDraft.actionPayload,
          defaultFilters: currentDraft.defaultFilters ?? null,
          parameters: [],
          category: saveCategory.trim() || null,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      setSaveName('')
      setSaveDescription('')
      setSaveCategory('')
      await fetchTemplates()
      setActiveTab('browse')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-label="Template library"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-white border border-slate-200 rounded-lg shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <div className="inline-flex items-center gap-2 text-base font-semibold text-slate-700">
            <Sparkles className="w-4 h-4 text-amber-500" />
            Templates
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-7 w-7 inline-flex items-center justify-center text-slate-600 hover:bg-slate-100 rounded"
            aria-label="Close"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="px-4 py-2 border-b border-slate-200 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveTab('browse')}
            className={cn(
              'h-7 px-3 text-xs font-medium rounded transition-colors',
              activeTab === 'browse'
                ? 'bg-blue-100 text-blue-800'
                : 'text-slate-600 hover:bg-slate-100',
            )}
          >
            Browse ({templates.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('save')}
            disabled={!currentDraft}
            title={
              currentDraft
                ? 'Save current operation as template'
                : 'Configure an operation in the modal first'
            }
            className={cn(
              'h-7 px-3 text-xs font-medium rounded transition-colors disabled:opacity-40',
              activeTab === 'save'
                ? 'bg-blue-100 text-blue-800'
                : 'text-slate-600 hover:bg-slate-100',
            )}
          >
            <Plus className="w-3 h-3 inline -mt-0.5 mr-1" />
            Save current
          </button>
        </div>

        {error && (
          <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-sm text-red-700">
            {error}
          </div>
        )}

        {activeTab === 'browse' && (
          <>
            <div className="px-4 py-2 border-b border-slate-200">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search templates…"
                  className="w-full h-7 pl-7 pr-2 text-md border border-slate-200 rounded outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>
            <div className="flex-1 overflow-auto">
              {loading ? (
                <div className="p-6 text-center text-sm text-slate-500">
                  Loading…
                </div>
              ) : filtered.length === 0 ? (
                <div className="p-6 text-center text-sm text-slate-500">
                  {search
                    ? `No templates matching "${search}"`
                    : 'No templates yet — try saving the current operation.'}
                </div>
              ) : (
                Array.from(grouped.entries()).map(([cat, list]) => (
                  <div key={cat} className="border-b border-slate-100 last:border-0">
                    <div className="px-4 py-1.5 bg-slate-50 text-xs font-medium uppercase tracking-wide text-slate-500">
                      {CATEGORY_LABELS[cat] ?? cat}
                    </div>
                    {list.map((t) => (
                      <div
                        key={t.id}
                        className="px-4 py-2 flex items-start gap-2 hover:bg-slate-50 group"
                      >
                        <button
                          type="button"
                          onClick={() => onSelect(t)}
                          className="flex-1 text-left min-w-0"
                        >
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-slate-800 truncate">
                              {t.name}
                            </span>
                            {t.isBuiltin && (
                              <BookMarked
                                className="w-3 h-3 text-amber-500 flex-shrink-0"
                                aria-label="Built-in template"
                              />
                            )}
                            <span className="text-xs text-slate-400 font-mono uppercase tracking-wide flex-shrink-0">
                              {t.actionType.replace(/_/g, ' ')}
                            </span>
                          </div>
                          {t.description && (
                            <div className="text-xs text-slate-500 truncate mt-0.5">
                              {t.description}
                            </div>
                          )}
                          {t.usageCount > 0 && (
                            <div className="text-[10px] text-slate-400 mt-0.5 tabular-nums">
                              Used {t.usageCount} time
                              {t.usageCount === 1 ? '' : 's'}
                              {t.lastUsedAt &&
                                ` · last ${new Date(t.lastUsedAt).toLocaleDateString()}`}
                            </div>
                          )}
                        </button>
                        <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleDuplicate(t)}
                            title="Duplicate"
                            className="h-6 w-6 inline-flex items-center justify-center text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded"
                          >
                            <Copy className="w-3 h-3" />
                          </button>
                          {!t.isBuiltin && (
                            <button
                              type="button"
                              onClick={() => handleDelete(t)}
                              title="Delete"
                              className="h-6 w-6 inline-flex items-center justify-center text-slate-500 hover:text-red-600 hover:bg-red-50 rounded"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          </>
        )}

        {activeTab === 'save' && currentDraft && (
          <div className="p-4 space-y-3 overflow-auto">
            <div className="text-sm text-slate-500">
              Capture the current modal state as a reusable template.
              Parameters can be added by editing the template later.
            </div>
            <label className="block">
              <span className="text-xs font-medium text-slate-600 mb-1 block">
                Name
              </span>
              <input
                type="text"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder="Spring sale 5%"
                className="w-full h-8 px-2 text-sm border border-slate-200 rounded outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600 mb-1 block">
                Description (optional)
              </span>
              <input
                type="text"
                value={saveDescription}
                onChange={(e) => setSaveDescription(e.target.value)}
                placeholder="What this template does"
                className="w-full h-8 px-2 text-sm border border-slate-200 rounded outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600 mb-1 block">
                Category
              </span>
              <select
                value={saveCategory}
                onChange={(e) => setSaveCategory(e.target.value)}
                className="w-full h-8 px-2 text-sm border border-slate-200 rounded bg-white"
              >
                <option value="">(none)</option>
                {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <div className="bg-slate-50 border border-slate-200 rounded p-2 text-xs">
              <div className="font-medium text-slate-700 mb-1">
                Captured operation
              </div>
              <div className="text-slate-600">
                <strong>{currentDraft.actionType.replace(/_/g, ' ')}</strong>
                {currentDraft.channel && ` on ${currentDraft.channel}`}
              </div>
              <pre className="mt-1 text-[10px] text-slate-500 font-mono overflow-x-auto whitespace-pre-wrap">
                {JSON.stringify(currentDraft.actionPayload, null, 2)}
              </pre>
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setActiveTab('browse')}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleSave}
                disabled={!saveName.trim() || saving}
              >
                {saving ? 'Saving…' : 'Save template'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
