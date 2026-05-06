'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Search,
  Package,
  FileText,
  Settings as SettingsIcon,
  Tag,
  Layers,
  Upload,
  Boxes,
  Activity,
  ClipboardList,
  HeartPulse,
  History,
  Plug,
  FileEdit,
  Warehouse,
  Keyboard,
  X,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface Command {
  id: string
  label: string
  icon: LucideIcon
  href: string
  group: 'Navigation' | 'Catalog' | 'System'
  /** Optional Linear-style chord (e.g. 'g p' for "go to products"). */
  chord?: string
}

const COMMANDS: Command[] = [
  // Navigation
  { id: 'goto-products', label: 'Go to Products', icon: Package, href: '/products', group: 'Navigation', chord: 'g p' },
  { id: 'goto-listings', label: 'Go to All Listings', icon: Boxes, href: '/listings', group: 'Navigation', chord: 'g l' },
  { id: 'goto-orders', label: 'Go to Orders', icon: FileText, href: '/orders', group: 'Navigation', chord: 'g o' },
  { id: 'goto-pricing', label: 'Go to Pricing', icon: Tag, href: '/pricing', group: 'Navigation', chord: 'g r' },
  { id: 'goto-stock', label: 'Go to Stock', icon: Warehouse, href: '/fulfillment/stock', group: 'Navigation', chord: 'g s' },
  { id: 'goto-pos', label: 'Go to Purchase Orders (approval workflow)', icon: FileEdit, href: '/fulfillment/purchase-orders', group: 'Navigation', chord: 'g u' },
  { id: 'goto-pick-list', label: 'Go to Pick List (warehouse picking)', icon: ClipboardList, href: '/fulfillment/outbound/pick-list', group: 'Navigation', chord: 'g k' },
  { id: 'goto-qc-queue', label: 'Go to QC Queue (inbound supervisor review)', icon: ClipboardList, href: '/fulfillment/inbound/qc-queue', group: 'Navigation', chord: 'g q' },
  { id: 'goto-routing-rules', label: 'Go to Order Routing Rules', icon: FileEdit, href: '/fulfillment/routing-rules', group: 'Navigation' },
  { id: 'goto-cycle-count', label: 'Go to Cycle Counts (physical inventory)', icon: ClipboardList, href: '/fulfillment/stock/cycle-count', group: 'Navigation' },
  { id: 'goto-activity', label: 'Go to Activity Log', icon: Activity, href: '/sync-logs', group: 'Navigation' },
  { id: 'goto-audit-log', label: 'Go to Audit Log (every mutation)', icon: History, href: '/audit-log', group: 'Navigation', chord: 'g a' },
  { id: 'goto-health', label: 'Go to Sync Health', icon: HeartPulse, href: '/dashboard/health', group: 'Navigation', chord: 'g h' },
  // Catalog actions
  { id: 'catalog-organize', label: 'Organize catalog (group orphans, promote standalones)', icon: Layers, href: '/catalog/organize', group: 'Catalog', chord: 'g c' },
  { id: 'wizard-drafts', label: 'Resume a listing wizard draft', icon: FileEdit, href: '/products/drafts', group: 'Catalog', chord: 'g d' },
  { id: 'bulk-upload', label: 'Bulk upload products', icon: Upload, href: '/bulk-operations', group: 'Catalog', chord: 'g b' },
  { id: 'bulk-history', label: 'View bulk operations history', icon: History, href: '/bulk-operations/history', group: 'Catalog', chord: 'g j' },
  // System
  { id: 'connections', label: 'Manage channel connections', icon: Plug, href: '/settings/channels', group: 'System' },
  { id: 'settings', label: 'Open Settings', icon: SettingsIcon, href: '/settings/account', group: 'System' },
]

/**
 * Chord shortcut registry — extracted from COMMANDS so the keydown
 * handler can do an O(1) lookup. e.g. { 'g p': '/products' }.
 */
const CHORD_TO_HREF: Record<string, string> = COMMANDS.reduce((acc, cmd) => {
  if (cmd.chord) acc[cmd.chord] = cmd.href
  return acc
}, {} as Record<string, string>)

/**
 * Window of time (ms) we wait between the leader key (e.g. 'g') and
 * the second key. Long enough to feel forgiving, short enough that a
 * stray 'g' followed seconds later doesn't accidentally navigate.
 */
const CHORD_TIMEOUT_MS = 1500

export default function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement | null>(null)
  // Chord state — when the user presses a leader key like 'g', the
  // next key within CHORD_TIMEOUT_MS forms the chord. Tracked in a
  // ref so the handler stays stable across renders.
  const chordLeader = useRef<string | null>(null)
  const chordTimer = useRef<number | null>(null)

  // Global keyboard handler:
  //   ⌘K          — open palette (toggle)
  //   Escape      — close palette / help
  //   ?           — open shortcut help (when not typing)
  //   /           — focus active page's search input (dispatches
  //                 nexus:focus-search; pages may listen)
  //   ⌘P/⌘L/⌘O/⌘, — direct nav (legacy)
  //   g <letter>  — Linear-style chord nav (g p / g l / g o / g c …)
  // All shortcuts are skipped when focus is in an input/textarea/
  // contenteditable so they don't hijack typing.
  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false
      const tag = target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
      if (target.isContentEditable) return true
      return false
    }
    const legacyDirect: Record<string, string> = {
      p: '/products',
      l: '/listings',
      o: '/orders',
      ',': '/settings/account',
    }
    const cancelChord = () => {
      chordLeader.current = null
      if (chordTimer.current) {
        window.clearTimeout(chordTimer.current)
        chordTimer.current = null
      }
    }
    const onKey = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey
      const k = e.key.toLowerCase()

      // ⌘K — toggle palette
      if (isMod && k === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
        cancelChord()
        return
      }

      // Escape — close whichever overlay is open. Don't preventDefault
      // when nothing's open so global Esc behaviour (e.g. closing a
      // browser dialog) keeps working.
      if (e.key === 'Escape') {
        if (open) {
          setOpen(false)
          return
        }
        if (helpOpen) {
          setHelpOpen(false)
          return
        }
      }

      // ⌘P/⌘L/⌘O/⌘, — legacy modifier nav. Cmd+P would normally print;
      // we eat it here for power-user nav. Skip when typing.
      if (isMod && !open && !isTypingTarget(e.target)) {
        const dest = legacyDirect[k] ?? legacyDirect[e.key]
        if (dest) {
          e.preventDefault()
          router.push(dest)
          cancelChord()
          return
        }
      }

      // From this point on, we only handle modifier-less keypresses
      // and skip when typing or when the palette is open (the palette
      // owns its own arrow/Enter handlers).
      if (isMod || open || helpOpen || isTypingTarget(e.target)) return

      // ? — open the shortcut help overlay. e.key is '?' on most
      // layouts when shift+/ is pressed.
      if (e.key === '?') {
        e.preventDefault()
        setHelpOpen(true)
        cancelChord()
        return
      }

      // / — focus the active page's primary search input. Pages can
      // listen for this event and call inputRef.current?.focus().
      if (e.key === '/') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('nexus:focus-search'))
        cancelChord()
        return
      }

      // Chord state machine.
      if (chordLeader.current) {
        // We're mid-chord; this key is the second half.
        const chord = `${chordLeader.current} ${k}`
        cancelChord()
        const dest = CHORD_TO_HREF[chord]
        if (dest) {
          e.preventDefault()
          router.push(dest)
        }
        return
      }
      // Leader keys we recognise. 'g' is the only one today; adding
      // 'a' / 'c' / 'd' style leaders later is one entry away.
      if (k === 'g') {
        e.preventDefault()
        chordLeader.current = 'g'
        chordTimer.current = window.setTimeout(cancelChord, CHORD_TIMEOUT_MS)
        return
      }
    }
    const onOpenEvent = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('nexus:open-command-palette', onOpenEvent)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('nexus:open-command-palette', onOpenEvent)
      cancelChord()
    }
  }, [open, helpOpen, router])

  // Reset query + focus input each time we open
  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIdx(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const filtered = query.trim()
    ? COMMANDS.filter((c) => c.label.toLowerCase().includes(query.toLowerCase()))
    : COMMANDS

  // Group filtered list
  const grouped: Record<string, Command[]> = {}
  for (const cmd of filtered) {
    ;(grouped[cmd.group] ??= []).push(cmd)
  }

  // Flat list (matches keyboard navigation order)
  const flat = filtered

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => Math.min(i + 1, flat.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = flat[activeIdx]
      if (cmd) {
        router.push(cmd.href)
        setOpen(false)
      }
    }
  }

  // Help can be opened independently of the palette (via `?`), so we
  // can't return null until BOTH overlays are closed.
  if (!open && !helpOpen) return null

  if (!open && helpOpen) {
    return <ShortcutHelp onClose={() => setHelpOpen(false)} />
  }

  return (
    <div
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-[1px] z-50 flex items-start justify-center pt-[15vh]"
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div
        className="bg-white rounded-lg shadow-2xl w-[600px] max-w-[90vw] overflow-hidden border border-slate-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200">
          <Search className="w-4 h-4 text-slate-400" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActiveIdx(0)
            }}
            onKeyDown={onKeyDown}
            placeholder="Type a command or search…"
            className="flex-1 bg-transparent text-[14px] text-slate-900 placeholder:text-slate-400 outline-none"
          />
          <kbd className="text-[10px] bg-slate-100 px-1.5 py-0.5 rounded text-slate-500 font-mono">
            ESC
          </kbd>
        </div>

        <div className="max-h-[400px] overflow-y-auto p-2">
          {flat.length === 0 ? (
            <div className="text-center text-[13px] text-slate-500 py-8">
              No commands found
            </div>
          ) : (
            Object.entries(grouped).map(([group, cmds]) => (
              <div key={group} className="mb-1 last:mb-0">
                <div className="px-3 pt-2 pb-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                  {group}
                </div>
                {cmds.map((cmd) => {
                  const flatIdx = flat.indexOf(cmd)
                  const isActive = flatIdx === activeIdx
                  const Icon = cmd.icon
                  return (
                    <button
                      key={cmd.id}
                      type="button"
                      onMouseEnter={() => setActiveIdx(flatIdx)}
                      onClick={() => {
                        router.push(cmd.href)
                        setOpen(false)
                      }}
                      className={cn(
                        'w-full flex items-center gap-3 px-3 py-2 rounded-md text-[13px] text-left transition-colors',
                        isActive
                          ? 'bg-blue-50 text-blue-700'
                          : 'text-slate-700 hover:bg-slate-50'
                      )}
                    >
                      <Icon
                        className={cn(
                          'w-4 h-4 flex-shrink-0',
                          isActive ? 'text-blue-600' : 'text-slate-400'
                        )}
                      />
                      <span className="flex-1 truncate">{cmd.label}</span>
                      {cmd.chord && (
                        <kbd
                          className={cn(
                            'text-[10px] font-mono px-1.5 py-0.5 rounded',
                            isActive
                              ? 'bg-blue-100 text-blue-700'
                              : 'bg-slate-100 text-slate-500',
                          )}
                        >
                          {cmd.chord}
                        </kbd>
                      )}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>

        <div className="border-t border-slate-100 px-3 py-1.5 text-[10px] text-slate-400 flex items-center justify-between gap-2">
          <span>↑↓ navigate · ↵ open</span>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              setHelpOpen(true)
            }}
            className="hover:text-slate-700 inline-flex items-center gap-1"
          >
            <Keyboard className="w-3 h-3" />
            Shortcuts
          </button>
        </div>
      </div>
      {helpOpen && <ShortcutHelp onClose={() => setHelpOpen(false)} />}
    </div>
  )
}

/**
 * Shortcut help overlay. Surfaced via `?` (anywhere) or the
 * "Shortcuts" link in the command palette footer. Keeps the chord
 * registry as the source of truth so a new entry shows up here
 * automatically.
 */
function ShortcutHelp({ onClose }: { onClose: () => void }) {
  // Esc closes when the palette isn't also open. The palette's
  // global handler covers the case when both are open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const navChords = COMMANDS.filter((c) => c.chord)
  const generalShortcuts: Array<{ keys: string; label: string }> = [
    { keys: '⌘ K', label: 'Open command palette' },
    { keys: '?', label: 'Show this help' },
    { keys: '/', label: 'Focus the page search' },
    { keys: 'Esc', label: 'Close any overlay' },
  ]

  return (
    <div
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-[1px] z-[60] flex items-start justify-center pt-[12vh]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div
        className="bg-white rounded-lg shadow-2xl w-[560px] max-w-[90vw] overflow-hidden border border-slate-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <Keyboard className="w-4 h-4 text-slate-500" />
            <h2 className="text-[14px] font-semibold text-slate-900">
              Keyboard shortcuts
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 p-0.5"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto">
          <section>
            <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2">
              General
            </div>
            <ul className="space-y-1.5">
              {generalShortcuts.map((s) => (
                <li
                  key={s.keys}
                  className="flex items-center justify-between text-[13px] text-slate-700"
                >
                  <span>{s.label}</span>
                  <kbd className="text-[10px] font-mono bg-slate-100 px-1.5 py-0.5 rounded text-slate-500">
                    {s.keys}
                  </kbd>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2">
              Navigation (chord — press {'g'} then …)
            </div>
            <ul className="space-y-1.5">
              {navChords.map((cmd) => (
                <li
                  key={cmd.id}
                  className="flex items-center justify-between text-[13px] text-slate-700"
                >
                  <span>{cmd.label}</span>
                  <kbd className="text-[10px] font-mono bg-slate-100 px-1.5 py-0.5 rounded text-slate-500">
                    {cmd.chord}
                  </kbd>
                </li>
              ))}
            </ul>
          </section>

          <p className="text-[11px] text-slate-500 leading-relaxed">
            Shortcuts are skipped while you&rsquo;re typing in a field. The
            command palette also accepts ⌘ P / ⌘ L / ⌘ O / ⌘ , as direct
            navigation (legacy).
          </p>
        </div>
      </div>
    </div>
  )
}
