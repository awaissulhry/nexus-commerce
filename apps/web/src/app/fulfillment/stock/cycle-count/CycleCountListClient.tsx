'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  CheckCircle2,
  ClipboardCheck,
  Loader2,
  Plus,
  RefreshCw,
  Warehouse as WarehouseIcon,
  X,
  Zap,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input } from '@/components/ui/Input'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { formatRelative } from '@/components/inventory/formatRelative'
import { cn } from '@/lib/utils'

interface CountSummary {
  id: string
  status: string
  notes: string | null
  startedAt: string | null
  completedAt: string | null
  cancelledAt: string | null
  createdAt: string
  location: { id: string; code: string; name: string }
  totalItems: number
  itemTotals: Record<string, number>
}

interface Location {
  id: string
  code: string
  name: string
}

function relativeTime(iso: string | null, t: (k: string, vars?: Record<string, string | number>) => string): string {
  if (!iso) return '—'
  return formatRelative(iso, t)
}

function statusVariant(status: string): 'success' | 'warning' | 'danger' | 'info' | 'default' {
  switch (status) {
    case 'COMPLETED': return 'success'
    case 'IN_PROGRESS': return 'info'
    case 'DRAFT': return 'warning'
    case 'CANCELLED': return 'danger'
    default: return 'default'
  }
}

// S.11 — labels resolve via t() per render so locale flips refresh
// the chip text. Keys stay declarative.
const STATUS_FILTERS = [
  { key: 'all', labelKey: 'cycleCount.list.statusAll' },
  { key: 'DRAFT', labelKey: 'cycleCount.list.statusDraft' },
  { key: 'IN_PROGRESS', labelKey: 'cycleCount.list.statusInProgress' },
  { key: 'COMPLETED', labelKey: 'cycleCount.list.statusCompleted' },
  { key: 'CANCELLED', labelKey: 'cycleCount.list.statusCancelled' },
] as const

export default function CycleCountListClient() {
  const { toast } = useToast()
  const { t } = useTranslations()
  const [counts, setCounts] = useState<CountSummary[] | null>(null)
  const [locations, setLocations] = useState<Location[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<string>('all')

  // Create modal state
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newLocationId, setNewLocationId] = useState('')
  const [newNotes, setNewNotes] = useState('')
  // S.17 — busy flag for the auto-schedule trigger.
  const [autoScheduling, setAutoScheduling] = useState(false)

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      const url = new URL(`${getBackendUrl()}/api/fulfillment/cycle-counts`)
      if (statusFilter !== 'all') url.searchParams.set('status', statusFilter)
      url.searchParams.set('limit', '100')
      const [countsRes, locsRes] = await Promise.all([
        fetch(url.toString(), { cache: 'no-store' }),
        fetch(`${getBackendUrl()}/api/stock/locations`, { cache: 'no-store' }),
      ])
      if (!countsRes.ok) {
        const body = await countsRes.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${countsRes.status}`)
      }
      const json = await countsRes.json()
      setCounts(json.counts ?? [])
      if (locsRes.ok) {
        const locJson = await locsRes.json()
        // /api/stock/locations may return { locations: [...] } or [...]
        const locArr = Array.isArray(locJson) ? locJson : locJson.locations ?? []
        setLocations(
          locArr
            .filter((l: any) => l && l.id && l.code)
            .map((l: any) => ({ id: l.id, code: l.code, name: l.name ?? l.code })),
        )
      }
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // S.17 — trigger the auto-scheduler now (the daily cron already
  // runs this at 02:30 UTC; this button lets the operator force one
  // mid-day if they want a fresh batch). Idempotent on the server
  // side against an existing DRAFT/IN_PROGRESS auto-scheduled session.
  const handleAutoSchedule = async () => {
    setAutoScheduling(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/cycle-counts/auto-schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      const r = body.result
      if (!r?.sessionId) {
        toast.success(t('cycleCount.list.toast.autoScheduleNoneDue'))
      } else {
        toast.success(t('cycleCount.list.toast.autoScheduled', { n: r.itemCount }))
      }
      await fetchData()
    } catch (err) {
      toast.error(t('cycleCount.list.toast.autoScheduleFailed', {
        error: err instanceof Error ? err.message : String(err),
      }))
    } finally {
      setAutoScheduling(false)
    }
  }

  const handleCreate = async () => {
    if (!newLocationId) {
      toast.error(t('cycleCount.list.toast.selectLocation'))
      return
    }
    setCreating(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/cycle-counts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          locationId: newLocationId,
          notes: newNotes.trim() || undefined,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      toast.success(t('cycleCount.list.toast.created'))
      setCreateOpen(false)
      setNewLocationId('')
      setNewNotes('')
      await fetchData()
    } catch (err) {
      toast.error(t('cycleCount.list.toast.createFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1 flex-wrap">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setStatusFilter(f.key)}
              className={cn(
                'px-3 py-1 text-sm font-medium rounded border transition-colors',
                statusFilter === f.key
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600',
              )}
            >
              {t(f.labelKey)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={fetchData} disabled={loading}>
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
            {t('cycleCount.list.actionRefresh')}
          </Button>
          {/* S.17 — manual trigger for the ABC-driven scheduler.
              Daily cron runs at 02:30 UTC; this button lets the
              operator force a session immediately when desired. */}
          <Button
            variant="secondary"
            size="sm"
            onClick={handleAutoSchedule}
            disabled={autoScheduling}
            title={t('cycleCount.list.actionAutoScheduleTitle')}
          >
            {autoScheduling
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <Zap className="w-3.5 h-3.5" />}
            {t('cycleCount.list.actionAutoSchedule')}
          </Button>
          <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="w-3.5 h-3.5" />
            {t('cycleCount.list.actionNew')}
          </Button>
        </div>
      </div>

      {error && (
        <div className="text-base text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 inline-flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5" />
          {error}
        </div>
      )}

      {loading && !counts && (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg animate-pulse" />
          ))}
        </div>
      )}

      {counts && counts.length === 0 && !loading && (
        <EmptyState
          icon={ClipboardCheck}
          title={t('cycleCount.list.empty.title')}
          description={t('cycleCount.list.empty.description')}
          action={{ label: t('cycleCount.list.empty.action'), onClick: () => setCreateOpen(true) }}
        />
      )}

      {counts && counts.length > 0 && (
        <div className="space-y-2">
          {counts.map((c) => {
            const resolved = (c.itemTotals.RECONCILED ?? 0) + (c.itemTotals.IGNORED ?? 0)
            const counted = c.itemTotals.COUNTED ?? 0
            const pending = c.itemTotals.PENDING ?? 0
            const progressPct = c.totalItems > 0 ? Math.round((resolved / c.totalItems) * 100) : 0
            return (
              <Link
                key={c.id}
                href={`/fulfillment/stock/cycle-count/${c.id}`}
                className="block bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-4 hover:border-slate-300 dark:hover:border-slate-600 hover:shadow-sm transition-all"
              >
                <div className="flex items-start gap-3">
                  <ClipboardCheck className="w-5 h-5 text-slate-500 dark:text-slate-400 flex-shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={statusVariant(c.status)} size="sm">
                        {c.status.replace(/_/g, ' ')}
                      </Badge>
                      <span className="font-medium text-slate-900 dark:text-slate-100 inline-flex items-center gap-1">
                        <WarehouseIcon className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500" />
                        {c.location.name}
                        <span className="text-sm font-mono text-slate-500 dark:text-slate-400 ml-1">
                          ({c.location.code})
                        </span>
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-sm text-slate-500 dark:text-slate-400 flex-wrap">
                      <span>
                        {t('cycleCount.list.row.itemsSummary', {
                          n: c.totalItems,
                          pending,
                          counted,
                        })}
                        {' · '}
                        <span className="text-green-700 font-medium">
                          {t('cycleCount.list.row.reconciledSuffix', { n: c.itemTotals.RECONCILED ?? 0 })}
                        </span>
                        {(c.itemTotals.IGNORED ?? 0) > 0 && (
                          <> · <span className="text-amber-700">{t('cycleCount.list.row.ignoredSuffix', { n: c.itemTotals.IGNORED })}</span></>
                        )}
                      </span>
                      <span>·</span>
                      <span title={new Date(c.createdAt).toLocaleString()}>
                        {t('cycleCount.list.row.created', { when: relativeTime(c.createdAt, t) })}
                      </span>
                      {c.startedAt && (
                        <span>· {t('cycleCount.list.row.started', { when: relativeTime(c.startedAt, t) })}</span>
                      )}
                      {c.completedAt && (
                        <span>· {t('cycleCount.list.row.completed', { when: relativeTime(c.completedAt, t) })}</span>
                      )}
                    </div>
                    {c.notes && (
                      <div className="text-sm text-slate-600 dark:text-slate-400 mt-1 italic truncate">
                        {c.notes}
                      </div>
                    )}
                    {/* Progress bar */}
                    {c.totalItems > 0 && c.status !== 'CANCELLED' && (
                      <div className="mt-2 h-1 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                        <div
                          className={cn(
                            'h-full transition-all',
                            c.status === 'COMPLETED' ? 'bg-green-500' : 'bg-blue-500',
                          )}
                          style={{ width: `${progressPct}%` }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </Link>
            )
          })}
        </div>
      )}

      {/* Create modal */}
      {createOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-start justify-center pt-[10vh] px-4"
          onClick={() => !creating && setCreateOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="bg-white dark:bg-slate-900 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t('cycleCount.list.modal.title')}</h2>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                disabled={creating}
                className="text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:text-slate-300 disabled:opacity-50"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <div>
                <label htmlFor="cycle-count-location" className="text-sm font-medium text-slate-700 dark:text-slate-300 uppercase tracking-wide">
                  {t('cycleCount.list.modal.locationLabel')} <span className="text-red-600">*</span>
                </label>
                <select
                  id="cycle-count-location"
                  value={newLocationId}
                  onChange={(e) => setNewLocationId(e.target.value)}
                  className="mt-1 w-full px-3 py-1.5 text-md border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-300"
                >
                  <option value="">{t('cycleCount.list.modal.locationPlaceholder')}</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.code} — {l.name}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  {t('cycleCount.list.modal.locationHelp')}
                </p>
              </div>
              <div>
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300 uppercase tracking-wide">
                  {t('cycleCount.list.modal.notesLabel')}
                </label>
                <Input
                  type="text"
                  value={newNotes}
                  onChange={(e) => setNewNotes(e.target.value)}
                  placeholder={t('cycleCount.list.modal.notesPlaceholder')}
                  className="mt-1"
                />
              </div>
              <div className="flex items-center gap-2 pt-2 border-t border-slate-200 dark:border-slate-700">
                <Button variant="primary" size="sm" onClick={handleCreate} disabled={creating}>
                  {creating ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <CheckCircle2 className="w-3.5 h-3.5" />
                  )}
                  {t('cycleCount.list.modal.create')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setCreateOpen(false)}
                  disabled={creating}
                >
                  {t('cycleCount.list.modal.cancel')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
