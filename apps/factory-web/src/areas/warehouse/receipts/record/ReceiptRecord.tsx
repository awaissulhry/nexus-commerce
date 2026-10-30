'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { downloadText, useCoalesced, useLive, useThreadDock } from '../../../_shared/buying/hooks'
import { buyingCan, csvOf, part, PART_LOADING, phrase, readProblem, writeProblem, type Loaded, type Part, type Phrase } from '../../../_shared/buying/model'
import { getReceipt, receiptLots, reverseReceipt, type LotWithHides, type Receipt } from '../api'
import { receiptTabOf, type ReceiptRecordModel } from '../model'
import { ReceiptRecordView } from './view/ReceiptRecordView'

const TIME_ZONE = 'Europe/Rome'

/**
 * `/w/<company>/warehouse/receipts/<id>` (SCR-063; `?tab=lines|lots|activity`): loads the receipt (inventory.stock.view;
 * values with the cost grain) and its lots with every hide, and reverses it (inventory.reverse) with the receipt's
 * version as read and one Idempotency-Key per dialog. Live: inventory.receipt_* events of this receipt read it again.
 */
export function ReceiptRecord({ receiptId }: { receiptId: string }) {
  return (
    <WithMessages namespaces={['buying', 'lists', 'records']}>
      <RecordContainer receiptId={receiptId} />
    </WithMessages>
  )
}

function RecordContainer({ receiptId }: { receiptId: string }) {
  const t = useT('buying')
  const api = useOfficeApi()
  const session = useOfficeSession()
  const pathname = usePathname()
  const params = useSearchParams()
  const tab = receiptTabOf(params?.get('tab'))
  const prefix = pathname.replace(/\/warehouse\/receipts\/[^/]+\/?$/, '')
  const can = useMemo(() => buyingCan(session.permissions), [session.permissions])

  const [receipt, setReceipt] = useState<Loaded<Receipt>>({ status: 'loading' })
  const [lots, setLots] = useState<Part<LotWithHides[]>>(PART_LOADING)
  const [dialog, setDialog] = useState<ReceiptRecordModel['dialog']>(null)
  const dialogRef = useRef(dialog)
  dialogRef.current = dialog
  const [dialogProblem, setDialogProblem] = useState<Phrase | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<ReceiptRecordModel['notice']>(null)
  const [changed, setChanged] = useState<{ at: string } | null>(null)
  const reverseKey = useRef(newIdempotencyKey())
  const { dockOpen, toggleDock } = useThreadDock('GoodsReceipt')

  const loadLots = useCallback(() => {
    receiptLots(api, receiptId)
      .then((value) => setLots(part(value)))
      .catch((error: unknown) => setLots({ value: null, problem: readProblem(error) }))
  }, [api, receiptId])

  const load = useCallback(async () => {
    try {
      setReceipt({ status: 'ready', value: await getReceipt(api, receiptId) })
      setChanged(null)
      loadLots()
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setReceipt({ status: 'not_found' })
      else if (isApiError(error) && error.kind === 'forbidden') setReceipt({ status: 'forbidden' })
      else setReceipt({ status: 'error', problem: readProblem(error) })
    }
  }, [api, receiptId, loadLots])

  useEffect(() => {
    void load()
  }, [load])

  const reread = useCoalesced(() => void load(), 700)
  const live = useLive(
    (change) => {
      if (change.fields.receiptId !== receiptId) return
      if (dialogRef.current) setChanged({ at: new Date().toISOString() })
      else reread()
    },
    () => void load(),
  )

  const reverse = useCallback(async () => {
    if (receipt.status !== 'ready' || dialog?.kind !== 'reverse' || busy) return
    setBusy(true)
    setDialogProblem(null)
    try {
      const answer = await reverseReceipt(api, receiptId, receipt.value.version, dialog.reason.trim(), reverseKey.current)
      setReceipt({ status: 'ready', value: answer.receipt })
      setDialog(null)
      setNotice({ tone: 'success', words: phrase('rc.notice.reversed', { number: answer.receipt.number }) })
      loadLots()
    } catch (error) {
      setDialogProblem(writeProblem(error, (paths, info) => (paths.some((path) => path.startsWith('blockers/')) ? phrase('rc.reverse.used') : info.kind === 'conflict' ? phrase('rc.reverse.changed') : null)))
      reverseKey.current = newIdempotencyKey()
      if (isApiError(error) && error.kind === 'conflict') void load()
    } finally {
      setBusy(false)
    }
  }, [api, busy, dialog, load, loadLots, receipt, receiptId])

  const exportHides = useCallback(
    (ids: string[]) => {
      const hides = (lots.value ?? []).flatMap((lot) => lot.hides.filter((hide) => ids.includes(hide.id)).map((hide) => ({ lot, hide })))
      const header = ['tag', 'lot', 'tannery', 'area', 'unit', 'baseArea', 'grade', 'thickness', 'shade', 'defects', 'state', 'onHand'].map((column) => t(`rc.csv.hide.${column}`))
      const rows = hides.map(({ lot, hide }) => [hide.code, lot.code, hide.supplierCode ?? '', hide.area, hide.areaUom, hide.baseArea, hide.grade ?? '', hide.thicknessMm ?? '', hide.shade ?? '', hide.defects ?? '', t(`rc.hideState.${hide.state}`), hide.onHand])
      downloadText(`hides-${receipt.status === 'ready' ? receipt.value.number : receiptId}.csv`, csvOf(header, rows))
    },
    [lots.value, receipt, receiptId, t],
  )

  const model: ReceiptRecordModel = { prefix, can, tab, receipt, lots, live, dockOpen, changed, notice, notes: null, busy, dialog, dialogProblem, timeZone: TIME_ZONE }
  const value = receipt.status === 'ready' ? receipt.value : null

  return (
    <ReceiptRecordView
      model={model}
      panels={value && (tab === 'activity' || dockOpen) ? <RecordPanels record={{ type: 'GoodsReceipt', id: value.id, companyId: value.companyId, siteId: value.siteId }} title={`${value.number} · ${value.supplier.name}`} /> : null}
      actions={{
        onRetry: () => void load(),
        onReload: () => void load(),
        onDock: toggleDock,
        onDialog: (next) => {
          setDialogProblem(null)
          if (next && !dialogRef.current) reverseKey.current = newIdempotencyKey()
          setDialog(next)
        },
        onReverse: () => void reverse(),
        onDismissNotice: () => setNotice(null),
        onRetryLots: loadLots,
        onExportHides: exportHides,
      }}
    />
  )
}
