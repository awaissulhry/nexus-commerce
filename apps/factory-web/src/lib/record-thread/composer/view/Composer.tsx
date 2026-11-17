'use client'

import { useEffect, useId, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Ban, CornerDownRight, Euro, Globe, Lock, Mail, Paperclip, PencilLine, Ruler, UserPlus, X } from 'lucide-react'
import { Button, Checkbox, SegmentedControl } from '@nexus/ui/primitives'
import { MentionButton, MentionInput, type MentionInputHandle } from '../../helpers/view/MentionInput'
import { useLocale, useT } from '../../../i18n/provider'
import { shortDateOf, dayOf, timeOf } from '../../parts/time'
// B-TH-236: the amount field (B-TH-049) beside the box, price readers only.
import { amountOffered, AMOUNT_CURRENCIES } from '../../helpers/amount'
import { AmountField } from '../../helpers/view/AmountField'
import {
  floorLocked,
  toCustomer,
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
  /** A line in the foot: "Draft kept on this device · saved 10:42" (TH-1c's DraftLine). */
  hint?: ReactNode
  /** B-TH-300: the helpers beside the @ button (Saved replies ▾, TH-1c's B-TH-208). */
  helpers?: ReactNode
  /** B-TH-283 (B-TH-083): files dropped on the box's "measurement sheet" side go up ticked as measurement sheets. */
  onSheets?: (files: File[]) => void
}

/** The icon of each audience: the lock for an Office note, the mail for a reply, the globe for the portal (B-TH-237). */
const MODE_ICON = { note: Lock, reply: Mail, portal: Globe } as const

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
  const heldId = useId()
  const boxRef = useRef<HTMLDivElement>(null)
  const mention = useRef<MentionInputHandle>(null)
  const textArea = () => boxRef.current?.querySelector<HTMLTextAreaElement>('textarea') ?? null
  const [dragging, setDragging] = useState(false)
  // B-TH-283: which side of the box a drag is over (the right side files them as measurement sheets).
  const [dropSide, setDropSide] = useState<'files' | 'sheets'>('files')
  const [announce, setAnnounce] = useState('')
  const lastMode = useRef(draft.mode)

  const state = boxState(context)
  const modes = composerModes(context)
  const party = audienceName(context)
  const prospect = !context.party && context.prospect ? context.prospect : null
  const ModeIcon = MODE_ICON[draft.mode]
  const mentionMode = draft.mode === 'note' ? 'note' : 'reply'
  const held = heldReason(draft, context, { sending, hasFiles: props.hasFiles })
  const heldText = held ? t(held.key, held.params) : (props.extraHeld ?? null)
  const length = [...draft.body].length

  // The box grows with the text up to about 40 % of the thread's column, then scrolls inside (T5-F01).
  useLayoutEffect(() => {
    const area = textArea()
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
    setAnnounce(t(`live.${draft.mode}`, { party }))
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
    mention.current?.focus()
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
  const sheetSide = (event: DragEvent<HTMLDivElement>): 'files' | 'sheets' => {
    if (!props.onSheets) return 'files'
    const box = event.currentTarget.getBoundingClientRect()
    return box.width > 0 && event.clientX > box.left + box.width * 0.6 ? 'sheets' : 'files'
  }
  const onDrag = (event: DragEvent<HTMLDivElement>, on: boolean) => {
    if (!takesFiles || !event.dataTransfer?.types.includes('Files')) return
    event.preventDefault()
    setDragging(on)
    setDropSide(sheetSide(event))
  }
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!takesFiles) return
    event.preventDefault()
    setDragging(false)
    const files = [...(event.dataTransfer?.files ?? [])]
    if (files.length === 0) return
    if (sheetSide(event) === 'sheets' && props.onSheets) props.onSheets(files)
    else props.onFiles?.(files)
  }
  // B-TH-236: what the message answers or corrects, said above the box with × to let it go.
  const link = draft.link ?? null
  const dropLink = () => {
    const { link: _link, ...rest } = draft
    void _link
    props.onDraft(rest, notes)
  }
  const amount = amountOffered(draft.mode, context.can.price)
  const lockedFloor = floorLocked(draft)

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
            options={modes.map((mode) => {
              const Icon = MODE_ICON[mode]
              const label = mode === 'note' ? t('mode.note') : mode === 'portal' ? t('mode.portal', { party }) : t(prospect ? 'mode.replyProspect' : 'mode.reply', { party })
              return { value: mode, label, icon: <Icon size={13} aria-hidden /> }
            })}
          />
        </div>
      )}

      {draft.mode === 'reply' && props.recipients}

      {link && (
        <p className="fw-rt-cx-link">
          {link.kind === 'reply' ? <CornerDownRight size={13} aria-hidden /> : <PencilLine size={13} aria-hidden />}
          <span>
            {link.kind === 'reply'
              ? t('link.replying', { who: link.who ?? t('link.someone'), when: shortDateOf(link.at, locale, dayOf(props.now ?? new Date().toISOString())) })
              : t(`link.correcting.${link.way ?? draft.mode}`, { time: timeOf(link.at, locale), party })}
          </span>
          <Button size="sm" variant="quiet" aria-label={t(link.kind === 'reply' ? 'link.dropReply' : 'link.dropCorrect')} onClick={dropLink}>
            <X size={13} aria-hidden />
          </Button>
        </p>
      )}

      <div
        ref={boxRef}
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
          <ModeIcon size={13} aria-hidden />
          <span>{t(`mark.${draft.mode}`, { party })}</span>
        </p>
        <MentionInput
          ref={mention}
          className="fw-rt-cx-text"
          value={draft.body}
          onChange={(body) => change({ body })}
          people={context.people}
          mode={mentionMode}
          label={t(`mode.${draft.mode}`, { party })}
          rows={2}
          honourRows
          placeholder={t(`placeholder.${draft.mode}`, { party })}
          aria-describedby={heldText ? heldId : undefined}
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
        {dragging && !props.onSheets && (
          <div className="fw-rt-cx-drop" aria-hidden="true">
            <Paperclip size={18} aria-hidden />
            {t(`drop.${draft.mode}`, { party })}
          </div>
        )}
        {dragging && props.onSheets && (
          <div className="fw-rt-cx-drop is-split" aria-hidden="true">
            <span className={dropSide === 'files' ? 'is-on' : ''}>
              <Paperclip size={18} aria-hidden />
              {t(`drop.${draft.mode}`, { party })}
            </span>
            <span className={dropSide === 'sheets' ? 'is-on' : ''}>
              <Ruler size={18} aria-hidden />
              {t('drop.sheets')}
            </span>
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
      {draft.mode === 'portal' && <p className="fw-rt-cx-line">{t('portal.line', { party })}</p>}
      {amount && draft.amount !== undefined && (
        <AmountField
          value={draft.amount}
          currency={draft.currency ?? AMOUNT_CURRENCIES[0]}
          forFloor={draft.forFloor}
          onChange={(next) => change({ amount: next.amount, currency: next.currency })}
          onRemove={() => {
            const { amount: _amount, currency: _currency, ...rest } = draft
            void _amount
            void _currency
            props.onDraft(rest, notes)
          }}
        />
      )}
      {toCustomer(draft.mode) && prospect && (
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
          <Checkbox label={t('floor.label')} checked={draft.forFloor || lockedFloor} disabled={lockedFloor} onChange={(event) => change({ forFloor: event.target.checked })} />
          <p className="fw-rt-cx-line">
            {draft.forFloor || lockedFloor ? t('floor.on', { record: context.recordLabel, limit: FLOOR_TEXT }) : t('floor.off')}
            {lockedFloor ? ` ${t('floor.locked')}` : ''}
            {floorTooLong(draft) ? ` ${t('floor.long', { limit: FLOOR_TEXT })}` : ''}
          </p>
        </div>
      )}

      <div className="fw-rt-cx-foot">
        {props.clip}
        {draft.mode === 'note' && context.people.length > 0 && <MentionButton onClick={() => mention.current?.startMention()} />}
        {props.helpers}
        {amount && draft.amount === undefined && (
          <Button size="sm" variant="quiet" onClick={() => change({ amount: '', currency: draft.currency ?? AMOUNT_CURRENCIES[0] })}>
            <Euro size={13} aria-hidden /> {t('amount.add')}
          </Button>
        )}
        {props.hint}
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
