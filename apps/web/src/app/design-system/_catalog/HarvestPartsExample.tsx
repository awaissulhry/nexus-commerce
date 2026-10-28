'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { Plus } from 'lucide-react'

import { Button, Tag } from '@/design-system/primitives'
import { EntityPath, Listbox, Modal, useNarrow, type EntityRef, type ListboxPanelAction, type ListboxPanelOption } from '@/design-system/components'
import {
  GridCard, GridToolbar, NexusGrid, displayedRowIds, entityPathColumn, revealRow, textColumn,
  type ColDef, type GridApi, type GridReadyEvent,
} from '@/design-system/grid'

/*
 * 2026-10-10 — Keyword Harvest DS lane: H1 commands under a list, H5 a held Button, H6 walking the rows as shown,
 * H7 a Portfolio › Campaign › Ad group path, H4 one phone breakpoint. Made-up names.
 * Verify:
 *  - The list: groups (Suggested first), a match chip, a held place stays listed with its reason (focus it: the reason is
 *    read and shown; Enter does nothing). ↓ past the last place reaches "New campaign…"; Tab from the search field goes to
 *    the first action, then the next; Shift+Tab back. Enter or a click on an action closes the list and runs it (the
 *    line below says which); the held action says why and never runs. Esc closes. The actions stay visible while the
 *    list scrolls.
 *  - "In a dialog": the same list inside a DS Modal. Tab off the last action closes the list and goes on to "Cancel"
 *    (never out of the dialog); Shift+Tab off the search field closes it onto the trigger; Esc closes only the list.
 *  - The held Button takes focus, shows its reason on hover AND focus, and a click does nothing.
 *  - The paths: a narrow box cuts the MIDDLE step first; hover or focus shows the whole path; a step without a page is
 *    plain text; an empty path is a dash. In the grid: Enter on a path cell steps onto its last link, ←/→ walk, Esc returns.
 *  - "Next row" walks the rows in the order shown (sort the Term column, then walk) and turns the page when it must.
 *  - Light and dark, 390 px.
 */
const OPTIONS: ListboxPanelOption[] = [
  { value: 'ag:g1', label: 'Jacket IT Exact › Exact group', group: 'Suggested', leading: <Tag>Exact</Tag>, searchText: 'Jacket IT Exact group' },
  { value: 'ag:g2', label: 'Jacket IT Phrase › Phrase group', group: 'Jacket IT', leading: <Tag>Phrase</Tag> },
  { value: 'ag:g3', label: 'Jacket IT Broad › Broad group', group: 'Jacket IT', leading: <Tag>Broad</Tag>, heldReason: 'The term comes from this ad group.', note: 'The term comes from this ad group.' },
  { value: 'ag:g4', label: 'Jacket IT Auto › Auto group', group: 'Jacket IT', leading: <Tag>Auto</Tag>, heldReason: 'An auto campaign takes no keywords.', note: 'An auto campaign takes no keywords.' },
  { value: 'ag:g5', label: 'Shared Exact › Exact group', group: 'No portfolio', leading: <Tag>Exact</Tag> },
  { value: 'ag:g6', label: 'Gloves IT Exact › Exact group', group: 'Gloves IT', leading: <Tag>Exact</Tag>, heldReason: 'Another product runs here.', note: 'Another product runs here.' },
]

const ref = (id: string, name: string, href = true): EntityRef => ({ id, name, href: href ? '/design-system#harvest-parts-example' : undefined })
interface Row { id: string; term: string; goesTo: Array<EntityRef | null> }
const ROWS: Row[] = Array.from({ length: 7 }, (_, i) => ({
  id: `t${i}`,
  term: ['rain jacket', 'jacket men', 'leather jacket', 'summer jacket', 'jacket women', 'touring jacket', 'mesh jacket'][i],
  goesTo: i % 3 === 2
    ? [null, ref(`c${i}`, 'Shared Exact'), ref(`g${i}`, 'Exact group')]
    : [ref('p1', 'Jacket IT'), ref(`c${i}`, 'Jacket IT Exact with a long campaign name'), ref(`g${i}`, 'Exact group')],
}))
const ROW_ID = (p: { data: Row }) => p.data.id

export function HarvestPartsExample() {
  const [value, setValue] = useState('ag:g1')
  const [said, setSaid] = useState('Nothing run yet')
  const narrow = useNarrow()
  const [dialog, setDialog] = useState(false)
  const actions = useMemo<ListboxPanelAction[]>(() => [
    { id: 'campaign', label: 'New campaign…', icon: <Plus />, onSelect: () => setSaid('Ran: New campaign…') },
    { id: 'portfolio', label: 'New portfolio…', icon: <Plus />, onSelect: () => setSaid('Ran: New portfolio…'), heldReason: 'Pick terms of one product first.' },
  ], [])
  const cols = useMemo<ColDef<Row>[]>(() => [
    { colId: 'term', headerName: 'Term', width: 110, sortable: true, ...textColumn<Row>('term') },
    { colId: 'goesTo', flex: 1, minWidth: 110, ...entityPathColumn<Row>('goesTo', { header: 'Goes to', label: (r) => `${r.term} goes to` }) },
  ], [])
  const apiRef = useRef<GridApi<Row> | null>(null)
  const [at, setAt] = useState<string | null>(null)
  const onReady = useCallback((e: GridReadyEvent<Row>) => { apiRef.current = e.api }, [])
  const next = () => {
    const api = apiRef.current
    if (!api) return
    const ids = displayedRowIds(api)
    const to = ids[(at ? ids.indexOf(at) + 1 : 0) % ids.length]
    if (to && revealRow(api, to)) setAt(to)
  }
  return (
    <section id="harvest-parts-example" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--nds-space-12)', maxWidth: 560 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--nds-space-12)' }}>
        <Listbox width="min(300px, 100%)" ariaLabel="Destination" options={OPTIONS} value={value} onChange={setValue} searchable searchPlaceholder="Search campaigns…" actions={actions} />
        <span aria-live="polite" style={{ fontSize: 'var(--nds-font-size-sm)', color: 'var(--nds-text-2)' }}>{said}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--nds-space-8)' }}>
        <Button variant="primary" heldReason="Pick terms of one product first." onClick={() => setSaid('Ran: Harvest (should never show)')}>Harvest to…</Button>
        <Button onClick={() => setSaid('Ran: Skip…')}>Skip…</Button>
        <Button onClick={() => setDialog(true)}>In a dialog</Button>
        <span style={{ fontSize: 'var(--nds-font-size-sm)', color: 'var(--nds-text-2)' }}>{narrow ? 'Narrow (≤ 760 px)' : 'Wide'}</span>
      </div>
      <Modal open={dialog} onClose={() => setDialog(false)} title="Harvest 1 term"
        footer={<><Button onClick={() => setDialog(false)}>Cancel</Button><span className="grow" /><Button variant="primary" onClick={() => setDialog(false)}>Review</Button></>}>
        <Listbox width="100%" ariaLabel="Destination" options={OPTIONS} value={value} onChange={setValue} searchable searchPlaceholder="Search campaigns…" actions={actions} />
      </Modal>
      <div style={{ display: 'grid', gap: 'var(--nds-space-8)' }}>
        <EntityPath label="Goes to" items={[ref('p1', 'Jacket IT'), ref('c1', 'Jacket IT Exact'), ref('g1', 'Exact group')]} />
        <div style={{ width: 220, maxWidth: '100%' }}><EntityPath label="Goes to" items={[ref('p1', 'Jacket IT'), ref('c1', 'Jacket IT Exact with a long campaign name'), ref('g1', 'Exact group')]} /></div>
        <EntityPath label="Found in" items={[null, ref('c2', 'Shared Exact'), ref('g2', 'Ad group without a page', false)]} />
        <EntityPath label="Goes to" items={[]} />
      </div>
      <GridCard toolbar={<GridToolbar count={<><b>{ROWS.length}</b> terms</>} right={<Button size="sm" onClick={next}>Next row</Button>} />}>
        <NexusGrid<Row> density="cozy" domLayout="autoHeight" rowData={ROWS} getRowId={ROW_ID} columnDefs={cols} suppressCellFocus={false}
          pagination paginationPageSize={3} paginationPageSizeSelector={false} onGridReady={onReady} />
      </GridCard>
    </section>
  )
}
