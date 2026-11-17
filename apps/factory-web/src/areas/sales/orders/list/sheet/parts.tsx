'use client'

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { ChevronDown, Filter, Shirt, X } from 'lucide-react'
import { AsyncListboxPanel, DetailPopover, type ListboxOption } from '@nexus/ui/components'
import { Button, FilterChip } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import type { OrderRow } from '../../api'
import { switcherFace, switcherLines, type Door, type Phrase, type SwitcherState } from './model'
import './sheet.css'

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string
const say = (t: Translate, phrase: Phrase) => t(phrase.key, phrase.params)

/**
 * B-TH-225 / B-TH-226 — the parts of the Orders sheet the design system does not have (Owner yes on decision 2: they live in
 * factory-web): the door (a real link in the link colour, or plain words with the reason when the reader may not open it), the
 * peek card (a link that shows a small card after half a second of rest or on focus; Space opens it at once), the funnel
 * button (a value that narrows the sheet, never a page), the Picture cell and its viewer, the chips row and the Customer
 * switcher. Words: the `orders-sheet` catalogue.
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

// ---- the Picture cell and its viewer -----------------------------------------------------------------------------------------

/** A small preview's address, kept until shortly before it expires (the cell re-reads it after). */
const SMALL_CACHE = new Map<string, { url: string; until: number }>()

export type PictureLoader = (orderId: string) => Promise<{ url: string; expiresAt: string } | null>

/** The small preview of a row: undefined while read, null for the placeholder (none, no right, or the store has none). */
export function useSmallPicture(row: OrderRow, load: PictureLoader | undefined, demo: string | undefined): string | null | undefined {
  const wanted = !!row.picture?.small && !!row.picture.fileId
  const cached = SMALL_CACHE.get(row.id)
  const [src, setSrc] = useState<string | null | undefined>(demo ?? (!wanted || !load ? null : cached && cached.until > Date.now() ? cached.url : undefined))
  useEffect(() => {
    if (demo !== undefined) return setSrc(demo)
    if (!wanted || !load) return setSrc(null)
    const known = SMALL_CACHE.get(row.id)
    if (known && known.until > Date.now()) return setSrc(known.url)
    let gone = false
    load(row.id)
      .then((answer) => {
        if (gone) return
        if (!answer) return setSrc(null)
        SMALL_CACHE.set(row.id, { url: answer.url, until: Date.parse(answer.expiresAt) - 5_000 })
        setSrc(answer.url)
      })
      .catch(() => !gone && setSrc(null))
    return () => {
      gone = true
    }
  }, [row.id, wanted, load, demo])
  return src
}

/** The Picture cell: the style's main picture as a small preview ("+2" when the order has more styles), else a placeholder. */
export function PictureThumb({ row, src, onOpen, t }: { row: OrderRow; src: string | null | undefined; onOpen: () => void; t: Translate }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [src])
  const picture = row.picture
  const style = picture ? `${picture.styleCode} ${picture.styleName}` : null
  const more = Math.max(0, row.styleCount - 1)
  const name = style ? t('picture.open', { number: row.number, style }) : t('picture.noneOf', { number: row.number })
  return (
    <button type="button" className="fw-sheet-thumb" onClick={onOpen} aria-label={name} title={name} disabled={!picture}>
      {src && !broken ? <img src={src} alt={t('picture.alt', { style: style ?? row.number })} loading="lazy" onError={() => setBroken(true)} /> : <Shirt size={18} aria-hidden className={src === undefined ? 'fw-sheet-thumb-wait' : undefined} />}
      {more > 0 && <span className="fw-sheet-thumb-more">{t('picture.more', { count: more })}</span>}
    </button>
  )
}

/**
 * The picture large (grid-F02): the small preview — the sheet never loads the original — with the style's code and name, Open
 * style (a real link) and, for an order of several styles, the way to its lines. Esc closes and returns to the cell.
 */
export function PictureViewer({ row, src, prefix, t, onClose }: { row: OrderRow; src: string | null | undefined; prefix: string; t: Translate; onClose: () => void }) {
  const picture = row.picture
  const more = Math.max(0, row.styleCount - 1)
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={picture ? `${picture.styleCode} ${picture.styleName}` : row.number}
      subtitle={t('picture.viewerOf', { number: row.number })}
      footer={
        <>
          <Button onClick={onClose}>{t('picture.close')}</Button>
          {picture && (
            <Button variant="primary" asChild>
              <Link href={`${prefix}/products/styles/${encodeURIComponent(picture.styleId)}`}>{t('picture.openStyle')}</Link>
            </Button>
          )}
        </>
      }
    >
      <div className="fw-sheet-viewer">
        {src ? <img src={src} alt={t('picture.alt', { style: picture ? `${picture.styleCode} ${picture.styleName}` : row.number })} /> : (
          <span className="fw-sheet-viewer-none">
            <Shirt size={40} aria-hidden />
            {t('picture.none')}
          </span>
        )}
      </div>
      <p className="fw-sheet-viewer-note">{t('picture.small')}</p>
      {more > 0 && (
        <p className="fw-sheet-viewer-note">
          <Link className="fw-sheet-door" href={`${prefix}/sales/orders/${encodeURIComponent(row.id)}?tab=lines`}>
            {t('picture.moreStyles', { count: more })}
          </Link>
        </p>
      )}
    </Modal>
  )
}

// ---- the chips row ---------------------------------------------------------------------------------------------------------------

export interface SheetChip {
  readonly id: string
  readonly label: string
  readonly onClear: () => void
}

/** Every narrowing as a chip with ✕ (grid-F25: nothing filters the sheet that is not a chip); Clear all from two on. */
export function SheetChips({ chips, t, onClearAll }: { chips: readonly SheetChip[]; t: Translate; onClearAll: () => void }) {
  if (chips.length === 0) return null
  return (
    <div className="fw-sheet-chips" role="group" aria-label={t('chips.label')}>
      {chips.map((chip) => (
        <FilterChip key={chip.id} pressed onClick={chip.onClear} aria-label={t('chips.remove', { name: chip.label })}>
          {chip.label} <X size={12} aria-hidden />
        </FilterChip>
      ))}
      {chips.length > 1 && (
        <Button size="sm" variant="link" onClick={onClearAll}>
          {t('chips.clearAll')}
        </Button>
      )}
    </div>
  )
}

// ---- the Customer switcher ---------------------------------------------------------------------------------------------------------

export interface SwitcherProps {
  state: SwitcherState
  party: string | null
  /** The chosen customer's name when the switcher's page does not hold it (from the rows or its record); null: not available. */
  partyName: string | null | undefined
  t: Translate
  /** The search typed in the open list (the page reads the customers that match). */
  query: string
  searching: boolean
  onQuery?: (query: string) => void
  onPick?: (party: string | null) => void
  onRetry?: () => void
  /** Design cases: open at start. */
  open?: boolean
}

/**
 * "Customer: All customers ▾" beside the views (SHEET.switcher-F01): a DS DetailPopover whose panel is the DS AsyncListboxPanel —
 * search, then "All customers" (or "All my customers (n)") on top, the recent customers, the others by name, each with its open
 * and late orders read by the API. A reader limited to one customer reads a fixed label; with no customer yet it is absent.
 */
export function CustomerSwitcher({ state, party, partyName, t, query, searching, onQuery, onPick, onRetry, open: startOpen }: SwitcherProps) {
  // A design case opens it after the first paint (a popover is portaled to <body>: never in the server's HTML).
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (startOpen) setOpen(true)
  }, [startOpen])
  const face = switcherFace(state, party, partyName)
  if (face.kind === 'hidden') return null
  if (face.kind === 'fixed')
    return (
      <span className="fw-sheet-fixed" title={t('switcher.fixedHint')}>
        {t('switcher.fixed', { name: face.name })}
      </span>
    )
  const all = state.limited ? t('switcher.allMine', { count: state.total }) : t('switcher.all')
  const lines = switcherLines(state.customers ?? [], query.trim() !== '', { all, recent: t('switcher.recent'), others: t(state.limited ? 'switcher.mine' : 'switcher.everyone', { count: state.total }) })
  const options: ListboxOption[] = lines.map((line) => ({
    value: line.value,
    label: line.label,
    ...(line.group ? { group: line.group } : {}),
    ...(line.value
      ? {
          title: line.archived ? `${line.label} · ${t('switcher.archived')}` : line.label,
          trailing: (
            <span className="fw-sheet-opt-n">
              {t('switcher.open', { count: line.open ?? 0 })}
              {(line.late ?? 0) > 0 && (
                <>
                  {' · '}
                  <span className="fw-sheet-late">{t('switcher.late', { count: line.late ?? 0 })}</span>
                </>
              )}
              {line.archived && ` · ${t('switcher.archived')}`}
            </span>
          ),
        }
      : {}),
  }))
  const shown = state.customers?.length ?? 0
  const message = state.customers && state.total > shown ? t('switcher.typeToFind', { count: state.total - shown }) : undefined
  return (
    <DetailPopover
      open={open}
      onOpenChange={setOpen}
      hoverDelay={0}
      trigger={
        <span className="fw-sheet-switch">
          {say(t, face.label)}
          <ChevronDown size={13} aria-hidden />
        </span>
      }
      triggerClassName="nds-btn sm fw-sheet-switch-btn"
      triggerLabel={`${say(t, face.label)} — ${t('switcher.trigger')}`}
      label={t('switcher.title')}
      panelClassName="fw-sheet-switch-panel"
    >
      {({ close }) => (
        <AsyncListboxPanel
          label={t('switcher.search')}
          placeholder={t('switcher.searchHint')}
          query={query}
          onQueryChange={(next) => onQuery?.(next)}
          options={options}
          value={party ?? ''}
          loading={state.customers === null || searching}
          error={state.problem ? t('switcher.failed') : undefined}
          onRetry={onRetry}
          message={state.customers === null || searching ? t('switcher.reading') : message}
          emptyMessage={query.trim() ? t('switcher.noMatch', { q: query.trim() }) : t('switcher.none')}
          onCommit={(value) => {
            onPick?.(value || null)
            close({ returnFocus: true })
          }}
          onCancel={() => close({ returnFocus: true })}
        />
      )}
    </DetailPopover>
  )
}
