'use client'

import type { KeyboardEvent, ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { escCloses } from './model'
import './split-pane.css'

export interface SplitPaneProps {
  /** The list (Incoming's rows). */
  list: ReactNode
  /** The record the list opened; null: the list alone. */
  pane: ReactNode | null
  /** The host's words (this part has no catalogue of its own). */
  labels: { pane: string; close: string }
  /** Close the pane: Esc inside it, and the way back on a narrow screen. */
  onClose?: () => void
}

/**
 * SplitPane (B-TH-212): the list and its open record side by side from 1024 px (35 : 65), one at a time below with a way back. Esc
 * inside the pane closes it (not while typing, not in a dialog). The pane is a named region; it scrolls on its own.
 */
export function SplitPane({ list, pane, labels, onClose }: SplitPaneProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || !onClose) return
    const target = event.target as HTMLElement
    if (!escCloses({ tagName: target.tagName, isContentEditable: target.isContentEditable, inDialog: Boolean(target.closest('[role="dialog"], [role="menu"], [role="listbox"]')) })) return
    event.preventDefault()
    onClose()
  }
  return (
    <div className={`fw-split${pane ? ' is-open' : ''}`}>
      <div className="fw-split-list">{list}</div>
      {pane && (
        <section className="fw-split-pane" aria-label={labels.pane} onKeyDown={onKeyDown}>
          {onClose && (
            <div className="fw-split-back">
              <Button size="sm" variant="quiet" onClick={onClose}>
                <ArrowLeft size={14} aria-hidden /> {labels.close}
              </Button>
            </div>
          )}
          <div className="fw-split-body">{pane}</div>
        </section>
      )}
    </div>
  )
}
