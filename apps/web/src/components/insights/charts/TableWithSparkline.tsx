'use client'

import { Area, AreaChart, ResponsiveContainer } from 'recharts'
import { cn } from '@/lib/utils'
import { formatCurrency, formatNum, formatPct } from '../format'

export interface TableColumn<T> {
  key: string
  label: string
  align?: 'left' | 'right' | 'center'
  format?: 'currency' | 'number' | 'percent' | 'text' | 'sparkline' | 'delta'
  accessor: (row: T) => unknown
  className?: string
  width?: string
}

interface TableWithSparklineProps<T> {
  rows: T[]
  columns: TableColumn<T>[]
  currency?: string
  rowKey: (row: T) => string
  onRowClick?: (row: T) => void
  emptyLabel?: string
  dense?: boolean
}

function renderCell(
  col: TableColumn<unknown>,
  raw: unknown,
  currency: string,
): React.ReactNode {
  switch (col.format) {
    case 'currency':
      return (
        <span className="tabular-nums">
          {formatCurrency(Number(raw ?? 0), currency)}
        </span>
      )
    case 'number':
      return <span className="tabular-nums">{formatNum(Number(raw ?? 0))}</span>
    case 'percent':
      return <span className="tabular-nums">{formatPct(Number(raw ?? 0))}</span>
    case 'delta': {
      const v = raw == null ? null : Number(raw)
      if (v == null || Number.isNaN(v))
        return <span className="text-slate-400">—</span>
      const tone =
        Math.abs(v) < 0.5
          ? 'text-slate-500'
          : v > 0
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-rose-600 dark:text-rose-400'
      const sign = v > 0 ? '+' : ''
      return (
        <span className={cn('tabular-nums font-medium', tone)}>
          {sign}
          {v.toFixed(1)}%
        </span>
      )
    }
    case 'sparkline': {
      const series = (raw as number[] | null | undefined) ?? []
      if (series.length < 2)
        return <span className="text-slate-400 text-xs">—</span>
      const data = series.map((v, i) => ({ i, v }))
      return (
        <div className="h-6 w-20 inline-block">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={`ih-row-spark`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="rgb(16 185 129)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="rgb(16 185 129)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area
                type="monotone"
                dataKey="v"
                stroke="rgb(16 185 129)"
                strokeWidth={1.25}
                fill="url(#ih-row-spark)"
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )
    }
    default:
      return <>{String(raw ?? '')}</>
  }
}

export function TableWithSparkline<T>({
  rows,
  columns,
  currency = 'EUR',
  rowKey,
  onRowClick,
  emptyLabel = 'No data',
  dense = false,
}: TableWithSparklineProps<T>) {
  if (rows.length === 0) {
    return (
      <div className="text-sm text-slate-500 dark:text-slate-400 py-8 text-center">
        {emptyLabel}
      </div>
    )
  }
  const padY = dense ? 'py-1' : 'py-1.5'
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-200 dark:border-slate-800">
            {columns.map((c) => (
              <th
                key={c.key}
                className={cn(
                  'text-[11px] uppercase tracking-wider font-medium text-slate-500 dark:text-slate-400 px-2',
                  padY,
                  c.align === 'right' && 'text-right',
                  c.align === 'center' && 'text-center',
                  c.align !== 'right' && c.align !== 'center' && 'text-left',
                )}
                style={c.width ? { width: c.width } : undefined}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className={cn(
                'border-b border-slate-100 dark:border-slate-800/60 last:border-b-0',
                onRowClick &&
                  'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40',
              )}
              onClick={() => onRowClick?.(row)}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cn(
                    'px-2 text-slate-800 dark:text-slate-200',
                    padY,
                    c.align === 'right' && 'text-right',
                    c.align === 'center' && 'text-center',
                    c.className,
                  )}
                >
                  {renderCell(
                    c as TableColumn<unknown>,
                    c.accessor(row),
                    currency,
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
