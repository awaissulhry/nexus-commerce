'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { pickerReasons, type PickerReason } from '../../../_shared/reasons/api'
import { downloadText, useCoalesced, useLive, useThreadDock } from '../../../_shared/buying/hooks'
import { buyingCan, csvOf, part, PART_LOADING, phrase, readProblem, writeProblem, type Loaded, type Part, type Phrase } from '../../../_shared/buying/model'
import { getReceipt, receiptLots, reverseReceipt, type LotWithHides, type Receipt } from '../api'
import {
  changeDiscrepancy,
  claimFromDiscrepancies,
  listDiscrepancies,
  photoAddress,
  receiptEmails,
  recordDiscrepancy,
  removeDiscrepancy,
  reportCheck,
  reportPreviewBytes,
  requestCheck,
  sendDocumentRequest,
  sendReport,
  settleDiscrepancy,
  uploadDdtPhoto,
  uploadDiscrepancyPhoto,
  type Discrepancy,
} from '../daily-api'
import {
  claimBody,
  claimProblem,
  dailyCan,
  discrepancyBody,
  discrepancyProblem,
  NAMESPACE,
  photoProblem,
  readSay,
  reportBody,
  reportProblem,
  requestBody,
  requestProblem,
  say,
  settleProblem,
  withCheck,
  withRequestCheck,
  type Say,
} from '../daily-model'
import type { DailyDialog, DailyNotice, ReceiptDailyModel } from '../daily-state'
import { receiptTabOf, type ReceiptRecordModel } from '../model'
import { ReceiptRecordView } from './view/ReceiptRecordView'

const TIME_ZONE = 'Europe/Rome'

/**
 * `/w/<company>/warehouse/receipts/<id>` (SCR-063; `?tab=lines|lots|documents|discrepancies|activity`, `?open=<discrepancy>`):
 * loads the receipt (inventory.stock.view; values with the cost grain), its lots with every hide and — B-W2a-63 — its
 * discrepancies and the DISCREPANCY and CLAIM reason lists; reverses it (inventory.reverse); records, changes, settles and
 * removes a discrepancy with its photos, sends the report to the supplier (its check, its PDF in the viewer, then the
 * mail's delivery), makes a claim from discrepancies, photographs the supplier's DDT and asks the supplier for the
 * documents the lots wait for. Every write sends the version read and ONE Idempotency-Key per dialog. Live:
 * inventory.receipt_* events of this receipt read it again (or say "changed" while a dialog is open).
 */
export function ReceiptRecord({ receiptId }: { receiptId: string }) {
  return (
    <WithMessages namespaces={['buying', 'lists', 'records', NAMESPACE, 'photo-kit']}>
      <RecordContainer receiptId={receiptId} />
    </WithMessages>
  )
}

function RecordContainer({ receiptId }: { receiptId: string }) {
  const t = useT('buying')
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const tab = receiptTabOf(params?.get('tab'))
  const openId = params?.get('open') ?? null
  const prefix = pathname.replace(/\/warehouse\/receipts\/[^/]+\/?$/, '')
  const can = useMemo(() => buyingCan(session.permissions), [session.permissions])
  const dCan = useMemo(() => dailyCan(session.permissions), [session.permissions])

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

  // ---- B-W2a-63: the receipt every day ----
  const [discrepancies, setDiscrepancies] = useState<Part<Discrepancy[]>>(PART_LOADING)
  const [reasons, setReasons] = useState<Part<PickerReason[]>>(PART_LOADING)
  const [daily, setDaily] = useState<DailyDialog | null>(null)
  const dailyRef = useRef(daily)
  dailyRef.current = daily
  const [dailyBusy, setDailyBusy] = useState(false)
  const [dailyProblem, setDailyProblem] = useState<Say | null>(null)
  const [dailyNotice, setDailyNotice] = useState<DailyNotice | null>(null)
  const [photos, setPhotos] = useState<Record<string, string | null>>({})
  const asked = useRef(new Set<string>())
  const [ddtStep, setDdtStep] = useState(false)
  const [uploading, setUploading] = useState(false)
  const dailyKey = useRef(newIdempotencyKey())

  const loadLots = useCallback(() => {
    receiptLots(api, receiptId)
      .then((value) => setLots(part(value)))
      .catch((error: unknown) => setLots({ value: null, problem: readProblem(error) }))
  }, [api, receiptId])

  const loadDiscrepancies = useCallback(() => {
    listDiscrepancies(api, receiptId)
      .then((answer) => setDiscrepancies(part(answer.discrepancies)))
      .catch((error: unknown) => setDiscrepancies({ value: null, problem: readSay(error) }))
  }, [api, receiptId])

  const reloadReceipt = useCallback(async () => {
    try {
      setReceipt({ status: 'ready', value: await getReceipt(api, receiptId) })
    } catch {
      // The record stays as read; the next live change or Reload reads it again.
    }
  }, [api, receiptId])

  const load = useCallback(async () => {
    try {
      setReceipt({ status: 'ready', value: await getReceipt(api, receiptId) })
      setChanged(null)
      loadLots()
      loadDiscrepancies()
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setReceipt({ status: 'not_found' })
      else if (isApiError(error) && error.kind === 'forbidden') setReceipt({ status: 'forbidden' })
      else setReceipt({ status: 'error', problem: readProblem(error) })
    }
  }, [api, receiptId, loadLots, loadDiscrepancies])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    pickerReasons(api, ['DISCREPANCY', 'CLAIM'])
      .then((value) => setReasons(part(value)))
      .catch((error: unknown) => setReasons({ value: null, problem: readSay(error) }))
  }, [api])

  const reread = useCoalesced(() => void load(), 700)
  const live = useLive(
    (change) => {
      if (change.fields.receiptId !== receiptId) return
      if (dialogRef.current || dailyRef.current) setChanged({ at: new Date().toISOString() })
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
      loadDiscrepancies()
    } catch (error) {
      setDialogProblem(writeProblem(error, (paths, info) => (paths.some((path) => path.startsWith('blockers/')) ? phrase('rc.reverse.used') : info.kind === 'conflict' ? phrase('rc.reverse.changed') : null)))
      reverseKey.current = newIdempotencyKey()
      if (isApiError(error) && error.kind === 'conflict') void load()
    } finally {
      setBusy(false)
    }
  }, [api, busy, dialog, load, loadLots, loadDiscrepancies, receipt, receiptId])

  const exportHides = useCallback(
    (ids: string[]) => {
      const hides = (lots.value ?? []).flatMap((lot) => lot.hides.filter((hide) => ids.includes(hide.id)).map((hide) => ({ lot, hide })))
      const header = ['tag', 'lot', 'tannery', 'area', 'unit', 'baseArea', 'grade', 'thickness', 'shade', 'defects', 'state', 'onHand'].map((column) => t(`rc.csv.hide.${column}`))
      const rows = hides.map(({ lot, hide }) => [hide.code, lot.code, hide.supplierCode ?? '', hide.area, hide.areaUom, hide.baseArea, hide.grade ?? '', hide.thicknessMm ?? '', hide.shade ?? '', hide.defects ?? '', t(`rc.hideState.${hide.state}`), hide.onHand])
      downloadText(`hides-${receipt.status === 'ready' ? receipt.value.number : receiptId}.csv`, csvOf(header, rows))
    },
    [lots.value, receipt, receiptId, t],
  )

  // ---- the daily dialogs' reads: the report's check and PDF, the request's contacts and text ----

  const reportIdsKey = daily?.kind === 'report' ? daily.draft.ids.join(',') : null
  const reportChecked = daily?.kind === 'report' ? daily.draft.check.value !== null || daily.draft.check.problem !== null : true
  useEffect(() => {
    if (reportIdsKey === null || reportChecked) return
    const ids = reportIdsKey.split(',').filter(Boolean)
    const controller = new AbortController()
    reportCheck(api, receiptId, ids, controller.signal)
      .then((check) => setDaily((current) => (current?.kind === 'report' ? { kind: 'report', draft: withCheck(current.draft, check) } : current)))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setDaily((current) => (current?.kind === 'report' ? { kind: 'report', draft: { ...current.draft, check: { value: null, problem: readSay(error) } } } : current))
      })
    return () => controller.abort()
  }, [api, receiptId, reportIdsKey, reportChecked])

  const previewKey = daily?.kind === 'report' && daily.draft.check.value && !daily.draft.sent ? `${daily.draft.ids.join(',')}|${daily.draft.language}` : null
  useEffect(() => {
    if (previewKey === null) return
    const [ids, language] = previewKey.split('|') as [string, 'it' | 'en']
    const controller = new AbortController()
    setDaily((current) => (current?.kind === 'report' ? { kind: 'report', draft: { ...current.draft, preview: { src: null, problem: null } } } : current))
    reportPreviewBytes(api, receiptId, ids.split(',').filter(Boolean), language, controller.signal)
      .then((src) => setDaily((current) => (current?.kind === 'report' ? { kind: 'report', draft: { ...current.draft, preview: { src, problem: null } } } : current)))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const problem = isApiError(error) && error.kind === 'conflict' ? 'report.problem.company' : readSay(error)
        setDaily((current) => (current?.kind === 'report' ? { kind: 'report', draft: { ...current.draft, preview: { src: null, problem } } } : current))
      })
    return () => controller.abort()
  }, [api, receiptId, previewKey])

  // After the send: the mail's delivery as the worker moves it (read a few times, then left to the thread).
  const sentEmail = daily?.kind === 'report' ? (daily.draft.sent?.report.emailId ?? null) : null
  useEffect(() => {
    if (!sentEmail) return
    let tries = 0
    const timer = window.setInterval(() => {
      tries += 1
      receiptEmails(api, receiptId)
        .then((emails) => {
          const email = emails.find((entry) => entry.id === sentEmail)
          if (email) setDaily((current) => (current?.kind === 'report' && current.draft.sent?.report.emailId === sentEmail ? { kind: 'report', draft: { ...current.draft, delivery: email.status } } : current))
          if (email && email.status !== 'QUEUED' && email.status !== 'SENDING') window.clearInterval(timer)
        })
        .catch(() => undefined)
      if (tries >= 10) window.clearInterval(timer)
    }, 2500)
    return () => window.clearInterval(timer)
  }, [api, receiptId, sentEmail])

  const value = receipt.status === 'ready' ? receipt.value : null

  // B-W2a-F4: the request's own check (inventory.receipts.documents.request): the documents, the supplier's contacts.
  const requestOpen = daily?.kind === 'request' && daily.draft.check.value === null && daily.draft.check.problem === null
  useEffect(() => {
    if (!requestOpen) return
    const controller = new AbortController()
    requestCheck(api, receiptId, controller.signal)
      .then((check) => setDaily((current) => (current?.kind === 'request' ? { kind: 'request', draft: withRequestCheck(current.draft, check) } : current)))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setDaily((current) => (current?.kind === 'request' ? { kind: 'request', draft: { ...current.draft, check: { value: null, problem: readSay(error) } } } : current))
      })
    return () => controller.abort()
  }, [api, receiptId, requestOpen])

  // ---- the daily writes ----

  const run = useCallback(
    async (work: () => Promise<void>, refused: (error: unknown) => Say) => {
      if (dailyBusy) return
      setDailyBusy(true)
      setDailyProblem(null)
      try {
        await work()
      } catch (error) {
        setDailyProblem(refused(error))
        dailyKey.current = newIdempotencyKey()
        if (isApiError(error) && error.kind === 'conflict') loadDiscrepancies()
      } finally {
        setDailyBusy(false)
      }
    },
    [dailyBusy, loadDiscrepancies],
  )

  const findRow = (id: string) => discrepancies.value?.find((row) => row.id === id) ?? null

  const saveDiscrepancy = () =>
    run(async () => {
      const current = dailyRef.current
      if (current?.kind !== 'discrepancy') return
      const draft = current.draft
      const body = discrepancyBody(draft)
      const saved = draft.id && draft.version !== null ? await changeDiscrepancy(api, receiptId, draft.id, { ...body, version: draft.version }, dailyKey.current) : await recordDiscrepancy(api, receiptId, body, dailyKey.current)
      let failedPhotos = 0
      for (const [index, photo] of draft.photos.entries()) {
        try {
          await uploadDiscrepancyPhoto(api, receiptId, saved.id, photo.blob, photo.name || `${saved.seq}-${index + 1}.jpg`)
        } catch {
          failedPhotos += 1
        }
      }
      setDaily(null)
      setDailyNotice(failedPhotos > 0 ? { tone: 'warning', words: say('notice.savedPhotosFailed', { seq: saved.seq, count: failedPhotos }) } : { tone: 'success', words: say(draft.id ? 'notice.changed' : 'notice.recorded', { seq: saved.seq }) })
      loadDiscrepancies()
      void reloadReceipt()
    }, discrepancyProblem)

  const settle = () =>
    run(async () => {
      const current = dailyRef.current
      if (current?.kind !== 'settle') return
      const row = findRow(current.id)
      if (!row) return
      const saved = await settleDiscrepancy(api, receiptId, row.id, { version: row.version, to: current.to, note: current.note.trim() || null }, dailyKey.current)
      setDaily(null)
      setDailyNotice({ tone: 'success', words: say(`notice.settled.${current.to}`, { seq: saved.seq }) })
      loadDiscrepancies()
      void reloadReceipt()
    }, settleProblem)

  const remove = () =>
    run(async () => {
      const current = dailyRef.current
      if (current?.kind !== 'remove') return
      const row = findRow(current.id)
      if (!row) return
      await removeDiscrepancy(api, receiptId, row.id, row.version, dailyKey.current)
      setDaily(null)
      if (openId === row.id) openDetail(null)
      setDailyNotice({ tone: 'success', words: say('notice.removed', { seq: row.seq }) })
      loadDiscrepancies()
      void reloadReceipt()
    }, discrepancyProblem)

  const sendTheReport = () =>
    run(async () => {
      const current = dailyRef.current
      if (current?.kind !== 'report') return
      const sent = await sendReport(api, receiptId, reportBody(current.draft), dailyKey.current)
      setDaily({ kind: 'report', draft: { ...current.draft, sent, delivery: 'QUEUED' } })
      loadDiscrepancies()
      void reloadReceipt()
    }, reportProblem)

  const claim = () =>
    run(async () => {
      const current = dailyRef.current
      if (current?.kind !== 'claim') return
      const made = await claimFromDiscrepancies(api, claimBody(current.draft), dailyKey.current)
      setDaily(null)
      setDailyNotice({ tone: 'success', words: say('notice.claimMade', { number: made.number }), link: { words: say('notice.openClaim', { number: made.number }), href: `${prefix}/purchasing/claims/${made.id}` } })
      loadDiscrepancies()
    }, claimProblem)

  const request = () =>
    run(async () => {
      const current = dailyRef.current
      if (current?.kind !== 'request' || !current.draft.check.value) return
      const sent = await sendDocumentRequest(api, receiptId, requestBody(current.draft), dailyKey.current)
      setDaily({ kind: 'request', draft: { ...current.draft, sentTo: sent.to } })
    }, requestProblem)

  const openDetail = useCallback(
    (id: string | null) => {
      const query = new URLSearchParams(params?.toString() ?? '')
      if (id) query.set('open', id)
      else query.delete('open')
      const qs = query.toString()
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
    },
    [params, pathname, router],
  )

  const loadPhotos = useCallback(
    (ids: readonly string[]) => {
      for (const id of ids) {
        if (asked.current.has(id)) continue
        asked.current.add(id)
        photoAddress(api, id)
          .then((address) => setPhotos((current) => ({ ...current, [id]: address })))
          .catch(() => setPhotos((current) => ({ ...current, [id]: null })))
      }
    },
    [api],
  )

  const ddtPhoto = async (photo: Blob) => {
    if (!value || uploading) return
    setUploading(true)
    try {
      await uploadDdtPhoto(api, value.id, photo, `${value.number}-ddt.jpg`)
      setDdtStep(false)
      setDailyNotice({ tone: 'success', words: say('notice.ddtPhoto') })
      await reloadReceipt()
    } catch (error) {
      setDailyNotice({ tone: 'danger', words: photoProblem(error) })
    } finally {
      setUploading(false)
    }
  }

  const addPhoto = async (discrepancyId: string, photo: Blob) => {
    if (uploading) return
    setUploading(true)
    setDailyProblem(null)
    try {
      const row = findRow(discrepancyId)
      await uploadDiscrepancyPhoto(api, receiptId, discrepancyId, photo, `${value?.number ?? 'receipt'}-${row?.seq ?? 'd'}.jpg`)
      loadDiscrepancies()
    } catch (error) {
      setDailyProblem(photoProblem(error))
    } finally {
      setUploading(false)
    }
  }

  const dailyModel: ReceiptDailyModel = { can: dCan, discrepancies, reasons, dialog: daily, busy: dailyBusy, problem: dailyProblem, notice: dailyNotice, open: openId, photos, ddtStep, uploading }
  const model: ReceiptRecordModel = { prefix, can, tab, receipt, lots, live, dockOpen, changed, notice, notes: null, busy, dialog, dialogProblem, timeZone: TIME_ZONE, daily: dailyModel }

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
        daily: {
          onDialog: (next) => {
            setDailyProblem(null)
            if (next && (!dailyRef.current || dailyRef.current.kind !== next.kind)) dailyKey.current = newIdempotencyKey()
            setDaily(next)
          },
          onSaveDiscrepancy: () => void saveDiscrepancy(),
          onSettle: () => void settle(),
          onRemove: () => void remove(),
          onSendReport: () => void sendTheReport(),
          onClaim: () => void claim(),
          onRequest: () => void request(),
          onOpen: openDetail,
          onDdtStep: setDdtStep,
          onDdtPhoto: ddtPhoto,
          onAddPhoto: addPhoto,
          onPhotos: loadPhotos,
          onRetry: loadDiscrepancies,
          onDismissNotice: () => setDailyNotice(null),
        },
      }}
    />
  )
}
