'use client'

import { useCallback, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { pickerReasons } from '../../../_shared/reasons/api'
import { addWriteOffPhoto, postWriteOff, raiseNcr } from './api'
import type { WriteOffActions, WriteOffDialogModel, WriteOffDone } from './dialog-model'
import { blankWriteOff, writeOffHeld, writeOffLines, writeOffProblem, type WriteOffTarget } from './model'

export interface WriteOffAbilities {
  withCost: boolean
  canPhoto: boolean
  canNcr: boolean
  prefix: string
}

/**
 * The Write off / Scrap N hides dialog's container part (Movements and Hides share it): opens on a target, reads the
 * tenant's WRITE_OFF reasons (`GET /reasons?list=WRITE_OFF`), posts the write-off with ONE Idempotency-Key per dialog
 * (a retry of the same dialog is the same write-off), then — the write-off being its record — sends the photo and raises
 * the NCR when asked, each with its own retry. `onDone` runs once the write-off is posted (the page reads again).
 */
export function useWriteOff(api: ApiClient, abilities: WriteOffAbilities, onDone: () => void) {
  const [model, setModel] = useState<WriteOffDialogModel | null>(null)
  const key = useRef<string | null>(null)
  const ncrKey = useRef<string | null>(null)
  const latest = useRef(model)
  latest.current = model

  const open = useCallback(
    (target: WriteOffTarget) => {
      key.current = newIdempotencyKey()
      ncrKey.current = newIdempotencyKey()
      const canNcr = abilities.canNcr && (target.kind === 'hides' || target.lot !== null)
      setModel({ target, draft: blankWriteOff(), reasons: { value: null, problem: null }, withCost: abilities.withCost, canPhoto: abilities.canPhoto, canNcr, posting: false, problem: null, done: null, prefix: abilities.prefix })
      pickerReasons(api, ['WRITE_OFF'])
        .then((reasons) => setModel((current) => (current ? { ...current, reasons: { value: reasons, problem: null } } : current)))
        .catch(() => setModel((current) => (current ? { ...current, reasons: { value: null, problem: 'problem.read' } } : current)))
    },
    [api, abilities.canNcr, abilities.canPhoto, abilities.withCost, abilities.prefix],
  )

  const patchDone = (patch: Partial<WriteOffDone>) => setModel((current) => (current?.done ? { ...current, done: { ...current.done, ...patch } } : current))

  const sendPhoto = useCallback(
    async (writeOffId: string, photo: NonNullable<WriteOffDialogModel['draft']['photo']>) => {
      patchDone({ photo: 'sending' })
      try {
        const blob = photo.marked ?? photo.photo
        await addWriteOffPhoto(api, writeOffId, { name: 'write-off.jpg', type: blob.type || 'image/jpeg', size: blob.size, bytes: await blob.arrayBuffer() })
        patchDone({ photo: 'sent' })
      } catch {
        patchDone({ photo: 'failed' })
      }
    },
    [api],
  )

  const sendNcr = useCallback(
    async (target: WriteOffTarget, note: string, severity: WriteOffDialogModel['draft']['ncrSeverity']) => {
      // One hide: raised from it; hides of one lot: from the lot; hides of several lots: from the first hide (named gap).
      const lots = target.kind === 'hides' ? [...new Set(target.hides.map((hide) => hide.lotId))] : []
      const from =
        target.kind === 'hides'
          ? target.hides.length === 1 || lots.length !== 1
            ? target.hides[0]
              ? { recordType: 'Hide' as const, recordId: target.hides[0].id }
              : null
            : { recordType: 'Lot' as const, recordId: lots[0]! }
          : target.lot
            ? { recordType: 'Lot' as const, recordId: target.lot.id }
            : null
      if (!from || !ncrKey.current || !severity) return
      patchDone({ ncr: { state: 'sending', id: null, number: null } })
      try {
        const answer = await raiseNcr(api, from, severity, note.trim() || null, ncrKey.current)
        patchDone({ ncr: { state: 'sent', id: answer.record.ncr.id, number: answer.record.ncr.number ?? null } })
      } catch {
        patchDone({ ncr: { state: 'failed', id: null, number: null } })
      }
    },
    [api],
  )

  const actions: WriteOffActions = {
    onChange: (draft) => setModel((current) => (current ? { ...current, draft, problem: null } : current)),
    onClose: () => setModel(null),
    onPost: () => {
      const current = latest.current
      if (!current || current.posting || current.done || !key.current || !current.reasons.value) return
      if (writeOffHeld(current.target, current.draft, current.reasons.value, false)) return
      setModel({ ...current, posting: true, problem: null })
      const { target, draft } = current
      postWriteOff(api, { siteId: target.siteId, reasonCode: draft.reasonCode, note: draft.note, reference: draft.reference, lines: writeOffLines(target, draft) }, key.current)
        .then((answer) => {
          const first = answer.writeOff.values?.byCurrency[0]
          const done: WriteOffDone = {
            writeOffId: answer.writeOff.id,
            moves: answer.writeOff.moves.length,
            value: first && answer.writeOff.values?.byCurrency.length === 1 ? { amount: first.amount, currency: first.currency } : null,
            photo: null,
            ncr: null,
            overReserved: answer.overReserved.length,
          }
          setModel((now) => (now ? { ...now, posting: false, done } : now))
          onDone()
          if (draft.photo) void sendPhoto(answer.writeOff.id, draft.photo)
          if (draft.openNcr && current.canNcr) void sendNcr(target, draft.note, draft.ncrSeverity)
        })
        .catch((error: unknown) => setModel((now) => (now ? { ...now, posting: false, problem: writeOffProblem(error) } : now)))
    },
    onRetryPhoto: () => {
      const current = latest.current
      if (current?.done && current.draft.photo) void sendPhoto(current.done.writeOffId, current.draft.photo)
    },
    onRetryNcr: () => {
      const current = latest.current
      if (current?.done) void sendNcr(current.target, current.draft.note, current.draft.ncrSeverity)
    },
  }
  return { model, open, actions }
}
