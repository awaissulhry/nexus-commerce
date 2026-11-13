'use client'

import type { ReactNode } from 'react'
import { ArrowLeft, Box, CircleAlert, CircleCheck, CircleMinus, CloudOff, FileText, House, Lock, Package, PackageCheck, PackageOpen, Printer, RotateCcw, ScanLine, ShieldAlert, ShieldCheck, Tag, Truck, X } from 'lucide-react'
import { LABEL_PRINT_TONE } from '@nexus/ui/components/LabelPreview/index'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { FloorActionBar, FloorButton, FloorList, FloorListRow, ScanInput, type CameraScanner, type FloorAction, type FloorActions, type FloorTone } from '@nexus/ui/floor'
import { formatDate, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Translate } from '../../../../lib/i18n/messages'
import { pdfViewerLabels } from '../../../../lib/pdf/labels'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import type { TaskProblem } from '../../shared/task-api'
import { HeldLine, ListFooter, ProblemState, TaskCard, TaskLine } from '../../shared/view/TaskParts'
import type { JobStatus } from '../api'
import type { BenchPackaging } from '../carton/api'
import type { BenchLeft, BenchMain, CloseChoice, HoldReason, KeptScan, MarksNote, PackCartonView, PackGrid, ScanFlash } from '../carton/model'
import { CartonCard, KeptScans, LeftList, leftWords, ScanFlashLine } from '../carton/view/CartonParts'
import { CloseCarton } from '../carton/view/CloseCarton'
import { MarksResult, type MarksPreviewFacts } from '../carton/view/MarksResult'
import { PackSizeGrid } from '../carton/view/PackSizeGrid'
import type { PackedSummary } from '../done/model'
import { PackedDone } from '../done/view/PackedDone'
import type { DocumentsState, PackHead } from '../model'
import '../pack.css'
import '../carton/carton.css'

/**
 * SCR-098 — the packing bench on the floor tablet (design floor.pack; LOG-002, LOG-003, LOG-007, LOG-010, LOG-013, LOG-019,
 * LOG-039, QHS-073). One shipment at a time: the site's shipments to pack (scan the pack slip or a carton's marks, or pick a
 * row: never a customer's name on a shared screen), "Released?" (only released garments are on a shipment; a hold turns it
 * red and stops the scans with its reason), then B-W2b-387's Scan into the carton: each garment scanned goes into the open
 * carton (0 taps), the size grid ordered against packed live, a wrong piece flashes big with its reason, a batch label that
 * names no size makes its sizes buttons on the grid; scans keep on the tablet while the network is gone; a garment comes out
 * of a carton; Close carton = what it is packed in and its weight, then its contents stored and its marks printed (or why
 * not, with Print again and the marks as a PDF made here); the carton list "Carton 2 of 3"; Packed. Once packed: the carrier
 * labels and the office's DDT and packing list on the station's printers, then Packed's summary. No money, never another
 * person.
 */

export interface PackRowModel {
  id: string
  number: string
  status: 'DRAFT' | 'PACKED'
  carrier: string | null
  garments: number
  cartons: number
}

export interface JobModel {
  id: string
  what: 'LABEL' | 'DDT' | 'PACKING_LIST'
  /** The carton of a label. */
  seq: number | null
  status: JobStatus
  detail: string | null
}

export interface DocumentsModel extends DocumentsState {
  trackingNumbers: { seq: number; trackingNumber: string | null }[]
  jobs: JobModel[]
}

/** Scan into the carton as the view draws it (Pack.tsx builds it from the bench and the screen's own state). */
export interface BenchStep {
  grid: PackGrid
  cartons: readonly PackCartonView[]
  /** The carton scans go into (null: the next scan opens one). */
  current: PackCartonView | null
  left: readonly BenchLeft[]
  main: BenchMain
  /** The hold in force (scans stop), by its reason. */
  hold: HoldReason | null
  flash: ScanFlash | null
  /** The next scan takes a garment out of this carton. */
  takeOut: { cartonId: string; seq: number } | null
  /** A batch label named no size: the cells to tap on the grid. */
  choosing: readonly string[] | null
  close: { choice: CloseChoice; types: readonly BenchPackaging[]; suggestedId: string | null; held: 'noPackaging' | 'packaging' | 'weight' | null; overweightMax: string | null } | null
  marks: { note: MarksNote; job: JobStatus | null; facts: MarksPreviewFacts | null } | null
  /** The cartons whose marks were just sent to the printer again. */
  printedMarks: readonly number[] | null
  kept: { waiting: readonly KeptScan[]; refused: readonly KeptScan[] }
  /** The marks as a PDF made here: being made, or its bytes. */
  pdf: { bytes: Uint8Array; number: string } | 'loading' | null
}

export type PackStep =
  | { kind: 'loading'; code?: string | null }
  | { kind: 'noPermission' }
  | { kind: 'problem'; problem: TaskProblem; code?: string | null }
  | { kind: 'list'; rows: PackRowModel[]; scanned?: { code: string; why: 'notFound' | 'serialFirst' } | null }
  | { kind: 'pack'; head: PackHead; bench: BenchStep }
  | { kind: 'documents'; head: PackHead; documents: DocumentsModel; unpackHeld: 'labelled' | 'ddt' | null }
  | { kind: 'done'; summary: PackedSummary }

export interface PackViewModel {
  frame: FrameModel
  online: boolean
  /** The person's rights here: pack (shipping.pack) and print carrier labels (print.labels). */
  can: { pack: boolean; printLabels: boolean }
  step: PackStep
  /** Shown from what the tablet read before (offline): when. */
  asOf?: string | null
  /** A call is on its way. */
  busy?: boolean
  /** A refused write, said on the step: the bench's words for it. */
  notice?: TaskProblem | null
  timeZone?: string
}

export type PackAction =
  | { type: 'scan'; code: string }
  | { type: 'open'; id: string }
  | { type: 'back' }
  | { type: 'home' }
  | { type: 'retry' }
  | { type: 'choose-cell'; cellId: string }
  | { type: 'take-out'; cartonId: string }
  | { type: 'remove-carton'; id: string }
  | { type: 'close-carton'; cartonId: string }
  | { type: 'close-packaging'; id: string }
  | { type: 'close-weight'; value: number | null }
  | { type: 'close-confirm' }
  | { type: 'close-cancel' }
  | { type: 'marks-print'; parcelIds?: string[] }
  | { type: 'marks-retry' }
  | { type: 'marks-pdf'; parcelIds: string[] }
  | { type: 'pdf-print' }
  | { type: 'pdf-close' }
  | { type: 'packed' }
  | { type: 'unpack' }
  | { type: 'documents' }
  | { type: 'print' }
  | { type: 'retry-job'; jobId: string }
  | { type: 'finish' }
  | { type: 'next' }

export interface PackViewProps {
  model: PackViewModel
  onAction?: (action: PackAction) => void
  onFrame?: (action: FrameAction) => void
  camera?: CameraScanner
}

const actions = (list: (FloorAction | null | false)[]): FloorActions => list.filter((entry): entry is FloorAction => Boolean(entry)).slice(-3) as unknown as FloorActions

/** A print job's tone, as the DS label preview paints its print state (always with its icon and word). */
const JOB_TONE: Readonly<Record<JobStatus, FloorTone>> = {
  QUEUED: LABEL_PRINT_TONE.queued,
  SENT: LABEL_PRINT_TONE.sent,
  PRINTED: LABEL_PRINT_TONE.printed,
  FAILED: LABEL_PRINT_TONE.failed,
}

export function PackView({ model, onAction, onFrame, camera }: PackViewProps) {
  const t = useT('floor-pack')
  const d = useT('floor-pack-depth')
  const tt = useT('floor-tasks')
  const shell = useT('shell')
  const locale = useLocale()
  const send = (action: PackAction) => onAction?.(action)
  const { step } = model
  const offlineHeld = model.online ? null : t('offline.held')
  const busyHeld = model.busy ? t('busy') : null
  const back: FloorAction = { label: tt('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }), variant: 'secondary' }
  const time = (value: string) => formatTime(value, { locale, timeZone: model.timeZone })

  let body: ReactNode = null
  let bar: FloorActions | null = null

  const asOf = model.asOf ? (
    <TaskLine tone="info" icon={<CircleMinus />}>
      {tt('asOf', { time: time(model.asOf) })}
    </TaskLine>
  ) : null
  const notice = model.notice ? <NoticeLine problem={model.notice} t={t} d={d} tt={tt} /> : null
  const scan = (label: string, hint: string, disabled = false) => (
    <ScanInput
      label={label}
      hint={hint}
      scannedLabel={(code) => t('scan.read', { code })}
      keyboardLabel={t('scan.type')}
      disabled={disabled}
      camera={camera ? { scanner: camera, startLabel: t('scan.camera.start'), stopLabel: t('scan.camera.stop'), errorLabel: t('scan.camera.error') } : undefined}
      onScan={(code) => send({ type: 'scan', code })}
    />
  )

  switch (step.kind) {
    case 'loading':
      body = (
        <div className="fw-floor-card" aria-busy="true">
          {step.code ? <p className="fw-floor-card-code">{step.code}</p> : null}
          <p className="fw-floor-muted">{t('loading')}</p>
        </div>
      )
      break

    case 'noPermission':
      body = <FloorState tone="warning" icon={<Lock />} title={t('noPermission.title')} text={t('noPermission.body')} alert />
      bar = [{ label: tt('action.home'), icon: <House />, onPress: () => send({ type: 'home' }) }]
      break

    case 'problem':
      body = <ProblemState problem={step.problem} code={step.code ?? null} />
      bar = [back, { label: tt('action.retry'), icon: <RotateCcw />, onPress: () => send({ type: 'retry' }) }]
      break

    case 'list': {
      body = (
        <>
          {scan(t('list.scan'), t('list.hint'))}
          {step.scanned ? (
            <TaskLine tone="danger" icon={<CircleAlert />} alert>
              {t(`list.${step.scanned.why}`, { code: step.scanned.code })}
            </TaskLine>
          ) : null}
          {step.rows.length === 0 ? (
            <FloorState tone="info" icon={<PackageOpen />} title={t('list.empty.title')} text={t('list.empty.body')} />
          ) : (
            <section className="fw-floor-stack" aria-labelledby="fw-pack-rows">
              <h2 id="fw-pack-rows" className="fw-floor-subtitle">
                {t('list.title')}
              </h2>
              <FloorList label={t('list.title')}>
                {step.rows.map((row) => (
                  <FloorListRow
                    key={row.id}
                    icon={row.status === 'PACKED' ? <PackageCheck /> : <Package />}
                    tone={row.status === 'PACKED' ? 'info' : 'neutral'}
                    title={<span className="fw-floor-code">{row.number}</span>}
                    meta={[row.carrier ? t('list.carrier', { carrier: row.carrier }) : t('list.noCarrier'), t('list.cartons', { count: row.cartons })].join(' · ')}
                    status={row.status === 'PACKED' ? t('list.waiting') : t('list.toPack')}
                    count={row.garments}
                    countLabel={t('list.garments')}
                    onPress={() => send({ type: 'open', id: row.id })}
                  />
                ))}
              </FloorList>
              <ListFooter
                count={t('list.count', { count: step.rows.length })}
                keys={[
                  { key: 'Tab', does: tt('keys.tab') },
                  { key: 'Enter', does: tt('keys.enter') },
                  { key: 'Esc', does: tt('keys.escape') },
                ]}
              />
            </section>
          )}
        </>
      )
      bar = [{ label: tt('action.home'), icon: <House />, onPress: () => send({ type: 'home' }) }]
      break
    }

    case 'pack': {
      const { head, bench } = step
      const writeHeld = offlineHeld ?? busyHeld
      const holdWords = bench.hold ? d('gate.held', { reason: d(`gate.reason.${bench.hold}`) }) : null
      if (bench.pdf) {
        body = (
          <>
            <ShipmentStrip head={head} t={t} d={d} current={bench.current} />
            {bench.pdf === 'loading' ? (
              <FloorState tone="info" icon={<FileText />} title={d('marks.pdfLoading')} busy />
            ) : (
              <div className="fw-pack-pdf">
                <PdfViewer src={bench.pdf.bytes} title={d('marks.pdfTitle', { number: bench.pdf.number })} fileName={`${bench.pdf.number}-marks.pdf`} labels={pdfViewerLabels(shell)} height="min(64vh, 900px)" />
              </div>
            )}
          </>
        )
        bar = actions([
          { label: d('marks.pdfClose'), icon: <X />, variant: 'secondary', onPress: () => send({ type: 'pdf-close' }) },
          { label: d('marks.pdfPrint'), icon: <Printer />, onPress: () => send({ type: 'pdf-print' }), heldReason: bench.pdf === 'loading' ? d('marks.pdfLoading') : null },
        ])
        break
      }
      const close = bench.close
      const scanHint = bench.hold ? d('scan.held') : bench.takeOut ? d('scan.out', { seq: bench.takeOut.seq }) : bench.current ? d('scan.into', { seq: bench.current.seq }) : d('scan.new')
      const others = bench.cartons.filter((carton) => carton.id !== bench.current?.id)
      const cartonActions = (carton: PackCartonView) => {
        if (carton.labelled || bench.hold) return undefined
        return {
          held: writeHeld,
          takeOut: carton.garments > 0 ? () => send({ type: 'take-out', cartonId: carton.id }) : undefined,
          close: !carton.closed && carton.garments > 0 && carton.id !== bench.current?.id ? () => send({ type: 'close-carton', cartonId: carton.id }) : undefined,
          weigh: carton.closed && carton.garments > 0 && carton.grossKg === null ? () => send({ type: 'close-carton', cartonId: carton.id }) : undefined,
          remove: carton.garments === 0 ? () => send({ type: 'remove-carton', id: carton.id }) : undefined,
        }
      }
      body = (
        <>
          <ShipmentStrip head={head} t={t} d={d} current={bench.current} />
          {holdWords ? (
            <TaskLine tone="danger" icon={<ShieldAlert />} alert>
              {holdWords}
            </TaskLine>
          ) : (
            <ReleasedLine head={head} t={t} />
          )}
          <div className="fw-task-split fw-pack-split">
            <section className="fw-floor-stack" aria-labelledby="fw-pack-carton">
              <h2 id="fw-pack-carton" className="fw-floor-section-title">
                <span className="fw-floor-inline-icon" aria-hidden="true">
                  <Box />
                </span>
                {close ? d('close.title', { seq: close.choice.seq }) : d('scan.label')}
              </h2>
              {close ? (
                <CloseCarton
                  choice={close.choice}
                  types={close.types}
                  suggestedId={close.suggestedId}
                  held={writeHeld ?? (close.held ? d(`close.held.${close.held}`) : null)}
                  overweightMax={close.overweightMax}
                  t={d}
                  locale={locale}
                  onPackaging={(id) => send({ type: 'close-packaging', id })}
                  onWeight={(value) => send({ type: 'close-weight', value })}
                  onConfirm={() => send({ type: 'close-confirm' })}
                />
              ) : (
                <>
                  {scan(d('scan.label'), scanHint, Boolean(bench.hold))}
                  {bench.flash ? <ScanFlashLine key={bench.flash.seq} flash={bench.flash} t={d} locale={locale} /> : null}
                  <KeptScans waiting={bench.kept.waiting} refused={bench.kept.refused} t={d} />
                  {bench.printedMarks ? (
                    <TaskLine tone="success" icon={<CircleCheck />}>
                      {d('marks.printed', { cartons: bench.printedMarks.join(', ') })}
                    </TaskLine>
                  ) : null}
                  {bench.marks ? (
                    <MarksResult
                      note={bench.marks.note}
                      facts={bench.marks.facts}
                      job={bench.marks.job}
                      t={d}
                      held={writeHeld}
                      onAgain={() => (bench.marks?.job === 'FAILED' ? send({ type: 'marks-retry' }) : send({ type: 'marks-print', parcelIds: [bench.marks!.note.cartonId] }))}
                      onPdf={() => send({ type: 'marks-pdf', parcelIds: [bench.marks!.note.cartonId] })}
                    />
                  ) : null}
                  {bench.current ? (
                    <CartonCard carton={bench.current} t={d} locale={locale} takingOut={bench.takeOut?.cartonId === bench.current.id} actions={cartonActions(bench.current)} />
                  ) : (
                    <p className="fw-floor-lead">{d('carton.none')}</p>
                  )}
                </>
              )}
              {!model.online ? (
                <TaskLine tone="warning" icon={<CloudOff />}>
                  {d('offline')}
                </TaskLine>
              ) : null}
              {notice}
            </section>
            <section className="fw-floor-stack" aria-labelledby="fw-pack-grid">
              <h2 id="fw-pack-grid" className="fw-floor-subtitle">
                {d('grid.title', { packed: bench.grid.packed, ordered: bench.grid.ordered })}
              </h2>
              <PackSizeGrid grid={bench.grid} choosing={close ? null : bench.choosing} onChoose={(cellId) => send({ type: 'choose-cell', cellId })} t={d} locale={locale} />
              <h2 className="fw-floor-subtitle">{d('carton.list', { count: bench.cartons.length })}</h2>
              {bench.cartons.length === 0 ? <p className="fw-floor-muted">{d('carton.listEmpty')}</p> : null}
              {others.map((carton) => (
                <CartonCard key={carton.id} carton={carton} t={d} locale={locale} takingOut={bench.takeOut?.cartonId === carton.id} actions={close ? undefined : cartonActions(carton)} />
              ))}
              <LeftList left={bench.left} t={d} />
            </section>
          </div>
        </>
      )
      if (close) bar = actions([{ ...back, label: d('close.cancel'), onPress: () => send({ type: 'close-cancel' }) }])
      else {
        const main = bench.main
        const held = bench.hold ? d('main.held.hold') : writeHeld
        const mainAction: FloorAction =
          main.kind === 'close'
            ? { label: d('main.close', { seq: main.carton.seq }), icon: <Box />, onPress: () => send({ type: 'close-carton', cartonId: main.carton.id }), heldReason: held }
            : main.kind === 'marks'
              ? { label: d('main.marks'), icon: <Printer />, onPress: () => send({ type: 'marks-print' }), heldReason: held }
              : main.kind === 'packed'
                ? { label: d('main.packed'), icon: <PackageCheck />, onPress: () => send({ type: 'packed' }), heldReason: held }
                : { label: bench.current ? d('main.close', { seq: bench.current.seq }) : d('main.packed'), icon: <Box />, onPress: () => undefined, heldReason: held ?? (main.why === null || main.why.kind === 'toScan' ? d('main.held.scan') : leftWords(main.why, d)) }
        const marksDue = main.kind !== 'marks' && bench.left.find((item) => item.kind === 'marks')
        bar = actions([back, marksDue ? { label: d('main.marks'), icon: <Printer />, variant: 'secondary', onPress: () => send({ type: 'marks-print' }), heldReason: held } : null, mainAction])
      }
      break
    }

    case 'documents': {
      const { head, documents } = step
      const labels = documents.labels
      const docs = documents.documents
      const printHeld = offlineHeld ?? busyHeld ?? (documents.printable ? null : t('documents.held.nothing'))
      const printed = documents.jobs.length > 0
      body = (
        <>
          <ShipmentStrip head={head} t={t} d={d} current={null} />
          <div className="fw-task-split">
            <section className="fw-floor-stack" aria-labelledby="fw-pack-labels">
              <h2 id="fw-pack-labels" className="fw-floor-section-title">
                <span className="fw-floor-inline-icon" aria-hidden="true">
                  <Tag />
                </span>
                {t('labels.title')}
              </h2>
              {labels.held === 'notNeeded' ? (
                <TaskLine tone="info" icon={<Truck />}>
                  {t(`labels.notNeeded.${head.transportBy}`)}
                </TaskLine>
              ) : (
                <>
                  <FloorList label={t('labels.title')}>
                    {documents.trackingNumbers.map((entry) => (
                      <FloorListRow key={entry.seq} icon={<Tag />} tone={entry.trackingNumber ? 'success' : 'warning'} title={t('labels.carton', { seq: entry.seq })} meta={entry.trackingNumber ? t('labels.tracking', { number: entry.trackingNumber }) : t('labels.noLabel')} status={entry.trackingNumber ? t('labels.bought') : t('labels.waiting')} />
                    ))}
                  </FloorList>
                  {labels.held ? <HeldLine text={t(`labels.held.${labels.held}`)} /> : <TaskLine tone="success" icon={<CircleCheck />}>{t('labels.ready', { count: labels.labelled })}</TaskLine>}
                </>
              )}
            </section>
            <section className="fw-floor-stack" aria-labelledby="fw-pack-docs">
              <h2 id="fw-pack-docs" className="fw-floor-section-title">
                <span className="fw-floor-inline-icon" aria-hidden="true">
                  <FileText />
                </span>
                {t('documents.title')}
              </h2>
              {docs.ddtNumber ? (
                <TaskCard
                  icon={<FileText />}
                  type={t('documents.ddt')}
                  code={docs.ddtNumber}
                  facts={[
                    { label: t('documents.date'), value: docs.ddtDate ? formatDate(`${docs.ddtDate}T12:00:00Z`, { locale, timeZone: model.timeZone }) : '—' },
                    { label: t('documents.cartons'), value: String(head.cartons) },
                    { label: t('documents.packingList'), value: docs.packingList ? t('documents.yes') : t('documents.no') },
                  ]}
                />
              ) : null}
              {docs.held ? <HeldLine text={t(`documents.held.${docs.held}`)} /> : <TaskLine tone="success" icon={<CircleCheck />}>{docs.packingList ? t('documents.readyBoth') : t('documents.readyDdt')}</TaskLine>}
              <p className="fw-floor-muted">{t('documents.noPreview')}</p>
            </section>
          </div>
          {printed ? (
            <section className="fw-floor-stack" aria-labelledby="fw-pack-jobs">
              <h2 id="fw-pack-jobs" className="fw-floor-subtitle">
                {t('jobs.title')}
              </h2>
              <FloorList label={t('jobs.title')}>
                {documents.jobs.map((job) => (
                  <FloorListRow key={job.id} icon={job.what === 'LABEL' ? <Tag /> : <FileText />} tone={JOB_TONE[job.status]} title={job.what === 'LABEL' ? t('jobs.label', { seq: job.seq ?? 0 }) : t(`jobs.${job.what}`)} meta={job.detail ?? undefined} status={t(`job.${job.status}`)} />
                ))}
              </FloorList>
              {documents.jobs
                .filter((job) => job.status === 'FAILED')
                .map((job) => (
                  <div key={job.id} className="fw-pack-job">
                    <FloorButton size="lg" variant="primary" icon={<RotateCcw />} heldReason={offlineHeld} onClick={() => send({ type: 'retry-job', jobId: job.id })}>
                      {job.what === 'LABEL' ? t('jobs.retryLabel', { seq: job.seq ?? 0 }) : t('jobs.retry', { what: t(`jobs.${job.what}`) })}
                    </FloorButton>
                  </div>
                ))}
            </section>
          ) : null}
          {offlineHeld ? <HeldLine text={offlineHeld} /> : null}
          {notice}
        </>
      )
      // Finish is the main action once something printed, or when nothing can print here (the summary says why).
      const finish = printed || !documents.printable
      bar = actions([
        back,
        { label: t('pack.unpack'), icon: <PackageOpen />, variant: 'secondary', onPress: () => send({ type: 'unpack' }), heldReason: offlineHeld ?? (step.unpackHeld ? t(`unpack.held.${step.unpackHeld}`) : busyHeld) },
        finish ? { label: t('documents.finish'), icon: <CircleCheck />, onPress: () => send({ type: 'finish' }) } : { label: t('documents.print'), icon: <Printer />, onPress: () => send({ type: 'print' }), heldReason: printHeld },
      ])
      break
    }

    case 'done':
      body = <PackedDone summary={step.summary} t={d} />
      bar = [
        { label: tt('action.home'), icon: <House />, variant: 'secondary', onPress: () => send({ type: 'home' }) },
        { label: d('done.next'), icon: <ScanLine />, onPress: () => send({ type: 'next' }) },
      ]
      break
  }

  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={bar ? <FloorActionBar label={t('bar')} actions={bar} /> : undefined}>
      <div className="fw-floor-stack">
        {asOf}
        {body}
      </div>
    </FloorFrameView>
  )
}

// ---- parts ---------------------------------------------------------------------------------------------------------------

/** The shipment on top (design header status: Shipment, Carton n of N): number · state · carrier · the carton scans go into. */
function ShipmentStrip({ head, t, d, current }: { head: PackHead; t: Translate; d: Translate; current: PackCartonView | null }) {
  const parts = [
    head.number,
    t(`status.${head.status}`),
    head.carrier ? t('list.carrier', { carrier: head.carrier }) : t(`transport.${head.transportBy}`),
    current ? d('carton.open', { seq: current.seq }) : t('strip.cartons', { count: head.cartons }),
  ]
  return (
    <p className="fw-pack-strip" role="status">
      <span className="fw-floor-inline-icon" aria-hidden="true">
        <Package />
      </span>
      <span>{parts.join(' · ')}</span>
    </p>
  )
}

/** "Released?" (design gate): the API plans a shipment from released garments only; the batches it names. */
function ReleasedLine({ head, t }: { head: PackHead; t: Translate }) {
  return (
    <TaskLine tone="success" icon={<ShieldCheck />}>
      {head.batches.length > 0 ? t('released.batches', { batches: head.batches.join(', ') }) : t('released.plain')}
    </TaskLine>
  )
}

function NoticeLine({ problem, t, d, tt }: { problem: TaskProblem; t: Translate; d: Translate; tt: Translate }) {
  if (problem.kind === 'refused') {
    // The bench's own refusals in its words; another module's (a W1 route) in the office's.
    const known = d(`refusal.${problem.code}`)
    const words = known === `refusal.${problem.code}` ? `${problem.message} ${problem.fix ?? ''}`.trim() : known
    return (
      <TaskLine tone="danger" icon={<CircleAlert />} alert>
        {t('notice.refused', { words })}
      </TaskLine>
    )
  }
  if (problem.kind === 'conflict' && problem.message) {
    return (
      <TaskLine tone="danger" icon={<CircleAlert />} alert>
        {t('notice.refused', { words: problem.message })}
      </TaskLine>
    )
  }
  if (problem.kind === 'invalid' && problem.path === 'body/printerId') {
    return (
      <TaskLine tone="danger" icon={<CircleAlert />} alert>
        {t('documents.held.noPrinter')}
      </TaskLine>
    )
  }
  const kind = problem.kind === 'stepUp' ? 'forbidden' : problem.kind
  return (
    <TaskLine tone={kind === 'offline' || kind === 'unavailable' ? 'warning' : 'danger'} icon={<CircleAlert />} alert>
      {`${tt(`problem.${kind}.title`)}: ${tt(`problem.${kind}.body`)}`}
    </TaskLine>
  )
}
