'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { MenuItemDef } from '@nexus/ui/components'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { readProblem, writeProblem, type Phrase } from '../../../_shared/buying/model'
import type { Receipt } from '../api'
import { askBuyer, getReport, getUnplanned, nameOrder, reserveFromReport, sendBack, sendReport, type Unplanned } from './api'
import { defaultChoice, namingBody, namingFor, reportProblem, reserveBody, serveRows, suggestedOrder, waitingProblem } from './model'
import { ReceptionDialog, type ReceptionDialogModel } from './view/ReceptionDialog'
import { WaitingBanner, WaitingDialogs, type WaitingDialog } from './view/WaitingPanel'

/**
 * The receipt record's W2b-5 depth (B-W2b-300; SCM-119, SCM-122): what SCR-063's record mounts in its own lines — an item in the
 * receipt's ⋯ ("Reception report…", a posted receipt of an order), the banner of goods without a PO while they wait (or what
 * became of them), and the dialogs. Each write sends ONE Idempotency-Key per dialog; a refusal is said in our words by its path.
 * The words are the `warehouse-receiving-depth` catalogue (the record's WithMessages loads it).
 */

export interface ReceiptDepthSlot {
  readonly more: readonly MenuItemDef[]
  readonly banner: ReactNode
  readonly dialogs: ReactNode
}

export interface ReceiptDepthInput {
  readonly api: ApiClient
  readonly receipt: Receipt | null
  readonly prefix: string
  readonly timeZone: string
  /** The words of the ⋯ item (the record's translator over this catalogue). */
  readonly label: string
  /** The receipt changed (named, sent back): the record reads it again. */
  readonly onChanged: () => void
}

const EMPTY_REPORT: Omit<ReceptionDialogModel, 'timeZone'> = { report: { status: 'loading' }, chosen: [], tellBuyer: true, note: '', busy: false, problem: null, done: null }

export function useReceiptDepth({ api, receipt, prefix, timeZone, label, onChanged }: ReceiptDepthInput): ReceiptDepthSlot {
  // ---- the reception report ----
  const [open, setOpen] = useState(false)
  const [report, setReport] = useState(EMPTY_REPORT)
  const reportKey = useRef(newIdempotencyKey())
  const receiptId = receipt?.id ?? null

  const loadReport = useCallback(
    (keepChoice = false) => {
      if (!receiptId) return
      getReport(api, receiptId)
        .then((value) => setReport((current) => ({ ...current, report: { status: 'ready', value }, chosen: keepChoice ? current.chosen : defaultChoice(serveRows(value)), tellBuyer: value.can.send })))
        .catch((error: unknown) => setReport((current) => ({ ...current, report: { status: 'error', problem: `reception.problem.${readProblem(error).replace('problem.', '')}` } })))
    },
    [api, receiptId],
  )

  const openReport = () => {
    reportKey.current = newIdempotencyKey()
    setReport(EMPTY_REPORT)
    setOpen(true)
    loadReport()
  }

  const reserve = async () => {
    if (!receiptId || report.report.status !== 'ready' || report.busy) return
    setReport((current) => ({ ...current, busy: true, problem: null, done: null }))
    try {
      const answer = await reserveFromReport(api, receiptId, reserveBody(serveRows(report.report.value), report.chosen, report.tellBuyer && report.report.value.can.send, report.note), reportKey.current)
      reportKey.current = newIdempotencyKey()
      setReport((current) => ({ ...current, busy: false, note: '', done: { reserved: answer.reservationIds.length, skipped: answer.skipped.length, told: answer.sent ? answer.sent.buyerTold : null } }))
      loadReport()
    } catch (error) {
      setReport((current) => ({ ...current, busy: false, problem: writeProblem(error, reportProblem) }))
    }
  }

  const send = async () => {
    if (!receiptId || report.busy) return
    setReport((current) => ({ ...current, busy: true, problem: null, done: null }))
    try {
      const answer = await sendReport(api, receiptId, { note: report.note.trim() || null }, reportKey.current)
      reportKey.current = newIdempotencyKey()
      setReport((current) => ({ ...current, busy: false, note: '', done: { reserved: 0, skipped: 0, told: answer.buyerTold } }))
    } catch (error) {
      setReport((current) => ({ ...current, busy: false, problem: writeProblem(error, reportProblem) }))
    }
  }

  // ---- goods without a PO ----
  const [unplanned, setUnplanned] = useState<Unplanned | null>(null)
  const [dialog, setDialog] = useState<WaitingDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Phrase | null>(null)
  const waitingKey = useRef(newIdempotencyKey())
  // Only a receipt without an order may be goods without one (a customer's goods have none either: the API says 404); once
  // found, it is read again after its order is named (the banner says what became of it).
  const known = useRef<string | null>(null)
  const maybe = Boolean(receipt && (receipt.purchaseOrder === null || known.current === receipt.id))
  const version = receipt ? `${receipt.status}` : ''

  const loadUnplanned = useCallback(() => {
    if (!receiptId || !maybe) return setUnplanned(null)
    getUnplanned(api, receiptId)
      .then((value) => {
        known.current = value.receipt.id
        setUnplanned(value)
      })
      .catch((error: unknown) => {
        if (isApiError(error) && error.kind === 'not_found') setUnplanned(null)
      })
  }, [api, receiptId, maybe])

  useEffect(() => {
    loadUnplanned()
  }, [loadUnplanned, version])

  const write = async (run: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setProblem(null)
    try {
      await run()
      waitingKey.current = newIdempotencyKey()
      setDialog(null)
      onChanged()
      loadUnplanned()
    } catch (error) {
      setProblem(writeProblem(error, (paths, found) => waitingProblem(paths, found)))
    } finally {
      setBusy(false)
    }
  }

  const waitingActions = {
    onDialog: (next: WaitingDialog | null) => {
      setProblem(null)
      if (next && (!dialog || dialog.kind !== next.kind)) waitingKey.current = newIdempotencyKey()
      setDialog(next && next.kind === 'name' && next.draft.orderId === null && unplanned ? { kind: 'name', draft: namingFor(unplanned, suggestedOrder(unplanned)) } : next)
    },
    onName: () => {
      if (!unplanned || dialog?.kind !== 'name') return
      void write(() => nameOrder(api, unplanned.receipt.id, namingBody(unplanned, dialog.draft), waitingKey.current))
    },
    onSendBack: () => {
      if (!unplanned || dialog?.kind !== 'back') return
      void write(() => sendBack(api, unplanned.receipt.id, { version: unplanned.receipt.version, reason: dialog.reason.trim() }, waitingKey.current))
    },
    onAskBuyer: () => {
      if (!unplanned) return
      void write(() => askBuyer(api, unplanned.receipt.id, { version: unplanned.receipt.version }, waitingKey.current))
    },
  }

  const waitingModel = unplanned ? { unplanned, dialog, busy, problem, prefix, timeZone } : null
  const reportable = receipt?.status === 'POSTED' && receipt.purchaseOrder !== null
  return {
    more: reportable ? [{ id: 'reception', label, onSelect: openReport }] : [],
    banner: waitingModel ? <WaitingBanner model={waitingModel} actions={waitingActions} /> : null,
    dialogs: (
      <>
        {open && receipt ? (
          <ReceptionDialog
            number={receipt.number}
            model={{ ...report, timeZone }}
            actions={{
              onClose: () => setOpen(false),
              onChoose: (ids) => setReport((current) => ({ ...current, chosen: ids })),
              onTellBuyer: (on) => setReport((current) => ({ ...current, tellBuyer: on })),
              onNote: (text) => setReport((current) => ({ ...current, note: text })),
              onReserve: () => void reserve(),
              onSend: () => void send(),
              onRetry: () => loadReport(true),
            }}
          />
        ) : null}
        {waitingModel ? <WaitingDialogs model={waitingModel} actions={waitingActions} /> : null}
      </>
    ),
  }
}

