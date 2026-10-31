'use client'

/**
 * FloorListUpdates — the floor list's updates slot (B-W2b-28, design part "FloorList updates slot", the floor form of
 * D11): rows never move under a gloved finger. New rows wait; a big "List changed · Show" button puts them in.
 *
 *   const live = useFloorListUpdates(rowsFromServer, { key: (r) => r.id, version: (r) => `${r.status}:${r.count}` })
 *   <FloorList label="Il mio lavoro" updates={<FloorListUpdates pending={live.pending} onShow={live.show} labels={ds.floorListUpdates} />}>
 *     {live.rows?.map((r) => <FloorListRow key={r.id} … />)}
 *   </FloorList>
 *
 * - The button is the screen's main action size, full width, above the rows and sticky at the top of the scroll area,
 *   so it is in reach without scrolling. Without changes nothing is drawn but an empty polite live region.
 * - A screen reader hears ONE polite sentence when the list first changes, not on every later change.
 * - `useFloorListUpdates` keeps the rows on screen until Show; the first rows, and rows into an empty list, go in at
 *   once (`floorListUpdatesModel.ts`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { FloorButton } from '../FloorButton'
import { FLOOR_LIST_UPDATES_LABELS, type FloorListUpdatesLabels } from './FloorListUpdatesLabels'
import { floorListChanges, floorListTakesAtOnce } from './floorListUpdatesModel'
import '../floor.css'
import './floorListUpdates.css'

export interface FloorListUpdatesProps {
  /** Rows that changed and wait (0: nothing waits). `useFloorListUpdates().pending`. */
  pending: number
  /** Puts the new rows in. */
  onShow: () => void
  /** The count is not known (a "something changed" ping): show the button without a number. */
  countUnknown?: boolean
  labels?: Partial<FloorListUpdatesLabels>
}

export function FloorListUpdates({ pending, onShow, countUnknown, labels }: FloorListUpdatesProps) {
  const lw = mergeLabels(FLOOR_LIST_UPDATES_LABELS, labels)
  const waiting = pending > 0
  const [spoken, setSpoken] = useState('')
  const was = useRef(false)
  useEffect(() => {
    if (waiting && !was.current) setSpoken(lw.announce)
    if (!waiting) setSpoken('')
    was.current = waiting
  }, [waiting, lw.announce])

  return (
    <div className="nds-floor-list-updates" data-waiting={waiting ? 'true' : undefined}>
      <span className="nds-floor-sr" aria-live="polite" aria-atomic="true">
        {spoken}
      </span>
      {waiting ? (
        <FloorButton variant="primary" size="lg" block icon={<RefreshCw />} onClick={onShow}>
          {lw.changed(countUnknown ? 0 : pending)} · {lw.show}
        </FloorButton>
      ) : null}
    </div>
  )
}

export interface FloorListUpdatesOptions<T> {
  /** A row's id. */
  key: (row: T) => string
  /** What makes a row look different (its status, its count). Without it only added, removed and moved rows count. */
  version?: (row: T) => string
}

export interface FloorListUpdatesState<T> {
  /** The rows to draw: what was on screen until Show. `null` until the first rows come. */
  rows: readonly T[] | null
  /** Rows that changed and wait for Show. */
  pending: number
  /** Puts the waiting rows in. */
  show: () => void
}

/** Holds the rows on screen while new ones wait; see `FloorListUpdates`. `incoming` is `null` while the first read runs. */
export function useFloorListUpdates<T>(incoming: readonly T[] | null, { key, version }: FloorListUpdatesOptions<T>): FloorListUpdatesState<T> {
  const [shown, setShown] = useState<readonly T[] | null>(incoming)
  const keyRef = useRef(key)
  keyRef.current = key
  const versionRef = useRef(version)
  versionRef.current = version
  const pending = useMemo(
    () => (shown && incoming ? floorListChanges(shown, incoming, keyRef.current, versionRef.current) : 0),
    [shown, incoming],
  )
  useEffect(() => {
    if (incoming === shown || incoming === null) return
    if (shown === null || floorListTakesAtOnce(shown.length, pending)) setShown(incoming)
  }, [incoming, shown, pending])
  const show = useCallback(() => setShown(incoming), [incoming])
  return { rows: shown, pending: shown === null || shown.length === 0 ? 0 : pending, show }
}
