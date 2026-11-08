'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../../lib/api/errors'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { useCoalesced, useLive } from '../../../_shared/hooks'
import { loading, phrase, readProblem, type Part } from '../../model'
import {
  allocateRolls,
  cancelCutOrder,
  getCutOrder,
  getReconciliation,
  labelPrinters,
  printTicket,
  reconcileCutOrder,
  releaseCutOrder,
  removeLayRoll,
  rollCandidates,
  unreleaseCutOrder,
  voidTicket,
  type CutOrderRecord as Record_,
  type PrintAnswer,
  type Printer,
  type Reconciliation,
  type RollCandidates,
} from '../api'
import { NO_RECONCILE, orderProblem, ordersCanOf, orderTabOf, reconcileBody, type ReconcileDraft } from '../model'
import { CutOrderRecordView, type CutOrderRecordModel, type OrderDialog } from './view/CutOrderRecordView'

const TIME_ZONE = 'Europe/Rome'
const LIVE_TYPES = /^(cut_order|cut_ticket|ply_run|lay|cut_consumption)\./

/**
 * `/w/<company>/production/cutting/orders/<id>` (SCR-238-order; `?tab=lay|pieces|yield|tickets`): the cut order and its
 * reconciliation (ordered, cut and recut; the fabric per lay), each read on its own (a part that fails says so with Try again),
 * live cut order, ticket, lay and fabric-used events of this cut order, and the writes — Release, Back to planning, Cancel,
 * Allocate rolls and Remove, Print (or show) and Void tickets, Reconcile cut — each one command with its Idempotency-Key (kept for
 * a retry of the same write), at the version the screen read; a refusal in our words.
 */
export function CutOrderRecord({ cutOrderId }: { cutOrderId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/production\/cutting\/orders\/[^/]+\/?$/, '')
  const can = useMemo(() => ordersCanOf(session.permissions), [session.permissions])
  const tab = orderTabOf(params?.get('tab'))

  const [record, setRecord] = useState<CutOrderRecordModel['record']>({ status: 'loading', value: null, problem: null })
  const [recon, setRecon] = useState<Part<Reconciliation>>(loading())
  const [candidates, setCandidates] = useState<Part<RollCandidates>>(loading())
  const [printers, setPrinters] = useState<Part<readonly Printer[]>>(loading())
  const [dialog, setDialog] = useState<OrderDialog | null>(null)
  const [reconcile, setReconcile] = useState<ReconcileDraft>(NO_RECONCILE)
  const [shown, setShown] = useState<PrintAnswer | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<CutOrderRecordModel['problem']>(null)
  const [notice, setNotice] = useState<CutOrderRecordModel['notice']>(null)
  const writeKey = useRef<string | null>(null)

  const readRecon = useCallback(() => {
    getReconciliation(api, cutOrderId)
      .then((value) => setRecon({ value, problem: null }))
      .catch((error: unknown) => setRecon({ value: null, problem: readProblem(error) }))
  }, [api, cutOrderId])

  const load = useCallback(async () => {
    if (!can.view) return
    try {
      const value = await getCutOrder(api, cutOrderId)
      setRecord({ status: 'ready', value, problem: null })
      readRecon()
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setRecord({ status: 'missing', value: null, problem: null })
      else if (isApiError(error) && (error.kind === 'forbidden' || error.kind === 'step_up')) setRecord({ status: 'forbidden', value: null, problem: null })
      else setRecord({ status: 'error', value: null, problem: readProblem(error) })
    }
  }, [api, cutOrderId, can.view, readRecon])

  useEffect(() => {
    void load()
  }, [load])

  const reread = useCoalesced(() => void load(), 800)
  const live = useLive(
    (change) => {
      if (LIVE_TYPES.test(change.type) && change.fields.cutOrderId === cutOrderId) reread()
    },
    () => void load(),
    can.view,
  )

  const readCandidates = useCallback(() => {
    setCandidates(loading())
    rollCandidates(api, cutOrderId)
      .then((value) => setCandidates({ value, problem: null }))
      .catch((error: unknown) => setCandidates({ value: null, problem: readProblem(error) }))
  }, [api, cutOrderId])

  const readPrinters = useCallback(() => {
    const siteId = record.value?.cutOrder.siteId
    if (!siteId) return
    if (!can.print) {
      setPrinters({ value: [], problem: null })
      return
    }
    setPrinters(loading())
    labelPrinters(api, siteId)
      .then((value) => setPrinters({ value, problem: null }))
      .catch((error: unknown) => setPrinters({ value: null, problem: readProblem(error) }))
  }, [api, record.value?.cutOrder.siteId, can.print])

  const openDialog = useCallback(
    (next: OrderDialog | null) => {
      writeKey.current = next ? newIdempotencyKey() : null
      setProblem(null)
      setDialog(next)
      if (next?.kind === 'rolls') readCandidates()
      if (next?.kind === 'print') readPrinters()
      if (next?.kind === 'reconcile') {
        setReconcile(NO_RECONCILE)
        readRecon()
      }
    },
    [readCandidates, readPrinters, readRecon],
  )

  /** One write: the dialog's key (kept for a retry of the same write), the record read again, a notice. */
  const write = useCallback(
    async <T,>(run: (key: string) => Promise<T>, done: (answer: T) => CutOrderRecordModel['notice'], options: { keepDialog?: boolean } = {}) => {
      const key = writeKey.current ?? newIdempotencyKey()
      writeKey.current = key
      setBusy(true)
      setProblem(null)
      try {
        const answer = await run(key)
        writeKey.current = options.keepDialog ? newIdempotencyKey() : null
        if (!options.keepDialog) setDialog(null)
        setNotice(done(answer))
        void load()
        return answer
      } catch (error) {
        writeKey.current = newIdempotencyKey()
        setProblem(orderProblem(error))
        return null
      } finally {
        setBusy(false)
      }
    },
    [load],
  )

  const value: Record_ | null = record.value
  const model: CutOrderRecordModel = { prefix, can, tab, timeZone: TIME_ZONE, record, recon, live, dialog, candidates, printers, reconcile, shown, busy, problem, notice }

  return (
    <CutOrderRecordView
      model={model}
      actions={{
        onRetry: () => void load(),
        onRetryPart: (part) => (part === 'recon' ? readRecon() : part === 'candidates' ? readCandidates() : readPrinters()),
        onDialog: openDialog,
        onRelease: () => {
          if (!value) return
          writeKey.current = newIdempotencyKey()
          void write((key) => releaseCutOrder(api, value.cutOrder.id, value.cutOrder.version, key), (answer) => ({ tone: 'success', words: phrase('notice.released', { number: answer.cutOrder.number, count: answer.tickets.filter((ticket) => ticket.status === 'OPEN').length }) }))
        },
        onBack: (reason) => value && void write((key) => unreleaseCutOrder(api, value.cutOrder.id, { version: value.cutOrder.version, reason }, key), (answer) => ({ tone: 'success', words: phrase('notice.back', { number: answer.cutOrder.number }) })),
        onCancel: (reason) => value && void write((key) => cancelCutOrder(api, value.cutOrder.id, { version: value.cutOrder.version, reason }, key), (answer) => ({ tone: 'success', words: phrase('notice.cancelled', { number: answer.cutOrder.number }) })),
        onAllocate: (layId, rolls) => {
          const lay = value?.lays.find((row) => row.id === layId)
          if (!value || !lay) return
          void write(
            (key) => allocateRolls(api, value.cutOrder.id, layId, { version: lay.version, rolls }, key),
            () => ({ tone: 'success', words: phrase('notice.allocated', { count: rolls.length, seq: lay.seq, plies: rolls.reduce((sum, roll) => sum + roll.plies, 0) }) }),
          )
        },
        onRemoveRoll: (layId, layRollId) => {
          const lay = value?.lays.find((row) => row.id === layId)
          const roll = lay?.rolls.find((row) => row.id === layRollId)
          if (!value || !lay || !roll) return
          writeKey.current = newIdempotencyKey()
          void write(
            (key) => removeLayRoll(api, value.cutOrder.id, layId, layRollId, lay.version, key),
            () => ({ tone: 'success', words: phrase('notice.removed', { code: roll.code, seq: lay.seq }) }),
            { keepDialog: true },
          ).then((answer) => answer && readCandidates())
        },
        onPrint: (ticketIds, printerId, language) => {
          void (async () => {
            setBusy(true)
            setProblem(null)
            let printed = 0
            let last: PrintAnswer | null = null
            try {
              // One after the other: one print job (and one key) each.
              for (const ticketId of ticketIds) {
                last = await printTicket(api, ticketId, { ...(printerId !== undefined ? { printerId } : {}), language }, newIdempotencyKey())
                if (last.job) printed += 1
              }
              setDialog(null)
              if (printerId === null && last) {
                setShown(last)
                setNotice(null)
              } else {
                setNotice(printed === ticketIds.length ? { tone: 'success', words: phrase('notice.printed', { count: printed }) } : { tone: 'warning', words: phrase('notice.notPrinted', { count: ticketIds.length - printed }) })
                if (printed < ticketIds.length && last) setShown(last)
              }
              void load()
            } catch (error) {
              setProblem(orderProblem(error))
            } finally {
              setBusy(false)
            }
          })()
        },
        onVoid: (ticketId, reason, replace) => {
          const ticket = value?.tickets.find((row) => row.id === ticketId)
          if (!ticket) return
          void write(
            (key) => voidTicket(api, ticketId, { version: ticket.version, reason, replace }, key),
            (answer) => ({ tone: 'success', words: answer.replacement ? phrase('notice.voidedReplaced', { number: answer.voided.number, replacement: answer.replacement.number }) : phrase('notice.voided', { number: answer.voided.number }) }),
          )
        },
        onReconcileDraft: setReconcile,
        onReconcile: () => {
          const current = recon.value
          if (!current) return
          void write(
            (key) => reconcileCutOrder(api, current.cutOrder.id, reconcileBody(current, reconcile), key),
            (answer) => {
              setRecon({ value: answer, problem: null })
              return { tone: 'success', words: phrase('notice.reconciled', { number: answer.cutOrder.number, ordered: answer.garments.ordered, cut: answer.garments.cut }) }
            },
          )
        },
        onDismissNotice: () => setNotice(null),
        onDismissShown: () => setShown(null),
      }}
    />
  )
}
