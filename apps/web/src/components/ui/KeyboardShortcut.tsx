'use client'

/**
 * U.2 — KeyboardShortcut primitive.
 *
 * Renders shortcut keys in the standard kbd-chip style used by
 * Linear / Notion / Stripe. Replaces the 9 hand-rolled <kbd> uses
 * in the existing CommandPalette help overlay and unblocks
 * surfacing shortcuts in tooltips, menus, and inline help text
 * without inconsistent styling.
 *
 * Accepts either:
 *   - keys: string[] — array of separate keys ("Cmd", "K") rendered
 *     as individual chips with a "+" between them
 *   - chord: string — single chord notation ("g p") rendered as
 *     "g" + "then" + "p" (Linear style)
 *   - Single string children — "Esc" rendered as one chip
 *
 * Auto-translates platform-modifier names:
 *   "Cmd"  → ⌘ on Mac, Ctrl on others (heuristic via navigator.platform)
 *   "Alt"  → ⌥ on Mac, Alt on others
 *   "Shift" → ⇧ on Mac, Shift on others
 *
 * Usage:
 *   <KeyboardShortcut keys={["Cmd", "K"]} />        →  ⌘ + K
 *   <KeyboardShortcut chord="g p" />                →  g  then  p
 *   <KeyboardShortcut>Esc</KeyboardShortcut>        →  Esc
 */

import { useEffect, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface KeyboardShortcutProps {
  /** Array of keys to render with "+" separators. */
  keys?: string[]
  /** Linear-style chord notation: "g p" → g then p. */
  chord?: string
  /** Single key fallback when neither keys[] nor chord is set. */
  children?: ReactNode
  size?: 'xs' | 'sm'
  className?: string
}

const MAC_SUBS: Record<string, string> = {
  cmd:   '⌘',
  meta:  '⌘',
  alt:   '⌥',
  option: '⌥',
  shift: '⇧',
  ctrl:  '⌃',
  enter: '⏎',
  return: '⏎',
  esc:   'Esc',
  escape: 'Esc',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  tab: 'Tab',
}

const NON_MAC_SUBS: Record<string, string> = {
  cmd:   'Ctrl',
  meta:  'Ctrl',
  alt:   'Alt',
  option: 'Alt',
  shift: 'Shift',
  ctrl:  'Ctrl',
  enter: 'Enter',
  return: 'Enter',
  esc:   'Esc',
  escape: 'Esc',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  tab: 'Tab',
}

const KEY_CLASS_BY_SIZE = {
  xs: 'text-xs h-4 min-w-[16px] px-1',
  sm: 'text-sm h-5 min-w-[20px] px-1.5',
} as const

function useIsMac() {
  const [isMac, setIsMac] = useState(false)
  useEffect(() => {
    if (typeof navigator === 'undefined') return
    setIsMac(/Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent))
  }, [])
  return isMac
}

function translateKey(raw: string, isMac: boolean): string {
  const k = raw.toLowerCase()
  const subs = isMac ? MAC_SUBS : NON_MAC_SUBS
  return subs[k] ?? raw
}

function Key({ k, size }: { k: string; size: 'xs' | 'sm' }) {
  return (
    <kbd
      className={cn(
        'inline-flex items-center justify-center font-mono font-medium',
        'bg-slate-100 text-slate-600 border border-slate-200 rounded',
        KEY_CLASS_BY_SIZE[size],
      )}
    >
      {k}
    </kbd>
  )
}

export function KeyboardShortcut({
  keys,
  chord,
  children,
  size = 'sm',
  className,
}: KeyboardShortcutProps) {
  const isMac = useIsMac()

  // Chord — "g p" → g then p
  if (chord) {
    const parts = chord.split(/\s+/).filter(Boolean)
    return (
      <span
        className={cn('inline-flex items-center gap-1', className)}
        aria-label={`Press ${parts.join(' then ')}`}
      >
        {parts.map((part, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            {i > 0 && <span className="text-xs text-slate-400">then</span>}
            <Key k={translateKey(part, isMac)} size={size} />
          </span>
        ))}
      </span>
    )
  }

  // Multi-key — "Cmd + K" rendered with "+" separators
  if (keys && keys.length > 0) {
    return (
      <span
        className={cn('inline-flex items-center gap-0.5', className)}
        aria-label={`Press ${keys.join(' plus ')}`}
      >
        {keys.map((k, i) => (
          <span key={i} className="inline-flex items-center gap-0.5">
            {i > 0 && <span className="text-xs text-slate-400">+</span>}
            <Key k={translateKey(k, isMac)} size={size} />
          </span>
        ))}
      </span>
    )
  }

  // Single key fallback — children rendered as one chip
  if (children != null) {
    return (
      <span className={className}>
        <Key k={String(children)} size={size} />
      </span>
    )
  }

  return null
}
