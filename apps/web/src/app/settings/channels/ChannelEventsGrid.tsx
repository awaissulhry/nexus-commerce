'use client'

/**
 * CX.2 — the two event lists on the channels pages (the connection ledger and a
 * channel's recent inbound events) on the sanctioned engine: `NexusGrid`
 * (design-system/grid). autoHeight + page scroll, density from the page, column
 * defs memoised at module scope so the column model is built once
 * (reference_ag_react_inline_options_rerun_column_model).
 */

import { useMemo } from 'react'
import { NexusGrid, type ColDef, type ICellRendererParams } from '@/design-system/grid'
import { Pill, Tag } from '@/design-system/primitives'
import { EmptyState } from '@/design-system/components'
import { relativeTime } from './channels-data'

export interface LedgerRow {
  id: string
  type: string
  actorUserId: string | null
  detail: Record<string, unknown> | null
  createdAt: string
}

export interface InboundRow {
  id: string
  eventType: string
  externalId: string | null
  isProcessed: boolean
  processedAt: string | null
  error: string | null
  createdAt: string
}

export function summariseDetail(detail: Record<string, unknown> | null): string {
  if (!detail) return ''
  return Object.entries(detail)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .slice(0, 5)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ')
}

function WhenCell(p: ICellRendererParams<{ createdAt: string }>) {
  const iso = p.data?.createdAt
  return <span title={iso}>{relativeTime(iso ?? null)}</span>
}
function TypeCell(p: ICellRendererParams<LedgerRow>) {
  return p.data ? <Tag>{p.data.type}</Tag> : null
}
function ProcessedCell(p: ICellRendererParams<InboundRow>) {
  if (!p.data) return null
  const r = p.data
  return (
    <Pill tone={r.error ? 'danger' : r.isProcessed ? 'success' : 'neutral'} size="sm">
      {r.error ? 'failed' : r.isProcessed ? 'yes' : 'pending'}
    </Pill>
  )
}

const LEDGER_COLUMNS: ColDef<LedgerRow>[] = [
  { field: 'createdAt', headerName: 'When', width: 150, cellRenderer: WhenCell, sortable: true },
  { field: 'type', headerName: 'Event', width: 170, cellRenderer: TypeCell },
  { field: 'actorUserId', headerName: 'Actor', width: 130, valueFormatter: (p) => p.value ?? 'system' },
  { colId: 'detail', headerName: 'Detail', flex: 1, minWidth: 240, valueGetter: (p) => summariseDetail(p.data?.detail ?? null), cellClass: 'nds-ag-cell nds-channels-detail-cell' },
]

const INBOUND_COLUMNS: ColDef<InboundRow>[] = [
  { field: 'createdAt', headerName: 'When', width: 150, cellRenderer: WhenCell, sortable: true },
  { field: 'eventType', headerName: 'Type', width: 220 },
  { field: 'externalId', headerName: 'External id', width: 200, valueFormatter: (p) => p.value ?? '—' },
  { colId: 'processed', headerName: 'Processed', width: 120, cellRenderer: ProcessedCell },
  { field: 'error', headerName: 'Error', flex: 1, minWidth: 200, valueFormatter: (p) => p.value ?? '' },
]

const getRowId = (p: { data: { id: string } }) => p.data.id

export function LedgerGrid({ rows, emptyTitle, emptyDescription }: { rows: LedgerRow[]; emptyTitle: string; emptyDescription: string }) {
  const columnDefs = useMemo(() => LEDGER_COLUMNS, [])
  if (rows.length === 0) return <EmptyState title={emptyTitle} description={emptyDescription} />
  return <NexusGrid<LedgerRow> density="compact" domLayout="autoHeight" rowData={rows} columnDefs={columnDefs} getRowId={getRowId} />
}

export function InboundGrid({ rows, emptyTitle, emptyDescription }: { rows: InboundRow[]; emptyTitle: string; emptyDescription: string }) {
  const columnDefs = useMemo(() => INBOUND_COLUMNS, [])
  if (rows.length === 0) return <EmptyState title={emptyTitle} description={emptyDescription} />
  return <NexusGrid<InboundRow> density="compact" domLayout="autoHeight" rowData={rows} columnDefs={columnDefs} getRowId={getRowId} />
}
