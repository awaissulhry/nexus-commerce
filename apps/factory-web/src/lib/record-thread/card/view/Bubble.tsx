import type { ReactNode } from 'react'
import { toneClass, type SenderTone } from '../../parts/tones'
import '../card.css'

/**
 * tw- W1.2 (THE THREAD REBUILD; 10-design §2 "The bubble — every size"; 13-backend §3.1): the NARROW chat bubble — the shell every
 * thread draws, and the one a portal thread may reuse later (tw-p): on its side, as wide as its words (at most
 * `min(L − 64px, max(65 % of L, 340px))` of the list `L`, words at most 72 characters a line), corners 7, a tail on the first bubble of
 * a run, the sender's name in their own colour on a run's first bubble of someone else ("Lia Modello  Brand Alpha" when the sender is
 * of another company: P3), the menu arrow inside the top-right corner on hover and on keyboard focus. Its model has NO audience,
 * note, author id or office field (PR-15's type wall, kept by the type): an office note's yellow comes from the office card around
 * it (MessageCard), never from the bubble. The content — top blocks, files, words, lines and the foot — is its children.
 */
export interface BubbleModel {
  /** Mine (the reader wrote it): on the right, no tile, no name. Everyone else on the left. */
  readonly side: 'mine' | 'others'
  /** Its place in the run: the tail on the first bubble. */
  readonly run: { readonly first: boolean; readonly last: boolean }
  /** The name line: the person, and their company when it is not the reader's own; absent: no line. */
  readonly name?: { readonly text: string; readonly org?: string | null } | null
  /** The sender's ONE colour (parts/tones); slate without a key. */
  readonly senderTone?: SenderTone
}

export function Bubble({ model, tools, children }: { model: BubbleModel; tools?: ReactNode; children?: ReactNode }) {
  const cls = ['fw-rt-bub', `is-${model.side}`, model.run.first ? 'is-tail' : ''].filter(Boolean).join(' ')
  return (
    <div className={cls}>
      {model.name && (
        <p className={`fw-rt-name ${toneClass(model.senderTone ?? 'slate')}`}>
          <span className="fw-rt-name-who">{model.name.text}</span>
          {model.name.org ? <span className="fw-rt-name-org">{model.name.org}</span> : null}
        </p>
      )}
      {children}
      {tools ? <div className="fw-rt-tools">{tools}</div> : null}
    </div>
  )
}

/**
 * The foot: the small icons and the time at the end of the last line (it floats there when the line has room and drops to a line of
 * its own when it is full, as WhatsApp's does). Every icon carries its honest word as a tooltip and for screen readers (R17).
 */
export function BubbleFoot({ children }: { children: ReactNode }) {
  return <span className="fw-rt-meta">{children}</span>
}
