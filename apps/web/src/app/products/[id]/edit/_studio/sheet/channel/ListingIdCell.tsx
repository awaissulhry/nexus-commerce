'use client'

/**
 * The listing's channel id column — one cell, per channel:
 *
 * Amazon (Amazon sheet gaps, gap 5; Item ID control, step I4): the market's ASIN (`listing_asin`, the listing's
 * `externalListingId` on this market; a parent row shows the parent ASIN).
 *   ASIN       mono text, with the DS cell actions Copy and Open on Amazon (`listingUrl`).
 *   suggested  a row not on Amazon with an ASIN set to list on at Publish (the server's `pendingId`): an info pill
 *              "Lists on B0X at Publish" — never shown as the row's ASIN.
 *   pending    published, the ASIN not read back yet — the shared rule (`isAsinPending`) and the header chip's words.
 *   draft      a Nexus draft, nothing sent — the shared rule (`isStillDraftListing`) and the header chip's words.
 *   none       a dash; the hover says why (the server's sentence).
 * Every Amazon row with a listing is its control's door (`channelIdControl.tsx`): Enter or a double-click opens it,
 * Delete clears an ASIN set for Publish. A live offer's ASIN is Amazon's: the control's Check says why and the way.
 *
 * eBay Item ID (I1), Etsy Listing ID (I2), Shopify Product ID (I3) (`listing_item_id`). The server's value is the id
 * only when it counts (`studio-stock.ts` `listingItemIdValue`; Shopify: only when the open sheet's Shopify read returned
 * the row); every state below is read from the row, never guessed.
 *   item            id + Copy (+ Open on eBay / Etsy; never on Shopify — the store's address is not known here, and a
 *                   guessed one could be another business's); an ended item says Ended; a Shopify draft or archived
 *                   product says so.
 *   Not confirmed   Nexus holds an id it cannot vouch for (eBay/Etsy: a Draft or Error row with an id, a variation holding
 *                   another id than its main row; Etsy: not found on its last read; Shopify: not returned by the read):
 *                   a warning pill, the id and the reason in the hover.
 *   draft           "Draft · not published".  No number recorded: live in Nexus without an id (a warning pill).
 *   none            a dash.
 * On the family's MAIN row the cell is the control: Enter or a double-click opens it, Delete clears the id (a plain
 * confirm). One id carries the whole family, so a variation row is read-only and its hover says "Set on the main row"
 * (the server's sentence).
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
/** The ASIN plus its cell actions fit without cutting the ASIN (10 mono characters + Copy, Open and Change). */
export const ASIN_COLUMN_MIN_WIDTH = 196
/** The words of the ASIN control's door and of a row that lists on an ASIN at Publish (step I4). */
export const ASIN_CONTROL_COPY = {
  change: 'Change ASIN',
  changeDetail: 'Enter or a double-click on the cell opens it too. On a row not on Amazon, Delete clears the ASIN set for Publish.',
  suggested: (asin: string) => `Lists on ${asin} at Publish`,
  suggestedHover: (asin: string) => `Lists on ${asin} at Publish: Publish sends this row to Amazon as an offer on ASIN ${asin}. It is not on Amazon yet. Enter or a double-click changes or clears it.`,
} as const

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

/** Etsy's Listing ID and Shopify's Product ID cells' words (eBay's are `ITEM_ID_COPY`; the API's `studio-stock.ts` says the same). */
export const CHANNEL_ITEM_ID_COPY = {
  EBAY: { ...ITEM_ID_COPY, missingHover: null as ((id: string) => string) | null, notReturnedHover: null as ((id: string) => string) | null },
  ETSY: {
    copy: (id: string) => `Copy Listing ID ${id}`,
    copyDetail: 'Ctrl+C on the cell copies it too.',
    copied: 'Listing ID copied',
    open: 'Open on Etsy',
    openDetail: (_market: string) => 'Opens the listing on Etsy in a new tab.',
    change: 'Change Listing ID',
    changeDetail: 'Enter or a double-click on the cell opens it too. Delete clears it.',
    ended: 'Ended',
    notConfirmed: 'Not confirmed',
    noNumber: 'No number recorded',
    live: (id: string) => `Etsy Listing ID ${id}. Enter or a double-click: link another listing, or clear it.`,
    endedHover: (id: string) => `Etsy Listing ID ${id}: the listing ended on Etsy (expired or removed). Enter or a double-click: link another listing, or clear it.`,
    notConfirmedHover: (id: string, status: string) => `Not confirmed: Nexus holds Listing ID ${id}, but this listing reads ${status ? status.toLowerCase() : 'no status'} in Nexus, so it is not known to sell on Etsy. Enter or a double-click: Check asks Etsy, then Keep or Clear.`,
    missingHover: (id: string) => `Not confirmed: Nexus holds Listing ID ${id}, but Etsy did not return it on its last read of this shop. Enter or a double-click: Check asks Etsy, then Keep or Clear.`,
    notReturnedHover: null as ((id: string) => string) | null,
    draftHover: (market: string) => `${draftChipDetail('ETSY', market)} Enter or a double-click links a listing that already sells on Etsy.`,
    noNumberHover: 'No number recorded: this listing reads live in Nexus, but Nexus holds no Etsy Listing ID for it. Enter or a double-click: type the Listing ID to link it.',
  },
  SHOPIFY: {
    copy: (id: string) => `Copy Product ID ${id}`,
    copyDetail: 'Ctrl+C on the cell copies it too.',
    copied: 'Product ID copied',
    open: '',
    openDetail: (_market: string) => '',
    change: 'Change Product ID',
    changeDetail: 'Enter or a double-click on the cell opens it too. Delete clears it.',
    ended: 'Ended',
    notConfirmed: 'Not confirmed',
    noNumber: 'No number recorded',
    live: (id: string) => `Shopify Product ID ${id}, as Shopify returned it when the sheet opened. Enter or a double-click: link another product, or clear it.`,
    endedHover: (id: string) => `Shopify Product ID ${id}.`,
    notConfirmedHover: (id: string, _status: string) => `Not confirmed: Nexus holds Shopify product ${id}, but Shopify did not return it when the sheet opened. Enter or a double-click: Check asks Shopify, then Keep or Clear.`,
    missingHover: null as ((id: string) => string) | null,
    notReturnedHover: (id: string) => `Not confirmed: Nexus holds Shopify product ${id}, but Shopify did not return it when the sheet opened. Enter or a double-click: Check asks Shopify, then Keep or Clear.`,
    draftHover: (market: string) => `${draftChipDetail('SHOPIFY', market)} Enter or a double-click links a product that is already in the store.`,
    noNumberHover: 'No number recorded: this listing reads live in Nexus, but Nexus holds no Shopify product for it. Enter or a double-click: type the Product ID to link it.',
  },
} as const
/** Shopify's own status of a returned product, when it is not for sale (the row reads Inactive in Nexus). */
export const SHOPIFY_STATUS_NOTE: Readonly<Record<string, string>> = { DRAFT: 'Draft on Shopify', ARCHIVED: 'Archived' }

type ItemChannel = keyof typeof CHANNEL_ITEM_ID_COPY
const itemChannel = (channel: string | undefined): ItemChannel => {
  const ch = String(channel ?? 'EBAY').toUpperCase()
  return ch === 'ETSY' || ch === 'SHOPIFY' ? ch : 'EBAY'
}

export type AsinCellModel =
  | { kind: 'asin'; asin: string; url: string | null; tooltip: string | null }
  | { kind: 'suggested'; asin: string; label: string; tooltip: string }
  | { kind: 'pending' | 'draft'; label: string; tooltip: string }
  | { kind: 'none'; tooltip: string | null }

/** eBay, Etsy, Shopify: `editable` = this row's cell is the control (the main row with a listing). `note`: a Shopify product not for sale. */
export type ItemIdCellModel =
  | { kind: 'item'; itemId: string; url: string | null; ended: boolean; tooltip: string | null; editable: boolean; note?: string | null }
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
  const suggested = row.listing ? text((cell as { pendingId?: { id?: unknown } } | undefined)?.pendingId?.id) : ''
  if (suggested) return { kind: 'suggested', asin: suggested, label: ASIN_CONTROL_COPY.suggested(suggested), tooltip: ASIN_CONTROL_COPY.suggestedHover(suggested) }
  const listing = row.listing
  if (listing && isAsinPending({ ...listing, channel: 'AMAZON' })) return { kind: 'pending', label: ASIN_PENDING_CHIP_LABEL, tooltip: asinPendingChipDetail(1, market) }
  if (listing && isStillDraftListing(listing)) return { kind: 'draft', label: DRAFT_CHIP_LABEL, tooltip: draftChipDetail('AMAZON', market) }
  return { kind: 'none', tooltip: cell?.writeBlockedReason ?? null }
}

/**
 * PURE — what one row's Item ID (eBay), Listing ID (Etsy) or Product ID (Shopify) cell shows. The server's value is the
 * id only when it counts; with none, the id the listing holds is "Not confirmed" (with the channel's reason). A variation
 * row's hover is the server's sentence ("Set on the main row").
 */
export function itemIdCellModel(row: Pick<ChannelSheetRow, 'parentId' | 'listing' | 'values'>, market: string, channel: string = 'EBAY'): ItemIdCellModel {
  const ch = itemChannel(channel)
  const copy = CHANNEL_ITEM_ID_COPY[ch]
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
    const ended = ch !== 'SHOPIFY' && status === 'ENDED'
    const url = ch === 'SHOPIFY' ? null : listingUrl(ch, market, value)
    const note = ch === 'SHOPIFY' ? SHOPIFY_STATUS_NOTE[text(listing.channelFactDetail?.shopifyStatus).toUpperCase()] ?? null : null
    return { kind: 'item', itemId: value, url, ended, tooltip: served(ended ? copy.endedHover(value) : copy.live(value)), editable, ...(note ? { note } : {}) }
  }
  if (held) {
    const reason = ch === 'ETSY' && text(listing.lastSyncStatus).toUpperCase() === 'MISSING' ? copy.missingHover!(held)
      : ch === 'SHOPIFY' ? copy.notReturnedHover!(held) : copy.notConfirmedHover(held, status)
    return { kind: 'notConfirmed', itemId: held, label: copy.notConfirmed, tooltip: served(reason), editable }
  }
  if (isStillDraftListing(listing)) return { kind: 'draft', label: DRAFT_CHIP_LABEL, tooltip: served(copy.draftHover(market)), editable }
  if (status === 'ACTIVE' || listing.isPublished) return { kind: 'noNumber', label: copy.noNumber, tooltip: served(copy.noNumberHover), editable }
  return { kind: 'none', tooltip: served(cell?.writeBlockedReason ?? null), editable }
}

/** The channel id columns this cell draws: Amazon's ASIN and the Item ID / Listing ID / Product ID. */
export const isListingIdKey = (key: string): boolean => key === LISTING_ASIN_KEY || key === LISTING_ITEM_ID_KEY

type Scope = Pick<ChannelScope, 'channel' | 'marketplace'>
const isAmazon = (scope: Scope) => String(scope.channel).toUpperCase() === 'AMAZON'

/** PURE — one model for every channel: the ASIN on Amazon, the channel's own id elsewhere. */
export function listingIdCellModel(row: Pick<ChannelSheetRow, 'isParent' | 'parentId' | 'listing' | 'values'>, scope: Scope): ListingIdCellModel {
  return isAmazon(scope) ? asinCellModel(row, scope.marketplace) : itemIdCellModel(row, scope.marketplace, scope.channel)
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

/**
 * eBay, Etsy, Shopify: the keys the control takes on a main row — Enter opens it, Delete (or Backspace) opens its Clear
 * confirm. The cell's own listener acts (it reaches the control); this only keeps the grid from acting on them too.
 */
export function itemIdKeyIntent(p: { event: KeyboardEvent; editing: boolean; data?: ChannelSheetRow }, market: string, channel: string = 'EBAY'): 'edit' | 'clear' | null {
  if (p.editing || p.event.ctrlKey || p.event.metaKey || p.event.altKey || p.event.shiftKey) return null
  const model = p.data ? itemIdCellModel(p.data, market, channel) : null
  if (!model?.editable) return null
  if (p.event.key === 'Enter') return 'edit'
  if (p.event.key === 'Delete' || p.event.key === 'Backspace') return model.kind === 'item' || model.kind === 'notConfirmed' ? 'clear' : null
  return null
}

/**
 * Amazon (step I4): the keys the ASIN control takes on a row with a listing — Enter opens it, Delete (or Backspace)
 * opens its Clear confirm when the row lists on an ASIN set for Publish. A live offer's ASIN is never cleared here.
 */
export function asinKeyIntent(p: { event: KeyboardEvent; editing: boolean; data?: ChannelSheetRow }, market: string): 'edit' | 'clear' | null {
  if (p.editing || p.event.ctrlKey || p.event.metaKey || p.event.altKey || p.event.shiftKey || !p.data?.listing) return null
  if (p.event.key === 'Enter') return 'edit'
  if (p.event.key === 'Delete' || p.event.key === 'Backspace') return asinCellModel(p.data, market).kind === 'suggested' ? 'clear' : null
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

/**
 * The control's door on a cell: its Enter / Delete keys (when the cell itself has the focus) and a double-click reach the
 * sheet's control (`channelIdControl.tsx`); a double-click on a cell action stays that action's.
 */
function useControlDoor(door: boolean, cell: HTMLElement | null | undefined, row: ChannelSheetRow | undefined, control: ReturnType<typeof useChannelIdControl>,
  intentOf: (event: KeyboardEvent, row: ChannelSheetRow) => 'edit' | 'clear' | null) {
  useEffect(() => {
    if (!door || !cell || !row || !control) return
    const onKey = (event: KeyboardEvent) => {
      const intent = intentOf(event, row)
      if (!intent || event.target !== cell) return
      event.preventDefault()
      control.open(row, intent)
    }
    const onDouble = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-nds-cell-action]')) return
      control.open(row, 'edit')
    }
    cell.addEventListener('keydown', onKey)
    cell.addEventListener('dblclick', onDouble)
    return () => { cell.removeEventListener('keydown', onKey); cell.removeEventListener('dblclick', onDouble) }
    // `intentOf` is a pure rule of the row, the market and the channel (fixed per column): the row and the control decide.
  }, [door, cell, row, control])
}

export const AsinCell = memo(function AsinCell(p: ICellRendererParams<ChannelSheetRow> & AsinCellParams) {
  const [copied, copy] = useCopied()
  const control = useChannelIdControl()
  const row = p.data
  // Every row with a listing is the ASIN control's door (step I4); without the sheet's control the cell stays read-only.
  const door = !!control && !!row?.listing
  useControlDoor(door, p.eGridCell, row, control, (event, data) => asinKeyIntent({ event, editing: false, data }, p.market))
  if (!row) return null
  const model = asinCellModel(row, p.market)
  const focusCell = focusCellOf(p)
  const change = door
    ? <CellAction label={ASIN_CONTROL_COPY.change} description={ASIN_CONTROL_COPY.changeDetail} icon={<Pencil size={13} />} onFocusCell={focusCell} onActivate={() => control!.open(row, 'edit')} />
    : null
  if (model.kind === 'none') return change ? <span className="nds-cell-value nds-reveal-row"><EmptyValue />{change}</span> : <EmptyValue />
  // The detail is the column's hover (`tooltipValueGetter`), as on every sheet cell — never a second native title.
  if (model.kind !== 'asin') return <span className="nds-cell-value nds-reveal-row"><Pill tone="info">{model.label}</Pill>{change}</span>
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
      {change}
    </span>
  )
})

export interface ItemIdCellParams { market: string; channel?: string }

/** The Item ID / Listing ID / Product ID cell. On the main row it is the control's door: Enter, a double-click and Delete reach it here. */
export const ItemIdCell = memo(function ItemIdCell(p: ICellRendererParams<ChannelSheetRow> & ItemIdCellParams) {
  const [copied, copy] = useCopied()
  const control = useChannelIdControl()
  const row = p.data
  const channel = itemChannel(p.channel)
  const words = CHANNEL_ITEM_ID_COPY[channel]
  const model = row ? itemIdCellModel(row, p.market, channel) : null
  const door = !!control && !!model?.editable
  useControlDoor(door, p.eGridCell, row, control, (event, data) => itemIdKeyIntent({ event, editing: false, data }, p.market, channel))
  if (!row || !model) return null
  const focusCell = focusCellOf(p)
  const change = door
    ? <CellAction label={words.change} description={words.changeDetail} icon={<Pencil size={13} />} onFocusCell={focusCell} onActivate={() => control!.open(row, 'edit')} />
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
      {model.ended && <Pill tone="neutral">{words.ended}</Pill>}
      {model.note && <Pill tone="neutral">{model.note}</Pill>}
      <CellAction label={copied ? words.copied : words.copy(model.itemId)} description={words.copyDetail}
        icon={copied ? <Check size={13} /> : <Copy size={13} />} onFocusCell={focusCell} onActivate={() => copy(model.itemId)} />
      {model.url && <CellAction label={words.open} description={words.openDetail(p.market)} icon={<ExternalLink size={13} />}
        onFocusCell={focusCell} onActivate={() => openInNewTab(model.url!)} />}
      {change}
    </span>
  )
})

/** The column is wide enough for a 12-digit Item ID and three cell actions. */
export const ITEM_ID_COLUMN_MIN_WIDTH = 200

/**
 * The channel id column's ColDef — spread LAST over the sheet's own column (like the stock columns): the renderer, the
 * ONE text (copy, export, filters), the hover and the keys. Never the grid's own editor: every channel id changes only
 * through its control (a variation row's shared id: never).
 */
export function listingIdColumnDef(col: SheetColumn, scope: Scope): ColDef<ChannelSheetRow> {
  const amazon = isAmazon(scope)
  const market = scope.marketplace
  const params: AsinCellParams & ItemIdCellParams = { market, channel: String(scope.channel).toUpperCase() }
  const textOf = (row: ChannelSheetRow | undefined) => listingIdCellText(row, scope)
  const minWidth = amazon ? ASIN_COLUMN_MIN_WIDTH : ITEM_ID_COLUMN_MIN_WIDTH
  return {
    colId: col.key,
    minWidth,
    width: Math.max(col.width ?? minWidth, minWidth),
    editable: false,
    suppressFillHandle: true,
    cellDataType: false,
    cellClass: 'nds-ag-cell',
    cellClassRules: {},
    cellRenderer: amazon ? AsinCell : ItemIdCell,
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
    suppressKeyboardEvent: (p) => (amazon ? asinKeyIntent(p as never, market) : itemIdKeyIntent(p as never, market, scope.channel)) !== null,
  }
}

/** The ASIN column's ColDef (kept for its callers): the Amazon branch of `listingIdColumnDef`. */
export const asinColumnDef = (col: SheetColumn, market: string): ColDef<ChannelSheetRow> => listingIdColumnDef(col, { channel: 'AMAZON', marketplace: market })
