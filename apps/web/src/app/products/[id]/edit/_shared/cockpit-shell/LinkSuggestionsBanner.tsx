'use client'

// FL.6.2 — Smart link suggestions banner.
//
// Surfaces fields whose value is already identical across markets and
// offers a one-click link, then gets out of the way. Dismissible.

import { Lightbulb, X } from 'lucide-react'
import type { LinkSuggestion } from './useFieldLinks'

export interface LinkSuggestionsBannerProps {
  suggestions: LinkSuggestion[]
  onLink: (s: LinkSuggestion) => void
  onDismiss: (fieldKey: string) => void
}

export default function LinkSuggestionsBanner({
  suggestions,
  onLink,
  onDismiss,
}: LinkSuggestionsBannerProps) {
  if (suggestions.length === 0) return null

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900 dark:bg-amber-950/30">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
        <Lightbulb className="h-3.5 w-3.5" />
        Linking suggestions
      </div>
      <ul className="space-y-1">
        {suggestions.map((s) => (
          <li key={s.fieldKey} className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-300">
              <span className="font-medium">{s.label}</span> is identical
              <span className="text-slate-500"> ({s.sampleValue})</span> on {s.count} markets
            </span>
            <button
              type="button"
              onClick={() => onLink(s)}
              className="shrink-0 rounded border border-amber-300 bg-white px-2 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:bg-slate-900 dark:text-amber-300"
            >
              Link {s.count}
            </button>
            <button
              type="button"
              onClick={() => onDismiss(s.fieldKey)}
              aria-label={`Dismiss ${s.label} suggestion`}
              className="shrink-0 rounded p-0.5 text-amber-500 hover:bg-amber-100 dark:hover:bg-amber-900/40"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
