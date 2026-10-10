'use client'

import { useMemo, useRef, useState } from 'react'

import { EditModeBar } from '../patterns/EditModeBar'
import {
  GridCard, GridToolbar, NexusGrid, gridSelection, switchColumn, textColumn,
  type ColDef, type SwitchHandlers,
} from '../grid'

/*
 * 2026-10-10 — ads brain page D2: an on/off column that only changes a DRAFT. Made-up rows. Verify:
 *  - a click on a switch flips it, shows "Not saved" and the bar counts the change; nothing is saved until "Save";
 *    the click never ticks or opens the row;
 *  - arrow to a switch cell and press Space (or Enter): the switch flips, the row's tick box does NOT change;
 *  - "Product D" cannot move: disabled, its reason on hover and read by a screen reader;
 *  - Discard puts every switch back; sorting the column puts Off before On; Customise lists "Brain". Light and dark.
 */
interface Row { id: string; name: string; market: string; brain: boolean; held?: string }

const START: Row[] = [
  { id: 'a', name: 'Product A', market: 'IT', brain: true },
  { id: 'b', name: 'Product B', market: 'IT', brain: false },
  { id: 'c', name: 'Product C', market: 'DE', brain: true },
  { id: 'd', name: 'Product D', market: 'FR', brain: false, held: 'Not advertised in this market' },
]
const ROW_ID = (p: { data: Row }) => p.data.id

export function SwitchColumnExample() {
  const [draft, setDraft] = useState<Record<string, boolean>>({})
  const [saved, setSaved] = useState<Row[]>(START)
  const [log, setLog] = useState('nothing saved yet')
  const draftRef = useRef(draft)
  draftRef.current = draft

  // The handlers live in a ref, so the column definitions never change while the draft does.
  const handlers = useRef<SwitchHandlers<Row>>({})
  handlers.current.onSwitch = (row, next) => {
    setDraft((d) => {
      const base = saved.find((r) => r.id === row.id)?.brain
      const rest = { ...d }
      delete rest[row.id]
      return next === base ? rest : { ...rest, [row.id]: next }
    })
  }

  const rows = useMemo(() => saved.map((r) => (r.id in draft ? { ...r, brain: draft[r.id] } : r)), [saved, draft])
  const cols = useMemo<ColDef<Row>[]>(() => [
    { colId: 'name', headerName: 'Product', width: 160, ...textColumn<Row>('name') },
    { colId: 'market', headerName: 'Market', width: 110, ...textColumn<Row>('market') },
    {
      colId: 'brain',
      width: 170,
      ...switchColumn<Row>('brain', {
        header: 'Brain',
        label: (r) => `Keep ${r.name} under the brain`,
        disabledReason: (r) => r.held ?? null,
        pending: (r) => r.id in draftRef.current,
      }),
    },
  ], [])
  const count = Object.keys(draft).length

  return (
    <section id="switch-column-example" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--nds-space-10)', maxWidth: 560 }}>
      <GridCard toolbar={<GridToolbar count={<><b>{rows.length}</b> products</>} />}>
        <NexusGrid<Row>
          density="cozy"
          domLayout="autoHeight"
          rowData={rows}
          getRowId={ROW_ID}
          columnDefs={cols}
          context={handlers}
          rowSelection={gridSelection<Row>()}
        />
      </GridCard>
      {count > 0 && (
        <EditModeBar
          count={count}
          applyLabel={`Save ${count} ${count === 1 ? 'change' : 'changes'}`}
          onDiscard={() => setDraft({})}
          onApply={() => {
            setSaved(rows.map((r) => ({ ...r })))
            setDraft({})
            setLog(`saved ${count} ${count === 1 ? 'change' : 'changes'} (example: nothing leaves the page)`)
          }}
        />
      )}
      <span style={{ fontSize: 'var(--nds-font-size-sm)', color: 'var(--nds-text-2)' }}>Last save: <b>{log}</b></span>
    </section>
  )
}
