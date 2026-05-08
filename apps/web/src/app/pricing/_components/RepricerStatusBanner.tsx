'use client'

// UI.7 — Repricer status banner.
//
// Reads /api/pricing/repricer-status (G.2 AuditLog rows + env config).
// Renders three states:
//   - cron disabled (slate, configuration hint)
//   - dry-run mode (amber, "would have enqueued N — flip the flag")
//   - live mode (emerald, "enqueued N this tick")
//
// Empty when no ticks recorded yet (cron just enabled, hasn't fired).
// Polls every 60s so dry-run runs surface promptly when the operator is
// validating before flipping the kill switch.

import { useCallback, useEffect, useState } from 'react'
import { Activity, AlertTriangle, CheckCircle2, Clock } from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface Tick {
  runId: string
  action: string
  occurredAt: string
  liveMode: boolean
  snapshotsScanned: number
  enqueued: number
  dryRunWouldEnqueue: number
  skippedSubThreshold: number
  durationMs: number
}

interface Status {
  config: { cronEnabled: boolean; liveMode: boolean; thresholdPct: number }
  ticks: Tick[]
}

export default function RepricerStatusBanner() {
  const { t } = useTranslations()
  const [data, setData] = useState<Status | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/pricing/repricer-status`, {
        cache: 'no-store',
      })
      if (res.ok) setData(await res.json())
    } catch {
      // Status banner is non-blocking; render nothing on fetch failure.
    }
  }, [])

  useEffect(() => {
    fetchData()
    const id = setInterval(fetchData, 60_000)
    return () => clearInterval(id)
  }, [fetchData])

  if (!data) return null

  const { config, ticks } = data
  const lastTick = ticks[0]

  // Tone selection mirrors the safety story:
  //   - cron disabled → slate (config hint)
  //   - live → emerald (everything is wired)
  //   - dry-run → amber (in flight; verify before flipping)
  const tone = !config.cronEnabled
    ? 'slate'
    : config.liveMode
      ? 'emerald'
      : 'amber'
  const Icon = !config.cronEnabled
    ? Clock
    : config.liveMode
      ? CheckCircle2
      : AlertTriangle

  const headline = !config.cronEnabled
    ? t('pricing.repricer.cronOff')
    : config.liveMode
      ? t('pricing.repricer.live', { n: config.thresholdPct })
      : t('pricing.repricer.dryRun')

  const subline = !lastTick
    ? t('pricing.repricer.noTicks')
    : lastTick.liveMode
      ? `${t('pricing.repricer.lastTick', {
          when: new Date(lastTick.occurredAt).toLocaleString(),
        })} · ${t('pricing.repricer.tickSummaryLive', {
          scanned: lastTick.snapshotsScanned,
          enqueued: lastTick.enqueued,
          durationMs: lastTick.durationMs,
        })}`
      : `${t('pricing.repricer.lastTick', {
          when: new Date(lastTick.occurredAt).toLocaleString(),
        })} · ${t('pricing.repricer.tickSummaryDry', {
          scanned: lastTick.snapshotsScanned,
          wouldEnqueue: lastTick.dryRunWouldEnqueue,
          durationMs: lastTick.durationMs,
        })}`

  const toneCls = {
    slate:
      'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-300',
    amber:
      'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950 text-amber-800 dark:text-amber-200',
    emerald:
      'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-200',
  }[tone]

  return (
    <div
      className={cn(
        'border rounded-md px-3 py-2 inline-flex items-start gap-2 w-full text-base',
        toneCls,
      )}
    >
      <Icon size={16} className="mt-0.5 flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium inline-flex items-center gap-2">
          <Activity size={12} className="opacity-70" />
          <span className="text-sm uppercase tracking-wider">
            {t('pricing.repricer.title')}
          </span>
          <span className="font-normal opacity-80">·</span>
          <span>{headline}</span>
        </div>
        <div className="text-sm opacity-80 mt-0.5 truncate">{subline}</div>
      </div>
    </div>
  )
}
