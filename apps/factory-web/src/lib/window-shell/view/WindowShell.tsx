'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { Button } from '@nexus/ui/primitives'
import { Modal } from '../../i18n/ds-parts'
import { actHeldOf, windowFootOf, windowKeyOf } from '../model'
import { useWindowWords } from '../words'
import '../room.css'
import '../window-shell.css'

/**
 * owb-b5 (w5.3; design plan § 5zd, § 5s; word table: Cancel · Close) — THE window frame: a centred DS dialog (lib/i18n/ds-parts Modal,
 * its words in the person's language) with the window's name, a body that scrolls, and the foot FIXED at the bottom (the DS footer,
 * outside the scrolling body); on a phone a bottom sheet (`sheet`). The foot: the host's other doors at the left · Cancel (a window that
 * acts) or Close (a window that only shows) · the ONE act last. ⌘ Enter (Ctrl Enter) does the act anywhere in the window while nothing
 * holds it; Escape, the backdrop, the X, the sheet's pull and Cancel / Close are ONE way out (`onClose`). The body is a room
 * (room.css `fwroom`): what is inside follows the window's width, never the screen's. Draws what it is given; fetches nothing.
 * Owner after the base: S2. S3's windows (Print and start the work, Print again, Ship the whole order, Place the scan code, the
 * warehouse leg) are drawn with it.
 */

/** The window's ONE act: the primary, last in the foot. */
export interface WindowAct {
  /** What it says, in the host's words ("Print and start the work", "Ship"). */
  readonly words: string
  readonly onAct: () => void
  /** Why it cannot act now: the button stays, focusable, and says why (the DS held button); null: it acts. */
  readonly held?: string | null
  /** A danger act ("Delete this draft") draws red. */
  readonly danger?: boolean
  /** The act runs: the button says "Working on it…" and holds; ⌘ Enter does nothing. */
  readonly busy?: boolean
}

export interface WindowShellProps {
  readonly open: boolean
  /** The one way out: Cancel / Close, Escape, the backdrop, the X and the phone sheet's pull. */
  readonly onClose: () => void
  /** The window's name ("Print and start the work"), in the host's words. */
  readonly title: ReactNode
  /** One line under the name (the order's number and subject). */
  readonly subtitle?: ReactNode
  /** The window's ONE act; absent or null: a window that only shows (or whose act is done) — its foot says Close. */
  readonly act?: WindowAct | null
  /** The host's other doors, at the foot's left (a quiet "Print again…"). */
  readonly more?: ReactNode
  /** How wide on a PC (the DS sizes: md 560 · lg 660 · xl 920); a phone always gets the bottom sheet. */
  readonly size?: 'md' | 'lg' | 'xl'
  /** Why the window cannot close now (while an act runs): the X, Escape and the backdrop wait and say why. */
  readonly closeHeld?: string | null
  /** The body: it scrolls between the name and the foot. */
  readonly children: ReactNode
}

export function WindowShell({ open, onClose, title, subtitle, act = null, more, size = 'md', closeHeld = null, children }: WindowShellProps) {
  const t = useWindowWords()
  const body = useRef<HTMLDivElement>(null)
  const foot = windowFootOf({ acts: act !== null, more: more !== undefined && more !== null })
  const held = act ? actHeldOf(act, t('busy')) : null

  // ⌘ Enter anywhere in THIS window (its body or its foot) does the act; a window opened over it keeps the key (its own target).
  const latest = useRef({ act, held })
  latest.current = { act, held }
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      const dialog = body.current?.closest('[role="dialog"]')
      if (event.defaultPrevented || !dialog || !(event.target instanceof Node) || !dialog.contains(event.target)) return
      const now = latest.current
      if (windowKeyOf(event, { acts: now.act !== null, held: now.held, busy: now.act?.busy }) !== 'act' || !now.act) return
      event.preventDefault()
      now.act.onAct()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const parts = foot.parts.map((part) => {
    switch (part) {
      case 'more':
        return <span key="more" className="fw-wsh-more">{more}</span>
      case 'grow':
        return <span key="grow" className="grow" />
      case 'leave':
        return (
          <Button key="leave" size="sm" onClick={onClose} heldReason={closeHeld}>
            {t(foot.leave)}
          </Button>
        )
      case 'act':
        return act ? (
          <Button key="act" size="sm" variant={act.danger ? 'danger' : 'primary'} heldReason={held} aria-busy={act.busy || undefined} aria-keyshortcuts="Meta+Enter Control+Enter" onClick={act.onAct}>
            {act.words}
          </Button>
        ) : null
    }
  })

  return (
    <Modal open={open} onClose={onClose} title={title} subtitle={subtitle} size={size} sheet closeHeld={closeHeld} footer={<>{parts}</>}>
      <div ref={body} className="fw-wsh-body">
        {children}
      </div>
    </Modal>
  )
}
