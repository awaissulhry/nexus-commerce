'use client'

import { cn } from '@/lib/utils'
import { formatCurrency } from '../format'
import type { WaterfallStep } from '../types'

interface WaterfallChartProps {
  steps: WaterfallStep[]
  currency?: string
  height?: number
  ariaLabel?: string
}

const KIND_COLOR: Record<WaterfallStep['kind'], string> = {
  start: 'bg-slate-400 dark:bg-slate-500',
  add: 'bg-emerald-500',
  sub: 'bg-rose-500',
  total: 'bg-blue-600 dark:bg-blue-500',
}

const KIND_LABEL: Record<WaterfallStep['kind'], string> = {
  start: 'Start',
  add: '+',
  sub: '−',
  total: '=',
}

export function WaterfallChart({
  steps,
  currency = 'EUR',
  height = 280,
  ariaLabel,
}: WaterfallChartProps) {
  let running = 0
  const computed: Array<{
    step: WaterfallStep
    base: number
    top: number
    delta: number
  }> = []
  for (const step of steps) {
    if (step.kind === 'start' || step.kind === 'total') {
      computed.push({ step, base: 0, top: step.value, delta: step.value })
      running = step.value
    } else if (step.kind === 'add') {
      computed.push({
        step,
        base: running,
        top: running + step.value,
        delta: step.value,
      })
      running += step.value
    } else {
      computed.push({
        step,
        base: running - step.value,
        top: running,
        delta: -step.value,
      })
      running -= step.value
    }
  }

  const max = Math.max(...computed.map((c) => Math.max(c.top, c.base)))
  const min = Math.min(0, ...computed.map((c) => c.base))
  const range = max - min || 1

  return (
    <div
      className="w-full"
      style={{ height }}
      role="img"
      aria-label={ariaLabel ?? 'Waterfall chart'}
    >
      <div className="grid h-full" style={{ gridTemplateColumns: `repeat(${computed.length}, minmax(60px, 1fr))`, columnGap: '8px' }}>
        {computed.map(({ step, base, top, delta }, i) => {
          const basePct = ((base - min) / range) * 100
          const heightPct = ((top - base) / range) * 100
          const isPivot = step.kind === 'start' || step.kind === 'total'
          return (
            <div
              key={`${step.key}-${i}`}
              className="flex flex-col items-center justify-end h-full pb-7 relative"
            >
              <div className="relative w-full" style={{ height: '100%' }}>
                <div
                  className={cn(
                    'absolute left-0 right-0 rounded-sm transition',
                    KIND_COLOR[step.kind],
                    isPivot ? 'opacity-90' : 'opacity-80',
                  )}
                  style={{
                    bottom: `${basePct}%`,
                    height: `${Math.max(heightPct, 0.5)}%`,
                  }}
                  title={`${step.label}: ${formatCurrency(delta, currency)}`}
                />
              </div>
              <div className="absolute bottom-0 left-0 right-0 px-1 text-center">
                <div
                  className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400 truncate"
                  title={step.label}
                >
                  {step.label}
                </div>
                <div
                  className={cn(
                    'text-[11px] font-semibold tabular-nums truncate',
                    step.kind === 'sub'
                      ? 'text-rose-600 dark:text-rose-400'
                      : step.kind === 'total'
                        ? 'text-blue-700 dark:text-blue-300'
                        : 'text-slate-800 dark:text-slate-200',
                  )}
                >
                  {KIND_LABEL[step.kind]} {formatCurrency(Math.abs(delta), currency)}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
