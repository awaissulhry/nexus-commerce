'use client'

/**
 * W14.9 — Scheduled imports operator surface.
 *
 * Pre-W14.9 the W8.4 ScheduledImport CRUD was reachable only via
 * the REST API. This panel renders the list + new-form +
 * enable/disable toggle + manual fire so operators can manage
 * recurring URL pulls without curl.
 *
 * Mounts as a tab on /bulk-operations/imports.
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

interface ScheduledImport {
  id: string
  name: string
  source: string
  sourceUrl: string
  targetEntity: string
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

const TARGET_ENTITIES = ['product', 'channelListing', 'inventory'] as const

export default function ScheduledImportsPanel() {
  const askConfirm = useConfirm()
  const [rows, setRows] = useState<ScheduledImport[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  // New form state
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const [targetEntity, setTargetEntity] =
    useState<(typeof TARGET_ENTITIES)[number]>('product')
  const [cronExpression, setCronExpression] = useState('0 6 * * *')
  const [columnMapping, setColumnMapping] = useState('{"sku":"SKU"}')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/scheduled-imports?limit=200`,
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
    if (!name.trim() || !sourceUrl.trim()) {
      setError('Name and source URL are required')
      return
    }
    let mapping: Record<string, string>
    try {
      mapping = JSON.parse(columnMapping)
      if (typeof mapping !== 'object' || mapping == null) throw new Error('not object')
    } catch {
      setError('Column mapping must be valid JSON object: {"sku":"SKU","price":"Price"}')
      return
    }
    setCreating(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/scheduled-imports`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            source: 'url',
            sourceUrl,
            targetEntity,
            columnMapping: mapping,
            cronExpression,
          }),
        },
      )
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`)
      setShowForm(false)
      setName('')
      setSourceUrl('')
      setColumnMapping('{"sku":"SKU"}')
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }

  const toggle = async (row: ScheduledImport) => {
    setBusy(row.id)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/scheduled-imports/${row.id}/enabled`,
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

  const remove = async (row: ScheduledImport) => {
    const ok = await askConfirm({
      title: `Delete scheduled import "${row.name}"?`,
      description: 'The recurring URL pull will stop. Past job rows are kept for audit.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return
    setBusy(row.id)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/scheduled-imports/${row.id}`,
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
        `${getBackendUrl()}/api/scheduled-imports/tick`,
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
          Recurring URL pulls. The cron worker fires due rows every 5 minutes.
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
            {showForm ? 'Cancel' : 'New scheduled import'}
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
            <label className="block md:col-span-2">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-0.5 block">
                Source URL (http(s))
              </span>
              <input
                type="text"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://supplier.example/feed.csv"
                className="w-full h-8 px-2 text-sm border border-slate-200 dark:border-slate-700 dark:bg-slate-900 rounded outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
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
                Column mapping (JSON)
              </span>
              <input
                type="text"
                value={columnMapping}
                onChange={(e) => setColumnMapping(e.target.value)}
                placeholder='{"sku":"SKU","price":"Price"}'
                className="w-full h-8 px-2 text-sm font-mono border border-slate-200 dark:border-slate-700 dark:bg-slate-900 rounded outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </label>
          </div>
          <div className="flex justify-end">
            <Button
              variant="primary"
              size="sm"
              onClick={create}
              disabled={creating || !name.trim() || !sourceUrl.trim()}
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
              : 'No scheduled imports yet. Click "New scheduled import" to create one.'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Name</th>
                <th className="text-left px-3 py-2 font-medium">Source</th>
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
                  <td className="px-3 py-2 max-w-[260px] truncate font-mono text-xs text-slate-500 dark:text-slate-400">
                    {r.sourceUrl}
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
