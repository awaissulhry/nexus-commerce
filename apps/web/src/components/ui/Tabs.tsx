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
        'flex items-center gap-0 border-b border-default -mb-px overflow-x-auto',
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
              // U.60 — flex-shrink-0 belt-and-braces with whitespace-nowrap
              // so a tab never squishes into a constrained parent.
              'flex items-center gap-1.5 h-10 px-4 text-md font-label border-b-2 transition-colors whitespace-nowrap flex-shrink-0',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-info-500/30',
              isActive
                ? 'border-info-600 text-info-700'
                : 'border-transparent text-secondary hover:text-primary',
              tab.disabled && 'opacity-50 cursor-not-allowed'
            )}
          >
            {tab.label}
            {tab.count != null && (
              <span
                className={cn(
                  'inline-flex items-center justify-center rounded text-xs tabular-nums px-1.5 py-0.5 min-w-[18px]',
                  isActive ? 'bg-info-soft text-info-strong' : 'bg-sunken text-secondary'
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
