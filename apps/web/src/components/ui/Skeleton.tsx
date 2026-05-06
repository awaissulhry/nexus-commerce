'use client'

/**
 * Skeleton — shimmer placeholder for first-paint loading.
 *
 * Pages currently render either nothing or a centered Spinner while
 * data loads, both of which reset layout when the real content
 * arrives. Skeletons preserve the page shape so the user sees a
 * stable layout from the first byte.
 *
 * Usage:
 *   {loading ? <Skeleton lines={3} /> : <Content />}
 *   {loading ? <Skeleton variant="card" /> : <Card>{...}</Card>}
 */

import { cn } from '@/lib/utils'

type Variant = 'text' | 'card' | 'avatar' | 'thumbnail' | 'pill' | 'block'

const SHIMMER =
  'animate-pulse bg-gradient-to-r from-slate-100 via-slate-200 to-slate-100 bg-[length:200%_100%]'

export function Skeleton({
  variant = 'text',
  lines = 1,
  className,
  width,
  height,
}: {
  variant?: Variant
  /** For variant='text', number of staggered lines. Default 1. */
  lines?: number
  className?: string
  /** CSS width override (e.g. '60%' for partial-width text rows). */
  width?: string | number
  /** CSS height override (block variant). */
  height?: string | number
}) {
  if (variant === 'text') {
    return (
      <div className={cn('space-y-1.5', className)}>
        {Array.from({ length: lines }).map((_, i) => {
          // Last line shorter to mimic real text wrapping.
          const w =
            width != null
              ? typeof width === 'number'
                ? `${width}px`
                : width
              : i === lines - 1 && lines > 1
                ? '70%'
                : '100%'
          return (
            <div
              key={i}
              className={cn(SHIMMER, 'h-3 rounded')}
              style={{ width: w }}
            />
          )
        })}
      </div>
    )
  }
  if (variant === 'card') {
    return (
      <div
        className={cn(
          'border border-slate-200 rounded-md p-3 space-y-2',
          className,
        )}
      >
        <div className={cn(SHIMMER, 'h-4 rounded w-1/3')} />
        <div className={cn(SHIMMER, 'h-3 rounded w-full')} />
        <div className={cn(SHIMMER, 'h-3 rounded w-5/6')} />
      </div>
    )
  }
  if (variant === 'avatar') {
    return (
      <div
        className={cn(SHIMMER, 'rounded-full', className)}
        style={{
          width: width ?? 32,
          height: height ?? width ?? 32,
        }}
      />
    )
  }
  if (variant === 'thumbnail') {
    return (
      <div
        className={cn(SHIMMER, 'rounded', className)}
        style={{
          width: width ?? 40,
          height: height ?? width ?? 40,
        }}
      />
    )
  }
  if (variant === 'pill') {
    return (
      <div
        className={cn(SHIMMER, 'h-5 rounded-full', className)}
        style={{ width: width ?? 80 }}
      />
    )
  }
  // block — generic rectangle. Caller passes width/height.
  return (
    <div
      className={cn(SHIMMER, 'rounded', className)}
      style={{
        width: width ?? '100%',
        height: height ?? 16,
      }}
    />
  )
}

/**
 * SkeletonRow — table-row-shaped skeleton for grids that haven't
 * loaded their first page yet. Renders a flex row of N
 * variable-width pills so it visually resembles a real row of data.
 */
export function SkeletonRow({
  columns = 5,
  className,
}: {
  columns?: number
  className?: string
}) {
  // Mix widths so the row doesn't look mechanical.
  const widths = ['20%', '32%', '12%', '18%', '14%', '24%', '16%', '22%']
  return (
    <div
      className={cn(
        'flex items-center gap-3 py-2.5 border-b border-slate-100',
        className,
      )}
    >
      {Array.from({ length: columns }).map((_, i) => (
        <div
          key={i}
          className={cn(SHIMMER, 'h-3 rounded')}
          style={{ width: widths[i % widths.length] }}
        />
      ))}
    </div>
  )
}
