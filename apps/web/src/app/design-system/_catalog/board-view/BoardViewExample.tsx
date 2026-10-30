'use client'

import { useState } from 'react'

import { SegmentedControl } from '@/design-system/primitives'
import { BoardView, type BoardCard, type BoardLane, type BoardMove } from '@/design-system/grid/views/board'

/*
 * 2026-10-30 — board (kanban) view for lists (factory gap D19, `packages/ui/src/grid/views/board`). Made-up
 * nonconformances. Verify: drag a card onto another column; Tab to a card, Space picks it up, ← → choose a column,
 * Enter drops, Escape cancels — each step is said; the Move to… menu lists every column, the held ones with their
 * reason; NCR-0108 cannot go to Decided ("3 of 40 garments not decided"); Closed is held (only quality managers close);
 * NCR-0101 is waiting for its signature and cannot move; Show more under Open; below 640 px of its own width the columns
 * stack. Light and dark, 1440 and 390.
 */

const lanes: BoardLane[] = [
  { id: 'open', label: 'Open', total: 6, detail: 'Oldest 12 days', tone: 'danger' },
  { id: 'contained', label: 'Contained', detail: 'Oldest 4 days', tone: 'warning' },
  { id: 'decided', label: 'Decided', tone: 'info' },
  { id: 'closed', label: 'Closed', held: 'Only quality managers close a nonconformance', tone: 'success' },
]

const start: BoardCard[] = [
  { id: 'n108', laneId: 'open', label: 'NCR-0108', title: 'Seam opens at the armour pocket', fields: [{ label: 'Severity', value: 'Major' }, { label: 'Owner', value: 'Quality' }], marks: [{ label: 'Customer complaint', tone: 'danger' }] },
  { id: 'n109', laneId: 'open', label: 'NCR-0109', title: 'Zip colour does not match the sample', fields: [{ label: 'Severity', value: 'Minor' }] },
  { id: 'n104', laneId: 'contained', label: 'NCR-0104', title: 'Holes in two hides of lot L-2231', fields: [{ label: 'Severity', value: 'Major' }, { label: 'Owner', value: 'Warehouse' }] },
  { id: 'n102', laneId: 'decided', label: 'NCR-0102', title: 'Wrong size label on 12 jackets', fields: [{ label: 'Severity', value: 'Minor' }], marks: [{ label: 'Rework', tone: 'info' }] },
  { id: 'n101', laneId: 'decided', label: 'NCR-0101', title: 'Stitch density under the spec', held: 'Waiting for the closing signature' },
]

export function BoardViewExample() {
  const [cards, setCards] = useState(start)
  // The server's count of Open, kept in step with the moves (the API would answer it).
  const [openTotal, setOpenTotal] = useState(6)
  const [layout, setLayout] = useState<'board' | 'list'>('board')
  const [last, setLast] = useState('')
  const onMove = (move: BoardMove) => {
    setCards((now) => now.map((card) => (card.id === move.cardId ? { ...card, laneId: move.to } : card)))
    setOpenTotal((now) => now + (move.to === 'open' ? 1 : 0) - (move.from === 'open' ? 1 : 0))
    setLast(`${move.via}: ${move.cardId} ${move.from} → ${move.to}`)
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--nds-space-12)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--nds-space-12)', alignItems: 'center' }}>
        <SegmentedControl
          ariaLabel="Layout"
          value={layout}
          onChange={(value: string) => setLayout(value as 'board' | 'list')}
          options={[
            { value: 'board', label: 'Board' },
            { value: 'list', label: 'List (phone)' },
          ]}
        />
        <span style={{ color: 'var(--nds-text-2)' }}>{last || 'No move yet.'}</span>
      </div>
      <BoardView
        label="Nonconformances (example)"
        lanes={lanes.map((lane) => (lane.id === 'open' ? { ...lane, total: openTotal } : lane))}
        cards={cards}
        layout={layout}
        onMove={onMove}
        moveHeld={(card, laneId) => (card.id === 'n108' && laneId === 'decided' ? '3 of 40 garments not decided' : null)}
        onMore={() => setLast('Show more: the app reads the next page of Open')}
        renderAside={(card) => (card.id === 'n108' ? 'Due in 2 days' : card.id === 'n104' ? 'Due today' : null)}
      />
    </div>
  )
}
