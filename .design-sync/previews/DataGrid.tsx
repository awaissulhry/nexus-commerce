import { useState } from 'react'
import { Badge, DataGrid, Pill, type Column } from '@nexus/design-system'

type Row = {
  id: string
  name: string
  status: 'success' | 'warning' | 'neutral'
  program: 'sp' | 'sb' | 'sd'
  spend: number
  sales: number
  acos: number
}

const ROWS: Row[] = [
  { id: '1', name: 'Helmets · Auto', status: 'success', program: 'sp', spend: 1284, sales: 8640, acos: 14.9 },
  { id: '2', name: 'Brand Defense', status: 'success', program: 'sb', spend: 642, sales: 3120, acos: 20.6 },
  { id: '3', name: 'Retargeting', status: 'warning', program: 'sd', spend: 318, sales: 1090, acos: 29.2 },
  { id: '4', name: 'Gloves · Manual', status: 'neutral', program: 'sp', spend: 96, sales: 410, acos: 23.4 },
]
const sum = (k: 'spend' | 'sales') => ROWS.reduce((s, r) => s + r[k], 0)
const eur = (n: number) => `€${n.toLocaleString('en-IE')}`
const STATUS_LABEL = { success: 'Active', warning: 'Paused', neutral: 'Archived' } as const

const COLS: Column<Row>[] = [
  {
    key: 'name',
    label: 'Campaign',
    sticky: true,
    width: 220,
    sortable: true,
    sortValue: (r) => r.name,
    render: (r) => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <Badge program={r.program}>{r.program.toUpperCase()}</Badge>
        <span style={{ fontWeight: 600 }}>{r.name}</span>
      </span>
    ),
  },
  { key: 'status', label: 'Status', render: (r) => <Pill tone={r.status}>{STATUS_LABEL[r.status]}</Pill> },
  { key: 'spend', label: 'Spend', align: 'right', sortable: true, sortValue: (r) => r.spend, render: (r) => eur(r.spend), total: eur(sum('spend')) },
  { key: 'sales', label: 'Sales', align: 'right', sortable: true, sortValue: (r) => r.sales, render: (r) => eur(r.sales), total: eur(sum('sales')) },
  { key: 'acos', label: 'ACOS', align: 'right', sortable: true, sortValue: (r) => r.acos, render: (r) => `${r.acos}%` },
]

/** The canonical grid: a sticky first column, sortable numeric columns and a totals row. */
export const CampaignGrid = () => (
  <DataGrid<Row> columns={COLS} rows={ROWS} rowKey={(r) => r.id} showTotals initialSort={{ key: 'spend', dir: 'desc' }} />
)

/** `selectable` adds the checkbox column; drive it with `selected` + `onSelectedChange`. */
export const Selectable = () => {
  const [selected, setSelected] = useState<Set<string>>(new Set(['1', '3']))
  return (
    <DataGrid<Row>
      columns={COLS}
      rows={ROWS}
      rowKey={(r) => r.id}
      selectable
      selected={selected}
      onSelectedChange={setSelected}
      showTotals
    />
  )
}

/** `emptyState` fills the body when `rows` is empty — never an unexplained blank grid. */
export const Empty = () => (
  <DataGrid<Row>
    columns={COLS}
    rows={[]}
    rowKey={(r) => r.id}
    emptyState={
      <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-tertiary)' }}>
        No campaigns match these filters. Clear a filter to see results.
      </div>
    }
  />
)
