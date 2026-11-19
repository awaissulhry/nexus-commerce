'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../../../lib/api/client'
import { useOfficeApi } from '../../../../../../lib/session/context'
import { readyToShip, type ReadyCell } from '../../../../../warehouse/shipments/api'
import type { Order } from '../../../api'
import { previewElsewhere, recordElsewhere, type ElsewherePreview, type ElsewhereRecorded } from './api'
import { changed, elsewhereBody, emptyForm, garmentsOf, liveProblems, recordableCells, refusalOf, waitingForQuality, type ElsewhereForm } from './model'
import { ElsewhereDialog, type ElsewhereDialogModel } from './view/ElsewhereDialog'

/**
 * F-OP-123 (order page N5; 10-order-page §8.5): "Record a shipment made elsewhere…" for ONE order, mounted only while its dialog is
 * open (use-shipments-acts). Reads what quality released of the order and is on no shipment (the Warehouse's ready read), then the
 * API's preview of the recording as the person types (a pause of 400 ms; a later answer wins), and records it in ONE write with its
 * own Idempotency-Key (a new one once anything is typed again). Done shows what was recorded; Done closes and the order reads
 * itself again (`onDone`).
 */
export function RecordElsewhere({ order, prefix, onDone, onClose }: { order: Order; prefix: string; onDone: () => void; onClose: () => void }) {
  const api = useOfficeApi()
  const [form, setForm] = useState<ElsewhereForm>(() => emptyForm(new Date()))
  const [cells, setCells] = useState<ReadyCell[] | 'loading' | 'failed'>('loading')
  const [preview, setPreview] = useState<ElsewherePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<ElsewhereDialogModel['refusal']>(null)
  const [done, setDone] = useState<ElsewhereRecorded | null>(null)
  const key = useRef(newIdempotencyKey())
  const customer = order.party?.legalName ?? order.party?.code ?? '—'

  const readCells = useCallback(() => {
    setCells('loading')
    readyToShip(api, { salesOrderId: order.id })
      .then((orders) => setCells(recordableCells(orders.find((entry) => entry.salesOrderId === order.id)?.cells ?? [])))
      .catch(() => setCells('failed'))
  }, [api, order.id])
  useEffect(() => readCells(), [readCells])

  const list = useMemo(() => (Array.isArray(cells) ? cells : []), [cells])
  const body = useMemo(() => elsewhereBody(order.id, form, list), [order.id, form, list])
  // The preview of what the recording would say, after a pause in typing (nothing is written).
  useEffect(() => {
    if (body.lines.length === 0) return setPreview(null)
    const controller = new AbortController()
    const timer = setTimeout(() => {
      previewElsewhere(api, body, controller.signal)
        .then((answer) => setPreview(answer))
        .catch(() => undefined)
    }, 400)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [api, body])

  const now = new Date()
  const model: ElsewhereDialogModel = {
    order: { id: order.id, number: order.number, customer, waiting: waitingForQuality(order) },
    prefix,
    cells,
    form,
    preview,
    problems: liveProblems(form, list, preview, now),
    busy,
    refusal,
    done,
    now: now.toISOString(),
  }
  return (
    <ElsewhereDialog
      model={model}
      actions={{
        onChange: (next) => {
          key.current = newIdempotencyKey()
          setRefusal(null)
          setForm((current) => changed(current, next, new Date()))
        },
        onRetryCells: readCells,
        onRecord: () => {
          if (busy || garmentsOf(form) === 0) return
          setBusy(true)
          setRefusal(null)
          recordElsewhere(api, body, key.current)
            .then((answer) => setDone(answer))
            .catch((error: unknown) => setRefusal(refusalOf(error, customer)))
            .finally(() => setBusy(false))
        },
        onClose: () => (done ? onDone() : onClose()),
      }}
    />
  )
}
