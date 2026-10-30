'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { readFromStore, storeUrl } from '../../../../record-panels/store'
import { findMaterials, getMaterial } from '../../../_shared/buying/api'
import { todayIn } from '../../../_shared/buying/model'
import { useCoalesced, useLive, useThreadDock } from '../../../_shared/buying/hooks'
import { listLocations, stockOverview } from '../../../_shared/stock/api'
import {
  actOn,
  addKitLines,
  addOperation,
  annulDdt,
  ddtPdfLink,
  editOperation,
  getOrder,
  outsideOperations,
  planKit,
  printDdtAgain,
  receiveBack,
  removeKitLine,
  removeOperation,
  returnKitLine,
  sendKit,
  workOrderBundles,
  workshopStock,
  type SubcontractOrder,
} from '../api'
import { subcontractCan, words, type Words } from '../model'
import {
  addOperationProblem,
  cellKey,
  cellPatch,
  cellProblem,
  kindWords,
  LOADING,
  liveDdt,
  NO_KIT_LINE,
  readWords,
  ready,
  receiveBody,
  receivedWords,
  receiveDraftOf,
  receiveProblem,
  returnProblem,
  sendBody,
  sendDraftOf,
  sendProblem,
  sentWords,
  sizesOf,
  sourcesFor,
  tabOf,
  type CellField,
  type DdtPdf,
  type Loaded,
  type RecordDialog,
  type SaveMark,
  type SubcontractRecordModel,
} from './record-model'
import { RECORD_NAMESPACES, SubcontractRecordView } from './view/SubcontractRecordView'

const TIME_ZONE = 'Europe/Rome'

/**
 * `/w/<company>/purchasing/subcontracting/<id>` (SCR-128 record): reads the order (purchasing.view; fees only with the
 * cost grain) and does what the view asks, one write at a time, each with the order's version as read and an
 * Idempotency-Key (one per dialog or cell save), never optimistically: a 409 reads it again and says so. Live:
 * subcontract_order.* and the kit DDTs' ddt.source_* events of this order read it again; with a dialog open the page
 * says it changed. A dialog's reads (stock to send from, bundles, the workshop's stock, places, the work order's
 * operations, materials) happen when it opens.
 */
export function SubcontractRecord({ orderId }: { orderId: string }) {
  return (
    <WithMessages namespaces={RECORD_NAMESPACES}>
      <RecordContainer orderId={orderId} />
    </WithMessages>
  )
}

function RecordContainer({ orderId }: { orderId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const pathname = usePathname()
  const params = useSearchParams()
  const tab = tabOf(params?.get('tab'))
  const prefix = pathname.replace(/\/purchasing\/subcontracting\/[^/]+(\/.*)?$/, '')
  const can = useMemo(() => subcontractCan(session.permissions), [session.permissions])
  const [order, setOrder] = useState<Loaded<SubcontractOrder>>({ status: 'loading' })
  const current = useRef<SubcontractOrder | null>(null)
  const [dialog, setDialogState] = useState<RecordDialog | null>(null)
  const dialogRef = useRef<RecordDialog | null>(null)
  dialogRef.current = dialog
  const [dialogProblem, setDialogProblem] = useState<Words | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<SubcontractRecordModel['notice']>(null)
  const [changed, setChanged] = useState<{ at: string } | null>(null)
  const [marks, setMarks] = useState<Record<string, SaveMark>>({})
  const [pdf, setPdf] = useState<DdtPdf | null>(null)
  const dialogKey = useRef<string | null>(null)
  const { dockOpen, toggleDock } = useThreadDock('SubcontractOrder')
  const today = todayIn(TIME_ZONE)

  const setDialog = useCallback((next: RecordDialog | null) => {
    // A dialog that opens takes a fresh Idempotency-Key; edits within it keep the same one.
    if (next && (!dialogRef.current || dialogRef.current.kind !== next.kind)) dialogKey.current = newIdempotencyKey()
    if (!next) dialogKey.current = null
    dialogRef.current = next
    setDialogState(next)
  }, [])
  /** Updates the open dialog's draft only while that dialog is still open (a late read never reopens one). */
  const patchDialog = useCallback(<K extends RecordDialog['kind']>(kind: K, update: (open: Extract<RecordDialog, { kind: K }>) => RecordDialog) => {
    const open = dialogRef.current
    if (!open || open.kind !== kind) return
    const next = update(open as Extract<RecordDialog, { kind: K }>)
    dialogRef.current = next
    setDialogState(next)
  }, [])

  const setValue = useCallback((next: SubcontractOrder) => {
    current.current = next
    setOrder({ status: 'ready', value: next })
  }, [])

  const load = useCallback(async () => {
    try {
      const next = await getOrder(api, orderId)
      setValue(next)
      setChanged(null)
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setOrder({ status: 'not_found' })
      else if (isApiError(error) && error.kind === 'forbidden') setOrder({ status: 'forbidden' })
      else setOrder({ status: 'error', problem: readWords(error) })
    }
  }, [api, orderId, setValue])

  useEffect(() => {
    if (can.view) void load()
  }, [load, can.view])

  // Live: this order's events (and its kit DDTs') read it again; a dialog open → "changed · Reload".
  const reread = useCoalesced(() => void load(), 700)
  const live = useLive(
    (change) => {
      const mine = (change.type.startsWith('subcontract_order.') && change.fields.subcontractOrderId === orderId) || (change.type.startsWith('ddt.source_') && change.fields.sourceId === orderId)
      if (!mine) return
      if (dialogRef.current) setChanged({ at: new Date().toISOString() })
      else reread()
    },
    () => void load(),
    can.view,
  )

  const version = () => current.current?.version ?? 1

  /** One write: the order it answers replaces the page's; a refusal is said in the dialog (or the page) in words. */
  const write = useCallback(
    async (run: (key: string) => Promise<SubcontractOrder | null>, success: Words | null, problemOf: (error: unknown) => Words = kindWords) => {
      if (busy) return false
      setBusy(true)
      setNotice(null)
      setDialogProblem(null)
      const key = dialogKey.current ?? newIdempotencyKey()
      try {
        const next = await run(key)
        if (next) setValue(next)
        setDialog(null)
        if (success) setNotice({ tone: 'success', words: success })
        return true
      } catch (error) {
        const said = problemOf(error)
        if (dialogRef.current) setDialogProblem(said)
        else setNotice({ tone: 'danger', words: said })
        if (isApiError(error) && error.kind === 'conflict') {
          // A new key for the next try: the same key would replay the refused write.
          dialogKey.current = newIdempotencyKey()
          void load()
        }
        return false
      } finally {
        setBusy(false)
      }
    },
    [busy, load, setDialog, setValue],
  )

  // ---- the band's acts -------------------------------------------------------------------------------------------------------

  const act = useCallback(
    (name: 'issue' | 'reopen') =>
      void write((key) => actOn(api, orderId, name, version(), {}, key), words(name === 'issue' ? 'notice.issued' : 'notice.reopened')),
    [api, orderId, write],
  )

  const cancel = useCallback(() => {
    const open = dialogRef.current
    if (open?.kind !== 'cancel') return
    void write((key) => actOn(api, orderId, 'cancel', version(), { reason: open.reason.trim() }, key), words('notice.cancelled'))
  }, [api, orderId, write])

  const close = useCallback(() => {
    const open = dialogRef.current
    if (open?.kind !== 'close') return
    void write((key) => actOn(api, orderId, 'close', version(), { note: open.note.trim() || null }, key), words('notice.closed'))
  }, [api, orderId, write])

  // ---- a draft's cells ---------------------------------------------------------------------------------------------------------

  const saveCell = useCallback(
    async (operationId: string, field: CellField, typed: string) => {
      const value = current.current
      const operation = value?.operations.find((entry) => entry.id === operationId)
      if (!value || !operation) return
      const mark = cellKey(operationId, field)
      const { patch, problem } = cellPatch(field, typed, operation)
      if (problem) return setMarks((all) => ({ ...all, [mark]: { state: 'failed', words: problem } }))
      if (!patch) return
      setMarks((all) => ({ ...all, [mark]: { state: 'saving' } }))
      try {
        setValue(await editOperation(api, orderId, operationId, value.version, patch, newIdempotencyKey()))
        setMarks((all) => ({ ...all, [mark]: { state: 'saved' } }))
      } catch (error) {
        setMarks((all) => ({ ...all, [mark]: { state: 'failed', words: cellProblem(error, field) } }))
        if (isApiError(error) && error.kind === 'conflict') void load()
      }
    },
    [api, orderId, load, setValue],
  )

  const openSizes = useCallback(
    (operationId: string) => {
      const value = current.current
      const operation = value?.operations.find((entry) => entry.id === operationId)
      if (!value || !operation) return
      const grid: Record<string, Record<string, number>> = {}
      for (const size of operation.sizes) grid[size.colourway] = { ...(grid[size.colourway] ?? {}), [size.size]: size.pieces }
      setDialogProblem(null)
      setDialog({ kind: 'sizes', draft: { operationId, cells: LOADING, value: grid } })
      outsideOperations(api, value.workOrder.id)
        .then((outside) => patchDialog('sizes', (open) => ({ ...open, draft: { ...open.draft, cells: ready(outside.cells) } })))
        .catch((error: unknown) => patchDialog('sizes', (open) => ({ ...open, draft: { ...open.draft, cells: { value: null, problem: readWords(error) } } })))
    },
    [api, patchDialog, setDialog],
  )

  const saveSizes = useCallback(async () => {
    const open = dialogRef.current
    if (open?.kind !== 'sizes') return
    const { sizes, pieces } = sizesOf(open.draft)
    const mark = cellKey(open.draft.operationId, 'sizes')
    const ok = await write((key) => editOperation(api, orderId, open.draft.operationId, version(), { sizes, pieces }, key), null, (error) => cellProblem(error, 'sizes'))
    if (ok) setMarks((all) => ({ ...all, [mark]: { state: 'saved' } }))
  }, [api, orderId, write])

  const openAddOperation = useCallback(() => {
    const value = current.current
    if (!value) return
    setDialogProblem(null)
    setDialog({ kind: 'addOperation', draft: { outside: LOADING, operationId: '', pieces: '' } })
    outsideOperations(api, value.workOrder.id)
      .then((outside) => patchDialog('addOperation', (open) => ({ ...open, draft: { ...open.draft, outside: ready(outside) } })))
      .catch((error: unknown) => patchDialog('addOperation', (open) => ({ ...open, draft: { ...open.draft, outside: { value: null, problem: readWords(error) } } })))
  }, [api, patchDialog, setDialog])

  const saveAddOperation = useCallback(() => {
    const open = dialogRef.current
    if (open?.kind !== 'addOperation') return
    void write((key) => addOperation(api, orderId, version(), { workOrderOperationId: open.draft.operationId, pieces: Number(open.draft.pieces) }, key), words('notice.operationAdded'), addOperationProblem)
  }, [api, orderId, write])

  const removeOperationNow = useCallback(() => {
    const open = dialogRef.current
    if (open?.kind !== 'removeOperation') return
    void write((key) => removeOperation(api, orderId, open.operationId, version(), key), words('notice.operationRemoved'))
  }, [api, orderId, write])

  // ---- the kit -------------------------------------------------------------------------------------------------------------------

  const searchMaterials = useCallback(
    (text: string) => {
      patchDialog('kitLine', (open) => ({ ...open, draft: { ...open.draft, query: text, materials: null, materialsProblem: null } }))
      findMaterials(api, text)
        .then((materials) => patchDialog('kitLine', (open) => (open.draft.query === text ? { ...open, draft: { ...open.draft, materials } } : open)))
        .catch((error: unknown) => patchDialog('kitLine', (open) => (open.draft.query === text ? { ...open, draft: { ...open.draft, materials: [], materialsProblem: readWords(error) } } : open)))
    },
    [api, patchDialog],
  )

  const openKitLine = useCallback(() => {
    setDialogProblem(null)
    setDialog({ kind: 'kitLine', draft: { ...NO_KIT_LINE } })
    if (can.materials) searchMaterials('')
  }, [can.materials, searchMaterials, setDialog])

  const pickMaterial = useCallback(
    (id: string | null) => {
      if (!id) return patchDialog('kitLine', (open) => ({ ...open, draft: { ...open.draft, material: null, itemColourId: '', uom: '' } }))
      getMaterial(api, id)
        .then((material) => patchDialog('kitLine', (open) => ({ ...open, draft: { ...open.draft, material, itemColourId: '', uom: material.units.base.uom } })))
        .catch((error: unknown) => patchDialog('kitLine', (open) => ({ ...open, draft: { ...open.draft, materialsProblem: readWords(error) } })))
    },
    [api, patchDialog],
  )

  const saveKitLine = useCallback(() => {
    const open = dialogRef.current
    if (open?.kind !== 'kitLine' || !open.draft.material) return
    const { material, itemColourId, quantity, uom } = open.draft
    void write((key) => addKitLines(api, orderId, version(), [{ itemId: material.id, itemColourId: itemColourId || null, quantity: quantity.trim().replace(',', '.'), uom: uom || material.units.base.uom }], key), words('notice.kitLineAdded'))
  }, [api, orderId, write])

  const planKitNow = useCallback(() => void write((key) => planKit(api, orderId, version(), key), words('notice.kitPlanned')), [api, orderId, write])

  const removeKit = useCallback(async () => {
    const open = dialogRef.current
    if (open?.kind !== 'removeKit') return
    // One line at a time, each with the order's version as it stands after the one before.
    await write(async (key) => {
      let value: SubcontractOrder | null = null
      for (const [index, lineId] of open.lineIds.entries()) value = await removeKitLine(api, orderId, lineId, value?.version ?? version(), `${key}-${index}`)
      return value
    }, words('notice.kitRemoved', { count: open.lineIds.length }))
  }, [api, orderId, write])

  const returnLine = useCallback(() => {
    const open = dialogRef.current
    if (open?.kind !== 'returnLine') return
    void write((key) => returnKitLine(api, orderId, open.lineId, version(), open.reason.trim(), key), words('notice.lineReturned'), returnProblem)
  }, [api, orderId, write])

  // ---- send the kit ---------------------------------------------------------------------------------------------------------------

  const openSend = useCallback(() => {
    const value = current.current
    if (!value) return
    setDialogProblem(null)
    const draft = sendDraftOf(value, can)
    setDialog({ kind: 'send', draft })
    if (draft.lines.length > 0) {
      // One read per material of the planned lines (the site's whole stock may be cut short).
      const planned = value.kitLines.filter((line) => line.status === 'PLANNED')
      Promise.all([...new Set(planned.map((line) => line.item.id))].map((itemId) => stockOverview(api, { siteId: value.site.id, itemId })))
        .then((overviews) => {
          const rows = overviews.flatMap((overview) => overview.rows)
          const sources = Object.fromEntries(planned.map((line) => [line.id, sourcesFor(rows, line, new Set([value.location.id]))]))
          patchDialog('send', (open) => ({
            ...open,
            draft: {
              ...open.draft,
              sources: ready(sources),
              // One place holds it: picked already.
              lines: open.draft.lines.map((line) => (line.source || (sources[line.lineId] ?? []).length !== 1 ? line : { ...line, source: sources[line.lineId]![0]!.key })),
            },
          }))
        })
        .catch((error: unknown) => patchDialog('send', (open) => ({ ...open, draft: { ...open.draft, sources: { value: null, problem: readWords(error) } } })))
    } else patchDialog('send', (open) => ({ ...open, draft: { ...open.draft, sources: ready({}) } }))
    if (can.workOrders)
      workOrderBundles(api, value.workOrder.id)
        .then((bundles) => patchDialog('send', (open) => ({ ...open, draft: { ...open.draft, bundles: ready(bundles) } })))
        .catch((error: unknown) => patchDialog('send', (open) => ({ ...open, draft: { ...open.draft, bundles: { value: null, problem: readWords(error) } } })))
  }, [api, can, patchDialog, setDialog])

  const send = useCallback(async () => {
    const open = dialogRef.current
    const value = current.current
    if (open?.kind !== 'send' || !value || busy) return
    setBusy(true)
    setDialogProblem(null)
    try {
      const answer = await sendKit(api, orderId, sendBody(open.draft, value), dialogKey.current ?? newIdempotencyKey())
      setValue(answer.order)
      setDialog(null)
      setNotice({ tone: answer.ddt?.pdfProblem ? 'warning' : 'success', words: sentWords(answer) })
    } catch (error) {
      setDialogProblem(sendProblem(error))
      if (isApiError(error) && error.kind === 'conflict') {
        dialogKey.current = newIdempotencyKey()
        void load()
      }
    } finally {
      setBusy(false)
    }
  }, [api, busy, load, orderId, setDialog, setValue])

  // ---- goods back --------------------------------------------------------------------------------------------------------------------

  const openReceive = useCallback(() => {
    const value = current.current
    if (!value) return
    setDialogProblem(null)
    setDialog({ kind: 'receive', draft: receiveDraftOf(value, todayIn(TIME_ZONE), can) })
    workshopStock(api, { locationId: value.location.id })
      .then((stock) => patchDialog('receive', (open) => ({ ...open, draft: { ...open.draft, stock: ready(stock.rows) } })))
      .catch((error: unknown) => patchDialog('receive', (open) => ({ ...open, draft: { ...open.draft, stock: { value: null, problem: readWords(error) } } })))
    if (can.locations)
      listLocations(api, { siteId: value.site.id })
        .then((answer) => {
          const places = answer.sites.flatMap((site) => site.locations).filter((location) => location.siteId === value.site.id && location.status === 'ACTIVE' && location.kind !== 'SUBCONTRACTOR')
          patchDialog('receive', (open) => ({ ...open, draft: { ...open.draft, locations: ready(places.map((place) => ({ id: place.id, code: place.code, name: place.name }))) } }))
        })
        .catch((error: unknown) => patchDialog('receive', (open) => ({ ...open, draft: { ...open.draft, locations: { value: null, problem: readWords(error) } } })))
    else patchDialog('receive', (open) => ({ ...open, draft: { ...open.draft, locations: { value: null, problem: 'receive.noPlaces' } } }))
    if (can.workOrders)
      workOrderBundles(api, value.workOrder.id)
        .then((bundles) => patchDialog('receive', (open) => ({ ...open, draft: { ...open.draft, bundles: ready(bundles) } })))
        .catch((error: unknown) => patchDialog('receive', (open) => ({ ...open, draft: { ...open.draft, bundles: { value: null, problem: readWords(error) } } })))
  }, [api, can, patchDialog, setDialog])

  const receive = useCallback(async () => {
    const open = dialogRef.current
    const value = current.current
    if (open?.kind !== 'receive' || !value || busy) return
    setBusy(true)
    setDialogProblem(null)
    try {
      const answer = await receiveBack(api, orderId, receiveBody(open.draft, value, todayIn(TIME_ZONE)), dialogKey.current ?? newIdempotencyKey())
      setValue(answer.order)
      setDialog(null)
      setNotice({ tone: 'success', words: receivedWords(answer, can) })
    } catch (error) {
      setDialogProblem(receiveProblem(error))
      if (isApiError(error) && error.kind === 'conflict') {
        dialogKey.current = newIdempotencyKey()
        void load()
      }
    } finally {
      setBusy(false)
    }
  }, [api, busy, can, load, orderId, setDialog, setValue])

  // ---- documents ---------------------------------------------------------------------------------------------------------------------

  const showPdf = useCallback(
    async (ddtId: string) => {
      if (!can.files) return setPdf({ ddtId, data: null, problem: 'docs.noFiles' })
      setPdf({ ddtId, data: null, problem: null })
      try {
        setPdf({ ddtId, data: await readFromStore(await ddtPdfLink(api, ddtId)), problem: null })
      } catch (error) {
        setPdf({ ddtId, data: null, problem: isApiError(error) && error.kind === 'not_found' ? 'docs.pdf.missing' : readWords(error) })
      }
    },
    [api, can.files],
  )

  // Documents: the live kit DDT inline, once per DDT.
  const liveId = order.status === 'ready' ? (liveDdt(order.value)?.id ?? null) : null
  useEffect(() => {
    if (tab === 'documents' && liveId && can.files && pdf?.ddtId !== liveId) void showPdf(liveId)
    // Only when the tab or the live DDT changes.
  }, [tab, liveId])

  const openDdt = useCallback(
    async (ddtId: string) => {
      try {
        const link = await ddtPdfLink(api, ddtId)
        const anchor = document.createElement('a')
        anchor.href = storeUrl(link.url)
        anchor.target = '_blank'
        anchor.rel = 'noopener'
        document.body.append(anchor)
        anchor.click()
        anchor.remove()
      } catch (error) {
        setNotice({ tone: 'danger', words: isApiError(error) && error.kind === 'not_found' ? words('docs.pdf.missing') : words(readWords(error)) })
      }
    },
    [api],
  )

  const printAgain = useCallback(
    async (ddtId: string) => {
      if (busy) return
      setBusy(true)
      try {
        await printDdtAgain(api, ddtId)
        setNotice({ tone: 'success', words: words('notice.printed') })
        void showPdf(ddtId)
      } catch (error) {
        setNotice({ tone: 'danger', words: kindWords(error) })
      } finally {
        setBusy(false)
      }
    },
    [api, busy, showPdf],
  )

  const annul = useCallback(() => {
    const open = dialogRef.current
    if (open?.kind !== 'annul') return
    const number = current.current?.ddts.find((ddt) => ddt.id === open.ddtId)?.number ?? ''
    void write(
      async (key) => {
        await annulDdt(api, open.ddtId, version(), open.reason.trim(), key)
        setPdf(null)
        return getOrder(api, orderId)
      },
      words('notice.annulled', { number }),
    )
  }, [api, orderId, write])

  const model: SubcontractRecordModel = { prefix, can, tab, order, live, dockOpen, changed, notice, busy, dialog, dialogProblem, marks, pdf, timeZone: TIME_ZONE, today }

  const panels =
    order.status === 'ready' && (tab === 'activity' || dockOpen) ? (
      <RecordPanels record={{ type: 'SubcontractOrder', id: order.value.id, companyId: order.value.companyId, siteId: order.value.site.id }} title={order.value.number} party={{ id: order.value.workshop.id, name: order.value.workshop.name, emails: [] }} />
    ) : null

  return (
    <SubcontractRecordView
      model={model}
      panels={panels}
      actions={{
        onRetry: () => void load(),
        onReload: () => void load(),
        onDock: toggleDock,
        onDismissNotice: () => setNotice(null),
        onDialog: (next) => {
          if (!next) setDialogProblem(null)
          setDialog(next)
        },
        onAct: act,
        onCancel: cancel,
        onClose: close,
        onOpenSend: openSend,
        onSend: () => void send(),
        onOpenReceive: openReceive,
        onReceive: () => void receive(),
        onCell: (operationId, field, typed) => void saveCell(operationId, field, typed),
        onOpenSizes: openSizes,
        onSaveSizes: () => void saveSizes(),
        onOpenAddOperation: openAddOperation,
        onAddOperation: saveAddOperation,
        onRemoveOperation: removeOperationNow,
        onOpenKitLine: openKitLine,
        kitLine: { onQuery: searchMaterials, onMaterial: pickMaterial, onSave: saveKitLine },
        onPlanKit: planKitNow,
        onRemoveKit: () => void removeKit(),
        onReturnLine: returnLine,
        onOpenDdt: (ddtId) => void openDdt(ddtId),
        onPrintAgain: (ddtId) => void printAgain(ddtId),
        onAnnul: annul,
        onShowPdf: (ddtId) => void showPdf(ddtId),
        onCopyNumber: () => {
          const number = current.current?.number
          if (number) void navigator.clipboard?.writeText(number).then(() => setNotice({ tone: 'info', words: words('notice.copied', { number }) })).catch(() => undefined)
        },
      }}
    />
  )
}
