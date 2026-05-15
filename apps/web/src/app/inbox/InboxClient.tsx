'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertCircle, AlertTriangle, Bell, CheckCircle2, ExternalLink,
  Inbox, Info, Loader2, RefreshCw, RotateCcw, X, Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import { useToast } from '@/components/ui/Toast'
import { Button } from '@/components/ui/Button'

// ── Types ──────────────────────────────────────────────────────────────────────

interface InboxItem {
  key: string
  source: 'sync' | 'alert' | 'notification' | 'webhook'
  severity: 'critical' | 'warn' | 'info'
  title: string
  body?: string
  channel?: string
  href?: string
  createdAt: string
  resolvedAt?: string | null
  meta: Record<string, unknown>
}

interface InboxData {
  items: InboxItem[]
  total: number
  counts: {
    all: number
    sync: number
    alert: number
    notification: number
    webhook: number
  }
}

type SourceTab = 'all' | 'sync' | 'alert' | 'notification' | 'webhook'

const BACKEND = getBackendUrl()
const POLL_MS = 30_000

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`
  return `${Math.floor(ms / 86_400_000)}d`
}

function SeverityIcon({ severity, className }: { severity: InboxItem['severity']; className?: string }) {
  if (severity === 'critical') return <AlertCircle className={cn('w-3.5 h-3.5 text-red-500 flex-shrink-0', className)} />
  if (severity === 'warn') return <AlertTriangle className={cn('w-3.5 h-3.5 text-amber-500 flex-shrink-0', className)} />
  return <Info className={cn('w-3.5 h-3.5 text-blue-400 flex-shrink-0', className)} />
}

function SourceIcon({ source, className }: { source: InboxItem['source']; className?: string }) {
  if (source === 'sync') return <Zap className={cn('w-3 h-3', className)} />
  if (source === 'alert') return <AlertTriangle className={cn('w-3 h-3', className)} />
  if (source === 'notification') return <Bell className={cn('w-3 h-3', className)} />
  return <ExternalLink className={cn('w-3 h-3', className)} />
}

const SOURCE_LABELS: Record<string, string> = { sync: 'Sync', alert: 'Alert', notification: 'Notif', webhook: 'Webhook' }
const CHANNEL_COLORS: Record<string, string> = {
  AMAZON: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  EBAY: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300',
  SHOPIFY: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function InboxClient() {
  const { toast } = useToast()
  const router = useRouter()
  const [data, setData] = useState<InboxData | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<SourceTab>('all')
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set())
  const [busyBulk, setBusyBulk] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const url = tab === 'all'
        ? `${BACKEND}/api/inbox?limit=100`
        : `${BACKEND}/api/inbox?source=${tab}&limit=100`
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) return
      const json = (await res.json()) as InboxData
      setData(json)
    } catch {
      /* non-fatal — keep stale data */
    } finally {
      setLoading(false)
    }
  }, [tab])

  useEffect(() => {
    setLoading(true)
    void fetchData()
  }, [fetchData])

  useEffect(() => {
    const id = setInterval(() => void fetchData(), POLL_MS)
    return () => clearInterval(id)
  }, [fetchData])

  // ── Per-item actions ─────────────────────────────────────────────────────

  const doItemAction = useCallback(async (item: InboxItem, action: string) => {
    const key = `${item.key}:${action}`
    setBusyKeys((s) => new Set(s).add(key))
    try {
      const id = item.meta.id as string
      let url = ''
      let method = 'POST'
      let body: Record<string, unknown> | undefined

      if (item.source === 'sync' && action === 'retry') url = `${BACKEND}/api/outbound-queue/${id}/retry`
      if (item.source === 'sync' && action === 'cancel') url = `${BACKEND}/api/outbound-queue/${id}/cancel`
      if (item.source === 'alert' && action === 'acknowledge') url = `${BACKEND}/api/sync-logs/alerts/events/${id}/acknowledge`
      if (item.source === 'alert' && action === 'resolve') url = `${BACKEND}/api/sync-logs/alerts/events/${id}/resolve`
      if (item.source === 'notification' && action === 'read') { url = `${BACKEND}/api/notifications/${id}/read`; body = {} }
      if (item.source === 'webhook' && action === 'replay') url = `${BACKEND}/api/sync-logs/webhooks/${id}/replay`

      if (!url) return
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string }
        toast({ title: `Action failed`, description: err.error ?? `HTTP ${res.status}`, tone: 'error' })
        return
      }
      toast({ title: 'Done', tone: 'success' })
      void fetchData()
    } finally {
      setBusyKeys((s) => { const n = new Set(s); n.delete(key); return n })
    }
  }, [fetchData, toast])

  // ── Bulk actions ─────────────────────────────────────────────────────────

  const doBulk = useCallback(async (bulkAction: string) => {
    setBusyBulk(bulkAction)
    try {
      if (bulkAction === 'retry-dead') {
        const res = await fetch(`${BACKEND}/api/outbound-queue/bulk-retry`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filter: 'dead' }),
        })
        const json = await res.json().catch(() => ({})) as { retried?: number }
        toast({ title: `Retried ${json.retried ?? '?'} dead-letter items`, tone: 'success' })
      }
      if (bulkAction === 'ack-all-alerts') {
        const alertItems = (data?.items ?? []).filter((i) => i.source === 'alert')
        await Promise.allSettled(
          alertItems.map((i) =>
            fetch(`${BACKEND}/api/sync-logs/alerts/events/${i.meta.id}/acknowledge`, { method: 'POST' })
          )
        )
        toast({ title: `Acknowledged ${alertItems.length} alert${alertItems.length !== 1 ? 's' : ''}`, tone: 'success' })
      }
      if (bulkAction === 'mark-all-read') {
        await fetch(`${BACKEND}/api/notifications/read-all`, { method: 'POST' })
        toast({ title: 'All notifications marked read', tone: 'success' })
      }
      void fetchData()
    } catch {
      toast({ title: 'Bulk action failed', tone: 'error' })
    } finally {
      setBusyBulk(null)
    }
  }, [data, fetchData, toast])

  // ── Counts for tabs ──────────────────────────────────────────────────────

  const counts = data?.counts
  const items = data?.items ?? []

  const deadCount = items.filter((i) => i.source === 'sync' && (i.meta.isDead as boolean)).length
  const alertCount = items.filter((i) => i.source === 'alert').length
  const notifCount = items.filter((i) => i.source === 'notification').length

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">

      {/* Quick action strip */}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm" variant="secondary"
          disabled={deadCount === 0 || busyBulk === 'retry-dead'}
          onClick={() => void doBulk('retry-dead')}
        >
          {busyBulk === 'retry-dead' ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5 mr-1.5" />}
          Retry dead letters{deadCount > 0 ? ` (${deadCount})` : ''}
        </Button>
        <Button
          size="sm" variant="secondary"
          disabled={alertCount === 0 || busyBulk === 'ack-all-alerts'}
          onClick={() => void doBulk('ack-all-alerts')}
        >
          {busyBulk === 'ack-all-alerts' ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />}
          Ack all alerts{alertCount > 0 ? ` (${alertCount})` : ''}
        </Button>
        <Button
          size="sm" variant="secondary"
          disabled={notifCount === 0 || busyBulk === 'mark-all-read'}
          onClick={() => void doBulk('mark-all-read')}
        >
          {busyBulk === 'mark-all-read' ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />}
          Mark all read{notifCount > 0 ? ` (${notifCount})` : ''}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void fetchData()}>
          <RefreshCw className="w-3.5 h-3.5 mr-1.5" />Refresh
        </Button>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => router.push('/sync-logs/outbound-queue')}>
          Outbound queue →
        </Button>
      </div>

      {/* Source filter tabs */}
      <div className="flex items-center gap-1 border-b border-slate-200 dark:border-slate-700">
        {(['all', 'sync', 'alert', 'notification', 'webhook'] as SourceTab[]).map((t) => {
          const c = t === 'all' ? counts?.all : counts?.[t]
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                'px-3 py-1.5 text-sm font-medium border-b-2 -mb-px transition-colors',
                tab === t
                  ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200',
              )}
            >
              {t === 'all' ? 'All' : SOURCE_LABELS[t]}
              {c != null && c > 0 && (
                <span className="ml-1.5 rounded-full bg-slate-100 dark:bg-slate-800 px-1.5 py-0 text-xs tabular-nums">
                  {c}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Feed */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
        </div>
      )}

      {!loading && items.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-14 h-14 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center mb-4">
            <Inbox className="w-7 h-7 text-emerald-600 dark:text-emerald-400" />
          </div>
          <p className="text-base font-medium text-slate-700 dark:text-slate-300">All clear</p>
          <p className="text-sm text-slate-400 mt-1">Nothing needs attention right now.</p>
        </div>
      )}

      {!loading && items.length > 0 && (
        <div className="space-y-1.5">
          {items.map((item) => {
            const isBusy = (action: string) => busyKeys.has(`${item.key}:${action}`)
            return (
              <div
                key={item.key}
                className={cn(
                  'flex items-start gap-3 p-3 rounded-lg border transition-colors',
                  item.severity === 'critical'
                    ? 'border-red-200 bg-red-50/50 dark:border-red-800/50 dark:bg-red-950/10'
                    : item.severity === 'warn'
                      ? 'border-amber-200 bg-amber-50/30 dark:border-amber-800/50 dark:bg-amber-950/10'
                      : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900',
                )}
              >
                {/* Severity icon */}
                <SeverityIcon severity={item.severity} className="mt-0.5" />

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                      {item.title}
                    </span>
                    {item.channel && (
                      <span className={cn('inline-flex items-center px-1.5 py-0 rounded text-[10px] font-semibold uppercase', CHANNEL_COLORS[item.channel] ?? 'bg-slate-100 text-slate-600')}>
                        {item.channel}
                      </span>
                    )}
                    <span className="ml-auto text-[11px] text-slate-400 tabular-nums flex-shrink-0">
                      {relativeTime(item.createdAt)}
                    </span>
                  </div>
                  {item.body && (
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate">{item.body}</p>
                  )}
                  <div className="flex items-center gap-1 mt-2 flex-wrap">
                    {/* Source tag */}
                    <span className="inline-flex items-center gap-1 text-[10px] text-slate-400 dark:text-slate-500 mr-1">
                      <SourceIcon source={item.source} />
                      {SOURCE_LABELS[item.source]}
                    </span>

                    {/* Per-source action buttons */}
                    {item.source === 'sync' && (
                      <>
                        <button
                          type="button"
                          disabled={isBusy('retry')}
                          onClick={() => void doItemAction(item, 'retry')}
                          className="inline-flex items-center gap-1 h-5 px-2 rounded text-[11px] font-medium bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-300 disabled:opacity-50"
                        >
                          {isBusy('retry') ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <RotateCcw className="w-2.5 h-2.5" />}
                          Retry
                        </button>
                        <button
                          type="button"
                          disabled={isBusy('cancel')}
                          onClick={() => void doItemAction(item, 'cancel')}
                          className="inline-flex items-center gap-1 h-5 px-2 rounded text-[11px] font-medium bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 disabled:opacity-50"
                        >
                          {isBusy('cancel') ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <X className="w-2.5 h-2.5" />}
                          Cancel
                        </button>
                      </>
                    )}
                    {item.source === 'alert' && (
                      <>
                        <button
                          type="button"
                          disabled={isBusy('acknowledge')}
                          onClick={() => void doItemAction(item, 'acknowledge')}
                          className="inline-flex items-center gap-1 h-5 px-2 rounded text-[11px] font-medium bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-300 disabled:opacity-50"
                        >
                          {isBusy('acknowledge') ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <CheckCircle2 className="w-2.5 h-2.5" />}
                          Ack
                        </button>
                        <button
                          type="button"
                          disabled={isBusy('resolve')}
                          onClick={() => void doItemAction(item, 'resolve')}
                          className="inline-flex items-center gap-1 h-5 px-2 rounded text-[11px] font-medium bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 disabled:opacity-50"
                        >
                          {isBusy('resolve') ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <CheckCircle2 className="w-2.5 h-2.5" />}
                          Resolve
                        </button>
                      </>
                    )}
                    {item.source === 'notification' && (
                      <button
                        type="button"
                        disabled={isBusy('read')}
                        onClick={() => void doItemAction(item, 'read')}
                        className="inline-flex items-center gap-1 h-5 px-2 rounded text-[11px] font-medium bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 disabled:opacity-50"
                      >
                        {isBusy('read') ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <CheckCircle2 className="w-2.5 h-2.5" />}
                        Mark read
                      </button>
                    )}
                    {item.source === 'webhook' && (
                      <button
                        type="button"
                        disabled={isBusy('replay')}
                        onClick={() => void doItemAction(item, 'replay')}
                        className="inline-flex items-center gap-1 h-5 px-2 rounded text-[11px] font-medium bg-violet-100 text-violet-700 hover:bg-violet-200 dark:bg-violet-900/30 dark:text-violet-300 disabled:opacity-50"
                      >
                        {isBusy('replay') ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <RotateCcw className="w-2.5 h-2.5" />}
                        Replay
                      </button>
                    )}

                    {/* Navigate link */}
                    {item.href && (
                      <a
                        href={item.href}
                        className="inline-flex items-center gap-1 h-5 px-2 rounded text-[11px] font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                      >
                        <ExternalLink className="w-2.5 h-2.5" />
                        View
                      </a>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
