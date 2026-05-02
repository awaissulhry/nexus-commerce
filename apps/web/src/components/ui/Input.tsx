'use client'

import { forwardRef, type InputHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  hint?: string
  prefix?: string
  suffix?: string
  charLimit?: number
  mono?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    { label, error, hint, prefix, suffix, charLimit, mono, className, value, id, ...props },
    ref
  ) => {
    const charCount = typeof value === 'string' ? value.length : 0
    const overLimit = charLimit != null && charCount > charLimit

    return (
      <div className="space-y-1">
        {(label || charLimit) && (
          <div className="flex items-baseline justify-between gap-2">
            {label && (
              <label htmlFor={id} className="text-[12px] font-medium text-slate-700">
                {label}
              </label>
            )}
            {charLimit != null && (
              <span
                className={cn(
                  'text-[10px] tabular-nums',
                  overLimit ? 'text-red-600' : 'text-slate-500'
                )}
              >
                {charCount} / {charLimit}
              </span>
            )}
          </div>
        )}
        <div className="relative">
          {prefix && (
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-[13px] pointer-events-none">
              {prefix}
            </span>
          )}
          <input
            ref={ref}
            id={id}
            value={value}
            className={cn(
              'w-full h-8 rounded-md border bg-white text-[13px] text-slate-900 placeholder:text-slate-400',
              'border-slate-200 hover:border-slate-300 focus:border-blue-500',
              'focus:outline-none focus:ring-2 focus:ring-blue-500/20',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              'transition-colors',
              prefix ? 'pl-7' : 'pl-3',
              suffix ? 'pr-7' : 'pr-3',
              mono && 'font-mono',
              (error || overLimit) &&
                'border-red-300 focus:border-red-500 focus:ring-red-500/20',
              className
            )}
            {...props}
          />
          {suffix && (
            <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-[13px] pointer-events-none">
              {suffix}
            </span>
          )}
        </div>
        {error && <p className="text-[11px] text-red-600">{error}</p>}
        {hint && !error && <p className="text-[11px] text-slate-500">{hint}</p>}
      </div>
    )
  }
)

Input.displayName = 'Input'
