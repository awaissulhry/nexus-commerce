'use client'

import { Fragment, useEffect, useId, useState, type AnimationEvent, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { Bell, Check, CheckCheck, CircleAlert, Clock, CornerDownRight, EyeOff, FileText, FileX, Globe, ImageIcon, Layers, Lock, Mail, Pin, RotateCw, Tablet, Trash2, Undo2 } from 'lucide-react'
import { Button, Pill } from '@nexus/ui/primitives'
import { formatDate } from '../../../i18n/format'
import { INTL_LOCALE } from '../../../i18n/locales'
import { useLocale, useT } from '../../../i18n/provider'
import { FLASH_MS } from '../../feed/model'
import type { RunPlace } from '../../feed/runs'
import { Avatar } from '../../parts/Avatar'
import { timeOf } from '../../parts/time'
import { senderTone } from '../../parts/tones'
import {
  // B-TH-236: the amount, Undo.
  amountWords,
  showsUndo,
  undoLeft,
  type CardAction,
  type CardLink,
  audienceKey,
  authorWords,
  cardActions,
  cardFiles,
  copyTextOf, // tw- W2.5
  READ_ONLY_MENU, // tw- W2.5
  deliveryMark,
  fileKindKey,
  footMarks,
  longFold,
  sizeWords,
  splitQuoted,
  type CardContext,
  type CardMessage,
} from '../model'
import { bodyKind, skippedLine } from '../model' // B-TH-255
import { askChip, changeChip, type CardAsk, type CardChange } from '../model' // F-SA-244
import { Bubble, BubbleFoot } from './Bubble'
import { MessageMenu, opensOnRightClick } from './MessageMenu' // tw- W2.2
import { QuoteBlock } from './QuoteBlock'
import '../card.css'

export interface CardActions {
  onReply?: (messageId: string) => void
  /** tw- W1.1 (W-037): an office note that quotes the customer's message. */
  onReplyPrivately?: (messageId: string) => void
  onTask?: (messageId: string) => void
  onCopyLink?: (messageId: string) => void
  /** Send again a message that did not go (the same Idempotency-Key: one message). */
  onRetry?: (messageId: string) => void
  onOpenFile?: (fileId: string) => void
  /** "+14": the message's other files (the Files view, TH-1c); without it the card shows them all in place. */
  onMoreFiles?: (messageId: string) => void
  /** B-TH-231: "Use on another record…" with the message's files. */
  onUseOn?: (messageId: string) => void
  // ---- B-TH-236 (B-TH-048, B-TH-050)
  /** "Correct": the box takes a correction of this message, the way it went. */
  onCorrect?: (messageId: string) => void
  /** "Undo" in a mail's 10 seconds: take it back; its text comes back into the box. */
  onUndo?: (messageId: string) => void
  // ---- end B-TH-236
  // ---- B-TH-286 (B-TH-091): "Pin for everyone" / "Unpin".
  onPin?: (messageId: string) => void
  onUnpin?: (messageId: string) => void
  // ---- end B-TH-286
  // ---- F-SA-265: "Show on the page" — a message about a part of its record jumps back to that row (the record page's own door).
  onShowOnPage?: (messageId: string) => void
  // ---- F-SA-244: the conversation side of a change — the record page's doors (absent: not offered).
  /** Answer… on the customer's ask: the ONE review window opens on its request (the record frame's answer door). */
  onAnswer?: (requestId: string) => void
  /** Answer…'s own address (a real link: ⌘-click opens it in a new tab); null: the page has none. */
  answerHref?: (requestId: string) => string | null
  /** Who was told… on a change's line. */
  onWhoWasTold?: (messageId: string) => void
  /** "Still to do: N" on a change's line: the page's Still to do. */
  onStillToDo?: (messageId: string) => void
  // ---- end F-SA-244
  // ---- tw- W1.2 (Z10): a quote, "Correction of 09:12" and "Corrected" go to the message they name (the host's ONE door: the View
  // back to All when it hides it, older pages read, the row lit). Absent: the quote is drawn, nothing to click.
  onJump?: (messageId: string) => void
  // ---- tw- W2.2 (10-design §9): the menu's rows the host carries — Copy text (the host says it was copied), Remind me (the reader's
  // own reminder, its one dialog) and Email details (the one window). Absent: the row is not drawn.
  onCopyText?: (messageId: string) => void
  onRemind?: (messageId: string) => void
  onEmailDetails?: (messageId: string) => void
  /** tw- W2.5: a read-only card (All of <Customer>): "Answer in its thread" — the dock switches to the message's own thread. */
  onAnswerThere?: (messageId: string) => void
}

/** tw- W2.2: a row whose door the host does not give is not drawn. */
const DOOR_OF: Partial<Record<CardAction, keyof CardActions>> = { answer: 'onAnswer', remind: 'onRemind', emailDetails: 'onEmailDetails', copyText: 'onCopyText' }
/** tw- W2.5: a read-only card's rows, each by its door. */
const READ_ONLY_DOOR: Partial<Record<CardAction, keyof CardActions>> = { answerThere: 'onAnswerThere', copyText: 'onCopyText', link: 'onCopyLink' }

const MARK_ICON = { lock: Lock, mail: Mail, globe: Globe, tablet: Tablet } as const
const DELIVERY_ICON = { clock: Clock, check: Check, checks: CheckCheck, alert: CircleAlert, back: Undo2 } as const
/** An album shows at most this many tiles; past it the 4th tile says "+N" (W-041). */
const ALBUM_TILES = 4

/** A line under the words: drawn by the card, the foot placed in the LAST of them (the time sits at the end of the last line). */
interface TailLine {
  readonly key: string
  readonly draw: (foot: ReactNode) => ReactNode
}

// F-SA-261 (sales page plan R4, P9; "All of <Customer>"): `readOnly` draws the card as the merged customer feed shows it — the same
// card, its audience, words and files, with no menu, no Undo and no Retry: nothing is done on it there.
/**
 * One message of a record's thread (B-TH-298, T3), as a chat bubble (tw- W1.2; THE THREAD REBUILD, 10-design §2 – §5): the row is
 * the whole list width (`.fw-rt-msg`, the row a jump lights up); mine on the right with no tile and no name, everyone else on the
 * left with the 28 px tile of the PERSON on a run's first bubble and their name in their own colour (with their company when it is
 * not the reader's own). Inside, top to bottom: "Correction of 09:12", the quote and the About chip; the album of tiles (2 × 2, "+N")
 * or the file rows; the words (links open, @names coloured, quoted text and the signature behind "…", a long text after 12 lines
 * behind "Show all"); the amount on its own line with the lock; the lines for a bounce, a file the reader cannot open, a file an
 * email did not keep, the customer's ask, a change's line, "Not sent · Retry"; the foot at the end of the last line — the pin,
 * "Corrected", who reads it (the lock of an office note, the mail, the globe, the tablet), the time or "Sending · Undo (7)", and our
 * email's delivery mark (grey ticks, never "read"). An office note is the one yellow on either side, said in words too (R17). The
 * system's own office line is a centred pill (no menu). An article named by writer, audience and time for screen readers.
 */
export function MessageCard({
  message,
  context,
  actions,
  readOnly = false,
  run,
  flash = null,
  paper = false,
}: {
  message: CardMessage
  context: CardContext
  actions?: CardActions
  readOnly?: boolean
  /** tw- W1.2: its place in the run (the feed's); alone: a run of its own. */
  run?: RunPlace
  /** tw- W1.3: the row lights up after a jump (FLASH_MS), then says it ended. */
  flash?: { readonly seq: number; readonly onEnd: () => void } | null
  /** tw- W1.4 (R18): paper — its name on every message and who reads it in words. */
  paper?: boolean
}) {
  const t = useT('record-thread-card')
  const frameWords = useT('record-frame') // F-SA-265: the record frame's door words (loaded by the frame around a record page)
  const pricedWords = useT('record-files') // B-CP-014: a priced document's lock (record-files.json priced.*; THREAD_NAMESPACES loads it)
  const locale = useLocale()
  const intl = INTL_LOCALE[locale]
  const quotedId = useId()
  const [quotedOpen, setQuotedOpen] = useState(false)
  const [allShown, setAllShown] = useState(false)
  const [allFiles, setAllFiles] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false) // tw- W2.2: the arrow or a right-click opens it

  const party = context.partyName || t('side.theParty')
  const who = authorWords(message)
  const author = 'text' in who ? who.text : t(who.key)
  const time = timeOf(message.at, locale)
  const place: RunPlace = run ?? { side: message.mine ? 'mine' : 'others', first: true, last: true, showName: !message.mine }
  const system = message.kind === 'note' && message.authorKind === 'SYSTEM'
  // B-TH-255 (T3-F14): an erased message says why its words are gone; a message that only carries files draws no empty body.
  const body = bodyKind(message)
  const { text, quoted } = body === 'text' ? splitQuoted(message.body, message.kind) : { text: '', quoted: null }
  const skipped = skippedLine(message.skipped)
  const fold = longFold(text)
  const folded = fold.folds && !allShown
  const files = cardFiles(message.files, context.canReadFiles, true, { hidden: message.hiddenFiles ?? 0, sheets: message.lockedSheets ?? 0, priced: message.lockedPriced ?? 0 /* B-CP-014 */ })
  // F-SA-261: none read-only. tw- W2.2: ONE order; a row whose door the host does not give is not drawn.
  // tw- W2.5: read only (All of <Customer>), the card's own small menu: Answer in its thread · Copy text · Copy link, each by its door.
  const menu = readOnly
    ? message.outbox
      ? []
      : READ_ONLY_MENU.filter((action) => Boolean(actions?.[READ_ONLY_DOOR[action]!]) && (action !== 'copyText' || copyTextOf(message) !== null))
    : cardActions(message, context).filter((action) => !DOOR_OF[action] || Boolean(actions?.[DOOR_OF[action]!]))
  const failed = message.outbox?.state === 'failed'
  const sending = message.outbox?.state === 'sending'
  const label = t('label', { author, audience: t(audienceKey(message), { party }), time })
  const tone = senderTone(message.senderKey)
  const cls = ['fw-rt-msg', `is-${message.kind}`, body === 'erased' ? 'is-erased' : '', sending ? 'is-pending' : '', failed ? 'is-failed' : '', system ? 'is-system' : `is-${place.side}`, place.first ? 'is-start' : ''].filter(Boolean).join(' ')
  // tw- W1.3: the jump's flash on the whole row — the one named constant, cleared when its animation ends (no timer).
  const lit = flash
    ? {
        'data-flash': '',
        style: { '--fw-rt-flash-ms': `${FLASH_MS}ms` } as CSSProperties,
        onAnimationEnd: (event: AnimationEvent<HTMLElement>) => {
          if (event.target === event.currentTarget && event.animationName.startsWith('fw-rt-flash')) flash.onEnd()
        },
      }
    : {}

  // ── the system's own office line: one centred pill, no menu (10-design §9 "A system note: a pill") ──────────────────
  if (system) {
    const sideLines = !readOnly && message.change && changeShown(message.change, actions)
    return (
      <article className={cls} id={`message-${message.id}`} data-message-id={message.id} data-feed-item={message.id} tabIndex={-1} aria-label={label} {...lit}>
        <div className="fw-rt-sys">
          <p className="fw-rt-sys-line">
            <Lock size={13} className="fw-rt-lock" aria-hidden />
            <span className="fw-rt-sys-text">{message.body}</span>
            <time dateTime={message.at}>{time}</time>
          </p>
          {sideLines && message.change ? <ChangeLine messageId={message.id} change={message.change} actions={actions} /> : null}
        </div>
      </article>
    )
  }

  // ── the name line: the person, and their company when it is not the reader's own (P3) ────────────────────────────────
  const org = message.authorHidden ? null : message.authorKind === 'PARTY' ? context.partyName : message.authorKind === 'WORKER' ? t('org.floor') : null
  const name = paper || place.showName ? { text: author, org: paper ? null : org } : null
  const names = message.mentions.filter((one): one is string => one !== null)

  // ── the album of tiles (Z1: icon + name this round; real pictures later change the cell only) ───────────────────────
  const photos = files.photos
  const album = photos.length === 0 ? [] : allFiles || photos.length <= ALBUM_TILES ? photos : photos.slice(0, ALBUM_TILES - 1)
  const moreCount = allFiles || photos.length <= ALBUM_TILES ? 0 : photos.length - (ALBUM_TILES - 1)
  const openFile = (fileId: string) => actions?.onOpenFile?.(fileId)

  // ── the lines under the words ──────────────────────────────────────────────────────────────────────────────────────
  const tail: TailLine[] = []
  if (body === 'erased') {
    tail.push({
      key: 'erased',
      draw: (foot) => (
        <p className="fw-rt-erased">
          <EyeOff size={13} aria-hidden />
          <span>{t('erased.line')}</span>
          {foot}
        </p>
      ),
    })
  } else if (body === 'text') {
    tail.push({
      key: 'body',
      draw: (foot) => (
        <>
          <p className={`fw-rt-body${folded ? ' is-folded' : ''}`}>
            {wordsOf(text, names)}
            {quoted !== null && (
              <button type="button" className="fw-rt-quoted" aria-expanded={quotedOpen} aria-controls={quotedId} aria-label={t(quotedOpen ? 'body.hideQuoted' : 'body.showQuoted')} onClick={() => setQuotedOpen((open) => !open)}>
                …
              </button>
            )}
            {foot}
          </p>
          {quoted !== null && (
            <p id={quotedId} className="fw-rt-quoted-text" hidden={!quotedOpen}>
              {quoted}
            </p>
          )}
        </>
      ),
    })
    if (folded) {
      tail.push({
        key: 'showAll',
        draw: (foot) => (
          <p className="fw-rt-bline">
            <button type="button" className="fw-rt-showall" onClick={() => setAllShown(true)}>
              {t('body.showAll', { count: fold.lines })}
            </button>
            {foot}
          </p>
        ),
      })
    }
  }
  if (message.amount) {
    const amount = message.amount
    tail.push({
      key: 'amount',
      draw: (foot) => (
        <p className="fw-rt-bline fw-rt-amount">
          <Lock size={13} className="fw-rt-lock" aria-hidden />
          <span>{t('amount.line', { amount: amountWords(amount, intl) })}</span>
          {foot}
        </p>
      ),
    })
  }
  // F-SA-244: their ask's live chip and Answer…; a change's line: its Still to do, when the floor and the workshop were told.
  if (!readOnly && message.ask) {
    const ask = message.ask
    tail.push({ key: 'ask', draw: (foot) => <AskLine ask={ask} foot={foot} /> })
  }
  if (!readOnly && message.change && changeShown(message.change, actions)) {
    const change = message.change
    tail.push({ key: 'change', draw: (foot) => <ChangeLine messageId={message.id} change={change} actions={actions} foot={foot} /> })
  }
  // B-TH-231 / B-CP-014: what the reader may not open is counted in its own words, never named.
  const quiet = (key: string, words: string, icon: ReactNode = <Lock size={13} aria-hidden />) =>
    tail.push({
      key,
      draw: (foot) => (
        <p className="fw-rt-bline is-quiet fw-rt-held-file">
          {icon}
          <span>{words}</span>
          {foot}
        </p>
      ),
    })
  if (files.sheets > 0) quiet('sheets', t('files.sheetLocked', { count: files.sheets }))
  if ((files.priced ?? 0) > 0) quiet('priced', pricedWords('priced.lockedCount', { count: files.priced ?? 0 }))
  if (files.hidden > 0) quiet('hidden', t('files.cannotOpen', { count: files.hidden }))
  // B-TH-255 (T3-F15): what an inbound mail brought that was not kept, by name and why (office only; never a signature logo).
  if (skipped) {
    tail.push({
      key: 'skipped',
      draw: (foot) => (
        <p className="fw-rt-bline is-quiet fw-rt-skipped" role="note">
          <FileX size={13} aria-hidden />
          <span>{t('skipped.line', { count: skipped.count, files: skipped.items.map((item) => t('skipped.item', { name: item.name, reason: t(item.reasonKey) })).join(', ') })}</span>
          {foot}
        </p>
      ),
    })
  }
  const mail = message.email // tw- W2.2: its To · Cc · Subject live in the menu's Email details
  if (mail?.status === 'BOUNCED' || mail?.status === 'COMPLAINED' || mail?.status === 'FAILED') {
    tail.push({
      key: 'bounce',
      draw: (foot) => (
        <p className="fw-rt-bline is-bad fw-rt-bounce" role="note">
          <CircleAlert size={13} aria-hidden />
          <span>{mail.status === 'BOUNCED' ? t('bounce.text', { to: mail.to.join(', ') }) : t(mail.status === 'COMPLAINED' ? 'bounce.complained' : 'bounce.failed')}</span>
          {mail.status === 'BOUNCED' && message.bounceTask && (
            <a className="fw-rt-bounce-link" href={message.bounceTask.href}>
              {t('bounce.task')}
            </a>
          )}
          {foot}
        </p>
      ),
    })
  }
  if (!readOnly /* F-SA-261 */ && message.outbox?.state === 'failed') {
    const reason = message.outbox.reason
    tail.push({
      key: 'failed',
      draw: (foot) => (
        <p className="fw-rt-bline is-bad fw-rt-failline" role="alert">
          <span>{t('outbox.failed', { reason: t(reason) })}</span>
          <Button size="sm" onClick={() => actions?.onRetry?.(message.id)}>
            <RotateCw size={13} aria-hidden /> {t('outbox.retry')}
          </Button>
          {foot}
        </p>
      ),
    })
  }
  // tw- W1.4 (R18): on paper, who reads it in words.
  if (paper) {
    tail.push({
      key: 'audience',
      draw: (foot) => (
        <p className="fw-rt-bline is-quiet fw-rt-audwords">
          <span>{t(audienceKey(message), { party })}</span>
          {foot}
        </p>
      ),
    })
  }
  if (tail.length === 0) tail.push({ key: 'foot', draw: (foot) => <p className="fw-rt-bline is-foot">{foot}</p> })

  // ── the foot: the pin, "Corrected", who reads it, the time (or Sending · Undo), our email's delivery mark ─────────────────
  const delivery = message.kind === 'ours' && mail && !message.outbox ? deliveryMark(mail.status) : null
  const DeliveryIcon = delivery ? DELIVERY_ICON[delivery.icon] : null
  const timeWords = <time dateTime={message.at}>{time}</time>
  const onJump = actions?.onJump
  const correctedBy = message.correctedBy ?? null
  const foot = (
    <BubbleFoot>
      {message.pinned && <FootIcon className="fw-rt-pinned" word={t('foot.pinned')} icon={<Pin size={13} aria-hidden />} />}
      {/* tw- W2.2 (10-design §2 "Foot"): the reader's own follow-up on their message — a bell, for its sender only. */}
      {message.followUp && message.mine && <FootIcon className="fw-rt-followup" word={t('foot.followUp', { date: formatDate(message.followUp.at, { locale }) })} icon={<Bell size={13} aria-hidden />} />}
      {correctedBy &&
        (onJump && !readOnly ? (
          <button type="button" className="fw-rt-corrected" onClick={() => onJump(correctedBy.id)}>
            {t('foot.corrected')}
          </button>
        ) : (
          <span className="fw-rt-corrected">{t('foot.corrected')}</span>
        ))}
      {footMarks(message).map((mark) => {
        const Icon = MARK_ICON[mark.icon]
        return <FootIcon key={mark.key} className={mark.icon === 'lock' ? 'fw-rt-lock' : undefined} word={t(mark.key)} icon={<Icon size={13} aria-hidden />} />
      })}
      {!readOnly /* F-SA-261 */ && mail && showsUndo(message, context.now ?? Date.now()) ? (
        <UndoFoot until={mail.undoUntil!} start={context.now} onUndo={actions?.onUndo ? () => actions.onUndo?.(message.id) : undefined} done={timeWords} />
      ) : sending ? (
        <span>{t('outbox.sending')}</span>
      ) : (
        timeWords
      )}
      {delivery && DeliveryIcon && mail && <FootIcon className={delivery.tone === 'bad' ? 'is-bad' : 'is-ok'} word={t(`delivery.${mail.status}`)} icon={<DeliveryIcon size={13} aria-hidden />} />}
    </BubbleFoot>
  )

  const pick = (action: CardAction) => {
    if (action === 'answerThere') actions?.onAnswerThere?.(message.id) // tw- W2.5
    else if (action === 'reply') actions?.onReply?.(message.id)
    else if (action === 'replyPrivately') actions?.onReplyPrivately?.(message.id) // tw- W1.1
    else if (action === 'copyText') actions?.onCopyText?.(message.id)
    else if (action === 'link') actions?.onCopyLink?.(message.id)
    else if (action === 'pin') actions?.onPin?.(message.id) // B-TH-286
    else if (action === 'unpin') actions?.onUnpin?.(message.id) // B-TH-286
    else if (action === 'remind') actions?.onRemind?.(message.id)
    else if (action === 'task') actions?.onTask?.(message.id)
    else if (action === 'answer' && message.ask) actions?.onAnswer?.(message.ask.requestId) // F-SA-244
    else if (action === 'correct') actions?.onCorrect?.(message.id)
    else if (action === 'emailDetails') actions?.onEmailDetails?.(message.id)
    else if (action === 'useOn') actions?.onUseOn?.(message.id)
  }
  const tools =
    menu.length > 0 ? (
      <MessageMenu rows={menu} label={t('menu.label', { author, time })} open={menuOpen} onOpenChange={setMenuOpen} onPick={pick} answerHref={message.ask ? (actions?.answerHref?.(message.ask.requestId) ?? null) : null} />
    ) : null
  // tw- W2.2 (W-060): a right-click on the message opens the same menu (a link or selected text keeps the browser's own).
  const onContextMenu =
    menu.length > 0
      ? (event: MouseEvent<HTMLElement>) => {
          if (!opensOnRightClick(event, typeof window === 'undefined' ? '' : (window.getSelection()?.toString() ?? ''))) return
          event.preventDefault()
          setMenuOpen(true)
        }
      : undefined

  return (
    <article className={cls} id={`message-${message.id}`} data-message-id={message.id} data-feed-item={message.id} tabIndex={-1} aria-label={label} onContextMenu={onContextMenu} {...lit}>
      {place.side === 'others' && place.first && !paper && <Avatar name={message.authorHidden ? null : message.author} size="run" tone={tone} />}
      <Bubble model={{ side: place.side, run: { first: place.first, last: place.last }, name, senderTone: tone }} tools={tools}>
        {/* TOP: the correction, the quote — both from this message's OWN links (R1) — and what it is about. */}
        {message.corrects && <CorrectionLink link={message.corrects} onJump={onJump} />}
        {message.replyTo && <QuoteBlock link={message.replyTo} onJump={onJump} />}
        {/* F-SA-265: a message about a part of its record (a line, a shipment…) jumps back to its row on the page. */}
        {!readOnly && message.about && actions?.onShowOnPage && (
          <button type="button" className="fw-rt-about" onClick={() => actions.onShowOnPage?.(message.id)}>
            <Layers size={12} aria-hidden />
            {frameWords('discuss.showOnPage')}
          </button>
        )}
        {(album.length > 0 || files.others.length > 0 || files.held.length > 0) && (
          <div className="fw-rt-attach">
            {album.length > 0 && (
              <ul className={`fw-rt-album${album.length + (moreCount > 0 ? 1 : 0) === 1 ? ' is-one' : ''}`} aria-label={t('files.label')}>
                {album.map((file) => (
                  <li key={file.id}>
                    <button type="button" className="fw-rt-tile" aria-label={t('files.open', { name: file.name })} onClick={() => openFile(file.id)}>
                      <ImageIcon size={18} aria-hidden />
                      <span>{file.name}</span>
                    </button>
                  </li>
                ))}
                {moreCount > 0 && (
                  <li>
                    <button type="button" className="fw-rt-tile is-more" aria-label={t('files.moreLabel', { count: moreCount })} onClick={() => (actions?.onMoreFiles ? actions.onMoreFiles(message.id) : setAllFiles(true))}>
                      +{moreCount}
                    </button>
                  </li>
                )}
              </ul>
            )}
            {files.others.map((file) => (
              <button key={file.id} type="button" className="fw-rt-file" aria-label={t('files.open', { name: file.name })} onClick={() => openFile(file.id)}>
                <FileText size={18} aria-hidden />
                <span className="fw-rt-file-name">
                  <b>{file.name}</b>
                  <small>{`${t(fileKindKey(file))} · ${sizeWords(file.sizeBytes, intl)}`}</small>
                </span>
              </button>
            ))}
            {files.held.map((file) => (
              <p key={file.id} className="fw-rt-held-file">
                {file.status === 'DELETED' ? <Trash2 size={13} aria-hidden /> : <Lock size={13} aria-hidden />}
                <span>
                  <b>{file.name}</b> · {t(file.status === 'DELETED' ? 'files.removed' : file.status === 'QUARANTINED' ? 'files.quarantined' : 'files.pending')}
                </span>
              </p>
            ))}
          </div>
        )}
        {tail.map((line, index) => (
          <Fragment key={line.key}>{line.draw(index === tail.length - 1 ? foot : null)}</Fragment>
        ))}
      </Bubble>
    </article>
  )
}

/** One small icon of the foot with its honest word as the tooltip and for screen readers (R17). */
function FootIcon({ icon, word, className }: { icon: ReactNode; word: string; className?: string | undefined }) {
  return (
    <span className={`fw-rt-mi${className ? ` ${className}` : ''}`} title={word}>
      {icon}
      <span className="fw-rt-sr">{word}</span>
    </span>
  )
}

/** "Correction of 09:12" at the top of a correction: it goes to the message it corrects (from its own link, R1). */
function CorrectionLink({ link, onJump }: { link: CardLink; onJump?: ((messageId: string) => void) | undefined }) {
  const t = useT('record-thread-card')
  const locale = useLocale()
  const words = t('link.correction', { time: timeOf(link.at, locale) })
  if (!onJump) {
    return (
      <p className="fw-rt-corr">
        <CornerDownRight size={13} aria-hidden />
        {words}
      </p>
    )
  }
  return (
    <button type="button" className="fw-rt-corr" onClick={() => onJump(link.id)}>
      <CornerDownRight size={13} aria-hidden />
      {words}
    </button>
  )
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/g
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The words with their links (W-026: they open in a new tab; nothing is fetched to preview them, R16) and their @names coloured
 * (W-025: the people a note mentioned, by the names the read gave; the "Mentioned:" line went).
 */
function wordsOf(text: string, mentioned: readonly string[]): ReactNode[] {
  const parts: ReactNode[] = []
  const names = [...new Set(mentioned)].sort((a, b) => b.length - a.length)
  const mention = names.length > 0 ? new RegExp(`@(?:${names.map(escapePattern).join('|')})(?![\\p{L}\\p{N}])`, 'gu') : null
  const plain = (segment: string, at: number) => {
    if (!mention) {
      parts.push(segment)
      return
    }
    let last = 0
    for (const found of segment.matchAll(mention)) {
      const index = found.index ?? 0
      if (index > last) parts.push(segment.slice(last, index))
      parts.push(
        <span key={`m${at + index}`} className="fw-rt-mention">
          {found[0]}
        </span>,
      )
      last = index + found[0].length
    }
    if (last < segment.length) parts.push(segment.slice(last))
  }
  let last = 0
  for (const found of text.matchAll(URL_PATTERN)) {
    const index = found.index ?? 0
    const href = found[0].replace(/[.,;:!?)\]]+$/, '')
    if (index > last) plain(text.slice(last, index), last)
    parts.push(
      <a key={`u${index}`} className="fw-rt-link" href={href} target="_blank" rel="noopener noreferrer">
        {href}
      </a>,
    )
    last = index + href.length
  }
  if (last < text.length) plain(text.slice(last), last)
  return parts
}

/**
 * "Sending · Undo (7)" in the foot of our mail in its 10 seconds (B-TH-048, T7-F06), for the person who sent it: the seconds count
 * down; Undo takes it back (its text comes back into the box). When the window passes the time and the delivery mark stay.
 */
function UndoFoot({ until, start, onUndo, done }: { until: string; start?: number | undefined; onUndo?: (() => void) | undefined; done: ReactNode }) {
  const t = useT('record-thread-card')
  // Counted from when the card first drew it (the clock, or a design case's fixed "now"), one second a tick.
  const [now, setNow] = useState(() => start ?? Date.now())
  const left = undoLeft(until, now)
  useEffect(() => {
    if (left <= 0) return
    const id = setInterval(() => setNow((current) => current + 1000), 1000)
    return () => clearInterval(id)
  }, [left])
  if (left <= 0) return <>{done}</>
  return (
    <>
      <span>{t('foot.sending')} ·</span>
      {onUndo ? (
        <button type="button" className="fw-rt-undo" aria-label={t('undo.label', { seconds: left })} onClick={onUndo}>
          {t('undo.button', { seconds: left })}
        </button>
      ) : (
        <span>{t('undo.button', { seconds: left })}</span>
      )}
    </>
  )
}

// ── F-SA-244 ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A change's line draws when it has something to say (a chip, a told time, or the page's Who was told door). */
const changeShown = (change: CardChange, actions: CardActions | undefined): boolean => Boolean(changeChip(change) || change.floorAt || change.workshopAt || actions?.onWhoWasTold)

/** "Request · waiting on us · Answer…" under the customer's ask (the chip lives: it reads the request as the page reads it now). */
function AskLine({ ask, foot }: { ask: CardAsk; foot?: ReactNode }) {
  const t = useT('record-thread-card')
  const chip = askChip(ask)
  // tw- W2.2 (10-design §12 home 38): the chip in the bubble; Answer… is a row of the message's menu.
  return (
    <p className="fw-rt-details fw-rt-change">
      <Pill tone={chip.tone}>{t(chip.key, chip.params)}</Pill>
      {foot}
    </p>
  )
}

/** "Still to do: 2 · Told the floor at 10:42 · Told the workshop at 10:44 · Who was told…" under a change's line (never who read it). */
function ChangeLine({ messageId, change, actions, foot }: { messageId: string; change: CardChange; actions?: CardActions | undefined; foot?: ReactNode }) {
  const t = useT('record-thread-card')
  const locale = useLocale()
  const chip = changeChip(change)
  const onStill = actions?.onStillToDo
  const onTold = actions?.onWhoWasTold
  if (!changeShown(change, actions)) return null
  return (
    <p className="fw-rt-details fw-rt-change">
      {chip && chip.door && onStill ? (
        <Button size="xs" variant="warning" onClick={() => onStill(messageId)}>
          {t(chip.key, chip.params)}
        </Button>
      ) : chip ? (
        <Pill tone={chip.tone}>{t(chip.key, chip.params)}</Pill>
      ) : null}
      {change.floorAt && <span>{t('change.floor', { time: timeOf(change.floorAt, locale) })}</span>}
      {change.workshopAt && <span>{t('change.workshop', { time: timeOf(change.workshopAt, locale) })}</span>}
      {onTold && (
        <Button size="xs" variant="link" onClick={() => onTold(messageId)}>
          {t('change.whoWasTold')}
        </Button>
      )}
      {foot}
    </p>
  )
}
