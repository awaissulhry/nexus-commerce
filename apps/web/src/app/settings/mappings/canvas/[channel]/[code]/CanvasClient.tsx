'use client'

/**
 * PIM D.4 — Mapping Canvas (two-column visual).
 *
 * Per the vision: "It presents two columns. On the left is the API
 * schema pulled dynamically from Amazon. On the right, the user
 * selects variables from the internal database."
 *
 * UX: click a field on the left to select it, then click a variable
 * on the right to bind it (creates/updates the FieldMappingRule via
 * the existing PUT endpoint). Click an already-mapped field to see
 * its current binding highlighted on the right. Reset clears it via
 * the DELETE endpoint.
 *
 * Drag-drop would be the natural next step (D.4b) but click-to-bind
 * covers the same operator intent without the drag library overhead
 * and stays accessible by default. The two-column layout is the
 * piece the vision called "the secret"; the gesture is just sugar.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  Search,
  Trash2,
  Plus,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Input } from '@/components/ui/Input'
import { useToast } from '@/components/ui/Toast'
import { cn } from '@/lib/utils'
import {
  variablesByGroup,
  type InternalVariable,
  type VariableGroup,
} from './_shared/internalVariables'

interface FieldRow {
  fieldKey: string
  label: string
  maxLength: number | null
  required: boolean
  allowedValues: unknown
  notes: string | null
  rule: { source: string; fallback?: string; required?: boolean } | null
}

interface MarketplaceView {
  channel: string
  code: string
  version: number
  lastSyncedAt: string | null
  schemaSnapshotVersion: string | null
  fields: FieldRow[]
}

interface Props {
  channel: string
  code: string
}

export default function CanvasClient({ channel, code }: Props) {
  const { toast } = useToast()
  const [view, setView] = useState<MarketplaceView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedField, setSelectedField] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [varSearch, setVarSearch] = useState('')
  const [bindingFieldKey, setBindingFieldKey] = useState<string | null>(null)

  // ── Fetch ───────────────────────────────────────────────────────
  const fetchView = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch(
        `${getBackendUrl()}/api/pim/mappings/${channel}/${code}`,
        { cache: 'no-store' },
      )
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = (await r.json()) as MarketplaceView
      setView(data)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [channel, code])

  useEffect(() => {
    void fetchView()
  }, [fetchView])

  // ── Bind / unbind ───────────────────────────────────────────────
  const bindVariable = useCallback(
    async (fieldKey: string, variable: InternalVariable) => {
      setBindingFieldKey(fieldKey)
      try {
        const existing = view?.fields.find((f) => f.fieldKey === fieldKey)
        const rule = {
          source: variable.path,
          required: existing?.rule?.required ?? existing?.required ?? undefined,
          // Preserve fallback if the field already had one, but reset
          // transforms on rebind (operator should re-author them via
          // the flat editor if they want them — canvas keeps simple).
          fallback: existing?.rule?.fallback,
        }
        const r = await fetch(
          `${getBackendUrl()}/api/pim/mappings/${channel}/${code}/${encodeURIComponent(fieldKey)}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rule),
          },
        )
        if (!r.ok) {
          const body = await r.json().catch(() => ({}))
          throw new Error(body?.error ?? `HTTP ${r.status}`)
        }
        toast.success(`Mapped ${fieldKey} → ${variable.label}`)
        await fetchView()
      } catch (e: any) {
        toast.error('Bind failed', { description: e?.message })
      } finally {
        setBindingFieldKey(null)
      }
    },
    [channel, code, view, fetchView, toast],
  )

  const unbindField = useCallback(
    async (fieldKey: string) => {
      try {
        const r = await fetch(
          `${getBackendUrl()}/api/pim/mappings/${channel}/${code}/${encodeURIComponent(fieldKey)}`,
          { method: 'DELETE' },
        )
        if (!r.ok) {
          const body = await r.json().catch(() => ({}))
          throw new Error(body?.error ?? `HTTP ${r.status}`)
        }
        toast.success(`Unmapped ${fieldKey}`)
        await fetchView()
      } catch (e: any) {
        toast.error('Unbind failed', { description: e?.message })
      }
    },
    [channel, code, fetchView, toast],
  )

  // ── Filter ──────────────────────────────────────────────────────
  const filteredFields = useMemo(() => {
    if (!view) return []
    const needle = search.trim().toLowerCase()
    if (!needle) return view.fields
    return view.fields.filter(
      (f) =>
        f.fieldKey.toLowerCase().includes(needle) ||
        f.label.toLowerCase().includes(needle),
    )
  }, [view, search])

  const groupedVars = useMemo(() => variablesByGroup(), [])
  const filteredGroupedVars = useMemo(() => {
    const needle = varSearch.trim().toLowerCase()
    if (!needle) return groupedVars
    const out: Record<VariableGroup, InternalVariable[]> = {
      'Locale content': [],
      Master: [],
      Variant: [],
      'Technical attributes': [],
      Channel: [],
    }
    for (const [g, vars] of Object.entries(groupedVars) as Array<
      [VariableGroup, InternalVariable[]]
    >) {
      out[g] = vars.filter(
        (v) =>
          v.path.toLowerCase().includes(needle) ||
          v.label.toLowerCase().includes(needle),
      )
    }
    return out
  }, [groupedVars, varSearch])

  const selectedRule = view?.fields.find((f) => f.fieldKey === selectedField)?.rule ?? null

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)]">
      {/* Header */}
      <header className="px-6 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/settings/mappings"
            className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
          >
            <ArrowLeft className="w-3 h-3" />
            Mappings
          </Link>
          <div>
            <h1 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              {channel} · {code}
            </h1>
            <p className="text-[11px] text-zinc-500">
              Click an external field on the left, then click an internal variable on the right
              to bind them.
            </p>
          </div>
        </div>
        {view && (
          <span className="text-[11px] text-zinc-500">
            {view.fields.filter((f) => f.rule).length} of {view.fields.length} mapped
          </span>
        )}
      </header>

      {/* Body */}
      {loading && (
        <div className="flex-1 flex items-center justify-center text-zinc-500">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading…
        </div>
      )}
      {error && (
        <div className="m-4 p-3 rounded bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          {error}
        </div>
      )}
      {view && !loading && !error && (
        <div className="flex-1 flex overflow-hidden">
          {/* ── Left: external schema ──────────────────────────── */}
          <section className="flex-1 flex flex-col border-r border-zinc-200 dark:border-zinc-800 overflow-hidden">
            <header className="px-4 py-2 border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50/40 dark:bg-zinc-900/30">
              <div className="flex items-center justify-between mb-1.5">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  External schema ({channel})
                </h2>
              </div>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-400" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search field…"
                  className="pl-6 text-xs"
                />
              </div>
            </header>
            <ul className="flex-1 overflow-y-auto">
              {filteredFields.length === 0 ? (
                <li className="px-4 py-6 text-center text-zinc-500 text-xs italic">
                  {view.fields.length === 0
                    ? 'No schema fields yet — sync from Amazon or use the seed button on the main mappings page.'
                    : 'No fields match the search.'}
                </li>
              ) : (
                filteredFields.map((f) => (
                  <FieldItem
                    key={f.fieldKey}
                    field={f}
                    selected={selectedField === f.fieldKey}
                    onSelect={() =>
                      setSelectedField(selectedField === f.fieldKey ? null : f.fieldKey)
                    }
                    onUnbind={() => void unbindField(f.fieldKey)}
                    binding={bindingFieldKey === f.fieldKey}
                  />
                ))
              )}
            </ul>
          </section>

          {/* ── Right: internal variables ──────────────────────── */}
          <section className="flex-1 flex flex-col overflow-hidden bg-zinc-50/30 dark:bg-zinc-950/40">
            <header className="px-4 py-2 border-b border-zinc-100 dark:border-zinc-800">
              <div className="flex items-center justify-between mb-1.5">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  Internal variables
                </h2>
                {selectedField && (
                  <span className="text-[10px] text-blue-600 dark:text-blue-300">
                    Click a variable to bind →{' '}
                    <span className="font-mono">{selectedField}</span>
                  </span>
                )}
              </div>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-400" />
                <Input
                  value={varSearch}
                  onChange={(e) => setVarSearch(e.target.value)}
                  placeholder="Search variable…"
                  className="pl-6 text-xs"
                />
              </div>
            </header>
            <div className="flex-1 overflow-y-auto">
              {!selectedField && (
                <div className="px-4 py-6 text-xs text-zinc-500 italic text-center">
                  Select an external field on the left to start binding.
                </div>
              )}
              {selectedField &&
                (Object.entries(filteredGroupedVars) as Array<
                  [VariableGroup, InternalVariable[]]
                >).map(([group, vars]) => {
                  if (vars.length === 0) return null
                  return (
                    <div key={group} className="border-b border-zinc-100 dark:border-zinc-800">
                      <div className="px-4 py-1.5 bg-zinc-100/60 dark:bg-zinc-900/60 text-[10px] uppercase tracking-wide font-semibold text-zinc-500">
                        {group}
                      </div>
                      <ul>
                        {vars.map((v) => {
                          const isCurrent = selectedRule?.source === v.path
                          return (
                            <li key={v.path}>
                              <button
                                type="button"
                                onClick={() => void bindVariable(selectedField, v)}
                                disabled={bindingFieldKey === selectedField}
                                className={cn(
                                  'w-full text-left px-4 py-2 hover:bg-blue-50 dark:hover:bg-blue-900/20',
                                  isCurrent && 'bg-emerald-50 dark:bg-emerald-900/20',
                                )}
                              >
                                <div className="flex items-baseline justify-between gap-2">
                                  <span className="text-sm text-zinc-800 dark:text-zinc-200 truncate">
                                    {v.label}
                                  </span>
                                  {isCurrent && (
                                    <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-700 dark:text-emerald-300 font-medium">
                                      <CheckCircle2 className="w-2.5 h-2.5" />
                                      bound
                                    </span>
                                  )}
                                </div>
                                <div className="flex items-baseline justify-between gap-2 mt-0.5">
                                  <code className="text-[10px] text-zinc-500 font-mono truncate">
                                    {v.path}
                                  </code>
                                  <span className="text-[10px] text-zinc-400 truncate">
                                    {v.hint}
                                  </span>
                                </div>
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  )
                })}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

function FieldItem({
  field,
  selected,
  onSelect,
  onUnbind,
  binding,
}: {
  field: FieldRow
  selected: boolean
  onSelect: () => void
  onUnbind: () => void
  binding: boolean
}) {
  const isMapped = field.rule != null
  return (
    <li
      className={cn(
        'border-b border-zinc-100 dark:border-zinc-800/60',
        selected && 'bg-blue-50 dark:bg-blue-900/20',
      )}
    >
      <div className="flex items-start justify-between gap-2 px-4 py-2.5">
        <button
          type="button"
          onClick={onSelect}
          className="flex-1 text-left"
          aria-pressed={selected}
        >
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-xs text-zinc-500">{field.fieldKey}</span>
            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
              {field.label}
            </span>
            {field.required && (
              <span className="text-[10px] px-1 rounded bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">
                required
              </span>
            )}
            {binding && <Loader2 className="w-3 h-3 animate-spin text-blue-600" />}
          </div>
          {isMapped ? (
            <div className="mt-1 text-[11px] text-emerald-700 dark:text-emerald-300 flex items-center gap-1">
              <CheckCircle2 className="w-2.5 h-2.5" />
              <code className="font-mono">{field.rule!.source}</code>
            </div>
          ) : (
            <div className="mt-1 text-[11px] text-zinc-400 italic flex items-center gap-1">
              <Plus className="w-2.5 h-2.5" />
              not mapped — select to bind
            </div>
          )}
        </button>
        {isMapped && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onUnbind()
            }}
            className="text-zinc-400 hover:text-red-600 p-1 mt-0.5"
            aria-label={`Unmap ${field.fieldKey}`}
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>
    </li>
  )
}
