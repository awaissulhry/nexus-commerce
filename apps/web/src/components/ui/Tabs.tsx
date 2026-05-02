'use client'

import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface Tab {
  id: string
  label: ReactNode
  count?: number
  disabled?: boolean
}

interface TabsProps {
  tabs: Tab[]
  activeTab: string
  onChange: (id: string) => void
  trailing?: ReactNode
  className?: string
}

export function Tabs({ tabs, activeTab, onChange, trailing, className }: TabsProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-0 border-b border-slate-200 -mb-px overflow-x-auto',
        className
      )}
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id
        return (
          <button
            key={tab.id}
            onClick={() => !tab.disabled && onChange(tab.id)}
            disabled={tab.disabled}
            className={cn(
              'flex items-center gap-1.5 h-10 px-4 text-[13px] font-medium border-b-2 transition-colors whitespace-nowrap',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30',
              isActive
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-600 hover:text-slate-900',
              tab.disabled && 'opacity-50 cursor-not-allowed'
            )}
          >
            {tab.label}
            {tab.count != null && (
              <span
                className={cn(
                  'inline-flex items-center justify-center rounded text-[10px] tabular-nums px-1.5 py-0.5 min-w-[18px]',
                  isActive ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-600'
                )}
              >
                {tab.count}
              </span>
            )}
          </button>
        )
      })}
      {trailing && <div className="ml-auto">{trailing}</div>}
    </div>
  )
}
