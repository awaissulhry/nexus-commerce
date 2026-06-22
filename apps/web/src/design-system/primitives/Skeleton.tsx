export interface SkeletonProps {
  width?: number | string
  height?: number | string
  radius?: number | string
  className?: string
}

/** Shimmering loading placeholder (H10 `.skb` gradient). */
export function Skeleton({ width = '100%', height = 12, radius, className }: SkeletonProps) {
  return (
    <span
      className={['h10-ds-skeleton', className ?? ''].filter(Boolean).join(' ')}
      style={{ width, height, ...(radius != null ? { borderRadius: radius } : null) }}
      aria-hidden
    />
  )
}
