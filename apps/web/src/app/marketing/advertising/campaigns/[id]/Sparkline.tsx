'use client'

/**
 * CD.6 — tiny inline SVG sparkline (no recharts, cheap enough for one per
 * table row). Draws a trailing daily series; the last point gets a dot.
 */

export function Sparkline({ data, width = 64, height = 18, color = '#6366f1' }: { data: number[] | undefined; width?: number; height?: number; color?: string }) {
  if (!data || data.length === 0 || data.every((v) => v === 0)) {
    return <span className="text-slate-300 dark:text-slate-600 text-xs">—</span>
  }
  const max = Math.max(...data)
  const min = Math.min(...data)
  const range = max - min || 1
  const n = data.length
  const stepX = n > 1 ? width / (n - 1) : 0
  const y = (v: number) => height - 1 - ((v - min) / range) * (height - 2)
  const pts = data.map((v, i) => `${(i * stepX).toFixed(1)},${y(v).toFixed(1)}`)
  const lastX = (n - 1) * stepX
  const lastY = y(data[n - 1] ?? 0)
  return (
    <svg width={width} height={height} className="inline-block align-middle" aria-hidden>
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastX} cy={lastY} r={1.6} fill={color} />
    </svg>
  )
}
