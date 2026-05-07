import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface CardProps {
  title?: ReactNode
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
  noPadding?: boolean
}

export function Card({ title, description, action, children, className, noPadding }: CardProps) {
  return (
    <div className={cn('bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg', className)}>
      {(title || description || action) && (
        <div className="flex items-start justify-between gap-4 px-4 py-3 border-b border-slate-200 dark:border-slate-800">
          <div className="min-w-0">
            {title && (
              <h2 className="text-md font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
            )}
            {description && (
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{description}</p>
            )}
          </div>
          {action && <div className="flex-shrink-0">{action}</div>}
        </div>
      )}
      <div className={cn(noPadding ? '' : 'p-4')}>{children}</div>
    </div>
  )
}
