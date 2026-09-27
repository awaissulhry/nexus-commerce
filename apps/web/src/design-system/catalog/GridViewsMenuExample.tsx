'use client'

import { useMemo, useState } from 'react'

import { GridViewsMenu } from '../grid/toolbars/GridViewsMenu'
import type { GridStateApi } from '../grid/hooks/useGridState'
import type { SavedGridView } from '../grid/hooks/useGridViews'
import { columnsViewPayload } from '../grid/views/viewPayload'

/*
 * 2026-09-26 — SHEET-VIEWS P2: my views, then the team's after a rule ("Shared by <name>"); a teammate's
 * view offers only Duplicate…; my own view adds Share with team and Make default for <Type> products.
 * A rule view says what it follows. In-memory only: nothing here reaches the server.
 */
const OUTERWEAR = { code: 'OUTERWEAR', label: 'Outerwear' }
const INITIAL: SavedGridView<null>[] = [
  { id: 'mine', name: 'Launch check', isDefault: false, updatedAt: '2026-09-26T10:00:00.000Z', owned: true, shared: true, teamShared: false, sharedBy: null, defaultProductTypes: ['OUTERWEAR'],
    payload: { ...columnsViewPayload(['name', 'brand']), rules: [{ kind: 'required' }] } },
  { id: 'team', name: 'Fix the gaps', isDefault: false, updatedAt: '2026-09-25T10:00:00.000Z', owned: false, shared: true, teamShared: true, sharedBy: 'Giulia Bianchi', defaultProductTypes: [],
    payload: { ...columnsViewPayload(['name']), rules: [{ kind: 'gaps' }] } },
]
const NOTES: Record<string, string> = { mine: 'Follows required fields', team: 'Follows fields with gaps' }

export function GridViewsMenuExample() {
  const [views, setViews] = useState(INITIAL)
  const [activeId, setActiveId] = useState<string | null>('mine')
  const change = (id: string, patch: Partial<SavedGridView<null>>) => setViews((list) => list.map((v) => (v.id === id ? { ...v, ...patch } : v)))
  const api = useMemo(() => ({
    views, activeId,
    apply: (v: SavedGridView<null>) => setActiveId(v.id),
    save: async () => 'mine', rename: async () => {}, duplicate: async () => 'mine', setDefault: async () => {}, clearDefault: async () => {}, remove: async () => {},
    setShared: async (id: string, shared: boolean) => change(id, { shared }),
    setTypeDefault: async (id: string, type: string, on: boolean) => change(id, { defaultProductTypes: on ? [type] : [] }),
  }) as unknown as GridStateApi<null>, [views, activeId])
  return <section id="grid-views-menu-example">
    <h3>Views menu — team views and rule views</h3>
    <p>My views first, then views a teammate shared. A teammate&apos;s view can be applied and duplicated, never changed. A view that follows a rule says so; a new column there joins it by itself.</p>
    <GridViewsMenu<null> views={api} showCounts productType={OUTERWEAR} describeView={(v) => ({ note: NOTES[v.id] })} />
    <h3>As a sheet&apos;s “Columns” menu (2026-09-27)</h3>
    <p>Headings name each section, the trigger names the question and the answer, the sheet adds My layout after the built-in views and Customise at the end.</p>
    <GridViewsMenu<null> views={api} showCounts headings productType={OUTERWEAR} describeView={(v) => ({ note: NOTES[v.id] })}
      presets={[{ id: 'all', label: 'All attributes', columns: ['name', 'brand', 'color'] }, { id: 'required', label: 'Required', columns: ['name'] }]}
      activePresetId={activeId ? null : 'all'}
      triggerLabel={<><span className="nds-toolbar-menu-lead">Columns</span><span className="nds-toolbar-fold-active">{views.find((v) => v.id === activeId)?.name ?? 'All attributes'}</span></>}
      afterPresets={[{ id: 'my-layout', label: 'My layout (2)' }]}
      endItems={[{ id: 'customise', label: 'Customise columns…' }]} />
  </section>
}
