'use client'

import { useCallback, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { pickerReasons } from '../../../_shared/reasons/api'
import { readProblem } from '../../../_shared/stock/model'
import { listReservations, placeHold, previewHold } from './api'
import type { HoldActions, HoldDialogModel, HoldSubjectLine } from './dialog-model'
import { blankHold, demandLabel, holdHeldKey, holdProblem } from './model'

/**
 * The Put on hold dialog's container part (Stock's selection and row ⋯): opens on the lots (or hides) chosen, asks the
 * API what holding them reaches (`POST /quality/holds/preview`: each record's state, the site's quarantine places), reads
 * the HOLD reasons and who reserved the stock (`GET /inventory/reservations?lotId|hideId&status=ACTIVE`), and places the
 * hold with ONE Idempotency-Key per dialog. `onDone` runs once it is placed (the page reads again).
 */
export function useHold(api: ApiClient, onDone: () => void) {
  const [model, setModel] = useState<HoldDialogModel | null>(null)
  const key = useRef<string | null>(null)
  const latest = useRef(model)
  latest.current = model

  const open = useCallback(
    (subjectType: 'Lot' | 'Hide', subjects: HoldSubjectLine[], leftOut = 0) => {
      key.current = newIdempotencyKey()
      setModel({
        subjectType,
        subjects,
        leftOut,
        preview: { value: null, problem: null },
        reservedBy: { value: null, problem: null },
        reasons: { value: null, problem: null },
        draft: blankHold(),
        posting: false,
        problem: null,
        done: null,
      })
      const ids = subjects.map((subject) => subject.id)
      previewHold(api, subjectType, ids)
        .then((value) => setModel((current) => (current ? { ...current, preview: { value, problem: null } } : current)))
        .catch((error: unknown) => setModel((current) => (current ? { ...current, preview: { value: null, problem: readProblem(error) } } : current)))
      pickerReasons(api, ['HOLD'])
        .then((reasons) => setModel((current) => (current ? { ...current, reasons: { value: reasons, problem: null } } : current)))
        .catch((error: unknown) => setModel((current) => (current ? { ...current, reasons: { value: null, problem: readProblem(error) } } : current)))
      Promise.all(ids.map((id) => listReservations(api, { ...(subjectType === 'Lot' ? { lotId: id } : { hideId: id }), status: ['ACTIVE'], limit: 100 })))
        .then((pages) => {
          const numbers = [...new Set(pages.flatMap((page) => page.reservations.filter((row) => !row.stale).map((row) => demandLabel(row.demand))))].sort()
          setModel((current) => (current ? { ...current, reservedBy: { value: numbers, problem: null } } : current))
        })
        .catch((error: unknown) => setModel((current) => (current ? { ...current, reservedBy: { value: null, problem: readProblem(error) } } : current)))
    },
    [api],
  )

  const actions: HoldActions = {
    onChange: (draft) => setModel((current) => (current ? { ...current, draft, problem: null } : current)),
    onClose: () => setModel(null),
    onPlace: () => {
      const current = latest.current
      if (!current || current.posting || current.done || !key.current || !current.reasons.value) return
      if (holdHeldKey(current.draft, current.reasons.value, current.preview.value, false)) return
      setModel({ ...current, posting: true, problem: null })
      placeHold(
        api,
        {
          subjectType: current.subjectType,
          subjectIds: current.subjects.map((subject) => subject.id),
          reasonCode: current.draft.reasonCode,
          reasonNote: current.draft.reasonNote,
          askQuarantine: current.draft.askQuarantine,
          quarantineLocationId: current.draft.askQuarantine ? current.draft.quarantineLocationId : null,
        },
        key.current,
      )
        .then(() => {
          setModel((now) => (now ? { ...now, posting: false, done: { count: now.subjects.length } } : now))
          onDone()
        })
        .catch((error: unknown) => setModel((now) => (now ? { ...now, posting: false, problem: holdProblem(error) } : now)))
    },
  }
  return { model, open, actions }
}
