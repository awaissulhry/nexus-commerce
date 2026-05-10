'use client'

/**
 * AI-2.5 (list-wizard) — admin UI for PromptTemplate rows.
 *
 * Closes Wave AI-2 prompt-as-data. Operators see every seeded /
 * authored prompt body, edit DRAFT bodies inline, and promote a
 * DRAFT → ACTIVE so the matcher in AI-2.3 starts using the DB body
 * for live AI calls.
 *
 * v1 scope:
 *   - List rows, grouped by feature, ordered by status (ACTIVE
 *     first so the live row is obvious) then version desc
 *   - Per-row: feature / name / status pill / version / scope
 *     (language + marketplace) / call count / last used
 *   - Expand row → preview body + edit textarea (DRAFT only;
 *     ACTIVE / ARCHIVED bodies are read-only — promote a DRAFT
 *     to replace them)
 *   - Promote DRAFT → ACTIVE button with confirm
 *   - Archive ACTIVE → ARCHIVED button with confirm
 *   - Save body edits via PATCH (DRAFT only)
 *
 * Out of scope (deferred):
 *   - Version cloning / A/B variants (AI-2.4)
 *   - Diff between body versions
 *   - Per-prompt quality score history
 */

import { useCallback, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'

export interface PromptTemplateRow {
  id: string
  feature: string
  name: string
  description: string | null
  body: string
  status: string
  version: number
  language: string | null
  marketplace: string | null
  callCount: number
  lastUsedAt: string | null
  createdAt: string
  updatedAt: string
  createdBy: string | null
}

interface Props {
  initialRows: PromptTemplateRow[]
}

const fmtRelative = (iso: string | null): string => {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

export default function AiPromptsClient({ initialRows }: Props) {
  const { toast } = useToast()
  const confirm = useConfirm()

  const [rows, setRows] = useState<PromptTemplateRow[]>(initialRows)
  const [refreshing, setRefreshing] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [editBody, setEditBody] = useState<Record<string, string>>({})

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/ai/prompt-templates`, {
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

  const patchRow = useCallback(
    async (id: string, body: Record<string, unknown>): Promise<boolean> => {
      setRowBusy(id, true)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/ai/prompt-templates/${id}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        )
        const json = await res.json()
        if (!res.ok) {
          toast({
            tone: 'error',
            title: 'PromptTemplate update failed',
            description: json?.error ?? `HTTP ${res.status}`,
            durationMs: 6000,
          })
          return false
        }
        if (json?.row) {
          setRows((prev) =>
            prev.map((r) => (r.id === id ? (json.row as PromptTemplateRow) : r)),
          )
        }
        return true
      } catch (err) {
        toast({
          tone: 'error',
          title: 'PromptTemplate update failed',
          description: err instanceof Error ? err.message : String(err),
          durationMs: 6000,
        })
        return false
      } finally {
        setRowBusy(id, false)
      }
    },
    [setRowBusy, toast],
  )

  const promote = useCallback(
    async (row: PromptTemplateRow) => {
      const ok = await confirm({
        title: 'Promote to ACTIVE?',
        description: `${row.feature} (${row.name} v${row.version}) will go ACTIVE for this feature${row.language ? ` in ${row.language}` : ''}${row.marketplace ? ` on ${row.marketplace}` : ''}. Other ACTIVE rows on the same scope stay ACTIVE — traffic splits evenly among them (AB.1). Archive the loser when you're done A/B-ing.`,
        confirmLabel: 'Promote to ACTIVE',
        tone: 'warning',
      })
      if (!ok) return
      const success = await patchRow(row.id, { status: 'ACTIVE' })
      if (success) {
        toast({
          tone: 'success',
          title: 'Promoted to ACTIVE',
          description: `${row.feature} now lives off the DB body.`,
          durationMs: 4000,
        })
      }
    },
    [confirm, patchRow, toast],
  )

  // AI-2.4 — clone a prompt as a DRAFT variant. Used for A/B testing
  // — operator authors a new variant alongside the existing ACTIVE,
  // edits the body, then promotes when ready (existing ACTIVE stays
  // ACTIVE until manually archived; AB.1 — when multiple ACTIVE rows
  // match the same scope, the matcher evenly splits traffic among
  // them, and the per-row callCount surfaces the realised split).
  const cloneRow = useCallback(
    async (row: PromptTemplateRow) => {
      setRowBusy(row.id, true)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/ai/prompt-templates/${row.id}/clone`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          },
        )
        const json = await res.json()
        if (!res.ok) {
          toast({
            tone: 'error',
            title: 'Clone failed',
            description: json?.error ?? `HTTP ${res.status}`,
            durationMs: 6000,
          })
          return
        }
        if (json?.row) {
          const cloned = json.row as PromptTemplateRow
          setRows((prev) => [cloned, ...prev])
          // Auto-expand the new variant so the operator can edit
          // the body immediately without hunting for it.
          setExpanded((prev) => {
            const next = new Set(prev)
            next.add(cloned.id)
            return next
          })
          toast({
            tone: 'success',
            title: `Cloned as "${cloned.name}"`,
            description: 'Edit the body and Promote when ready to A/B.',
            durationMs: 4000,
          })
        }
      } catch (err) {
        toast({
          tone: 'error',
          title: 'Clone failed',
          description: err instanceof Error ? err.message : String(err),
          durationMs: 6000,
        })
      } finally {
        setRowBusy(row.id, false)
      }
    },
    [setRowBusy, toast],
  )

  const archive = useCallback(
    async (row: PromptTemplateRow) => {
      const ok = await confirm({
        title: 'Archive this prompt?',
        description: `${row.feature} (${row.name} v${row.version}) will move to ARCHIVED. AI calls for this feature${row.language ? ` in ${row.language}` : ''}${row.marketplace ? ` on ${row.marketplace}` : ''} will fall back to whatever's still ACTIVE — or to the inline static body if nothing is.`,
        confirmLabel: 'Archive',
        tone: 'danger',
      })
      if (!ok) return
      const success = await patchRow(row.id, { status: 'ARCHIVED' })
      if (success) {
        toast({
          tone: 'success',
          title: 'Archived',
          durationMs: 3000,
        })
      }
    },
    [confirm, patchRow, toast],
  )

  const saveBody = useCallback(
    async (row: PromptTemplateRow) => {
      const next = editBody[row.id]
      if (typeof next !== 'string' || next.trim().length === 0) return
      if (next === row.body) return
      const success = await patchRow(row.id, { body: next })
      if (success) {
        toast({
          tone: 'success',
          title: 'Body saved',
          description: 'Promote to ACTIVE to take effect on live calls.',
          durationMs: 4000,
        })
        setEditBody((prev) => {
          const { [row.id]: _omit, ...rest } = prev
          return rest
        })
      }
    },
    [editBody, patchRow, toast],
  )

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Group rows by feature so admin sees one section per AI call site.
  const grouped = new Map<string, PromptTemplateRow[]>()
  for (const r of rows) {
    const list = grouped.get(r.feature) ?? []
    list.push(r)
    grouped.set(r.feature, list)
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => {
      // ACTIVE first, then DRAFT, then ARCHIVED.
      const statusRank: Record<string, number> = {
        ACTIVE: 0,
        DRAFT: 1,
        ARCHIVED: 2,
      }
      const sa = statusRank[a.status] ?? 3
      const sb = statusRank[b.status] ?? 3
      if (sa !== sb) return sa - sb
      return b.version - a.version
    })
  }

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-md font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider inline-flex items-center gap-1.5">
          <Sparkles className="w-3 h-3" />
          AI prompts
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
        Step 5 attribute prompts as DB rows (Wave AI-2). DRAFT bodies
        are editable and inert; promote a DRAFT to ACTIVE to swap
        the inline static body with the operator-edited one for live
        AI calls. ACTIVE bodies are read-only — edit a DRAFT and
        promote.
      </div>

      {rows.length === 0 ? (
        <div className="border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900 px-4 py-6 text-center text-base text-slate-500 dark:text-slate-400 italic">
          No prompts yet. Restart the API server to trigger the seed,
          or check that the DB migration for PromptTemplate has run.
        </div>
      ) : (
        <div className="space-y-3">
          {[...grouped.entries()].map(([feature, list]) => {
            // AB.1 — count ACTIVE rows per scope key to detect an
            // A/B in progress. Same-scope = same (language || '*',
            // marketplace || '*'); 2+ ACTIVEs = traffic splits.
            //
            // AB.4 — also accumulate per-scope total callCount so
            // the per-row badge can show realised traffic share
            // ("60% of A/B") without re-scanning the whole list.
            const scopeCounts = new Map<string, number>()
            const scopeTotalCalls = new Map<string, number>()
            const scopeKey = (r: PromptTemplateRow) =>
              `${r.language ?? '*'}|${r.marketplace ?? '*'}`
            for (const r of list) {
              if (r.status !== 'ACTIVE') continue
              const k = scopeKey(r)
              scopeCounts.set(k, (scopeCounts.get(k) ?? 0) + 1)
              scopeTotalCalls.set(
                k,
                (scopeTotalCalls.get(k) ?? 0) + (r.callCount ?? 0),
              )
            }
            const abVariants = Math.max(0, ...scopeCounts.values())
            return (
            <div
              key={feature}
              className="border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900 overflow-hidden"
            >
              <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 flex items-center justify-between gap-2">
                <div className="font-mono text-sm text-slate-900 dark:text-slate-100">
                  {feature}
                </div>
                {abVariants >= 2 && (
                  <span
                    className="text-xs px-1.5 py-0.5 rounded bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 font-medium"
                    title={`${abVariants} ACTIVE variants share the same scope — traffic splits evenly (AB.1).`}
                  >
                    A/B · {abVariants} variants
                  </span>
                )}
              </div>
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {list.map((row) => {
                  const isExpanded = expanded.has(row.id)
                  const isBusy = busy.has(row.id)
                  const editing = editBody[row.id] !== undefined
                  return (
                    <li key={row.id} className="px-3 py-2">
                      <div className="flex items-start justify-between gap-3">
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
                              <span className="font-mono text-sm font-medium text-slate-900 dark:text-slate-100">
                                {row.name} v{row.version}
                              </span>
                              <StatusPill status={row.status} />
                              {row.language && (
                                <span className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                                  lang={row.language}
                                </span>
                              )}
                              {row.marketplace && (
                                <span className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                                  market={row.marketplace}
                                </span>
                              )}
                              <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                                {row.callCount} call{row.callCount === 1 ? '' : 's'}
                                {row.lastUsedAt
                                  ? ` · last ${fmtRelative(row.lastUsedAt)}`
                                  : ''}
                              </span>
                              {(() => {
                                // AB.4 — show realised traffic share
                                // when this row is part of an A/B
                                // (same-scope ACTIVEs ≥ 2). 0% rows
                                // still get a label so an operator
                                // can spot a variant nobody hits.
                                if (row.status !== 'ACTIVE') return null
                                const k = scopeKey(row)
                                const variants = scopeCounts.get(k) ?? 0
                                if (variants < 2) return null
                                const total = scopeTotalCalls.get(k) ?? 0
                                const pct =
                                  total === 0
                                    ? 0
                                    : Math.round(
                                        ((row.callCount ?? 0) / total) * 100,
                                      )
                                return (
                                  <span
                                    className="text-xs px-1.5 py-0.5 rounded bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 tabular-nums font-medium"
                                    title={`${row.callCount} of ${total} A/B calls in this scope.`}
                                  >
                                    {pct}% A/B
                                  </span>
                                )
                              })()}
                            </div>
                            {row.description && (
                              <div className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
                                {row.description}
                              </div>
                            )}
                          </div>
                        </button>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {/* AI-2.4 — Clone as variant. Available on
                              every status (operators may want a DRAFT
                              variant of an ARCHIVED prompt to start
                              from). Lands as DRAFT with a fresh id so
                              it never collides with the source. */}
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => void cloneRow(row)}
                            disabled={isBusy}
                            title="Clone as a DRAFT variant for A/B testing"
                          >
                            Clone
                          </Button>
                          {row.status === 'DRAFT' && (
                            <Button
                              variant="primary"
                              size="sm"
                              onClick={() => void promote(row)}
                              disabled={isBusy}
                            >
                              {isBusy ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <Sparkles className="w-3 h-3" />
                              )}
                              Promote
                            </Button>
                          )}
                          {row.status === 'ACTIVE' && (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => void archive(row)}
                              disabled={isBusy}
                            >
                              Archive
                            </Button>
                          )}
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="mt-2 ml-6 space-y-2">
                          {row.status === 'DRAFT' ? (
                            <>
                              <textarea
                                value={editing ? editBody[row.id]! : row.body}
                                onChange={(e) =>
                                  setEditBody((prev) => ({
                                    ...prev,
                                    [row.id]: e.target.value,
                                  }))
                                }
                                className="w-full font-mono text-xs px-2 py-1.5 border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 min-h-[200px]"
                                placeholder="Prompt body (use {marketplace}, {language}, {contextBlock}, {terminologyBlock} placeholders)"
                              />
                              <div className="flex items-center gap-2">
                                <Button
                                  variant="primary"
                                  size="sm"
                                  onClick={() => void saveBody(row)}
                                  disabled={
                                    isBusy ||
                                    !editing ||
                                    editBody[row.id] === row.body
                                  }
                                >
                                  Save body
                                </Button>
                                {editing && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setEditBody((prev) => {
                                        const { [row.id]: _o, ...rest } = prev
                                        return rest
                                      })
                                    }
                                    className="text-sm text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
                                  >
                                    Discard changes
                                  </button>
                                )}
                                <span className="text-xs text-slate-400 dark:text-slate-500 ml-auto">
                                  Save first, then promote — Promote uses the
                                  saved body.
                                </span>
                              </div>
                            </>
                          ) : (
                            <pre
                              className={cn(
                                'whitespace-pre-wrap font-mono text-xs px-2 py-1.5 border rounded',
                                'border-slate-200 dark:border-slate-700',
                                row.status === 'ACTIVE'
                                  ? 'bg-emerald-50/40 dark:bg-emerald-950/20'
                                  : 'bg-slate-50 dark:bg-slate-900',
                              )}
                            >
                              {row.body}
                            </pre>
                          )}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'ACTIVE'
      ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900'
      : status === 'DRAFT'
        ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900'
        : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-700'
  const Icon = status === 'ACTIVE' ? CheckCircle2 : AlertCircle
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium border',
        tone,
      )}
    >
      <Icon className="w-3 h-3" />
      {status}
    </span>
  )
}
