'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface Props {
  page: number
  totalPages: number
  total: number
  pageSize: number
  loading: boolean
  onChange: (next: number) => void
}

export default function PaginationStrip({
  page,
  totalPages,
  total,
  pageSize,
  loading,
  onChange,
}: Props) {
  if (total === 0) return null

  const start = (page - 1) * pageSize + 1
  const end = Math.min(page * pageSize, total)
  const canPrev = page > 1 && !loading
  const canNext = page < totalPages && !loading

  return (
    <div className="flex items-center justify-between text-[12px] text-slate-600 px-1 py-2">
      <div className="tabular-nums">
        Showing{' '}
        <span className="font-medium text-slate-900">
          {start.toLocaleString()}
        </span>
        {' – '}
        <span className="font-medium text-slate-900">
          {end.toLocaleString()}
        </span>{' '}
        of{' '}
        <span className="font-medium text-slate-900">
          {total.toLocaleString()}
        </span>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => canPrev && onChange(page - 1)}
          disabled={!canPrev}
          className={cn(
            'inline-flex items-center gap-1 h-7 px-2 rounded border text-[12px]',
            canPrev
              ? 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              : 'border-slate-100 bg-slate-50 text-slate-400 cursor-default',
          )}
        >
          <ChevronLeft className="w-3.5 h-3.5" />
          Prev
        </button>
        <div className="px-2 tabular-nums">
          Page <span className="font-medium text-slate-900">{page}</span> of{' '}
          <span className="font-medium text-slate-900">{totalPages}</span>
        </div>
        <button
          type="button"
          onClick={() => canNext && onChange(page + 1)}
          disabled={!canNext}
          className={cn(
            'inline-flex items-center gap-1 h-7 px-2 rounded border text-[12px]',
            canNext
              ? 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              : 'border-slate-100 bg-slate-50 text-slate-400 cursor-default',
          )}
        >
          Next
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  )
}
