'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronRight,
  Clock,
  History,
  Loader2,
  RotateCcw,
  X,
} from 'lucide-react'
import { usePolledList } from '@/lib/sync/use-polled-list'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { useToast } from '@/components/ui/Toast'

// ─── Types ───────────────────────────────────────────────────────────

interface SessionChange {
  id: string
  productId: string
  productSku: string
  productName: string
  toParentId: string
  toParentSku: string
  fromParentId: string | null
  attributes: Record<string, string> | null
  status: 'APPLIED' | 'UNDONE'
  undoneAt: string | null
}

interface OrganizeSession {
  id: string
  status: 'PUBLISHED' | 'UNDONE' | 'FAILED'
  publishedAt: string
  undoExpiresAt: string
  undoneAt: string | null
  changes: SessionChange[]
}

// ─── Helpers ─────────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function sessionSummary(session: OrganizeSession): string {
  const n = session.changes.length
  const parents = [...new Set(session.changes.map((c) => c.toParentSku))].slice(0, 2)
  const parentLabel = parents.join(', ') + (parents.length < new Set(session.changes.map((c) => c.toParentSku)).size ? '…' : '')
  return `${n} product${n === 1 ? '' : 's'} → ${parentLabel}`
}

// ─── useCountdown ─────────────────────────────────────────────────────
// Polls every 30 s — accurate enough for hours-remaining display.
function useCountdown(expiresAt: string): { label: string; expired: boolean } {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  return useMemo(() => {
    const ms = new Date(expiresAt).getTime() - now
    if (ms <= 0) return { label: 'Expired', expired: true }
    const h = Math.floor(ms / 3_600_000)
    const m = Math.floor((ms % 3_600_000) / 60_000)
    const label = h > 0 ? `${h}h ${m}m left` : `${m}m left`
    return { label, expired: false }
  }, [expiresAt, now])
}

// ─── Main component ───────────────────────────────────────────────────
export default function OrganizeHistoryPanel() {
  const { data, loading, error, refetch } = usePolledList<{ sessions: OrganizeSession[] }>({
    url: '/api/catalog/organize/sessions',
    intervalMs: 30_000,
    invalidationTypes: ['pim.changed'],
  })
  const sessions = data?.sessions ?? []

  if (loading && sessions.length === 0) {
    return (
      <div className="flex items-center justify-center py-6 text-slate-400">
        <Loader2 className="w-4 h-4 animate-spin" />
      </div>
    )
  }
  if (error) {
    return (
      <p className="text-xs text-rose-600 dark:text-rose-400 py-2">
        Couldn't load history: {error}
      </p>
    )
  }
  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1.5 py-4 text-center">
        <History className="w-5 h-5 text-slate-300 dark:text-slate-600" />
        <p className="text-xs text-slate-400 dark:text-slate-500">
          No published sessions yet.
          <br />
          Publish staged changes to see them here.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {sessions.map((s) => (
        <SessionCard key={s.id} session={s} onRefetch={refetch} />
      ))}
    </div>
  )
}

// ─── SessionCard ──────────────────────────────────────────────────────
function SessionCard({
  session,
  onRefetch,
}: {
  session: OrganizeSession
  onRefetch: () => void
}) {
  const { toast } = useToast()
  const [expanded, setExpanded] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const countdown = useCountdown(session.undoExpiresAt)

  const canUndo =
    session.status === 'PUBLISHED' &&
    !countdown.expired &&
    session.changes.some((c) => c.status === 'APPLIED')

  const handleUndoSession = useCallback(async () => {
    setUndoing(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/catalog/organize/undo/${session.id}`,
        { method: 'POST' },
      )
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      emitInvalidation({ type: 'pim.changed', meta: { undone: json.undone } })
      onRefetch()
      toast.success(
        `Undone ${json.undone} change${json.undone === 1 ? '' : 's'}.`,
      )
    } catch (err) {
      toast.error(
        `Undo failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      setUndoing(false)
    }
  }, [session.id, onRefetch, toast])

  const appliedCount = session.changes.filter((c) => c.status === 'APPLIED').length

  return (
    <div
      className={`rounded-lg border text-sm transition-colors ${
        session.status === 'UNDONE'
          ? 'border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/30'
          : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900'
      }`}
    >
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="px-3 py-2.5 space-y-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-xs text-slate-400 dark:text-slate-500 mb-0.5">
              <span>{timeAgo(session.publishedAt)}</span>
              <span>·</span>
              <span>{session.changes.length} change{session.changes.length === 1 ? '' : 's'}</span>
            </div>
            <div className="text-xs font-medium text-slate-700 dark:text-slate-300 truncate">
              {sessionSummary(session)}
            </div>
          </div>
          {/* Status badge */}
          {session.status === 'UNDONE' ? (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 flex-shrink-0">
              <Check className="w-2.5 h-2.5" /> Undone
            </span>
          ) : session.status === 'FAILED' ? (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 flex-shrink-0">
              Failed
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-teal-50 dark:bg-teal-950/40 text-teal-700 dark:text-teal-400 flex-shrink-0">
              Live
            </span>
          )}
        </div>

        {/* Countdown */}
        {session.status === 'PUBLISHED' && (
          <div
            className={`flex items-center gap-1 text-xs ${
              countdown.expired
                ? 'text-slate-400 dark:text-slate-500'
                : 'text-amber-600 dark:text-amber-400'
            }`}
          >
            <Clock className="w-3 h-3 flex-shrink-0" />
            <span>{countdown.label}</span>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 pt-0.5">
          {session.changes.length > 0 && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="inline-flex items-center gap-0.5 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
            >
              <ChevronRight
                className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
              />
              {expanded ? 'Hide' : `${appliedCount > 0 ? 'Show' : 'View'} details`}
            </button>
          )}
          {canUndo && (
            <button
              type="button"
              onClick={handleUndoSession}
              disabled={undoing}
              className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200 disabled:opacity-50 transition-colors ml-auto"
            >
              {undoing ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <RotateCcw className="w-3 h-3" />
              )}
              {undoing ? 'Undoing…' : 'Undo all'}
            </button>
          )}
        </div>
      </div>

      {/* ── Expanded change list ──────────────────────────────── */}
      {expanded && (
        <div className="border-t border-slate-100 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
          {session.changes.map((c) => (
            <ChangeRow
              key={c.id}
              change={c}
              sessionId={session.id}
              canUndo={canUndo && c.status === 'APPLIED'}
              onRefetch={onRefetch}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── ChangeRow ────────────────────────────────────────────────────────
const ChangeRow = function ChangeRow({
  change,
  sessionId,
  canUndo,
  onRefetch,
}: {
  change: SessionChange
  sessionId: string
  canUndo: boolean
  onRefetch: () => void
}) {
  const { toast } = useToast()
  const [undoing, setUndoing] = useState(false)
  const isMounted = useRef(true)
  useEffect(() => () => { isMounted.current = false }, [])

  const attrPairs = useMemo(
    () => Object.entries(change.attributes ?? {}).filter(([, v]) => v),
    [change.attributes],
  )

  const handleUndoChange = useCallback(async () => {
    setUndoing(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/catalog/organize/undo/${sessionId}/change/${change.id}`,
        { method: 'POST' },
      )
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      emitInvalidation({ type: 'pim.changed', meta: { undone: 1 } })
      onRefetch()
      toast.success(`Reverted ${change.productSku}.`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      if (isMounted.current) setUndoing(false)
    }
  }, [sessionId, change.id, change.productSku, onRefetch, toast])

  return (
    <div
      className={`px-3 py-2 flex items-start justify-between gap-2 ${
        change.status === 'UNDONE' ? 'opacity-50' : ''
      }`}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-1 text-xs">
          <span className="font-mono text-slate-700 dark:text-slate-300 truncate max-w-[90px]">
            {change.productSku}
          </span>
          <ChevronRight className="w-3 h-3 text-slate-400 flex-shrink-0" />
          <span className="font-mono text-blue-600 dark:text-blue-400 truncate max-w-[80px]">
            {change.toParentSku}
          </span>
          {change.status === 'UNDONE' && (
            <Check className="w-3 h-3 text-slate-400 flex-shrink-0" />
          )}
        </div>
        {attrPairs.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {attrPairs.map(([k, v]) => (
              <span
                key={k}
                className="text-[10px] bg-teal-50 dark:bg-teal-950/40 text-teal-700 dark:text-teal-300 border border-teal-200 dark:border-teal-800 px-1 py-0.5 rounded-full"
              >
                {k}: {v}
              </span>
            ))}
          </div>
        )}
      </div>
      {canUndo && (
        <button
          type="button"
          onClick={handleUndoChange}
          disabled={undoing}
          aria-label={`Undo ${change.productSku}`}
          className="flex-shrink-0 p-1 rounded text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 disabled:opacity-40 transition-colors"
        >
          {undoing ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <X className="w-3.5 h-3.5" />
          )}
        </button>
      )}
    </div>
  )
}
