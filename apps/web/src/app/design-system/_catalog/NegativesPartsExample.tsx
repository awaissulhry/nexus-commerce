'use client'

import { useMemo, useState } from 'react'

import { Button, Pill } from '@/design-system/primitives'
import { ChangeReview, EmptyState, KeyValue, RecordLayout, Sparkline, SummaryTable, Timeline, useNarrow } from '@/design-system/components'
import { FilterBar, ReviewChangesPanel, type FilterDimension } from '@/design-system/patterns'
import { GridCard, GridToolbar, NexusGrid, type ColDef } from '@/design-system/grid'

/*
 * 2026-10-26 — the Negative Targeting redesign's DS parts. Made-up terms and numbers.
 * Verify:
 *  - FilterBar `layout="inline"`: one row of fields, Clear at its end on the controls' line, held at 0 on (focus it: it
 *    says why). The Status list is a single pick with its counts after each name; a screen reader hears "Status Wasting".
 *    At ≤ 760 px one "Filters (n)" button opens the fields in the full-screen sheet with Clear and Done.
 *  - Pill `truncate`: the long status ends in "…" in its 120 px box; hover shows the whole words.
 *  - NexusGrid `rows="two-line"`: a term over its campaign fits at compact, cozy and spacious. "Show no rows" draws the
 *    page's EmptyState as the grid's overlay; its button can be clicked.
 *  - ChangeReview `tick={false}`: no checkbox. Timeline `action`: Undo at the end of the step's line.
 *  - SummaryTable `roomy` + `align` + `stackOnPhone`: 44 px rows with a button, the second column right; at ≤ 760 px each
 *    row a block of labelled lines. A muted second line in a cell (`.nds-summary-sub`).
 *  - Sparkline `fluid` fills the side panel; its dots stay round. RecordLayout: two columns, one at ≤ 760 px (side panel
 *    after). KeyValue `phoneColumns={2}` keeps two columns on a phone.
 *  - ReviewChangesPanel at ≤ 760 px: one card per change (Where, What, Now → New, Note), nothing scrolls sideways.
 *  - Light and dark, 390 px.
 */
const STATUS = [
  { value: 'wasting', label: 'Wasting', count: 9 },
  { value: 'stopped', label: 'Stopped', count: 4 },
  { value: 'waiting', label: 'Waiting', count: 2 },
]
const MARKETS = [{ value: 'it', label: 'Amazon IT' }, { value: 'de', label: 'Amazon DE' }]
const CAMPAIGNS = [{ value: 'c1', label: 'Jackets IT Auto', count: 6 }, { value: 'c2', label: 'Gloves IT Broad', count: 3 }]

interface Row { id: string; term: string; campaign: string; spend: string }
const ROWS: Row[] = [
  { id: 'r1', term: 'cheap jacket', campaign: 'Jackets IT Auto › Auto group', spend: '€14.20' },
  { id: 'r2', term: 'kids gloves', campaign: 'Gloves IT Broad › Broad group', spend: '€9.80' },
  { id: 'r3', term: 'jacket free shipping', campaign: 'Jackets IT Auto › Auto group', spend: '€6.10' },
]
const ROW_ID = (p: { data: Row }) => p.data.id
const NO_ROWS: Row[] = []
const noop = () => {}

export function NegativesPartsExample() {
  const narrow = useNarrow()
  const [status, setStatus] = useState('wasting')
  const [market, setMarket] = useState('')
  const [campaigns, setCampaigns] = useState<string[]>([])
  const [empty, setEmpty] = useState(false)
  const [ack, setAck] = useState(false)
  const on = (status ? 1 : 0) + (market ? 1 : 0) + (campaigns.length ? 1 : 0)
  const dims: FilterDimension[] = [
    { key: 'status', label: 'Status', kind: 'listbox', options: STATUS, value: status, onChange: setStatus },
    { key: 'market', label: 'Market', kind: 'select', options: MARKETS, value: market, onChange: setMarket },
    { key: 'campaign', label: 'Campaign', kind: 'multiselect', options: CAMPAIGNS, value: campaigns, onChange: setCampaigns },
  ]
  const cols = useMemo<ColDef<Row>[]>(() => [
    {
      colId: 'term', headerName: 'Search term', flex: 2, minWidth: 180,
      cellRenderer: (p: { data?: Row }) => p.data ? (
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <span>{p.data.term}</span>
          <span className="nds-cell-sub">{p.data.campaign}</span>
        </span>
      ) : null,
    },
    { colId: 'spend', headerName: 'Spend', field: 'spend', width: 100, type: 'rightAligned' },
  ], [])

  return (
    <section id="negatives-parts-example" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--nds-space-16)' }}>
      <FilterBar layout="inline" dimensions={dims} activeCount={on} onClear={() => { setStatus(''); setMarket(''); setCampaigns([]) }} />

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--nds-space-8)' }}>
        <span style={{ display: 'inline-flex', width: 120 }}>
          <Pill tone="warning" truncate>Partly blocked in 3 campaigns</Pill>
        </span>
        <Pill tone="success">Running</Pill>
        <span>{narrow ? 'Narrow (≤ 760 px)' : 'Wide'}</span>
      </div>

      <GridCard toolbar={<GridToolbar count={<><b>{empty ? 0 : ROWS.length}</b> terms</>} right={<Button size="sm" onClick={() => setEmpty((e) => !e)}>{empty ? 'Show rows' : 'Show no rows'}</Button>} />}>
        <NexusGrid<Row> rows="two-line" density="compact" domLayout="autoHeight" rowData={empty ? NO_ROWS : ROWS} getRowId={ROW_ID} columnDefs={cols}
          emptyState={<EmptyState title="No term wastes money" description="Nothing matches these filters." action={<Button size="sm" onClick={() => setEmpty(false)}>Show rows</Button>} />} />
      </GridCard>

      <RecordLayout
        asideLabel="Status and trend"
        main={
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--nds-space-12)', minWidth: 0 }}>
            <KeyValue columns={3} phoneColumns={2} items={[{ label: 'Spend', value: '€14.20' }, { label: 'Clicks', value: '31' }, { label: 'Orders', value: '0' }]} />
            <SummaryTable label="Where it runs" density="roomy" stackOnPhone align={[undefined, 'right', 'right']} columns={['Campaign', 'Spend', '']}
              rows={[
                { id: 'a', cells: [<>Jackets IT Auto<span className="nds-summary-sub">Auto group</span></>, '€14.20', <Button key="u" size="sm">Open</Button>] },
                { id: 'b', cells: [<>Gloves IT Broad<span className="nds-summary-sub">Broad group</span></>, '€9.80', <Button key="u" size="sm">Open</Button>] },
              ]} />
            <Timeline label="What happened" steps={[
              { key: 's1', label: 'Added as negative exact', tone: 'success', at: '2026-10-24T09:12:00Z', action: <Button size="sm" aria-label="Undo Added as negative exact">Undo</Button> },
              { key: 's2', label: 'Sent to Amazon', tone: 'info', at: null },
            ]} />
            <ChangeReview label="What goes together" tick={false} selectedIds={[]} onSelectionChange={noop} items={[
              { id: 'x', label: 'Negative exact', status: 'New', note: 'Blocks 1 term', selectable: false, values: [{ label: 'Now', value: 'Running' }, { label: 'New', value: 'Negative' }] },
            ]} />
          </div>
        }
        aside={
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--nds-space-8)', minWidth: 0 }}>
            <Pill tone="warning">Wasting</Pill>
            <Sparkline fluid shape="line" height={36} label="Spend, 14 days" values={[1.2, 0.8, 2.1, 1.4, null, 0.9, 1.6, 2.4, 1.1, 0.7, 1.9, 2.2, 1.3, 1.8]} format={(n) => `€${n.toFixed(2)}`} />
          </div>
        }
      />

      <ReviewChangesPanel ack={ack} onAckChange={setAck} changes={[
        { id: 'p', where: 'Amazon IT · every campaign', what: 'Remove protection · "waterproof"', now: 'Protected', next: 'Not protected', note: 'Step 1 · Nexus only' },
        { id: 'n', where: 'Jackets IT Auto › Auto group', what: 'Negative exact · waterproof coat', now: 'Protected', next: 'Negative' },
      ]} />
    </section>
  )
}
