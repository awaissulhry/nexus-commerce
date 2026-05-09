'use client'

/**
 * L.16.1 — Alert rules + events client.
 *
 * Left column: AlertRule list with inline enable toggle, edit, delete,
 * and a "+ New rule" form at the top. Each row shows the rule's
 * lastValue compared to its threshold so the operator sees current
 * health at a glance.
 *
 * Right column: AlertEvent history. Filter chips for status
 * (TRIGGERED / ACKNOWLEDGED / RESOLVED / ALL). Per-row
 * Acknowledge / Resolve buttons.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  Bell,
  CheckCircle2,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'

const METRICS = [
  { value: 'errorRate', label: 'Error rate', unit: '%' },
  { value: 'latencyP95', label: 'Latency p95', unit: 'ms' },
  { value: 'queueDepth', label: 'Queue depth', unit: '' },
  { value: 'activeErrorGroups', label: 'Active error groups', unit: '' },
  { value: 'staleCrons', label: 'Stale RUNNING crons', unit: '' },
] as const
const OPERATORS = [
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
] as const
const STATUS_OPTIONS = ['TRIGGERED', 'ACKNOWLEDGED', 'RESOLVED', 'ALL'] as const

interface AlertRule {
  id: string
  name: string
  description: string | null
  metric: string
  operator: string
  threshold: number
  windowMinutes: number
  channel: string | null
  notificationChannels: string[]
  enabled: boolean
  lastEvaluatedAt: string | null
  lastValue: number | null
  lastFired: boolean
  createdAt: string
  updatedAt: string
}

interface AlertEvent {
  id: string
  ruleId: string
  rule: AlertRule
  value: number
  status: 'TRIGGERED' | 'ACKNOWLEDGED' | 'RESOLVED'
  triggeredAt: string
  acknowledgedAt: string | null
  acknowledgedBy: string | null
  resolvedAt: string | null
  resolvedBy: string | null
  notes: string | null
  notifications:
    | Array<{ channel: string; ok: boolean; error?: string }>
    | null
}

function fmtRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

function fmtMetricValue(metric: string, v: number | null): string {
  if (v === null) return '—'
  if (metric === 'errorRate') return `${(v * 100).toFixed(2)}%`
  if (metric === 'latencyP95') return `${Math.round(v)}ms`
  return String(Math.round(v))
}

export default function AlertsClient() {
  const { toast } = useToast()
  const { t } = useTranslations()
  const [rules, setRules] = useState<AlertRule[]>([])
  const [events, setEvents] = useState<AlertEvent[]>([])
  const [statusFilter, setStatusFilter] =
    useState<(typeof STATUS_OPTIONS)[number]>('TRIGGERED')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  // Create-rule form state
  const [newName, setNewName] = useState('')
  const [newMetric, setNewMetric] = useState<string>('errorRate')
  const [newOperator, setNewOperator] = useState<string>('gt')
  const [newThreshold, setNewThreshold] = useState('1')
  const [newWindow, setNewWindow] = useState('15')
  const [newChannel, setNewChannel] = useState('')
  const [newNotify, setNewNotify] = useState('log')

  const fetchAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const backend = getBackendUrl()
      const [rulesRes, eventsRes] = await Promise.all([
        fetch(`${backend}/api/sync-logs/alerts/rules`, { cache: 'no-store' }),
        fetch(
          `${backend}/api/sync-logs/alerts/events?status=${statusFilter}&limit=50`,
          { cache: 'no-store' },
        ),
      ])
      if (!rulesRes.ok) throw new Error(`rules HTTP ${rulesRes.status}`)
      if (!eventsRes.ok) throw new Error(`events HTTP ${eventsRes.status}`)
      const rulesJson = await rulesRes.json()
      const eventsJson = await eventsRes.json()
      setRules(rulesJson.items)
      setEvents(eventsJson.items)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => {
    void fetchAll()
    // Re-poll every 30s so a fired alert appears without a refresh.
    const id = setInterval(() => void fetchAll(), 30_000)
    return () => clearInterval(id)
  }, [fetchAll])

  const createRule = useCallback(async () => {
    if (!newName.trim()) {
      toast.error(t('syncLogs.alerts.rules.nameRequired'))
      return
    }
    const threshold = Number(newThreshold)
    if (Number.isNaN(threshold)) {
      toast.error(t('syncLogs.alerts.rules.thresholdNumber'))
      return
    }
    setCreating(true)
    try {
      const body = {
        name: newName.trim(),
        metric: newMetric,
        operator: newOperator,
        // errorRate threshold input is in % — convert to fraction.
        threshold: newMetric === 'errorRate' ? threshold / 100 : threshold,
        windowMinutes: Number(newWindow) || 15,
        channel: newChannel.trim() || undefined,
        notificationChannels: newNotify
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      }
      const res = await fetch(`${getBackendUrl()}/api/sync-logs/alerts/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      toast.success(t('syncLogs.alerts.rules.created', { name: newName.trim() }))
      setNewName('')
      setNewThreshold('1')
      setNewChannel('')
      void fetchAll()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }, [newName, newMetric, newOperator, newThreshold, newWindow, newChannel, newNotify, fetchAll, toast, t])

  const toggleRule = useCallback(
    async (rule: AlertRule) => {
      setBusyId(rule.id)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/sync-logs/alerts/rules/${rule.id}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: !rule.enabled }),
          },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        void fetchAll()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e))
      } finally {
        setBusyId(null)
      }
    },
    [fetchAll, toast],
  )

  const deleteRule = useCallback(
    async (rule: AlertRule) => {
      if (!confirm(t('syncLogs.alerts.rules.deleteConfirm', { name: rule.name }))) return
      setBusyId(rule.id)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/sync-logs/alerts/rules/${rule.id}`,
          { method: 'DELETE' },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        toast.success(t('syncLogs.alerts.rules.deleted'))
        void fetchAll()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e))
      } finally {
        setBusyId(null)
      }
    },
    [fetchAll, toast, t],
  )

  const eventAction = useCallback(
    async (eventId: string, action: 'acknowledge' | 'resolve') => {
      setBusyId(eventId)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/sync-logs/alerts/events/${eventId}/${action}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        toast.success(
          action === 'acknowledge'
            ? t('syncLogs.alerts.events.markedAcknowledged')
            : t('syncLogs.alerts.events.markedResolved'),
        )
        void fetchAll()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e))
      } finally {
        setBusyId(null)
      }
    },
    [fetchAll, toast, t],
  )

  return (
    <div className="space-y-3">
      {error && (
        <div className="border border-rose-200 dark:border-rose-900 bg-rose-50 dark:bg-rose-950/40 rounded-md px-3 py-2 text-base text-rose-800 dark:text-rose-300 flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5" /> {error}
        </div>
      )}

      <div className="flex justify-end">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void fetchAll()}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          {t('syncLogs.alerts.refresh')}
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* RULES COLUMN */}
        <section className="border border-slate-200 dark:border-slate-800 rounded-md bg-white dark:bg-slate-900">
          <header className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300 inline-flex items-center gap-1.5">
              <Bell className="w-3 h-3" /> {t('syncLogs.alerts.rules.heading')}
            </h2>
            <span className="text-xs text-slate-500 dark:text-slate-500">
              {t('syncLogs.alerts.rules.summary', {
                total: rules.length,
                enabled: rules.filter((r) => r.enabled).length,
              })}
            </span>
          </header>

          {/* Create form */}
          <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 space-y-2 bg-slate-50/50 dark:bg-slate-800/30">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t('syncLogs.alerts.rules.namePlaceholder')}
              className="w-full px-2 py-1 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 focus:outline-none focus:border-slate-400 dark:focus:border-slate-500"
            />
            <div className="flex items-center gap-1.5 flex-wrap">
              <select
                value={newMetric}
                onChange={(e) => setNewMetric(e.target.value)}
                className="text-sm px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              >
                {METRICS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {t(`syncLogs.metric.${m.value}`)}
                  </option>
                ))}
              </select>
              <select
                value={newOperator}
                onChange={(e) => setNewOperator(e.target.value)}
                className="text-sm px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              >
                {OPERATORS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {t(`syncLogs.operator.${o.value}`)}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={newThreshold}
                onChange={(e) => setNewThreshold(e.target.value)}
                placeholder={t('syncLogs.alerts.rules.thresholdPlaceholder')}
                className="w-24 px-2 py-1 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
              <span className="text-xs text-slate-500 dark:text-slate-500">
                {METRICS.find((m) => m.value === newMetric)?.unit}
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-500">
                {t('syncLogs.alerts.rules.over')}
              </span>
              <input
                type="text"
                value={newWindow}
                onChange={(e) => setNewWindow(e.target.value)}
                className="w-14 px-2 py-1 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
              <span className="text-xs text-slate-500 dark:text-slate-500">
                {t('syncLogs.alerts.rules.minLabel')}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={newChannel}
                onChange={(e) => setNewChannel(e.target.value)}
                placeholder={t('syncLogs.alerts.rules.channelPlaceholder')}
                className="flex-1 px-2 py-1 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
              <input
                type="text"
                value={newNotify}
                onChange={(e) => setNewNotify(e.target.value)}
                placeholder={t('syncLogs.alerts.rules.notifyPlaceholder')}
                className="flex-1 px-2 py-1 text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
              />
            </div>
            <div className="flex justify-end">
              <Button
                variant="primary"
                size="sm"
                onClick={() => void createRule()}
                disabled={creating || !newName.trim()}
              >
                {creating ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Plus className="w-3.5 h-3.5" />
                )}
                {t('syncLogs.alerts.rules.add')}
              </Button>
            </div>
          </div>

          {/* Rules list */}
          {rules.length === 0 ? (
            <EmptyState
              icon={Bell}
              title={t('syncLogs.alerts.rules.empty.title')}
              description={t('syncLogs.alerts.rules.empty.description')}
            />
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {rules.map((r) => {
                const metric = METRICS.find((m) => m.value === r.metric)
                const op = OPERATORS.find((o) => o.value === r.operator)
                const thresholdDisplay =
                  r.metric === 'errorRate'
                    ? `${(r.threshold * 100).toFixed(2)}%`
                    : `${r.threshold}${metric?.unit ?? ''}`
                return (
                  <li key={r.id} className="px-3 py-2 flex items-start gap-3">
                    <button
                      type="button"
                      onClick={() => void toggleRule(r)}
                      disabled={busyId === r.id}
                      className={cn(
                        'flex-shrink-0 w-8 h-4 rounded-full transition-colors relative',
                        r.enabled
                          ? 'bg-emerald-500'
                          : 'bg-slate-300 dark:bg-slate-700',
                      )}
                      title={r.enabled ? t('syncLogs.alerts.rules.disable') : t('syncLogs.alerts.rules.enable')}
                    >
                      <span
                        className={cn(
                          'absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all',
                          r.enabled ? 'left-4' : 'left-0.5',
                        )}
                      />
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-base font-medium text-slate-900 dark:text-slate-100 truncate">
                          {r.name}
                        </span>
                        {r.lastFired && (
                          <Badge variant="danger" size="sm">
                            {t('syncLogs.alerts.rules.firing')}
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-500 mt-0.5 font-mono">
                        {metric ? t(`syncLogs.metric.${metric.value}`) : r.metric}{' '}
                        {op ? t(`syncLogs.operator.${op.value}`) : r.operator}{' '}
                        {thresholdDisplay}
                        {' · '}
                        {t('syncLogs.alerts.rules.windowSummary', {
                          window: r.windowMinutes,
                        })}
                        {r.channel && ` · ${r.channel}`}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-500 mt-0.5">
                        {t('syncLogs.alerts.rules.now', {
                          value: fmtMetricValue(r.metric, r.lastValue),
                        })}
                        {r.lastEvaluatedAt &&
                          ` · ${t('syncLogs.alerts.rules.checked', {
                            when: fmtRelative(r.lastEvaluatedAt),
                          })}`}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-500 mt-0.5 truncate">
                        {t('syncLogs.alerts.rules.notify', {
                          channels: r.notificationChannels.join(', '),
                        })}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void deleteRule(r)}
                      disabled={busyId === r.id}
                      className="flex-shrink-0 p-1 text-slate-400 hover:text-rose-600 dark:hover:text-rose-400"
                      title={t('syncLogs.alerts.rules.deleteTooltip')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        {/* EVENTS COLUMN */}
        <section className="border border-slate-200 dark:border-slate-800 rounded-md bg-white dark:bg-slate-900">
          <header className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-700 dark:text-slate-300 inline-flex items-center gap-1.5">
              <AlertCircle className="w-3 h-3" /> {t('syncLogs.alerts.events.heading')}
            </h2>
            <div className="flex items-center gap-1 ml-auto">
              {STATUS_OPTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatusFilter(s)}
                  className={cn(
                    'px-2 py-0.5 text-xs font-medium rounded border transition-colors',
                    statusFilter === s
                      ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 border-slate-900 dark:border-slate-100'
                      : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700',
                  )}
                >
                  {t(`syncLogs.alertStatus.${s}`)}
                </button>
              ))}
            </div>
          </header>

          {events.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title={
                statusFilter === 'TRIGGERED'
                  ? t('syncLogs.alerts.events.empty.active.title')
                  : t('syncLogs.alerts.events.empty.other.title', {
                      status: t(`syncLogs.alertStatus.${statusFilter}`).toLowerCase(),
                    })
              }
              description={
                statusFilter === 'TRIGGERED'
                  ? t('syncLogs.alerts.events.empty.active.description')
                  : t('syncLogs.alerts.events.empty.other.description')
              }
            />
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {events.map((e) => (
                <li key={e.id} className="px-3 py-2 flex items-start gap-3">
                  <span
                    className={cn(
                      'w-1.5 h-1.5 rounded-full flex-shrink-0 mt-2',
                      e.status === 'TRIGGERED'
                        ? 'bg-rose-500 animate-pulse'
                        : e.status === 'ACKNOWLEDGED'
                          ? 'bg-amber-500'
                          : 'bg-emerald-500',
                    )}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge
                        variant={
                          e.status === 'TRIGGERED'
                            ? 'danger'
                            : e.status === 'ACKNOWLEDGED'
                              ? 'warning'
                              : 'success'
                        }
                        size="sm"
                      >
                        {t(`syncLogs.alertStatus.${e.status}`)}
                      </Badge>
                      <span className="text-base font-medium text-slate-900 dark:text-slate-100 truncate">
                        {e.rule.name}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-500 mt-0.5 font-mono">
                      {t('syncLogs.alerts.events.value')}{' '}
                      <span className="text-rose-700 dark:text-rose-400 font-semibold">
                        {fmtMetricValue(e.rule.metric, e.value)}
                      </span>{' '}
                      · {fmtRelative(e.triggeredAt)}
                      {e.resolvedBy === 'auto' &&
                        ` · ${t('syncLogs.alerts.events.autoResolved')}`}
                    </div>
                    {e.notifications && e.notifications.length > 0 && (
                      <div className="text-xs text-slate-500 dark:text-slate-500 mt-0.5 truncate font-mono">
                        {t('syncLogs.alerts.events.sent')}{' '}
                        {e.notifications
                          .map((n) =>
                            n.ok ? `✓ ${n.channel}` : `✗ ${n.channel}`,
                          )
                          .join(' · ')}
                      </div>
                    )}
                  </div>
                  {e.status === 'TRIGGERED' && (
                    <div className="flex flex-col gap-1 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => void eventAction(e.id, 'acknowledge')}
                        disabled={busyId === e.id}
                        className="h-6 px-2 text-xs font-medium rounded border border-amber-300 dark:border-amber-700 bg-white dark:bg-slate-900 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/40 disabled:opacity-50"
                      >
                        {t('syncLogs.alerts.events.ack')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void eventAction(e.id, 'resolve')}
                        disabled={busyId === e.id}
                        className="h-6 px-2 text-xs font-medium rounded border border-emerald-300 dark:border-emerald-700 bg-white dark:bg-slate-900 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 disabled:opacity-50"
                      >
                        {t('syncLogs.alerts.events.resolve')}
                      </button>
                    </div>
                  )}
                  {e.status === 'ACKNOWLEDGED' && (
                    <button
                      type="button"
                      onClick={() => void eventAction(e.id, 'resolve')}
                      disabled={busyId === e.id}
                      className="flex-shrink-0 h-6 px-2 text-xs font-medium rounded border border-emerald-300 dark:border-emerald-700 bg-white dark:bg-slate-900 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 disabled:opacity-50"
                    >
                      {t('syncLogs.alerts.events.resolve')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
