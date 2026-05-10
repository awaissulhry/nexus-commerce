'use client'

// MC.1.4 — search input with clear button + recent searches dropdown.
// Owns local input state (so debouncing happens at the parent without
// fighting controlled-component re-renders) and surfaces recent
// searches when focused with an empty value.

import { useEffect, useRef, useState } from 'react'
import { Search, X, Clock } from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'
import {
  readRecentSearches,
  pushRecentSearch,
  clearRecentSearches,
} from '../_lib/recent-searches'

interface Props {
  value: string
  onChange: (next: string) => void
}

export default function SearchInput({ value, onChange }: Props) {
  const { t } = useTranslations()
  const placeholder = t('marketingContent.toolbar.searchPlaceholder')
  const [recents, setRecents] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setRecents(readRecentSearches())
  }, [])

  // Close dropdown on outside click + Escape.
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Persist on Enter so we don't pollute recents with each keystroke.
  const persist = (q: string) => {
    if (q.trim()) {
      const next = pushRecentSearch(q)
      setRecents(next)
    }
  }

  const showRecents = open && !value.trim() && recents.length > 0

  return (
    <div ref={containerRef} className="relative flex-1 min-w-0">
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 dark:text-slate-500"
        aria-hidden="true"
      />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            persist(value)
            setOpen(false)
          }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full rounded-md border border-slate-300 bg-white py-2 pl-8 pr-9 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100 dark:placeholder-slate-500"
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            onChange('')
            inputRef.current?.focus()
          }}
          aria-label={t('marketingContent.toolbar.searchClear')}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}

      {showRecents && (
        <div
          role="listbox"
          aria-label={t('marketingContent.toolbar.recentSearches')}
          className="absolute left-0 right-0 top-full z-20 mt-1 rounded-md border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          <div className="flex items-center justify-between px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            <span className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              {t('marketingContent.toolbar.recentSearches')}
            </span>
            <button
              type="button"
              onClick={() => {
                clearRecentSearches()
                setRecents([])
              }}
              className="text-xs font-normal text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
            >
              {t('marketingContent.toolbar.searchClearRecent')}
            </button>
          </div>
          <ul>
            {recents.map((r) => (
              <li key={r}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange(r)
                    setOpen(false)
                  }}
                  className="block w-full px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  {r}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
