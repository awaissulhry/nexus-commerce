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
  HeartPulse,
  Plug,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface Command {
  id: string
  label: string
  icon: LucideIcon
  href: string
  group: 'Navigation' | 'Catalog' | 'System'
}

const COMMANDS: Command[] = [
  // Navigation
  { id: 'goto-products', label: 'Go to Products', icon: Package, href: '/inventory', group: 'Navigation' },
  { id: 'goto-listings', label: 'Go to All Listings', icon: Boxes, href: '/listings', group: 'Navigation' },
  { id: 'goto-orders', label: 'Go to Orders', icon: FileText, href: '/orders', group: 'Navigation' },
  { id: 'goto-pricing', label: 'Go to Pricing', icon: Tag, href: '/pricing', group: 'Navigation' },
  { id: 'goto-activity', label: 'Go to Activity Log', icon: Activity, href: '/sync-logs', group: 'Navigation' },
  { id: 'goto-health', label: 'Go to Sync Health', icon: HeartPulse, href: '/dashboard/health', group: 'Navigation' },
  // Catalog actions
  { id: 'pim-review', label: 'Review detected PIM groups', icon: Layers, href: '/pim/review', group: 'Catalog' },
  { id: 'bulk-upload', label: 'Bulk upload products', icon: Upload, href: '/inventory/upload', group: 'Catalog' },
  // System
  { id: 'connections', label: 'Manage channel connections', icon: Plug, href: '/settings/channels', group: 'System' },
  { id: 'settings', label: 'Open Settings', icon: SettingsIcon, href: '/settings/account', group: 'System' },
]

export default function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Open on ⌘K / Ctrl+K, close on Esc, also listen for sidebar's
  // dispatched event so the search icon button works.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'
      if (isCmdK) {
        e.preventDefault()
        setOpen((o) => !o)
      } else if (e.key === 'Escape' && open) {
        setOpen(false)
      }
    }
    const onOpenEvent = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('nexus:open-command-palette', onOpenEvent)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('nexus:open-command-palette', onOpenEvent)
    }
  }, [open])

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

  if (!open) return null

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
                      <span>{cmd.label}</span>
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
