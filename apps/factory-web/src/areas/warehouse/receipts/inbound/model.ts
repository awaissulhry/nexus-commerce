import type { BoardCard, BoardLane, BoardTone } from '@nexus/ui/grid/views/board/index'
import type { ExpectedLine } from '../api'
import { blankHide, blankLot, draftKey, type HideDraft, type LotDraft, type ReceiveDraft } from '../model'
import type { InboundBoardData, InboundCard, NoticePrefill } from './api'

/**
 * The inbound board, pure (B-W2b-182; SCM-110; design warehouse.receipts sec:rc-inbound "7 day columns × site rows; a card
 * per delivery: supplier, PO, lines, ASN tracking status, dock note; card → PO; 'Receive' on a card creates the receipt
 * pre-filled; empty day: nothing drawn") and the page's "Inbound board on / off (W2b)" (h.more): a person's choice on this
 * device, on by default. And the receiving form filled from a ship notice: its lines, a lot per dye batch, each hide with
 * the area the tannery declared (the receiver measures and corrects; B-W2b-94).
 */

export const INBOUND_NAMESPACE = 'warehouse-inbound'
export const INBOUND_DAYS = 7
const STORE = 'factory.receipts.inbound'

/** Whether the board is shown on this device (default on; a blocked storage reads as on). */
export function readInboundOn(): boolean {
  try {
    return window.localStorage.getItem(STORE) !== 'off'
  } catch {
    return true
  }
}

export function writeInboundOn(on: boolean): void {
  try {
    if (on) window.localStorage.removeItem(STORE)
    else window.localStorage.setItem(STORE, 'off')
  } catch {
    // A private window keeps the choice for this page only.
  }
}

/** What the board's container hands its view (made-up in the design cases). */
export interface InboundModel {
  prefix: string
  /** The person's choice on this device. */
  on: boolean
  board: { status: 'loading' } | { status: 'ready'; value: InboundBoardData } | { status: 'error'; problem: string } | { status: 'forbidden' }
  today: string
  /** inventory.receive at the board's sites: Receive and the dock note. */
  canReceive: boolean
  timeZone: string
  /** A dock note being written (the card's notice id). */
  noting?: { card: InboundCard; text: string; saving: boolean; problem: string | null } | null
}

export interface InboundActions {
  onToggle?: (on: boolean) => void
  onRetry?: () => void
  onReceive?: (card: InboundCard) => void
  onNote?: (card: InboundCard | null) => void
  onNoteText?: (text: string) => void
  onNoteSave?: () => void
}

export type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

/** `Mon 9 Nov`, `Today` in the page's language. */
export function dayLabel(day: string, locale: 'it' | 'en'): string {
  return new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`))
}

/** A decimal as the API sends it (4 places) as a person types it: `21.0000` → `21`, `10.5000` → `10.5`. */
export const trimZeros = (text: string): string => (text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text)

/** The board's columns: one per day (the first also carries what is late). */
export function lanesOf(board: Pick<InboundBoardData, 'days'>, cards: readonly InboundCard[], today: string, locale: 'it' | 'en', t: Translate): BoardLane[] {
  return board.days.map((day, index) => {
    const own = cards.filter((card) => card.day === day)
    const late = index === 0 ? own.filter((card) => card.late).length : 0
    return {
      id: day,
      label: day === today ? t('lane.today', { day: dayLabel(day, locale) }) : dayLabel(day, locale),
      detail: late > 0 ? t('lane.late', { count: late }) : null,
      total: own.length,
      tone: (late > 0 ? 'danger' : day === today ? 'info' : 'neutral') as BoardTone,
    }
  })
}

const STATE_TONE = { ANNOUNCED: 'info', IN_TRANSIT: 'info', DRAFT: 'neutral', RECEIVED: 'success', RECEIVED_WITH_DIFFERENCES: 'warning', CANCELLED: 'neutral' } as const
const VERDICT_TONE = { OK: 'success', CHECK: 'warning', NOT_AS_ORDERED: 'danger' } as const

/** A delivery as a card: the PO's number, the supplier, its lines, the ASN's tracking state, the dock note; the card opens the PO. */
export function cardOf(card: InboundCard, prefix: string, t: Translate, quantity: (text: string) => string): BoardCard {
  const notice = card.shipNotice
  const items = card.items.map((item) => `${item.code} · ${quantity(item.quantity)} ${t(`uom.${item.uom}`)}`)
  const more = card.lines - card.items.length
  return {
    id: card.id,
    laneId: card.day,
    label: notice ? `${notice.number} · ${card.purchaseOrder.number}` : card.purchaseOrder.number,
    title: card.supplier.name,
    fields: [
      { label: t('card.lines'), value: more > 0 ? t('card.linesMore', { lines: items.join(', '), count: more }) : items.join(', ') || t('card.linesCount', { count: card.lines }) },
      ...(notice
        ? [
            { label: t('card.tracking'), value: [t(`state.${notice.state}`), notice.carrier, notice.trackingNumber].filter(Boolean).join(' · ') },
            ...(notice.hides > 0 ? [{ label: t('card.hides'), value: t('card.hidesCount', { count: notice.hides }) }] : []),
            ...(notice.supplierNote ? [{ label: t('card.supplierNote'), value: notice.supplierNote }] : []),
          ]
        : [{ label: t('card.tracking'), value: t('card.noNotice') }]),
      ...(card.dockNote ? [{ label: t('card.dockNote'), value: card.dockNote }] : []),
    ],
    marks: [
      ...(card.late ? [{ label: t('mark.late'), tone: 'danger' as BoardTone }] : []),
      ...(notice ? [{ label: t(`verdict.${notice.verdict}`), tone: VERDICT_TONE[notice.verdict] as BoardTone }, { label: t(`state.${notice.state}`), tone: STATE_TONE[notice.state] as BoardTone }] : [{ label: t('mark.confirmed'), tone: 'neutral' as BoardTone }]),
    ],
    href: `${prefix}/purchasing/orders/${card.purchaseOrder.id}`,
  }
}

/** Where Receive goes: the receiving page with the order, and the notice it is filled from. */
export function receiveHref(prefix: string, card: InboundCard): string {
  const query = new URLSearchParams({ order: card.purchaseOrder.id })
  if (card.shipNotice) query.set('notice', card.shipNotice.id)
  return `${prefix}/warehouse/receipts/new?${query.toString()}`
}

/** Why Receive is held on a card, as a key of the namespace (null: it may go). */
export const receiveHeldKey = (canReceive: boolean): string | null => (canReceive ? null : 'held.noReceive')

/** The board's sites as rows, each with its cards (a site without deliveries in the days is still a row: "nothing drawn"). */
export function siteRows(board: InboundBoardData): { site: InboundBoardData['sites'][number]; cards: InboundCard[] }[] {
  return board.sites.map((site) => ({ site, cards: board.cards.filter((card) => card.siteId === site.id) }))
}

// ---- the receiving form filled from a ship notice -------------------------------------------------------------------------

const hideOf = (line: ExpectedLine, hide: NoticePrefill['lines'][number]['lots'][number]['hides'][number]): HideDraft => ({
  ...blankHide(line, hide.areaUom),
  supplierCode: hide.supplierCode,
  area: trimZeros(hide.area),
  grade: hide.grade ?? '',
  thicknessMm: hide.thicknessMm ?? '',
})

/**
 * The form for the order's open lines, the notice's lines included and filled: the quantity (an untracked line), a lot per
 * lot / dye batch (a lot-kept line: what was announced), each hide with its declared area (a leather lot with no list: one
 * empty hide row); the DDT; the notice it is filled from (Post names it: the notice becomes received).
 */
export function draftFromNotice(orderId: string, lines: readonly ExpectedLine[], prefill: NoticePrefill): ReceiveDraft {
  const announced = new Map(prefill.lines.map((line) => [line.purchaseOrderLineId, line]))
  return {
    orderId,
    shipNoticeId: prefill.shipNoticeId,
    lines: lines
      .filter((line) => line.purchaseOrderId === orderId)
      .sort((a, b) => a.seq - b.seq)
      .map((line) => {
        const own = announced.get(line.purchaseOrderLineId)
        const tracked = line.item.tracking === 'HIDE' || line.item.tracking === 'LOT'
        const lots: LotDraft[] = !tracked
          ? []
          : own && own.lots.length > 0
            ? own.lots.map((lot) => {
                const base = blankLot(line)
                const hides = lot.hides.map((hide) => hideOf(line, hide))
                return { ...base, key: draftKey('l'), supplierLotRef: lot.supplierLotRef ?? '', dyeBatch: lot.dyeBatch ?? '', quantity: lot.quantity ? trimZeros(lot.quantity) : '', hides: line.item.tracking === 'HIDE' ? (hides.length > 0 ? hides : base.hides) : [] }
              })
            : [blankLot(line)]
        return { line, include: own !== undefined, quantity: own?.quantity ? trimZeros(own.quantity) : '', lots, differenceReason: '', note: '' }
      }),
    ddtNumber: prefill.supplierDdtNumber ?? '',
    ddtDate: prefill.supplierDdtDate ?? '',
    receivedAt: '',
    note: '',
  }
}
