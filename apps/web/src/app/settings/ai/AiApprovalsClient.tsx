'use client'

/**
 * ACP.3a-UI — Agent approvals inbox.
 *
 * The operator's control surface for governed actions: every pending
 * AgentApproval an agent/copilot wants to run, with its dry-run diff and
 * Approve / Reject. Approving executes the real action through the gate
 * (idempotent + undo-snapshotted on the backend). Self-fetching over
 * GET /api/agent/approvals + POST /agent/approvals/:id/approve|reject.
 */

import { useCallback, useEffect, useState } from 'react'
import { ShieldAlert, Check, X, Loader2, RefreshCw, Inbox } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Approval {
  id: string
  toolName: string
  riskTier: string
  preview?: unknown
  status: string
  requestedAt: string
}

const TIER_TONE: Record<string, string> = {
  high: 'text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-900',
  medium:
    'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900',
  low: 'text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700',
}

function changesOf(
  preview: unknown,
): Record<string, { from?: unknown; to?: unknown }> | null {
  if (preview && typeof preview === 'object' && 'changes' in preview) {
    const c = (preview as { changes?: unknown }).changes
    if (c && typeof c === 'object')
      return c as Record<string, { from?: unknown; to?: unknown }>
  }
  return null
}

const short = (v: unknown) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return (s ?? '').slice(0, 160)
}

function PreviewBody({ preview }: { preview: unknown }) {
  const changes = changesOf(preview)
  if (changes) {
    return (
      <div className="space-y-2">
        {Object.entries(changes).map(([field, c]) => (
          <div key={field} className="text-sm">
            <div className="font-medium text-slate-600 dark:text-slate-300">
              {field}
            </div>
            <div className="text-rose-700 dark:text-rose-400 line-through break-words">
              {short(c.from) || '(empty)'}
            </div>
            <div className="text-emerald-700 dark:text-emerald-400 break-words">
              {short(c.to)}
            </div>
          </div>
        ))}
      </div>
    )
  }
  return (
    <pre className="text-sm whitespace-pre-wrap break-words text-slate-600 dark:text-slate-400 max-h-40 overflow-y-auto">
      {JSON.stringify(preview, null, 2).slice(0, 600)}
    </pre>
  )
}

export default function AiApprovalsClient() {
  const backend = getBackendUrl()
  const [rows, setRows] = useState<Approval[]>([])
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${backend}/api/agent/approvals?status=pending`, {
        cache: 'no-store',
      })
      const d = await r.json().catch(() => null)
      setRows(d?.approvals ?? [])
    } catch {
      setError('Could not load approvals.')
    } finally {
      setLoading(false)
    }
  }, [backend])

  useEffect(() => {
    void load()
  }, [load])

  const decide = useCallback(
    async (id: string, decision: 'approve' | 'reject') => {
      setActing(id)
      setError(null)
      try {
        const r = await fetch(
          `${backend}/api/agent/approvals/${id}/${decision}`,
          { method: 'POST' },
        )
        const d = await r.json().catch(() => null)
        if (!r.ok || !d?.ok) {
          setError(d?.error ?? 'Action failed.')
        }
        await load()
      } catch {
        setError('Action failed.')
      } finally {
        setActing(null)
      }
    },
    [backend, load],
  )

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-md font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider inline-flex items-center gap-1.5">
          <Inbox className="w-3 h-3" />
          Agent approvals
          {rows.length > 0 && (
            <span className="text-sm font-normal text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-full px-2">
              {rows.length} pending
            </span>
          )}
        </h2>
        <button
          type="button"
          onClick={() => void load()}
          className="h-8 px-3 text-base border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center gap-1.5"
        >
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>
      <p className="text-sm text-slate-500 dark:text-slate-400 max-w-2xl">
        Actions the copilot / agents have prepared. Nothing here has run —
        approving executes it (reversibly, with an undo snapshot); rejecting
        discards it.
      </p>

      {error && (
        <div
          role="alert"
          className="border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 rounded-md px-3 py-2 text-base text-rose-800 dark:text-rose-200"
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-base text-slate-500 inline-flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> loading…
        </div>
      ) : rows.length === 0 ? (
        <div className="border border-slate-200 dark:border-slate-700 rounded-md p-4 bg-white dark:bg-slate-900 text-base text-slate-500 dark:text-slate-400">
          No pending actions. When the copilot or an agent proposes a change,
          it appears here for your approval.
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((a) => (
            <div
              key={a.id}
              className="border border-slate-200 dark:border-slate-700 rounded-md p-3 bg-white dark:bg-slate-900"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-base text-slate-900 dark:text-slate-100">
                      {a.toolName}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 text-sm border rounded px-1.5 py-0.5 ${TIER_TONE[a.riskTier] ?? TIER_TONE.low}`}
                    >
                      {a.riskTier === 'high' && <ShieldAlert className="w-3 h-3" />}
                      {a.riskTier}
                    </span>
                  </div>
                  <div className="mt-2">
                    <PreviewBody preview={a.preview} />
                  </div>
                </div>
                <div className="flex flex-col gap-1.5 flex-shrink-0">
                  <button
                    type="button"
                    disabled={acting === a.id}
                    onClick={() => void decide(a.id, 'approve')}
                    className="h-8 px-3 text-base rounded bg-emerald-600 text-white inline-flex items-center gap-1.5 hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {acting === a.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Check className="w-3.5 h-3.5" />
                    )}
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={acting === a.id}
                    onClick={() => void decide(a.id, 'reject')}
                    className="h-8 px-3 text-base rounded border border-slate-200 dark:border-slate-700 inline-flex items-center gap-1.5 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
                  >
                    <X className="w-3.5 h-3.5" /> Reject
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
