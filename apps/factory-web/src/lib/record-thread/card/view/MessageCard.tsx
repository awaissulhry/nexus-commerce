'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { Bell, Check, CheckCheck, CircleAlert, Clock, FileX, Globe, Layers, Lock, Mail, RotateCw, Tablet, Undo2 } from 'lucide-react'
import { Button, Pill } from '@nexus/ui/primitives'
import { formatDate } from '../../../i18n/format'
import { INTL_LOCALE } from '../../../i18n/locales'
import { useLocale, useT } from '../../../i18n/provider'
import type { RunPlace } from '../../feed/runs'
import { timeOf } from '../../parts/time'
import { senderTone } from '../../parts/tones'
import {
  // B-TH-236: the amount, Undo.
  amountWords,
  showsUndo,
  undoLeft,
  type CardAction,
  audienceKey,
  authorWords,
  cardActions,
  cardFiles,
  copyTextOf, // tw- W2.5
  READ_ONLY_MENU, // tw- W2.5
  deliveryMark,
  footMarks,
  splitQuoted,
  type CardContext,
  type CardMessage,
} from '../model'
import { bodyKind, skippedLine } from '../model' // B-TH-255
import { askChip, changeChip, type CardAsk, type CardChange } from '../model' // F-SA-244
import { FootIcon, MessageRow, rowFlash, type TailLine } from './MessageRow' // pt-w1 W1.1: the row both doors draw
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
 * pt-w1 W1.1 (lane pt-, S2): the row itself — the article, the tile, the bubble, the quote, the files, the words, what is counted, the
 * foot, the menu — is `MessageRow`, the same in both doors; the card keeps every office line and fills the row's slots with them.
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
  const locale = useLocale()
  const intl = INTL_LOCALE[locale]

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
  const tone = (message.senderKey ? context.tones?.get(message.senderKey) : undefined) ?? senderTone(message.senderKey) // tw- fx2 (G-7)
  const cls = ['fw-rt-msg', `is-${message.kind}`, body === 'erased' ? 'is-erased' : '', sending ? 'is-pending' : '', failed ? 'is-failed' : '', system ? 'is-system' : `is-${place.side}`, place.first ? 'is-start' : ''].filter(Boolean).join(' ')
  // tw- W1.3: the jump's flash on the whole row — the one named constant, cleared when its animation ends (pt-w1: MessageRow's rowFlash).
  const lit = rowFlash(flash)

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
  const names = message.mentions.filter((one): one is string => one !== null)

  // ── the office's own lines under the words (pt-w1 W1.1: the row draws the words, what is counted, and the foot in the last line) ──
  const tail: TailLine[] = []
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
  // ── the office's own lines at the end (after what the reader may not open, which the row counts) ──
  const end: TailLine[] = []
  // B-TH-255 (T3-F15): what an inbound mail brought that was not kept, by name and why (office only; never a signature logo).
  if (skipped) {
    end.push({
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
    end.push({
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
    end.push({
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
    end.push({
      key: 'audience',
      draw: (foot) => (
        <p className="fw-rt-bline is-quiet fw-rt-audwords">
          <span>{t(audienceKey(message), { party })}</span>
          {foot}
        </p>
      ),
    })
  }

  // ── the office's own parts of the foot: the follow-up bell, who reads it, Sending · Undo, our email's delivery mark ─────────────
  const delivery = message.kind === 'ours' && mail && !message.outbox ? deliveryMark(mail.status) : null
  const DeliveryIcon = delivery ? DELIVERY_ICON[delivery.icon] : null
  const timeWords = <time dateTime={message.at}>{time}</time>
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

  // pt-w1 W1.1: the row both doors draw — the message's OWN links (R1), its files as this reader sees them, the office's lines in its slots.
  return (
    <MessageRow
      message={{
        id: message.id,
        at: message.at,
        kindClass: `is-${message.kind}`,
        ariaLabel: label,
        who: author,
        face: message.authorHidden ? null : message.author,
        org,
        tone,
        words: body === 'erased' ? 'erased' : body === 'text' ? { text, quoted } : null,
        names,
        pending: sending,
        failed,
        corrects: message.corrects,
        replyTo: message.replyTo,
        correctedBy: message.correctedBy,
        files,
        pinned: message.pinned,
      }}
      context={context}
      actions={actions}
      run={place}
      flash={flash}
      paper={paper}
      readOnly={readOnly}
      menu={{ rows: menu, onPick: pick, answerHref: message.ask ? (actions?.answerHref?.(message.ask.requestId) ?? null) : null }}
      // F-SA-265: a message about a part of its record (a line, a shipment…) jumps back to its row on the page.
      top={!readOnly && message.about && actions?.onShowOnPage && (
        <button type="button" className="fw-rt-about" onClick={() => actions.onShowOnPage?.(message.id)}>
          <Layers size={12} aria-hidden />
          {frameWords('discuss.showOnPage')}
        </button>
      )}
      lines={{ words: tail, end }}
      foot={{
        /* tw- W2.2 (10-design §2 "Foot"): the reader's own follow-up on their message — a bell, for its sender only. */
        start: message.followUp && message.mine && <FootIcon className="fw-rt-followup" word={t('foot.followUp', { date: formatDate(message.followUp.at, { locale }) })} icon={<Bell size={13} aria-hidden />} />,
        marks: footMarks(message).map((mark) => {
          const Icon = MARK_ICON[mark.icon]
          return <FootIcon key={mark.key} className={mark.icon === 'lock' ? 'fw-rt-lock' : undefined} word={t(mark.key)} icon={<Icon size={13} aria-hidden />} />
        }),
        time:
          !readOnly /* F-SA-261 */ && mail && showsUndo(message, context.now ?? Date.now()) ? (
            <UndoFoot until={mail.undoUntil!} start={context.now} onUndo={actions?.onUndo ? () => actions.onUndo?.(message.id) : undefined} done={timeWords} />
          ) : sending ? (
            <span>{t('outbox.sending')}</span>
          ) : (
            timeWords
          ),
        end: delivery && DeliveryIcon && mail && <FootIcon className={delivery.tone === 'bad' ? 'is-bad' : 'is-ok'} word={t(`delivery.${mail.status}`)} icon={<DeliveryIcon size={13} aria-hidden />} />,
      }}
    />
  )
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
