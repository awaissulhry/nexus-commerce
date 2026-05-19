'use client'

import type { ComponentType, SVGProps } from 'react'

export interface LensTab<K extends string = string> {
  key: K
  label: string
  /** lucide-react icon component (accepts size prop). */
  icon?: ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>
  /** Hide this tab without removing it from the catalog. */
  hidden?: boolean
}

export interface LensTabsProps<K extends string = string> {
  /** Catalog of every tab the page could expose. */
  tabs: ReadonlyArray<LensTab<K>>
  /** Active tab key. */
  current: K
  onChange: (next: K) => void
  /** Optional className for the outer container. */
  className?: string
}

/**
 * Segmented pill-style lens tabs. Shared chrome so the workspace
 * surfaces look identical wherever they appear. Pages that need
 * locked + reorderable + picker behavior (e.g. /products) keep
 * their own richer component but the visual treatment matches.
 */
export function LensTabs<K extends string = string>({
  tabs, current, onChange, className,
}: LensTabsProps<K>) {
  const visible = tabs.filter((t) => !t.hidden)
  return (
    <div
      className={`inline-flex items-center bg-slate-100 dark:bg-slate-800 rounded-md p-0.5 ${className ?? ''}`}
      role="tablist"
    >
      {visible.map((tab) => {
        const Icon = tab.icon
        const isActive = current === tab.key
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(tab.key)}
            className={`h-7 px-3 text-base font-medium inline-flex items-center gap-1.5 rounded transition-colors ${
              isActive
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            {Icon && <Icon size={12} aria-hidden="true" />}
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
