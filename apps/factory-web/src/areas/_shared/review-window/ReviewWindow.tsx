'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { NotebookPen } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { windowLayout } from './model'
import './review-window.css'

export const REVIEW_WINDOW_NS = 'review-window'

/**
 * B-TH-271 (threads plan PL6, picture 40): the thread inside a review window or a list's detail window — the window's content and,
 * on its right at 3 : 2 (~40 % of the 1160 px window, ~458 px), the record's own thread docked (the office's OfficeRecordThread
 * docked, or a design case's), sticky while the content scrolls, the feed scrolling inside it and the box at its foot. Under 800 px
 * of screen (the window then fills it; a phone's full-screen sheet) the thread follows the content.
 *
 * An EMPTY OFFICE-ONLY thread (notes only: no party, nothing written yet) folds to a slim "Add a note" column, so a window with
 * nothing to read keeps its room for its content; "Add a note" opens it at its width with the box ready. The thread stays mounted
 * while folded (it tells whether it is still empty). A thread with a party (a reminder's customer) never folds: its answer must be
 * seen. Without a thread (no threads.read) the window is its content alone.
 */
export function ReviewWindow(props: { thread: ReactNode | null; threadLabel: string; notesOnly?: boolean; empty?: boolean; recordKey: string; children: ReactNode }) {
  return (
    <WithMessages namespaces={[REVIEW_WINDOW_NS]}>
      <Window {...props} />
    </WithMessages>
  )
}

function Window({ thread, threadLabel, notesOnly = false, empty = false, recordKey, children }: { thread: ReactNode | null; threadLabel: string; notesOnly?: boolean; empty?: boolean; recordKey: string; children: ReactNode }) {
  const t = useT(REVIEW_WINDOW_NS)
  const [opened, setOpened] = useState(false)
  const aside = useRef<HTMLElement>(null)
  // Another record in the same window (J / K): folded again until its own thread says otherwise.
  useEffect(() => setOpened(false), [recordKey])
  const layout = windowLayout({ hasThread: thread !== null && thread !== undefined, notesOnly, empty, opened })

  const open = () => {
    setOpened(true)
    // The box ready for the note (the thread's own composer, once it shows).
    requestAnimationFrame(() => aside.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus())
  }

  if (layout === 'alone') return <div className="fw-rw">{children}</div>
  return (
    <div className={`fw-rw has-thread${layout === 'folded' ? ' is-folded' : ''}`} data-layout={layout}>
      <div className="fw-rw-body">{children}</div>
      <aside ref={aside} className="fw-rw-thread" aria-label={threadLabel}>
        {layout === 'folded' && (
          <div className="fw-rw-fold">
            <Button size="sm" onClick={open}>
              <NotebookPen size={14} aria-hidden /> {t('addNote')}
            </Button>
            <p className="fw-rw-fold-hint">{t('foldedHint')}</p>
          </div>
        )}
        <div className="fw-rw-thread-inner" hidden={layout === 'folded'}>
          {thread}
        </div>
      </aside>
    </div>
  )
}
