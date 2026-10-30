'use client'

import type { ReactNode } from 'react'
import { ArrowLeft, CircleAlert, CircleCheck, CircleMinus, CloudOff, House, Lock, Printer, RotateCcw, ScanLine, ShieldCheck, ShieldX, Tag, Tags, TriangleAlert } from 'lucide-react'
import { LABEL_PRINT_TONE, LabelPreview } from '@nexus/ui/components/LabelPreview/index'
import { FloorActionBar, FloorButton, FloorList, FloorListRow, QuantityPad, ScanInput, SizeButtons, type CameraScanner, type FloorAction, type FloorActions, type FloorTone } from '@nexus/ui/floor'
import { formatDate, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Translate } from '../../../../lib/i18n/messages'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import type { TaskProblem } from '../../shared/task-api'
import { HeldLine, ProblemState, TaskLine } from '../../shared/view/TaskParts'
import type { JobStatus, Refusal, Tracking } from '../api'
import { isWorded, type ColourGroup, type GateModel, type HeldKey, type JobModel, type MainAction, type PrinterChoice, type SizeModel } from '../model'
import type { LabelLayout } from '@nexus/ui/components/LabelPreview/index'
import '../labels.css'

/**
 * SCR-096 — Garment labels at the final operation on the floor tablet (design floor.labels; MES-076, PRD-348, QHS-051).
 * Scan the traveller, a bundle ticket or a garment's serial → the work order's sizes with what is left to label (batch
 * number per work order, or a serial per garment, as the style says) → the certificate gate of the picked size in words
 * (green: the certificate in force covers it; red: no label prints, with the reason and who to tell) → the label as it
 * prints (to scale; the CE mark, the pictogram and the care symbols are stand-ins, said on screen) → Print the size (2
 * taps from the scan) or Print all (1 tap), on the station's label printer, each job's state with Retry; a size
 * already printed asks why before it prints again. Online only (garment labels never queue): offline every print waits
 * with the reason and the last read stays with its time. No money; never a person's name.
 */

export interface OrderModel {
  workOrderId: string
  number: string
  batchNumber: string | null
  style: { code: string; name: string }
  tracking: Tracking
  /** The label template frozen at the release. */
  label: { code: string; revision: number; widthMm: string; heightMm: string } | null
  finalOperation: { seq: number; name: string } | null
}

export type LabelsNote =
  | { kind: 'notHere'; code: string; why: 'otherLabel' | 'otherFactory' | 'typo' | 'notFound' | 'several' }
  | { kind: 'printed'; count: number; sizes: string }
  | { kind: 'reprinted'; count: number; what: string }

export type LabelsStep =
  | { kind: 'loading'; code?: string | null }
  | { kind: 'noPermission' }
  | { kind: 'problem'; problem: TaskProblem; code?: string | null }
  | { kind: 'scan'; note?: LabelsNote | null }
  /** The whole work order prints nothing now (floor not ready, not open, no label template …): full screen. */
  | { kind: 'blocked'; order: OrderModel; refusal: Refusal }
  | {
      kind: 'labels'
      order: OrderModel
      groups: ColourGroup[]
      /** The picked size, its gate and its label (null while it is read). */
      picked: SizeModel | null
      gate: GateModel | null
      preview: LabelLayout | null
      /** The picked size's label is being read (another size was just picked). */
      previewReading: boolean
      previewSample: boolean
      printer: PrinterChoice
      main: MainAction
      all: { count: number; sizes: number; held: HeldKey }
      jobs: JobModel[]
      /** Sizes the last print refused (in their codes' words). */
      refused: Refusal[]
      /** Labels the last print made no job for (the API's words, as data). */
      problems: { what: string; problem: string }[]
      note?: LabelsNote | null
      finished: boolean
    }
  | { kind: 'reprint'; order: OrderModel; size: SizeModel; serial: string | null; count: number; printedAt: string | null; held: HeldKey }
  | { kind: 'done'; number: string; labels: number }

export interface LabelsViewModel {
  frame: FrameModel
  online: boolean
  step: LabelsStep
  /** Shown from what the tablet read before (offline): when. */
  asOf?: string | null
  busy?: boolean
  /** A refused write, said on the step. */
  notice?: TaskProblem | null
  timeZone?: string
}

export const REPRINT_REASONS = ['DAMAGED', 'UNREADABLE', 'LOST', 'JAMMED'] as const
export type ReprintReason = (typeof REPRINT_REASONS)[number]

export type LabelsAction =
  | { type: 'scan'; code: string }
  | { type: 'pick'; cellId: string }
  | { type: 'printer'; printerId: string }
  | { type: 'print' }
  | { type: 'print-all' }
  | { type: 'reprint' }
  | { type: 'reprint-count'; value: number | null }
  | { type: 'reprint-reason'; reason: ReprintReason }
  | { type: 'retry-job'; jobId: string }
  | { type: 'cancel' }
  | { type: 'back' }
  | { type: 'home' }
  | { type: 'retry' }
  | { type: 'finish' }
  | { type: 'next' }

export interface LabelsViewProps {
  model: LabelsViewModel
  onAction?: (action: LabelsAction) => void
  onFrame?: (action: FrameAction) => void
  camera?: CameraScanner
}

const actions = (list: (FloorAction | null | false)[]): FloorActions => list.filter((entry): entry is FloorAction => Boolean(entry)).slice(-3) as unknown as FloorActions

const JOB_TONE: Readonly<Record<JobStatus, FloorTone>> = {
  QUEUED: LABEL_PRINT_TONE.queued,
  SENT: LABEL_PRINT_TONE.sent,
  PRINTED: LABEL_PRINT_TONE.printed,
  FAILED: LABEL_PRINT_TONE.failed,
}

/** The refusal's words: this screen's for a code it knows (with the size and style), else the API's (data). */
function refusalWords(refusal: { code: string; message: string; fix: string }, t: Translate, params: Record<string, string | number>): { title: string; body: string } {
  if (isWorded(refusal.code)) return { title: t(`refusal.${refusal.code}.title`, params), body: t(`refusal.${refusal.code}.body`, params) }
  return { title: refusal.message, body: refusal.fix }
}

export function LabelsView({ model, onAction, onFrame, camera }: LabelsViewProps) {
  const t = useT('floor-labels')
  const tt = useT('floor-tasks')
  const locale = useLocale()
  const send = (action: LabelsAction) => onAction?.(action)
  const { step } = model
  const place = { locale, timeZone: model.timeZone }
  const time = (value: string) => formatTime(value, place)
  const day = (value: string) => formatDate(`${value}T12:00:00Z`, place)
  const held = (key: HeldKey): string | null => (key ? t(`held.${key}`) : null)
  const back: FloorAction = { label: tt('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }), variant: 'secondary' }
  const home: FloorAction = { label: tt('action.home'), icon: <House />, onPress: () => send({ type: 'home' }) }

  let body: ReactNode = null
  let bar: FloorActions | null = null

  const asOf = model.asOf ? (
    <TaskLine tone="info" icon={<CircleMinus />}>
      {tt('asOf', { time: time(model.asOf) })}
    </TaskLine>
  ) : null
  const noticeParams =
    step.kind === 'labels' || step.kind === 'reprint'
      ? { size: (step.kind === 'labels' ? step.picked?.size : step.size.size) ?? '', colour: (step.kind === 'labels' ? step.picked?.colourwayName : step.size.colourwayName) ?? '', style: step.order.style.name, number: step.order.number }
      : { size: '', colour: '', style: '', number: '' }
  const notice = model.notice ? <NoticeLine problem={model.notice} t={t} params={noticeParams} /> : null
  const scan = (hint: string) => (
    <ScanInput
      label={t('scan.label')}
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
      bar = [home]
      break

    case 'problem':
      body = <ProblemState problem={step.problem} code={step.code ?? null} />
      bar = [back, { label: tt('action.retry'), icon: <RotateCcw />, onPress: () => send({ type: 'retry' }) }]
      break

    case 'scan':
      body = (
        <>
          <h2 className="fw-floor-section-title">
            <span className="fw-floor-inline-icon" aria-hidden="true">
              <Tags />
            </span>
            {t('scan.title')}
          </h2>
          <p className="fw-floor-lead">{t('scan.lead')}</p>
          {scan(t('scan.hint'))}
          {step.note ? <NoteLine note={step.note} t={t} /> : null}
        </>
      )
      bar = [home]
      break

    case 'blocked': {
      const words = refusalWords(step.refusal, t, { number: step.order.number, style: step.order.style.name })
      body = (
        <>
          <OrderStrip order={step.order} t={t} />
          <FloorState tone="danger" icon={<ShieldX />} title={words.title} text={words.body} alert>
            <p className="fw-floor-card-code">{step.order.number}</p>
          </FloorState>
        </>
      )
      bar = [home, { label: tt('action.scanAnother'), icon: <ScanLine />, onPress: () => send({ type: 'next' }) }]
      break
    }

    case 'labels': {
      const { order, groups, picked, gate, main } = step
      const cell = picked ? `${picked.colourwayCode} ${picked.size}` : ''
      const params = { size: picked?.size ?? '', colour: picked?.colourwayName ?? '', style: order.style.name, number: order.number }
      const refusedHere = gate?.kind === 'refused' ? refusalWords(gate, t, params) : null
      // A pick still to make comes first (nothing prints before it); once picked, the printer line follows the sizes.
      const needsPick = step.printer.kind === 'pick' && step.printer.picked === null
      const mainLabel =
        main.kind === 'print'
          ? t('print.size', { count: main.count, size: cell })
          : main.kind === 'reprint'
            ? t('reprint.open')
            : main.kind === 'reprintSerial'
              ? t('reprint.openSerial', { serial: main.serial })
              : t('print.nothing')
      body = (
        <>
          <OrderStrip order={order} t={t} />
          {step.note ? <NoteLine note={step.note} t={t} /> : null}
          <div className="fw-task-split">
            <section className="fw-floor-stack" aria-labelledby="fw-labels-sizes">
              <h2 id="fw-labels-sizes" className="fw-floor-section-title">
                <span className="fw-floor-inline-icon" aria-hidden="true">
                  <Tag />
                </span>
                {order.tracking === 'SERIAL' ? t('sizes.titleSerial') : t('sizes.titleBatch')}
              </h2>
              {needsPick ? <PrinterLine choice={step.printer} t={t} send={send} /> : null}
              {groups.map((group) => (
                <SizeButtons
                  key={group.code}
                  label={groups.length > 1 ? t('sizes.colour', { colour: group.name, code: group.code }) : t('sizes.label')}
                  sizes={group.sizes.map((size) => ({ id: size.id, label: size.size, ...(size.labelled > 0 || (size.finished ?? 0) > 0 ? { remaining: size.toLabel } : {}), hint: size.finished === null ? t('sizes.notScanned') : size.finished === 0 ? t('sizes.noneFinished') : t('sizes.of', { count: size.finished }) }))}
                  value={picked && group.sizes.some((size) => size.id === picked.id) ? picked.id : null}
                  onChange={(id) => send({ type: 'pick', cellId: id })}
                  remainingLabel={(count) => t('sizes.toLabel', { count })}
                  doneLabel={t('sizes.done')}
                />
              ))}
              {step.jobs.length > 0 ? <JobList jobs={step.jobs} t={t} send={send} held={model.online ? null : t('held.offline')} /> : null}
              {step.refused.length > 0 ? <RefusedList refused={step.refused} groups={groups} order={order} t={t} /> : null}
              {step.problems.length > 0 ? (
                <ul className="fw-labels-problems" aria-label={t('jobs.notMade')}>
                  {step.problems.map((entry) => (
                    <li key={entry.what}>{t('jobs.problem', { what: entry.what, problem: entry.problem })}</li>
                  ))}
                </ul>
              ) : null}
              {picked && picked.overLabelled > 0 ? (
                <TaskLine tone="warning" icon={<TriangleAlert />}>
                  {t('sizes.overLabelled', { count: picked.overLabelled, size: cell })}
                </TaskLine>
              ) : null}
              {picked && picked.labelled > 0 ? <p className="fw-floor-muted">{[t(order.tracking === 'SERIAL' ? 'sizes.labelledSerial' : 'sizes.labelled', { count: picked.labelled, size: cell }), picked.reprinted > 0 ? t('sizes.again', { count: picked.reprinted }) : null].filter(Boolean).join(' · ')}</p> : null}
              {needsPick ? null : <PrinterLine choice={step.printer} t={t} send={send} />}
              {!model.online ? <HeldLine text={t('held.offline')} /> : null}
              {notice}
            </section>
            <section className="fw-floor-stack" aria-labelledby="fw-labels-gate">
              <h2 id="fw-labels-gate" className="fw-floor-section-title">
                <span className="fw-floor-inline-icon" aria-hidden="true">
                  <ShieldCheck />
                </span>
                {t('gate.title', { size: cell })}
              </h2>
              {refusedHere ? (
                <FloorState tone="danger" icon={<ShieldX />} title={refusedHere.title} text={refusedHere.body} alert />
              ) : gate?.kind === 'covered' ? (
                <TaskLine tone="success" icon={<ShieldCheck />}>
                  {t(gate.ppeClass ? 'gate.coveredClass' : 'gate.covered', { standard: gate.standard, ppeClass: gate.ppeClass ?? '', number: gate.number, until: day(gate.validTo), style: order.style.name, size: cell })}
                </TaskLine>
              ) : gate?.kind === 'notRequired' ? (
                <TaskLine tone="info" icon={<CircleCheck />}>
                  {t('gate.notRequired')}
                </TaskLine>
              ) : null}
              {!refusedHere && step.preview ? (
                <div className="fw-labels-preview">
                  <TaskLine tone="warning" icon={<TriangleAlert />}>
                    {t('preview.standIn')}
                  </TaskLine>
                  <LabelPreview
                    layout={step.preview}
                    scale={5}
                    renderMark={(id) => <StandInMark id={id} />}
                    codeLabel={(value) => t('preview.code', { value })}
                    invalidCodeLabel={(value) => t('preview.invalid', { value })}
                  />
                  {order.tracking === 'SERIAL' ? <p className="fw-floor-muted">{t('preview.serialStandIn')}</p> : null}
                  {step.previewSample ? <p className="fw-floor-muted">{t('preview.sample')}</p> : null}
                </div>
              ) : !refusedHere && picked ? (
                <p className="fw-floor-muted">{step.previewReading ? t('preview.reading') : t('preview.none')}</p>
              ) : null}
            </section>
          </div>
        </>
      )
      const offline = model.online ? null : t('held.offline')
      if (step.finished) {
        bar = actions([back, main.kind === 'reprint' || main.kind === 'reprintSerial' ? { label: mainLabel, icon: <Printer />, variant: 'secondary', onPress: () => send({ type: 'reprint' }), heldReason: held(main.held) } : null, { label: t('finish'), icon: <CircleCheck />, onPress: () => send({ type: 'finish' }) }])
      } else {
        bar = actions([
          back,
          { label: step.all.count > 0 ? t('print.all', { count: step.all.count }) : t('print.allNone'), icon: <Tags />, variant: 'secondary', onPress: () => send({ type: 'print-all' }), heldReason: offline ?? held(step.all.held) },
          main.kind === 'none'
            ? { label: mainLabel, icon: <Printer />, onPress: () => undefined, heldReason: held(main.held) }
            : { label: mainLabel, icon: <Printer />, onPress: () => send({ type: main.kind === 'print' ? 'print' : 'reprint' }), heldReason: offline ?? held(main.held) },
        ])
      }
      break
    }

    case 'reprint': {
      const { size, order } = step
      const cell = `${size.colourwayCode} ${size.size}`
      const question = step.serial
        ? t('reprint.serialQuestion', { serial: step.serial })
        : step.printedAt
          ? t('reprint.questionAt', { count: size.labelled, size: cell, time: time(step.printedAt) })
          : t('reprint.question', { count: size.labelled, size: cell })
      const reasonHeld = model.online ? (model.busy ? t('held.busy') : held(step.held)) : t('held.offline')
      body = (
        <>
          <OrderStrip order={order} t={t} />
          <section className="fw-floor-section" aria-labelledby="fw-labels-reprint">
            <h2 id="fw-labels-reprint" className="fw-floor-section-title">
              <span className="fw-floor-inline-icon" aria-hidden="true">
                <Printer />
              </span>
              {t('reprint.title')}
            </h2>
            <p className="fw-floor-lead">{question}</p>
            <div className="fw-task-reasons" role="group" aria-label={t('reprint.why')}>
              {REPRINT_REASONS.map((reason) => (
                <FloorButton key={reason} size="lg" variant="secondary" block heldReason={reasonHeld} onClick={() => send({ type: 'reprint-reason', reason })}>
                  {t(`reprint.reason.${reason}`)}
                </FloorButton>
              ))}
            </div>
            {!step.serial ? (
              <QuantityPad
                label={t('reprint.count', { size: cell })}
                value={step.count}
                onChange={(value) => send({ type: 'reprint-count', value })}
                unit={t('reprint.unit')}
                min={1}
                max={size.labelled}
                decimals={0}
                showPad={false}
                decrementLabel={t('pad.minus')}
                incrementLabel={t('pad.plus')}
                clearLabel={t('pad.clear')}
                backLabel={t('pad.back')}
                emptyLabel={t('pad.empty')}
                rangeLabel={() => t('reprint.range', { max: size.labelled })}
              />
            ) : null}
            <p className="fw-floor-muted">{t('reprint.logged')}</p>
            {notice}
          </section>
        </>
      )
      bar = [{ label: t('reprint.cancel'), icon: <ArrowLeft />, onPress: () => send({ type: 'cancel' }) }]
      break
    }

    case 'done':
      body = (
        <FloorState tone="success" icon={<CircleCheck />} title={t('done.title', { number: step.number })} text={t('done.body', { count: step.labels })}>
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

function OrderStrip({ order, t }: { order: OrderModel; t: Translate }) {
  const parts = [order.number, order.batchNumber ? t('strip.batch', { batch: order.batchNumber }) : t('strip.noBatch'), `${order.style.code} · ${order.style.name}`, t(`strip.${order.tracking}`)]
  return (
    <p className="fw-labels-strip" role="status">
      <span className="fw-floor-inline-icon" aria-hidden="true">
        <Tags />
      </span>
      <span>{parts.join(' · ')}</span>
    </p>
  )
}

function PrinterLine({ choice, t, send }: { choice: PrinterChoice; t: Translate; send: (action: LabelsAction) => void }) {
  if (choice.kind === 'none') return <HeldLine text={choice.others > 0 ? t('printer.noneFits') : t('printer.none')} />
  if (choice.kind === 'one')
    return (
      <TaskLine tone="info" icon={<Printer />}>
        {t('printer.one', { printer: `${choice.printer.code} · ${choice.printer.name}` })}
      </TaskLine>
    )
  return (
    <div className="fw-labels-printers" role="radiogroup" aria-label={t('printer.pick')}>
      <p className="fw-floor-subtitle">{t('printer.pick')}</p>
      {choice.printers.map((printer) => {
        const picked = choice.picked?.id === printer.id
        return (
          <FloorButton key={printer.id} size="md" variant={picked ? 'primary' : 'secondary'} icon={<Printer />} role="radio" aria-checked={picked} onClick={() => send({ type: 'printer', printerId: printer.id })}>
            {`${printer.code} · ${printer.name}`}
          </FloorButton>
        )
      })}
    </div>
  )
}

function RefusedList({ refused, groups, order, t }: { refused: readonly Refusal[]; groups: readonly ColourGroup[]; order: OrderModel; t: Translate }) {
  const sizeOf = (id: string | null) => groups.flatMap((group) => group.sizes).find((size) => size.id === id)
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-labels-refused">
      <h3 id="fw-labels-refused" className="fw-floor-subtitle">
        {t('refused.title', { count: refused.length })}
      </h3>
      {refused.map((entry, index) => {
        const size = sizeOf(entry.workOrderSizeId)
        const words = refusalWords(entry, t, { size: size?.size ?? '', colour: size?.colourwayName ?? '', style: order.style.name, number: order.number })
        return (
          <TaskLine key={`${entry.code}-${entry.workOrderSizeId ?? index}`} tone="danger" icon={<CircleAlert />}>
            {size ? t('refused.line', { size: `${size.colourwayCode} ${size.size}`, words: `${words.title} ${words.body}` }) : `${words.title} ${words.body}`}
          </TaskLine>
        )
      })}
    </section>
  )
}

function JobList({ jobs, t, send, held }: { jobs: readonly JobModel[]; t: Translate; send: (action: LabelsAction) => void; held: string | null }) {
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-labels-jobs">
      <h3 id="fw-labels-jobs" className="fw-floor-subtitle">
        {t('jobs.title')}
      </h3>
      <FloorList label={t('jobs.title')}>
        {jobs.map((job) => (
          <FloorListRow
            key={job.id}
            icon={<Tag />}
            tone={JOB_TONE[job.status]}
            title={job.serial ? t('jobs.serial', { what: job.what, serial: job.serial }) : t(job.reprint ? 'jobs.batchAgain' : 'jobs.batch', { what: job.what, count: job.copies })}
            meta={job.status === 'FAILED' && job.detail ? job.detail : undefined}
            status={t(`job.${job.status}`)}
          />
        ))}
      </FloorList>
      {jobs
        .filter((job) => job.status === 'FAILED')
        .map((job) => (
          <FloorButton key={job.id} size="lg" variant="primary" icon={<RotateCcw />} heldReason={held} onClick={() => send({ type: 'retry-job', jobId: job.id })}>
            {t('jobs.retry', { what: job.serial ?? job.what })}
          </FloorButton>
        ))}
    </section>
  )
}

function NoteLine({ note, t }: { note: LabelsNote; t: Translate }) {
  if (note.kind === 'notHere')
    return (
      <TaskLine tone="danger" icon={<CircleAlert />} alert>
        {t(`note.${note.why}`, { code: note.code })}
      </TaskLine>
    )
  if (note.kind === 'printed')
    return (
      <TaskLine tone="success" icon={<CircleCheck />}>
        {t('note.printed', { count: note.count, sizes: note.sizes })}
      </TaskLine>
    )
  return (
    <TaskLine tone="success" icon={<CircleCheck />}>
      {t('note.reprinted', { count: note.count, what: note.what })}
    </TaskLine>
  )
}

/** A refused write said on the step, in this screen's words for a rule it knows. */
function NoticeLine({ problem, t, params }: { problem: TaskProblem; t: Translate; params: Record<string, string> }) {
  if (problem.kind === 'refused') {
    const words = isWorded(problem.code) ? { title: t(`refusal.${problem.code}.title`, params), body: t(`refusal.${problem.code}.body`, params) } : { title: problem.message, body: problem.fix ?? '' }
    return (
      <TaskLine tone="danger" icon={<CircleAlert />} alert>
        {`${words.title} ${words.body}`.trim()}
      </TaskLine>
    )
  }
  if (problem.kind === 'offline')
    return (
      <TaskLine tone="warning" icon={<CloudOff />} alert>
        {t('held.offline')}
      </TaskLine>
    )
  return (
    <TaskLine tone="danger" icon={<CircleAlert />} alert>
      {t(`notice.${problem.kind}`)}
    </TaskLine>
  )
}

/**
 * The marks on the preview are STAND-INS (HANDOFF "outside items": the CE mark's official proportions, the EN 17092
 * motorcyclist pictogram and the care symbols are not in Nexus yet): an outlined square with the mark's short name.
 */
function StandInMark({ id }: { id: string }) {
  const text = id === 'CE' ? 'CE' : id === 'MOTORCYCLIST' ? 'EN' : id === 'GLOVE' ? 'EN' : id.startsWith('care-') ? id.slice(5, 7) : id.slice(0, 2)
  return (
    <svg viewBox="0 0 20 20" className="fw-labels-mark" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="18" height="18" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 1.5" />
      <text x="10" y="13.5" textAnchor="middle" fontSize="8" fontWeight="700" fill="currentColor">
        {text}
      </text>
    </svg>
  )
}
