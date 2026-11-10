'use client'

import { useCallback, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { decideOrder, decideSmv, moveRequest, readCompare, readDrift, readMinutes, readOrder, readRequest } from './api'
import { actionHeld, moveHeld, readProblem, rowOfOrder, rowOfRequest, writeProblem, type ChangeRow, type ChangesCan, type DecideChoice, type Phrase } from './model'
import type { DecideModel } from './view/DecideDialog'

const EMPTY: Omit<DecideModel, 'row'> = { ids: [], reading: true, problem: null, order: null, request: null, minutes: null, redline: null, drift: null, holds: {}, reason: '', busy: false, notice: null, offline: false }

/**
 * Approve change's state and calls, shared by the list (a row, J / K through the list) and the record (its own change):
 * open reads the record — a change order with its redline (B-W2b-220's compare) and the open quotes and orders on older
 * revisions; a change request; an SMV change's operation minutes — and says why each button is held from what it read;
 * decide sends the decision at the version read with one Idempotency-Key per attempt (a stale version reads again).
 */
export function useDecide(api: ApiClient, can: ChangesCan, me: string, onDone: (receipt: Phrase) => void, onFail: (problem: string) => void) {
  const [decide, setDecide] = useState<DecideModel | null>(null)
  const key = useRef<string | null>(null)
  const current = useRef<DecideModel | null>(null)
  current.current = decide
  const done = useRef(onDone)
  done.current = onDone
  const fail = useRef(onFail)
  fail.current = onFail

  /** Open (or move to) one change: its row when known (an SMV change is known only from a list), the list's ids for J / K. */
  const open = useCallback(
    async (rowId: string, known: ChangeRow | null, ids: readonly string[]) => {
      const [kind, id] = rowId.split(':') as [ChangeRow['kind'], string]
      if (kind === 'smv' && !known) return
      key.current = null
      const base = { ...EMPTY, ids }
      const same = (now: DecideModel | null) => now !== null && now.row.id === rowId
      if (known) setDecide({ ...base, row: known })
      try {
        if (kind === 'order') {
          const order = await readOrder(api, id)
          const held = actionHeld(order, 'decide', can, false)
          setDecide((now) => ({
            ...(now && same(now) ? now : base),
            row: rowOfOrder(order),
            order,
            reading: false,
            holds: { APPROVED: held, REJECTED: held },
            redline: order.compare ? (can.bom ? { compare: null, problem: null } : { compare: null, problem: 'problem.forbidden' }) : { compare: null, problem: null, none: true },
            drift: can.bom ? { value: null, problem: null } : null,
          }))
          if (order.compare && can.bom)
            readCompare(api, order.compare)
              .then((compare) => setDecide((now) => (same(now) ? { ...now!, redline: { compare, problem: null } } : now)))
              .catch((error: unknown) => setDecide((now) => (same(now) ? { ...now!, redline: { compare: null, problem: readProblem(error) } } : now)))
          if (can.bom)
            readDrift(api, order.style.id)
              .then((value) => setDecide((now) => (same(now) ? { ...now!, drift: { value, problem: null } } : now)))
              .catch((error: unknown) => setDecide((now) => (same(now) ? { ...now!, drift: { value: null, problem: readProblem(error) } } : now)))
        } else if (kind === 'request') {
          const request = await readRequest(api, id)
          setDecide((now) => ({
            ...(now && same(now) ? now : base),
            row: rowOfRequest(request),
            request,
            reading: false,
            holds: { APPROVED: moveHeld(request, 'ACCEPTED', can, false), REJECTED: moveHeld(request, 'REJECTED', can, false), IN_REVIEW: moveHeld(request, 'IN_REVIEW', can, false) },
          }))
        } else if (known && known.kind === 'smv') {
          const held: Phrase | null = !can.smvDecide || !known.smv.mayDecide ? { key: known.smv.proposal.proposedBy.id === me ? 'held.ownSmv' : 'held.noSmvApprove' } : null
          setDecide((now) => (same(now) ? { ...now!, holds: { APPROVED: held, REJECTED: held } } : now))
          const minutes = await readMinutes(api, known.smv.operation.id)
          setDecide((now) => (same(now) ? { ...now!, minutes, reading: false } : now))
        }
      } catch (error) {
        // A change not on screen whose read failed has nothing to show: the page says why instead.
        if (!known) fail.current(readProblem(error))
        setDecide((now) => (now ? { ...now, reading: false, problem: readProblem(error) } : now))
      }
    },
    [api, can, me],
  )

  const submit = useCallback(
    async (choice: DecideChoice) => {
      const now = current.current
      if (!now || now.busy) return
      const row = now.row
      if (choice === 'IN_REVIEW' && row.kind !== 'request') return
      setDecide({ ...now, busy: true, notice: null })
      key.current ??= newIdempotencyKey()
      const reason = now.reason.trim()
      try {
        let receipt: Phrase | null = null
        if (row.kind === 'order' && now.order && choice !== 'IN_REVIEW') {
          const order = await decideOrder(api, now.order.id, { version: now.order.version, decision: choice, ...(reason ? { reason } : {}) }, key.current)
          receipt = { key: choice === 'APPROVED' ? 'decide.doneApproved' : 'decide.doneRejected', params: { number: order.number } }
        } else if (row.kind === 'request' && now.request) {
          const to = choice === 'APPROVED' ? 'ACCEPTED' : choice
          const request = await moveRequest(api, now.request.id, { version: now.request.version, to, ...(reason ? { note: reason } : {}) }, key.current)
          receipt = { key: `decide.doneRequest.${to}`, params: { number: request.number ?? '' } }
        } else if (row.kind === 'smv' && choice !== 'IN_REVIEW') {
          await decideSmv(api, { operationId: row.smv.operation.id, versionId: row.smv.proposal.id, version: row.smv.proposal.version }, choice, reason || null, key.current)
          receipt = { key: choice === 'APPROVED' ? 'decide.doneApproved' : 'decide.doneRejected', params: { number: row.number ?? '' } }
        }
        key.current = null
        if (receipt) done.current(receipt)
        else setDecide((value) => (value ? { ...value, busy: false } : value))
      } catch (error) {
        const refused = writeProblem(error)
        key.current = null
        setDecide((value) => (value ? { ...value, busy: false, notice: { ...refused, tone: 'danger' } } : value))
        if (refused.stale) void open(row.id, row, now.ids)
      }
    },
    [api, open],
  )

  return { decide, setDecide, open, submit }
}
