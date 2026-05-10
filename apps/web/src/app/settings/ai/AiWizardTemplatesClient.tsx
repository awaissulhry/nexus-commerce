'use client'

/**
 * WT.5b (list-wizard) — admin UI for WizardTemplate rows.
 *
 * Closes Wave 6 wizard templates. WT.1 / 2 / 3 / 4 landed schema +
 * routes + Apply picker + Save-as-template; this lets operators
 * rename / re-describe / delete the templates they've saved (and
 * inspect — but not edit — built-in seeds).
 *
 * v1 scope:
 *   - List rows, built-in first then operator templates by recency
 *   - Per-row: name + builtIn pill + usage count + channel chips
 *   - Expand → channel detail + defaults JSON preview
 *   - Edit name + description + categoryHint inline (non-builtIn)
 *   - Delete (non-builtIn, with confirm)
 *   - Refresh button
 *
 * Out of scope (deferred):
 *   - Re-shape channels / defaults (delete + re-save from fresh
 *     wizard is the path)
 *   - Per-template usage analytics surface
 */

import { useCallback, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Layers,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'

export interface WizardTemplateRow {
  id: string
  name: string
  description: string | null
  channels: Array<{ platform: string; marketplace: string }>
  defaults: Record<string, unknown>
  builtIn: boolean
  categoryHint: string | null
  usageCount: number
  lastUsedAt: string | null
  createdAt: string
  updatedAt: string
  createdBy: string | null
}

interface Props {
  initialRows: WizardTemplateRow[]
}

const fmtRelative = (iso: string | null): string => {
  if (!iso) return 'never'
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

export default function AiWizardTemplatesClient({ initialRows }: Props) {
  const { toast } = useToast()
  const confirm = useConfirm()

  const [rows, setRows] = useState<WizardTemplateRow[]>(initialRows)
  const [refreshing, setRefreshing] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<{
    name: string
    description: string
    categoryHint: string
  }>({
    name: '',
    description: '',
    categoryHint: '',
  })

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/wizard-templates`, {
        cache: 'no-store',
      })
      if (res.ok) {
        const json = await res.json()
        setRows(Array.isArray(json?.rows) ? json.rows : [])
      }
    } finally {
      setRefreshing(false)
    }
  }, [])

  const setRowBusy = useCallback((id: string, isBusy: boolean) => {
    setBusy((prev) => {
      const next = new Set(prev)
      if (isBusy) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const startEdit = useCallback((row: WizardTemplateRow) => {
    setEditing(row.id)
    setDraft({
      name: row.name,
      description: row.description ?? '',
      categoryHint: row.categoryHint ?? '',
    })
  }, [])

  const cancelEdit = useCallback(() => {
    setEditing(null)
    setDraft({ name: '', description: '', categoryHint: '' })
  }, [])

  const saveEdit = useCallback(
    async (row: WizardTemplateRow) => {
      if (draft.name.trim().length === 0) return
      setRowBusy(row.id, true)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/wizard-templates/${row.id}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: draft.name.trim(),
              description: draft.description.trim(),
              categoryHint: draft.categoryHint.trim(),
            }),
          },
        )
        const json = await res.json()
        if (!res.ok) {
          toast({
            tone: 'error',
            title: 'Template save failed',
            description: json?.error ?? `HTTP ${res.status}`,
            durationMs: 6000,
          })
          return
        }
        if (json?.row) {
          setRows((prev) =>
            prev.map((r) =>
              r.id === row.id ? (json.row as WizardTemplateRow) : r,
            ),
          )
        }
        cancelEdit()
        toast({
          tone: 'success',
          title: 'Template saved',
          durationMs: 2400,
        })
      } catch (err) {
        toast({
          tone: 'error',
          title: 'Template save failed',
          description: err instanceof Error ? err.message : String(err),
          durationMs: 6000,
        })
      } finally {
        setRowBusy(row.id, false)
      }
    },
    [draft, cancelEdit, setRowBusy, toast],
  )

  const deleteRow = useCallback(
    async (row: WizardTemplateRow) => {
      const ok = await confirm({
        title: `Delete "${row.name}"?`,
        description: `Removes this template. Any wizard that already applied it keeps its current state — only the template itself is removed. Used ${row.usageCount}× before deletion.`,
        confirmLabel: 'Delete template',
        tone: 'danger',
      })
      if (!ok) return
      setRowBusy(row.id, true)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/wizard-templates/${row.id}`,
          { method: 'DELETE' },
        )
        if (!res.ok) {
          const json = await res.json().catch(() => ({}))
          toast({
            tone: 'error',
            title: 'Delete failed',
            description: json?.error ?? `HTTP ${res.status}`,
            durationMs: 6000,
          })
          return
        }
        setRows((prev) => prev.filter((r) => r.id !== row.id))
        toast({
          tone: 'success',
          title: 'Template deleted',
          durationMs: 2400,
        })
      } catch (err) {
        toast({
          tone: 'error',
          title: 'Delete failed',
          description: err instanceof Error ? err.message : String(err),
          durationMs: 6000,
        })
      } finally {
        setRowBusy(row.id, false)
      }
    },
    [confirm, setRowBusy, toast],
  )

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-md font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider inline-flex items-center gap-1.5">
          <Layers className="w-3 h-3" />
          Wizard templates
        </h2>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5 disabled:opacity-50"
        >
          {refreshing ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <RefreshCw className="w-3 h-3" />
          )}
          Refresh
        </button>
      </div>
      <div className="text-sm text-slate-500 dark:text-slate-400">
        Pre-built channel + state combos for the listing wizard. Built-
        in seeds are read-only; operator-saved templates can be
        renamed / re-described / deleted here. Operators apply them
        on Step 1 of the wizard and save new ones from Step 9.
      </div>

      {rows.length === 0 ? (
        <div className="border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900 px-4 py-6 text-center text-base text-slate-500 dark:text-slate-400 italic">
          No templates yet. The 5 built-in seeds land via the
          WT.1 migration; check that it&apos;s applied.
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const isExpanded = expanded.has(row.id)
            const isBusy = busy.has(row.id)
            const isEditing = editing === row.id
            return (
              <li
                key={row.id}
                className="border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900"
              >
                <div className="px-3 py-2 flex items-start justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => toggleExpand(row.id)}
                    className="flex-1 min-w-0 text-left flex items-start gap-2"
                  >
                    {isExpanded ? (
                      <ChevronDown className="w-4 h-4 mt-0.5 text-slate-400 dark:text-slate-500 flex-shrink-0" />
                    ) : (
                      <ChevronRight className="w-4 h-4 mt-0.5 text-slate-400 dark:text-slate-500 flex-shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-md font-medium text-slate-900 dark:text-slate-100">
                          {row.name}
                        </span>
                        {row.builtIn && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400">
                            built-in
                          </span>
                        )}
                        {row.categoryHint && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-mono font-medium border bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-900 text-blue-700 dark:text-blue-300">
                            {row.categoryHint}
                          </span>
                        )}
                        <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                          used {row.usageCount}× · last{' '}
                          {fmtRelative(row.lastUsedAt)}
                        </span>
                      </div>
                      {row.description && (
                        <div className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
                          {row.description}
                        </div>
                      )}
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {row.channels.map((c, i) => (
                          <span
                            key={`${c.platform}:${c.marketplace}:${i}`}
                            className="inline-flex items-center h-5 px-1.5 rounded text-xs font-mono font-medium border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300"
                          >
                            {c.platform}
                            {c.marketplace !== 'GLOBAL' && (
                              <>
                                <span className="opacity-50 mx-0.5">·</span>
                                <span>{c.marketplace}</span>
                              </>
                            )}
                          </span>
                        ))}
                      </div>
                    </div>
                  </button>
                  {!row.builtIn && !isEditing && (
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => startEdit(row)}
                        disabled={isBusy}
                      >
                        Edit
                      </Button>
                      <button
                        type="button"
                        onClick={() => void deleteRow(row)}
                        disabled={isBusy}
                        aria-label="Delete template"
                        className="text-rose-600 hover:text-rose-800 dark:text-rose-400 dark:hover:text-rose-300 disabled:opacity-40"
                      >
                        {isBusy ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  )}
                </div>

                {isEditing && !row.builtIn && (
                  <div className="ml-6 mr-3 mb-3 space-y-2 border border-slate-200 dark:border-slate-700 rounded-md bg-slate-50 dark:bg-slate-800/40 p-3">
                    <input
                      type="text"
                      value={draft.name}
                      onChange={(e) =>
                        setDraft((p) => ({ ...p, name: e.target.value }))
                      }
                      placeholder="Template name"
                      className="w-full h-8 px-2 text-base border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900"
                      autoFocus
                    />
                    <textarea
                      value={draft.description}
                      onChange={(e) =>
                        setDraft((p) => ({
                          ...p,
                          description: e.target.value,
                        }))
                      }
                      placeholder="Description"
                      rows={2}
                      className="w-full px-2 py-1 text-base border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900"
                    />
                    <input
                      type="text"
                      value={draft.categoryHint}
                      onChange={(e) =>
                        setDraft((p) => ({
                          ...p,
                          categoryHint: e.target.value,
                        }))
                      }
                      placeholder="Category hint (e.g. helmet)"
                      className="w-full h-8 px-2 text-base border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900"
                    />
                    <div className="flex items-center gap-2">
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => void saveEdit(row)}
                        disabled={
                          isBusy || draft.name.trim().length === 0
                        }
                      >
                        {isBusy ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : null}
                        Save
                      </Button>
                      <button
                        type="button"
                        onClick={cancelEdit}
                        disabled={isBusy}
                        className="text-sm text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Channels and defaults are fixed at create time.
                      To re-shape, delete + save a new template from
                      a fresh wizard.
                    </p>
                  </div>
                )}

                {isExpanded && !isEditing && (
                  <div className="ml-6 mr-3 mb-3 space-y-2">
                    <div className="text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wider">
                      Defaults
                    </div>
                    <pre
                      className={cn(
                        'whitespace-pre-wrap font-mono text-xs px-2 py-1.5 border rounded',
                        'border-slate-200 dark:border-slate-700',
                        'bg-slate-50 dark:bg-slate-900',
                      )}
                    >
                      {JSON.stringify(row.defaults, null, 2)}
                    </pre>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
