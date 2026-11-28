'use client'

import { memo } from 'react'
import { Camera, ChevronDown, ChevronRight, Hourglass, Lock, Plus, Sigma, Trash2, X } from 'lucide-react'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import type { ICellRendererParams } from '@nexus/ui/grid'
import type { Translate } from '../../i18n/messages'
import type { Locale } from '../../i18n/locales'
import { formatDate, formatNumber } from '../../i18n/format'
import { StateChip } from '../../order-cells/view/StateChip'
import { DeptChip } from '../../department/view/DeptChip'
import type { Department } from '../../department/model'
import { RecordPicture } from '../../record-picture/view/RecordPicture'
import { useSheetPictures } from '../pictures'
import { sheetIconOf } from '../icons'
import type { OrdersSheetOrder, SheetChip, SheetColumnId, SheetKind, SheetOwnValue } from '../model'
import { askOf, departmentNoOf, detailsOf, heldWhyOf, mainActOf, materialsOf, orderOwnOf, ownWordsOf, sideActOf, targetOf, type SheetAct, type SheetRow } from '../rows'

/** What every cell of the sheet reads (AG's grid context, set again when it changes). */
export interface SheetContext {
  readonly kind: SheetKind
  readonly withNew: boolean
  readonly shut: ReadonlySet<string>
  readonly totals: { readonly orders: number; readonly lines: number; readonly pieces: number; readonly selected: boolean }
  readonly t: Translate
  readonly locale: Locale
  readonly department: (no: number) => Department | null
  readonly onToggle: (orderKey: string) => void
  readonly onOpen: (target: string) => void
  readonly onNewOrder: (column: SheetColumnId) => void
}

type CellParams = ICellRendererParams<SheetRow, unknown, SheetContext> & { readonly column?: { getColId(): string } }

/** A day (`YYYY-MM-DD`) in the person's words; noon UTC, so no time zone moves it to another day. */
export const dayWords = (day: string, locale: Locale): string => formatDate(`${day}T12:00:00Z`, { locale })

// ---- the pinned first column ------------------------------------------------------------------------------------------------

export const IdentityCell = memo(function IdentityCell(params: CellParams) {
  const row = params.data
  const ctx = params.context
  if (!row || !ctx) return null
  const { t } = ctx
  if (row.kind === 'T') {
    return (
      <span className="fw-osh-id fw-osh-id-total">
        <Sigma size={14} aria-hidden />
        <span>{ctx.totals.selected ? t('part.totals.selected', { count: ctx.totals.orders }) : t('part.totals.all', { count: ctx.totals.orders })}</span>
      </span>
    )
  }
  if (row.kind === 'N') {
    return (
      <button type="button" className="fw-osh-id fw-osh-id-new" onClick={() => ctx.onNewOrder(ctx.kind === 'office' ? 'customer' : 'what')} title={t('part.newRow.tip')}>
        <span className="fw-osh-badge is-new" aria-hidden>
          <Plus size={12} />
        </span>
        <span className="fw-osh-strong">{t('part.newRow.words')}</span>
        <span className="fw-osh-muted">{t('part.newRow.hint')}</span>
      </button>
    )
  }
  const order = row.order
  if (!order) return null
  if (row.kind === 'C') {
    const line = row.line
    return (
      <span className="fw-osh-id fw-osh-id-line">
        <span className="fw-osh-badge is-line" aria-hidden>
          C
        </span>
        <span className="fw-osh-muted">{t('part.line.of', { seq: row.index + 1, count: order.lines.length })}</span>
        {line?.product && <span className="fw-osh-code">{line.product.code}</span>}
      </span>
    )
  }
  const shut = ctx.shut.has(order.key)
  const deptNo = ctx.kind === 'office' ? departmentNoOf(order) : null
  const dept = deptNo === null ? null : ctx.department(deptNo)
  const number = order.number ?? t('part.noNumber')
  return (
    <span className="fw-osh-id">
      <button type="button" className="fw-osh-chev" onClick={() => ctx.onToggle(order.key)} aria-expanded={!shut} aria-label={shut ? t('part.lines.show', { number }) : t('part.lines.hide', { number })}>
        {shut ? <ChevronRight size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
      </button>
      <span className="fw-osh-badge" aria-hidden>
        P
      </span>
      <OrderPictureButton order={order} number={number} onOpen={() => ctx.onOpen(targetOf('picture', order.key))} t={t} />
      <button type="button" className="fw-osh-door fw-osh-number" onClick={() => ctx.onOpen(targetOf('open', order.key))} title={t('part.open', { number })}>
        {number}
      </button>
      <span className="fw-osh-grow" />
      {dept && <DeptChip dept={dept} />}
      {order.may.editLines === 'DRAFT' && (
        <Button size="sm" variant="quiet" aria-label={t('part.addLine', { number })} title={t('part.addLine', { number })} onClick={() => ctx.onOpen(targetOf('addLine', order.key))}>
          <Plus size={14} aria-hidden />
        </Button>
      )}
      {order.life === 'DRAFT' && order.may.deleteDraft && (
        <Button size="sm" variant="quiet" aria-label={t('part.deleteDraft', { number })} title={t('part.deleteDraft', { number })} onClick={() => ctx.onOpen(targetOf('deleteDraft', order.key))}>
          <Trash2 size={14} aria-hidden />
        </Button>
      )}
    </span>
  )
})

/** The order's picture: the button to choose another (§ 5zj A); a small camera shows while the mouse is on the row. */
export function OrderPictureButton({ order, number, onOpen, t, size = 'cell' }: { order: OrdersSheetOrder; number: string; onOpen: () => void; t: Translate; size?: 'cell' | 'phone' }) {
  const pictures = useSheetPictures()
  return (
    <span className="fw-osh-pic">
      <RecordPicture source={pictures.sourceOf(order.record)} recordId={order.record.id} number={number} size={size} read={pictures.read} onOpen={onOpen} />
      <Camera className="fw-osh-cam" size={12} aria-hidden />
      <span className="nds-vh">{t('part.picture.choose', { number })}</span>
    </span>
  )
}

// ---- the value cells --------------------------------------------------------------------------------------------------------

function AskMark({ to, t }: { to: string; t: Translate }) {
  return (
    <span className="fw-osh-ask" title={t('part.ask.tip', { to })}>
      <Hourglass size={12} aria-hidden />
      <span>{t('part.ask.asked', { to })}</span>
    </span>
  )
}

export function ChipButton({ chip, onOpen }: { chip: SheetChip; onOpen: (target: string) => void }) {
  const Icon = sheetIconOf(chip.icon)
  const icon = Icon ? <Icon size={11} aria-hidden /> : undefined
  if (!chip.door) {
    return (
      <Pill tone={chip.tone} icon={icon} title={chip.hint ?? chip.words}>
        {chip.words}
      </Pill>
    )
  }
  const target = chip.door.target
  return (
    <Pill tone={chip.tone} icon={icon} title={chip.hint ?? chip.words} aria-label={chip.hint ?? chip.words} onClick={() => onOpen(target)}>
      {chip.words}
    </Pill>
  )
}

/** The chips of an order: the first three, then "+ n" with the rest in its tip. */
export function ChipRow({ chips, onOpen, t, max = 3 }: { chips: readonly SheetChip[]; onOpen: (target: string) => void; t: Translate; max?: number }) {
  if (chips.length === 0) return <span className="fw-osh-muted">—</span>
  const shown = chips.slice(0, max)
  const rest = chips.slice(max)
  return (
    <span className="fw-osh-chips">
      {shown.map((chip, index) => (
        <ChipButton key={`${chip.words}:${index}`} chip={chip} onOpen={onOpen} />
      ))}
      {rest.length > 0 && (
        <Pill tone="neutral" title={rest.map((chip) => chip.words).join(' · ')}>
          {t('part.more', { count: rest.length })}
        </Pill>
      )}
    </span>
  )
}

export function DetailChips({ own, t }: { own: readonly SheetOwnValue[]; t: Translate }) {
  const yesNo = { yes: t('part.yes'), no: t('part.no') }
  const { shown, more } = detailsOf(own)
  if (shown.length === 0) return <span className="fw-osh-muted">—</span>
  const words = (value: SheetOwnValue) => `${value.name}: ${ownWordsOf(value, yesNo) ?? ''}`
  return (
    <span className="fw-osh-chips">
      {shown.map((value) => (
        <Tag key={`${value.columnId}:${String(value.value)}`} truncate title={words(value)}>
          {words(value)}
        </Tag>
      ))}
      {more.length > 0 && (
        <Tag title={more.map(words).join(' · ')}>{t('part.more', { count: more.length })}</Tag>
      )}
    </span>
  )
}

const ACT_ICON: Partial<Record<SheetAct, typeof X>> = { withdraw: X, askCancel: X }

export function ActButtons({ order, kind, t, onOpen }: { order: OrdersSheetOrder; kind: SheetKind; t: Translate; onOpen: (target: string) => void }) {
  const main = mainActOf(order, kind)
  const side = sideActOf(order, kind)
  const SideIcon = side ? (ACT_ICON[side] ?? X) : null
  return (
    <span className="fw-osh-acts">
      <Button size="sm" variant={main.primary ? 'primary' : 'quiet'} onClick={() => onOpen(targetOf(main.act, order.key))}>
        {t(`part.act.${main.act}`)}
      </Button>
      {side && SideIcon && (
        <Button size="sm" variant="quiet" aria-label={t(`part.act.${side}`)} title={t(`part.act.${side}`)} onClick={() => onOpen(targetOf(side, order.key))}>
          <SideIcon size={14} aria-hidden />
        </Button>
      )}
    </span>
  )
}

/** One cell of a data column (the column's id is the renderer's own param). */
export const ValueCell = memo(function ValueCell(params: CellParams & { readonly sheetColumn: SheetColumnId }) {
  const row = params.data
  const ctx = params.context
  const column = params.sheetColumn
  if (!row || !ctx) return null
  const { t, locale } = ctx
  if (row.kind === 'T') {
    return column === 'pieces' ? <span className="fw-osh-strong">{formatNumber(ctx.totals.pieces, locale)}</span> : null
  }
  if (row.kind === 'N') {
    if (ctx.kind === 'office' && column === 'customer') {
      return (
        <button type="button" className="fw-osh-door fw-osh-placeholder" onClick={() => ctx.onNewOrder('customer')}>
          {t('part.newRow.customer')}
        </button>
      )
    }
    if (column === 'what') return <span className="fw-osh-placeholder">{t(ctx.kind === 'office' ? 'part.newRow.subject' : 'part.newRow.type')}</span>
    return null
  }
  const order = row.order
  if (!order) return null
  const held = heldWhyOf(row, column, ctx.kind)
  const ask = askOf(row, column)
  const askMark = ask ? <AskMark to={ask.to} t={t} /> : null
  const heldMark = held === 'confirmFirst' ? <Lock size={11} className="fw-osh-heldmark" aria-label={t('part.held.confirmFirst')} /> : null

  if (row.kind === 'P') {
    switch (column) {
      case 'what':
        return <span className="fw-osh-cellrow">{order.subject ? <span className="fw-osh-strong fw-osh-ell">{order.subject}</span> : <span className="fw-osh-placeholder">{t('part.noSubject')}</span>}{heldMark}</span>
      case 'customer':
        return order.customer ? (
          <span className="fw-osh-cellrow">
            <span className="fw-osh-ell">{order.customer.name}</span>
            <span className="fw-osh-code">{order.customer.code}</span>
          </span>
        ) : (
          <span className="fw-osh-muted">—</span>
        )
      case 'wanted':
        return <span className="fw-osh-cellrow">{order.wantedFor ? dayWords(order.wantedFor, locale) : <span className="fw-osh-muted">—</span>}{heldMark}</span>
      case 'promised':
        return order.promised && order.life !== 'DRAFT' && order.life !== 'SENT' ? (
          <span className="fw-osh-cellrow">
            {dayWords(order.promised, locale)}
            {order.daysLate !== null && order.daysLate > 0 && <Pill tone="danger">{t('part.late', { count: order.daysLate })}</Pill>}
          </span>
        ) : (
          <span className="fw-osh-muted" title={t('part.promisedLater')}>
            —
          </span>
        )
      case 'where':
        return (
          <button type="button" className="fw-osh-door fw-osh-cellrow" onClick={() => ctx.onOpen(targetOf('open', order.key))} aria-label={t('part.open', { number: order.number ?? t('part.noNumber') })}>
            <StateChip life={order.life} />
            {order.where?.held && <Pill tone="warning">{t('part.onHold')}</Pill>}
          </button>
        )
      case 'news':
        return <ChipRow chips={order.chips} onOpen={ctx.onOpen} t={t} />
      case 'material': {
        const materials = materialsOf(order)
        if (materials.length === 0) return <span className="fw-osh-muted">—</span>
        return <span className="fw-osh-muted fw-osh-ell">{materials.map((material) => material ?? t('part.notDecided')).join(' · ')}</span>
      }
      case 'sizes':
        return <span className="fw-osh-muted">—</span>
      case 'pieces':
        return <span className="fw-osh-strong">{formatNumber(order.pieces, locale)}</span>
      case 'details':
        return <DetailChips own={orderOwnOf(order)} t={t} />
      case 'act':
        return <ActButtons order={order} kind={ctx.kind} t={t} onOpen={ctx.onOpen} />
    }
    return null
  }

  const line = row.line
  if (!line) return null
  switch (column) {
    case 'what': {
      const words = line.product ? `${line.product.code} · ${line.product.name}` : line.text
      return (
        <span className="fw-osh-cellrow">
          {words ? <span className="fw-osh-ell">{words}</span> : <span className="fw-osh-placeholder">{t('part.pickProduct')}</span>}
          {!line.product && line.text && <Pill tone="info">{t('part.asText')}</Pill>}
          {heldMark}
          {askMark}
        </span>
      )
    }
    case 'material':
      return (
        <span className="fw-osh-cellrow">
          {line.material ? (
            <span className="fw-osh-ell">{line.material}</span>
          ) : (
            <span className="fw-osh-open">
              <Hourglass size={12} aria-hidden />
              {t('part.notDecided')}
            </span>
          )}
          {heldMark}
          {askMark}
        </span>
      )
    case 'sizes':
      return (
        <span className="fw-osh-cellrow">
          {line.sizeFileId ? (
            <Tag>{t('part.sizeFile')}</Tag>
          ) : line.sizes ? (
            <span className="fw-osh-ell">{line.sizes}</span>
          ) : (
            <span className="fw-osh-open">
              <Hourglass size={12} aria-hidden />
              {t('part.comeLater')}
            </span>
          )}
          {heldMark}
          {askMark}
        </span>
      )
    case 'pieces':
      return (
        <span className="fw-osh-cellrow fw-osh-num">
          {formatNumber(line.pieces, locale)}
          {heldMark}
          {askMark}
        </span>
      )
    case 'details':
      return <DetailChips own={line.own} t={t} />
    default:
      return null
  }
})
