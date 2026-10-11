'use client'

import { useMemo, useRef, useState } from 'react'

import { EditModeBar } from '../patterns/EditModeBar'
import {
  GridCard, GridToolbar, NexusGrid, gridSelection, modeColumn, modeWord, MODE_STEPS, textColumn,
  type ColDef, type ModeCellValue, type ModeHandlers,
} from '../grid'

/*
 * 2026-10-10 — bid page DS lane: a 4-step mode column (Off · Watch · Ask me · Auto) that only changes a DRAFT. Made-up
 * rows. Verify:
 *  - a click on a mode cell (or Enter / Space on the focused cell) opens the list; arrows move, Enter picks, Escape
 *    closes without a change; a pick shows "Not saved" and the bar counts it — nothing is saved until "Save";
 *  - Space never ticks the row; the click never opens or ticks the row;
 *  - "Rule B" is set to Auto but acts as Ask me: the meter's last bar is an outline and the mark's name says why;
 *  - in "Rule B"'s list, Auto is held with its reason under it (reachable, never picked);
 *  - "Rule D" is locked: its lock says why on hover, and Space or Enter on the cell puts the focus on it;
 *  - sorting the column goes Off → Auto. Light and dark.
 */
interface Row { id: string; name: string; scope: string; mode: ModeCellValue; locked?: string; autoHeld?: string }

const START: Row[] = [
  { id: 'a', name: 'Rule A', scope: 'IT · 4 campaigns', mode: 'ASK' },
  { id: 'b', name: 'Rule B', scope: 'IT · 2 campaigns', mode: { set: 'AUTO', acts: 'ASK', heldBy: { kind: 'dial', label: 'the account dial' } }, autoHeld: 'Needs 14 clean days first' },
  { id: 'c', name: 'Rule C', scope: 'DE · 1 campaign', mode: 'WATCH' },
  { id: 'd', name: 'Rule D', scope: 'FR · 3 campaigns', mode: 'OFF', locked: 'Changing it needs the ads rules permission' },
]
const ROW_ID = (p: { data: Row }) => p.data.id
const setOf = (mode: ModeCellValue) => (typeof mode === 'string' ? mode : mode?.set ?? null)
/** A drafted step replaces the set step; what acts is the server's to say again after a save. */
const withSet = (mode: ModeCellValue, next: string): ModeCellValue => (typeof mode === 'object' && mode ? { ...mode, set: next } : next)

export function ModeColumnExample() {
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<Row[]>(START)
  const [log, setLog] = useState('nothing saved yet')
  const draftRef = useRef(draft)
  draftRef.current = draft

  // The handlers live in a ref, so the column definitions never change while the draft does.
  const handlers = useRef<ModeHandlers<Row>>({})
  handlers.current.onMode = (row, next) => {
    setDraft((d) => {
      const base = setOf(saved.find((r) => r.id === row.id)?.mode)
      const rest = { ...d }
      delete rest[row.id]
      return next === base ? rest : { ...rest, [row.id]: next }
    })
  }

  const rows = useMemo(() => saved.map((r) => (r.id in draft ? { ...r, mode: withSet(r.mode, draft[r.id]) } : r)), [saved, draft])
  const cols = useMemo<ColDef<Row>[]>(() => [
    { colId: 'name', headerName: 'Rule', width: 130, ...textColumn<Row>('name') },
    { colId: 'scope', headerName: 'Applies to', width: 160, ...textColumn<Row>('scope') },
    {
      width: 190,
      ...modeColumn<Row>('mode', {
        header: 'Mode',
        heldOption: (r, step) => (step === 'AUTO' ? r.autoHeld ?? null : null),
        lockReason: (r) => r.locked ?? null,
        pending: (r) => r.id in draftRef.current,
      }),
    },
  ], [])
  const count = Object.keys(draft).length

  return (
    <section id="mode-column-example" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--nds-space-10)', maxWidth: 560 }}>
      <GridCard toolbar={<GridToolbar count={<><b>{rows.length}</b> rules</>} />}>
        <NexusGrid<Row>
          density="cozy"
          domLayout="autoHeight"
          rowData={rows}
          getRowId={ROW_ID}
          columnDefs={cols}
          context={handlers}
          rowSelection={gridSelection<Row>()}
          suppressCellFocus={false}
        />
      </GridCard>
      {count > 0 && (
        <EditModeBar
          count={count}
          applyLabel={`Save ${count} ${count === 1 ? 'change' : 'changes'}`}
          onDiscard={() => setDraft({})}
          onApply={() => {
            setSaved(rows.map((r) => ({ ...r })))
            setLog(Object.entries(draft).map(([id, step]) => `${saved.find((r) => r.id === id)?.name} → ${modeWord(MODE_STEPS, step)}`).join(', '))
            setDraft({})
          }}
        />
      )}
      <span style={{ fontSize: 'var(--nds-font-size-sm)', color: 'var(--nds-text-2)' }}>Last save: <b>{log}</b></span>
    </section>
  )
}
