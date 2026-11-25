'use client'

import { useLayoutEffect, type DOMAttributes, type ReactNode, type Ref, type RefObject } from 'react'
import { SendHorizontal, X } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../i18n/provider'
import { toneClass, type SenderTone } from '../../parts/tones'
import { COUNTER_FROM, MAX_BODY, type ComposerDraft } from '../model'
import '../../parts/parts.css'
import '../composer.css'

/**
 * pt-w1 W1.2 (lane pt-, S3; ONE SHARED THREAD): the composer's ONE row as both doors draw it — at rest one row: the "+" slot · a chip
 * slot · the box · the Send arrow; ONE bar above it (the host's: a hold, the reply, a note); a chips row of its own above the box; the
 * counter near the limit (from COUNTER_FROM to MAX_BODY); the host's lines under it; what a screen reader hears. Closed and read-only
 * are ONE held line (`ComposerHeld`). The office's Composer fills it with its modes, audience chip, mentions, amount, floor, About and
 * recipients; the portal's partner face (pt-w2) with its own box. The box is a SLOT: the office's @ box is a combobox, the
 * partner's DS Textarea stays a textbox. Takes no mode, audience, mention, amount or floor: it draws what the host hands it.
 */
export interface ComposerRowProps {
  /** The root's data attributes (the office's audience: the golden flows read it). */
  readonly data?: Readonly<Record<`data-${string}`, string>>
  /** ONE bar above the box, or nothing. */
  readonly bar?: ReactNode
  /** The email's To · Cc · Subject, one line above the chips. */
  readonly fields?: ReactNode
  /** The chips row (its own row above the box), or nothing. */
  readonly chips?: ReactNode
  /** The "+" at the row's start. */
  readonly plus?: ReactNode
  /** A chip in the row before the box (the office's audience chip at rest). */
  readonly chip?: ReactNode
  readonly box: ComposerBox
  readonly send: { readonly label: string; readonly held: string | null; readonly onSend: () => void }
  /** How many characters the text has: the counter shows from COUNTER_FROM. */
  readonly length: number
  /** The host's lines under the box (after the counter). */
  readonly lines?: ReactNode
  /** What a screen reader hears (polite). */
  readonly announce: string
}

/** The box and what sits in it: the text field (a slot), the helpers inside it, the tray of files, the drop hint while files are over it. */
export interface ComposerBox {
  readonly input: ReactNode
  readonly ref?: Ref<HTMLDivElement> | undefined
  /** Files are dragged over it. */
  readonly dragging?: boolean | undefined
  readonly drag?: Pick<DOMAttributes<HTMLDivElement>, 'onDragEnter' | 'onDragOver' | 'onDragLeave' | 'onDrop'> | undefined
  readonly helpers?: ReactNode
  readonly tray?: ReactNode
  readonly drop?: ReactNode
}

export function ComposerRow({ data, bar, fields, chips, plus, chip, box, send, length, lines, announce }: ComposerRowProps) {
  const t = useT('record-thread-composer')
  return (
    <div className="fw-rt-composer" {...data}>
      {bar}
      {fields}
      {chips}
      <div className="fw-rt-cx-row">
        {plus}
        {chip}
        <div ref={box.ref} className={`fw-rt-cx-box${box.dragging ? ' is-dragging' : ''}`} {...box.drag}>
          {box.input}
          {box.helpers && <span className="fw-rt-cx-helpers">{box.helpers}</span>}
          {box.tray}
          {box.drop}
        </div>
        <Button size="sm" variant="primary" className="fw-rt-cx-send" onClick={send.onSend} heldReason={send.held} aria-label={send.label}>
          <SendHorizontal size={16} aria-hidden />
          <span className="fw-rt-sr">{send.label}</span>
        </Button>
      </div>
      {length >= COUNTER_FROM && <p className={`fw-rt-cx-count${length > MAX_BODY ? ' is-over' : ''}`}>{t('counter', { count: MAX_BODY - length })}</p>}
      {lines}
      <p className="fw-rt-sr" aria-live="polite">
        {announce}
      </p>
    </div>
  )
}

/** Closed, or no right to write: ONE line in place of the box — its icon, its words, what follows them (the office's Reopen). */
export function ComposerHeld({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="fw-rt-composer">
      <div className="fw-rt-cx-held">
        {icon}
        {children}
      </div>
    </div>
  )
}

/** The reply (or the correction) above the box: the quoted person's colour edge, its words, × lets it go. */
export function LinkBar({ tone, label, drop, children }: { tone?: SenderTone | undefined; label?: string | undefined; drop: { readonly label: string; readonly onDrop: () => void }; children: ReactNode }) {
  return (
    <div className={`fw-rt-cx-bar is-link${tone ? ` ${toneClass(tone)}` : ''}`} role="group" aria-label={label}>
      {children}
      <Button size="sm" variant="quiet" className="icon" aria-label={drop.label} onClick={drop.onDrop}>
        <X size={13} aria-hidden />
      </Button>
    </div>
  )
}

/** The reply's words in its bar: who wrote what it answers, and one line of it. */
export function ReplyLine({ who, line }: { who: string; line?: string | undefined }) {
  return (
    <span className="fw-rt-cx-quote">
      <b>{who}</b>
      {line !== undefined && <span>{line}</span>}
    </span>
  )
}

/** A key in the box, as the box's handler gets it (a React keyboard event fits). */
export interface ComposerKeyEvent {
  readonly key: string
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly nativeEvent: { readonly isComposing: boolean }
  preventDefault(): void
}

/**
 * tw- W2.3 (D5, Z3): the box's keys, ONE rule for both doors — Enter sends and Shift+Enter makes a new line (where Enter does not send,
 * only ⌘/Ctrl+Enter: the office's Reply to N, no Undo for N records); never while a word is being composed; Esc goes to the host
 * (it drops the reply bar first); "/" in an empty box opens the host's helpers when it has some. The @ list takes its own Enter first.
 */
export function composerKeys(
  event: ComposerKeyEvent,
  box: { readonly enterSends: boolean; readonly body: string },
  doors: { readonly send: () => void; readonly escape: () => void; readonly slash?: (() => boolean) | undefined },
): void {
  const { enterSends, body } = box
  if (event.key === 'Enter' && !event.shiftKey && !event.altKey && (enterSends || event.metaKey || event.ctrlKey)) {
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    doors.send()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    doors.escape()
  } else if (event.key === '/' && body === '' && doors.slash?.()) {
    event.preventDefault()
  }
}

/**
 * tw- W2.3 (P0-B2): the box grows with the text from one line to about 8 lines, then scrolls inside; its floor is ONE line
 * (composer.css owns the height rule: never 0 px — a measured 0 is never written back). `draft.mode`: the office's audience (its box
 * is drawn again); the partner has none.
 */
export function useBoxGrow(boxRef: RefObject<HTMLDivElement | null>, draft: Pick<ComposerDraft, 'body'> & Partial<Pick<ComposerDraft, 'mode'>>): void {
  const textArea = () => boxRef.current?.querySelector<HTMLTextAreaElement>('textarea') ?? null
  useLayoutEffect(() => {
    const area = textArea()
    if (!area) return
    area.style.height = 'auto'
    const line = Number.parseFloat(getComputedStyle(area).lineHeight) || 20
    const max = Math.round(line * 8 + 12)
    const height = area.scrollHeight
    if (height <= 0) {
      area.style.removeProperty('height')
      return
    }
    area.style.height = `${Math.min(height, max)}px`
    area.style.overflowY = height > max ? 'auto' : 'hidden'
  }, [draft.body, draft.mode])
}
