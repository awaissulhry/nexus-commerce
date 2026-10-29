'use client'

import type { ReactNode } from 'react'
import { ArrowLeft, Box, CircleAlert, CircleCheck, CircleMinus, FileText, House, Lock, Package, PackageCheck, PackageOpen, PackagePlus, Printer, RotateCcw, ScanLine, ShieldCheck, Tag, Trash2, Truck } from 'lucide-react'
import { LABEL_PRINT_TONE } from '@nexus/ui/components/LabelPreview/index'
import { FloorActionBar, FloorButton, FloorList, FloorListRow, QuantityPad, ScanInput, type CameraScanner, type FloorAction, type FloorActions, type FloorTone } from '@nexus/ui/floor'
import { formatDate, formatNumber, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Translate } from '../../../../lib/i18n/messages'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import type { TaskProblem } from '../../shared/task-api'
import { HeldLine, ListFooter, ProblemState, TaskCard, TaskLine } from '../../shared/view/TaskParts'
import type { JobStatus } from '../api'
import type { DocumentsState, LeftItem, PackCarton, PackCell, PackShipment, SerialRefusal } from '../model'
import '../pack.css'

/**
 * SCR-098 — the packing bench on the floor tablet (design floor.pack; LOG-002, LOG-039, QHS-073). One shipment at a
 * time: the site's shipments to pack (scan the pack slip, or pick a row: never a customer's name on a shared screen),
 * "Released?" (only garments quality released are on a shipment: the API plans lines from them, and a serial that is
 * not released is refused at the scan), the cartons — scan each garment into the current carton (a serial label, or a
 * batch-tracked garment's label: 0 taps after the scan), "Put the rest" of a size in one tap, Close carton = weigh it,
 * the size grid planned vs packed live — then Packing done; once packed, the carrier labels and the office's DDT and
 * packing list print on the station's printers with one tap (each print job's state with its icon and word, Retry on a
 * failed one), held with the reason while the office has not issued the DDT or bought the labels. Packing needs the
 * network (it is not in the tablet's queue): offline every write waits, with the reason, and the last read stays with
 * its time. No money, never another person.
 */

export interface PackRowModel {
  id: string
  number: string
  status: 'DRAFT' | 'PACKED'
  carrier: string | null
  garments: number
  cartons: number
}

/** The shipment as the bench shows it (model.ts `shipmentModel`). */
export type ShipmentModel = PackShipment

/** What the last scan did, said on the step (never a toast). */
export type ScanNote =
  | { kind: 'packed'; code: string; cell: string; carton: number; rest?: number }
  | { kind: 'refused'; code: string; why: SerialRefusal | 'noRoom' | 'serialTracked' | 'batchDone' | 'unknown' | 'notDraft' | 'offline'; cell?: string | null }

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

export type PackStep =
  | { kind: 'loading'; code?: string | null }
  | { kind: 'noPermission' }
  | { kind: 'problem'; problem: TaskProblem; code?: string | null }
  | { kind: 'list'; rows: PackRowModel[]; scanned?: { code: string; why: 'notFound' | 'serialFirst' } | null }
  | { kind: 'pack'; shipment: ShipmentModel; weigh: { cartonId: string; seq: number; value: number | null } | null; note: ScanNote | null; unpackHeld: 'labelled' | 'ddt' | null }
  | { kind: 'documents'; shipment: ShipmentModel; documents: DocumentsModel; unpackHeld: 'labelled' | 'ddt' | null }
  | { kind: 'done'; number: string; cartons: number; labelsPrinted: boolean }

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
  | { type: 'add-carton' }
  | { type: 'pick-carton'; id: string }
  | { type: 'remove-carton'; id: string }
  | { type: 'put-rest'; cellId: string }
  | { type: 'close-carton' }
  | { type: 'weigh-value'; value: number | null }
  | { type: 'weigh-confirm' }
  | { type: 'weigh-cancel' }
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
  const tt = useT('floor-tasks')
  const locale = useLocale()
  const send = (action: PackAction) => onAction?.(action)
  const { step } = model
  const offlineHeld = model.online ? null : t('offline.held')
  const busyHeld = model.busy ? t('busy') : null
  const back: FloorAction = { label: tt('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }), variant: 'secondary' }
  const time = (value: string) => formatTime(value, { locale, timeZone: model.timeZone })
  const kg = (text: string | null) => (text === null ? '—' : t('carton.kg', { weight: formatNumber(Number.parseFloat(text), locale, { maximumFractionDigits: 2 }) }))

  let body: ReactNode = null
  let bar: FloorActions | null = null

  const asOf = model.asOf ? (
    <TaskLine tone="info" icon={<CircleMinus />}>
      {tt('asOf', { time: time(model.asOf) })}
    </TaskLine>
  ) : null
  const notice = model.notice ? <NoticeLine problem={model.notice} t={t} tt={tt} /> : null
  const scan = (label: string, hint: string) => (
    <ScanInput
      label={label}
      hint={hint}
      scannedLabel={(code) => t('scan.read', { code })}
      keyboardLabel={t('scan.type')}
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
      const { shipment, weigh, note } = step
      const current = shipment.current
      const draft = shipment.status === 'DRAFT'
      const writeHeld = offlineHeld ?? busyHeld
      const left = shipment.left
      body = (
        <>
          <ShipmentStrip shipment={shipment} t={t} />
          <ReleasedLine shipment={shipment} t={t} />
          {!draft ? (
            <TaskLine tone="info" icon={<PackageCheck />}>
              {t('pack.alreadyPacked')}
            </TaskLine>
          ) : null}
          <div className="fw-task-split fw-pack-split">
            <section className="fw-floor-stack" aria-labelledby="fw-pack-carton">
              <h2 id="fw-pack-carton" className="fw-floor-section-title">
                <span className="fw-floor-inline-icon" aria-hidden="true">
                  <Box />
                </span>
                {current ? t('carton.current', { seq: current.seq, count: shipment.cartons.length }) : t('carton.none')}
              </h2>
              {weigh ? (
                <QuantityPad
                  label={t('weigh.label', { seq: weigh.seq })}
                  value={weigh.value}
                  onChange={(value) => send({ type: 'weigh-value', value })}
                  unit={t('weigh.unit')}
                  min={0.01}
                  max={999}
                  decimals={2}
                  decimalSeparator={locale === 'it' ? ',' : '.'}
                  separatorLabel={t('weigh.separator')}
                  decrementLabel={t('pad.minus')}
                  incrementLabel={t('pad.plus')}
                  clearLabel={t('pad.clear')}
                  backLabel={t('pad.back')}
                  emptyLabel={t('weigh.empty')}
                  rangeLabel={() => t('weigh.range')}
                  onConfirm={() => send({ type: 'weigh-confirm' })}
                  confirmLabel={t('weigh.save')}
                  confirmHeldReason={writeHeld}
                  autoFocus
                />
              ) : (
                <>
                  {draft ? scan(t('pack.scan'), current ? t('pack.hint', { seq: current.seq }) : t('pack.hintNew')) : null}
                  {note ? <ScanNoteLine note={note} t={t} /> : null}
                  {current ? <CartonCard carton={current} t={t} kg={kg} current /> : <p className="fw-floor-lead">{draft ? t('carton.noneLead') : t('carton.noneDone')}</p>}
                  {draft ? <RestButtons cells={shipment.cells} t={t} send={send} held={writeHeld} /> : null}
                </>
              )}
              {offlineHeld ? <HeldLine text={offlineHeld} /> : null}
              {notice}
            </section>
            <section className="fw-floor-stack" aria-labelledby="fw-pack-grid">
              <h2 id="fw-pack-grid" className="fw-floor-subtitle">
                {t('grid.title', { packed: shipment.packed, garments: shipment.garments })}
              </h2>
              <PackGrid grid={shipment.grid} t={t} />
              <h2 className="fw-floor-subtitle">{t('cartons.title', { count: shipment.cartons.length })}</h2>
              {shipment.cartons.length === 0 ? <p className="fw-floor-muted">{t('cartons.empty')}</p> : null}
              {shipment.cartons.map((carton) => (
                <CartonCard key={carton.id} carton={carton} t={t} kg={kg} current={carton.id === current?.id} onPick={draft && carton.id !== current?.id && !carton.labelled ? () => send({ type: 'pick-carton', id: carton.id }) : undefined} onRemove={draft && carton.garments === 0 && !carton.labelled ? () => send({ type: 'remove-carton', id: carton.id }) : undefined} held={writeHeld} />
              ))}
              {left.length > 0 ? (
                <ul className="fw-pack-left" aria-label={t('left.title')}>
                  {left.map((item) => (
                    <li key={item.kind}>{leftWords(item, t)}</li>
                  ))}
                </ul>
              ) : draft ? (
                <TaskLine tone="success" icon={<CircleCheck />}>
                  {t('left.none')}
                </TaskLine>
              ) : null}
            </section>
          </div>
        </>
      )
      // The pad confirms the weight (its button and Enter); the bar only steps back.
      if (weigh) bar = actions([{ ...back, label: t('weigh.cancel'), onPress: () => send({ type: 'weigh-cancel' }) }])
      else if (!draft) bar = actions([back, { label: t('documents.open'), icon: <Printer />, onPress: () => send({ type: 'documents' }) }])
      else {
        const done = left.length === 0
        const closable = current !== null && current.garments > 0
        bar = actions([
          back,
          { label: t('carton.add'), icon: <PackagePlus />, variant: 'secondary', onPress: () => send({ type: 'add-carton' }), heldReason: writeHeld },
          done
            ? { label: t('pack.done'), icon: <PackageCheck />, onPress: () => send({ type: 'packed' }), heldReason: writeHeld }
            : { label: t('carton.close'), icon: <Box />, onPress: () => send({ type: 'close-carton' }), heldReason: writeHeld ?? (closable ? null : current ? t('carton.held.empty') : t('carton.held.none')) },
        ])
      }
      break
    }

    case 'documents': {
      const { shipment, documents } = step
      const labels = documents.labels
      const docs = documents.documents
      const printHeld = offlineHeld ?? busyHeld ?? (documents.printable ? null : t('documents.held.nothing'))
      const printed = documents.jobs.length > 0
      body = (
        <>
          <ShipmentStrip shipment={shipment} t={t} />
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
                  {t(`labels.notNeeded.${shipment.transportBy}`)}
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
                    { label: t('documents.cartons'), value: String(shipment.cartons.length) },
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
      bar = actions([
        back,
        { label: t('pack.unpack'), icon: <PackageOpen />, variant: 'secondary', onPress: () => send({ type: 'unpack' }), heldReason: offlineHeld ?? (step.unpackHeld ? t(`unpack.held.${step.unpackHeld}`) : busyHeld) },
        printed ? { label: t('documents.finish'), icon: <CircleCheck />, onPress: () => send({ type: 'finish' }) } : { label: t('documents.print'), icon: <Printer />, onPress: () => send({ type: 'print' }), heldReason: printHeld },
      ])
      break
    }

    case 'done':
      body = (
        <FloorState tone="success" icon={<PackageCheck />} title={t('done.title', { number: step.number })} text={step.labelsPrinted ? t('done.bodyLabels', { count: step.cartons }) : t('done.body', { count: step.cartons })}>
          <p className="fw-floor-card-code">{step.number}</p>
        </FloorState>
      )
      bar = [
        { label: tt('action.home'), icon: <House />, variant: 'secondary', onPress: () => send({ type: 'home' }) },
        { label: t('done.next'), icon: <ScanLine />, onPress: () => send({ type: 'next' }) },
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

function ShipmentStrip({ shipment, t }: { shipment: ShipmentModel; t: Translate }) {
  const parts = [shipment.number, t(`status.${shipment.status}`), shipment.carrier ? t('list.carrier', { carrier: shipment.carrier }) : t(`transport.${shipment.transportBy}`), t('strip.cartons', { count: shipment.cartons.length })]
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
function ReleasedLine({ shipment, t }: { shipment: ShipmentModel; t: Translate }) {
  return (
    <TaskLine tone="success" icon={<ShieldCheck />}>
      {shipment.batches.length > 0 ? t('released.batches', { batches: shipment.batches.join(', ') }) : t('released.plain')}
    </TaskLine>
  )
}

function ScanNoteLine({ note, t }: { note: ScanNote; t: Translate }) {
  if (note.kind === 'packed') {
    return (
      <TaskLine tone="success" icon={<CircleCheck />}>
        {note.rest ? t('note.rest', { count: note.rest, cell: note.cell, seq: note.carton }) : t('note.packed', { code: note.code, cell: note.cell, seq: note.carton })}
      </TaskLine>
    )
  }
  return (
    <TaskLine tone="danger" icon={<CircleAlert />} alert>
      <strong className="fw-pack-code">{note.code}</strong> {t(`refused.${note.why}`, { cell: note.cell ?? '' })}
    </TaskLine>
  )
}

function CartonCard({ carton, t, kg, current, onPick, onRemove, held }: { carton: PackCarton; t: Translate; kg: (text: string | null) => string; current?: boolean; onPick?: () => void; onRemove?: () => void; held?: string | null }) {
  const state = carton.labelled ? t('carton.labelled') : carton.weightKg !== null ? t('carton.closed') : t('carton.open')
  const tone: FloorTone = carton.labelled ? 'info' : carton.weightKg !== null ? 'success' : current ? 'primary' : 'neutral'
  return (
    <section className="fw-floor-card fw-pack-carton" data-current={current ? 'true' : undefined} aria-labelledby={`fw-pack-carton-${carton.id}`}>
      <header className="fw-floor-card-head">
        <span className="fw-floor-card-icon" aria-hidden="true">
          <Box />
        </span>
        <span className="fw-floor-card-title">
          <span className="fw-floor-card-type">{current ? t('carton.thisOne') : t('carton.type')}</span>
          <span id={`fw-pack-carton-${carton.id}`} className="fw-floor-card-code">
            {t('carton.seq', { seq: carton.seq })}
          </span>
        </span>
        <span className="fw-task-big">
          <span className="fw-task-big-value">{carton.garments}</span>
          <span className="fw-task-big-label">{t('list.garments')}</span>
        </span>
        <span className="fw-floor-pill" data-tone={tone}>
          {state}
        </span>
      </header>
      <p className="fw-floor-muted">
        {carton.contents.length > 0 ? carton.contents.map((entry) => (entry.serials > 0 ? t('carton.lineSerials', { cell: entry.label, count: entry.quantity, serials: entry.serials }) : t('carton.line', { cell: entry.label, count: entry.quantity }))).join(' · ') : t('carton.empty')}
        {' · '}
        {carton.weightKg !== null ? kg(carton.weightKg) : t('carton.notWeighed')}
        {carton.trackingNumber ? ` · ${t('labels.tracking', { number: carton.trackingNumber })}` : ''}
      </p>
      {onPick || onRemove ? (
        <div className="fw-floor-row-actions fw-pack-carton-actions">
          {onRemove ? (
            <FloorButton size="md" variant="secondary" icon={<Trash2 />} heldReason={held ?? null} onClick={onRemove}>
              {t('carton.remove')}
            </FloorButton>
          ) : null}
          {onPick ? (
            <FloorButton size="md" variant="secondary" icon={<Box />} heldReason={held ?? null} onClick={onPick}>
              {t('carton.pick')}
            </FloorButton>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

/** One tap per size still out of a carton: "Put the rest of RED 52 in this carton" (batch-tracked garments only). */
function RestButtons({ cells, t, send, held }: { cells: readonly PackCell[]; t: Translate; send: (action: PackAction) => void; held: string | null }) {
  const open = cells.filter((cell) => cell.loose > 0 && !cell.serialTracked)
  const serial = cells.filter((cell) => cell.loose > 0 && cell.serialTracked)
  if (open.length === 0 && serial.length === 0) return null
  return (
    <div className="fw-floor-stack">
      {open.length > 0 ? (
        <div className="fw-pack-rest" role="group" aria-label={t('rest.title')}>
          {open.map((cell) => (
            <FloorButton key={cell.id} size="md" variant="secondary" icon={<PackagePlus />} heldReason={held} onClick={() => send({ type: 'put-rest', cellId: cell.id })}>
              {t('rest.put', { count: cell.loose, cell: `${cell.styleCode} ${cell.colourwayCode} ${cell.size}` })}
            </FloorButton>
          ))}
        </div>
      ) : null}
      {serial.map((cell) => (
        <TaskLine key={cell.id} tone="info" icon={<ScanLine />}>
          {t('rest.serials', { count: cell.loose, cell: `${cell.styleCode} ${cell.colourwayCode} ${cell.size}` })}
        </TaskLine>
      ))}
    </div>
  )
}

/** Stand-in for the design's SizeGridView at floor density: per style and colour, each size's packed of planned. */
function PackGrid({ grid, t }: { grid: ShipmentModel['grid']; t: Translate }) {
  return (
    <table className="fw-pack-grid">
      <caption className="fw-pack-sr">{t('grid.caption')}</caption>
      <thead>
        <tr>
          <th scope="col">{t('grid.style')}</th>
          {grid.sizes.map((size) => (
            <th key={size} scope="col">
              {size}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {grid.rows.map((row) => (
          <tr key={row.key}>
            <th scope="row">{row.label}</th>
            {row.sizes.map((cell) => (
              <td key={cell.size} data-state={cell.planned === 0 ? 'none' : cell.packed >= cell.planned ? 'done' : cell.packed > 0 ? 'part' : 'todo'}>
                {cell.planned === 0 ? '—' : t('grid.cell', { packed: cell.packed, planned: cell.planned })}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function leftWords(item: LeftItem, t: Translate): string {
  switch (item.kind) {
    case 'noLines':
      return t('left.noLines')
    case 'loose':
      return t('left.loose', { count: item.count })
    case 'noCartons':
      return t('left.noCartons')
    case 'unweighed':
      return t('left.unweighed', { cartons: item.seqs.join(', ') })
    case 'empty':
      return t('left.empty', { cartons: item.seqs.join(', ') })
    case 'serials':
      return t('left.serials', { count: item.count })
  }
}

function NoticeLine({ problem, t, tt }: { problem: TaskProblem; t: Translate; tt: Translate }) {
  if (problem.kind === 'refused' || (problem.kind === 'conflict' && problem.message)) {
    const message = problem.kind === 'refused' ? `${problem.message} ${problem.fix ?? ''}`.trim() : (problem.message ?? '')
    return (
      <TaskLine tone="danger" icon={<CircleAlert />} alert>
        {t('notice.refused', { words: message })}
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
