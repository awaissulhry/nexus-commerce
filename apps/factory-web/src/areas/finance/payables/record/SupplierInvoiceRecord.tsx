'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { downloadLink } from '../../../../record-panels/api'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { storeUrl } from '../../../../record-panels/store'
import { romeToday } from '../../costing/model'
import { useCoalesced, useLive, useThreadDock } from '../../_shared/hooks'
import {
  acceptDifference,
  addLine,
  approveInvoice,
  disputeInvoice,
  getCandidates,
  getInvoice,
  matchAgain,
  patchLine,
  payInvoice,
  removeLine,
  reopenInvoice,
  sendToBuyer,
  voidInvoice,
  withdrawApproval,
  withoutOrder,
  type Candidates,
  type LineFigures,
  type SupplierInvoice,
} from '../api'
import { amountOf, decimalOf, mappingInputOf, payablesCanOf, readProblem, recordTouched, tabOf, writeProblem } from '../model'
import type { LineDraft, Loaded, RecordDialog, SupplierInvoiceModel } from './record-model'
import { SupplierInvoiceView } from './view/SupplierInvoiceView'

/**
 * `/w/<company>/finance/payables/<id>` (SCR-153 record): reads the invoice (payables.view over its company AND supplier;
 * the API answers 404 otherwise) and, while its lines may be mapped and the person may map them, the PO lines and
 * subcontract orders they may bill; does what the view asks, one write at a time, each with the invoice's version as read
 * (a 409 reads it again and says so): a line's mapping saved as soon as it is picked, an invoice without PO, match again,
 * accept a difference in words, send the differences to the buyer, approve, reject with reason (dispute), withdraw,
 * reopen, void a typed one, mark paid, a typed line changed, added or removed; the PDF through the files route. Live:
 * events naming this invoice — or a receipt that may change its match — read it again.
 */
export function SupplierInvoiceRecord({ invoiceId }: { invoiceId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const pathname = usePathname()
  const params = useSearchParams()
  const tab = tabOf(params?.get('tab'))
  const prefix = pathname.replace(/\/finance\/payables\/[^/]+\/?$/, '')
  const can = useMemo(() => payablesCanOf(session.permissions), [session.permissions])

  const [invoice, setInvoice] = useState<Loaded<SupplierInvoice>>({ status: 'loading' })
  const current = useRef<SupplierInvoice | null>(null)
  const [candidates, setCandidates] = useState<SupplierInvoiceModel['candidates']>(null)
  const [savingLine, setSavingLine] = useState<string | null>(null)
  const [lineProblem, setLineProblem] = useState<SupplierInvoiceModel['lineProblem']>(null)
  const [dialog, setDialog] = useState<RecordDialog | null>(null)
  const dialogRef = useRef<RecordDialog | null>(null)
  dialogRef.current = dialog
  const [dialogProblem, setDialogProblem] = useState<SupplierInvoiceModel['dialogProblem']>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<SupplierInvoiceModel['notice']>(null)
  const [changed, setChanged] = useState<{ at: string } | null>(null)
  const { dockOpen, toggleDock } = useThreadDock('SupplierInvoice')
  const key = useRef(newIdempotencyKey())

  const readCandidates = useCallback(
    (value: SupplierInvoice) => {
      const open = value.status === 'RECEIVED' || value.status === 'DISPUTED'
      if (!can.manage || !open) {
        setCandidates(null)
        return
      }
      setCandidates((known) => known ?? { value: null, problem: null })
      getCandidates(api, value.id)
        .then((answer: Candidates) => setCandidates({ value: answer, problem: null }))
        .catch((error: unknown) => setCandidates({ value: null, problem: readProblem(error) }))
    },
    [api, can.manage],
  )

  const setValue = useCallback((next: SupplierInvoice) => {
    current.current = next
    setInvoice({ status: 'ready', value: next })
  }, [])

  const load = useCallback(async () => {
    if (!can.view) return
    try {
      const next = await getInvoice(api, invoiceId)
      setValue(next)
      setChanged(null)
      readCandidates(next)
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setInvoice({ status: 'not_found' })
      else if (isApiError(error) && error.kind === 'forbidden') setInvoice({ status: 'forbidden' })
      else setInvoice({ status: 'error', problem: readProblem(error) })
    }
  }, [api, invoiceId, can.view, setValue, readCandidates])

  useEffect(() => {
    void load()
  }, [load])

  const reread = useCoalesced(() => void load(), 700)
  const live = useLive(
    (change) => {
      if (!recordTouched(change, invoiceId)) return
      const open = dialogRef.current
      if (open && open.kind !== 'withoutOrder' && open.kind !== 'removeLine') setChanged({ at: new Date().toISOString() })
      else reread()
    },
    () => void load(),
    can.view,
  )

  const version = () => current.current?.version ?? 1

  /** One write; the invoice it answers replaces the page's. A refused one keeps the dialog open with its words. */
  const write = useCallback(
    async (run: (idempotencyKey: string) => Promise<SupplierInvoice>, success: SupplierInvoiceModel['notice']) => {
      if (busy) return
      setBusy(true)
      setNotice(null)
      setDialogProblem(null)
      try {
        const next = await run(key.current)
        key.current = newIdempotencyKey()
        setValue(next)
        readCandidates(next)
        setDialog(null)
        if (success) setNotice(success)
      } catch (error) {
        key.current = newIdempotencyKey()
        const problem = writeProblem(error)
        if (dialogRef.current) setDialogProblem(problem.phrases)
        else setNotice({ tone: 'danger', phrases: problem.phrases })
        if (problem.reload) void load()
      } finally {
        setBusy(false)
      }
    },
    [busy, load, readCandidates, setValue],
  )

  const figuresOf = (draft: LineDraft): LineFigures => {
    const rate = draft.vatRate.trim().replace(',', '.')
    return {
      description: draft.description.trim(),
      itemCode: null,
      quantity: draft.quantity.trim() ? decimalOf(draft.quantity, 4) : null,
      uom: draft.uom.trim() || null,
      unitPrice: draft.unitPrice.trim() ? decimalOf(draft.unitPrice, 6) : null,
      netAmount: amountOf(draft.net)!,
      vatRatePct: rate,
      vatNature: Number(rate) === 0 ? draft.vatNature.trim() || null : null,
    }
  }

  const confirm = (open: RecordDialog) => {
    switch (open.kind) {
      case 'approve':
        return void write((k) => approveInvoice(api, invoiceId, version(), open.note.trim() || null, k), { tone: 'success', phrases: [{ key: 'notice.approved' }] })
      case 'accept':
        return void write((k) => acceptDifference(api, invoiceId, open.matchId, version(), open.note.trim(), k), { tone: 'success', phrases: [{ key: 'notice.accepted' }] })
      case 'sendToBuyer':
        return void write(async (k) => {
          const answer = await sendToBuyer(api, invoiceId, version(), open.message.trim() || null, k)
          setNotice({
            tone: answer.notReached.length > 0 ? 'warning' : 'success',
            phrases: [
              { key: 'notice.sentToBuyer', params: { count: answer.mentioned.length } },
              ...(answer.notReached.length > 0 ? [{ key: 'notice.notReached', params: { count: answer.notReached.length } }] : []),
            ],
          })
          return answer.invoice
        }, null)
      case 'dispute':
        return void write((k) => disputeInvoice(api, invoiceId, version(), open.reason.trim(), k), { tone: 'success', phrases: [{ key: 'notice.disputed' }] })
      case 'withdraw':
        return void write((k) => withdrawApproval(api, invoiceId, version(), open.reason.trim(), k), { tone: 'success', phrases: [{ key: 'notice.withdrawn' }] })
      case 'reopen':
        return void write((k) => reopenInvoice(api, invoiceId, version(), open.reason.trim() || null, k), { tone: 'success', phrases: [{ key: 'notice.reopened' }] })
      case 'void':
        return void write((k) => voidInvoice(api, invoiceId, version(), open.reason.trim(), k), { tone: 'success', phrases: [{ key: 'notice.voided' }] })
      case 'pay':
        return void write((k) => payInvoice(api, invoiceId, version(), open.paidOn, open.paymentRef.trim(), k), { tone: 'success', phrases: [{ key: 'notice.paid' }] })
      case 'withoutOrder':
        return void write((k) => withoutOrder(api, invoiceId, version(), k), { tone: 'success', phrases: [{ key: 'notice.withoutOrder' }] })
      case 'removeLine':
        return void write((k) => removeLine(api, invoiceId, open.lineId, version(), k), { tone: 'success', phrases: [{ key: 'notice.lineRemoved' }] })
      case 'line':
        return void write(
          (k) =>
            open.lineId
              ? patchLine(api, invoiceId, open.lineId, { version: version(), ...figuresOf(open.draft) }, k)
              : addLine(api, invoiceId, version(), { kind: 'SERVICE', ...figuresOf(open.draft) }, k),
          { tone: 'success', phrases: [{ key: open.lineId ? 'notice.lineSaved' : 'notice.lineAdded' }] },
        )
    }
  }

  const model: SupplierInvoiceModel = { prefix, can, today: romeToday(), tab, invoice, candidates, savingLine, lineProblem, live, dockOpen, changed, notice, busy, dialog, dialogProblem }
  const value = invoice.status === 'ready' ? invoice.value : null

  return (
    <SupplierInvoiceView
      model={model}
      panels={
        value && (tab === 'activity' || dockOpen) ? (
          <RecordPanels
            record={{ type: 'SupplierInvoice', id: value.id, companyId: value.company.id, siteId: null }}
            title={`${value.number} · ${value.supplier.name}`}
            party={{ id: value.supplier.id, name: value.supplier.name, emails: [] }}
          />
        ) : null
      }
      actions={{
        onRetry: () => void load(),
        onRetryCandidates: () => value && readCandidates(value),
        onReload: () => void load(),
        onDock: toggleDock,
        onDismissNotice: () => setNotice(null),
        onDialog: (next) => {
          setDialog(next)
          setDialogProblem(null)
        },
        onMap: (lineId, picked) => {
          const input = mappingInputOf(picked)
          const line = current.current?.lines.find((entry) => entry.id === lineId)
          if (!input || !line || savingLine) return
          setSavingLine(lineId)
          setLineProblem(null)
          void (async () => {
            try {
              const next = await patchLine(api, invoiceId, lineId, { version: version(), ...input })
              setValue(next)
            } catch (error) {
              const problem = writeProblem(error)
              setLineProblem({ lineId, phrases: problem.phrases })
              if (problem.reload) void load()
            } finally {
              setSavingLine(null)
            }
          })()
        },
        onMatchAgain: () => void write((k) => matchAgain(api, invoiceId, version(), k), { tone: 'success', phrases: [{ key: 'notice.matched' }] }),
        onConfirm: confirm,
        onDownload: (fileId) => {
          void (async () => {
            try {
              const { download } = await downloadLink(api, fileId)
              const anchor = document.createElement('a')
              anchor.href = storeUrl(download.url)
              anchor.rel = 'noopener'
              document.body.appendChild(anchor)
              anchor.click()
              anchor.remove()
            } catch (error) {
              setNotice({ tone: 'danger', phrases: [{ key: readProblem(error) }] })
            }
          })()
        },
      }}
    />
  )
}
