'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { storeHeaders, storeUrl } from '../../../../record-panels/store'
import {
  addLines,
  addParcel,
  annulDdt,
  attachDocuments,
  buyLabels,
  cancelShipment,
  changeLine,
  changeParcel,
  ddtPdfLink,
  fileLink,
  getDdt,
  getDocuments,
  getLabels,
  getShipment,
  getTracking,
  issueDdt,
  listDdts,
  makePackingList,
  markPacked,
  placeLine,
  previewDdt,
  previewDdtPdf,
  printDdtAgain,
  printLabels,
  readyToShip,
  removeLine,
  removeParcel,
  sendDocumentLink,
  shipShipment,
  unpack,
  updateShipment,
  type Bought,
  type Ddt,
  type DdtPreview,
  type DdtRow,
  type Documents,
  type Labels,
  type ReadyOrder,
  type SentLinks,
  type Shipment,
  type Tracking,
} from '../api'
import { useCoalesced, useLive, useThreadDock } from '../hooks'
import { abilitiesOf, ddtFormFor, ddtRequestOf, hasLeft, knownIds, liveTouches, readProblem, tabOf, writeProblem, type DdtForm } from '../model'
import { PART_LOADING, type Loaded, type Part, type PdfPart, type RecordDialog, type ShipmentRecordModel } from './record-model'
import { ShipmentRecordView } from './view/ShipmentRecordView'

/**
 * `/w/<company>/warehouse/shipments/<id>` (SCR-067): loads the shipment (shipping.view; the API checks its company,
 * site and party) and the parts its tabs show by the person's rights — its DDTs (the live one in full, its PDF from the
 * fiscal archive with files.read; while none is live, the draft the server would issue: every DPR 472/1996 field, its
 * problems, the number it would take, and the draft's PDF with the SAMPLE banner), the carrier labels (shipping.pack),
 * the tracking, the documents that travel (the DoC and user information per style, the customer's links) — and does
 * what the view asks, one write at a time, each with the shipment's version as read (a 409 reads it again and says so).
 * Live: an event that names the shipment, its parcels or lines reads it again.
 */
export function ShipmentRecord({ shipmentId }: { shipmentId: string }) {
  return (
    <WithMessages namespaces={['shipments', 'lists', 'records']}>
      <RecordContainer shipmentId={shipmentId} />
    </WithMessages>
  )
}

const part = <T,>(value: T): Part<T> => ({ value, problem: null })

/** A presigned GET's bytes (the issued DDT's PDF): the file store's address goes through this app's /api when local. */
async function presignedBytes(download: { url: string; headers: Record<string, string> }): Promise<Uint8Array> {
  const response = await fetch(storeUrl(download.url), { headers: storeHeaders(download), credentials: 'omit', cache: 'no-store' })
  if (!response.ok) throw new Error(`the file store answered ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

function openPresigned(download: { url: string }) {
  const anchor = document.createElement('a')
  anchor.href = storeUrl(download.url)
  anchor.target = '_blank'
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}

function RecordContainer({ shipmentId }: { shipmentId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const pathname = usePathname()
  const params = useSearchParams()
  const tab = tabOf(params?.get('tab'))
  const prefix = pathname.replace(/\/warehouse\/shipments\/[^/]+\/?$/, '')
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])

  const [shipment, setShipment] = useState<Loaded<Shipment>>({ status: 'loading' })
  const current = useRef<Shipment | null>(null)
  const [ddts, setDdts] = useState<Part<DdtRow[]>>(PART_LOADING)
  const [ddt, setDdt] = useState<Part<Ddt> | null>(null)
  const [pdf, setPdf] = useState<PdfPart | null>(null)
  const [preview, setPreview] = useState<Part<DdtPreview> | null>(null)
  const [labels, setLabels] = useState<Part<Labels> | null>(can.pack ? PART_LOADING : null)
  const [tracking, setTracking] = useState<Part<Tracking> | null>(null)
  const [documents, setDocuments] = useState<Part<Documents>>(PART_LOADING)
  const [ready, setReady] = useState<Part<ReadyOrder | null> | null>(null)
  const [dialog, setDialog] = useState<RecordDialog | null>(null)
  const dialogRef = useRef<RecordDialog | null>(null)
  dialogRef.current = dialog
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<ShipmentRecordModel['notice']>(null)
  const [dialogProblem, setDialogProblem] = useState<ShipmentRecordModel['dialogProblem']>(null)
  const [changed, setChanged] = useState<{ at: string } | null>(null)
  const [ddtForm, setDdtForm] = useState<DdtForm | null>(null)
  const [bought, setBought] = useState<Bought | null>(null)
  const [sent, setSent] = useState<SentLinks | null>(null)
  const { dockOpen, toggleDock } = useThreadDock()
  const keys = useRef<Record<string, string>>({})
  const keyOf = (name: string) => (keys.current[name] ??= newIdempotencyKey())
  const dropKey = (name: string) => delete keys.current[name]

  // ---- the parts ------------------------------------------------------------------------------------------------------

  const loadPdf = useCallback(
    async (live: DdtRow | null, value: Shipment, form: DdtForm | null) => {
      if (live) {
        if (!can.readFiles) return setPdf({ data: null, problem: 'docs.pdf.noFiles', sample: false })
        if (!live.fileId) return setPdf({ data: null, problem: 'docs.pdf.missing', sample: false })
        setPdf({ data: null, problem: null, sample: false })
        try {
          setPdf({ data: await presignedBytes(await ddtPdfLink(api, live.id)), problem: null, sample: false })
        } catch (error) {
          setPdf({ data: null, problem: readProblem(error), sample: false })
        }
        return
      }
      if (value.status !== 'PACKED' && !(value.status === 'SHIPPED' && value.ddtRequired)) return setPdf(null)
      setPdf({ data: null, problem: null, sample: true })
      try {
        setPdf({ data: await previewDdtPdf(api, value.id, form ? ddtRequestOf(form, value.transportBy) : {}), problem: null, sample: true })
      } catch (error) {
        setPdf({ data: null, problem: isApiError(error) && (error.kind === 'invalid' || error.kind === 'conflict') ? 'docs.pdf.draftHeld' : readProblem(error), sample: true })
      }
    },
    [api, can.readFiles],
  )

  const loadPreview = useCallback(
    async (value: Shipment, form: DdtForm | null): Promise<DdtPreview | null> => {
      setPreview((known) => known ?? PART_LOADING)
      try {
        const answer = await previewDdt(api, value.id, form ? ddtRequestOf(form, value.transportBy) : {})
        setPreview(part(answer))
        return answer
      } catch (error) {
        setPreview({ value: null, problem: readProblem(error) })
        return null
      }
    },
    [api],
  )

  const loadDdts = useCallback(
    async (value: Shipment) => {
      try {
        const rows = await listDdts(api, value.id)
        setDdts(part(rows))
        const live = rows.find((row) => row.status === 'LIVE') ?? null
        if (live) {
          setPreview(null)
          getDdt(api, live.id)
            .then((answer) => setDdt(part(answer)))
            .catch((error: unknown) => setDdt({ value: null, problem: readProblem(error) }))
        } else {
          setDdt(null)
          if (value.status === 'PACKED' || (value.status === 'SHIPPED' && value.ddtRequired) || value.status === 'DRAFT') {
            const answer = await loadPreview(value, null)
            setDdtForm((known) => known ?? ddtFormFor(value, answer))
          } else setPreview(null)
        }
        void loadPdf(live, value, null)
      } catch (error) {
        setDdts({ value: null, problem: readProblem(error) })
      }
    },
    [api, loadPdf, loadPreview],
  )

  const loadLabels = useCallback(
    (value: Shipment) => {
      if (!can.pack) return
      getLabels(api, value.id)
        .then((answer) => setLabels(part(answer)))
        .catch((error: unknown) => setLabels({ value: null, problem: readProblem(error) }))
    },
    [api, can.pack],
  )

  const loadTracking = useCallback(
    (value: Shipment) => {
      if (!hasLeft(value.status) && !value.parcels.some((parcel) => parcel.trackingNumber)) return setTracking(null)
      setTracking((known) => known ?? PART_LOADING)
      getTracking(api, value.id)
        .then((answer) => setTracking(part(answer)))
        .catch((error: unknown) => setTracking({ value: null, problem: readProblem(error) }))
    },
    [api],
  )

  const loadDocuments = useCallback(
    (value: Shipment) => {
      getDocuments(api, value.id)
        .then((answer) => setDocuments(part(answer)))
        .catch((error: unknown) => setDocuments({ value: null, problem: readProblem(error) }))
    },
    [api],
  )

  const loadReady = useCallback(
    (value: Shipment) => {
      if (value.status !== 'DRAFT' || !can.manage) return setReady(null)
      setReady((known) => known ?? PART_LOADING)
      readyToShip(api, { salesOrderId: value.salesOrderId })
        .then((orders) => setReady(part(orders.find((order) => order.salesOrderId === value.salesOrderId) ?? null)))
        .catch((error: unknown) => setReady({ value: null, problem: readProblem(error) }))
    },
    [api, can.manage],
  )

  const loadParts = useCallback(
    (value: Shipment) => {
      void loadDdts(value)
      loadLabels(value)
      loadTracking(value)
      loadDocuments(value)
      loadReady(value)
    },
    [loadDdts, loadLabels, loadTracking, loadDocuments, loadReady],
  )

  const setValue = useCallback((next: Shipment) => {
    current.current = next
    setShipment({ status: 'ready', value: next })
  }, [])

  const load = useCallback(async () => {
    try {
      const next = await getShipment(api, shipmentId)
      setValue(next)
      setChanged(null)
      loadParts(next)
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setShipment({ status: 'not_found' })
      else if (isApiError(error) && error.kind === 'forbidden') setShipment({ status: 'forbidden' })
      else setShipment({ status: 'error', problem: readProblem(error) })
    }
  }, [api, shipmentId, setValue, loadParts])

  useEffect(() => {
    void load()
  }, [load])

  // Live: an event that names this shipment, a parcel or a line; a dialog with typed work open → "changed · Reload".
  const reread = useCoalesced(() => void load(), 700)
  const known = shipment.status === 'ready' ? knownIds(shipment.value, [...(ddts.value ?? []).map((row) => row.id)]) : null
  const knownRef = useRef(known)
  knownRef.current = known
  const live = useLive(
    (change) => {
      if (!knownRef.current || !liveTouches(change, knownRef.current)) return
      const open = dialogRef.current
      if (open && (open.kind === 'issueDdt' || open.kind === 'annulDdt' || open.kind === 'cancel' || open.kind === 'delivery' || open.kind === 'parcel' || open.kind === 'sendLink')) setChanged({ at: new Date().toISOString() })
      else reread()
    },
    () => void load(),
  )

  /** One write; then the shipment and its parts are read again (a write answers the packing view or a part, not the record). */
  const write = useCallback(
    async (run: () => Promise<void | Shipment>, success: string | null, options: { keepDialog?: boolean; key?: string } = {}) => {
      if (busy) return
      setBusy(true)
      setNotice(null)
      setDialogProblem(null)
      try {
        const next = await run()
        if (next) {
          setValue(next)
          loadParts(next)
        } else await load()
        if (options.key) dropKey(options.key)
        if (!options.keepDialog) setDialog(null)
        if (success) setNotice({ tone: 'success', words: { key: success } })
      } catch (error) {
        const problem = writeProblem(error)
        if (dialogRef.current) setDialogProblem({ words: { key: problem.key }, detail: problem.detail ?? null })
        else setNotice({ tone: 'danger', words: { key: problem.key }, detail: problem.detail ?? null })
        if (problem.reload) void load()
      } finally {
        setBusy(false)
      }
    },
    [busy, load, loadParts, setValue],
  )

  const version = () => current.current?.version ?? 1
  const value = shipment.status === 'ready' ? shipment.value : null
  const liveDdt = ddts.value?.find((row) => row.status === 'LIVE') ?? null

  const model: ShipmentRecordModel = {
    prefix,
    can,
    tab,
    shipment,
    ddts,
    ddt,
    pdf,
    preview,
    labels,
    tracking,
    documents,
    ready,
    live,
    dockOpen,
    changed,
    notice,
    busy,
    dialog,
    dialogProblem,
    ddtForm,
    bought,
    sent,
  }

  return (
    <ShipmentRecordView
      model={model}
      panels={value ? <RecordPanels record={{ type: 'Shipment', id: value.id, companyId: value.companyId, siteId: value.siteId }} title={`${value.number} · ${value.party.legalName}`} party={{ id: value.partyId, name: value.party.legalName, emails: [] }} /> : null}
      actions={{
        onRetry: () => void load(),
        onRetryPart: (which) => {
          if (!value) return
          if (which === 'ddts' || which === 'preview') void loadDdts(value)
          if (which === 'pdf') void loadPdf(liveDdt, value, ddtForm)
          if (which === 'labels') loadLabels(value)
          if (which === 'tracking') loadTracking(value)
          if (which === 'documents') loadDocuments(value)
          if (which === 'ready') loadReady(value)
        },
        onReload: () => void load(),
        onDock: toggleDock,
        onDismissNotice: () => setNotice(null),
        onDialog: (next) => {
          setDialog(next)
          setDialogProblem(null)
          setBought(null)
          setSent(null)
          if (next?.kind === 'issueDdt' && value && !ddtForm) setDdtForm(ddtFormFor(value, preview?.value ?? null))
        },
        // Lines & cartons
        onPack: () => void write(async () => void (await markPacked(api, shipmentId, version())), 'notice.packed'),
        onUnpack: () => void write(async () => void (await unpack(api, shipmentId, version())), 'notice.unpacked'),
        onLineQuantity: (lineId, quantity) => void write(() => changeLine(api, shipmentId, lineId, version(), quantity), null),
        onRemoveLine: (lineId) => void write(() => removeLine(api, shipmentId, lineId, version()), 'notice.lineRemoved'),
        onAddLines: (lines) => void write(() => addLines(api, shipmentId, version(), lines), 'notice.linesAdded'),
        onPlaceLine: (lineId, parcelId) => void write(async () => void (await placeLine(api, shipmentId, lineId, version(), parcelId)), null),
        onSaveParcel: (parcelId, measures) => {
          const clean = (text: string) => (text.trim() === '' ? null : text.trim().replace(',', '.'))
          const body = { grossWeightKg: clean(measures.grossWeightKg), lengthCm: clean(measures.lengthCm), widthCm: clean(measures.widthCm), heightCm: clean(measures.heightCm) }
          void write(async () => {
            if (parcelId) await changeParcel(api, shipmentId, parcelId, version(), body)
            else await addParcel(api, shipmentId, version(), Object.fromEntries(Object.entries(body).filter(([, entry]) => entry !== null)))
          }, parcelId ? 'notice.parcelSaved' : 'notice.parcelAdded')
        },
        onRemoveParcel: (parcelId) => void write(async () => void (await removeParcel(api, shipmentId, parcelId, version())), 'notice.parcelRemoved'),
        onPackingList: () => void write(async () => void (await makePackingList(api, shipmentId)), 'notice.packingList'),
        // Documents
        onDdtForm: (form) => setDdtForm(form),
        onPreview: () => {
          if (!value) return
          void loadPreview(value, ddtForm)
          void loadPdf(null, value, ddtForm)
        },
        onIssueDdt: () => {
          if (!value || !ddtForm) return
          const key = keyOf('issueDdt')
          void write(
            async () => {
              const answer = await issueDdt(api, shipmentId, ddtRequestOf(ddtForm, value.transportBy, version()), key)
              if (answer.pdfProblem) setNotice({ tone: 'warning', words: { key: 'notice.ddtNoPdf', params: { number: answer.ddt.number } } })
            },
            ddtForm.ship ? 'notice.ddtShipped' : 'notice.ddtIssued',
            { key: 'issueDdt' },
          )
        },
        onAnnulDdt: (ddtId, reason) => void write(async () => void (await annulDdt(api, ddtId, version(), reason)), 'notice.ddtAnnulled'),
        onDownloadDdt: (ddtId) => void write(async () => openPresigned(await ddtPdfLink(api, ddtId)), null),
        onPrintDdtAgain: (ddtId) => void write(async () => void (await printDdtAgain(api, ddtId)), 'notice.ddtPdf'),
        onAttach: () => void write(async () => void (await attachDocuments(api, shipmentId)), 'notice.attached'),
        onSendLink: (contactIds, expiresInDays) => {
          const key = keyOf('sendLink')
          void write(
            async () => {
              setSent(await sendDocumentLink(api, shipmentId, { contactIds, expiresInDays }, key))
            },
            null,
            { keepDialog: true, key: 'sendLink' },
          )
        },
        onOpenFile: (fileId) => void write(async () => openPresigned(await fileLink(api, fileId)), null),
        // Carrier & label
        onDelivery: (next) =>
          void write(
            () =>
              updateShipment(api, shipmentId, {
                version: version(),
                transportBy: next.transportBy,
                ...(next.transportBy === 'CARRIER' ? { carrierCode: next.carrierCode.trim() || null, serviceCode: next.serviceCode.trim() || null } : { carrierCode: null, serviceCode: null }),
              }),
            'notice.delivery',
          ),
        onBuyLabels: () => {
          const key = keyOf('buyLabels')
          void write(
            async () => {
              setBought(await buyLabels(api, shipmentId, version(), key))
            },
            null,
            { keepDialog: true, key: 'buyLabels' },
          )
        },
        onPrintLabels: () => void write(async () => void (await printLabels(api, shipmentId)), 'notice.labelsPrinted'),
        onHandOver: () => void write(() => shipShipment(api, shipmentId, version()), 'notice.shipped'),
        onCancel: (reason) => void write(() => cancelShipment(api, shipmentId, version(), reason), 'notice.cancelled'),
      }}
    />
  )
}
