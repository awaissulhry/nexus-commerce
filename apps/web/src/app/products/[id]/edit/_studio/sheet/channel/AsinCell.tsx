'use client'

/**
 * Amazon sheet gaps (gap 5) — the ASIN column on an Amazon sheet: the market's ASIN (`listing_asin`, the listing's
 * `externalListingId` on this market; a parent row shows the parent ASIN). Read-only: Amazon assigns it.
 *
 *   ASIN       mono text, with the DS cell actions Copy and Open on Amazon (`listingUrl`). Keyboard: Ctrl/⌘+C on the
 *              cell copies (AG's clipboard), Enter opens it on Amazon.
 *   pending    published, the ASIN not read back yet — the shared rule (`isAsinPending`) and the header chip's words.
 *   draft      a Nexus draft, nothing sent — the shared rule (`isStillDraftListing`) and the header chip's words.
 *   none       a dash; the hover says why (the server's sentence).
 */
import { memo, useEffect, useState } from 'react'
import { Check, Copy, ExternalLink } from 'lucide-react'

import { CellAction } from '@/design-system/components'
import { Pill } from '@/design-system/primitives'
import { EmptyValue, type ColDef, type ICellRendererParams } from '@/design-system/grid'
import { isAsinPending } from '@nexus/shared/listing-risk'

import { ASIN_PENDING_CHIP_LABEL, asinPendingChipDetail, DRAFT_CHIP_LABEL, draftChipDetail, isStillDraftListing } from '../../draftListing'
import { listingUrl } from '../../drawer/listingUrl'
import { LISTING_ASIN_KEY } from './stockCells'
import type { ChannelSheetRow, SheetColumn } from './types'

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

export type AsinCellModel =
  | { kind: 'asin'; asin: string; url: string | null; tooltip: string | null }
  | { kind: 'pending' | 'draft'; label: string; tooltip: string }
  | { kind: 'none'; tooltip: string | null }

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

/** The cell's text for copy, export and the filters: the ASIN, or nothing. */
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

function openInNewTab(url: string): void {
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer')
}

export const AsinCell = memo(function AsinCell(p: ICellRendererParams<ChannelSheetRow> & AsinCellParams) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const row = p.data
  if (!row) return null
  const model = asinCellModel(row, p.market)
  if (model.kind === 'none') return <EmptyValue />
  // The detail is the column's hover (`tooltipValueGetter`), as on every sheet cell — never a second native title.
  if (model.kind !== 'asin') return <span className="nds-cell-value"><Pill tone="info">{model.label}</Pill></span>
  const focusCell = () => {
    const column = p.column?.getColId()
    if (p.node.rowIndex != null && column) p.api.setFocusedCell(p.node.rowIndex, column)
  }
  // `nds-reveal-row`: the cell actions show while the pointer is on the cell (the sheet's CascadeCell does the same).
  return (
    <span className="nds-cell-value nds-reveal-row">
      <span className="nds-cell-value-text nds-projcell-detail">{model.asin}</span>
      <CellAction label={copied ? ASIN_COPY.copied : ASIN_COPY.copy(model.asin)} description={ASIN_COPY.copyDetail}
        icon={copied ? <Check size={13} /> : <Copy size={13} />} onFocusCell={focusCell}
        onActivate={() => { void navigator.clipboard?.writeText(model.asin).then(() => setCopied(true), () => undefined) }} />
      {model.url && (
        <CellAction label={ASIN_COPY.open} description={ASIN_COPY.openDetail(p.market)} icon={<ExternalLink size={13} />} onFocusCell={focusCell}
          onActivate={() => openInNewTab(model.url!)} />
      )}
    </span>
  )
})

/**
 * The ASIN column's ColDef — spread LAST over the sheet's own column (like the stock columns): the renderer, the ONE text
 * (copy, export, filters), the hover and the keys. Read-only on every row.
 */
export function asinColumnDef(col: SheetColumn, market: string): ColDef<ChannelSheetRow> {
  const params: AsinCellParams = { market }
  const textOf = (row: ChannelSheetRow | undefined) => asinCellText(row, market)
  return {
    colId: col.key,
    minWidth: ASIN_COLUMN_MIN_WIDTH,
    width: Math.max(col.width ?? ASIN_COLUMN_MIN_WIDTH, ASIN_COLUMN_MIN_WIDTH),
    editable: false,
    suppressFillHandle: true,
    cellDataType: false,
    cellClass: 'nds-ag-cell',
    cellClassRules: {},
    cellRenderer: AsinCell,
    cellRendererParams: params,
    cellEditorSelector: undefined,
    valueParser: undefined,
    valueSetter: () => false,
    valueGetter: (p) => textOf(p.data) || null,
    valueFormatter: (p) => textOf(p.data),
    filterValueGetter: (p) => textOf(p.data),
    getQuickFilterText: (p) => textOf(p.data),
    tooltipValueGetter: (p) => {
      const model = p.data ? asinCellModel(p.data, market) : null
      return model?.tooltip ?? undefined
    },
    suppressKeyboardEvent: (p) => asinCellKeys(p as never, market),
  }
}
