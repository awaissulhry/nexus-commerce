'use client'

import { useEffect, useId, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Ban, Lock, Mail, Paperclip, UserPlus } from 'lucide-react'
import { Button, Checkbox, SegmentedControl } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../i18n/provider'
import { shortDateOf, dayOf } from '../../parts/time'
import {
  audienceName,
  boxState,
  composerModes,
  COUNTER_FROM,
  floorOffered,
  floorTooLong,
  FLOOR_TEXT,
  heldReason,
  MAX_BODY,
  sendKey,
  switchMode,
  type ComposerContext,
  type ComposerDraft,
  type ComposerMode,
  type SwitchNote,
} from '../model'
import '../../parts/parts.css'
import '../composer.css'

export interface ComposerProps {
  context: ComposerContext
  draft: ComposerDraft
  /** Notes from the last switch ("Mentions stay in office notes: …"). */
  notes?: readonly SwitchNote[]
  /** The tray's or the recipients' reason Send waits, in words ("Waiting for 2 files"), or null. */
  extraHeld?: string | null
  /** The draft carries files (a message of files alone may go). */
  hasFiles?: boolean
  sending?: boolean
  /** Reply mode: To, Cc and Subject (B-TH-207). */
  recipients?: ReactNode
  /** The files of the message (B-TH-206). */
  tray?: ReactNode
  /** Lines under the box: an office-only file in a reply, the e-mail limit (B-TH-206). */
  lines?: ReactNode
  /** The paper clip (B-TH-206); without it the box takes no files. */
  clip?: ReactNode
  /** "Now" for the closed line's date (ISO). */
  now?: string
  onDraft: (draft: ComposerDraft, notes: readonly SwitchNote[]) => void
  onSend: () => void
  onReopen?: () => void
  onMakeCustomer?: () => void
  /** Esc in the box: the focus goes back to the feed, the text stays. */
  onEscape?: () => void
  /** Files dropped or pasted on the box. */
  onFiles?: (files: File[]) => void
}

/**
 * The composer (B-TH-205, T5; picture 3): sticky under the feed, ~104 px at rest, growing while typing to about 40 % of the column
 * and then scrolling inside. The audience switch, the box in the audience's colour with its mark, the text, the files, the lines,
 * then the foot with Send naming the audience and, while held, why. ⌘↵ sends; Esc leaves the box with the text kept. Draws its
 * model; the container keeps the draft.
 */
export function Composer(props: ComposerProps) {
  const { context, draft, notes = [], sending = false } = props
  const t = useT('record-thread-composer')
  const locale = useLocale()
  const textId = useId()
  const heldId = useId()
  const text = useRef<HTMLTextAreaElement>(null)
  const [dragging, setDragging] = useState(false)
  const [announce, setAnnounce] = useState('')
  const lastMode = useRef(draft.mode)

  const state = boxState(context)
  const modes = composerModes(context)
  const party = audienceName(context)
  const prospect = !context.party && context.prospect ? context.prospect : null
  const held = heldReason(draft, context, { sending, hasFiles: props.hasFiles })
  const heldText = held ? t(held.key, held.params) : (props.extraHeld ?? null)
  const length = [...draft.body].length

  // The box grows with the text up to about 40 % of the thread's column, then scrolls inside (T5-F01).
  useLayoutEffect(() => {
    const area = text.current
    if (!area) return
    area.style.height = 'auto'
    const column = area.closest<HTMLElement>('.fw-rt-column')?.clientHeight ?? 0
    const max = Math.max(72, column > 0 ? column * 0.4 - 80 : 240)
    area.style.height = `${Math.min(area.scrollHeight, max)}px`
    area.style.overflowY = area.scrollHeight > max ? 'auto' : 'hidden'
  }, [draft.body, draft.mode])

  // The new mode is read out ("Reply to Brand Alpha — Brand Alpha reads this").
  useEffect(() => {
    if (lastMode.current === draft.mode) return
    lastMode.current = draft.mode
    setAnnounce(t(draft.mode === 'note' ? 'live.note' : 'live.reply', { party }))
  }, [draft.mode, party, t])

  if (state === 'closed') {
    const closed = context.closed ?? null
    return (
      <div className="fw-rt-composer">
        <div className="fw-rt-cx-held">
          <Lock size={16} aria-hidden />
          <span>
            {closed?.by && closed.at
              ? t('box.closed', { who: closed.by, date: shortDateOf(closed.at, locale, dayOf(props.now ?? new Date().toISOString())) })
              : t('box.closedPlain')}
          </span>
          {context.can.manage && props.onReopen && (
            <Button size="sm" onClick={props.onReopen}>
              {t('box.reopen')}
            </Button>
          )}
        </div>
      </div>
    )
  }
  if (state === 'noRight') {
    return (
      <div className="fw-rt-composer">
        <div className="fw-rt-cx-held">
          <Ban size={16} aria-hidden />
          <span>{t('box.noRight')}</span>
        </div>
      </div>
    )
  }

  const change = (next: Partial<ComposerDraft>) => props.onDraft({ ...draft, ...next }, notes)
  const setMode = (mode: ComposerMode) => {
    const switched = switchMode(draft, mode, context.people)
    props.onDraft(switched.draft, switched.notes)
    text.current?.focus()
  }

  const send = () => {
    if (heldText) {
      setAnnounce(heldText)
      return
    }
    props.onSend()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      send()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      props.onEscape?.()
    }
  }

  const takesFiles = Boolean(props.onFiles)
  const onDrag = (event: DragEvent<HTMLDivElement>, on: boolean) => {
    if (!takesFiles || !event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    setDragging(on)
  }
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!takesFiles) return
    event.preventDefault()
    setDragging(false)
    const files = [...(event.dataTransfer?.files ?? [])]
    if (files.length > 0) props.onFiles?.(files)
  }

  return (
    <div className="fw-rt-composer" data-mode={draft.mode}>
      {modes.length > 1 && (
        <div className="fw-rt-cx-top">
          <SegmentedControl
            ariaLabel={t('modeLabel')}
            size="sm"
            wrap
            className="fw-rt-cx-seg"
            value={draft.mode}
            onChange={(value) => setMode(value as ComposerMode)}
            options={[
              { value: 'note', label: t('mode.note'), icon: <Lock size={13} aria-hidden /> },
              { value: 'reply', label: t(prospect ? 'mode.replyProspect' : 'mode.reply', { party }), icon: <Mail size={13} aria-hidden /> },
            ]}
          />
        </div>
      )}

      {draft.mode === 'reply' && props.recipients}

      <div
        className={`fw-rt-cx-box${dragging ? ' is-dragging' : ''}`}
        onDragEnter={(event) => onDrag(event, true)}
        onDragOver={(event) => onDrag(event, true)}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
          setDragging(false)
        }}
        onDrop={onDrop}
      >
        <p className="fw-rt-cx-mark">
          {draft.mode === 'note' ? <Lock size={13} aria-hidden /> : <Mail size={13} aria-hidden />}
          <span>{t(draft.mode === 'note' ? 'mark.note' : 'mark.reply', { party })}</span>
        </p>
        <label htmlFor={textId} className="fw-rt-sr">
          {t(draft.mode === 'note' ? 'mode.note' : 'mode.reply', { party })}
        </label>
        <textarea
          ref={text}
          id={textId}
          className="fw-rt-cx-text"
          value={draft.body}
          rows={2}
          maxLength={MAX_BODY + 1000}
          placeholder={t(draft.mode === 'note' ? 'placeholder.note' : 'placeholder.reply', { party })}
          aria-describedby={heldText ? heldId : undefined}
          onChange={(event) => change({ body: event.target.value })}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            if (!takesFiles) return
            const files = [...event.clipboardData.files]
            if (files.length === 0) return
            event.preventDefault()
            props.onFiles?.(files)
          }}
        />
        {props.tray}
        {dragging && (
          <div className="fw-rt-cx-drop" aria-hidden="true">
            <Paperclip size={18} aria-hidden />
            {t(draft.mode === 'note' ? 'drop.note' : 'drop.reply', { party })}
          </div>
        )}
      </div>

      {notes.length > 0 && (
        <div className="fw-rt-cx-notes" role="status">
          {notes.map((note) => (
            <p key={note.key} className="fw-rt-cx-line">
              {t(note.key, note.params)}
            </p>
          ))}
        </div>
      )}
      {draft.mode === 'reply' && prospect && (
        <p className="fw-rt-cx-warn">
          <span>{t('prospect.line', { party: prospect.name })}</span>
          {props.onMakeCustomer && (
            <Button size="sm" onClick={props.onMakeCustomer}>
              <UserPlus size={13} aria-hidden /> {t('prospect.make')}
            </Button>
          )}
        </p>
      )}
      {props.lines}
      {modes.length === 1 && modes[0] === 'note' && !context.party && !context.prospect && <p className="fw-rt-cx-line">{t('box.noParty')}</p>}
      {floorOffered(context, draft.mode) && (
        <div className="fw-rt-cx-floor">
          <Checkbox label={t('floor.label')} checked={draft.forFloor} onChange={(event) => change({ forFloor: event.target.checked })} />
          <p className="fw-rt-cx-line">
            {draft.forFloor ? t('floor.on', { record: context.recordLabel, limit: FLOOR_TEXT }) : t('floor.off')}
            {floorTooLong(draft) ? ` ${t('floor.long', { limit: FLOOR_TEXT })}` : ''}
          </p>
        </div>
      )}

      <div className="fw-rt-cx-foot">
        {props.clip}
        <span className="fw-rt-cx-grow" />
        {length >= COUNTER_FROM && <span className={`fw-rt-cx-count${length > MAX_BODY ? ' is-over' : ''}`}>{t('counter', { count: MAX_BODY - length })}</span>}
        {heldText && (
          <span id={heldId} className="fw-rt-cx-heldtext">
            {heldText}
          </span>
        )}
        <Button size="sm" variant="primary" onClick={send} heldReason={heldText}>
          {t(sendKey(draft.mode), { party })}
        </Button>
      </div>
      <p className="fw-rt-sr" aria-live="polite">
        {announce}
      </p>
    </div>
  )
}
