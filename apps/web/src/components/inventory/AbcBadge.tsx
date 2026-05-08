/**
 * Shared ABC (Pareto) class badge.
 *
 * S.16 introduced the badge inline inside StockWorkspace.tsx; S.33
 * lifts it into a shared component so analytics, fba-pan-eu, and any
 * future surface render the same visual at the same size with the
 * same dark-mode contrast. Pareto-band convention used everywhere:
 *
 *   A — top 80% of selected metric (revenue / units / margin)
 *   B — next 15%
 *   C — last 5%
 *   D — un-classified / no sales in window
 */
import { cn } from '@/lib/utils'

type AbcClass = 'A' | 'B' | 'C' | 'D'

interface AbcBadgeProps {
  cls: AbcClass
  /** sm = 18×18 (chip / inline), md = 20×20 (default), lg = 28×28 (card). */
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const TONES: Record<AbcClass, string> = {
  A: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 ring-emerald-200 dark:ring-emerald-800',
  B: 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 ring-blue-200 dark:ring-blue-800',
  C: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 ring-slate-200 dark:ring-slate-700',
  D: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 ring-rose-200 dark:ring-rose-800',
}

const SIZE: Record<NonNullable<AbcBadgeProps['size']>, string> = {
  sm: 'w-[18px] h-[18px] text-[10px]',
  md: 'w-5 h-5 text-xs',
  lg: 'w-7 h-7 text-sm',
}

export function AbcBadge({ cls, size = 'md', className }: AbcBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center font-bold rounded ring-1 shrink-0',
        SIZE[size],
        TONES[cls],
        className,
      )}
      title={`Pareto class ${cls}`}
      aria-label={`ABC class ${cls}`}
    >
      {cls}
    </span>
  )
}
