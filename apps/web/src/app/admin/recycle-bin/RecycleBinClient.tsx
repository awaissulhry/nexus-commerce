'use client'

/**
 * RB.1 — Recycle bin housekeeping surface.
 *
 * One row per entity (Products, Orders, Inbound, Outbound, POs) showing
 * count in bin + age of the oldest item + a "Open bin" deep-link + a
 * manual purge form (delete rows older than N days from that entity's
 * bin). No cron runs purge automatically — operator decides.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, RefreshCw, Trash2, AlertTriangle, Clock } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { getBackendUrl } from '@/lib/backend-url'

interface BinEntity {
  key: 'product' | 'order' | 'inboundShipment' | 'shipment' | 'purchaseOrder'
  label: string
  href: string
  count: number
  oldestDeletedAt: string | null
}

function ageDays(iso: string | null): number | null {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)))
}

function ageTone(days: number | null): string {
  if (days == null) return 'text-tertiary'
  if (days >= 90) return 'text-rose-700 dark:text-rose-300'
  if (days >= 30) return 'text-amber-700 dark:text-amber-300'
  return 'text-slate-700 dark:text-slate-300'
}

export default function RecycleBinClient() {
  const [entities, setEntities] = useState<BinEntity[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [purgeBusyFor, setPurgeBusyFor] = useState<string | null>(null)
  const [purgeMessage, setPurgeMessage] = useState<string | null>(null)
  const [purgeDays, setPurgeDays] = useState<Record<string, number>>({})

  const fetchSummary = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/admin/recycle-bin/summary`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const data = await res.json()
      setEntities(data.entities ?? [])
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchSummary() }, [fetchSummary])

  const purge = async (entity: BinEntity) => {
    const days = purgeDays[entity.key] ?? 30
    if (!window.confirm(
      `Permanently delete every ${entity.label.toLowerCase()} in the recycle bin older than ${days} day${days === 1 ? '' : 's'}? This cannot be undone.`,
    )) return
    setPurgeBusyFor(entity.key)
    setPurgeMessage(null)
    try {
      const res = await fetch(`${getBackendUrl()}/admin/recycle-bin/purge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity: entity.key, olderThanDays: days }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setPurgeMessage(`${entity.label}: purged ${data.purged} row${data.purged === 1 ? '' : 's'}.`)
      fetchSummary()
    } catch (e: any) {
      setPurgeMessage(`${entity.label}: ${e?.message ?? 'purge failed'}`)
    } finally {
      setPurgeBusyFor(null)
      setTimeout(() => setPurgeMessage(null), 5000)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-600 dark:text-slate-400 max-w-2xl">
          Soft-deleted rows stay searchable inside each surface's recycle bin and can be restored
          at any time. Use the purge controls below when an entity's bin gets stale — purges are
          permanent.
        </p>
        <button
          type="button"
          onClick={fetchSummary}
          disabled={loading}
          className="h-8 px-3 text-sm border border-default dark:border-slate-700 rounded inline-flex items-center gap-1.5 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {error && (
        <Card>
          <div className="text-rose-700 dark:text-rose-300 inline-flex items-center gap-2">
            <AlertTriangle size={14} aria-hidden="true" /> {error}
          </div>
        </Card>
      )}

      {purgeMessage && (
        <Card>
          <div className="text-sm text-slate-700 dark:text-slate-300">{purgeMessage}</div>
        </Card>
      )}

      <Card>
        <div className="overflow-x-auto -mx-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800/50 border-b border-default dark:border-slate-700">
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">Entity</th>
                <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">In bin</th>
                <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">Oldest</th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">Open</th>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">Purge older than</th>
              </tr>
            </thead>
            <tbody>
              {entities.map((e) => {
                const days = ageDays(e.oldestDeletedAt)
                const cutoffDefault = purgeDays[e.key] ?? 30
                return (
                  <tr key={e.key} className="border-b border-subtle dark:border-slate-800 last:border-0">
                    <td className="px-3 py-3 font-medium text-slate-900 dark:text-slate-100">{e.label}</td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {e.count.toLocaleString()}
                    </td>
                    <td className={`px-3 py-3 text-right tabular-nums inline-flex items-center justify-end gap-1.5 ${ageTone(days)}`}>
                      {days != null ? (
                        <>
                          <Clock size={12} aria-hidden="true" />
                          {days} day{days === 1 ? '' : 's'}
                        </>
                      ) : (
                        <span className="text-tertiary dark:text-slate-500">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <Link
                        href={e.href}
                        className="inline-flex items-center gap-1 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
                      >
                        Open bin <ArrowRight size={12} aria-hidden="true" />
                      </Link>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={cutoffDefault}
                          onChange={(ev) => {
                            const v = parseInt(ev.target.value, 10)
                            setPurgeDays((s) => ({ ...s, [e.key]: Number.isFinite(v) ? v : 0 }))
                          }}
                          className="h-7 w-16 px-2 text-sm border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
                          aria-label={`Cutoff days for ${e.label}`}
                        />
                        <span className="text-xs text-slate-500 dark:text-slate-400">days</span>
                        <button
                          type="button"
                          onClick={() => purge(e)}
                          disabled={purgeBusyFor === e.key || e.count === 0}
                          className="h-7 px-3 text-sm bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800 rounded hover:bg-rose-100 dark:hover:bg-rose-900/40 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
                          title={
                            e.count === 0
                              ? `${e.label} bin is empty`
                              : `Purge ${e.label} older than ${cutoffDefault} days`
                          }
                        >
                          <Trash2 size={12} /> Purge
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
              {entities.length === 0 && !loading && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-slate-500 dark:text-slate-400">
                    {loading ? 'Loading…' : 'No entities to report.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="text-xs text-slate-500 dark:text-slate-400 max-w-2xl">
        Purge removes rows where <code className="font-mono">deletedAt</code> is non-null AND older than
        the chosen cutoff. Cascading children (items, attachments, etc.) follow the schema's
        <code className="font-mono"> onDelete </code> rules. No automatic cron runs this — operator-initiated only.
      </div>
    </div>
  )
}
