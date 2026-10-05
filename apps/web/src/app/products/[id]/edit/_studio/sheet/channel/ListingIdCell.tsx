'use client'

/**
 * The listing's channel id column — one cell, per channel:
 *
 * Amazon (Amazon sheet gaps, gap 5): the market's ASIN (`listing_asin`, the listing's `externalListingId` on this
 * market; a parent row shows the parent ASIN). Read-only: Amazon assigns it.
 *   ASIN       mono text, with the DS cell actions Copy and Open on Amazon (`listingUrl`). Keyboard: Ctrl/⌘+C on the
 *              cell copies (AG's clipboard), Enter opens it on Amazon.
 *   pending    published, the ASIN not read back yet — the shared rule (`isAsinPending`) and the header chip's words.
 *   draft      a Nexus draft, nothing sent — the shared rule (`isStillDraftListing`) and the header chip's words.
 *   none       a dash; the hover says why (the server's sentence).
 *
 * eBay (Item ID control, step I1 — docs/sheet-ids-sku-rows): the Item ID (`listing_item_id`). The server's value is the
 * id only when it counts (`studio-stock.ts` `listingItemIdValue`); every state below is read from the row, never guessed.
 *   item            id + Copy + Open on eBay; an ended item says Ended (Relist makes a new Item ID).
 *   Not confirmed   Nexus holds an id it cannot vouch for (a Draft or Error row with an id; a variation holding another
 *                   item than its main row): a warning pill, the id and the reason in the hover.
 *   draft           "Draft · not published".  No number recorded: live in Nexus without an id (a warning pill).
 *   none            a dash.
 * On the family's MAIN row the cell is the control (`channelIdControl.tsx`): Enter or a double-click opens it, Delete
 * clears the id (a plain confirm). One eBay item carries the whole family, so a variation row is read-only and its
 * hover says "Set on the main row" (the server's sentence; Enter repeats it).
 */
import { memo, useEffect, useState } from 'react'
import { Check, Copy, ExternalLink, Pencil } from 'lucide-react'

import { CellAction } from '@/design-system/components'
import { Pill } from '@/design-system/primitives'
import { EmptyValue, type ColDef, type ICellRendererParams } from '@/design-system/grid'
import { isAsinPending } from '@nexus/shared/listing-risk'

import { ASIN_PENDING_CHIP_LABEL, asinPendingChipDetail, DRAFT_CHIP_LABEL, draftChipDetail, isStillDraftListing } from '../../draftListing'
import { listingUrl } from '../../drawer/listingUrl'
import { MATRIX_COPY } from '../../matrix/contract'
import { useChannelIdControl } from './channelIdControl'
import { LISTING_ASIN_KEY, LISTING_ITEM_ID_KEY } from './stockCells'
import type { ChannelScope, ChannelSheetRow, SheetColumn } from './types'

/** The parent row's hover (API `studio-stock.ts`): a parent ASIN groups the variations and is not for sale itself. */
export const PARENT_ASIN_NOTE = 'Parent ASIN — not buyable'
export const ASIN_COPY = {
  copy: (asin: string) => `Copy ASIN ${asin}`,
  copyDetail: 'Ctrl+C on the cell copies it too.',
  copied: 'ASIN copied',
  open: 'Open on Amazon',
  openDetail: (market: string) => `Opens the listing on Amazon · ${market} in a new tab. Enter on the cell opens it too.`,
} as const
/** The ASIN plus the two cell actions fit without cutting the ASIN (10 mono characters + two 24 px actions). */
export const ASIN_COLUMN_MIN_WIDTH = 168

/** The eBay Item ID cell's words (the API's `ITEM_ID_COPY` says the same of a variation row). */
export const ITEM_ID_COPY = {
  copy: (id: string) => `Copy Item ID ${id}`,
  copyDetail: 'Ctrl+C on the cell copies it too.',
  copied: 'Item ID copied',
  open: 'Open on eBay',
  openDetail: (market: string) => `Opens the item on eBay · ${market} in a new tab.`,
  change: 'Change Item ID',
  changeDetail: 'Enter or a double-click on the cell opens it too. Delete clears it.',
  ended: 'Ended',
  notConfirmed: 'Not confirmed',
  noNumber: 'No number recorded',
  live: (id: string) => `eBay Item ID ${id}. Enter or a double-click: link another item, or clear it.`,
  endedHover: (id: string) => `eBay Item ID ${id}: the item ended on eBay. Relist makes a new Item ID. Enter or a double-click: link another item, or clear it.`,
  notConfirmedHover: (id: string, status: string) => `Not confirmed: Nexus holds Item ID ${id}, but this listing reads ${status ? status.toLowerCase() : 'no status'} in Nexus, so it is not known to sell on eBay. Enter or a double-click: Check asks eBay, then Keep or Clear.`,
  draftHover: (market: string) => `${draftChipDetail('EBAY', market)} Enter or a double-click links an item that already sells on eBay.`,
  noNumberHover: 'No number recorded: this listing reads live in Nexus, but Nexus holds no eBay Item ID for it. Enter or a double-click: type the Item ID to link it.',
} as const

export type AsinCellModel =
  | { kind: 'asin'; asin: string; url: string | null; tooltip: string | null }
  | { kind: 'pending' | 'draft'; label: string; tooltip: string }
  | { kind: 'none'; tooltip: string | null }

/** eBay: `editable` = this row's cell is the control (the main row with a listing). */
export type ItemIdCellModel =
  | { kind: 'item'; itemId: string; url: string | null; ended: boolean; tooltip: string | null; editable: boolean }
  | { kind: 'notConfirmed'; itemId: string; label: string; tooltip: string | null; editable: boolean }
  | { kind: 'draft'; label: string; tooltip: string | null; editable: boolean }
  | { kind: 'noNumber'; label: string; tooltip: string | null; editable: boolean }
  | { kind: 'none'; tooltip: string | null; editable: boolean }

export type ListingIdCellModel = AsinCellModel | ItemIdCellModel

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** PURE — what one row's ASIN cell shows, from the row and its market. */
export function asinCellModel(row: Pick<ChannelSheetRow, 'isParent' | 'listing' | 'values'>, market: string): AsinCellModel {
  const cell = row.values?.[LISTING_ASIN_KEY]
  const asin = text(cell?.value) || text(row.listing?.externalListingId)
  if (asin) return { kind: 'asin', asin, url: listingUrl('AMAZON', market, asin), tooltip: row.isParent ? PARENT_ASIN_NOTE : null }
  const listing = row.listing
  if (listing && isAsinPending({ ...listing, channel: 'AMAZON' })) return { kind: 'pending', label: ASIN_PENDING_CHIP_LABEL, tooltip: asinPendingChipDetail(1, market) }
  if (listing && isStillDraftListing(listing)) return { kind: 'draft', label: DRAFT_CHIP_LABEL, tooltip: draftChipDetail('AMAZON', market) }
  return { kind: 'none', tooltip: cell?.writeBlockedReason ?? null }
}

/**
 * PURE — what one row's eBay Item ID cell shows. The server's value is the id only when it counts; with none, the id
 * the listing holds is "Not confirmed". A variation row's hover is the server's sentence ("Set on the main row").
 */
export function itemIdCellModel(row: Pick<ChannelSheetRow, 'parentId' | 'listing' | 'values'>, market: string): ItemIdCellModel {
  const cell = row.values?.[LISTING_ITEM_ID_KEY]
  const listing = row.listing
  const main = !row.parentId
  const editable = main && !!listing
  const served = (fallback: string | null) => (main ? fallback : cell?.writeBlockedReason ?? fallback)
  if (!listing) return { kind: 'none', tooltip: cell?.writeBlockedReason ?? MATRIX_COPY.noListingYet, editable: false }
  const value = text(cell?.value)
  const held = text(listing.externalListingId)
  const status = text(listing.listingStatus).toUpperCase()
  if (value) {
    const ended = status === 'ENDED'
    return { kind: 'item', itemId: value, url: listingUrl('EBAY', market, value), ended, tooltip: served(ended ? ITEM_ID_COPY.endedHover(value) : ITEM_ID_COPY.live(value)), editable }
  }
  if (held) return { kind: 'notConfirmed', itemId: held, label: ITEM_ID_COPY.notConfirmed, tooltip: served(ITEM_ID_COPY.notConfirmedHover(held, status)), editable }
  if (isStillDraftListing(listing)) return { kind: 'draft', label: DRAFT_CHIP_LABEL, tooltip: served(ITEM_ID_COPY.draftHover(market)), editable }
  if (status === 'ACTIVE' || listing.isPublished) return { kind: 'noNumber', label: ITEM_ID_COPY.noNumber, tooltip: served(ITEM_ID_COPY.noNumberHover), editable }
  return { kind: 'none', tooltip: served(cell?.writeBlockedReason ?? null), editable }
}

/** The channel id columns this cell draws: Amazon's ASIN and eBay's Item ID. */
export const isListingIdKey = (key: string): boolean => key === LISTING_ASIN_KEY || key === LISTING_ITEM_ID_KEY

type Scope = Pick<ChannelScope, 'channel' | 'marketplace'>

/** PURE — one model for both channels: the ASIN on Amazon, the Item ID on eBay. */
export function listingIdCellModel(row: Pick<ChannelSheetRow, 'isParent' | 'parentId' | 'listing' | 'values'>, scope: Scope): ListingIdCellModel {
  return String(scope.channel).toUpperCase() === 'EBAY' ? itemIdCellModel(row, scope.marketplace) : asinCellModel(row, scope.marketplace)
}

/** The cell's text for copy, export and the filters: the id that counts, or nothing. */
export const listingIdCellText = (row: Pick<ChannelSheetRow, 'isParent' | 'parentId' | 'listing' | 'values'> | undefined, scope: Scope): string => {
  const model = row ? listingIdCellModel(row, scope) : null
  return model?.kind === 'asin' ? model.asin : model?.kind === 'item' ? model.itemId : ''
}

/** The ASIN's text (kept for its callers). */
export const asinCellText = (row: Pick<ChannelSheetRow, 'isParent' | 'listing' | 'values'> | undefined, market: string): string => {
  const model = row ? asinCellModel(row, market) : null
  return model?.kind === 'asin' ? model.asin : ''
}

export interface AsinCellParams { market: string }

/** Enter on a focused ASIN cell opens it on Amazon; every other key stays AG's (arrows, Tab, Ctrl+C). */
export function asinCellKeys(p: { event: KeyboardEvent; editing: boolean; data?: ChannelSheetRow }, market: string, open: (url: string) => void = openInNewTab): boolean {
  if (p.editing || p.event.key !== 'Enter' || p.event.ctrlKey || p.event.metaKey || p.event.altKey || p.event.shiftKey) return false
  const model = p.data ? asinCellModel(p.data, market) : null
  if (model?.kind !== 'asin' || !model.url) return false
  // AG asks for keydown AND keypress; act once.
  if (p.event.type === 'keydown') { p.event.preventDefault(); open(model.url) }
  return true
}

/**
 * eBay: the keys the control takes on a main row — Enter opens it, Delete (or Backspace) opens its Clear confirm. The
 * cell's own listener acts (it reaches the control); this only keeps the grid from acting on them too.
 */
export function itemIdKeyIntent(p: { event: KeyboardEvent; editing: boolean; data?: ChannelSheetRow }, market: string): 'edit' | 'clear' | null {
  if (p.editing || p.event.ctrlKey || p.event.metaKey || p.event.altKey || p.event.shiftKey) return null
  const model = p.data ? itemIdCellModel(p.data, market) : null
  if (!model?.editable) return null
  if (p.event.key === 'Enter') return 'edit'
  if (p.event.key === 'Delete' || p.event.key === 'Backspace') return model.kind === 'item' || model.kind === 'notConfirmed' ? 'clear' : null
  return null
}

function openInNewTab(url: string): void {
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer')
}

function useCopied(): [boolean, (value: string) => void] {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return [copied, (value: string) => { void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => undefined) }]
}

const focusCellOf = (p: ICellRendererParams<ChannelSheetRow>) => () => {
  const column = p.column?.getColId()
  if (p.node.rowIndex != null && column) p.api.setFocusedCell(p.node.rowIndex, column)
}

export const AsinCell = memo(function AsinCell(p: ICellRendererParams<ChannelSheetRow> & AsinCellParams) {
  const [copied, copy] = useCopied()
  const row = p.data
  if (!row) return null
  const model = asinCellModel(row, p.market)
  if (model.kind === 'none') return <EmptyValue />
  // The detail is the column's hover (`tooltipValueGetter`), as on every sheet cell — never a second native title.
  if (model.kind !== 'asin') return <span className="nds-cell-value"><Pill tone="info">{model.label}</Pill></span>
  const focusCell = focusCellOf(p)
  // `nds-reveal-row`: the cell actions show while the pointer is on the cell (the sheet's Shopify cells do the same, on the cell).
  return (
    <span className="nds-cell-value nds-reveal-row">
      <span className="nds-cell-value-text nds-projcell-detail">{model.asin}</span>
      <CellAction label={copied ? ASIN_COPY.copied : ASIN_COPY.copy(model.asin)} description={ASIN_COPY.copyDetail}
        icon={copied ? <Check size={13} /> : <Copy size={13} />} onFocusCell={focusCell}
        onActivate={() => copy(model.asin)} />
      {model.url && (
        <CellAction label={ASIN_COPY.open} description={ASIN_COPY.openDetail(p.market)} icon={<ExternalLink size={13} />} onFocusCell={focusCell}
          onActivate={() => openInNewTab(model.url!)} />
      )}
    </span>
  )
})

export interface ItemIdCellParams { market: string }

/** The eBay Item ID cell. On the main row it is the control's door: Enter, a double-click and Delete reach it here. */
export const ItemIdCell = memo(function ItemIdCell(p: ICellRendererParams<ChannelSheetRow> & ItemIdCellParams) {
  const [copied, copy] = useCopied()
  const control = useChannelIdControl()
  const row = p.data
  const model = row ? itemIdCellModel(row, p.market) : null
  const door = !!control && !!model?.editable
  const cell = p.eGridCell
  useEffect(() => {
    if (!door || !cell || !row) return
    const onKey = (event: KeyboardEvent) => {
      const intent = itemIdKeyIntent({ event, editing: false, data: row }, p.market)
      if (!intent || event.target !== cell) return
      event.preventDefault()
      control!.open(row, intent)
    }
    const onDouble = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-nds-cell-action]')) return
      control!.open(row, 'edit')
    }
    cell.addEventListener('keydown', onKey)
    cell.addEventListener('dblclick', onDouble)
    return () => { cell.removeEventListener('keydown', onKey); cell.removeEventListener('dblclick', onDouble) }
  }, [door, cell, row, control, p.market])
  if (!row || !model) return null
  const focusCell = focusCellOf(p)
  const change = door
    ? <CellAction label={ITEM_ID_COPY.change} description={ITEM_ID_COPY.changeDetail} icon={<Pencil size={13} />} onFocusCell={focusCell} onActivate={() => control!.open(row, 'edit')} />
    : null
  if (model.kind === 'none') return change ? <span className="nds-cell-value nds-reveal-row"><EmptyValue />{change}</span> : <EmptyValue />
  if (model.kind === 'draft' || model.kind === 'noNumber') {
    return <span className="nds-cell-value nds-reveal-row"><Pill tone={model.kind === 'draft' ? 'info' : 'warning'}>{model.label}</Pill>{change}</span>
  }
  if (model.kind === 'notConfirmed') {
    return <span className="nds-cell-value nds-reveal-row"><Pill tone="warning">{model.label}</Pill>
      <span className="nds-cell-value-text nds-projcell-detail">{model.itemId}</span>{change}</span>
  }
  return (
    <span className="nds-cell-value nds-reveal-row">
      <span className="nds-cell-value-text nds-projcell-detail">{model.itemId}</span>
      {model.ended && <Pill tone="neutral">{ITEM_ID_COPY.ended}</Pill>}
      <CellAction label={copied ? ITEM_ID_COPY.copied : ITEM_ID_COPY.copy(model.itemId)} description={ITEM_ID_COPY.copyDetail}
        icon={copied ? <Check size={13} /> : <Copy size={13} />} onFocusCell={focusCell} onActivate={() => copy(model.itemId)} />
      {model.url && <CellAction label={ITEM_ID_COPY.open} description={ITEM_ID_COPY.openDetail(p.market)} icon={<ExternalLink size={13} />}
        onFocusCell={focusCell} onActivate={() => openInNewTab(model.url!)} />}
      {change}
    </span>
  )
})

/** The column is wide enough for a 12-digit Item ID and three cell actions. */
export const ITEM_ID_COLUMN_MIN_WIDTH = 200

/**
 * The channel id column's ColDef — spread LAST over the sheet's own column (like the stock columns): the renderer, the
 * ONE text (copy, export, filters), the hover and the keys. Never the grid's own editor: the ASIN is read-only, and the
 * eBay Item ID changes only through its control (a variation row: never).
 */
export function listingIdColumnDef(col: SheetColumn, scope: Scope): ColDef<ChannelSheetRow> {
  const ebay = String(scope.channel).toUpperCase() === 'EBAY'
  const market = scope.marketplace
  const params: AsinCellParams & ItemIdCellParams = { market }
  const textOf = (row: ChannelSheetRow | undefined) => listingIdCellText(row, scope)
  const minWidth = ebay ? ITEM_ID_COLUMN_MIN_WIDTH : ASIN_COLUMN_MIN_WIDTH
  return {
    colId: col.key,
    minWidth,
    width: Math.max(col.width ?? minWidth, minWidth),
    editable: false,
    suppressFillHandle: true,
    cellDataType: false,
    cellClass: 'nds-ag-cell',
    cellClassRules: {},
    cellRenderer: ebay ? ItemIdCell : AsinCell,
    cellRendererParams: params,
    cellEditorSelector: undefined,
    valueParser: undefined,
    valueSetter: () => false,
    valueGetter: (p) => textOf(p.data) || null,
    valueFormatter: (p) => textOf(p.data),
    filterValueGetter: (p) => textOf(p.data),
    getQuickFilterText: (p) => textOf(p.data),
    tooltipValueGetter: (p) => {
      const model = p.data ? listingIdCellModel(p.data, scope) : null
      return model?.tooltip ?? undefined
    },
    suppressKeyboardEvent: (p) => (ebay ? itemIdKeyIntent(p as never, market) !== null : asinCellKeys(p as never, market)),
  }
}

/** The ASIN column's ColDef (kept for its callers): the Amazon branch of `listingIdColumnDef`. */
export const asinColumnDef = (col: SheetColumn, market: string): ColDef<ChannelSheetRow> => listingIdColumnDef(col, { channel: 'AMAZON', marketplace: market })
