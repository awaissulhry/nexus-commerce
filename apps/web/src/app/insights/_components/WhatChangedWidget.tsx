'use client'

import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CircleDot,
  Sparkles,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'
import type { InsightChange } from './useInsightsData'

const SEVERITY_STYLES: Record<
  InsightChange['severity'],
  { ring: string; badge: string; icon: typeof CircleDot }
> = {
  positive: {
    ring: 'bg-emerald-50 dark:bg-emerald-950/30 border-l-emerald-500',
    badge: 'text-emerald-700 dark:text-emerald-300',
    icon: ArrowUp,
  },
  attention: {
    ring: 'bg-amber-50 dark:bg-amber-950/30 border-l-amber-500',
    badge: 'text-amber-700 dark:text-amber-300',
    icon: AlertTriangle,
  },
  critical: {
    ring: 'bg-rose-50 dark:bg-rose-950/30 border-l-rose-500',
    badge: 'text-rose-700 dark:text-rose-300',
    icon: ArrowDown,
  },
  info: {
    ring: 'bg-slate-50 dark:bg-slate-900/50 border-l-slate-400',
    badge: 'text-slate-700 dark:text-slate-300',
    icon: CircleDot,
  },
}

export function WhatChangedWidget({
  items,
  loading,
}: {
  items: InsightChange[]
  loading: boolean
}) {
  if (loading && items.length === 0) {
    return (
      <Card title="What changed">
        <div className="h-[140px] flex items-center justify-center text-tertiary text-sm">
          Loading…
        </div>
      </Card>
    )
  }

  if (items.length === 0) {
    return (
      <Card title="What changed">
        <div className="flex flex-col items-center justify-center gap-1.5 py-8 text-tertiary">
          <Sparkles className="w-6 h-6 opacity-40" />
          <p className="text-sm">Steady week — no major shifts vs comparison.</p>
        </div>
      </Card>
    )
  }

  return (
    <Card
      title="What changed"
      description="Auto-detected shifts vs comparison window"
    >
      <ul className="space-y-1.5">
        {items.map((item) => {
          const styles = SEVERITY_STYLES[item.severity]
          const Icon = styles.icon
          return (
            <li
              key={item.id}
              className={cn(
                'rounded-md border-l-2 pl-2.5 pr-2 py-1.5 flex items-start gap-2 text-xs',
                styles.ring,
              )}
            >
              <Icon
                className={cn('w-3.5 h-3.5 mt-0.5 shrink-0', styles.badge)}
              />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-slate-900 dark:text-slate-100">
                  {item.headline}
                </div>
                {item.detail && (
                  <div className="text-[11px] text-slate-600 dark:text-slate-400 mt-0.5">
                    {item.detail}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
