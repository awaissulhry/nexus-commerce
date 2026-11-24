'use client'

import { useEffect, useId, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Ban, ChevronDown, Euro, Globe, HardHat, Link2, Lock, Mail, Paperclip, PencilLine, Plus, Ruler, SendHorizontal, UserPlus, X } from 'lucide-react'
import { Menu, type MenuItemDef } from '@nexus/ui/components'
import { Button, Checkbox, Tooltip } from '@nexus/ui/primitives'
import { MentionInput, type MentionInputHandle } from '../../helpers/view/MentionInput'
import { toneClass } from '../../parts/tones'
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
  enterSends,
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
// F-SA-282a (B-SA-073): the portal's hold of a text that names another customer, and the writer's tick.
import { draftAfter, namesOtherAsked } from '../model'
// F-SA-265 (Discuss): the chip "About: …" in the box's audience words, removable.
import { aboutWords, withoutAbout } from '../model'
// F-CP-147 (B-CP-020): the API held words that look like a price — the box warns (no amount repeated) and Send becomes "Send anyway".
import { namesPriceAsked } from '../model'
import { NAMES_PRICE_SEND, namesPriceWords } from '../../send-check/model'
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
  /** The paper clip (B-TH-206); without it the box takes no files. tw- W2.3: a design case's own "+"; the thread passes `plus`. */
  clip?: ReactNode
  /** tw- W2.3 (10-design §10): the "+" with the files' rows (ClipMenu) and the composer's own rows after them. */
  plus?: (more: readonly MenuItemDef[]) => ReactNode
  /** tw- W2.3: the Follow up chip (B-TH-289) — in the chips row, on a message to the customer. */
  followUp?: ReactNode
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
  /** B-TH-300: Saved replies (TH-1c's B-TH-208) — tw- W2.3: an icon inside the box; "/" in an empty box and "+ › Saved replies" open it. */
  helpers?: ReactNode
  /** B-TH-283 (B-TH-083): files dropped on the box's "measurement sheet" side go up ticked as measurement sheets. */
  onSheets?: (files: File[]) => void
}

/** The icon of each audience: the lock for an Office note, the mail for a reply, the globe for the portal (B-TH-237). */
const MODE_ICON = { note: Lock, reply: Mail, portal: Globe } as const

/**
 * The composer (B-TH-205, T5; tw- W2.3 THE THREAD REBUILD, 10-design §10, S9; P0-B2, D5, Z3): at rest ONE row — "+" (Document · Photos
 * · From this record · Saved replies · Amount · For the floor) · the audience chip (a menu of radio rows: Office note · Reply to X by
 * email · In X's portal) · the box (one line, growing to about 8 lines, never 0 px tall) · the Send arrow (its name says who reads it:
 * `send.*`). The chips (Follow up, Amount, For the floor, About) take a row of their own above; the email's To · Cc · Subject one
 * line above them. ONE bar above at a time: a hold, the reply or the correction, a switch note. Enter sends and Shift+Enter makes a
 * new line — never in Reply to N (⌘/Ctrl+Enter there: no Undo for N records), never while the @ list is open; Esc leaves the box
 * with the text kept. Closed and read-only are one line. Key hints only in the head's ⓘ. Draws its model; the container keeps the draft.
 */
export function Composer(props: ComposerProps) {
  const { context, draft, notes = [], sending = false } = props
  const t = useT('record-thread-composer')
  const sendWords = useT('record-thread-send') // F-CP-147
  const cardWords = useT('record-thread-card') // tw- W2.3: the reply bar's "You"
  const attachWords = useT('record-thread-attach') // tw- W2.3: the "+"'s name
  const helperWords = useT('record-thread-helpers') // tw- W2.3: "+ › Saved replies"
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

  // tw- W2.3 (P0-B2): the box grows with the text from one line to about 8 lines, then scrolls inside; its floor is ONE line
  // (composer.css owns the height rule: never 0 px — a measured 0 is never written back).
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
          {context.can.manage && props.onReopen && <span aria-hidden="true">·</span>}
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

  // F-SA-282a: a change of the words lets the portal's hold and the tick go (the API checks the new words again).
  const change = (next: Partial<ComposerDraft>) => props.onDraft(draftAfter(draft, next), notes)
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

  // tw- W2.3 (D5, Z3): Enter sends, Shift+Enter a new line; in Reply to N (context.many) only ⌘/Ctrl+Enter sends (N records, no Undo).
  // The @ list takes its own Enter first (MentionInput). "/" in an empty box opens Saved replies.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && (enterSends(context) || event.metaKey || event.ctrlKey)) {
      if (event.nativeEvent.isComposing) return
      event.preventDefault()
      send()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      props.onEscape?.()
    } else if (event.key === '/' && draft.body === '' && openReplies()) {
      event.preventDefault()
    }
  }
  /** Opens Saved replies (its own menu inside the box); false when there is none. */
  const openReplies = (): boolean => {
    const trigger = boxRef.current?.querySelector<HTMLButtonElement>('.fw-rt-cx-helpers .nds-menu-wrap > button')
    trigger?.click()
    return Boolean(trigger)
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

  const modeWords = (mode: ComposerMode) => (mode === 'note' ? t('mode.note') : mode === 'portal' ? t('mode.portal', { party }) : t(prospect ? 'mode.replyProspect' : 'mode.reply', { party }))
  const sendLabel = namesPriceAsked(draft) ? sendWords(NAMES_PRICE_SEND) /* F-CP-147 */ : t(sendKey(draft.mode), { party })
  const floor = floorOffered(context, draft.mode)
  // ── the "+" rows after the files' (10-design §10): Saved replies · Amount (price grain) · For the floor (work orders) ──
  const more: MenuItemDef[] = [
    ...(props.helpers ? [{ id: 'replies', label: helperWords('replies.label'), onSelect: () => void openReplies() }] : []),
    ...(amount && draft.amount === undefined ? [{ id: 'amount', label: t('amount.add'), icon: <Euro size={14} aria-hidden />, onSelect: () => change({ amount: '', currency: draft.currency ?? AMOUNT_CURRENCIES[0] }) }] : []),
    ...(floor && !draft.forFloor && !lockedFloor ? [{ id: 'floor', label: t('floor.label'), icon: <HardHat size={14} aria-hidden />, onSelect: () => change({ forFloor: true }) }] : []),
  ]
  const plus = props.plus ? props.plus(more) : props.clip ? props.clip : more.length > 0 ? <Menu className="fw-rt-clip-menu" label={<Plus size={16} aria-hidden />} items={more} triggerProps={{ 'aria-label': attachWords('clip.label'), className: 'nds-btn quiet sm icon' }} /> : null

  // ── ONE bar above the box (10-design §10): a hold first (it must be answered to send), then the reply or the correction, then a
  // switch note; the counter near the limit and the floor's length rule ride on it. ──
  const quote = link?.kind === 'reply' ? link.quote : undefined
  const bar = namesOtherAsked(draft) ? (
    // F-SA-282a (B-SA-073): the API held the text — it names another customer of ours (never whom): the tick, and what it means.
    <div className="fw-rt-cx-bar is-held fw-rt-cx-tick">
      {heldText && <p className="fw-rt-cx-line">{heldText}</p>}
      <Checkbox label={t('namesOther.tick')} checked={draft.namesNoOtherCustomer === true} onChange={(event) => change({ namesNoOtherCustomer: event.target.checked })} />
      <p className="fw-rt-cx-line">{t('namesOther.hint')}</p>
    </div>
  ) : namesPriceAsked(draft) ? (
    // F-CP-147 (the money wall L3; Owner O5): these words look like a price — warned once, never blocked; the text stays.
    <p className="fw-rt-cx-bar is-held fw-rt-cx-warn" role="status">
      <Euro size={14} aria-hidden />
      <span>{sendWords(namesPriceWords(draft.mode).key)}</span>
    </p>
  ) : link ? (
    <div className={`fw-rt-cx-bar is-link${quote ? ` ${toneClass(quote.tone)}` : ''}`} role="group" aria-label={link.kind === 'reply' ? t('link.replying', { who: link.who ?? t('link.someone'), when: shortDateOf(link.at, locale, dayOf(props.now ?? new Date().toISOString())) }) : undefined}>
      {link.kind === 'reply' ? (
        <span className="fw-rt-cx-quote">
          <b>{quote ? (quote.you ? cardWords('quote.you') : (quote.name ?? t('link.someone'))) : (link.who ?? t('link.someone'))}</b>
          {quote && <span>{quote.line}</span>}
        </span>
      ) : (
        <span className="fw-rt-cx-quote is-correct">
          <PencilLine size={13} aria-hidden />
          <span>{t(`link.correcting.${link.way ?? draft.mode}`, { time: timeOf(link.at, locale), party })}</span>
        </span>
      )}
      <Button size="sm" variant="quiet" className="icon" aria-label={t(link.kind === 'reply' ? 'link.dropReply' : 'link.dropCorrect')} onClick={dropLink}>
        <X size={13} aria-hidden />
      </Button>
    </div>
  ) : notes.length > 0 ? (
    <div className="fw-rt-cx-bar fw-rt-cx-notes" role="status">
      {notes.map((note) => (
        <p key={note.key} className="fw-rt-cx-line">
          {t(note.key, note.params)}
        </p>
      ))}
    </div>
  ) : heldText && held?.key !== 'held.empty' ? (
    <p className="fw-rt-cx-bar is-held" id={heldId}>
      {heldText}
    </p>
  ) : null

  // ── the chips row (Follow up, Amount, For the floor, About): only when one is on (P6: at rest the composer is one row) ──
  const about = aboutWords(draft)
  const chips =
    (toCustomer(draft.mode) && props.followUp) || (amount && draft.amount !== undefined) || (floor && (draft.forFloor || lockedFloor)) || about ? (
      <div className="fw-rt-cx-chips">
        {toCustomer(draft.mode) && props.followUp}
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
        {floor && (draft.forFloor || lockedFloor) && (
          // The floor's rule in the chip's tooltip (the tablets' words), never a sentence under the box.
          <Tooltip label={`${t('floor.on', { record: context.recordLabel, limit: FLOOR_TEXT })}${lockedFloor ? ` ${t('floor.locked')}` : ''}`} portal>
            <span className="fw-rt-cx-chip is-floor" tabIndex={0}>
              <HardHat size={13} aria-hidden />
              {t('floor.label')}
              {/* The rule for a screen reader too (a tooltip alone is hover-only). */}
              <span className="nds-vh">
                {` ${t('floor.on', { record: context.recordLabel, limit: FLOOR_TEXT })}${lockedFloor ? ` ${t('floor.locked')}` : ''}`}
              </span>
              {!lockedFloor && (
                <button type="button" className="fw-rt-cx-chip-x" aria-label={`${t('floor.label')} ×`} onClick={() => change({ forFloor: false })}>
                  <X size={12} aria-hidden />
                </button>
              )}
            </span>
          </Tooltip>
        )}
        {/* F-SA-265: what the message is about ("About: SO-2026-0142 · line 2"; to the customer its own words), with × to let it go. */}
        {about && (
          <span className="fw-rt-cx-chip fw-rt-cx-about">
            <Link2 size={13} aria-hidden />
            <span>{t('about.chip', { thing: about })}</span>
            <button type="button" className="fw-rt-cx-chip-x" aria-label={t('about.drop')} onClick={() => props.onDraft(withoutAbout(draft), notes)}>
              <X size={12} aria-hidden />
            </button>
          </span>
        )}
      </div>
    ) : null

  // ── the audience chip: a menu of radio rows (today's words), the lock / mail / globe; one audience alone is a plain chip ──
  const chip =
    modes.length > 1 ? (
      <Menu
        className="fw-rt-cx-aud"
        label={
          <>
            <ModeIcon size={13} aria-hidden />
            <span className="fw-rt-cx-aud-word">{modeWords(draft.mode)}</span>
            <ChevronDown size={13} aria-hidden />
          </>
        }
        items={modes.map((mode) => {
          const Icon = MODE_ICON[mode]
          return { id: `mode-${mode}`, label: mode === 'note' ? t('mode.note') : t(mode === 'portal' ? 'modeMenu.portal' : 'modeMenu.reply', { party }), icon: <Icon size={14} aria-hidden />, checked: mode === draft.mode, onSelect: () => setMode(mode) }
        })}
        triggerProps={{ className: 'fw-rt-cx-chipbtn', 'aria-label': `${t('modeLabel')}: ${modeWords(draft.mode)}` }}
      />
    ) : modes.length === 1 ? (
      <span className="fw-rt-cx-chipbtn is-static" title={modeWords(draft.mode)}>
        <ModeIcon size={13} aria-hidden />
        <span className="fw-rt-cx-aud-word">{modeWords(draft.mode)}</span>
      </span>
    ) : null

  return (
    <div className="fw-rt-composer" data-mode={draft.mode}>
      {bar}
      {draft.mode === 'reply' && props.recipients}
      {chips}
      <div className="fw-rt-cx-row">
        {plus}
        {chip}
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
          <MentionInput
            ref={mention}
            className="fw-rt-cx-text"
            value={draft.body}
            onChange={(body) => change({ body })}
            people={context.people}
            mode={mentionMode}
            label={modeWords(draft.mode)}
            rows={1}
            placeholder={t('placeholder')}
            aria-describedby={heldText && held?.key !== 'held.empty' && !link && notes.length === 0 ? heldId : undefined}
            onKeyDown={onKeyDown}
            onPaste={(event) => {
              if (!takesFiles) return
              const files = [...event.clipboardData.files]
              if (files.length === 0) return
              event.preventDefault()
              props.onFiles?.(files)
            }}
          />
          {props.helpers && <span className="fw-rt-cx-helpers">{props.helpers}</span>}
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
        <Button size="sm" variant="primary" className="fw-rt-cx-send" onClick={send} heldReason={heldText} aria-label={sendLabel}>
          <SendHorizontal size={16} aria-hidden />
          <span className="fw-rt-sr">{sendLabel}</span>
        </Button>
      </div>
      {length >= COUNTER_FROM && <p className={`fw-rt-cx-count${length > MAX_BODY ? ' is-over' : ''}`}>{t('counter', { count: MAX_BODY - length })}</p>}
      {floor && floorTooLong(draft) && <p className="fw-rt-cx-line">{t('floor.long', { limit: FLOOR_TEXT })}</p>}
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
      {props.hint}
      <p className="fw-rt-sr" aria-live="polite">
        {announce}
      </p>
    </div>
  )
}
