'use client'

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { ChevronDown, ChevronRight, FileImage, Lock, Plus, Ruler } from 'lucide-react'
import { Card, Menu } from '@nexus/ui/components'
import { Button, InfoTip, Input, Tag } from '@nexus/ui/primitives'
import { Textarea } from '../../../../../../lib/i18n/ds-parts'
import { formatDate, formatNumber } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { RecordPicture } from '../../../../../../lib/record-picture/view/RecordPicture'
import { useRecordFrame } from '../../../../../_shared/record-frame/RecordFrame'
import { tabHref } from '../../../../../_shared/record-frame/address'
import { TabLink } from '../../../../../../lib/tab-link/TabLink'
import type { StyleDetail } from '../../../../quotes/api'
import type { Order, OrderLine } from '../../../api'
import type { CellFloors } from '../../../daily-model'
import { NAMESPACE as DEPTH } from '../../../depth/model'
import type { Freeze } from '../../../depth/api'
import { dayInstant } from '../../../model'
import { rowAnchor } from '../../dock/discuss'
import { artworkOfGroup } from '../../production'
import { autoReasonOf, badPriceText, clashKey, type Clash, type LinesDraft, type NoteField } from '../../lines-draft'
import {
  cellId,
  cellOfRow,
  closedFiguresOf,
  columnsOf,
  lineAmountOf,
  locksOfCard,
  mtmOf,
  notesOf,
  offeredOf,
  patternOf,
  priceCellId,
  priceLockOf,
  sizesPricedApart,
  unitPriceOf,
  type CardRow,
  type CellLock,
  type Column,
  type LinesReader,
  type ServerFigures,
  type StyleCardModel,
  type TaxBasis,
} from '../../lines-table'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { LineMenuButton, type LineMenu } from '../LineMenu'

/**
 * F-OL-02 (Order LINES lane; 10-design-tab §3–§8) — one style's card: its head (the picture opens large, the name opens the style,
 * "Pattern v3 · approved", the artwork chip, ONE lock line) and ONE native table — Colour | sizes | + Size | Pieces | Unit price | Line
 * total | Ready by | ⋯ — whose cells are thin DS boxes for who changes lines (accessible names "{colour}, size {size}") and plain
 * numbers for everyone else. Marks: a changed cell tinted with "was 3", a new colour "New", a removed one struck with Put back, "min 3"
 * only where cut or shipped binds, the company lock said on the cell before typing. Notes fold under the row as two one-line fields.
 * A made-to-measure unit reads "1 unit · base size 52"; a closed line "10 ordered · 9 to make · 1 cancelled". Fetches nothing.
 */

export interface LinesCtx {
  readonly order: Order
  readonly model: OrderRecordModel
  readonly actions?: OrderRecordActions
  readonly draft: LinesDraft
  readonly reader: LinesReader
  /** Writers see boxes now (not held by the order's state, no save running). */
  readonly boxes: boolean
  readonly readyBy: boolean
  readonly floors: CellFloors
  readonly freeze: Freeze | null
  readonly menu: LineMenu
  readonly clashes: readonly Clash[]
  readonly moved: readonly string[]
  readonly styles: Readonly<Record<string, StyleDetail | null | undefined>>
  readonly basis: TaxBasis
  /** Who saved meanwhile (the clash words "Bea 5"). */
  readonly colleague: string | null
  /** F-OL-09: the server's figures of THIS draft once its preview answered (price readers); null: the client estimate fills the gap. */
  readonly figures: ServerFigures | null
}

type Translate = (key: string, params?: Record<string, string | number>) => string

const amountText = (minor: number | null, locale: 'it' | 'en'): string => (minor === null ? '—' : formatNumber(minor / 100, locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
const priceText = (price: string | null, locale: 'it' | 'en'): string => (price === null ? '—' : formatNumber(Number(price), locale, { minimumFractionDigits: 2, maximumFractionDigits: 4 }))

/** A colour row's name ("BLK · Black"); a new row says its own. */
export const rowName = (row: CardRow): string => (row.kind === 'new' ? row.row.colour : row.line.colourway ? `${row.line.colourway.code} · ${row.line.colourway.name}` : '—')

/** A thin DS box: typing goes to the draft at once; Esc puts the box back as before this edit; Enter / Shift+Enter go down / up. */
function Box({ id, label, value, decimal, onType, below, above, invalid, describedBy }: { id: string; label: string; value: string; decimal?: boolean; onType: (text: string) => void; below?: string | null; above?: string | null; invalid?: boolean; describedBy?: string }) {
  const [text, setText] = useState<string | null>(null)
  const start = useRef('')
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setText(start.current)
      onType(start.current)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const to = event.shiftKey ? above : below
      if (to) document.getElementById(to)?.focus()
    }
  }
  return (
    <Input
      id={id}
      size="xs"
      fieldClassName="fw-lt-box"
      inputMode={decimal ? 'decimal' : 'numeric'}
      autoComplete="off"
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      placeholder={decimal ? undefined : '–'}
      value={text ?? value}
      onFocus={(event) => {
        start.current = value
        setText(value)
        event.currentTarget.select()
      }}
      onChange={(event) => {
        setText(event.target.value)
        onType(event.target.value)
      }}
      onBlur={() => setText(null)}
      onKeyDown={onKeyDown}
    />
  )
}

/** A typed count ("" is none, a non-number is not taken). */
const piecesOfText = (text: string): number | null => {
  const trimmed = text.trim()
  if (trimmed === '') return 0
  return /^\d{1,6}$/.test(trimmed) ? Number(trimmed) : null
}

function lockWords(lock: CellLock, t: Translate, d: Translate): string {
  const stage = lock.stage ? d(`stage.${lock.stage}`) : d('stage.none')
  return t(lock.state === 'BLOCKED' ? 'lines.cell.lockedForGood' : 'lines.cell.locked', { stage })
}

export function StyleTable({ card, first, ctx }: { card: StyleCardModel; first: boolean; ctx: LinesCtx }) {
  const t = useT('orders')
  const d = useT(DEPTH)
  const { model, actions, reader } = ctx
  const style = ctx.styles[card.styleId]
  const columns = columnsOf(reader, card.sizes, ctx.readyBy)
  const locks = locksOfCard(card, ctx.freeze)
  const keyOf = (row: CardRow) => row.key
  // Enter / Shift+Enter: the same size of the row below / above (a row with no box there is skipped).
  const boxBelow = (index: number, size: string, step: 1 | -1): string | null => {
    for (let at = index + step; at >= 0 && at < card.rows.length; at += step) {
      const row = card.rows[at]!
      if (row.kind === 'line' && (!row.typeable || row.removed)) continue
      return cellId(keyOf(row), size)
    }
    return null
  }
  return (
    <Card padded className="fw-lt-card" aria-label={`${card.code} · ${card.name}`} onFocus={() => (reader.writes ? actions?.linesTab?.onReadStyle?.(card.styleId) : undefined)}>
      <CardHead card={card} ctx={ctx} />
      {locks.length > 0 && (
        <p className="fw-lt-quiet">
          <Lock size={13} aria-hidden /> {t('lines.locks', { count: locks.length })}
          <InfoTip tip={locks.map((entry) => t('lines.lockOf', { colour: rowName(card.rows.find((row) => row.key === entry.lineId)!), size: entry.size, stage: entry.lock.stage ? d(`stage.${entry.lock.stage}`) : d('stage.none') })).join(' · ')} />
        </p>
      )}
      {model.depth?.freeze?.problem && <p className="fw-lt-quiet">{t('lines.freezeUnread')}</p>}
      <div className="fw-lt-scroll">
        <table className="fw-lt-table">
          <caption className="nds-vh">{t('lines.gridCaption', { style: card.code })}</caption>
          <colgroup>
            {columns.map((column, index) => (
              <col key={`${column.key}-${column.size ?? index}`} className={column.key === 'colour' ? undefined : `fw-lt-col-${COL_CLASS[column.key]}`} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {columns.map((column, index) => (
                <HeadCell key={`${column.key}-${column.size ?? index}`} column={column} card={card} ctx={ctx} style={style} />
              ))}
            </tr>
          </thead>
          {card.rows.map((row, index) => (
            <Row key={row.key} row={row} card={card} columns={columns} ctx={ctx} style={style} below={(size) => boxBelow(index, size, 1)} above={(size) => boxBelow(index, size, -1)} />
          ))}
          <Foot card={card} columns={columns} ctx={ctx} first={first} />
        </table>
      </div>
    </Card>
  )
}

const COL_CLASS: Readonly<Record<Column['key'], string>> = Object.freeze({ colour: 'colour', size: 'size', plus: 'plus', pieces: 'pieces', unitPrice: 'price', lineTotal: 'total', readyBy: 'ready', more: 'more' })

/** The card's head: the picture (it opens large in the thread's viewer), the style's name (its page), the pattern, the artwork chip. */
function CardHead({ card, ctx }: { card: StyleCardModel; ctx: LinesCtx }) {
  const t = useT('orders')
  const frame = useRecordFrame()
  const search = useSearchParams()?.toString() ?? ''
  const { order, model } = ctx
  const lines = card.rows.flatMap((row) => (row.kind === 'line' ? [row.line] : []))
  const firstLine = lines[0] ?? null
  const artwork = artworkOfGroup(lines)
  const pattern = patternOf(card.revision)
  const picture = firstLine?.picture ?? null
  const openLarge = picture && frame?.openFiles ? () => frame.openFiles?.({ files: [{ id: picture.fileId, name: `${card.code} · ${card.name}`, contentType: picture.contentType, sizeBytes: 0 }], fileId: picture.fileId }) : undefined
  return (
    <div className="fw-lt-card-head">
      {firstLine && (
        <RecordPicture
          source="order"
          recordId={order.id}
          number={`${card.code} · ${card.name}`}
          size="lineLarge"
          picture={firstLine.style ? { styleId: firstLine.styleId, styleCode: firstLine.style.code, styleName: firstLine.style.name, fileId: picture?.fileId ?? null, small: !!picture?.small } : null}
          held={picture?.small ?? null}
          onOpen={openLarge}
        />
      )}
      <h2 className="fw-lt-style">
        <a href={`${model.prefix}/products/styles/${encodeURIComponent(card.styleId)}`} title={t('lines.style.open', { code: card.code })}>
          {card.code} · {card.name}
        </a>
      </h2>
      {pattern.kind === 'none' ? <Tag tone="neutral">{t('lines.pattern.none')}</Tag> : <Tag tone={pattern.kind === 'approved' ? 'success' : 'warning'}>{t(`lines.pattern.${pattern.kind}`, { revision: pattern.revision })}</Tag>}
      {card.leaves && <Tag tone="danger">{t('lines.leaves')}</Tag>}
      {card.fresh && <Tag tone="info">{t('lines.row.new')}</Tag>}
      <span className="fw-lt-grow" />
      {artwork.count > 0 &&
        (frame?.openFiles && artwork.files.length > 0 ? (
          <Button size="sm" variant="quiet" title={t('lines.artworkOpen')} onClick={(event) => frame.openFiles?.({ files: artwork.files.map((file) => ({ id: file.fileId, name: file.name, contentType: file.contentType, sizeBytes: file.sizeBytes })), fileId: artwork.files[0]!.fileId, returnTo: event.currentTarget })}>
            <FileImage size={13} aria-hidden /> {t('lines.artwork', { count: artwork.count })}
          </Button>
        ) : (
          <Button size="sm" variant="quiet" asChild>
            <TabLink href={tabHref(`${model.prefix}/sales/orders/${order.id}`, 'files', search)}>
              <FileImage size={13} aria-hidden /> {t('lines.artwork', { count: artwork.count })}
            </TabLink>
          </Button>
        ))}
    </div>
  )
}

function HeadCell({ column, card, ctx, style }: { column: Column; card: StyleCardModel; ctx: LinesCtx; style: StyleDetail | null | undefined }) {
  const t = useT('orders')
  const vat = ctx.basis.kind === 'vat' || ctx.basis.kind === 'vatNone'
  switch (column.key) {
    case 'colour':
      return <th scope="col">{t('lines.col.colour')}</th>
    case 'size':
      return (
        <th scope="col" className="fw-lt-num">
          {column.size}
        </th>
      )
    case 'plus': {
      // "+ Size": the style's sizes not shown yet (read when the card is first focused); none to add: nothing to open.
      const more = (style?.sizes ?? []).filter((size) => !card.sizes.includes(size))
      return (
        <th scope="col" className="fw-lt-plus">
          {ctx.boxes && more.length > 0 ? <Menu align="right" label={<><Plus size={12} aria-hidden /> {t('lines.addSize')}</>} triggerProps={{ 'aria-label': t('lines.addSizeLabel') }} items={more.map((size) => ({ id: size, label: size, onSelect: () => ctx.actions?.linesTab?.onAddSize?.(card.styleId, size) }))} /> : <span className="nds-vh">{t('lines.addSizeLabel')}</span>}
        </th>
      )
    }
    case 'pieces':
      return (
        <th scope="col" className="fw-lt-num">
          {t('lines.col.pieces')}
        </th>
      )
    case 'unitPrice':
      return (
        <th scope="col" className="fw-lt-num">
          {ctx.basis.kind === 'gross' ? t('lines.col.unitGross') : t('lines.col.unitPrice')}
          {vat && <small>{t('lines.col.exVat')}</small>}
        </th>
      )
    case 'lineTotal':
      return (
        <th scope="col" className="fw-lt-num">
          {t('lines.col.lineTotal')}
          {vat && <small>{t('lines.col.exVat')}</small>}
        </th>
      )
    case 'readyBy':
      return (
        <th scope="col" className="fw-lt-num">
          {t('lines.col.readyBy')}
        </th>
      )
    default:
      return (
        <th scope="col" className="fw-lt-more">
          <span className="nds-vh">{t('wo.col.acts')}</span>
        </th>
      )
  }
}

/** One colour row: its main row (every column) and, when open, its notes fold. */
function Row({ row, card, columns, ctx, style, below, above }: { row: CardRow; card: StyleCardModel; columns: readonly Column[]; ctx: LinesCtx; style: StyleDetail | null | undefined; below: (size: string) => string | null; above: (size: string) => string | null }) {
  const t = useT('orders')
  const [open, setOpen] = useState(false)
  const { draft } = ctx
  const isNew = row.kind === 'new'
  const removed = row.kind === 'line' && row.removed
  const line = row.kind === 'line' ? row.line : null
  const mtm = line ? mtmOf(line) : null
  const offered = offeredOf(row, style)
  const typeable = ctx.boxes && !removed && (isNew || (row.kind === 'line' && row.typeable))
  const moved = row.kind === 'line' && ctx.moved.includes(row.key)
  const classes = ['fw-lt-line', isNew ? 'is-new' : '', removed ? 'is-removed' : '', line?.closedShort ? 'is-closed' : '', moved ? 'is-moved' : ''].filter(Boolean).join(' ')
  const sizeColumns = columns.filter((column) => column.key === 'size')
  const notes = notesOf(row, draft)
  const span = columns.length
  return (
    <tbody className={classes} id={line ? rowAnchor('SalesOrderLine', line.id) : undefined} tabIndex={line ? -1 : undefined}>
      <tr className="fw-lt-main">
        {columns.map((column, index) => {
          if (column.key === 'size') {
            if (mtm) {
              // A made-to-measure unit: ONE cell over every size column (its size and price stay; only its notes change here).
              if (column !== sizeColumns[0]) return null
              return (
                <td key="mtm" colSpan={sizeColumns.length} className="fw-lt-span" title={t('lines.mtm.fixed')}>
                  <span className="fw-lt-mtm">
                    <Ruler size={14} aria-hidden /> {mtm.baseSize ? t('lines.mtm.unit', { count: mtm.units, size: mtm.baseSize }) : t('lines.mtm.units', { count: mtm.units })}
                  </span>
                </td>
              )
            }
            return <SizeCell key={`s-${column.size}`} row={row} size={column.size!} ctx={ctx} offered={offered} typeable={typeable} below={below(column.size!)} above={above(column.size!)} />
          }
          return <FactCell key={`${column.key}-${index}`} column={column} row={row} card={card} ctx={ctx} typeable={typeable} notes={notes} open={open} onOpen={() => setOpen((on) => !on)} />
        })}
      </tr>
      {open && !removed && (
        <tr className="fw-lt-fold">
          <td colSpan={span}>
            <NotesFold row={row} ctx={ctx} notes={notes} typeable={ctx.boxes && !removed} />
          </td>
        </tr>
      )}
    </tbody>
  )
}

function SizeCell({ row, size, ctx, offered, typeable, below, above }: { row: CardRow; size: string; ctx: LinesCtx; offered: readonly string[] | null; typeable: boolean; below: string | null; above: string | null }) {
  const t = useT('orders')
  const d = useT(DEPTH)
  const cell = cellOfRow(row, size, { draft: ctx.draft, offered, floors: ctx.floors, freeze: ctx.freeze })
  const name = rowName(row)
  if (!cell.offered)
    return (
      <td className="fw-lt-size fw-lt-num fw-lt-na" data-label={size}>
        <span aria-hidden>–</span>
        <span className="nds-vh">{t('lines.cell.notOffered')}</span>
      </td>
    )
  const clash = row.kind === 'line' ? ctx.clashes.find((entry) => entry.lineId === row.key && entry.field.kind === 'size' && entry.field.size === size) : undefined
  const lockedForGood = cell.lock?.state === 'BLOCKED'
  const lockTitle = cell.lock ? lockWords(cell.lock, t, d) : undefined
  const floorTitle = cell.floor ? (cell.floor.by === 'shipped' ? t('lines.cell.minShipped', { count: cell.floor.count, shipped: cell.floor.count }) : t('lines.cell.minCut', { count: cell.floor.count })) : undefined
  // Typed under a floor: under what shipped it cannot go (the bar waits); under what is cut its extra pieces get a home in Review.
  const own = row.kind === 'line' ? ctx.floors[row.key]?.[size] : undefined
  const under = row.kind === 'line' && cell.was !== null && own ? (cell.value < own.shipped ? 'shipped' : cell.value < own.cut ? 'cut' : null) : null
  const box = typeable && !lockedForGood
  const id = cellId(row.key, size)
  const label = t('lines.cell.label', { colour: name, size })
  return (
    <td className={`fw-lt-size fw-lt-num${cell.was !== null ? ' fw-lt-changed' : ''}`} data-label={size} title={lockTitle ?? (box ? floorTitle : undefined)}>
      <span className="fw-lt-cell">
        <span className="fw-lt-cell-value">
          {cell.lock && <Lock size={12} aria-label={lockTitle} />}
          {box ? (
            <Box
              id={id}
              label={label}
              value={cell.value === 0 ? '' : String(cell.value)}
              onType={(text) => {
                const pieces = piecesOfText(text)
                if (pieces !== null) ctx.actions?.linesTab?.onCell?.(row.key, size, pieces)
              }}
              below={below}
              above={above}
              invalid={under === 'shipped'}
            />
          ) : (
            <span aria-label={label}>{cell.value === 0 ? '–' : cell.value}</span>
          )}
        </span>
        {clash ? (
          <ClashChoice clash={clash} ctx={ctx} />
        ) : cell.was !== null ? (
          <span className="fw-lt-was">{t('lines.cell.was', { value: cell.was })}</span>
        ) : box && cell.floor && !cell.lock ? (
          <span className="fw-lt-floor">{t('lines.cell.min', { count: cell.floor.count })}</span>
        ) : null}
        {under === 'shipped' && own && <span className="fw-lt-issue">{t('edit.floor.shipped', { count: own.shipped })}</span>}
        {under === 'cut' && own && <span className="fw-lt-warn">{t('lines.cell.cutBeyond', { count: own.cut - cell.value })}</span>}
      </span>
    </td>
  )
}

/** A cell both of us changed: "you 4 · Bea 5" and Keep mine / Take theirs (the bar waits until chosen). */
function ClashChoice({ clash, ctx }: { clash: Clash; ctx: LinesCtx }) {
  const t = useT('orders')
  return (
    <span className="fw-lt-both" data-clash={clashKey(clash)}>
      <span>{t('lines.clash', { mine: clash.mine, name: ctx.colleague ?? t('dates.someone'), theirs: clash.theirs })}</span>
      <Button size="xs" variant="primary" onClick={() => ctx.actions?.linesTab?.onKeepMine?.(clash)}>
        {t('lines.keepMine')}
      </Button>
      <Button size="xs" onClick={() => ctx.actions?.linesTab?.onTakeTheirs?.(clash)}>
        {t('lines.takeTheirs')}
      </Button>
    </span>
  )
}

function FactCell({ column, row, card, ctx, typeable, notes, open, onOpen }: { column: Column; row: CardRow; card: StyleCardModel; ctx: LinesCtx; typeable: boolean; notes: ReturnType<typeof notesOf>; open: boolean; onOpen: () => void }) {
  const t = useT('orders')
  const d = useT(DEPTH)
  const locale = useLocale()
  const { order, draft } = ctx
  const line = row.kind === 'line' ? row.line : null
  const removed = row.kind === 'line' && row.removed
  switch (column.key) {
    case 'colour':
      return (
        <td className="fw-lt-colour">
          <ColourCell row={row} ctx={ctx} notes={notes} open={open} onOpen={onOpen} />
        </td>
      )
    case 'plus':
      return <td className="fw-lt-plus" />
    case 'pieces': {
      const pieces = row.kind === 'new' ? Object.values(row.row.sizes).reduce((sum, value) => sum + value, 0) : piecesNow(row, draft)
      const was = row.kind === 'line' && !removed && pieces !== row.line.quantity ? row.line.quantity : null
      const shipped = line?.progress.shipped ?? 0
      return (
        <td className={`fw-lt-fact fw-lt-num${was !== null ? ' fw-lt-changed' : ''}`} data-label={t('lines.col.pieces')}>
          <strong>{pieces}</strong>
          {was !== null && <span className="fw-lt-was">{t('lines.cell.was', { value: was })}</span>}
          {shipped > 0 && <span className="fw-lt-sub">{t('lines.row.shipped', { count: shipped })}</span>}
        </td>
      )
    }
    case 'unitPrice': {
      const price = unitPriceOf(row, draft)
      const lock = line ? priceLockOf(ctx.freeze, line.id) : null
      const typed = row.kind === 'new' ? row.row.price : line ? draft.lines[line.id]?.price : undefined
      const changed = row.kind === 'line' && typed !== undefined
      const shipped = (line?.progress.shipped ?? 0) > 0
      const apart = line ? sizesPricedApart(line) : 0
      const box = typeable && !shipped && lock?.state !== 'BLOCKED' && !(line && mtmOf(line))
      const clash = line ? ctx.clashes.find((entry) => entry.lineId === line.id && entry.field.kind === 'price') : undefined
      const name = rowName(row)
      return (
        <td className={`fw-lt-fact fw-lt-num fw-lt-price${changed ? ' fw-lt-changed' : ''}`} data-label={t('lines.col.unitPrice')} title={shipped ? t('lines.cell.priceShipped', { count: line!.progress.shipped }) : lock ? lockWords(lock, t, d) : undefined}>
          <span className="fw-lt-cell">
            <span className="fw-lt-cell-value">
              {(lock || shipped) && <Lock size={12} aria-hidden />}
              {box ? (
                <Box id={priceCellId(row.key)} label={t('editor.priceOf', { colour: name })} value={typed ?? (price === null ? '' : price)} decimal onType={(text) => ctx.actions?.linesTab?.onPrice?.(row.key, text)} invalid={badPriceText(typed)} />
              ) : (
                <span>{priceText(price, locale)}</span>
              )}
            </span>
            {clash ? <ClashChoice clash={clash} ctx={ctx} /> : changed && line ? <span className="fw-lt-was">{t('lines.cell.was', { value: priceText(line.unitPrice ?? null, locale) })}</span> : null}
            {row.kind === 'new' && price === null && <span className="fw-lt-sub">{t('lines.row.listPrice', { customer: order.party?.legalName ?? '' })}</span>}
            {apart > 0 && <span className="fw-lt-sub">{t('lines.row.sizesApart', { count: apart })}</span>}
          </span>
        </td>
      )
    }
    case 'lineTotal': {
      const amount = lineAmountOf(row, draft, ctx.figures) // F-OL-09
      return (
        <td className={`fw-lt-fact fw-lt-num${amount.was !== null ? ' fw-lt-changed' : ''}`} data-label={t('lines.col.lineTotal')}>
          <span>{amountText(amount.now, locale)}</span>
          {amount.was !== null && <span className="fw-lt-was">{t('lines.cell.was', { value: amountText(amount.was, locale) })}</span>}
        </td>
      )
    }
    case 'readyBy': {
      const own = line?.promiseDate && line.promiseDate !== order.promiseDate ? line.promiseDate : null
      const date = own ?? order.promiseDate
      return (
        <td className="fw-lt-fact fw-lt-num" data-label={t('lines.col.readyBy')}>
          {date ? own ? <strong>{formatDate(dayInstant(date), { locale })}</strong> : <span className="fw-lt-sub" title={t('lines.row.orderDate')}>{formatDate(dayInstant(date), { locale })}</span> : '—'}
        </td>
      )
    }
    default:
      return (
        <td className="fw-lt-more fw-lt-keep">
          <RowMore row={row} card={card} ctx={ctx} />
        </td>
      )
  }
}

/** A line's pieces with my cells (a removed line: its pieces as saved). */
function piecesNow(row: Extract<CardRow, { kind: 'line' }>, draft: LinesDraft): number {
  if (row.removed || row.line.kind !== 'SIZE_GRID') return row.line.quantity
  const edit = draft.lines[row.line.id]?.sizes
  if (!edit) return row.line.quantity
  const sizes: Record<string, number> = Object.fromEntries(row.line.sizes.flatMap((size) => (size.size === null ? [] : [[size.size, size.quantity]])))
  return Object.values({ ...sizes, ...edit }).reduce((sum, value) => sum + value, 0)
}

/** The colour cell: picture, "BLK · Black", tags, Put back, and ONE quiet line (notes, a closed line's figures, the rider). */
function ColourCell({ row, ctx, notes, open, onOpen }: { row: CardRow; ctx: LinesCtx; notes: ReturnType<typeof notesOf>; open: boolean; onOpen: () => void }) {
  const t = useT('orders')
  const locale = useLocale()
  const { order, model } = ctx
  const line = row.kind === 'line' ? row.line : null
  const removed = row.kind === 'line' && row.removed
  const closed = line ? closedFiguresOf(line) : null
  const mtm = line ? mtmOf(line) : null
  // F-OL-03: a reason nobody typed is the server's automatic words: said in the reader's words (who and when are said beside it).
  const autoReason = (reason: string) => {
    const auto = autoReasonOf(reason)
    return auto ? t(auto.key) : reason
  }
  const quiet: ReactNode[] = []
  if (removed && line && line.progress.inWorkOrders > 0) quiet.push(<span key="close">{t('lines.row.closesShort')}</span>)
  if (closed && line?.closedShort) {
    const by = line.closedShort.byId ? (order.people.find((person) => person.id === line.closedShort!.byId)?.name ?? t('dates.someone')) : null
    quiet.push(
      <span key="closed">
        {t('lines.short.figures', closed)}
        {by ? ` · ${t('lines.short.by', { name: by, day: line.closedShort.at ? formatDate(line.closedShort.at, { locale }) : '—' })}` : ''}
        {line.closedShort.reason ? ` · ${autoReason(line.closedShort.reason)}` : ''}
      </span>,
    )
  }
  // The rider is named only when the read gives it (sales.measurements.view); without the right only "Made to measure" (F-SA-231b).
  if (mtm && line?.rider) quiet.push(<span key="rider">{t('lines.rider', { rider: line.rider.name, garment: line.rider.garmentType, revision: line.rider.revision })}</span>)
  const hasNotes = notes.notes > 0 || notes.files > 0
  if (!removed && (hasNotes || ctx.boxes))
    quiet.push(
      <button key="notes" type="button" className="fw-lt-notes-toggle fw-so-link" aria-expanded={open} onClick={onOpen}>
        {hasNotes ? [notes.notes > 0 ? t('lines.notes.count', { count: notes.notes }) : null, notes.files > 0 ? t('lines.notes.files', { count: notes.files }) : null].filter(Boolean).join(' · ') : t('lines.notes.add')}{' '}
        {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
      </button>,
    )
  return (
    <span className="fw-lt-cc">
      {line && (
        <RecordPicture
          source="order"
          recordId={order.id}
          number={`${line.style?.code ?? '—'} · ${rowName(row)}`}
          size="line"
          picture={line.style ? { styleId: line.styleId, styleCode: line.style.code, styleName: line.style.name, fileId: line.picture?.fileId ?? null, small: !!line.picture?.small } : null}
          held={line.picture?.small ?? null}
        />
      )}
      <span className="fw-lt-cc-text">
        <span className="fw-lt-cc-name">
          <span>{rowName(row)}</span>
          {row.kind === 'new' && <Tag tone="info">{t('lines.row.new')}</Tag>}
          {mtm && <Tag tone="neutral">{t('record.madeToMeasure')}</Tag>}
          {closed && <Tag tone="warning">{t('lines.short.tag')}</Tag>}
          {removed && <Tag tone="danger">{t('lines.row.removed')}</Tag>}
          {line && model.lineCost?.(line) /* B-W2b-380: cost changed since priced */}
        </span>
        {quiet.length > 0 && <span className="fw-lt-quietline">{quiet}</span>}
      </span>
    </span>
  )
}

/** The notes fold: two one-line fields that grow (never the 168 px floor), and the line's files. */
function NotesFold({ row, ctx, notes, typeable }: { row: CardRow; ctx: LinesCtx; notes: ReturnType<typeof notesOf>; typeable: boolean }) {
  const t = useT('orders')
  const frame = useRecordFrame()
  const line = row.kind === 'line' ? row.line : null
  const files = line?.artwork ?? []
  const field = (which: NoteField, label: string, value: string, max: number) => (
    <label className="fw-so-stack-tight">
      <span className="fw-so-hint">{label}</span>
      {typeable ? <Textarea rows={1} honourRows value={value} maxLength={max} aria-label={`${label} · ${rowName(row)}`} onChange={(event) => ctx.actions?.linesTab?.onText?.(row.key, which, event.target.value)} /> : <span>{value.trim() || '—'}</span>}
    </label>
  )
  return (
    <div className="fw-lt-fold-body">
      {field('description', t('lines.notes.customer'), notes.description, 1000)}
      {field('note', t('lines.notes.floor'), notes.note, 2000)}
      {files.length > 0 && (
        <div className="fw-lt-files">
          <span className="fw-so-hint">{t('lines.notes.filesLabel')}</span>
          {files.map((file) =>
            frame?.openFiles ? (
              <Button key={file.fileId} size="sm" variant="quiet" onClick={(event) => frame.openFiles?.({ files: files.map((entry) => ({ id: entry.fileId, name: entry.name, contentType: entry.contentType, sizeBytes: entry.sizeBytes })), fileId: file.fileId, returnTo: event.currentTarget })}>
                <FileImage size={13} aria-hidden /> {file.name}
              </Button>
            ) : (
              <span key={file.fileId}>{file.name}</span>
            ),
          )}
        </div>
      )}
    </div>
  )
}

/** The row's ⋯ (the ONE line list); a removed row: Put back (its quiet button); a new row: Remove. Read-only: nothing. */
function RowMore({ row, card, ctx }: { row: CardRow; card: StyleCardModel; ctx: LinesCtx }) {
  const t = useT('orders')
  if (!ctx.reader.moves) return null
  const name = `${card.code} ${rowName(row)}`
  if (row.kind === 'line' && row.removed && ctx.reader.writes)
    return (
      <Button size="xs" variant="quiet" onClick={() => ctx.actions?.linesTab?.onPutBack?.(row.key)}>
        {t('lineMenu.putBack')}
      </Button>
    )
  const moves = ctx.menu.movesOf([row.key], row.kind === 'new' ? { isNew: true } : row.removed ? { removed: true } : undefined)
  if (moves.length === 0) return null
  const seq = row.kind === 'line' ? row.line.seq : 0
  const label = row.kind === 'line' ? t('progress.moves', { seq, name }) : t('lines.row.newActions', { name })
  return <LineMenuButton label={label} items={ctx.menu.itemsOf(moves, { seq, name })} />
}

/** The card's totals row: "Total" (+ the ONE keys tip in the first card, + Add a colour for writers), per size, pieces, line totals. */
function Foot({ card, columns, ctx, first }: { card: StyleCardModel; columns: readonly Column[]; ctx: LinesCtx; first: boolean }) {
  const t = useT('orders')
  const locale = useLocale()
  const { draft } = ctx
  const live = card.rows.filter((row) => !(row.kind === 'line' && row.removed))
  const sizeTotal = (size: string) => live.reduce((sum, row) => sum + (row.kind === 'line' && row.line.kind !== 'SIZE_GRID' ? 0 : cellOfRow(row, size, { draft, offered: null }).value), 0)
  const pieces = live.reduce((sum, row) => sum + (row.kind === 'new' ? Object.values(row.row.sizes).reduce((total, value) => total + value, 0) : piecesNow(row, draft)), 0)
  const amounts = live.map((row) => lineAmountOf(row, draft, ctx.figures).now) // F-OL-09
  const money = amounts.every((amount) => amount !== null) ? amounts.reduce<number>((sum, amount) => sum + (amount ?? 0), 0) : null
  return (
    <tfoot>
      <tr>
        {columns.map((column, index) => {
          switch (column.key) {
            case 'colour':
              return (
                <td key="c" className="fw-lt-colour">
                  <span className="fw-lt-foot">
                    {t('lines.total')}
                    {first && ctx.boxes && <InfoTip tip={`${t('lines.keys')}: ${t('lines.keysList')}`} />}
                    {ctx.boxes && (
                      <Button size="sm" variant="quiet" onClick={() => ctx.actions?.linesTab?.onAddColourOpen?.(card.styleId)}>
                        <Plus size={13} aria-hidden /> {t('lines.addColour')}
                      </Button>
                    )}
                  </span>
                </td>
              )
            case 'size':
              return (
                <td key={`s-${column.size}`} className="fw-lt-size fw-lt-num">
                  {sizeTotal(column.size!) || '–'}
                </td>
              )
            case 'pieces':
              return (
                <td key="p" className="fw-lt-fact fw-lt-num" data-label={t('lines.col.pieces')}>
                  {pieces}
                </td>
              )
            case 'lineTotal':
              return (
                <td key="t" className="fw-lt-fact fw-lt-num" data-label={t('lines.col.lineTotal')}>
                  {amountText(money, locale)}
                </td>
              )
            default:
              return <td key={`${column.key}-${index}`} className="fw-lt-empty" />
          }
        })}
      </tr>
    </tfoot>
  )
}

/** The line a cell's words name ("BLK · Black"), for the bar's held reasons. */
export const lineNameOf = (order: Pick<Order, 'lines'>, draft: LinesDraft, key: string): string => {
  const line: OrderLine | undefined = order.lines.find((entry) => entry.id === key)
  if (line) return line.colourway ? `${line.colourway.code} · ${line.colourway.name}` : String(line.seq)
  return draft.added.find((entry) => entry.key === key)?.colour ?? key
}
