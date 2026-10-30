'use client'

import { useState } from 'react'

import { SegmentedControl } from '@/design-system/primitives'
import {
  LoadBar,
  PlanningBoard,
  withMove,
  type PlanningBucket,
  type PlanningCard,
  type PlanningLane,
  type PlanningMove,
} from '@/design-system/patterns/planning-board'

/*
 * 2026-10-30 — planning board and load bar (factory gap D18, `packages/ui/src/patterns/planning-board`). Made-up lines,
 * work orders and minutes. Verify: drag a card onto another day or line (the target cells show the load after the drop;
 * Line 2 on Tuesday goes over and says "+… min over"); Tab to a card, Space picks it up, arrows move, Enter drops,
 * Escape cancels — each step is said; the pinned card and Workshop Beta refuse with their reason; Undo / Redo (⌘Z / ⌘⇧Z)
 * only while the card is still where it was put; the columns layout is the allocation board; below 640 px of its own
 * width the board is a list with a Move dialog. Light and dark, 1440 and 390.
 */

const DAY = 2880
const buckets: PlanningBucket[] = [
  { id: 'mon', label: 'Mon 16', detail: 'Nov' },
  { id: 'tue', label: 'Tue 17', detail: 'Nov', today: true },
  { id: 'wed', label: 'Wed 18', detail: 'Nov' },
  { id: 'thu', label: 'Thu 19', detail: 'Nov' },
  { id: 'fri', label: 'Fri 20', detail: 'Nov', closed: 'Site shutdown' },
]
const formula = (people: number, minutes: number, efficiency: number) =>
  `${people} people × ${minutes} min × ${efficiency}% efficiency = ${Math.round((people * minutes * efficiency) / 100).toLocaleString('en-GB')} min`
const lanes: PlanningLane[] = [
  {
    id: 'line-1',
    label: 'Line 1',
    detail: '8 people · 80%',
    capacity: { mon: DAY, tue: DAY, wed: DAY, thu: DAY, fri: 0 },
    capacityWords: { mon: formula(8, 450, 80), tue: formula(8, 450, 80), wed: formula(8, 450, 80), thu: formula(8, 450, 80) },
  },
  {
    id: 'line-2',
    label: 'Line 2',
    detail: '8 people · 80%',
    capacity: { mon: DAY, tue: DAY, wed: DAY, thu: DAY, fri: 0 },
    capacityWords: { mon: formula(8, 450, 80), tue: formula(8, 450, 80), wed: formula(8, 450, 80), thu: formula(8, 450, 80) },
  },
  { id: 'cutting', label: 'Cutting', detail: 'Work centre · 3 tables', capacity: { mon: 1080, tue: 1080, wed: null, thu: null, fri: 0 } },
  { id: 'beta', label: 'Workshop Beta', detail: 'Subcontractor', held: 'Not approved for armour pockets' },
]
const start: PlanningCard[] = [
  { id: 'wo-1', label: 'WO-1001', detail: 'Touring jacket · 40 pcs', minutes: 1680, laneId: 'line-1', bucketId: 'mon' },
  { id: 'wo-2', label: 'WO-1002', detail: 'Summer jacket · 60 pcs', minutes: 4200, laneId: 'line-1', bucketId: 'tue', span: 2, load: [2400, 1800] },
  { id: 'wo-3', label: 'WO-1003', detail: 'Rain trousers · 30 pcs', minutes: 2340, laneId: 'line-2', bucketId: 'tue', late: true },
  { id: 'wo-4', label: 'WO-1004', detail: 'Leather gloves · 80 pcs', minutes: 960, laneId: 'line-2', bucketId: 'mon', pinned: true, marks: [{ label: 'Sample approved', tone: 'success' }] },
  { id: 'wo-5', label: 'WO-1005', detail: 'Cut · 40 jackets', minutes: 720, laneId: 'cutting', bucketId: 'mon' },
  { id: 'wo-6', label: 'WO-1006', detail: 'Winter jacket · 24 pcs', minutes: 1300, laneId: null, bucketId: null, marks: [{ label: 'Material 18 Nov', tone: 'warning' }] },
  { id: 'wo-7', label: 'WO-1007', detail: 'Vest · 50 pcs', minutes: 900, laneId: null, bucketId: null },
]

type Layout = 'time' | 'columns' | 'list'

export function PlanningBoardExample() {
  const [cards, setCards] = useState(start)
  const [layout, setLayout] = useState<Layout>('time')
  const [last, setLast] = useState<string>('')
  const onMove = (move: PlanningMove) => {
    setCards((now) => withMove(now, move.cardId, move.to, layout === 'columns' ? 'columns' : 'time'))
    setLast(`${move.via}: ${move.cardId} → ${move.to.laneId ?? 'tray'}${move.to.bucketId ? ` / ${move.to.bucketId}` : ''}${move.over ? ' (over capacity)' : ''}`)
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--nds-space-12)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--nds-space-12)', alignItems: 'center' }}>
        <SegmentedControl
          ariaLabel="Layout"
          value={layout}
          onChange={(value: string) => setLayout(value as Layout)}
          options={[
            { value: 'time', label: 'Lanes × days' },
            { value: 'columns', label: 'Columns (allocation)' },
            { value: 'list', label: 'List (phone)' },
          ]}
        />
        <span style={{ color: 'var(--nds-text-2)' }}>{last || 'No move yet.'}</span>
      </div>
      <PlanningBoard
        label="Planning board (example)"
        lanes={lanes}
        buckets={buckets}
        cards={cards}
        layout={layout}
        onMove={onMove}
        onPin={(card, pinned) => setCards((now) => now.map((item) => (item.id === card.id ? { ...item, pinned } : item)))}
        dropHeld={(card, to) => (card.id === 'wo-6' && to.laneId !== null && to.bucketId !== 'thu' && to.bucketId !== 'fri' ? 'Leather arrives on 18 Nov: earliest start Thu 19' : null)}
      />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 'var(--nds-space-12)' }}>
        <LoadBar booked={2340} available={2880} label="Under capacity" size="md" />
        <LoadBar booked={2880} available={2880} label="Full" size="md" />
        <LoadBar booked={3520} available={2880} label="Over capacity" size="md" />
        <LoadBar booked={2340} available={2880} after={2844} label="Preview" size="md" />
        <LoadBar booked={0} available={null} label="No calendar" size="md" />
        <LoadBar booked={0} available={undefined} label="Unknown" size="md" />
      </div>
    </div>
  )
}
