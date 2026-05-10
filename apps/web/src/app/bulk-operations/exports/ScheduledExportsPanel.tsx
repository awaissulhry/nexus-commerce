'use client'

/**
 * W14.10 — Scheduled exports operator surface.
 *
 * Mirror of the W14.9 ScheduledImportsPanel, but for the W9.4
 * ScheduledExport schema. Manages recurring exports + their
 * email / webhook delivery configuration without operators
 * needing to curl the REST API.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  XCircle,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'

interface ScheduledExport {
  id: string
  name: string
  format: string
  targetEntity: string
  delivery: string
  deliveryTarget: string | null
  cronExpression: string | null
  scheduledFor: string | null
  timezone: string
  nextRunAt: string | null
  enabled: boolean
  lastRunAt: string | null
  lastStatus: string | null
  lastError: string | null
  runCount: number
  createdAt: string
}

const FORMATS = ['csv', 'xlsx', 'json', 'pdf'] as const
const TARGET_ENTITIES = ['product', 'channelListing', 'inventory'] as const
const DELIVERIES = ['email', 'webhook'] as const

const DEFAULT_COLUMNS = [
  { id: 'sku', label: 'SKU' },
  { id: 'name', label: 'Name' },
  { id: 'brand', label: 'Brand' },
  { id: 'basePrice', label: 'Base price', format: 'currency' as const },
  { id: 'totalStock', label: 'Stock', format: 'number' as const },
]

export default function ScheduledExportsPanel() {
  const askConfirm = useConfirm()
  const [rows, setRows] = useState<ScheduledExport[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [format, setFormat] = useState<(typeof FORMATS)[number]>('csv')
  const [targetEntity, setTargetEntity] =
    useState<(typeof TARGET_ENTITIES)[number]>('product')
  const [delivery, setDelivery] = useState<(typeof DELIVERIES)[number]>('email')
  const [deliveryTarget, setDeliveryTarget] = useState('')
  const [cronExpression, setCronExpression] = useState('0 7 * * *')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/scheduled-exports?limit=200`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json()
      setRows(Array.isArray(j.schedules) ? j.schedules : [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const create = async () => {
    if (!name.trim()) {
      setError('Name is required')
      return
    }
    if (delivery === 'webhook' && !/^https?:\/\//i.test(deliveryTarget)) {
      setError('Webhook delivery requires an http(s) URL in deliveryTarget')
      return
    }
    setCreating(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/scheduled-exports`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            format,
            targetEntity,
            columns: DEFAULT_COLUMNS,
            filters: null,
            delivery,
            deliveryTarget: deliveryTarget || null,
            cronExpression,
          }),
        },
      )
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`)
      setShowForm(false)
      setName('')
      setDeliveryTarget('')
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }

  const toggle = async (row: ScheduledExport) => {
    setBusy(row.id)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/scheduled-exports/${row.id}/enabled`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !row.enabled }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (row: ScheduledExport) => {
    const ok = await askConfirm({
      title: `Delete scheduled export "${row.name}"?`,
      description:
        'The recurring export will stop. Past ExportJob rows are kept for download.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return
    setBusy(row.id)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/scheduled-exports/${row.id}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const fireTick = async () => {
    setBusy('tick')
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/scheduled-exports/tick`,
        { method: 'POST' },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="px-3 md:px-6 space-y-3">
      {error && (
        <div
          className="text-base text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded px-3 py-2 inline-flex items-start gap-2"
          role="alert"
        >
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" aria-hidden="true" />
          <div>{error}</div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="text-sm text-slate-600 dark:text-slate-400">
          Recurring exports. The cron worker fires due rows every 5 minutes;
          email delivery logs to Notification, webhook POSTs the bytes.
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            onClick={fireTick}
            disabled={busy === 'tick'}
          >
            <RefreshCw className="w-3 h-3 mr-1" aria-hidden="true" />
            Run tick now
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => setShowForm((s) => !s)}
          >
            <Plus className="w-3 h-3 mr-1" aria-hidden="true" />
            {showForm ? 'Cancel' : 'New scheduled export'}
          </Button>
        </div>
      </div>

      {showForm && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <label className="block">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-0.5 block">
                Name
              </span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full h-8 px-2 text-sm border border-slate-200 dark:border-slate-700 dark:bg-slate-900 rounded outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-0.5 block">
                Cron (Europe/Rome)
              </span>
              <input
                type="text"
                value={cronExpression}
                onChange={(e) => setCronExpression(e.target.value)}
                className="w-full h-8 px-2 text-sm border border-slate-200 dark:border-slate-700 dark:bg-slate-900 rounded outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-0.5 block">
                Format
              </span>
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value as typeof format)}
                className="w-full h-8 px-2 text-sm border border-slate-200 dark:border-slate-700 dark:bg-slate-900 rounded"
              >
                {FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {f.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-0.5 block">
                Target entity
              </span>
              <select
                value={targetEntity}
                onChange={(e) =>
                  setTargetEntity(e.target.value as typeof targetEntity)
                }
                className="w-full h-8 px-2 text-sm border border-slate-200 dark:border-slate-700 dark:bg-slate-900 rounded"
              >
                {TARGET_ENTITIES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-0.5 block">
                Delivery
              </span>
              <select
                value={delivery}
                onChange={(e) => setDelivery(e.target.value as typeof delivery)}
                className="w-full h-8 px-2 text-sm border border-slate-200 dark:border-slate-700 dark:bg-slate-900 rounded"
              >
                {DELIVERIES.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-0.5 block">
                {delivery === 'email'
                  ? 'Delivery target (email address)'
                  : 'Delivery target (http(s) webhook URL)'}
              </span>
              <input
                type="text"
                value={deliveryTarget}
                onChange={(e) => setDeliveryTarget(e.target.value)}
                placeholder={
                  delivery === 'email'
                    ? 'ops@example.com'
                    : 'https://example.com/webhook'
                }
                className="w-full h-8 px-2 text-sm border border-slate-200 dark:border-slate-700 dark:bg-slate-900 rounded outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </label>
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Default columns: {DEFAULT_COLUMNS.map((c) => c.label).join(' · ')}.
            For a custom column set, use the operator-side Export wizard once
            and copy the columns array via API.
          </div>
          <div className="flex justify-end">
            <Button
              variant="primary"
              size="sm"
              onClick={create}
              disabled={creating || !name.trim()}
              loading={creating}
            >
              Create
            </Button>
          </div>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        {rows.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-slate-500 dark:text-slate-400">
            {loading
              ? 'Loading…'
              : 'No scheduled exports yet. Click "New scheduled export" to create one.'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Name</th>
                <th className="text-left px-3 py-2 font-medium">Format</th>
                <th className="text-left px-3 py-2 font-medium">Delivery</th>
                <th className="text-left px-3 py-2 font-medium">Cron</th>
                <th className="text-left px-3 py-2 font-medium">Next run</th>
                <th className="text-left px-3 py-2 font-medium">Last</th>
                <th className="text-right px-3 py-2 font-medium tabular-nums">
                  Runs
                </th>
                <th className="text-right px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={
                    r.enabled
                      ? 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                      : 'opacity-60 hover:bg-slate-50 dark:hover:bg-slate-800/40'
                  }
                >
                  <td className="px-3 py-2 max-w-[200px] truncate font-medium text-slate-800 dark:text-slate-200">
                    {r.name}
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {r.targetEntity}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs uppercase font-mono text-slate-500 dark:text-slate-400">
                    {r.format}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <div className="font-medium text-slate-700 dark:text-slate-300">
                      {r.delivery}
                    </div>
                    {r.deliveryTarget && (
                      <div className="text-xs text-slate-500 dark:text-slate-400 truncate max-w-[200px]">
                        {r.deliveryTarget}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {r.cronExpression ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                    {r.nextRunAt ? new Date(r.nextRunAt).toLocaleString() : '—'}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.lastStatus ? (
                      <span className="inline-flex items-center gap-1">
                        {r.lastStatus === 'COMPLETED' ? (
                          <CheckCircle2 className="w-3 h-3 text-green-600 dark:text-green-400" aria-hidden="true" />
                        ) : r.lastStatus === 'FAILED' ? (
                          <XCircle className="w-3 h-3 text-red-600 dark:text-red-400" aria-hidden="true" />
                        ) : (
                          <Clock className="w-3 h-3 text-slate-400 dark:text-slate-500" aria-hidden="true" />
                        )}
                        <Badge
                          variant={
                            r.lastStatus === 'COMPLETED'
                              ? 'success'
                              : r.lastStatus === 'FAILED'
                                ? 'danger'
                                : 'default'
                          }
                          size="sm"
                        >
                          {r.lastStatus}
                        </Badge>
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.runCount.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => toggle(r)}
                        disabled={busy === r.id}
                        title={r.enabled ? 'Pause' : 'Resume'}
                        aria-label={
                          r.enabled
                            ? `Pause ${r.name}`
                            : `Resume ${r.name}`
                        }
                        className="h-6 w-6 inline-flex items-center justify-center text-slate-500 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-950/30 rounded disabled:opacity-50"
                      >
                        {r.enabled ? (
                          <Pause className="w-3 h-3" aria-hidden="true" />
                        ) : (
                          <Play className="w-3 h-3" aria-hidden="true" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(r)}
                        disabled={busy === r.id}
                        title="Delete"
                        aria-label={`Delete ${r.name}`}
                        className="h-6 w-6 inline-flex items-center justify-center text-slate-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 rounded disabled:opacity-50"
                      >
                        <Trash2 className="w-3 h-3" aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
