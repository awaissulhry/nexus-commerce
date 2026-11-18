'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import { useLiveChanges } from '../../../record-panels/live'
import { fetchWorkOrderNotes, keptWorkOrderNotes } from './api'
import { gateOf, gotItHere, markGotIt, orderChangeOf, type OrderChangeNote } from './order-change-seen'

/**
 * F-SA-247 (R2; 14-change-flow §5.3): the order-change gate of a floor screen that starts work on a work order in hand — the
 * operation screen's Start, the cutting table's work order before its first cut. It reads the notes of the work orders in hand
 * (`GET /production/dispatch/mine/messages?workOrderId=`) when they come on screen, again on `production.floor_note_posted` or a
 * hold placed or lifted on one of them (STOP ↔ CHECK is the office's read of the hold), and when the stream comes back; offline,
 * what this tablet read in this visit. The 30 s beat of My work stays its own safety net.
 *
 * `before(ids, go)` opens the first CHECK note not "got" on this tablet and holds the Start; "Got it" marks it on THIS tablet
 * (order-change-seen.ts: never sent, no queue kind, no route) and runs `go`, so the Start goes on. A STOP note opens no gate: the
 * hold refuses the scan itself and the screen shows the note as its reason. Nothing here interrupts a running bundle: the gate is
 * only ever asked at a Start.
 */

export interface OrderChangeOpen {
  readonly note: OrderChangeNote
  /** The note comes from this tablet (offline): as of when; null: read now. */
  readonly asOf: string | null
  /** A Start waits behind it (false: a card opened it to read). */
  readonly beforeStart: boolean
}

export interface OrderChangeGate {
  /** The newest order-change note of each work order in hand (null: none; left out: not read yet). */
  readonly notes: Readonly<Record<string, OrderChangeNote | null>>
  /** The note ids tapped "Got it" on this tablet. */
  readonly gotIt: readonly string[]
  /** The note open now; null: none. */
  readonly open: OrderChangeOpen | null
  /** Before a Start on these work orders: true, the Start goes now; false, a note opened and `go` runs after "Got it". */
  readonly before: (workOrderIds: readonly string[], go: () => void) => boolean
  /** Opens one note to read (a card's "Read the order change"); "Got it" then only marks it. */
  readonly show: (note: OrderChangeNote) => void
  /** "Got it": marked on this tablet only, the note closes, a Start that waited goes on. */
  readonly gotItNow: () => void
  /** Back: the note closes; a Start that waited does not happen. */
  readonly close: () => void
}

/** The live changes after which a work order's order-change note may differ (each a hint: the gate reads again). */
const NOTE_MOVES = new Set(['production.floor_note_posted', 'work_order_hold.placed', 'work_order_hold.lifted', 'workorder.status_changed'])
/** A read this fresh is used as it is when a work order comes on screen (the operation screen reads it with the bundle). */
const FRESH_MS = 10_000

export function useOrderChangeGate(input: { readonly api: ApiClient; readonly online: boolean; readonly workOrderIds: readonly string[]; readonly enabled?: boolean }): OrderChangeGate {
  const { api, online } = input
  const enabled = input.enabled ?? true
  const key = [...new Set(input.workOrderIds)].join(',')
  const [notes, setNotes] = useState<Record<string, OrderChangeNote | null>>({})
  const [asOf, setAsOf] = useState<Record<string, string | null>>({})
  const [gotIt, setGotIt] = useState<string[]>([])
  const [open, setOpen] = useState<(OrderChangeOpen & { readonly go: (() => void) | null }) | null>(null)
  const inHand = useRef<readonly string[]>([])
  inHand.current = key === '' ? [] : key.split(',')
  const notesNow = useRef(notes)
  notesNow.current = notes
  const asOfNow = useRef(asOf)
  asOfNow.current = asOf
  const openNow = useRef(open)
  openNow.current = open

  useEffect(() => setGotIt(gotItHere()), [])

  /**
   * Reads each work order's notes (online), else what the tablet kept; a read that fails leaves what is known. `again`: a live
   * hint or a reconnect, always read; else a read of the last few seconds (the bundle's own) is used as it is.
   */
  const read = useCallback(
    async (workOrderIds: readonly string[], again = false) => {
      for (const workOrderId of workOrderIds) {
        const recent = again ? null : keptWorkOrderNotes(workOrderId)
        if (recent && Date.now() - Date.parse(recent.asOf) < FRESH_MS) {
          setNotes((current) => ({ ...current, [workOrderId]: orderChangeOf(recent.value.messages, workOrderId) }))
          setAsOf((current) => ({ ...current, [workOrderId]: null }))
          continue
        }
        const answer = online ? await fetchWorkOrderNotes(api, workOrderId) : null
        const kept = answer?.ok ? null : keptWorkOrderNotes(workOrderId)
        const messages = answer?.ok ? answer.value.messages : (kept?.value.messages ?? null)
        if (messages === null) continue
        setNotes((current) => ({ ...current, [workOrderId]: orderChangeOf(messages, workOrderId) }))
        setAsOf((current) => ({ ...current, [workOrderId]: answer?.ok ? null : (kept?.asOf ?? null) }))
      }
    },
    [api, online],
  )

  useEffect(() => {
    if (!enabled || key === '') return
    void read(key.split(','))
  }, [enabled, key, read])

  useLiveChanges(
    {
      onChange: (change) => {
        if (!NOTE_MOVES.has(change.type)) return
        const workOrderId = typeof change.fields.workOrderId === 'string' ? change.fields.workOrderId : null
        if (workOrderId && inHand.current.includes(workOrderId)) void read([workOrderId], true)
      },
      onReconnect: () => void read(inHand.current, true),
    },
    enabled && online && key !== '',
  )

  const before = useCallback((workOrderIds: readonly string[], go: () => void): boolean => {
    const got = gotItHere()
    // What this screen read decides (null: no order change now); a work order not read here yet: what the tablet read of it.
    const note = gateOf(
      workOrderIds.map((workOrderId) => (notesNow.current[workOrderId] !== undefined ? notesNow.current[workOrderId] : keptNote(workOrderId))),
      got,
    )
    if (!note) return true
    setGotIt(got)
    setOpen({ note, asOf: asOfNow.current[note.workOrder.id] ?? null, beforeStart: true, go })
    return false
  }, [])

  const show = useCallback((note: OrderChangeNote) => setOpen({ note, asOf: asOfNow.current[note.workOrder.id] ?? null, beforeStart: false, go: null }), [])

  const gotItNow = useCallback(() => {
    const current = openNow.current
    if (!current) return
    openNow.current = null
    setGotIt(markGotIt(current.note.id))
    setOpen(null)
    // The Start that waited goes on: its gate now finds the note got on this tablet.
    current.go?.()
  }, [])

  const close = useCallback(() => setOpen(null), [])

  return { notes, gotIt, open: open ? { note: open.note, asOf: open.asOf, beforeStart: open.beforeStart } : null, before, show, gotItNow, close }
}

/** A work order's note the tablet read this visit but not yet on this screen (My work's read, an earlier bundle of it). */
function keptNote(workOrderId: string): OrderChangeNote | null {
  const kept = keptWorkOrderNotes(workOrderId)
  return kept ? orderChangeOf(kept.value.messages, workOrderId) : null
}
