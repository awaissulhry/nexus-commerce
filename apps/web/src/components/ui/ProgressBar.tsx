'use client'

/**
 * U.2 — ProgressBar primitive.
 *
 * Replaces 10+ inline `h-1.5 rounded` patterns scattered through bulk
 * operations, listing wizard submit flow, and various job strips.
 *
 * Two display modes:
 *
 *   determinate (value provided 0-100) — fills to a percentage,
 *     surfaces an aria-valuenow for screen readers, optionally
 *     shows the count text "12 / 50" alongside the bar
 *
 *   indeterminate (value omitted) — slides a striped segment along
 *     the track. For "we know it's progressing but can't measure it"
 *     workloads (the BullMQ worker tick during a bulk job)
 *
 * Tone defaults to info (blue). Use success when the operation has
 * already completed and you're showing the final state; danger when
 * a partial-failure has occurred.
 *
 * Usage:
 *   <ProgressBar value={succeeded} max={total} label="Bulk publish" />
 *   <ProgressBar indeterminate label="Polling Amazon…" />
 */

import { cn } from '@/lib/utils'

type Tone = 'info' | 'success' | 'warning' | 'danger'
type Size = 'xs' | 'sm' | 'md'

interface ProgressBarProps {
  /** Current progress 0..max. Omit for indeterminate state. */
  value?: number
  /** Total. Defaults to 100. */
  max?: number
  /** Indeterminate state — overrides value. */
  indeterminate?: boolean
  /** Optional label above the bar. */
  label?: string
  /** Show "12 / 50" alongside label. Defaults true when label set + value provided. */
  showCount?: boolean
  /** Show "24%" alongside label. */
  showPercent?: boolean
  tone?: Tone
  size?: Size
  className?: string
}

const TRACK: Record<Size, string> = {
  xs: 'h-1',
  sm: 'h-1.5',
  md: 'h-2',
}

const TONE: Record<Tone, string> = {
  info:    'bg-info-500',
  success: 'bg-success-500',
  warning: 'bg-warning-500',
  danger:  'bg-danger-500',
}

export function ProgressBar({
  value,
  max = 100,
  indeterminate,
  label,
  showCount,
  showPercent,
  tone = 'info',
  size = 'sm',
  className,
}: ProgressBarProps) {
  const isIndeterminate = indeterminate || value === undefined
  const pct = isIndeterminate
    ? 0
    : Math.max(0, Math.min(100, (value! / Math.max(1, max)) * 100))

  // Default count display: when there's a label + a value + max is
  // not the implicit 100, show the count. Operator scanning a job
  // strip wants "37 / 200" more than "18%".
  const showCountResolved =
    showCount ?? (label != null && !isIndeterminate && max !== 100)

  return (
    <div className={cn('w-full', className)}>
      {(label || showPercent || showCountResolved) && (
        <div className="flex items-center justify-between text-sm text-slate-600 mb-1">
          {label && <span className="font-medium">{label}</span>}
          {!label && <span />}
          <span className="tabular-nums">
            {showCountResolved && !isIndeterminate && (
              <span>
                {value} / {max}
              </span>
            )}
            {showPercent && !isIndeterminate && (
              <span className="ml-2">{pct.toFixed(0)}%</span>
            )}
          </span>
        </div>
      )}
      <div
        role="progressbar"
        aria-valuenow={isIndeterminate ? undefined : pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        className={cn(
          'w-full bg-slate-100 rounded-full overflow-hidden',
          TRACK[size],
        )}
      >
        {isIndeterminate ? (
          <div
            className={cn(
              'h-full rounded-full animate-pulse',
              TONE[tone],
              'w-1/3',
            )}
            style={{
              animation:
                'progress-indeterminate 1.4s cubic-bezier(0.4, 0, 0.2, 1) infinite',
            }}
          />
        ) : (
          <div
            className={cn('h-full rounded-full transition-all duration-base ease-out', TONE[tone])}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
      {/* Indeterminate keyframes — inline because Tailwind doesn't
          ship a sliding animation by default and adding it to the
          config would force every page to load it. */}
      {isIndeterminate && (
        <style jsx>{`
          @keyframes progress-indeterminate {
            0%   { transform: translateX(-100%); }
            100% { transform: translateX(400%); }
          }
        `}</style>
      )}
    </div>
  )
}
