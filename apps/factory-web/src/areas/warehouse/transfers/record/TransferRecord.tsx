'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { formatTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { useLiveBus } from '../../../../shell/live/use-live'
import {
  addLine,
  cancelTransfer,
  ddtPdfAddress,
  printDdtAgain,
  readOptions,
  readStock,
  readTransfer,
  receiveTransfer,
  removeLine,
  settleLine,
  shipTransfer,
  updateLine,
  updateTransfer,
  type TransferView,
} from '../api'
import { decimalText, fieldOfPath, readProblem, receiveBodyOf, recordTabOf, shipBodyOf, todayOf, transfersCan, writeProblem, type Notice, type Phrase } from '../model'
import { TransfersMessages } from '../parts'
import { pickedBodies } from './view/PickerDialog'
import { TransferRecordView } from './view/TransferRecordView'
import type { CellSave, Loaded, PickerState, RecordDialog } from './view-model'

const LIVE_TYPES = ['inventory.transfer_changed', 'inventory.moved'] as const

/**
 * `/w/<company>/warehouse/transfers/<transfer>?tab=lines|transit|received` (SCR-361): reads the transfer, then does what the
 * view asks — every write with the version read and one Idempotency-Key per attempt; each answer is the transfer as it is
 * now. A draft line's quantity saves per cell on the line's own version. Live changes of this transfer read it again (a
 * dialog open: the "changed elsewhere" banner instead). The DDT's PDF opens in a new tab (a presigned GET).
 */
export function TransferRecord({ transferId }: { transferId: string }) {
  return (
    <TransfersMessages>
      <Container transferId={transferId} />
    </TransfersMessages>
  )
}

function Container({ transferId }: { transferId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const locale = useLocale()
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => transfersCan(session.permissions), [session.permissions])
  const tab = recordTabOf(params)
  const [opened] = useState(() => new Date().toISOString())
  const today = todayOf(opened)

  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [asOf, setAsOf] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [lines, setLines] = useState<readonly Phrase[]>([])
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState<string | null>(null)
  const [cells, setCells] = useState<Record<string, CellSave>>({})
  const [dialog, setDialog] = useState<RecordDialog | null>(null)
  const [toPlaces, setToPlaces] = useState<{ id: string; code: string; name: string }[] | null>(null)
  const transfer = loaded.status === 'ready' ? loaded.transfer : null
  const current = useRef<TransferView | null>(null)
  current.current = transfer
  const dialogRef = useRef<RecordDialog | null>(null)
  dialogRef.current = dialog

  const show = useCallback((value: TransferView) => {
    setLoaded({ status: 'ready', transfer: value })
    setAsOf(new Date().toISOString())
    setStale(null)
  }, [])

  const load = useCallback(async () => {
    if (!can.view) return
    try {
      show(await readTransfer(api, transferId))
    } catch (error) {
      const kind = isApiError(error) ? error.kind : null
      setLoaded(kind === 'not_found' ? { status: 'notFound' } : kind === 'forbidden' ? { status: 'forbidden' } : { status: 'error', problem: readProblem(error) })
    }
  }, [api, can.view, transferId, show])
  useEffect(() => {
    setLoaded({ status: 'loading' })
    void load()
  }, [load])

  // The receiving site's places (the Receive dialog's choice).
  const toSiteId = transfer?.to.id ?? null
  useEffect(() => {
    if (!toSiteId || !can.view) return
    const controller = new AbortController()
    readOptions(api, controller.signal)
      .then((options) => setToPlaces(options.sites.find((site) => site.id === toSiteId)?.places ?? []))
      .catch(() => setToPlaces(null))
    return () => controller.abort()
  }, [api, toSiteId, can.view])

  const live = useLiveBus(
    {
      onChange: (change) => {
        if (!LIVE_TYPES.some((type) => change.type === type)) return
        if (change.type === 'inventory.transfer_changed' && change.fields.transferId !== transferId) return
        if (dialogRef.current) setStale(formatTime(new Date().toISOString(), { locale }))
        else void load()
      },
      onReconnect: () => void load(),
    },
    can.view,
  )

  const refused = useCallback((error: unknown, into?: (notice: Notice, places: Phrase[]) => void) => {
    const problem = writeProblem(error)
    const places = [...new Set(problem.paths.map(fieldOfPath))].map((key) => ({ key }))
    if (into) into({ ...problem, tone: 'danger' }, places)
    else {
      setNotice({ ...problem, tone: 'danger' })
      setLines(places)
    }
    if (problem.stale) void load()
    return problem
  }, [load])

  /** One write of the band or a tab: busy while it runs, the answer shown, a refusal said. */
  const write = useCallback(
    async (run: () => Promise<TransferView>, done?: Phrase) => {
      setBusy(true)
      try {
        show(await run())
        if (done) setNotice({ ...done, tone: 'success' })
        setLines([])
        return true
      } catch (error) {
        refused(error)
        return false
      } finally {
        setBusy(false)
      }
    },
    [show, refused],
  )

  // ---- the lines -----------------------------------------------------------------------------------------------------------
  const onQuantity = useCallback(
    async (lineId: string, text: string) => {
      const now = current.current
      const line = now?.lines.find((entry) => entry.id === lineId)
      if (!now || !line) return
      const quantity = decimalText(text)
      if (quantity === null) {
        setCells((all) => ({ ...all, [lineId]: { state: 'failed', words: { key: 'held.quantityCell' } } }))
        return
      }
      setCells((all) => ({ ...all, [lineId]: { state: 'saving' } }))
      try {
        show(await updateLine(api, transferId, lineId, { version: line.version, quantity }, newIdempotencyKey()))
        setCells((all) => ({ ...all, [lineId]: { state: 'saved' } }))
      } catch (error) {
        const problem = writeProblem(error)
        setCells((all) => ({ ...all, [lineId]: { state: 'failed', words: problem } }))
        if (problem.stale) void load()
      }
    },
    [api, transferId, show, load],
  )

  const removeMany = useCallback(
    async (ids: readonly string[]) => {
      setBusy(true)
      try {
        let value = current.current
        for (const id of ids) {
          if (!value) break
          value = await removeLine(api, transferId, id, value.version, newIdempotencyKey())
          show(value)
        }
        setNotice({ key: 'lines.removed', params: { count: ids.length }, tone: 'success' })
      } catch (error) {
        refused(error)
      } finally {
        setBusy(false)
      }
    },
    [api, transferId, show, refused],
  )

  // ---- the stock picker -------------------------------------------------------------------------------------------------------
  const pickerRead = useRef(0)
  const readPicker = useCallback(
    (picker: PickerState) => {
      const id = ++pickerRead.current
      readStock(api, transferId, { locationId: picker.locationId, q: picker.q })
        .then((stock) => id === pickerRead.current && setDialog((now) => (now?.kind === 'pick' ? { kind: 'pick', picker: { ...now.picker, stock, problem: null } } : now)))
        .catch((error: unknown) => id === pickerRead.current && setDialog((now) => (now?.kind === 'pick' ? { kind: 'pick', picker: { ...now.picker, stock: { rows: [], truncated: false }, problem: readProblem(error) } } : now)))
    },
    [api, transferId],
  )
  const openDialog = useCallback(
    (next: RecordDialog | null) => {
      const was = dialogRef.current
      setDialog(next)
      if (next?.kind === 'pick' && was?.kind !== 'pick') readPicker(next.picker)
      if (!next && stale) void load()
    },
    [readPicker, stale, load],
  )

  const addPicked = useCallback(async () => {
    const now = dialogRef.current
    if (now?.kind !== 'pick' || now.picker.busy) return
    const bodies = pickedBodies(now.picker)
    setDialog({ kind: 'pick', picker: { ...now.picker, busy: true, notice: null } })
    let value = current.current
    let added = 0
    try {
      for (const body of bodies) {
        if (!value) break
        value = await addLine(api, transferId, { version: value.version, ...body }, newIdempotencyKey())
        show(value)
        added += 1
      }
      setDialog(null)
      setNotice({ key: 'lines.added', params: { count: added }, tone: 'success' })
    } catch (error) {
      refused(error, (notice) => setDialog((open) => (open?.kind === 'pick' ? { kind: 'pick', picker: { ...open.picker, busy: false, notice, picked: Object.fromEntries(Object.entries(open.picker.picked).slice(added)) } } : open)))
    }
  }, [api, transferId, show, refused])

  // ---- the steps --------------------------------------------------------------------------------------------------------------
  const keys = useRef<Record<string, string | null>>({})
  const keyOf = (step: string) => (keys.current[step] ??= newIdempotencyKey())
  const dialogRefused = (error: unknown, step: string) => {
    const problem = refused(error, (notice, places) => setDialog((open) => (open && open.kind !== 'pick' ? { ...open, busy: false, notice, ...('lines' in open ? { lines: places } : {}) } : open)))
    if (!problem.stale) keys.current[step] = null
  }

  const onShip = useCallback(async () => {
    const now = dialogRef.current
    const value = current.current
    if (now?.kind !== 'ship' || !value || now.busy) return
    setDialog({ ...now, busy: true, notice: null, lines: [] })
    try {
      const answer = await shipTransfer(api, transferId, shipBodyOf(now.draft, value.version), keyOf('ship'))
      keys.current.ship = null
      show(answer.transfer)
      setDialog(null)
      setNotice(answer.pdfProblem ? { key: 'ship.donePdfMissing', params: { ddt: answer.transfer.ddt?.number ?? '' }, tone: 'warning' } : { key: 'ship.done', params: { ddt: answer.transfer.ddt?.number ?? '' }, tone: 'success' })
    } catch (error) {
      dialogRefused(error, 'ship')
    }
    // keyOf and dialogRefused read refs only.
  }, [api, transferId, show])

  const onReceive = useCallback(async () => {
    const now = dialogRef.current
    const value = current.current
    if (now?.kind !== 'receive' || !value || now.busy) return
    setDialog({ ...now, busy: true, notice: null, lines: [] })
    try {
      const answer = await receiveTransfer(api, transferId, receiveBodyOf(now.draft, value), keyOf('receive'))
      keys.current.receive = null
      show(answer)
      setDialog(null)
      setNotice({ key: answer.status === 'RECEIVED' ? 'receive.doneAll' : 'receive.donePart', tone: 'success' })
    } catch (error) {
      dialogRefused(error, 'receive')
    }
  }, [api, transferId, show])

  const onSettle = useCallback(async () => {
    const now = dialogRef.current
    const value = current.current
    if (now?.kind !== 'settle' || !value || now.busy || !now.draft.resolution) return
    setDialog({ ...now, busy: true, notice: null })
    try {
      const answer = await settleLine(api, transferId, now.draft.lineId, { version: value.version, resolution: now.draft.resolution, ...(now.draft.note.trim() ? { note: now.draft.note.trim() } : {}) }, keyOf('settle'))
      keys.current.settle = null
      show(answer)
      setDialog(null)
      setNotice({ key: 'settle.done', params: { resolution: `resolution.${now.draft.resolution}` }, tone: 'success' })
    } catch (error) {
      dialogRefused(error, 'settle')
    }
  }, [api, transferId, show])

  const onCancel = useCallback(async () => {
    const now = dialogRef.current
    const value = current.current
    if (now?.kind !== 'cancel' || !value || now.busy) return
    setDialog({ ...now, busy: true, notice: null })
    try {
      show(await cancelTransfer(api, transferId, { version: value.version, reason: now.reason.trim() }, keyOf('cancel')))
      keys.current.cancel = null
      setDialog(null)
      setNotice({ key: 'cancel.done', tone: 'success' })
    } catch (error) {
      dialogRefused(error, 'cancel')
    }
  }, [api, transferId, show])

  const onOpenDdt = useCallback(async () => {
    try {
      const address = await ddtPdfAddress(api, transferId)
      const anchor = document.createElement('a')
      anchor.href = address
      anchor.target = '_blank'
      anchor.rel = 'noopener'
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
    } catch (error) {
      setNotice({ key: isApiError(error) && error.kind === 'not_found' ? 'held.pdfMissing' : readProblem(error), tone: 'danger' })
    }
  }, [api, transferId])

  return (
    <TransferRecordView
      model={{ prefix, can, tab, today, loaded, asOf, live, notice, lines, busy, stale, cells, dialog, toPlaces }}
      actions={{
        onRetry: () => void load(),
        onReload: () => void load(),
        onDismissNotice: () => setNotice(null),
        onCopy: () => {
          if (!transfer) return
          void navigator.clipboard
            ?.writeText(transfer.number)
            .then(() => setNotice({ key: 'record.copied', params: { number: transfer.number }, tone: 'success' }))
            .catch(() => undefined)
        },
        onQuantity: (lineId, text) => void onQuantity(lineId, text),
        onRemoveLine: (lineId) => void removeMany([lineId]),
        onRemoveLines: (ids) => void removeMany(ids),
        onOpenDdt: () => void onOpenDdt(),
        onPrintDdtAgain: () =>
          void (async () => {
            setBusy(true)
            try {
              await printDdtAgain(api, transferId, 'it')
              await load()
              setNotice({ key: 'transit.printed', tone: 'success' })
            } catch (error) {
              refused(error)
            } finally {
              setBusy(false)
            }
          })(),
        onSaveTracking: (patch) => {
          if (!transfer) return
          void write(() => updateTransfer(api, transferId, { version: transfer.version, ...patch }, newIdempotencyKey()), { key: 'transit.saved' })
        },
        onDialog: openDialog,
        onShip: () => void onShip(),
        onReceive: () => void onReceive(),
        onSettle: () => void onSettle(),
        onCancel: () => void onCancel(),
        onPickerSearch: (patch) => {
          const now = dialogRef.current
          if (now?.kind !== 'pick') return
          const picker = { ...now.picker, ...patch, stock: null, problem: null, picked: {} }
          setDialog({ kind: 'pick', picker })
          readPicker(picker)
        },
        onAddPicked: () => void addPicked(),
      }}
    />
  )
}
