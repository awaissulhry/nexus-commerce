import { useState } from 'react'
import { Badge, Button, DataGrid, GridToolbar, Input, Pill, SegmentedControl, type Column } from '@nexus/design-system'
import { Search } from 'lucide-react'

type Row = { id: string; sku: string; name: string; program: 'sp' | 'sb' | 'sd'; state: 'success' | 'warning' | 'neutral'; price: number; available: number }

const ROWS: Row[] = [
  { id: '1', sku: 'NX-4471', name: 'Casco Integrale AGV K6', program: 'sp', state: 'success', price: 289, available: 412 },
  { id: '2', sku: 'NX-2210', name: 'Giacca Dainese Racing 4', program: 'sb', state: 'success', price: 449, available: 87 },
  { id: '3', sku: 'NX-8814', name: 'Guanti Alpinestars SP-8', program: 'sd', state: 'warning', price: 119, available: 0 },
]
const STATE_LABEL = { success: 'Live', warning: 'Suppressed', neutral: 'Draft' } as const

const COLS: Column<Row>[] = [
  {
    key: 'name',
    label: 'Product',
    sticky: true,
    width: 260,
    render: (r) => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <Badge program={r.program}>{r.program.toUpperCase()}</Badge>
        <span>
          <span style={{ fontWeight: 600 }}>{r.name}</span>
          <span style={{ color: 'var(--text-tertiary)' }}> · {r.sku}</span>
        </span>
      </span>
    ),
  },
  { key: 'state', label: 'Status', render: (r) => <Pill tone={r.state}>{STATE_LABEL[r.state]}</Pill> },
  { key: 'available', label: 'Available', align: 'right', render: (r) => r.available.toLocaleString('en-IE') },
  { key: 'price', label: 'Price', align: 'right', render: (r) => `€${r.price.toLocaleString('en-IE')}` },
]

/** The canonical seat: `.nds-gridcard` wraps the toolbar and the grid into one rectangle. */
export const AboveTheGrid = () => {
  const [density, setDensity] = useState('cosy')
  return (
    <div className="nds-gridcard">
      <GridToolbar
        count={<>Viewing <b>1–3</b> of <b>1,284</b> products</>}
        right={
          <>
            <SegmentedControl
              size="sm"
              value={density}
              onChange={setDensity}
              options={[
                { value: 'compact', label: 'Compact' },
                { value: 'cosy', label: 'Cosy' },
              ]}
            />
            <Button size="sm">Customise</Button>
            <Button size="sm">Export</Button>
            <Button size="sm" variant="primary">New product</Button>
          </>
        }
      />
      <DataGrid<Row> columns={COLS} rows={ROWS} rowKey={(r) => r.id} />
    </div>
  )
}

/** The left slot swaps with context — here the count reports a selection and the actions act on it. */
export const SelectionActions = () => (
  <div className="nds-gridcard">
    <GridToolbar
      count={<>Selected <b>12</b> products</>}
      right={
        <>
          <Button size="sm">Customise</Button>
          <Button size="sm">Export</Button>
        </>
      }
    >
      <Button size="sm">Assign tags</Button>
      <Button size="sm">Change status</Button>
      <Button size="sm" variant="danger">Archive</Button>
    </GridToolbar>
    <DataGrid<Row> columns={COLS} rows={ROWS} rowKey={(r) => r.id} />
  </div>
)

/** `children` also takes a search field; the spacer keeps `right` pinned however wide the left grows. */
export const WithSearch = () => (
  <GridToolbar
    count={<>Viewing <b>16</b> of 16 campaigns</>}
    right={
      <>
        <Button size="sm">Columns</Button>
        <Button size="sm" variant="primary">New campaign</Button>
      </>
    }
  >
    <Input leadingIcon={<Search size={13} />} placeholder="Search campaigns…" style={{ width: 220 }} />
  </GridToolbar>
)
