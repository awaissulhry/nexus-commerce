'use client'

/**
 * P.4 — extracted from ProductsWorkspace.tsx (was lines 1899-2377).
 *
 * H.8 — manage saved-view alerts.
 *
 * Lists every alert attached to a saved view, lets the user create
 * new ones (comparison + threshold + cooldown), toggle active,
 * delete, force-evaluate ("Test now"), or rebaseline. Each card
 * shows the live `lastCount` so the user can see what the cron
 * last observed without leaving the modal.
 */

import { useCallback, useEffect, useState } from 'react'
import { Bell, X, Plus, Trash2, RefreshCw } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import {
  emitInvalidation,
  useInvalidationChannel,
} from '@/lib/sync/invalidation-channel'

interface AlertRow {
  id: string
  name: string
  isActive: boolean
  comparison: 'GT' | 'LT' | 'CHANGE_ABS' | 'CHANGE_PCT' | string
  threshold: number
  baselineCount: number
  lastCount: number
  lastCheckedAt: string | null
  lastFiredAt: string | null
  cooldownMinutes: number
  createdAt: string
}

const COMPARISON_LABELS: Record<string, string> = {
  GT: 'Count is greater than',
  LT: 'Count is less than',
  CHANGE_ABS: 'Count moves by (absolute) ≥',
  CHANGE_PCT: 'Count moves by (percentage) ≥',
}

const COMPARISON_HINT: Record<string, string> = {
  GT: 'Fires when the matching count exceeds the threshold.',
  LT: 'Fires when the matching count drops below the threshold.',
  CHANGE_ABS:
    'Fires when |current − baseline| ≥ threshold. Baseline rebases after every fire.',
  CHANGE_PCT:
    'Fires when the count moves by ≥ threshold from the baseline. Enter as a fraction (0.2 = 20%).',
}

/**
 * Subset of SavedView this modal needs — id + name only. Defined
 * locally so the modal doesn't need to import the full SavedView
 * shape from the workspace.
 */
export interface SavedViewRef {
  id: string
  name: string
}

export default function ManageAlertsModal({
  view,
  onClose,
}: {
  view: SavedViewRef
  onClose: () => void
}) {
  const askConfirm = useConfirm()
  const [alerts, setAlerts] = useState<AlertRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [draftComparison, setDraftComparison] = useState<
    'GT' | 'LT' | 'CHANGE_ABS' | 'CHANGE_PCT'
  >('GT')
  const [draftThreshold, setDraftThreshold] = useState('10')
  const [draftCooldown, setDraftCooldown] = useState('60')
  const [draftName, setDraftName] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/saved-views/${view.id}/alerts`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setAlerts(json.alerts ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [view.id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // P.3 — keep this open modal's alert list fresh when a sibling tab
  // (or the saved-view alerts cron via webhook in the future) edits
  // an alert attached to this view.
  useInvalidationChannel(['saved-view-alert.changed'], (event) => {
    if (event.meta?.savedViewId === view.id) {
      void refresh()
    }
  })

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/saved-views/${view.id}/alerts`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: draftName.trim() || view.name,
            comparison: draftComparison,
            threshold: Number(draftThreshold),
            cooldownMinutes: Number(draftCooldown),
          }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      setCreating(false)
      setDraftName('')
      setDraftThreshold('10')
      setDraftCooldown('60')
      void refresh()
      emitInvalidation({
        type: 'saved-view-alert.changed',
        meta: { savedViewId: view.id, action: 'created' },
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const patchAlert = async (id: string, body: Record<string, unknown>) => {
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/saved-view-alerts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      void refresh()
      emitInvalidation({
        type: 'saved-view-alert.changed',
        id,
        meta: { savedViewId: view.id, action: 'updated' },
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const deleteAlert = async (id: string) => {
    if (!(await askConfirm({ title: 'Delete this alert?', confirmLabel: 'Delete', tone: 'danger' }))) return
    setBusy(true)
    try {
      await fetch(`${getBackendUrl()}/api/saved-view-alerts/${id}`, {
        method: 'DELETE',
      })
      void refresh()
      emitInvalidation({
        type: 'saved-view-alert.changed',
        id,
        meta: { savedViewId: view.id, action: 'deleted' },
      })
    } finally {
      setBusy(false)
    }
  }

  const evaluateNow = async (id: string) => {
    setBusy(true)
    setError(null)
    try {
      await fetch(
        `${getBackendUrl()}/api/saved-view-alerts/${id}/evaluate`,
        { method: 'POST' },
      )
      void refresh()
      emitInvalidation({
        type: 'saved-view-alert.changed',
        id,
        meta: { savedViewId: view.id, action: 'evaluated' },
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const rebaseline = async (id: string) => {
    setBusy(true)
    try {
      await fetch(
        `${getBackendUrl()}/api/saved-view-alerts/${id}/rebaseline`,
        { method: 'POST' },
      )
      void refresh()
      emitInvalidation({
        type: 'saved-view-alert.changed',
        id,
        meta: { savedViewId: view.id, action: 'rebaselined' },
      })
    } finally {
      setBusy(false)
    }
  }

  const fmtThreshold = (cmp: string, t: number) => {
    if (cmp === 'CHANGE_PCT') return `${(t * 100).toFixed(0)}%`
    return t.toLocaleString()
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between flex-shrink-0">
          <div>
            <div className="text-lg font-semibold text-slate-900 inline-flex items-center gap-1.5">
              <Bell className="w-4 h-4 text-purple-600" />
              Alerts for &ldquo;{view.name}&rdquo;
            </div>
            <div className="text-sm text-slate-500 mt-0.5">
              The 5-minute cron checks every active alert against this
              view&apos;s filter and fires an in-app notification when
              the condition trips.
            </div>
          </div>
          <IconButton
            onClick={onClose}
            aria-label="Close"
            size="md"
            className="text-slate-400 hover:text-slate-600"
          >
            <X className="w-4 h-4" />
          </IconButton>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {error && (
            <div className="border border-rose-200 bg-rose-50 rounded-md px-3 py-2 text-base text-rose-800">
              {error}
            </div>
          )}

          {loading ? (
            <div className="text-base text-slate-400 italic text-center py-6">
              Loading…
            </div>
          ) : alerts.length === 0 && !creating ? (
            <div className="text-center py-6 space-y-2">
              <Bell className="w-6 h-6 mx-auto text-slate-300" />
              <div className="text-base text-slate-500">
                No alerts on this view yet.
              </div>
            </div>
          ) : (
            alerts.map((a) => (
              <div
                key={a.id}
                className={`border rounded-md p-3 ${
                  a.isActive
                    ? 'border-slate-200 bg-white'
                    : 'border-slate-100 bg-slate-50/40 opacity-70'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-md font-medium text-slate-900 truncate">
                      {a.name}
                    </div>
                    <div className="text-sm text-slate-500 mt-0.5">
                      {COMPARISON_LABELS[a.comparison] ?? a.comparison}{' '}
                      <span className="font-medium text-slate-700">
                        {fmtThreshold(a.comparison, a.threshold)}
                      </span>
                      {' · cooldown '}
                      {a.cooldownMinutes}m
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => patchAlert(a.id, { isActive: !a.isActive })}
                    disabled={busy}
                    className={`h-6 px-2 text-sm rounded ${
                      a.isActive
                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100'
                        : 'bg-slate-100 text-slate-600 border border-slate-200 hover:bg-slate-200'
                    }`}
                  >
                    {a.isActive ? 'Active' : 'Paused'}
                  </button>
                </div>

                <div className="grid grid-cols-3 gap-2 text-sm text-slate-600 mt-2">
                  <div>
                    <div className="text-slate-400 uppercase tracking-wider text-xs">
                      Last count
                    </div>
                    <div className="text-slate-900 font-medium tabular-nums">
                      {a.lastCount.toLocaleString()}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-400 uppercase tracking-wider text-xs">
                      Baseline
                    </div>
                    <div className="text-slate-900 font-medium tabular-nums">
                      {a.baselineCount.toLocaleString()}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-400 uppercase tracking-wider text-xs">
                      Last fired
                    </div>
                    <div className="text-slate-900 font-medium">
                      {a.lastFiredAt
                        ? new Date(a.lastFiredAt).toLocaleString()
                        : '—'}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => evaluateNow(a.id)}
                    disabled={busy}
                    className="h-6 px-2 text-sm text-slate-700 hover:bg-slate-100 rounded inline-flex items-center gap-1"
                  >
                    <RefreshCw className="w-3 h-3" />
                    Test now
                  </button>
                  <button
                    type="button"
                    onClick={() => rebaseline(a.id)}
                    disabled={busy}
                    title="Reset baseline to last observed count"
                    className="h-6 px-2 text-sm text-slate-700 hover:bg-slate-100 rounded"
                  >
                    Rebaseline
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteAlert(a.id)}
                    disabled={busy}
                    className="ml-auto h-6 px-2 text-sm text-rose-700 hover:bg-rose-50 rounded inline-flex items-center gap-1"
                  >
                    <Trash2 className="w-3 h-3" />
                    Delete
                  </button>
                </div>
              </div>
            ))
          )}

          {creating && (
            <div className="border border-purple-200 bg-purple-50/40 rounded-md p-3 space-y-2">
              <div className="text-sm font-semibold text-purple-700 uppercase tracking-wider">
                New alert
              </div>
              <div>
                <label className="text-sm text-slate-700 block mb-1">
                  Name (optional)
                </label>
                <input
                  type="text"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  placeholder={view.name}
                  className="w-full h-8 px-2 text-base border border-slate-200 rounded bg-white"
                />
              </div>
              <div>
                <label className="text-sm text-slate-700 block mb-1">
                  Condition
                </label>
                <select
                  value={draftComparison}
                  onChange={(e) =>
                    setDraftComparison(
                      e.target.value as
                        | 'GT'
                        | 'LT'
                        | 'CHANGE_ABS'
                        | 'CHANGE_PCT',
                    )
                  }
                  className="w-full h-8 px-2 text-base border border-slate-200 rounded bg-white"
                >
                  {Object.entries(COMPARISON_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
                <div className="text-xs text-slate-500 mt-1">
                  {COMPARISON_HINT[draftComparison]}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-sm text-slate-700 block mb-1">
                    Threshold
                  </label>
                  <input
                    type="number"
                    step={
                      draftComparison === 'CHANGE_PCT' ? '0.05' : '1'
                    }
                    value={draftThreshold}
                    onChange={(e) => setDraftThreshold(e.target.value)}
                    className="w-full h-8 px-2 text-base border border-slate-200 rounded bg-white tabular-nums"
                  />
                </div>
                <div>
                  <label className="text-sm text-slate-700 block mb-1">
                    Cooldown (min)
                  </label>
                  <input
                    type="number"
                    min="1"
                    value={draftCooldown}
                    onChange={(e) => setDraftCooldown(e.target.value)}
                    className="w-full h-8 px-2 text-base border border-slate-200 rounded bg-white tabular-nums"
                  />
                </div>
              </div>
              <div className="flex items-center justify-end gap-1.5 pt-1">
                <button
                  type="button"
                  onClick={() => setCreating(false)}
                  className="h-7 px-2 text-sm text-slate-600 hover:bg-slate-100 rounded"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={create}
                  disabled={busy || !draftThreshold}
                  className="h-7 px-3 text-sm bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50"
                >
                  Create alert
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-between flex-shrink-0">
          <div className="text-sm text-slate-500">
            Cron checks every 5 minutes.
          </div>
          {!creating && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="h-7 px-3 text-sm bg-purple-600 text-white rounded hover:bg-purple-700 inline-flex items-center gap-1"
            >
              <Plus className="w-3 h-3" />
              New alert
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
