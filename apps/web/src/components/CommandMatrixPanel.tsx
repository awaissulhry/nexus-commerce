'use client'

/**
 * P5.3 — Command Matrix Panel.
 *
 * Keyboard shortcut reference overlay — the "cheat sheet" for all
 * 100+ commands registered in CommandPalette.tsx.
 *
 * Trigger:
 *   - `Shift+?` (anywhere in the app)
 *   - `nexus:open-shortcut-help` custom event (fired by the
 *     "Show keyboard shortcuts" command in the palette)
 *
 * Renders all COMMANDS + PAGE_COMMANDS grouped by category in a
 * two-column grid. Each row shows the shortcut badge(s) and label.
 * A search input narrows the list. ESC / Shift+? again closes.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Keyboard, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { COMMANDS, PAGE_COMMANDS, type Command } from './CommandPalette'

// Groups to render (in display order). PAGE_COMMANDS show at the end
// under "Page actions".
const GROUP_ORDER = [
  'Navigation',
  'Catalog',
  'Action',
  'Replenishment',
  'Marketing',
  'Shipments',
  'Pending orders',
  'System',
  'On this page',
]

function ShortcutBadge({ text }: { text: string }) {
  return (
    <kbd className="inline-flex items-center px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-600 text-[10px] font-mono text-slate-700 dark:text-slate-300 leading-none whitespace-nowrap">
      {text}
    </kbd>
  )
}

function CommandRow({ cmd }: { cmd: Command }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 px-2 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800/50 group">
      <div className="flex items-center gap-2 min-w-0">
        <cmd.icon className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
        <span className="text-xs text-slate-700 dark:text-slate-300 truncate">{cmd.label}</span>
      </div>
      {cmd.chord ? (
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {cmd.chord.split(' ').map((k, i) => <ShortcutBadge key={i} text={k} />)}
        </div>
      ) : (
        <ShortcutBadge text="⌘K" />
      )}
    </div>
  )
}

export default function CommandMatrixPanel() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Shift+? = Shift+/ (keyCode 191 or key '?')
      if (e.shiftKey && (e.key === '?' || e.key === '/') && !e.metaKey && !e.ctrlKey) {
        const tag = (e.target as HTMLElement)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        e.preventDefault()
        setOpen((o) => !o)
      }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    const h = () => setOpen((o) => !o)
    window.addEventListener('nexus:open-shortcut-help', h)
    return () => window.removeEventListener('nexus:open-shortcut-help', h)
  }, [])

  useEffect(() => {
    if (open) {
      setQuery('')
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const allCommands = useMemo(() => [...COMMANDS, ...PAGE_COMMANDS], [])

  const filtered = useMemo(() => {
    if (!query.trim()) return allCommands
    const q = query.toLowerCase()
    return allCommands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        (c.keywords ?? '').toLowerCase().includes(q) ||
        (c.chord ?? '').toLowerCase().includes(q) ||
        c.group.toLowerCase().includes(q),
    )
  }, [allCommands, query])

  const grouped = useMemo(() => {
    const map = new Map<string, Command[]>()
    for (const cmd of filtered) {
      const g = cmd.group === 'On this page' ? 'Page actions' : cmd.group
      if (!map.has(g)) map.set(g, [])
      map.get(g)!.push(cmd)
    }
    // Return in defined order, then any remaining groups alphabetically
    const ordered: Array<[string, Command[]]> = []
    const seen = new Set<string>()
    for (const g of GROUP_ORDER) {
      const label = g === 'On this page' ? 'Page actions' : g
      if (map.has(label)) { ordered.push([label, map.get(label)!]); seen.add(label) }
    }
    for (const [g, cmds] of map.entries()) {
      if (!seen.has(g)) ordered.push([g, cmds])
    }
    return ordered
  }, [filtered])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center pt-[8vh] px-4"
      onClick={(e) => { if (e.target === e.currentTarget) setOpen(false) }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setOpen(false)} />

      {/* Panel */}
      <div className="relative z-10 w-full max-w-2xl max-h-[82vh] flex flex-col bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700 shadow-2xl overflow-hidden">

        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-200 dark:border-slate-700 flex-shrink-0">
          <Keyboard className="w-4 h-4 text-slate-400 flex-shrink-0" />
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">Keyboard shortcuts</span>
          <div className="flex-1" />
          <div className="text-xs text-slate-400 hidden sm:block">
            <ShortcutBadge text="Shift" /> <span className="mx-1">+</span> <ShortcutBadge text="?" /> to toggle
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 ml-2"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-2 border-b border-slate-100 dark:border-slate-800 flex-shrink-0">
          <div className="relative flex items-center">
            <Search className="absolute left-2.5 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search shortcuts…"
              className="w-full pl-8 pr-3 py-1.5 text-sm border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-2 text-slate-400 hover:text-slate-600"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>

        {/* Command grid */}
        <div className="flex-1 overflow-y-auto p-4">
          {grouped.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-8">No shortcuts match "{query}"</p>
          ) : (
            <div className="space-y-5">
              {grouped.map(([group, cmds]) => (
                <div key={group}>
                  <h3 className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1.5 px-2">
                    {group}
                  </h3>
                  <div className={cn(
                    'grid gap-0',
                    cmds.length > 4 ? 'grid-cols-2' : 'grid-cols-1',
                  )}>
                    {cmds.map((cmd) => <CommandRow key={cmd.id} cmd={cmd} />)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-slate-100 dark:border-slate-800 flex items-center gap-3 text-xs text-slate-400 flex-shrink-0">
          <span>{allCommands.length} shortcuts total</span>
          <span>·</span>
          <span>Open command palette with <ShortcutBadge text="⌘K" /> or <ShortcutBadge text="?" /></span>
        </div>
      </div>
    </div>
  )
}
