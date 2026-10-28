'use client'

import { useMemo } from 'react'

import { EntityLinks, Sparkline, type EntityRef } from '@/design-system/components'
import { GridCard, GridToolbar, NexusGrid, entityLinksColumn, textColumn, type ColDef } from '@/design-system/grid'

/*
 * 2026-10-10 — bid page DS lane: a small step chart and the links to what a row works on. Made-up rows and numbers.
 * Verify:
 *  - Sparkline: the bid is drawn as steps (it holds until it is changed), clicks as a line; one reading is a dot; no
 *    readings is a dotted rule that says "No changes" — never blank, never a flat line. Each one's name (hover, screen
 *    reader) says low, high and now.
 *  - EntityLinks: none is a dash named "No campaigns"; one is a link (⌘/Ctrl-click opens a new tab); several is a count
 *    that opens a small list of links (click, Enter or Space; Tab stays inside; Esc closes and returns the focus).
 *  - In the grid: arrow to a Campaigns cell and press Enter — one link is followed, a count opens its list; Esc
 *    returns to the cell. Nothing ticks or opens the row. Light and dark, 390 px.
 */
const eur = (n: number) => `€${n.toFixed(2)}`
const camp = (id: string, name: string): EntityRef => ({ id, name, href: `/design-system#bid-parts-example` })

interface Row { id: string; keyword: string; campaigns: EntityRef[] }
const ROWS: Row[] = [
  { id: 'a', keyword: 'leather jacket', campaigns: [camp('c1', 'Jacket Exact')] },
  { id: 'b', keyword: 'jacket men', campaigns: [camp('c1', 'Jacket Exact'), camp('c2', 'Jacket Phrase'), camp('c3', 'Jacket Broad')] },
  { id: 'c', keyword: 'rain jacket', campaigns: [] },
]
const ROW_ID = (p: { data: Row }) => p.data.id

export function BidPartsExample() {
  const cols = useMemo<ColDef<Row>[]>(() => [
    { colId: 'keyword', headerName: 'Keyword', width: 150, ...textColumn<Row>('keyword') },
    { colId: 'campaigns', width: 170, ...entityLinksColumn<Row>('campaigns', { header: 'Campaigns', noun: { one: 'campaign', many: 'campaigns' }, listLabel: (r) => `Campaigns of ${r.keyword}` }) },
  ], [])
  return (
    <section id="bid-parts-example" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--nds-space-12)', maxWidth: 560 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--nds-space-16)' }}>
        <Sparkline label="Bid, 14 days" values={[0.4, 0.4, 0.1, 0.4, 0.1, 0.4, 0.3]} format={eur} />
        <Sparkline label="Clicks a day" shape="line" values={[4, 7, 5, null, 9, 12, 8]} />
        <Sparkline label="Bid, 14 days" values={[0.2]} format={eur} />
        <Sparkline label="Bid, 14 days" values={[]} />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--nds-space-16)' }}>
        <EntityLinks items={[]} noun={{ one: 'campaign', many: 'campaigns' }} />
        <EntityLinks items={[camp('p1', 'Jackets')]} noun={{ one: 'portfolio', many: 'portfolios' }} />
        <EntityLinks items={ROWS[1].campaigns} noun={{ one: 'campaign', many: 'campaigns' }} listLabel="Campaigns of Rule A" />
        <EntityLinks items={[{ id: 'g1', name: 'Ad group without a page' }]} noun={{ one: 'ad group', many: 'ad groups' }} />
      </div>
      <GridCard toolbar={<GridToolbar count={<><b>{ROWS.length}</b> keywords</>} />}>
        <NexusGrid<Row> density="cozy" domLayout="autoHeight" rowData={ROWS} getRowId={ROW_ID} columnDefs={cols} suppressCellFocus={false} />
      </GridCard>
    </section>
  )
}
