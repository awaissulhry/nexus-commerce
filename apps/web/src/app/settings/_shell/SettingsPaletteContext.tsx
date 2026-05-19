'use client'

/**
 * Settings rebuild — Phase A.4
 *
 * Settings-scoped command palette. Two halves:
 *
 *   1. <SettingsPaletteProvider> wraps the settings tree and owns
 *      the open/close state + the global Cmd+K (and Ctrl+K) keybind.
 *      Mounts the actual <SettingsPalette> modal so any descendant
 *      can call useSettingsPalette().open().
 *
 *   2. The palette itself renders an input + result list, indexing
 *      SETTINGS_NAV labels + descriptions + keywords. Hitting Enter
 *      (or clicking a result) router.push()es to the page and
 *      closes.
 *
 * The keyword list in settings-nav.ts is the leverage point — add
 * "Codice Fiscale" to the company-page item's keywords[] and the
 * operator can find it by typing that phrase.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useRouter } from 'next/navigation'
import { Search, CornerDownLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SETTINGS_NAV, type SettingsNavItem } from './settings-nav'

interface PaletteContextValue {
  open: () => void
  close: () => void
  isOpen: boolean
}

const PaletteContext = createContext<PaletteContextValue | null>(null)

export function useSettingsPalette(): PaletteContextValue {
  const ctx = useContext(PaletteContext)
  if (!ctx) {
    throw new Error(
      'useSettingsPalette must be called within <SettingsPaletteProvider>',
    )
  }
  return ctx
}

export function SettingsPaletteProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [isOpen, setIsOpen] = useState(false)
  const open = useCallback(() => setIsOpen(true), [])
  const close = useCallback(() => setIsOpen(false), [])

  // Global Cmd+K / Ctrl+K to open. Intentionally only active when
  // we're inside the settings tree (the provider only wraps /settings),
  // so we don't fight with any other Cmd+K palette the app might add.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setIsOpen((prev) => !prev)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const value = useMemo<PaletteContextValue>(
    () => ({ open, close, isOpen }),
    [open, close, isOpen],
  )

  return (
    <PaletteContext.Provider value={value}>
      {children}
      {isOpen && <SettingsPalette onClose={close} />}
    </PaletteContext.Provider>
  )
}

// ─────────────────────────────────────────────────────────────────
// The modal itself.
// ─────────────────────────────────────────────────────────────────

/**
 * Build the flat searchable index once per mount. Each entry carries
 * the source nav item + its group label (rendered as a subtitle so
 * "Profile" results are distinguishable from "Company > Profile-ish").
 */
function buildIndex(): Array<{
  item: SettingsNavItem
  groupLabel: string
  haystack: string
}> {
  return SETTINGS_NAV.flatMap((group) =>
    group.items.map((item) => ({
      item,
      groupLabel: group.label,
      haystack: [
        item.label,
        item.description,
        group.label,
        ...item.keywords,
      ]
        .join(' ')
        .toLowerCase(),
    })),
  )
}

function SettingsPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const index = useMemo(buildIndex, [])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return index
    // Token-AND: every whitespace-separated token must appear in the
    // haystack. Matches the operator mental model — "codice italian"
    // finds the company page.
    const tokens = q.split(/\s+/).filter(Boolean)
    return index.filter((entry) =>
      tokens.every((t) => entry.haystack.includes(t)),
    )
  }, [query, index])

  // Clamp active index when results shrink past it.
  useEffect(() => {
    if (activeIdx >= results.length) setActiveIdx(0)
  }, [results.length, activeIdx])

  // Autofocus on mount.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Keyboard navigation.
  const navigate = useCallback(
    (item: SettingsNavItem) => {
      router.push(item.href)
      onClose()
    },
    [router, onClose],
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(results.length - 1, i + 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(0, i - 1))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const sel = results[activeIdx]
      if (sel) navigate(sel.item)
    }
  }

  // Keep the active row in view when arrowing past the visible window.
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const row = list.children[activeIdx] as HTMLElement | undefined
    if (row?.scrollIntoView) {
      row.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIdx])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Find a setting"
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] px-4"
    >
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden
      />
      <div className="relative w-full max-w-xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-800">
          <Search
            size={16}
            className="text-slate-400 dark:text-slate-500 shrink-0"
          />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Find a setting — try “Codice Fiscale”, “2FA”, “webhook”"
            className="flex-1 bg-transparent outline-none text-base text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500"
            aria-label="Search settings"
          />
          <kbd className="hidden sm:inline-flex items-center h-5 px-1.5 rounded bg-slate-100 dark:bg-slate-800 text-xs font-mono text-slate-500 dark:text-slate-400">
            esc
          </kbd>
        </div>

        {results.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
            No settings match{' '}
            <span className="font-mono text-slate-700 dark:text-slate-300">
              “{query}”
            </span>
            .
          </div>
        ) : (
          <ul
            ref={listRef}
            role="listbox"
            aria-label="Settings results"
            className="max-h-[60vh] overflow-y-auto py-1"
          >
            {results.map((entry, idx) => {
              const Icon = entry.item.icon
              const isActive = idx === activeIdx
              return (
                <li
                  key={entry.item.href}
                  role="option"
                  aria-selected={isActive}
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => navigate(entry.item)}
                  className={cn(
                    'px-4 py-2 cursor-pointer flex items-center gap-3',
                    isActive
                      ? 'bg-blue-50 dark:bg-blue-950/40'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800/50',
                  )}
                >
                  <Icon
                    size={16}
                    className={cn(
                      isActive
                        ? 'text-blue-600 dark:text-blue-400'
                        : 'text-slate-400 dark:text-slate-500',
                    )}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-900 dark:text-slate-100 flex items-center gap-2">
                      {entry.item.label}
                      <span className="text-xs text-slate-400 dark:text-slate-500 font-normal">
                        {entry.groupLabel}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                      {entry.item.description}
                    </div>
                  </div>
                  {isActive && (
                    <CornerDownLeft
                      size={14}
                      className="text-slate-400 dark:text-slate-500"
                    />
                  )}
                </li>
              )
            })}
          </ul>
        )}

        <div className="border-t border-slate-200 dark:border-slate-800 px-4 py-2 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <kbd className="inline-flex items-center h-4 px-1 rounded bg-slate-100 dark:bg-slate-800 font-mono">
                ↑↓
              </kbd>
              navigate
            </span>
            <span className="inline-flex items-center gap-1">
              <kbd className="inline-flex items-center h-4 px-1 rounded bg-slate-100 dark:bg-slate-800 font-mono">
                ↵
              </kbd>
              open
            </span>
          </div>
          <span>
            {results.length} of {index.length}
          </span>
        </div>
      </div>
    </div>
  )
}
