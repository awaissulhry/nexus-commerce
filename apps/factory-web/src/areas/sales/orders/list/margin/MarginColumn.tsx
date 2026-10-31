'use client'

import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Pill } from '@nexus/ui/primitives'
import type { Locale } from '../../../../../lib/i18n/locales'
import { pctText, pctTone } from '../../../../finance/margins/model'
import type { OrderRow } from '../../api'

/**
 * B-W2a-72 — the orders list's Margin % column (design sales.orders orders.grid "Margin % (margin, W2a)"): the order's
 * margin as estimated now, in tone (below zero: danger), "…" while the margins are read and "—" when it cannot be told.
 * Drawn only for a person with costing.view and the margin grain (the caller passes the margins only then).
 */
export function marginColumn(margins: ReadonlyMap<string, string | null>, header: string, hint: string, locale: Locale): ColDef<OrderRow> {
  const MarginCell = ({ data }: ICellRendererParams<OrderRow>) => {
    if (!data) return null
    if (!margins.has(data.id)) return <span className="fw-so-hint">…</span>
    const pct = margins.get(data.id) ?? null
    return pct === null ? <span className="fw-so-hint">—</span> : <Pill tone={pctTone(pct)}>{pctText(pct, locale)}</Pill>
  }
  return { colId: 'margin', headerName: header, headerTooltip: hint, minWidth: 104, flex: 0.6, type: 'rightAligned', cellRenderer: MarginCell }
}
