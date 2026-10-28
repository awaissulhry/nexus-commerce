'use client'

import { useRef, useState } from 'react'
import { Ban, Check, Package, Pause, Trash2 } from 'lucide-react'

import { FloorActionBar, FloorFrame, FloorList, FloorListRow, useConfirmFeedback } from '@/design-system/floor'
import { SegmentedControl } from '@/design-system/primitives'

import type { FloorCopy } from './floorCopy'
import s from './floorCatalog.module.css'

/*
 * G5 list rows and action bar, G8 confirm feedback, on the floor tier with fake data. Each action answers on the count
 * card with colour + vibration (Android) + sound, through `useConfirmFeedback()` bound to the frame's mute setting.
 * Verify: green / amber / red flash; with reduced motion the colour holds still; "Sound off" silences only the sound.
 */
function OperationScreen({ copy }: { copy: FloorCopy }) {
  const target = useRef<HTMLDivElement>(null)
  const feedback = useConfirmFeedback()
  const [count, setCount] = useState(12)
  const [said, setSaid] = useState('')
  return (
    <div className={s.example}>
      <div ref={target} className={s.target} aria-live="polite">
        <span className={s.targetNumber}>{count}</span>
        <span className={s.targetWords}>{said || copy.counted}</span>
      </div>
      <FloorActionBar
        actions={[
          {
            label: copy.actions.scrap,
            icon: <Trash2 />,
            variant: 'warning',
            onPress: () => {
              feedback('warning', target.current)
              setSaid(copy.feedbackCheck)
            },
          },
          {
            label: copy.actions.refuse,
            icon: <Ban />,
            variant: 'danger',
            onPress: () => {
              feedback('error', target.current)
              setSaid(copy.feedbackRefused)
            },
          },
          {
            label: copy.actions.done,
            icon: <Check />,
            variant: 'success',
            onPress: () => {
              feedback('success', target.current)
              setCount((n) => n + 1)
              setSaid(copy.feedbackDone)
            },
          },
        ]}
      />
    </div>
  )
}

export function FloorWorkExample({ copy }: { copy: FloorCopy }) {
  const [muted, setMuted] = useState(false)
  const [selected, setSelected] = useState(1)
  const rows = [
    { title: 'Pelle nera 1,2 mm', meta: 'B3 · lotto 77', tone: 'success' as const, status: copy.rows.done, count: 4 },
    { title: 'Fodera rete', meta: 'C1 · lotto 12', tone: 'warning' as const, status: copy.rows.short, count: 3 },
    { title: 'Protezione spalla', meta: 'A4 · lotto 31', tone: 'danger' as const, status: copy.rows.held, count: 2 },
    { title: 'Cerniera 60 cm', meta: 'D2', tone: 'neutral' as const, status: copy.rows.todo, count: 8 },
  ]
  return (
    <div className={s.example} id="floor-work-example">
      <h3 className={s.title}>FloorListRow, FloorActionBar and confirmFeedback</h3>
      <div className={s.controls}>
        <SegmentedControl
          size="sm"
          ariaLabel="Sound"
          value={muted ? 'off' : 'on'}
          onChange={(v) => setMuted(v === 'off')}
          options={[
            { value: 'on', label: 'Sound on' },
            { value: 'off', label: 'Sound off' },
          ]}
        />
      </div>
      <div className={s.pair}>
        <div className={s.screen}>
          <FloorFrame fill={false} landmarks={false} label={copy.pick}>
            <FloorList label={copy.pick}>
              {rows.map((r, i) => (
                <FloorListRow
                  key={r.title}
                  icon={<Package />}
                  title={r.title}
                  meta={r.meta}
                  tone={r.tone}
                  status={r.status}
                  count={r.count}
                  countLabel={copy.pieces}
                  selected={selected === i}
                  onPress={() => setSelected(i)}
                />
              ))}
            </FloorList>
          </FloorFrame>
        </div>
        <div className={s.screen}>
          <FloorFrame fill={false} landmarks={false} muted={muted} label={copy.counted} actions={<FloorActionBar actions={[{ label: copy.actions.pause, icon: <Pause />, onPress: () => undefined }]} />}>
            <OperationScreen copy={copy} />
          </FloorFrame>
        </div>
      </div>
    </div>
  )
}
