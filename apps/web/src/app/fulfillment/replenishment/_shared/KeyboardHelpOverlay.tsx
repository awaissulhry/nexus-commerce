'use client'

/**
 * W9.6l — Keyboard shortcuts overlay.
 *
 * Extracted from ReplenishmentWorkspace.tsx. Modal-style with
 * click-backdrop dismiss; Esc handling lives in the parent's global
 * keydown listener. Shown when the user presses ? or clicks the
 * keyboard hint button.
 *
 * Adds dark-mode classes throughout (backdrop, panel surface,
 * dividers, kbd chip styling, header + footer text).
 */

import { Keyboard, X } from 'lucide-react'

export function KeyboardHelpOverlay({ onClose }: { onClose: () => void }) {
  const groups: { title: string; rows: { keys: string[]; label: string }[] }[] = [
    {
      title: 'Navigation',
      rows: [
        { keys: ['j', '↓'], label: 'Move focus down' },
        { keys: ['k', '↑'], label: 'Move focus up' },
        { keys: ['g'], label: 'Jump to top' },
        { keys: ['G'], label: 'Jump to bottom' },
        { keys: ['Esc'], label: 'Close drawer · clear selection · clear focus' },
      ],
    },
    {
      title: 'On focused row',
      rows: [
        { keys: ['Enter'], label: 'Open detail drawer' },
        { keys: ['x', 'Space'], label: 'Toggle selection' },
        { keys: ['p'], label: 'Draft single PO' },
        { keys: ['d'], label: 'Dismiss recommendation' },
      ],
    },
    {
      title: 'Filter / search',
      rows: [
        { keys: ['1'], label: 'Filter: Critical' },
        { keys: ['2'], label: 'Filter: High' },
        { keys: ['3'], label: 'Filter: Medium' },
        { keys: ['0'], label: 'Filter: All' },
        { keys: ['/'], label: 'Focus search' },
        { keys: ['r'], label: 'Refresh data' },
      ],
    },
    {
      title: 'Help',
      rows: [{ keys: ['?'], label: 'Toggle this overlay' }],
    },
  ]
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
        <div className="border-b border-slate-200 dark:border-slate-800 px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-lg font-semibold text-slate-900 dark:text-slate-100">
            <Keyboard size={16} className="text-slate-500 dark:text-slate-400" />
            Keyboard shortcuts
          </div>
          <button
            onClick={onClose}
            className="h-7 w-7 grid place-items-center text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
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
                  <div
                    key={i}
                    className="flex items-center justify-between gap-3 text-base"
                  >
                    <span className="text-slate-700 dark:text-slate-300">
                      {r.label}
                    </span>
                    <span className="flex items-center gap-1">
                      {r.keys.map((k, j) => (
                        <kbd
                          key={j}
                          className="font-mono text-xs px-1.5 py-0.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded shadow-[0_1px_0_0_rgb(226_232_240)] dark:shadow-[0_1px_0_0_rgb(15_23_42)] min-w-[20px] text-center text-slate-700 dark:text-slate-300"
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
        <div className="border-t border-slate-200 dark:border-slate-800 px-5 py-3 text-sm text-slate-500 dark:text-slate-400">
          Tip: shortcuts pause while typing in inputs. Press{' '}
          <kbd className="font-mono px-1 py-0.5 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded text-slate-700 dark:text-slate-300">
            Esc
          </kbd>{' '}
          to leave a search/filter field, then keys work again.
        </div>
      </div>
    </div>
  )
}
