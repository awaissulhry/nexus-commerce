'use client'

import { Fragment, useId, useState, type AnimationEvent, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { CornerDownRight, EyeOff, FileText, ImageIcon, Lock, Pin, Trash2 } from 'lucide-react'
import { INTL_LOCALE } from '../../../i18n/locales'
import { useLocale, useT } from '../../../i18n/provider'
import { FLASH_MS } from '../../feed/model'
import type { RunPlace } from '../../feed/runs'
import { Avatar } from '../../parts/Avatar'
import { timeOf } from '../../parts/time'
import type { SenderTone } from '../../parts/tones'
import { fileKindKey, longFold, sizeWords, type CardAction, type CardFiles, type CardLink } from '../model'
import { Bubble, BubbleFoot } from './Bubble'
import { MessageMenu, opensOnRightClick } from './MessageMenu' // tw- W2.2
import { QuoteBlock } from './QuoteBlock'
import '../card.css'

/**
 * pt-w1 W1.1 (lane pt-, S2; ONE SHARED THREAD): the NARROW message row — what ONE message of a thread draws in BOTH doors. The office
 * card (MessageCard) fills it from its message; the portal's partner face from its own read (pt-w2). It has NO audience, note, author
 * id, amount, email, mail or office field (the wall, held by its type and a source scan): the office card's kind reaches it as its CSS
 * class only (`kindClass`), and the office's own lines — the amount, an ask, a change, a bounce, Not sent, Undo, the delivery mark, who
 * reads it — are the card's, drawn into the row's slots.
 */
export interface RowModel {
  readonly id: string
  /** ISO instant (UTC): the time in the foot. */
  readonly at: string
  /** The host's kind as a class (`is-theirs`, `is-ours`, …): its CSS look only, never read here. */
  readonly kindClass: string
  /** The row's name for a screen reader, in the host's own words (who, for whom, when). */
  readonly ariaLabel: string
  /** Who wrote it, in words: the name line and the menu arrow's name. */
  readonly who: string
  /** The tile's person (null: the "?" tile, a writer the site's gate keeps back). */
  readonly face: string | null
  /** Their company on the name line, when it is not the reader's own (null: none). */
  readonly org: string | null
  /** The sender's ONE colour in this list. */
  readonly tone: SenderTone
  /** Its words (the repeated part of a mail behind "…"), erased after a privacy request, or none (files only). */
  readonly words: RowWords
  /** The @names coloured in the words. */
  readonly names?: readonly string[]
  /** On its way, or not sent: the row's look (the host says it in the foot or a line). */
  readonly pending?: boolean
  readonly failed?: boolean
  /** What it corrects and what it answers — its OWN links, as the server sent them for this reader (R1). */
  readonly corrects?: CardLink | null
  readonly replyTo?: CardLink | null
  /** The newest message that corrects it ("Corrected"). */
  readonly correctedBy?: { readonly id: string } | null
  /** Its files as this reader sees them (`cardFiles`): pictures, rows, held ones; what the reader may not open counted, never named. */
  readonly files: CardFiles
  readonly pinned?: boolean
}

/** A row's words: the text and the repeated part of a mail (behind "…"); `erased`: removed after a privacy request; null: none. */
export type RowWords = { readonly text: string; readonly quoted: string | null } | 'erased' | null

/** What a host does from a row (absent: drawn, nothing to click): the quote's and the correction's jump, a file, the album's "+N". */
export interface RowActions {
  onJump?: ((messageId: string) => void) | undefined
  onOpenFile?: ((fileId: string) => void) | undefined
  /** "+14": the message's other files (the office's Files view); without it the row shows them all in place. */
  onMoreFiles?: ((messageId: string) => void) | undefined
}

/** The row's ONE menu: its rows in ONE order (the host's), the pick, and Answer…'s own address (null: a plain row). */
export interface RowMenu {
  readonly rows: readonly CardAction[]
  readonly onPick: (action: CardAction) => void
  readonly answerHref?: string | null
}

/** tw- W1.3: the row lights up after a jump (FLASH_MS), then says it ended. */
export interface RowFlash {
  readonly seq: number
  readonly onEnd: () => void
}

/** The attributes of a lit row (none when it is not lit). */
export interface RowLit {
  readonly 'data-flash'?: string
  readonly style?: CSSProperties
  readonly onAnimationEnd?: (event: AnimationEvent<HTMLElement>) => void
}

/** A line under the words: drawn by the row, the foot placed in the LAST of them (the time sits at the end of the last line). */
export interface TailLine {
  readonly key: string
  readonly draw: (foot: ReactNode) => ReactNode
}

/** An album shows at most this many tiles; past it the 4th tile says "+N" (W-041). */
const ALBUM_TILES = 4

/** tw- W1.3: the jump's flash on the whole row — the one named constant, cleared when its animation ends (no timer). */
export function rowFlash(flash: RowFlash | null): RowLit {
  return flash
    ? {
        'data-flash': '',
        style: { '--fw-rt-flash-ms': `${FLASH_MS}ms` } as CSSProperties,
        onAnimationEnd: (event: AnimationEvent<HTMLElement>) => {
          if (event.target === event.currentTarget && event.animationName.startsWith('fw-rt-flash')) flash.onEnd()
        },
      }
    : {}
}

/**
 * One message row as a chat bubble (tw- W1.2; THE THREAD REBUILD, 10-design §2 – §5), the same in both doors: the row is the whole list
 * width (`.fw-rt-msg`, the row a jump lights up); mine on the right with no tile and no name, everyone else on the left with the 28 px
 * tile of the PERSON on a run's first bubble and their name in their own colour (with their company when it is not the reader's own).
 * Inside, top to bottom: "Correction of 09:12", the quote (both from the message's OWN links, R1), the host's top slot; the album of
 * tiles (2 × 2, "+N") or the file rows; the words (links open, @names coloured, quoted text and the signature behind "…", a long text
 * after 12 lines behind "Show all"); the host's lines; what the reader may not open, counted; the foot at the end of the last line —
 * the pin, the host's start, "Corrected", the host's marks, the time (or the host's), the host's end. The ONE menu: the arrow on hover
 * and keyboard focus, or a right-click. An article named by the host's words for screen readers.
 */
export function MessageRow({
  message,
  context,
  actions,
  run,
  flash = null,
  paper = false,
  readOnly = false,
  menu = null,
  top,
  lines,
  foot: footSlots,
}: {
  message: RowModel
  /** The list's colours by sender key: the quote's bar takes the quoted person's (tw- fx2, G-7). */
  context: { readonly tones?: ReadonlyMap<string, SenderTone> | undefined }
  actions?: RowActions | undefined
  /** Its place in the run (the feed's). */
  run: RunPlace
  flash?: RowFlash | null
  /** tw- W1.4 (R18): paper — its name on every message, no tile. */
  paper?: boolean
  /** F-SA-261: read only (All of <Customer>) — "Corrected" is a word, not a door. */
  readOnly?: boolean
  menu?: RowMenu | null
  /** Under the quote, before the files (the office's "Show on the page"). */
  top?: ReactNode
  /** The host's own lines: after the words, and at the end. */
  lines?: { readonly words?: readonly TailLine[]; readonly end?: readonly TailLine[] }
  /** The host's own parts of the foot: after the pin, who reads it (its marks), in the time's place, after the time. */
  foot?: { readonly start?: ReactNode; readonly marks?: ReactNode; readonly time?: ReactNode; readonly end?: ReactNode }
}) {
  const t = useT('record-thread-card')
  const pricedWords = useT('record-files') // B-CP-014: a priced document's lock (record-files.json priced.*; THREAD_NAMESPACES loads it)
  const locale = useLocale()
  const intl = INTL_LOCALE[locale]
  const quotedId = useId()
  const [quotedOpen, setQuotedOpen] = useState(false)
  const [allShown, setAllShown] = useState(false)
  const [allFiles, setAllFiles] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false) // tw- W2.2: the arrow or a right-click opens it

  const time = timeOf(message.at, locale)
  const place = run
  // B-TH-255 (T3-F14): an erased message says why its words are gone; a message that only carries files draws no empty body.
  const body = message.words === 'erased' ? 'erased' : message.words ? 'text' : 'none'
  const { text, quoted } = message.words && message.words !== 'erased' ? message.words : { text: '', quoted: null }
  const fold = longFold(text)
  const folded = fold.folds && !allShown
  const files = message.files
  const tone = message.tone
  const cls = ['fw-rt-msg', message.kindClass, body === 'erased' ? 'is-erased' : '', message.pending ? 'is-pending' : '', message.failed ? 'is-failed' : '', `is-${place.side}`, place.first ? 'is-start' : ''].filter(Boolean).join(' ')
  const lit = rowFlash(flash)

  // ── the name line: the person, and their company when it is not the reader's own (P3) ────────────────────────────────
  const name = paper || place.showName ? { text: message.who, org: paper ? null : message.org } : null
  const names = message.names ?? []

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
  // The host's lines after the words (the office: the amount, the customer's ask, a change's line).
  tail.push(...(lines?.words ?? []))
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
  // The host's lines at the end (the office: files a mail did not keep, a bounce, Not sent · Retry, who reads it on paper).
  tail.push(...(lines?.end ?? []))
  if (tail.length === 0) tail.push({ key: 'foot', draw: (foot) => <p className="fw-rt-bline is-foot">{foot}</p> })

  // ── the foot: the pin, the host's start, "Corrected", who reads it (the host's marks), the time (or the host's), the host's end ──
  const timeWords = <time dateTime={message.at}>{time}</time>
  const onJump = actions?.onJump
  const correctedBy = message.correctedBy ?? null
  const foot = (
    <BubbleFoot>
      {message.pinned && <FootIcon className="fw-rt-pinned" word={t('foot.pinned')} icon={<Pin size={13} aria-hidden />} />}
      {footSlots?.start}
      {correctedBy &&
        (onJump && !readOnly ? (
          <button type="button" className="fw-rt-corrected" onClick={() => onJump(correctedBy.id)}>
            {t('foot.corrected')}
          </button>
        ) : (
          <span className="fw-rt-corrected">{t('foot.corrected')}</span>
        ))}
      {footSlots?.marks}
      {footSlots?.time ?? timeWords}
      {footSlots?.end}
    </BubbleFoot>
  )

  const rows = menu?.rows ?? []
  const tools =
    menu && rows.length > 0 ? (
      <MessageMenu rows={rows} label={t('menu.label', { author: message.who, time })} open={menuOpen} onOpenChange={setMenuOpen} onPick={menu.onPick} answerHref={menu.answerHref ?? null} />
    ) : null
  // tw- W2.2 (W-060): a right-click on the message opens the same menu (a link or selected text keeps the browser's own).
  const onContextMenu =
    rows.length > 0
      ? (event: MouseEvent<HTMLElement>) => {
          if (!opensOnRightClick(event, typeof window === 'undefined' ? '' : (window.getSelection()?.toString() ?? ''))) return
          event.preventDefault()
          setMenuOpen(true)
        }
      : undefined

  return (
    <article className={cls} id={`message-${message.id}`} data-message-id={message.id} data-feed-item={message.id} tabIndex={-1} aria-label={message.ariaLabel} onContextMenu={onContextMenu} {...lit}>
      {place.side === 'others' && place.first && !paper && <Avatar name={message.face} size="run" tone={tone} />}
      <Bubble model={{ side: place.side, run: { first: place.first, last: place.last }, name, senderTone: tone }} tools={tools}>
        {/* TOP: the correction, the quote — both from this message's OWN links (R1) — and the host's top slot. */}
        {message.corrects && <CorrectionLink link={message.corrects} onJump={onJump} />}
        {message.replyTo && <QuoteBlock link={message.replyTo} onJump={onJump} tones={context.tones} />}
        {top}
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
export function FootIcon({ icon, word, className }: { icon: ReactNode; word: string; className?: string | undefined }) {
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
