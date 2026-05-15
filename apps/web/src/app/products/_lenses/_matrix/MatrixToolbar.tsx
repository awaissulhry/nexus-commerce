'use client'

import { memo } from 'react'
import { ChevronsUpDown, ChevronsDownUp } from 'lucide-react'
import {
  CONTENT_LOCALES,
  CONTENT_LOCALE_FLAGS,
  CONTENT_LOCALE_LABELS,
  CHANNEL_GROUPS,
  type ContentLocale,
  type ChannelGroup,
} from './types'

interface Props {
  contentLocale: ContentLocale
  onLocaleChange: (locale: ContentLocale) => void
  expandedChannelGroups: Set<ChannelGroup>
  onExpandAll: () => void
  onCollapseAll: () => void
}

export const MatrixToolbar = memo(function MatrixToolbar({
  contentLocale,
  onLocaleChange,
  expandedChannelGroups,
  onExpandAll,
  onCollapseAll,
}: Props) {
  const allExpanded = expandedChannelGroups.size === CHANNEL_GROUPS.length
  const allCollapsed = expandedChannelGroups.size === 0

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
      {/* Content locale picker */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap">
          Content locale:
        </span>
        <div className="flex items-center gap-0.5 rounded-md bg-slate-100 dark:bg-slate-700 p-0.5">
          {CONTENT_LOCALES.map((loc) => (
            <button
              key={loc}
              onClick={() => onLocaleChange(loc)}
              title={CONTENT_LOCALE_LABELS[loc]}
              className={`h-6 px-2 text-xs font-medium rounded transition-colors inline-flex items-center gap-1 ${
                contentLocale === loc
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300'
              }`}
            >
              <span>{CONTENT_LOCALE_FLAGS[loc]}</span>
              <span className="uppercase">{loc}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="h-4 w-px bg-slate-200 dark:bg-slate-600" />

      {/* Channel group expand/collapse controls */}
      <div className="flex items-center gap-1">
        <button
          onClick={onExpandAll}
          disabled={allExpanded}
          title="Expand all channel groups"
          className="h-6 px-2 text-xs inline-flex items-center gap-1 rounded text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-default transition-colors"
        >
          <ChevronsUpDown size={12} />
          Expand all
        </button>
        <button
          onClick={onCollapseAll}
          disabled={allCollapsed}
          title="Collapse all channel groups"
          className="h-6 px-2 text-xs inline-flex items-center gap-1 rounded text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-default transition-colors"
        >
          <ChevronsDownUp size={12} />
          Collapse all
        </button>
      </div>
    </div>
  )
})
