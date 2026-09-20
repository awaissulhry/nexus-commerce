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
import { readableAccountText, summariseDetail, type AccountNames } from './channel-event-details'
export { summariseDetail } from './channel-event-details'

export interface LedgerRow {
  id: string
  type: string
  actorUserId: string | null
  detail: Record<string, unknown> | null
  createdAt: string
}

/** The four states an inbound event can be in. */
export type InboundStatus = 'pending' | 'done' | 'failed' | 'dlq'

export interface InboundRow {
  id: string
  channel?: string
  eventType: string
  externalId: string | null
  isProcessed: boolean
  processedAt: string | null
  error: string | null
  createdAt: string
  /**
   * P2.8 — the lifecycle, which this grid could not show.
   *
   * It rendered three states from a boolean and an error string: yes / pending /
   * failed. A DEAD LETTER — an event that has run out of attempts and is waiting for a
   * person — came out as "failed", identical to one that will be tried again in four
   * minutes. Those are the two rows an operator most needs to tell apart, because one
   * needs them and the other does not.
   *
   * Optional so the older shape still renders while a caller catches up.
   */
  status?: InboundStatus
  attempts?: number
  deliveries?: number
  nextAttemptAt?: string | null
  lastError?: string | null
  signatureOk?: boolean | null
  verifiedBy?: string | null
}

/**
 * Who did it, in words. `actorUserId` is a cuid — printing it told the operator
 * nothing; the kind (operator / cron / system / channel) is the useful fact, and
 * the id stays in the title for anyone auditing a specific person's action.
 */
export function actorLabel(row: { actorUserId: string | null; detail: Record<string, unknown> | null }): string {
  const kind = row.detail && typeof row.detail.actorKind === 'string' ? row.detail.actorKind : null
  if (kind) return kind
  return row.actorUserId ? 'operator' : 'system'
}

function WhenCell(p: ICellRendererParams<{ createdAt: string }>) {
  const iso = p.data?.createdAt
  return <span title={iso}>{relativeTime(iso ?? null)}</span>
}
function TypeCell(p: ICellRendererParams<LedgerRow>) {
  return p.data ? <Tag>{p.data.type}</Tag> : null
}
/** The status a row is really in, falling back to the old boolean for older callers. */
export function inboundStatusOf(row: InboundRow): InboundStatus {
  if (row.status) return row.status
  if (row.error) return 'failed'
  return row.isProcessed ? 'done' : 'pending'
}

const STATUS_TONE: Record<InboundStatus, 'success' | 'danger' | 'warning' | 'neutral'> = {
  done: 'success',
  // A dead letter is not a worse "failed" — it is a DIFFERENT state, because nothing
  // will try it again. It gets its own tone so the two never read as one.
  dlq: 'danger',
  failed: 'warning',
  pending: 'neutral',
}

const STATUS_LABEL: Record<InboundStatus, string> = {
  done: 'done',
  dlq: 'dead letter',
  failed: 'will retry',
  pending: 'pending',
}

function ProcessedCell(p: ICellRendererParams<InboundRow>) {
  if (!p.data) return null
  const status = inboundStatusOf(p.data)
  const attempts = p.data.attempts ?? 0
  return (
    <Pill tone={STATUS_TONE[status]} size="sm">
      {STATUS_LABEL[status]}{status === 'failed' && attempts > 0 ? ` (${attempts})` : ''}
    </Pill>
  )
}

const LEDGER_COLUMNS: ColDef<LedgerRow>[] = [
  { field: 'createdAt', headerName: 'When', width: 150, cellRenderer: WhenCell, sortable: true },
  { field: 'type', headerName: 'Event', width: 170, cellRenderer: TypeCell },
  {
    colId: 'actor',
    headerName: 'Actor',
    width: 120,
    valueGetter: (p) => (p.data ? actorLabel(p.data) : ''),
    tooltipValueGetter: (p) => (p.data?.actorUserId ? `user ${p.data.actorUserId}` : undefined),
  },
  { colId: 'detail', headerName: 'Detail', flex: 1, minWidth: 240, valueGetter: (p) => summariseDetail(p.data?.detail ?? null), cellClass: 'nds-ag-cell nds-channels-detail-cell' },
]

const INBOUND_COLUMNS: ColDef<InboundRow>[] = [
  { field: 'createdAt', headerName: 'When', width: 150, cellRenderer: WhenCell, sortable: true },
  { field: 'eventType', headerName: 'Type', width: 220 },
  { field: 'externalId', headerName: 'External id', width: 200, valueFormatter: (p) => p.value ?? '—' },
  { colId: 'processed', headerName: 'Status', width: 140, cellRenderer: ProcessedCell },
  {
    colId: 'error', headerName: 'Reason', flex: 1, minWidth: 200,
    // `lastError` is the lifecycle's field and `error` is the one that predates it.
    // Both are written, but only the first is updated by a retry, so it is preferred.
    valueGetter: (p) => readableAccountText(p.data?.lastError ?? p.data?.error ?? ''),
  },
]

const getRowId = (p: { data: { id: string } }) => p.data.id

export function LedgerGrid({ rows, emptyTitle, emptyDescription, accountNames }: { rows: LedgerRow[]; emptyTitle: string; emptyDescription: string; accountNames?: AccountNames }) {
  const columnDefs = useMemo<ColDef<LedgerRow>[]>(() => LEDGER_COLUMNS.map((column) => column.colId === 'detail'
    ? { ...column, valueGetter: (p) => summariseDetail(p.data?.detail ?? null, accountNames) }
    : column), [accountNames])
  if (rows.length === 0) return <EmptyState title={emptyTitle} description={emptyDescription} />
  return <NexusGrid<LedgerRow> density="compact" domLayout="autoHeight" rowData={rows} columnDefs={columnDefs} getRowId={getRowId} />
}

export function InboundGrid({ rows, emptyTitle, emptyDescription }: { rows: InboundRow[]; emptyTitle: string; emptyDescription: string }) {
  const columnDefs = useMemo(() => INBOUND_COLUMNS, [])
  if (rows.length === 0) return <EmptyState title={emptyTitle} description={emptyDescription} />
  return <NexusGrid<InboundRow> density="compact" domLayout="autoHeight" rowData={rows} columnDefs={columnDefs} getRowId={getRowId} />
}
