'use client'

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
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
import type { OrderRow } from '../../api'
import { STATUS_TONE } from '../../model'
import { answerHrefOf, HEALTH_CHIP, piecesLineOf, supervisorCellOf, waitingItemsOf, whereLineOf, type WaitingMark } from './model'
// ---- end F-SA-275

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
 */
export function WhereItIsCell({ row, t, s, statusShown = false }: { row: OrderRow; t: Translate; s: Translate; statusShown?: boolean }) {
  const w = useProductionWords()
  const line = whereLineOf(row)
  const pieces = piecesLineOf(row)
  if (line.kind === 'unread') return <span className="fw-sheet-plain">—</span>
  // F-CP-107 (cp-fx16): the same fact never twice in one row — no stage kept while the row shows the Status column: only this
  // order's pieces ("Not in work yet"); "—" while they were not read. Status hidden (Customise, a view without it): the status here.
  if (line.kind === 'status' && statusShown)
    return pieces ? <span className="fw-sheet-sub">{pieces.production ? w.t(pieces.key, pieces.params) : s(pieces.key, pieces.params)}</span> : <span className="fw-sheet-plain">—</span>
  // ---- end F-CP-107 (cp-fx16)
  return (
    <span className="fw-sheet-cell">
      {line.kind === 'status' ? (
        <Pill tone={STATUS_TONE[row.status]}>{t(`status.${row.status}`)}</Pill>
      ) : (
        <span className="fw-sheet-where">
          <b>{w.t(`parts.stage.${line.stage}`)}</b>
          {line.byHand && <ByHandMark old={line.byHand.old} t={t} /> /* F-MS-104 */}
          {line.health && <HealthPill face="office" explain={false} computed={HEALTH_CHIP[line.health]} daysLate={row.daysLate} />}
          {line.held && <Tag tone="warning">{w.t('parts.stage.blocked')}</Tag>}
        </span>
      )}
      {pieces && <span className="fw-sheet-sub">{pieces.production ? w.t(pieces.key, pieces.params) : s(pieces.key, pieces.params)}</span>}
    </span>
  )
}

/**
 * Waiting on: the most urgent of a request to answer (a real link to the review window — on the customer page its door, else the
 * order's Changes), a reply that waits on us ("Reply waits · 4 h"), who acts next as the keeper keeps it ("Waiting on supplier ·
 * 2 d"); "+1 more" when more than one. Nothing waits: "—".
 */
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
        <span>{s('waiting.reply', { time: age(first.since) ?? '—' })}</span>
        {more}
      </span>
    )
  const since = age(first.since)
  return (
    <span className="fw-sheet-cell">
      <span>{since ? s('waiting.keeper', { who: w.t(`parts.waiting.office.${first.on}`), time: since }) : w.t(`parts.waiting.office.${first.on}`)}</span>
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
