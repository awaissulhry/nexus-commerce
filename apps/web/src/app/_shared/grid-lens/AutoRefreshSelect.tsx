'use client'

import { useEffect } from 'react'

export type AutoRefreshInterval = 0 | 5 | 15

export interface AutoRefreshSelectProps {
  value: AutoRefreshInterval
  onChange: (v: AutoRefreshInterval) => void
  /**
   * When provided, the hook ticks `onTick` on the chosen interval
   * (paused while the tab is hidden). Pages can call `onTick` to
   * trigger their own refetch. Leave undefined to manage timers
   * yourself.
   */
  onTick?: () => void
  className?: string
}

const OPTIONS: AutoRefreshInterval[] = [0, 5, 15]

function label(v: AutoRefreshInterval): string {
  if (v === 0) return 'Auto-refresh: Off'
  return `Auto-refresh: ${v} min`
}

/**
 * Dropdown to opt into background polling on long-lived workspace
 * pages. Three options (Off / 5 min / 15 min). Pauses while the tab
 * is hidden so a background page doesn't waste fetches.
 */
export function AutoRefreshSelect({ value, onChange, onTick, className }: AutoRefreshSelectProps) {
  useEffect(() => {
    if (!onTick || value === 0) return
    const ms = value * 60_000
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') onTick()
    }, ms)
    return () => window.clearInterval(id)
  }, [value, onTick])

  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value) as AutoRefreshInterval)}
      className={`h-8 px-2 text-sm border border-default dark:border-slate-700 rounded-md bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 ${className ?? ''}`}
      title="Auto-refresh interval (paused when tab is hidden)"
      aria-label="Auto-refresh interval"
    >
      {OPTIONS.map((v) => (
        <option key={v} value={v}>{label(v)}</option>
      ))}
    </select>
  )
}
