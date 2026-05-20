'use client'

import { Area, AreaChart, ResponsiveContainer } from 'recharts'
import { cn } from '@/lib/utils'
import {
  formatDelta,
  deltaTone,
  type DeltaTone,
} from '../format'

interface KPICardProps {
  label: string
  value: string
  secondary?: string
  deltaPct?: number | null
  series?: number[]
  invertDelta?: boolean
  accent?: 'emerald' | 'blue' | 'amber' | 'rose' | 'violet' | 'slate'
  href?: string
  onClick?: () => void
  hint?: string
}

const ACCENT_CLASSES: Record<string, { spark: string; gradId: string }> = {
  emerald: { spark: 'rgb(16 185 129)', gradId: 'ih-kpi-emerald' },
  blue: { spark: 'rgb(59 130 246)', gradId: 'ih-kpi-blue' },
  amber: { spark: 'rgb(245 158 11)', gradId: 'ih-kpi-amber' },
  rose: { spark: 'rgb(244 63 94)', gradId: 'ih-kpi-rose' },
  violet: { spark: 'rgb(139 92 246)', gradId: 'ih-kpi-violet' },
  slate: { spark: 'rgb(100 116 139)', gradId: 'ih-kpi-slate' },
}

const TONE_TEXT: Record<DeltaTone, string> = {
  pos: 'text-emerald-600 dark:text-emerald-400',
  neg: 'text-rose-600 dark:text-rose-400',
  flat: 'text-slate-500 dark:text-slate-400',
  na: 'text-slate-400 dark:text-slate-500',
}

export function KPICard({
  label,
  value,
  secondary,
  deltaPct,
  series,
  invertDelta,
  accent = 'emerald',
  href,
  onClick,
  hint,
}: KPICardProps) {
  const delta = formatDelta(deltaPct)
  const tone = deltaTone(deltaPct, invertDelta)
  const palette = ACCENT_CLASSES[accent]
  const interactive = !!(href || onClick)

  const sparkData = series?.map((v, i) => ({ i, v })) ?? null

  const inner = (
    <div
      className={cn(
        'group relative overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3.5 py-3 flex flex-col gap-1.5',
        interactive &&
          'transition hover:border-slate-300 dark:hover:border-slate-700 hover:shadow-sm cursor-pointer',
      )}
      onClick={onClick}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
    >
      <div className="flex items-center justify-between gap-2 min-w-0">
        <span
          className="text-[11px] uppercase tracking-wider font-medium text-slate-500 dark:text-slate-400 truncate"
          title={label}
        >
          {label}
        </span>
        {deltaPct != null && (
          <span
            className={cn(
              'text-[11px] font-semibold tabular-nums shrink-0',
              TONE_TEXT[tone],
            )}
            title={hint}
          >
            {delta.label}
          </span>
        )}
      </div>
      <div className="flex items-end justify-between gap-3 min-w-0">
        <div className="min-w-0 flex-1">
          <div
            className="text-xl font-semibold text-slate-900 dark:text-slate-100 tabular-nums truncate"
            title={value}
          >
            {value}
          </div>
          {secondary && (
            <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
              {secondary}
            </div>
          )}
        </div>
        {sparkData && sparkData.length > 1 && (
          <div className="h-9 w-20 shrink-0 -mb-1">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={sparkData}
                margin={{ top: 1, right: 0, left: 0, bottom: 0 }}
              >
                <defs>
                  <linearGradient id={palette.gradId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={palette.spark} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={palette.spark} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area
                  type="monotone"
                  dataKey="v"
                  stroke={palette.spark}
                  strokeWidth={1.5}
                  fill={`url(#${palette.gradId})`}
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  )

  if (href) {
    return (
      <a href={href} className="block">
        {inner}
      </a>
    )
  }
  return inner
}
