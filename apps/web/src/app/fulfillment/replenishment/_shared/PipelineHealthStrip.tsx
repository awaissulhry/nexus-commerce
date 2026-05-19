'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { useToast } from '@/components/ui/Toast'

interface PipelineHealth {
  tables: {
    dailySalesAggregate: { rows: number; oldest: string | null; newest: string | null; updatedAt: string | null }
    replenishmentForecast: { rows: number; latestHorizon: string | null; lastGeneratedAt: string | null }
    forecastAccuracy: { rows: number; latestDay: string | null; avgPercentError: number | null; withinBandCount: number }
  }
  crons: Record<
    'forecast' | 'forecast-accuracy' | 'abc-classification',
    {
      lastRun: { startedAt: string; finishedAt: string | null; status: string; outputSummary: string | null; triggeredBy: string } | null
      enabledFlag: boolean
    }
  >
}

const TONE_CLASSES: Record<'green' | 'amber' | 'red' | 'slate', string> = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-900',
  amber: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-900',
  red:   'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900',
  slate: 'bg-slate-50 text-slate-600 ring-slate-200 dark:bg-slate-900 dark:text-slate-400 dark:ring-slate-800',
}

export function PipelineHealthStrip({ onRefreshPageData }: { onRefreshPageData?: () => void }) {
  const { toast } = useToast()
  const { t } = useTranslations()
  const [health, setHealth] = useState<PipelineHealth | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)

  const fetchHealth = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment/pipeline/health`,
        { cache: 'no-store' },
      )
      if (res.ok) setHealth(await res.json())
    } catch {
      // strip degrades to "—"
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void fetchHealth() }, [fetchHealth])

  const runPipeline = useCallback(async () => {
    setRunning(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/replenishment/pipeline/run`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: 365 }), cache: 'no-store' },
      )
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.ok) {
        const failed = (json.steps ?? []).filter((s: { ok: boolean }) => !s.ok)
        toast.error(
          failed.length
            ? t('replenishment.pipeline.toast.failedSteps', { n: failed.length, steps: failed.map((s: { step: string }) => s.step).join(', ') })
            : t('replenishment.pipeline.toast.failed'),
        )
      } else {
        const seconds = Math.round((json.totalDurationMs ?? 0) / 100) / 10
        toast.success(t('replenishment.pipeline.toast.success', { seconds, n: json.steps.length }))
      }
      await fetchHealth()
      onRefreshPageData?.()
    } catch (err) {
      toast.error(t('replenishment.pipeline.toast.error', { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setRunning(false)
    }
  }, [fetchHealth, onRefreshPageData, toast, t])

  function ageBadge(iso: string | null): { text: string; tone: 'green' | 'amber' | 'red' | 'slate' } {
    if (!iso) return { text: '—', tone: 'slate' }
    const ageMs = Date.now() - new Date(iso).getTime()
    const hours = ageMs / 3_600_000
    if (hours < 48) return { text: `${Math.max(1, Math.round(hours))}h ago`, tone: 'green' }
    const days = Math.round(hours / 24)
    return { text: `${days}d ago`, tone: hours < 168 ? 'amber' : 'red' }
  }

  function tableTone(rows: number, freshIso: string | null): 'green' | 'amber' | 'red' {
    if (rows === 0) return 'red'
    if (!freshIso) return 'amber'
    return (Date.now() - new Date(freshIso).getTime()) / 3_600_000 < 48 ? 'green' : 'amber'
  }

  if (loading && !health) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2 text-xs text-slate-500">
        {t('replenishment.pipeline.loading')}
      </div>
    )
  }
  if (!health) {
    return (
      <div className="bg-white dark:bg-slate-900 border border-rose-200 dark:border-rose-900 rounded-md px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
        {t('replenishment.pipeline.unavailable')}
      </div>
    )
  }

  const dsa = health.tables.dailySalesAggregate
  const fc  = health.tables.replenishmentForecast
  const fa  = health.tables.forecastAccuracy
  const dsaAge = ageBadge(dsa.updatedAt)
  const fcAge  = ageBadge(fc.lastGeneratedAt)
  const cronChips: Array<{ key: keyof PipelineHealth['crons']; labelKey: string }> = [
    { key: 'forecast',           labelKey: 'replenishment.pipeline.cron.forecast' },
    { key: 'forecast-accuracy',  labelKey: 'replenishment.pipeline.cron.accuracy' },
    { key: 'abc-classification', labelKey: 'replenishment.pipeline.cron.abc' },
  ]

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mr-1">
          {t('replenishment.pipeline.label')}
        </span>

        {[
          { tone: tableTone(dsa.rows, dsa.updatedAt), label: `${t('replenishment.pipeline.salesAgg')}: ${dsa.rows.toLocaleString()}`, sub: dsaAge.text },
          { tone: tableTone(fc.rows, fc.lastGeneratedAt), label: `${t('replenishment.pipeline.forecast')}: ${fc.rows.toLocaleString()}`, sub: fcAge.text },
          { tone: tableTone(fa.rows, fa.latestDay), label: `${t('replenishment.pipeline.mape')}: ${fa.rows > 0 && fa.avgPercentError != null ? fa.avgPercentError.toFixed(1) + '%' : '—'}`, sub: `${fa.rows.toLocaleString()} obs` },
        ].map(({ tone, label, sub }, i) => (
          <span key={i} className={cn('text-xs px-2 py-0.5 rounded-full ring-1 ring-inset font-medium', TONE_CLASSES[tone])}>
            {label} <span className="opacity-70">· {sub}</span>
          </span>
        ))}

        <span className="mx-1 text-slate-300 dark:text-slate-700">|</span>

        {cronChips.map(({ key, labelKey }) => {
          const c = health.crons[key]
          const tone: 'green' | 'amber' | 'red' | 'slate' = !c.enabledFlag ? 'slate'
            : c.lastRun?.status === 'SUCCESS' ? 'green'
            : c.lastRun?.status === 'FAILED'  ? 'red'
            : 'amber'
          const detail = c.lastRun
            ? `${c.lastRun.status} · ${ageBadge(c.lastRun.startedAt).text}${c.lastRun.outputSummary ? ' · ' + c.lastRun.outputSummary : ''}`
            : c.enabledFlag ? t('replenishment.pipeline.noRuns') : t('replenishment.pipeline.disabled')
          return (
            <span key={key} className={cn('text-xs px-2 py-0.5 rounded-full ring-1 ring-inset font-medium', TONE_CLASSES[tone])}
              title={t('replenishment.pipeline.tooltip.cron', { name: key, detail })}>
              {t(labelKey)}: {!c.enabledFlag ? t('replenishment.pipeline.cronOff') : c.lastRun?.status ?? '—'}
            </span>
          )
        })}

        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => void runPipeline()} disabled={running}
            className="text-xs px-2 py-1 rounded ring-1 ring-inset bg-slate-900 dark:bg-slate-700 text-white hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1"
            title={t('replenishment.pipeline.runTooltip')} aria-label={t('replenishment.pipeline.runAriaLabel')}>
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            {running ? t('replenishment.pipeline.runningButton') : t('replenishment.pipeline.runButton')}
          </button>
        </div>
      </div>
    </div>
  )
}
