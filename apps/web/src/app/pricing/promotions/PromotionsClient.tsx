'use client'

// E.1 — Promotion calendar surface.
//
// Reads /api/pricing/promotions (GET) which buckets RetailEvent rows into
// active / upcoming / ended. Each event carries its RetailEventPriceAction
// children so the operator sees "what's running, what's queued, what just
// finished" at a glance. The "Run scheduler now" button fires the same
// G.5.2 promotion-scheduler tick the hourly cron runs — useful when the
// operator just created an event whose window has already started and
// they don't want to wait for the next :00.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertCircle,
  CalendarRange,
  CheckCircle2,
  Clock3,
  Loader2,
  PlayCircle,
  Tag,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface PriceAction {
  id: string
  channel: string | null
  marketplace: string | null
  productType: string | null
  action: 'PERCENT_OFF' | 'FIXED_PRICE'
  value: string
  isActive: boolean
  setSalePriceFrom: string | null
  setSalePriceUntil: string | null
}

interface RetailEvent {
  id: string
  name: string
  startDate: string
  endDate: string
  channel: string | null
  marketplace: string | null
  productType: string | null
  expectedLift: string
  prepLeadTimeDays: number
  description: string | null
  source: string | null
  isActive: boolean
  priceActions: PriceAction[]
}

interface PromotionsResponse {
  counts: { active: number; upcoming: number; ended: number; total: number }
  active: RetailEvent[]
  upcoming: RetailEvent[]
  ended: RetailEvent[]
}

export default function PromotionsClient() {
  const [data, setData] = useState<PromotionsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const { toast } = useToast()

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/pricing/promotions`, {
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const runScheduler = async () => {
    setRunning(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/pricing/run-promotions`,
        { method: 'POST' },
      )
      const json = await res.json()
      if (json.ok) {
        toast.success(
          `Scheduler tick: ${json.enteredEvents} entered, ${json.exitedEvents} exited, ${json.listingsUpdated} listings updated, ${json.snapshotsRefreshed} snapshots refreshed.`,
        )
        await fetchData()
      } else {
        toast.error(`Scheduler failed: ${json.error ?? 'unknown error'}`)
      }
    } catch (e) {
      toast.error(`Scheduler failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRunning(false)
    }
  }

  if (loading && !data) {
    return (
      <Card>
        <div className="text-md text-slate-500 py-8 text-center inline-flex items-center justify-center gap-2 w-full">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading promotions…
        </div>
      </Card>
    )
  }

  if (error) {
    return (
      <div className="border border-rose-200 bg-rose-50 rounded px-3 py-2 text-base text-rose-700 inline-flex items-start gap-1.5">
        <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
        <span>{error}</span>
      </div>
    )
  }

  if (!data || data.counts.total === 0) {
    return (
      <EmptyState
        icon={CalendarRange}
        title="No retail events yet"
        description="Create RetailEvent + RetailEventPriceAction rows to schedule sales. The hourly G.5.2 scheduler materializes ChannelListing.salePrice when their window opens; the engine reads it as SCHEDULED_SALE source."
      />
    )
  }

  return (
    <div className="space-y-4">
      {/* Counts banner + manual scheduler trigger */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-stretch">
        <CountTile
          icon={PlayCircle}
          label="Active"
          value={data.counts.active}
          tone={data.counts.active > 0 ? 'emerald' : 'slate'}
          hint="In window now — engine sourcing as SCHEDULED_SALE"
        />
        <CountTile
          icon={Clock3}
          label="Upcoming"
          value={data.counts.upcoming}
          tone={data.counts.upcoming > 0 ? 'blue' : 'slate'}
          hint="Window hasn't opened yet"
        />
        <CountTile
          icon={CheckCircle2}
          label="Ended"
          value={data.counts.ended}
          tone="slate"
          hint="Last 25, for lookback on lift"
        />
        <Card>
          <div className="space-y-2">
            <div className="text-sm uppercase tracking-wider text-slate-500 font-semibold">
              Scheduler
            </div>
            <Button
              variant="primary"
              size="md"
              onClick={runScheduler}
              loading={running}
              disabled={running}
              icon={running ? null : <PlayCircle size={14} />}
            >
              {running ? 'Running…' : 'Run scheduler now'}
            </Button>
            <div className="text-sm text-slate-500">
              Hourly cron (`0 * * * *`) runs the same enter/exit logic.
            </div>
          </div>
        </Card>
      </div>

      {/* Active events */}
      {data.active.length > 0 && (
        <EventSection
          label={`Active · ${data.active.length}`}
          tone="emerald"
          events={data.active}
        />
      )}

      {/* Upcoming */}
      {data.upcoming.length > 0 && (
        <EventSection
          label={`Upcoming · ${data.upcoming.length}`}
          tone="blue"
          events={data.upcoming}
        />
      )}

      {/* Ended */}
      {data.ended.length > 0 && (
        <EventSection
          label={`Ended · ${data.ended.length}`}
          tone="slate"
          events={data.ended}
        />
      )}
    </div>
  )
}

function CountTile({
  icon: Icon,
  label,
  value,
  tone,
  hint,
}: {
  icon: typeof PlayCircle
  label: string
  value: number
  tone: 'emerald' | 'blue' | 'slate'
  hint: string
}) {
  const toneClasses = {
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    blue: 'border-blue-200 bg-blue-50 text-blue-700',
    slate: 'border-slate-200 bg-white text-slate-500',
  }[tone]
  return (
    <Card>
      <div className={cn('flex items-start gap-2', toneClasses, 'p-1 -m-1 rounded')}>
        <Icon size={14} className="mt-0.5 flex-shrink-0" />
        <div>
          <div className="text-[20px] leading-tight font-semibold tabular-nums">
            {value}
          </div>
          <div className="text-base font-medium text-slate-700 leading-tight">
            {label}
          </div>
          <div className="text-sm text-slate-500 leading-tight mt-0.5">
            {hint}
          </div>
        </div>
      </div>
    </Card>
  )
}

function EventSection({
  label,
  tone,
  events,
}: {
  label: string
  tone: 'emerald' | 'blue' | 'slate'
  events: RetailEvent[]
}) {
  const headerToneCls = {
    emerald: 'bg-emerald-50 text-emerald-800',
    blue: 'bg-blue-50 text-blue-800',
    slate: 'bg-slate-50 text-slate-700',
  }[tone]
  return (
    <div className="space-y-2">
      <div className="text-sm uppercase tracking-wider text-slate-500 font-semibold">
        {label}
      </div>
      <Card noPadding>
        <div className="overflow-x-auto">
          <table className="w-full text-md">
            <thead className={cn('border-b border-slate-200', headerToneCls)}>
              <tr>
                <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider">
                  Event
                </th>
                <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider">
                  Window
                </th>
                <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider">
                  Scope
                </th>
                <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider">
                  Price action
                </th>
                <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider">
                  Lift
                </th>
                <th className="px-3 py-2 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => {
                const start = new Date(e.startDate)
                const end = new Date(e.endDate)
                const days = Math.max(
                  1,
                  Math.round((end.getTime() - start.getTime()) / (24 * 3600 * 1000)) + 1,
                )
                return (
                  <tr
                    key={e.id}
                    className="border-b border-slate-100 hover:bg-slate-50"
                  >
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-800">{e.name}</div>
                      {e.description && (
                        <div className="text-sm text-slate-500 truncate max-w-md">
                          {e.description}
                        </div>
                      )}
                      {e.source && (
                        <span className="inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 mt-0.5 border rounded bg-slate-50 text-slate-600 border-slate-200">
                          {e.source}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-base text-slate-700">
                      <div>
                        {start.toLocaleDateString()} →{' '}
                        {end.toLocaleDateString()}
                      </div>
                      <div className="text-sm text-slate-500">
                        {days} day{days === 1 ? '' : 's'}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-base text-slate-700">
                      <ScopeChip
                        channel={e.channel}
                        marketplace={e.marketplace}
                        productType={e.productType}
                      />
                    </td>
                    <td className="px-3 py-2">
                      {e.priceActions.length === 0 ? (
                        <span className="text-sm text-slate-400">— none</span>
                      ) : (
                        <ul className="space-y-0.5">
                          {e.priceActions.map((a) => (
                            <li
                              key={a.id}
                              className="text-base text-slate-700 inline-flex items-center gap-1.5"
                            >
                              <Tag
                                size={11}
                                className="text-pink-600 flex-shrink-0"
                              />
                              <span className="font-mono text-sm">
                                {a.action === 'PERCENT_OFF'
                                  ? `-${a.value}%`
                                  : `${a.value} fixed`}
                              </span>
                              {a.channel && (
                                <span className="text-xs text-slate-500">
                                  {a.channel}
                                  {a.marketplace ? `:${a.marketplace}` : ''}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                      ×{Number(e.expectedLift).toFixed(1)}
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/pricing?source=SCHEDULED_SALE`}
                        className="text-sm text-blue-600 hover:underline"
                      >
                        →
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

function ScopeChip({
  channel,
  marketplace,
  productType,
}: {
  channel: string | null
  marketplace: string | null
  productType: string | null
}) {
  const parts: string[] = []
  if (channel) parts.push(channel)
  if (marketplace) parts.push(marketplace)
  if (productType) parts.push(productType)
  if (parts.length === 0) {
    return <span className="text-sm text-slate-500">All channels & products</span>
  }
  return (
    <span className="font-mono text-sm text-slate-700">{parts.join(' · ')}</span>
  )
}
