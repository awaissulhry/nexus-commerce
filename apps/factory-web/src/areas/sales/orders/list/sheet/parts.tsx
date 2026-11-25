'use client'

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { Filter, Hand, X } from 'lucide-react' // F-MS-104: + Hand
import { Button, FilterChip, Pill, Tag, Tooltip } from '@nexus/ui/primitives' // F-SA-275: + Pill; F-MS-104: + Tooltip
import { STAGE_SET_CHECK_DAYS } from '@nexus/factory-domain/production-brand/stage-set' // F-MS-104
import type { Door, Phrase } from './model'
import './sheet.css'
import './chips.css' // F-CW-101: the chips' own styles (a new file beside the new parts)
// ---- F-SA-275: the production columns' cells (the shared health chip and the production parts' words, the supervisor marks) ----
import { HealthPill } from '../../../../../lib/production/view/HealthPill'
import { ageOf } from '../../../../../lib/production/model'
import { useProductionWords } from '../../../../../lib/production/words'
import { formatDate } from '../../../../../lib/i18n/format' // F-CW-102: a deposit's due day
import { useLocale } from '../../../../../lib/i18n/provider' // F-CW-102
import type { OrderRow } from '../../api'
import { STATUS_TONE } from '../../model'
import { answerHrefOf, supervisorCellOf, waitingItemsOf, type WaitingMark } from './model'
// ---- end F-SA-275
// ---- F-CW-102: the row's chips (Where it is, Customer urgency) and the New messages bubble ----
import { Banknote, CirclePause, Hourglass, Lock, MessageSquare } from 'lucide-react'
import { romeToday } from '../../model'
import { cellOf as unreadCellOf, type Unread } from '../../../../../lib/last-message-cell/model'
import { dockClick } from '../../../../../lib/last-message-cell/view/LastMessageCell'
import { healthChipOf, orderHref, piecesPartsOf, priorityChipOf, stageChipOf, stopChipOf, urgencyChipOf, type PiecesPart, type StopChip } from './model'
import { PHASE_ICON } from '../../../../../lib/order-groups/groups' // pg-w1: the group marks of both faces
// ---- end F-CW-102

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string
const say = (t: Translate, phrase: Phrase) => t(phrase.key, phrase.params)

/**
 * B-TH-225 / B-TH-226 — the parts of the Orders sheet the design system does not have (Owner yes on decision 2: they live in
 * factory-web): the door (a real link in the link colour, or plain words with the reason when the reader may not open it), the
 * peek card (a link that shows a small card after half a second of rest or on focus; Space opens it at once), the funnel
 * button (a value that narrows the sheet, never a page) and the chips row (F-SA-224: the Customer switcher is areas/sales/_shared). Words: the `orders-sheet`
 * catalogue. F-SA-212: the Picture cell and its viewer are the ONE picture part (lib/record-picture).
 */

// ---- doors -------------------------------------------------------------------------------------------------------------------

/** A cell's value as its door: the link (⌘-click: a new tab), the words with the reason on hover, or plain words. */
export function DoorCell({ door, t, children, strong }: { door: Door; t: Translate; children: ReactNode; strong?: boolean }) {
  if (door && 'href' in door)
    return (
      <Link className={strong ? 'fw-sheet-door strong' : 'fw-sheet-door'} href={door.href} title={say(t, door.tip)} data-door="">
        {children}
      </Link>
    )
  if (door && 'held' in door)
    return (
      <span className="fw-sheet-held" tabIndex={0} title={say(t, door.held)} aria-label={`${typeof children === 'string' ? children : ''} — ${say(t, door.held)}`.replace(/^ — /, '')}>
        {children}
      </span>
    )
  return <span className="fw-sheet-plain">{children}</span>
}

/** A value that narrows the sheet (Brand, Status, Company): a button with the funnel mark, never a page. */
export function FunnelButton({ tip, onClick, children }: { tip: string; onClick?: () => void; children: ReactNode }) {
  return (
    <button type="button" className="fw-sheet-funnel" title={tip} aria-label={tip} onClick={onClick} disabled={!onClick}>
      <span className="fw-sheet-funnel-value">{children}</span>
      <Filter size={12} aria-hidden />
    </button>
  )
}

// ---- the peek card -----------------------------------------------------------------------------------------------------------

const PEEK_AFTER = 500
const PEEK_CLOSE = 300

/**
 * A door with a peek (grid-F30): the link opens its thing on a click; resting on it half a second (or focusing it) shows a small
 * card under it, which stays while the pointer moves onto it and closes 300 ms after it leaves; Space on the link opens the card
 * at once and moves into it; Esc closes it and returns to the link. Touch: no peek, a tap opens.
 */
export function PeekLink({ href, className, label, children, card }: { href: string; className?: string; label: string; children: ReactNode; card: () => ReactNode }) {
  const anchor = useRef<HTMLAnchorElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [moveIn, setMoveIn] = useState(false)

  const later = (next: boolean, ms: number) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(next), ms)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  useLayoutEffect(() => {
    if (!open || !anchor.current) return
    const rect = anchor.current.getBoundingClientRect()
    const height = panel.current?.offsetHeight ?? 160
    const width = panel.current?.offsetWidth ?? 280
    const below = rect.bottom + 6 + height <= window.innerHeight - 8
    setPos({ top: below ? rect.bottom + 6 : Math.max(8, rect.top - 6 - height), left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) })
  }, [open])
  useEffect(() => {
    if (open && moveIn) panel.current?.querySelector<HTMLElement>('a, button')?.focus()
  }, [open, moveIn, pos])
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('scroll', close, true)
    return () => window.removeEventListener('scroll', close, true)
  }, [open])

  const onKey = (event: ReactKeyboardEvent) => {
    if (event.key === ' ') {
      event.preventDefault()
      event.stopPropagation()
      clearTimeout(timer.current)
      setMoveIn(true)
      setOpen(true)
    } else if (event.key === 'Escape' && open) {
      event.stopPropagation()
      setOpen(false)
    }
  }

  return (
    <>
      <Link
        ref={anchor}
        href={href}
        className={className}
        data-door=""
        aria-haspopup="dialog"
        aria-expanded={open}
        onPointerEnter={(event) => (event.pointerType === 'touch' ? undefined : later(true, PEEK_AFTER))}
        onPointerLeave={(event) => (event.pointerType === 'touch' ? undefined : later(false, PEEK_CLOSE))}
        onFocus={() => {
          setMoveIn(false)
          later(true, PEEK_AFTER)
        }}
        onBlur={(event) => {
          if (panel.current?.contains(event.relatedTarget as Node | null)) return
          later(false, PEEK_CLOSE)
        }}
        onKeyDown={onKey}
      >
        {children}
      </Link>
      {open &&
        createPortal(
          <div
            ref={panel}
            className="nds-detailpop fw-sheet-peek"
            role="dialog"
            aria-label={label}
            style={{ position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
            onMouseEnter={() => clearTimeout(timer.current)}
            onMouseLeave={() => later(false, PEEK_CLOSE)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              event.stopPropagation()
              setOpen(false)
              anchor.current?.focus()
            }}
            onBlur={(event) => {
              if (panel.current?.contains(event.relatedTarget as Node | null) || event.relatedTarget === anchor.current) return
              later(false, PEEK_CLOSE)
            }}
          >
            {card()}
          </div>,
          document.body,
        )}
    </>
  )
}

/** A peek card's body: its title, rows of facts, a last line and the Open link. */
export function PeekCard({ title, rows, note, open }: { title: ReactNode; rows: ReadonlyArray<[string, ReactNode]>; note?: ReactNode; open: { href: string; label: string } }) {
  return (
    <>
      <p className="nds-detailpop-h">{title}</p>
      <dl className="fw-sheet-peek-rows">
        {rows.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {note && <p className="nds-detailpop-note">{note}</p>}
      <p className="nds-detailpop-foot">
        <Link className="fw-sheet-door" href={open.href}>
          {open.label}
        </Link>
      </p>
    </>
  )
}

// ---- the chips row ---------------------------------------------------------------------------------------------------------------

export interface SheetChip {
  readonly id: string
  readonly label: string
  /** F-SA-221: none — the page holds the term (the Made-to-measure page's "Made to measure"): a fixed chip without ✕. */
  readonly onClear?: (() => void) | null
  /** F-CW-101: quiet words beside the chip that say what it holds (a phase's whys: "1 waits for a yes · 1 waits for the deposit"). */
  readonly note?: string | null
}

/** Every narrowing as a chip with ✕ (grid-F25: nothing filters the sheet that is not a chip); Clear all from two on. */
// F-SA-221: a term the page holds is a fixed chip (said, never removable); Clear all counts the removable ones and keeps it.
export function SheetChips({ chips, t, onClearAll }: { chips: readonly SheetChip[]; t: Translate; onClearAll: () => void }) {
  if (chips.length === 0) return null
  const removable = chips.filter((chip) => chip.onClear)
  return (
    <div className="fw-sheet-chips" role="group" aria-label={t('chips.label')}>
      {chips.map((chip) => {
        const drawn = chip.onClear ? (
          <FilterChip key={chip.id} pressed onClick={chip.onClear} aria-label={t('chips.remove', { name: chip.label })}>
            {chip.label} <X size={12} aria-hidden />
          </FilterChip>
        ) : (
          <Tag key={chip.id} tone="info">
            {chip.label}
          </Tag>
        )
        // F-CW-101: a chip may say in quiet words what it holds (never a second chip).
        return chip.note ? (
          <span key={chip.id} className="fw-sheet-chip-noted">
            {drawn}
            <span className="fw-sheet-chip-note">{chip.note}</span>
          </span>
        ) : (
          drawn
        )
      })}
      {removable.length > 1 && (
        <Button size="sm" variant="link" onClick={onClearAll}>
          {t('chips.clearAll')}
        </Button>
      )}
    </div>
  )
}

// F-SA-224: the Customer switcher moved to areas/sales/_shared/customer-switcher (one customer filter for every Sales list).

// ── F-SA-275 (sales page plan N5 / N2, picks R5, P10, P4; 11-customer-page §3.5): Where it is, Waiting on, Supervisor ──────────────

// ── F-MS-104 ──
/**
 * F-MS-104 (04 §5, R17): beside a stage set by hand, a 12 px hand (aria-hidden) and the same words for a screen reader; the DS
 * Tooltip says the order holds who and why (no name, no reason in the list). Amber once it was set 7 days ago or more, and then the
 * words say "check it" too (never the colour alone). Part of the stage, not a third mark: the dense cell keeps the stage and health.
 */
export function ByHandMark({ old, t }: { old: boolean; t: Translate }) {
  const days = STAGE_SET_CHECK_DAYS
  return (
    <Tooltip label={t(old ? 'list.byHand.oldTip' : 'list.byHand.tip', { days })} portal>
      <span className={old ? 'fw-sheet-hand old' : 'fw-sheet-hand'} data-by-hand={old ? 'old' : ''}>
        <Hand size={12} aria-hidden />
        <span className="nds-vh">{t(old ? 'list.byHand.oldMark' : 'list.byHand.mark', { days })}</span>
      </span>
    </Tooltip>
  )
}
// ── end F-MS-104 ──

/**
 * Where it is: the plain stage (the words the customer reads too) and the health chip (no "why" in a dense cell), then this order's
 * own pieces ("120 of 300 sewn") or "Sewing not counted here" (never 0). No stage kept (waiting for a yes, shipped, closed…): the
 * order's status. Not read: "—". F-MS-104: a stage set by hand carries its mark (ByHandMark); the customer page's Work tab draws
 * this same cell.
 * F-CW-102 (10-design §3.5; lead settles S3, S13, S15, S38) — the chips cell, the same on every host of the ONE sheet. Line 1 = up to
 * three chips, never cut: (1) the stage with its group's mark — the order's real status word where no stage is "now" (Partly
 * shipped with its pieces); (2) the health, only Late / At risk; (3) the ONE thing that stops it or who it waits on (a door where
 * there is one: On hold → the order's Production tab, a request → its review). Line 2 = this order's own pieces ("Sewn 152 of 244 ·
 * 24 ready now"), quiet. The chips WRAP whole (never half a chip): when they need two lines the pieces line gives way for that row
 * (it stays in the cell's tooltip; the row keeps its height). `dense` (a narrow cell beside the dock): chip 3 keeps its head — its
 * tail ("· due 25 Nov", "· 3 d") and its mark go to its tooltip. F-CP-107 (cp-fx16) stays: with the Status column on screen a
 * status word is never said twice.
 */
export function WhereItIsCell({ row, t, s, statusShown = false, waitingShown = false, mark, prefix, doorHref, today, now, dense = false, half }: { row: OrderRow; t: Translate; s: Translate; statusShown?: boolean; /** cw fx5 (walk W-29): the Waiting on column is on screen — chip 3 never repeats it. */ waitingShown?: boolean; mark?: WaitingMark | null; prefix?: string; doorHref?: ((requestId: string) => string) | null; today?: string; now?: number; dense?: boolean; /** cw fx5 (walk W-13): one half for the phone card — its chips (they wrap freely), or its pieces line (it wraps, never cut); nothing to say: nothing drawn. */ half?: 'chips' | 'pieces' }) {
  const w = useProductionWords()
  const locale = useLocale()
  const stage = stageChipOf(row)
  // Not read (the production part comes with the column): nothing is guessed.
  if (!stage) return half ? null : <span className="fw-sheet-plain">—</span>
  const health = healthChipOf(row)
  const stop = stopChipOf(row, mark, today ?? romeToday(), waitingShown)
  const pieces = piecesPartsOf(row)
  // F-CP-107 (cp-fx16): the same fact never twice in one row — a status word is not repeated beside the Status column.
  const first = stage.kind === 'status' && statusShown ? null : stage
  const piecesText = pieces.map((part) => (part.kind === 'stage' ? w.t(`parts.stage.${part.stage}`) : piecesWords(part, t, s, w.t))).join(' · ')
  const piecesLine =
    pieces.length > 0 ? (
      <span className={half === 'pieces' ? 'fw-sheet-wi-pcs is-wrap' : 'fw-sheet-wi-pcs'}>
        {pieces.map((part, index) => (
          <Fragment key={index}>
            {index > 0 && ' · '}
            {part.kind === 'stage' ? (
              <>
                <b>{w.t(`parts.stage.${part.stage}`)}</b>
                {part.byHand && <ByHandMark old={part.byHand.old} t={t} />}
              </>
            ) : part.strong ? (
              <b>{piecesWords(part, t, s, w.t)}</b>
            ) : (
              piecesWords(part, t, s, w.t)
            )}
          </Fragment>
        ))}
      </span>
    ) : null
  if (half === 'pieces') return piecesLine
  if (!first && !health && !stop) return half ? null : (piecesLine ?? <span className="fw-sheet-plain">—</span>)
  const Icon = first ? PHASE_ICON[first.phase] : null
  return (
    <span className={half === 'chips' ? 'fw-sheet-wi is-card' : dense ? 'fw-sheet-wi is-dense' : 'fw-sheet-wi'} title={half === 'chips' ? undefined : piecesText || undefined}>
      {first && Icon && first.kind === 'stage' && (
        <Pill tone="info" icon={<Icon size={11} aria-hidden />} className="fw-sheet-st">
          <b>{w.t(`parts.stage.${first.stage}`)}</b>
          {first.byHand && <ByHandMark old={first.byHand.old} t={t} /> /* F-MS-104 */}
        </Pill>
      )}
      {first && Icon && first.kind === 'status' && (
        <Pill tone={STATUS_TONE[first.status]} icon={<Icon size={11} aria-hidden />} className={first.status === 'CLOSED' ? 'fw-sheet-st is-line' : 'fw-sheet-st'}>
          {t(`status.${first.status}`)}
          {first.shipped ? ` · ${s('shippedOf', first.shipped)}` : ''}
        </Pill>
      )}
      {health && <HealthPill face="office" explain={false} computed={health} daysLate={row.daysLate} />}
      {stop && <StopChipPart chip={stop} row={row} t={t} s={s} prefix={prefix} doorHref={doorHref} dense={dense} now={now ?? Date.now()} date={(day) => formatDate(`${day}T12:00:00Z`, { locale })} />}
      {half !== 'chips' && piecesLine}
    </span>
  )
}

/** One part of the pieces line in words: the sheet's, the `orders` catalogue's (shipped) or the production parts' (sewing not counted). */
function piecesWords(part: Extract<PiecesPart, { kind: 'words' }>, t: Translate, s: Translate, production: Translate): string {
  const words = part.words
  return words.production ? production(words.key, words.params) : words.orders ? t(words.key, words.params) : s(words.key, words.params)
}

/**
 * F-CW-102: chip 3 — the ONE thing that stops the order or who it waits on, in the approved words (the orders', the sheet's and the
 * production parts' own): its head always whole; its tail and its mark give way in a dense cell (they stay in its tooltip).
 */
function StopChipPart({ chip, row, t, s, prefix, doorHref, dense, now, date }: { chip: StopChip; row: OrderRow; t: Translate; s: Translate; prefix?: string | undefined; doorHref?: ((requestId: string) => string) | null | undefined; dense: boolean; now: number; date: (day: string) => string }) {
  const w = useProductionWords()
  const age = (since: string | null): string | null => {
    const phrase = ageOf(since, now)
    return phrase ? w.say(phrase) : null
  }
  let head: string
  let tail: string | null = null
  let tone: 'warning' | 'danger' | 'neutral' = 'warning'
  let Icon: typeof Hourglass = Hourglass
  let href: string | null = null
  let tip: string | null = null
  if (chip.kind === 'credit') head = t('waits.credit')
  else if (chip.kind === 'review') head = t('waits.review')
  else if (chip.kind === 'deposit') {
    Icon = Banknote
    tone = chip.overdue ? 'danger' : 'warning'
    head = chip.overdue ? s('stop.depositOverdue') : chip.extra ? s('stop.depositExtra') : t('board.deposit.OPEN')
    tail = chip.due ? (chip.overdue ? date(chip.due) : t('list.depositDue', { date: date(chip.due) })) : null
  } else if (chip.kind === 'reaccept') head = s('stop.reaccept')
  else if (chip.kind === 'held') {
    Icon = CirclePause
    head = t('production.held')
    href = prefix !== undefined ? orderHref(prefix, row, 'production') : null
    tip = s('stop.heldTip', { number: row.number })
  } else if (chip.kind === 'request') {
    Icon = MessageSquare
    head = chip.count > 1 ? s('waiting.requests', { count: chip.count }) : s('waiting.request')
    href = prefix !== undefined ? answerHrefOf(prefix, row, { kind: 'request', count: chip.count, requestId: chip.requestId }, doorHref) : null
    tip = s('waiting.answerTip', { number: row.number })
  } else if (chip.kind === 'reply') {
    Icon = MessageSquare
    head = s('waiting.reply', { time: age(chip.since) ?? '—' }) // the Waiting on cell's own words, whole
  } else {
    tone = 'neutral'
    head = w.t(`parts.waiting.office.${chip.on}`)
    tail = age(chip.since)
  }
  const full = tail ? `${head} · ${tail}` : head
  const body = (
    <Tag tone={tone} className={tone === 'neutral' ? 'fw-sheet-stop is-dash' : 'fw-sheet-stop'} title={href ? undefined : (tip ?? full)}>
      {!dense && <Icon size={11} aria-hidden />}
      {head}
      {tail && !dense && ` · ${tail}`}
    </Tag>
  )
  if (!href) return body
  return (
    <Link href={href} className="fw-sheet-chip-door" data-door="" title={tip ?? full}>
      {body}
    </Link>
  )
}

/**
 * F-CW-102 (10-design §3.5; lead settles S6, S7, S31): the Customer urgency cell — READ ONLY. The customer's own mark as its chip
 * says it: "Urgent 2" (its place in the customer's OWN urgent list: never a place in our plan), "Urgent – asked" (dashed: its
 * request waits on us), "Set to regular by us" (a lock when we locked it); Regular: nothing. Where no header names the column (the
 * phone card: `bare`) "Urgent (customer) 2"; Italian always "Urgente (cliente) 2" ("Urgente" alone is the planner's rush word).
 * Beside it OUR priority when it is not Normal — "Priority: Top" (never a bare "Top" under this header) — unless the Priority
 * column is on screen (`priorityShown`): then it says it. The customer never sees our priority.
 */
export function CustomerUrgencyCell({ row, s, d, bare = false, priorityShown = false, askedHref = null }: { row: OrderRow; s: Translate; d: Translate; bare?: boolean; priorityShown?: boolean; askedHref?: string | null }) {
  const chip = urgencyChipOf(row)
  // F-CW-302 (S7): "Urgent – asked" is a door to the request that waits on us — the review window in place where the page holds it
  // (the customer's Work tab), else the order's Changes tab. The cell stays read-only: our own acts sit in the row ⋯ and More ▾.
  const asked = (
    <Tag tone="warning" className="fw-sheet-stop is-dash" title={s('urgency.askedTip')}>
      {s('urgency.ASKED')}
    </Tag>
  )
  const level = priorityShown ? null : priorityChipOf(row)
  if (!chip && !level) return null
  return (
    <span className="fw-sheet-urg">
      {chip?.state === 'URGENT' && (
        <Tag tone="warning" title={s('urgency.rankTip')}>
          {chip.rank !== null ? s(bare ? 'urgency.bareRank' : 'urgency.rank', { rank: chip.rank }) : s(bare ? 'urgency.bare' : 'urgency.URGENT')}
        </Tag>
      )}
      {chip?.state === 'ASKED' &&
        (askedHref ? (
          <Link href={askedHref} className="fw-sheet-chip-door" data-door="" title={s('urgency.askedTip')}>
            {asked}
          </Link>
        ) : (
          asked
        ))}
      {chip?.state === 'SET_BACK' && (
        <span className="fw-sheet-setback" title={s(chip.locked ? 'urgency.lockedTip' : 'urgency.SET_BACK')}>
          {chip.locked && <Lock size={11} aria-hidden />}
          <span>{s('urgency.SET_BACK')}</span>
        </span>
      )}
      {level && (
        <Tag tone={level === 'URGENT' ? 'danger' : level === 'HIGH' ? 'warning' : 'neutral'} title={s('urgency.priorityTip')}>
          {s('urgency.priority', { level: d(`priority.level.${level}`) })}
        </Tag>
      )}
    </span>
  )
}

/**
 * F-CW-102 (10-design §3.5; lead settle S33): New messages as a count bubble — the reader's own new messages on the order ("2",
 * "99+"), a door to its thread at the first new one (a link; on a page with a dock, a button that docks it — ⌘ / Ctrl keeps the new
 * tab); nothing new: an empty cell with its words for a screen reader. The words are the shared cell's own (`last-message`).
 */
export function NewMessagesBubble({ unread, href, record, onOpen, l }: { unread: Unread | undefined; href: string | null; record: string; onOpen?: (() => void) | null; l: Translate }) {
  const cell = unreadCellOf(unread)
  if (cell.kind === 'empty') return <span className="nds-vh">{l('cell.none')}</span>
  const label = l('cell.label', { count: cell.count, record })
  const count = cell.key === 'cell.many' ? '99+' : String(cell.count)
  if (onOpen)
    return (
      <button type="button" className="fw-sheet-msgs" aria-label={label} title={label} data-door="" onClick={(event) => dockClick(event, href, onOpen)} onAuxClick={(event) => event.button === 1 && href && window.open(href, '_blank', 'noopener')}>
        {count}
      </button>
    )
  if (!href)
    return (
      <span className="fw-sheet-msgs" title={label}>
        {count}
      </span>
    )
  return (
    <Link className="fw-sheet-msgs" href={href} aria-label={label} title={label} data-door="">
      {count}
    </Link>
  )
}

/** F-CW-102 (S33): the New messages column's header in a narrow column — the message mark; the column's name stays its accessible name. */
export function MessagesHeader({ displayName }: { displayName?: string }) {
  return (
    <span className="fw-sheet-hicon" title={displayName}>
      <MessageSquare size={14} aria-hidden />
      <span className="nds-vh">{displayName}</span>
    </span>
  )
}

/**
 * Waiting on: the most urgent of a request to answer (a real link to the review window — on the customer page its door, else the
 * order's Changes), a reply that waits on us ("Reply waits · 4 h"), who acts next as the keeper keeps it ("Waiting on supplier ·
 * 2 d"); "+1 more" when more than one. Nothing waits: "—".
 */
/**
 * cw fx5 (walk W-7): words that end with a time ("Waiting on customer · 16 d") wrap inside a narrow cell on a word's edge and
 * never inside the time — "· 16 d" goes to the second line whole (no-break spaces inside the tail and after its dot).
 */
export function tailWhole(text: string, tail: string | null): string {
  if (!tail || !text.endsWith(tail)) return text
  const head = text.slice(0, text.length - tail.length)
  return `${head.replace(/· $/, '·\u00a0')}${tail.replace(/ /g, '\u00a0')}`
}

export function WaitingOnCell({ row, mark, prefix, doorHref, s, now }: { row: OrderRow; mark?: WaitingMark | null; prefix: string; doorHref?: ((requestId: string) => string) | null; s: Translate; now: number }) {
  const w = useProductionWords()
  const items = waitingItemsOf(row, mark)
  const first = items[0]
  if (!first) return <span className="fw-sheet-plain">—</span>
  const age = (since: string | null) => {
    const phrase = ageOf(since, now)
    return phrase ? w.say(phrase) : null
  }
  const more = items.length > 1 ? <span className="fw-sheet-sub">{s('waiting.more', { count: items.length - 1 })}</span> : null
  if (first.kind === 'request')
    return (
      <span className="fw-sheet-cell">
        <Link href={answerHrefOf(prefix, row, first, doorHref)} className="fw-sheet-door" data-door="" title={s('waiting.answerTip', { number: row.number })}>
          {first.count > 1 ? s('waiting.requests', { count: first.count }) : s('waiting.request')}
        </Link>
        {more}
      </span>
    )
  if (first.kind === 'reply')
    return (
      <span className="fw-sheet-cell">
        <span className="fw-sheet-wraps">{tailWhole(s('waiting.reply', { time: age(first.since) ?? '—' }), age(first.since))}</span>
        {more}
      </span>
    )
  // F-CW-303: what WE asked and still wait for — production (the order's open production issues), the customer (our open ask).
  if (first.kind === 'askedProduction' || first.kind === 'askedCustomer') {
    const time = age(first.since)
    const words = first.kind === 'askedProduction' ? (time ? s('waiting.askedProduction', { time }) : s('waiting.askedProductionNow')) : s('waiting.askedCustomer', { customer: row.partyName, time: time ?? '—' })
    return (
      <span className="fw-sheet-cell">
        <span className="fw-sheet-wraps">{tailWhole(words, time)}</span>
        {more}
      </span>
    )
  }
  const since = age(first.since)
  return (
    <span className="fw-sheet-cell">
      <span className="fw-sheet-wraps">{since ? tailWhole(s('waiting.keeper', { who: w.t(`parts.waiting.office.${first.on}`), time: since }), since) : w.t(`parts.waiting.office.${first.on}`)}</span>
      {more}
    </span>
  )
}

/** Supervisor: Me / Someone else / Not set — never a name on a list (worker privacy); held in words without the work orders' right. */
export function SupervisorCell({ row, s, marks }: { row: OrderRow; s: Translate; marks: Translate }) {
  const cell = supervisorCellOf(row)
  if (cell.kind === 'unread') return <span className="fw-sheet-plain">—</span>
  if (cell.kind === 'withheld')
    return (
      <span className="fw-sheet-held" tabIndex={0} title={s('held.workorders')}>
        —
      </span>
    )
  return <span className={cell.mark === 'ME' ? 'fw-sheet-me' : undefined}>{marks(`mark.${cell.mark}`)}</span>
}
// ── end F-SA-275 ──
