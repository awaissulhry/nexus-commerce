'use client'

// PB.10 — Scheduled image-publish modal.
//
// Two-pane layout:
//   Top    — "Schedule new" form: date/time + channel + marketplace
//            (Amazon). Submit creates a ScheduledImagePublish row.
//   Bottom — "Pending" list with cancel buttons.
//
// Mounted from the ImageActionBar's Publish dropdown ("Schedule for
// later…"). Cron worker (apps/api/src/jobs/scheduled-image-publish.job.ts)
// picks up due rows on its 60s tick.

import { useCallback, useEffect, useState } from 'react'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/components.css'
import { AlertTriangle, Calendar, CheckCircle2, Clock, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { cn } from '@/lib/utils'
import { beFetch } from './api'
import { Listbox } from '@/design-system/components/Listbox'

type ChannelKey = 'AMAZON' | 'EBAY' | 'SHOPIFY'
type AmazonMarketplace = 'IT' | 'DE' | 'FR' | 'ES' | 'UK' | 'ALL'

const AMAZON_MARKETS: AmazonMarketplace[] = ['IT', 'DE', 'FR', 'ES', 'UK', 'ALL']

interface ScheduledRow {
  id: string
  productId: string
  channel: string
  marketplace: string | null
  scheduledFor: string
  status: string
  fireError: string | null
  createdAt: string
}

interface Props {
  open: boolean
  productId: string
  onClose: () => void
  /** Refetch trigger — bump after schedule create/cancel so the
   *  action bar's pending-count badge stays current. */
  onChanged?: () => void
}

function localDateTimeInputValue(d: Date): string {
  // Format: "YYYY-MM-DDTHH:MM" required by <input type="datetime-local">.
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function defaultScheduledFor(): string {
  // Default suggestion: tomorrow at 09:00 local time.
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(9, 0, 0, 0)
  return localDateTimeInputValue(d)
}

function elapsedUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'now'
  const m = Math.floor(ms / 60000)
  if (m < 60) return `in ${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `in ${h}h ${m % 60}m`
  const days = Math.floor(h / 24)
  return `in ${days}d ${h % 24}h`
}

export default function SchedulePublishModal({
  open,
  productId,
  onClose,
  onChanged,
}: Props) {
  const [channel, setChannel] = useState<ChannelKey>('AMAZON')
  const [marketplace, setMarketplace] = useState<AmazonMarketplace>('ALL')
  const [scheduledFor, setScheduledFor] = useState<string>(defaultScheduledFor())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [pending, setPending] = useState<ScheduledRow[]>([])
  const [loading, setLoading] = useState(false)
  const [cancellingId, setCancellingId] = useState<string | null>(null)

  const fetchPending = useCallback(async () => {
    setLoading(true)
    try {
      const res = await beFetch(`/api/products/${productId}/scheduled-image-publishes?status=PENDING`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json() as { rows: ScheduledRow[] }
      setPending(body.rows ?? [])
    } catch {
      setPending([])
    } finally {
      setLoading(false)
    }
  }, [productId])

  useEffect(() => {
    if (!open) return
    void fetchPending()
  }, [open, fetchPending])

  if (!open) return null

  async function createSchedule() {
    setSubmitting(true)
    setError(null)
    try {
      const iso = new Date(scheduledFor).toISOString()
      const res = await beFetch(`/api/products/${productId}/scheduled-image-publishes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel,
          marketplace: channel === 'AMAZON' ? marketplace : null,
          scheduledFor: iso,
        }),
      })
      const body = await res.json().catch(() => ({} as any))
      if (!res.ok) {
        setError(body?.message ?? body?.error ?? `Schedule failed: ${res.status}`)
        return
      }
      await fetchPending()
      onChanged?.()
      // Reset date back to default after a successful schedule.
      setScheduledFor(defaultScheduledFor())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Schedule failed')
    } finally {
      setSubmitting(false)
    }
  }

  async function cancelSchedule(id: string) {
    setCancellingId(id)
    try {
      const res = await beFetch(`/api/scheduled-image-publishes/${id}`, { method: 'DELETE' })
      if (!res.ok) return
      await fetchPending()
      onChanged?.()
    } finally {
      setCancellingId(null)
    }
  }

  function describeTarget(c: string, m: string | null): string {
    if (c === 'AMAZON') return m === 'ALL' ? 'Amazon (all markets)' : `Amazon ${m}`
    if (c === 'EBAY') return 'eBay'
    return 'Shopify'
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={submitting || cancellingId ? undefined : onClose} />

      <div className="relative bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
        <div className="flex items-start justify-between px-5 py-4 border-b border-default dark:border-slate-700">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Schedule image publish
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Cron fires due rows every 60s. Requires the
              <span className="font-mono"> NEXUS_ENABLE_SCHEDULED_IMAGE_PUBLISH </span>
              env on the API to actually run; the schedule row is created either way.
            </p>
          </div>
          <IconButton size="sm" onClick={onClose} disabled={submitting || !!cancellingId} aria-label="Close">
            <X className="w-4 h-4" />
          </IconButton>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Schedule new */}
          <section>
            <h3 className="text-[10px] uppercase font-semibold tracking-wide text-slate-500 dark:text-slate-400 mb-2">
              Schedule new
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs text-slate-600 dark:text-slate-400">Channel</span>
                <Listbox
                  value={channel}
                  onChange={(v) => setChannel(v as ChannelKey)}
                  ariaLabel="Channel"
                  className="mt-1 w-full"
                  options={[
                    { value: 'AMAZON', label: 'Amazon' },
                    { value: 'EBAY', label: 'eBay' },
                    { value: 'SHOPIFY', label: 'Shopify' },
                  ]}
                />
              </label>

              {channel === 'AMAZON' && (
                <label className="block">
                  <span className="text-xs text-slate-600 dark:text-slate-400">Marketplace</span>
                  <Listbox
                    value={marketplace}
                    onChange={(v) => setMarketplace(v as AmazonMarketplace)}
                    ariaLabel="Marketplace"
                    className="mt-1 w-full"
                    options={AMAZON_MARKETS.map((m) => ({ value: m, label: m === 'ALL' ? 'All markets' : m }))}
                  />
                </label>
              )}

              <label className="block md:col-span-2">
                <span className="text-xs text-slate-600 dark:text-slate-400">Scheduled for (local time)</span>
                <input
                  type="datetime-local"
                  value={scheduledFor}
                  onChange={(e) => setScheduledFor(e.target.value)}
                  className="mt-1 w-full text-sm border border-default dark:border-slate-700 rounded px-2 py-1.5 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300"
                />
              </label>
            </div>

            {error && (
              <div className="mt-2 flex items-start gap-1.5 text-xs text-rose-600 dark:text-rose-400">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="mt-3">
              <Button
                size="sm"
                onClick={() => void createSchedule()}
                disabled={submitting}
                className="gap-1.5"
              >
                {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Calendar className="w-3.5 h-3.5" />}
                Schedule
              </Button>
            </div>
          </section>

          {/* Pending list */}
          <section>
            <div className="flex items-center gap-2 mb-2">
              <h3 className="text-[10px] uppercase font-semibold tracking-wide text-slate-500 dark:text-slate-400">
                Pending
              </h3>
              {loading && <Loader2 className="w-3 h-3 animate-spin text-tertiary" />}
              <span className="text-xs text-tertiary">({pending.length})</span>
            </div>
            {pending.length === 0 && !loading && (
              <div className="text-xs text-tertiary italic">No pending schedules.</div>
            )}
            {pending.length > 0 && (
              <div className="space-y-1.5">
                {pending.map((row) => (
                  <div key={row.id} className="flex items-center gap-3 px-3 py-2 rounded-lg border border-default dark:border-slate-700 bg-white dark:bg-slate-900">
                    <Clock className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
                        {describeTarget(row.channel, row.marketplace)}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">
                        {new Date(row.scheduledFor).toLocaleString()} · {elapsedUntil(row.scheduledFor)}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void cancelSchedule(row.id)}
                      disabled={cancellingId === row.id}
                      className={cn('text-xs gap-1', cancellingId === row.id && 'opacity-50')}
                    >
                      {cancellingId === row.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                      Cancel
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="px-5 py-3 border-t border-default dark:border-slate-700 flex items-center bg-slate-50/50 dark:bg-slate-900/50">
          <span className="text-[11px] text-slate-500 dark:text-slate-400 inline-flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" />
            Schedules persist across browser sessions.
          </span>
          <Button size="sm" variant="ghost" onClick={onClose} disabled={submitting || !!cancellingId} className="ml-auto">
            Close
          </Button>
        </div>
      </div>
    </div>
  )
}
