'use client'

import { useState } from 'react'
import { Keyboard } from 'lucide-react'
import { Modal } from '@/design-system/components/Modal'
import { Kbd } from '@/design-system/primitives/Kbd'

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
    Tip: shortcuts pause while typing in inputs. Press <Kbd>Esc</Kbd> to leave a search/filter field, then keys work again.
  </>
)

/**
 * Shared keyboard-shortcuts modal. Grouped (Navigation / On row /
 * Filter / Help), two-column layout on wider screens, dark-mode
 * styling. Pages pass their own group registry — same chrome,
 * page-specific content.
 *
 * Uses DS Modal + Kbd primitives for consistent styling and a11y.
 */
export function KeyboardShortcutsModal({ groups, onClose, footer }: KeyboardShortcutsModalProps) {
  const [open, setOpen] = useState(true)

  const handleClose = () => {
    setOpen(false)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={
        <div className="flex items-center gap-2">
          <Keyboard size={16} className="text-slate-500 dark:text-slate-400" />
          Keyboard shortcuts
        </div>
      }
      footer={<div className="text-sm text-slate-500 dark:text-slate-400">{footer ?? DEFAULT_FOOTER}</div>}
      size="lg"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-5">
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
                      <Kbd key={j}>{k}</Kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
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
