'use client'

/**
 * U.2 — Type-aware TableCell renderers.
 *
 * Across /products + /bulk-operations cells render currency without
 * a € symbol in read mode (per UX audit), dates as raw ISO strings,
 * status as inconsistently-styled spans, links without underline
 * affordance. These primitives standardise per-type rendering so
 * one fix propagates everywhere.
 *
 * Each cell:
 *   - Right-aligns numeric content (currency, count) for column scan
 *   - Uses tabular-nums so values don't jitter
 *   - Locale-aware via Intl APIs (it-IT default for Xavia, but
 *     overridable via `locale` prop)
 *   - Honours nullish + empty values with consistent em-dash fallback
 *
 * Usage:
 *   <CurrencyCell value={p.basePrice} currency="EUR" />
 *   <DateCell value={p.updatedAt} format="short" />
 *   <ImageCell src={p.imageUrl} alt={p.name} />
 *   <LinkCell href={`/products/${p.id}`}>{p.sku}</LinkCell>
 *   <StatusCell status={p.status} />
 *
 * The grid renderers in /products and /bulk-operations should adopt
 * these in U.5 (inline edit affordance) + U.9 (bulk-ops cell type
 * indicators). U.2 ships the primitives only.
 */

import { type ReactNode } from 'react'
import Link from 'next/link'
import { Image as ImageIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

const DEFAULT_LOCALE = 'it-IT'
const DEFAULT_CURRENCY = 'EUR'
const NULL_DASH = <span className="text-slate-300">—</span>

// ── Currency ────────────────────────────────────────────────────────

interface CurrencyCellProps {
  value: number | string | null | undefined
  currency?: string
  locale?: string
  className?: string
  /** Hide the currency symbol for compact displays. Default false. */
  bareNumber?: boolean
  /** Number of decimal places. Default 2. */
  fractionDigits?: number
}

export function CurrencyCell({
  value,
  currency = DEFAULT_CURRENCY,
  locale = DEFAULT_LOCALE,
  className,
  bareNumber = false,
  fractionDigits = 2,
}: CurrencyCellProps) {
  if (value == null || value === '') {
    return <span className={cn('text-right tabular-nums block', className)}>{NULL_DASH}</span>
  }
  const n = typeof value === 'string' ? parseFloat(value) : value
  if (!Number.isFinite(n)) {
    return <span className={cn('text-right tabular-nums block', className)}>{NULL_DASH}</span>
  }
  const formatted = bareNumber
    ? new Intl.NumberFormat(locale, {
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      }).format(n)
    : new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
      }).format(n)
  return (
    <span className={cn('text-right tabular-nums block', className)}>
      {formatted}
    </span>
  )
}

// ── Date ────────────────────────────────────────────────────────────

interface DateCellProps {
  value: string | Date | null | undefined
  /** 'short' = "7 May", 'medium' = "7 May 2026", 'long' = "7 May 2026, 14:32",
   *  'relative' = "2h ago" */
  format?: 'short' | 'medium' | 'long' | 'relative'
  locale?: string
  className?: string
}

const SHORT_OPTS: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }
const MEDIUM_OPTS: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }
const LONG_OPTS: Intl.DateTimeFormatOptions = {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
}

function formatRelative(date: Date, now = new Date()): string {
  const diffSec = Math.round((now.getTime() - date.getTime()) / 1000)
  if (diffSec < 60) return 'just now'
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.round(diffHr / 24)
  if (diffDay < 30) return `${diffDay}d ago`
  const diffMo = Math.round(diffDay / 30)
  if (diffMo < 12) return `${diffMo}mo ago`
  return `${Math.round(diffMo / 12)}y ago`
}

export function DateCell({
  value,
  format = 'short',
  locale = DEFAULT_LOCALE,
  className,
}: DateCellProps) {
  if (value == null || value === '') {
    return <span className={cn('text-slate-500 tabular-nums', className)}>{NULL_DASH}</span>
  }
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) {
    return <span className={cn('text-slate-500 tabular-nums', className)}>{NULL_DASH}</span>
  }
  let text: string
  if (format === 'relative') text = formatRelative(d)
  else if (format === 'long') text = new Intl.DateTimeFormat(locale, LONG_OPTS).format(d)
  else if (format === 'medium') text = new Intl.DateTimeFormat(locale, MEDIUM_OPTS).format(d)
  else text = new Intl.DateTimeFormat(locale, SHORT_OPTS).format(d)
  return (
    <span
      className={cn('text-slate-500 tabular-nums', className)}
      title={d.toLocaleString(locale, LONG_OPTS)}
    >
      {text}
    </span>
  )
}

// ── Image ───────────────────────────────────────────────────────────

interface ImageCellProps {
  src?: string | null
  alt?: string
  size?: 'xs' | 'sm' | 'md'
  className?: string
}

const IMAGE_SIZE = {
  xs: 'w-6 h-6',
  sm: 'w-8 h-8',
  md: 'w-10 h-10',
} as const

export function ImageCell({ src, alt = '', size = 'md', className }: ImageCellProps) {
  if (!src) {
    return (
      <div
        className={cn(
          'rounded bg-slate-100 flex items-center justify-center text-slate-400',
          IMAGE_SIZE[size],
          className,
        )}
        aria-hidden="true"
      >
        <ImageIcon size={size === 'xs' ? 10 : size === 'sm' ? 12 : 14} />
      </div>
    )
  }
  return (
    <img
      src={src}
      alt={alt}
      className={cn('rounded object-cover bg-slate-100', IMAGE_SIZE[size], className)}
    />
  )
}

// ── Link ────────────────────────────────────────────────────────────

interface LinkCellProps {
  href: string
  children: ReactNode
  /** Open in new tab. Adds the external icon affordance + rel=noopener. */
  external?: boolean
  className?: string
  mono?: boolean
}

export function LinkCell({ href, children, external, className, mono }: LinkCellProps) {
  const cls = cn(
    'text-info-700 hover:text-info-900 hover:underline truncate block',
    mono && 'font-mono',
    className,
  )
  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
        {children}
      </a>
    )
  }
  return (
    <Link href={href} className={cls}>
      {children}
    </Link>
  )
}

// ── Status ──────────────────────────────────────────────────────────
// Re-export StatusBadge under the TableCell namespace so callers using
// type-aware cells get a consistent import path.

export { StatusBadge as StatusCell } from './StatusBadge'
