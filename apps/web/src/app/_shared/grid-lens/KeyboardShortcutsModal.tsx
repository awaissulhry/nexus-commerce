'use client'

import { useState } from 'react'
import { Keyboard, X } from 'lucide-react'

export interface ShortcutRow {
  /** One or more key chips ("Cmd", "K") rendered side-by-side. */
  keys: ReadonlyArray<string>
  /** Plain-English description of what the shortcut does. */
  label: string
}

export interface ShortcutGroup {
  title: string
  rows: ReadonlyArray<ShortcutRow>
}

export interface KeyboardShortcutsModalProps {
  groups: ReadonlyArray<ShortcutGroup>
  onClose: () => void
  /**
   * Optional footer text shown under the groups. Defaults to a tip
   * about input-focus pausing shortcuts.
   */
  footer?: React.ReactNode
}

const DEFAULT_FOOTER = (
  <>
    Tip: shortcuts pause while typing in inputs. Press{' '}
    <kbd className="font-mono px-1 py-0.5 bg-slate-50 dark:bg-slate-950 border border-default dark:border-slate-700 rounded text-slate-700 dark:text-slate-300">Esc</kbd>{' '}
    to leave a search/filter field, then keys work again.
  </>
)

/**
 * Shared keyboard-shortcuts modal. Grouped (Navigation / On row /
 * Filter / Help), two-column layout on wider screens, dark-mode
 * styling. Pages pass their own group registry — same chrome,
 * page-specific content.
 */
export function KeyboardShortcutsModal({ groups, onClose, footer }: KeyboardShortcutsModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/40 dark:bg-slate-950/60 backdrop-blur-sm grid place-items-center p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div
        className="bg-white dark:bg-slate-900 rounded-lg shadow-xl max-w-2xl w-full max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-default dark:border-slate-800 px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-lg font-semibold text-slate-900 dark:text-slate-100">
            <Keyboard size={16} className="text-slate-500 dark:text-slate-400" />
            Keyboard shortcuts
          </div>
          <button
            onClick={onClose}
            className="h-7 w-7 grid place-items-center text-tertiary dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>
        <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-5">
          {groups.map((g) => (
            <div key={g.title} className="space-y-2">
              <div className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400">
                {g.title}
              </div>
              <div className="space-y-1.5">
                {g.rows.map((r, i) => (
                  <div key={i} className="flex items-center justify-between gap-3 text-base">
                    <span className="text-slate-700 dark:text-slate-300">{r.label}</span>
                    <span className="flex items-center gap-1">
                      {r.keys.map((k, j) => (
                        <kbd
                          key={j}
                          className="font-mono text-xs px-1.5 py-0.5 bg-slate-50 dark:bg-slate-950 border border-default dark:border-slate-700 rounded shadow-[0_1px_0_0_rgb(226_232_240)] dark:shadow-[0_1px_0_0_rgb(15_23_42)] min-w-[20px] text-center text-slate-700 dark:text-slate-300"
                        >
                          {k}
                        </kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="border-t border-default dark:border-slate-800 px-5 py-3 text-sm text-slate-500 dark:text-slate-400">
          {footer ?? DEFAULT_FOOTER}
        </div>
      </div>
    </div>
  )
}

export interface KeyboardShortcutsButtonProps {
  groups: ReadonlyArray<ShortcutGroup>
  footer?: React.ReactNode
}

/**
 * Combined button + modal. Drop into any workspace header; clicking
 * the keyboard icon opens the modal. Pages that need to open the
 * modal programmatically (e.g. via `?` keypress) should manage the
 * open state themselves and render <KeyboardShortcutsModal/> instead.
 */
export function KeyboardShortcutsButton({ groups, footer }: KeyboardShortcutsButtonProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="h-8 w-8 inline-flex items-center justify-center border border-default dark:border-slate-700 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400"
        title="Keyboard shortcuts (?)"
        aria-label="Keyboard shortcuts"
      >
        <Keyboard size={12} />
      </button>
      {open && <KeyboardShortcutsModal groups={groups} onClose={() => setOpen(false)} footer={footer} />}
    </>
  )
}
