'use client'

/**
 * H.8 — topnav notification bell.
 *
 * Floating button in the top-right corner. Polls /api/notifications
 * every 30 seconds for the unread count, surfaces a red badge when
 * non-zero. Click opens a dropdown listing the most recent rows.
 *
 * Each row is severity-coloured (info/success/warn/danger), shows
 * title + body + relative time, and clicks through to the
 * notification's href (typically /products?<filters> for saved-view
 * alerts), marking it read in the same gesture.
 *
 * Mark-all-read button at the top of the dropdown wipes the badge in
 * one click for users who triage in batches.
 *
 * 30-second poll cadence: alert cron is on a 5-minute tick, so faster
 * polling buys nothing. The endpoint is index-backed and small (50
 * rows max).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Bell,
  BellRing,
  Check,
  CheckCheck,
  X,
  AlertCircle,
  CheckCircle2,
  Info,
  AlertTriangle,
  ExternalLink,
} from 'lucide-react'
import { useRouter } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'

interface NotificationRow {
  id: string
  type: string
  severity: 'info' | 'success' | 'warn' | 'danger' | string
  title: string
  body: string | null
  entityType: string | null
  entityId: string | null
  meta: unknown
  href: string | null
  readAt: string | null
  createdAt: string
}

const POLL_MS = 30_000

const SEVERITY_STYLES: Record<
  string,
  { dot: string; bg: string; icon: typeof Info }
> = {
  info: {
    dot: 'bg-sky-500',
    bg: 'bg-sky-50',
    icon: Info,
  },
  success: {
    dot: 'bg-emerald-500',
    bg: 'bg-emerald-50',
    icon: CheckCircle2,
  },
  warn: {
    dot: 'bg-amber-500',
    bg: 'bg-amber-50',
    icon: AlertTriangle,
  },
  danger: {
    dot: 'bg-rose-500',
    bg: 'bg-rose-50',
    icon: AlertCircle,
  },
}

function fmtRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

export default function NotificationsBell() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<NotificationRow[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/notifications?limit=30`, {
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setRows(json.rows ?? [])
      setUnreadCount(json.unreadCount ?? 0)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial fetch + 30s poll. Always-on so the badge stays current
  // even when the dropdown is closed.
  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  // Click-outside to close.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (
        wrapRef.current &&
        !wrapRef.current.contains(e.target as Node) &&
        open
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const markRead = async (id: string) => {
    setRows((prev) =>
      prev.map((r) =>
        r.id === id && !r.readAt
          ? { ...r, readAt: new Date().toISOString() }
          : r,
      ),
    )
    setUnreadCount((n) => Math.max(0, n - 1))
    try {
      await fetch(`${getBackendUrl()}/api/notifications/${id}/read`, {
        method: 'POST',
      })
    } catch {
      // Silent: the optimistic update is already in place. Next poll
      // will reconcile if the server didn't accept.
    }
  }

  const markAllRead = async () => {
    setRows((prev) =>
      prev.map((r) =>
        r.readAt ? r : { ...r, readAt: new Date().toISOString() },
      ),
    )
    setUnreadCount(0)
    try {
      await fetch(`${getBackendUrl()}/api/notifications/read-all`, {
        method: 'POST',
      })
    } catch {
      void refresh()
    }
  }

  const onRowClick = (row: NotificationRow) => {
    if (!row.readAt) void markRead(row.id)
    if (row.href) {
      router.push(row.href)
      setOpen(false)
    }
  }

  return (
    <div ref={wrapRef} className="fixed top-14 md:top-3 right-3 z-40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Notifications"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        className="relative inline-flex items-center justify-center w-8 h-8 rounded-full bg-white border border-slate-200 hover:bg-slate-50 shadow-sm"
      >
        {unreadCount > 0 ? (
          <BellRing className="w-4 h-4 text-slate-700" />
        ) : (
          <Bell className="w-4 h-4 text-slate-500" />
        )}
        {unreadCount > 0 && (
          <span
            className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-white text-[10px] font-semibold inline-flex items-center justify-center tabular-nums"
            aria-hidden
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute top-10 right-0 w-[380px] max-h-[70vh] bg-white rounded-lg border border-slate-200 shadow-xl flex flex-col">
          <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-between gap-2 flex-shrink-0">
            <div className="text-[13px] font-semibold text-slate-900">
              Notifications
              {unreadCount > 0 && (
                <span className="ml-1.5 text-[11px] text-slate-500 font-normal">
                  · {unreadCount} unread
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={markAllRead}
                  title="Mark all read"
                  className="h-6 px-2 text-[11px] text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded inline-flex items-center gap-1"
                >
                  <CheckCheck className="w-3 h-3" />
                  All read
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="h-6 w-6 inline-flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {error && (
              <div className="px-3 py-2 text-[12px] text-rose-700 bg-rose-50 border-b border-rose-200">
                {error}
              </div>
            )}
            {loading && rows.length === 0 ? (
              <div className="px-3 py-8 text-center text-[12px] text-slate-400 italic">
                Loading…
              </div>
            ) : rows.length === 0 ? (
              <div className="px-3 py-8 text-center text-[12px] text-slate-400">
                <Bell className="w-5 h-5 mx-auto mb-1 text-slate-300" />
                No notifications yet
              </div>
            ) : (
              rows.map((r) => {
                const unread = !r.readAt
                const sev = SEVERITY_STYLES[r.severity] ?? SEVERITY_STYLES.info
                const Icon = sev.icon
                return (
                  <div
                    key={r.id}
                    role={r.href ? 'button' : undefined}
                    onClick={r.href ? () => onRowClick(r) : undefined}
                    className={`px-3 py-2 border-b border-slate-100 last:border-b-0 flex items-start gap-2 ${
                      r.href ? 'cursor-pointer hover:bg-slate-50' : ''
                    } ${unread ? '' : 'opacity-70'}`}
                  >
                    <div
                      className={`mt-0.5 w-6 h-6 rounded-full ${sev.bg} inline-flex items-center justify-center flex-shrink-0`}
                    >
                      <Icon className={`w-3.5 h-3.5 ${sev.dot.replace('bg-', 'text-')}`} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start gap-1">
                        <div className="text-[12px] text-slate-900 font-medium leading-snug flex-1 min-w-0">
                          {r.title}
                        </div>
                        {unread && (
                          <span
                            className={`mt-1 w-1.5 h-1.5 rounded-full ${sev.dot} flex-shrink-0`}
                            aria-label="unread"
                          />
                        )}
                      </div>
                      {r.body && (
                        <div className="text-[11px] text-slate-600 mt-0.5 leading-snug">
                          {r.body}
                        </div>
                      )}
                      <div className="flex items-center gap-2 mt-1 text-[10px] text-slate-400">
                        <span>{fmtRelative(r.createdAt)}</span>
                        {r.href && (
                          <span className="inline-flex items-center gap-0.5">
                            Open <ExternalLink className="w-2.5 h-2.5" />
                          </span>
                        )}
                        {!r.readAt && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              void markRead(r.id)
                            }}
                            className="ml-auto inline-flex items-center gap-0.5 hover:text-slate-700"
                          >
                            <Check className="w-2.5 h-2.5" /> Mark read
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>

          <div className="px-3 py-2 border-t border-slate-100 flex-shrink-0 text-[11px] text-slate-500 flex items-center justify-between">
            <span>Polls every 30s</span>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              className="text-slate-600 hover:text-slate-900 disabled:opacity-50"
            >
              Refresh
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
