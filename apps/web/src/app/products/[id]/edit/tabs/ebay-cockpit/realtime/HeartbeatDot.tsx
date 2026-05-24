'use client'

// EC.3.2 — HeartbeatDot
//
// Tiny live-pulse dot for the cockpit header. Three visible states:
//   • emerald + pulse: SSE connected AND a relevant event landed in
//     the last 10s
//   • emerald solid:   SSE connected, last relevant event > 10s ago
//   • slate:           SSE connected, never seen an event for this
//                      product / marketplace yet
//   • amber:           SSE disconnected (auto-reconnecting)
//
// Tooltip surfaces the seconds-since-last so operators can tell at a
// glance how fresh the data on screen is.

import { cn } from '@/lib/utils'

interface Props {
  connected: boolean
  secondsSinceLast: number
  className?: string
}

function relativeAgo(s: number): string {
  if (s < 0) return 'no events yet'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

export default function HeartbeatDot({ connected, secondsSinceLast, className }: Props) {
  let tone: 'live-pulse' | 'live-solid' | 'idle' | 'down'
  if (!connected) tone = 'down'
  else if (secondsSinceLast >= 0 && secondsSinceLast < 10) tone = 'live-pulse'
  else if (secondsSinceLast >= 0) tone = 'live-solid'
  else tone = 'idle'

  const label = (() => {
    if (tone === 'down') return 'SSE reconnecting…'
    if (tone === 'idle') return 'Live · no events yet'
    return `Live · ${relativeAgo(secondsSinceLast)}`
  })()

  const dotClass = (() => {
    if (tone === 'down')       return 'bg-amber-500'
    if (tone === 'live-pulse') return 'bg-emerald-500'
    if (tone === 'live-solid') return 'bg-emerald-500/80'
    return 'bg-slate-400'
  })()

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[10.5px] text-slate-500 dark:text-slate-400',
        className,
      )}
      title={label}
      aria-label={label}
    >
      <span className="relative inline-flex items-center justify-center w-2 h-2">
        {tone === 'live-pulse' && (
          <span className="absolute inline-flex w-full h-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
        )}
        <span className={cn('relative inline-flex w-2 h-2 rounded-full', dotClass)} />
      </span>
      <span className="hidden sm:inline">{tone === 'down' ? 'Reconnecting' : 'Live'}</span>
    </span>
  )
}
