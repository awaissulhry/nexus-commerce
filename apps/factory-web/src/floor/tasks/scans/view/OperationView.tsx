'use client'

import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowLeft, Check, CircleAlert, CircleCheckBig, ClipboardPen, Clock, CloudOff, House, Layers, MessageSquareWarning, ScanLine, Send, ShieldOff, TriangleAlert, Wrench, X } from 'lucide-react'
import { FloorActionBar, FloorButton, FloorList, FloorListRow, FloorTile, FloorTileGrid, QuantityPad, ScanInput, type CameraScanner, type FloorAction, type FloorActions } from '@nexus/ui/floor'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { formatNumber, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Translate } from '../../../../lib/i18n/messages'
import type { Locale } from '../../../../lib/i18n/locales'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import type { LabelType } from '../../../scan/scan-model'
import type { TaskProblem } from '../../shared/task-api'
import { HeldLine, ListFooter, ProblemState, TaskCard, TaskLine, Ticks, UndoStrip, type TickState } from '../../shared/view/TaskParts'
import { fromScanReason } from '../../reasons/model'
import { ReasonPickerBody, type ReasonPickerAction, type ReasonPickerModel } from '../../reasons/view/ReasonPicker'
import {
  CORRECTION_REASONS,
  finishHeld,
  goodOf,
  KNOWN_REFUSALS,
  maxGood,
  nextOpen,
  reworkOf,
  scrapOf,
  correctionHeld,
  totalOfTarget,
  type BundleCard,
  type CardOperation,
  type CardReason,
  type CardReport,
  type CorrectionReason,
  type CorrectionTarget,
  type Counts,
  type DefectKind,
} from '../model'
import '../scans.css'

/**
 * SCR-090 — Operation (design floor.operation; MES-069, MES-090, MES-095, MES-096; Owner answers F2, F3): scan the
 * bundle's ticket, check it is the right one at a glance, report good, scrap and rework in the fewest taps (all good =
 * one tap on Finish), see it saved on this tablet and then recorded by the office, undo it until the next scan or two
 * minutes, then ask a correction. One job per step; the frame's banner says what waits for the network. Never another
 * person's numbers or name (Statuto dei Lavoratori art. 4), never money.
 */

export type CountsOpen = 'scrap' | 'rework' | 'good' | null

export type OperationStep =
  | { readonly kind: 'scan' }
  | { readonly kind: 'loading'; readonly code: string }
  | { readonly kind: 'pick'; readonly card: BundleCard; readonly options: readonly CardOperation[]; readonly asOf: string | null }
  | { readonly kind: 'counts'; readonly card: BundleCard; readonly operation: CardOperation; readonly counts: Counts; readonly open: CountsOpen; readonly asOf: string | null; readonly problem?: 'atMost' | null; readonly busy?: boolean }
  | { readonly kind: 'already'; readonly card: BundleCard; readonly operation: CardOperation; readonly report: CardReport; readonly undo: boolean }
  | { readonly kind: 'refused'; readonly code: string; readonly message: string; readonly fix: string | null; readonly card: BundleCard | null; readonly scanned: string }
  | { readonly kind: 'wrongType'; readonly type: LabelType; readonly code: string }
  | { readonly kind: 'notOnTablet'; readonly code: string }
  /** Another factory's label, or a misread code. */
  | { readonly kind: 'unknownCode'; readonly reason: 'otherFactory' | 'typo'; readonly code: string }
  | { readonly kind: 'problem'; readonly problem: TaskProblem; readonly code: string | null }
  | { readonly kind: 'corrections'; readonly targets: readonly CorrectionTarget[] | null; readonly offline: boolean; readonly problem?: TaskProblem | null }
  | { readonly kind: 'correct'; readonly target: CorrectionTarget; readonly counts: Counts; readonly open: CountsOpen; readonly reason: CorrectionReason | null; readonly reasons: readonly CardReason[]; readonly problem?: 'atMost' | null }
  | { readonly kind: 'asked'; readonly target: CorrectionTarget; readonly ticks: TickState }
  | { readonly kind: 'noPermission' }

/** The last report made on this tablet, as the strip on top shows it. */
export interface LastStrip {
  readonly bundleCode: string
  readonly operationSeq: number
  readonly good: number
  readonly scrap: number
  readonly rework: number
  readonly ticks: TickState | null
  /** open: Undo; closed: Ask a correction; undone: the undo's own ticks. */
  readonly undo: 'open' | 'closed' | 'undone'
  readonly undoTicks?: TickState | null
  /** The refusal's words when the office refused it. */
  readonly refusal?: string | null
}

export interface OperationViewModel {
  frame: FrameModel
  step: OperationStep
  last?: LastStrip | null
  /** The report was just made: the big receipt shows above the next scan. */
  receipt?: boolean
  online: boolean
  /** The worker notice holds scans. */
  held?: boolean
  /** "Leave this count?" (a scan while counts are typed). */
  leave?: { readonly bundleCode: string; readonly operationSeq: number; readonly scrap: number; readonly rework: number } | null
  timeZone?: string
}

export type OperationAction =
  | { type: 'scan'; code: string }
  | { type: 'pick'; operationId: string }
  | { type: 'reason'; kind: DefectKind; code: string }
  | { type: 'unreason'; kind: DefectKind; code: string }
  | { type: 'open'; what: CountsOpen }
  | { type: 'good'; value: number | null }
  | { type: 'finish' }
  | { type: 'back' }
  | { type: 'undo' }
  | { type: 'undoReport'; scanId: string }
  | { type: 'corrections' }
  | { type: 'target'; key: string }
  | { type: 'correctionReason'; reason: CorrectionReason }
  | { type: 'send' }
  | { type: 'retry' }
  | { type: 'home' }
  | { type: 'leave'; leave: boolean }

export interface OperationViewProps {
  model: OperationViewModel
  onAction?: (action: OperationAction) => void
  onFrame?: (action: FrameAction) => void
  camera?: CameraScanner
}

const KNOWN = new Set<string>(KNOWN_REFUSALS)

/** "19 good · 1 scrap · 1 rework" (zeros of scrap and rework left out). */
export function countsText(t: Translate, counts: { good: number; scrap: number; rework: number }): string {
  const parts = [t('count.good', { count: counts.good })]
  if (counts.scrap > 0) parts.push(t('count.scrap', { count: counts.scrap }))
  if (counts.rework > 0) parts.push(t('count.rework', { count: counts.rework }))
  return parts.join(' · ')
}

/** The kind of reasons the open counter asks (Scrap or Rework opens the reason picker, SCR-091), or null. */
export function pickerKindOf(open: CountsOpen): DefectKind | null {
  return open === 'scrap' ? 'SCRAP' : open === 'rework' ? 'REWORK' : null
}

/**
 * The reason picker (SCR-091) over the bundle card's reasons (W2a: the illustrated picker; design floor.operation
 * "counts"): what it is for ("Scrap · the bundle · Op 20 …") and the running count, each tap one piece with that reason.
 */
export function pickerOf(input: { bundleCode: string; operation: { seq: number; name: string }; kind: DefectKind; reasons: readonly CardReason[]; counts: Counts; expected: number; problem: 'atMost' | null }): ReasonPickerModel {
  return {
    purpose: input.kind === 'SCRAP' ? 'scrap' : 'rework',
    subject: `${input.bundleCode} · Op ${input.operation.seq} ${input.operation.name}`,
    reasons: input.reasons.filter((reason) => reason.kind === input.kind).map(fromScanReason),
    counts: input.kind === 'SCRAP' ? input.counts.scrap : input.counts.rework,
    of: input.expected,
    problem: input.problem,
  }
}

export function OperationView({ model, onAction, onFrame, camera }: OperationViewProps) {
  const t = useT('floor-scans')
  const shared = useT('floor-tasks')
  const floor = useT('floor')
  const locale = useLocale()
  const reasonsT = useT('floor-reasons')
  const send = (action: OperationAction) => onAction?.(action)
  // A tap on a reason tile adds one piece with that reason; − on the tile takes one off (reason-first counting).
  const pickerSend = (kind: DefectKind) => (action: ReasonPickerAction) => {
    if (action.type === 'count') send({ type: action.delta > 0 ? 'reason' : 'unreason', kind, code: action.id })
  }
  const { step } = model
  const time = (value: string) => formatTime(value, { locale, timeZone: model.timeZone })
  const statusWord = (status: string) => {
    const key = `status.workOrder.${status}`
    const word = floor(key)
    return word === key ? status : word
  }

  const home: FloorAction = { label: shared('action.home'), icon: <House />, onPress: () => send({ type: 'home' }) }
  const scanAnother: FloorAction = { label: shared('action.scanAnother'), icon: <ScanLine />, onPress: () => send({ type: 'back' }) }

  let actions: FloorActions | null = null
  let body: ReactNode = null

  // The scan field is the scan step's job. On every other step the container reads a scanner's burst without a field
  // (DS createWedgeReader): a scan while counts are typed asks "Leave this count?" first.
  const scanField = () => (
    <ScanInput
      label={t('scan.label')}
      hint={model.held ? floor('tile.held.notice') : t('scan.hint')}
      scannedLabel={(code) => floor('scan.read', { code })}
      keyboardLabel={floor('scan.type')}
      disabled={Boolean(model.held)}
      camera={camera ? { scanner: camera, startLabel: floor('scan.camera.start'), stopLabel: floor('scan.camera.stop'), errorLabel: floor('scan.camera.error') } : undefined}
      onScan={(code) => send({ type: 'scan', code })}
    />
  )

  const refusalWords = (params: Record<string, string | number>) => (code: string) => (KNOWN.has(code) ? { message: t(`refusal.${code}.message`, params), fix: t(`refusal.${code}.fix`, params) } : null)

  switch (step.kind) {
    case 'noPermission':
      actions = [home]
      body = <FloorState tone="warning" icon={<ShieldOff />} title={t('noPermission.title')} text={t('noPermission.body')} alert />
      break

    case 'scan':
      body = (
        <>
          {model.receipt && model.last ? <Receipt last={model.last} t={t} shared={shared} send={send} /> : null}
          {scanField()}
          {model.held ? (
            <TaskLine tone="warning" icon={<TriangleAlert />}>
              {floor('tile.held.notice')}
            </TaskLine>
          ) : (
            <div className="fw-scans-invite">
              <span className="fw-floor-hero" aria-hidden="true">
                <Layers />
              </span>
              <p className="fw-floor-lead">{t('scan.empty')}</p>
            </div>
          )}
        </>
      )
      actions = [home, { label: t('correction.open'), icon: <ClipboardPen />, onPress: () => send({ type: 'corrections' }), variant: 'secondary' }]
      break

    case 'loading':
      body = (
        <>
          <div className="fw-floor-card" aria-busy="true">
            <p className="fw-floor-card-code">{step.code}</p>
            <p className="fw-floor-muted">{t('scan.loading')}</p>
          </div>
        </>
      )
      break

    case 'wrongType':
      actions = [home, scanAnother]
      body = (
        <>
          <FloorState tone="danger" icon={<CircleAlert />} title={t('wrongType.title', { type: floor(`label.${step.type}`) })} text={t('wrongType.body')} alert>
            <p className="fw-floor-card-code">{step.code}</p>
          </FloorState>
        </>
      )
      break

    case 'unknownCode':
      actions = [home, scanAnother]
      body = (
        <FloorState tone="danger" icon={<CircleAlert />} title={t(`unknownCode.${step.reason}.title`)} text={t(`unknownCode.${step.reason}.body`)} alert>
          <p className="fw-floor-card-code">{step.code}</p>
        </FloorState>
      )
      break

    case 'notOnTablet':
      actions = [home, scanAnother]
      body = (
        <>
          <FloorState tone="warning" icon={<CloudOff />} title={shared('notOnTablet.title')} text={t('notOnTablet.body')} alert>
            <p className="fw-floor-card-code">{step.code}</p>
          </FloorState>
        </>
      )
      break

    case 'problem':
      actions = [scanAnother, { label: shared('action.retry'), icon: <ScanLine />, onPress: () => send({ type: 'retry' }) }]
      body = (
        <>
          <ProblemState problem={step.problem} code={step.code} words={refusalWords({ code: step.code ?? '' })} />
        </>
      )
      break

    case 'refused': {
      const card = step.card
      const next = card ? nextOpen(card) : null
      const params = {
        code: card?.bundle.code ?? step.scanned,
        scanned: step.scanned,
        number: card?.workOrder.number ?? '',
        status: card ? statusWord(card.workOrder.status).toLocaleLowerCase(locale) : '',
        seq: next?.seq ?? '',
        operation: next ? `${next.code} · ${next.name}` : '',
      }
      actions = [home, scanAnother]
      body = (
        <>
          <ProblemState problem={{ kind: 'refused', code: step.code, message: step.message || t('refusal.fallback'), fix: step.fix }} code={step.scanned} words={refusalWords(params)} />
        </>
      )
      break
    }

    case 'already': {
      const { report, operation } = step
      const where = report.station ? t('already.station', { station: report.station.code }) : ''
      const counts = countsText(t, { good: report.goodQuantity, scrap: report.scrapQuantity, rework: report.reworkQuantity })
      actions = report.own
        ? [scanAnother, step.undo ? { label: shared('undo.label'), icon: <ArrowLeft />, onPress: () => send({ type: 'undoReport', scanId: report.scanId }) } : { label: shared('undo.ask'), icon: <ClipboardPen />, onPress: () => send({ type: 'corrections' }) }]
        : [home, scanAnother]
      body = (
        <>
          <FloorState
            tone={report.own ? 'info' : 'warning'}
            icon={report.own ? <Clock /> : <CircleAlert />}
            title={report.own ? t('already.own.title', { seq: operation.seq, time: time(report.serverTime) }) : t('already.other.title', { seq: operation.seq, time: time(report.serverTime), where })}
            text={report.own ? (step.undo ? t('already.own.undo') : t('already.own.ask')) : t('already.other.body')}
            alert={!report.own}
          >
            <p className="fw-floor-card-code">{step.card.bundle.code}</p>
            {/* Own counts only: another person's numbers are never shown (art. 4, F2). */}
            {report.own ? <p className="fw-floor-state-text">{counts}</p> : null}
          </FloorState>
        </>
      )
      break
    }

    case 'pick':
      actions = [scanAnother]
      body = (
        <>
          <div className="fw-task-split">
            <BundleFacts card={step.card} operation={null} asOf={step.asOf} t={t} shared={shared} locale={locale} time={time} />
            <section className="fw-floor-stack" aria-labelledby="fw-scans-pick">
              <h2 id="fw-scans-pick" className="fw-floor-section-title">
                {t('pick.title')}
              </h2>
              <PickTiles options={step.options} t={t} onPick={(operationId) => send({ type: 'pick', operationId })} />
            </section>
          </div>
        </>
      )
      break

    case 'counts': {
      const expected = step.operation.expected ?? step.card.bundle.quantity
      const good = goodOf(step.counts, expected)
      const held = finishHeld(step.counts, step.operation.expected)
      const heldWords = held ? t(`finish.held.${held}`, { count: expected }) : step.busy ? t('finish.busy') : null
      const kind = pickerKindOf(step.open)
      if (kind) {
        // Scrap or Rework opened the reason picker: Done goes back to the counts, Finish stays one tap away.
        actions = [
          { label: reasonsT('done'), icon: <ArrowLeft />, variant: 'secondary', onPress: () => send({ type: 'open', what: null }) },
          { label: t('finish.label', { count: good }), icon: <Check />, onPress: () => send({ type: 'finish' }), heldReason: heldWords },
        ]
        const picker = pickerOf({ bundleCode: step.card.bundle.code, operation: step.operation, kind, reasons: step.card.reasons, counts: step.counts, expected, problem: step.problem ?? null })
        body = (
          <>
            {model.last ? <LastLine last={model.last} t={t} shared={shared} send={send} /> : null}
            <ReasonPickerBody model={picker} onAction={pickerSend(kind)} onBack={() => send({ type: 'open', what: null })} timeZone={model.timeZone} />
          </>
        )
        break
      }
      actions = [
        { label: t('counts.scrap'), icon: <TriangleAlert />, variant: step.open === 'scrap' ? 'warning' : 'secondary', onPress: () => send({ type: 'open', what: step.open === 'scrap' ? null : 'scrap' }) },
        { label: t('counts.rework'), icon: <Wrench />, variant: step.open === 'rework' ? 'warning' : 'secondary', onPress: () => send({ type: 'open', what: step.open === 'rework' ? null : 'rework' }) },
        { label: t('finish.label', { count: good }), icon: <Check />, onPress: () => send({ type: 'finish' }), heldReason: heldWords },
      ]
      body = (
        <>
          {model.last ? <LastLine last={model.last} t={t} shared={shared} send={send} /> : null}
          <div className="fw-task-split">
            <BundleFacts card={step.card} operation={step.operation} asOf={step.asOf} t={t} shared={shared} locale={locale} time={time} />
            <CountsPanel counts={step.counts} expected={expected} open={step.open} problem={step.problem ?? null} t={t} locale={locale} send={send} />
          </div>
        </>
      )
      break
    }

    case 'corrections': {
      actions = [scanAnother]
      const rows = step.targets
      body = (
        <section className="fw-floor-stack" aria-labelledby="fw-scans-corrections">
          <h2 id="fw-scans-corrections" className="fw-floor-section-title">
            {t('correction.listTitle')}
          </h2>
          {step.offline ? <HeldLine text={t('correction.offline')} /> : null}
          {step.problem ? <ProblemState problem={step.problem} /> : null}
          {rows === null && !step.problem ? (
            <p className="fw-floor-muted" aria-busy="true">
              {t('correction.loading')}
            </p>
          ) : null}
          {rows && rows.length === 0 && !step.offline ? <FloorState tone="info" icon={<ClipboardPen />} title={t('correction.empty.title')} text={t('correction.empty.body')} /> : null}
          {rows && rows.length > 0 ? (
            <>
              <FloorList label={t('correction.listTitle')}>
                {rows.map((row) => (
                  <FloorListRow
                    key={row.key}
                    icon={<Layers />}
                    tone={row.pending ? 'info' : 'neutral'}
                    title={
                      <span>
                        <span className="fw-floor-code">{row.bundleCode}</span> · {t('opCode', { seq: row.operation.seq, code: row.operation.code })}
                      </span>
                    }
                    meta={`${countsText(t, { good: row.good, scrap: sumOf(row.scrap), rework: sumOf(row.rework) })} · ${time(row.at)}`}
                    status={row.pending ? t('correction.pending') : undefined}
                    heldReason={row.pending ? t('correction.pending') : null}
                    onPress={() => send({ type: 'target', key: row.key })}
                  />
                ))}
              </FloorList>
              <ListFooter
                count={t('correction.count', { count: rows.length })}
                keys={[
                  { key: 'Tab', does: shared('keys.tab') },
                  { key: 'Enter', does: shared('keys.enter') },
                  { key: 'Esc', does: shared('keys.escape') },
                ]}
              />
            </>
          ) : null}
        </section>
      )
      break
    }

    case 'correct': {
      const expected = totalOfTarget(step.target)
      const held = correctionHeld(step.target, step.counts, step.reason)
      const kind = pickerKindOf(step.open)
      if (kind) {
        actions = [{ label: reasonsT('done'), icon: <Check />, onPress: () => send({ type: 'open', what: null }) }]
        const picker = pickerOf({ bundleCode: step.target.bundleCode, operation: step.target.operation, kind, reasons: step.reasons, counts: step.counts, expected, problem: step.problem ?? null })
        body = <ReasonPickerBody model={picker} onAction={pickerSend(kind)} onBack={() => send({ type: 'open', what: null })} timeZone={model.timeZone} />
        break
      }
      actions = [
        { label: shared('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'corrections' }) },
        { label: t('correction.send'), icon: <Send />, onPress: () => send({ type: 'send' }), heldReason: held ? t(`correction.held.${held}`) : null },
      ]
      body = (
        <div className="fw-task-split">
          <TaskCard
            icon={<Layers />}
            type={t('correction.reported')}
            code={step.target.bundleCode}
            id="fw-scans-target-code"
            facts={[
              { label: t('fact.operation'), value: t('opCode', { seq: step.target.operation.seq, code: step.target.operation.code }) + ` · ${step.target.operation.name}` },
              { label: t('correction.was'), value: countsText(t, { good: step.target.good, scrap: sumOf(step.target.scrap), rework: sumOf(step.target.rework) }) },
              { label: t('fact.at'), value: time(step.target.at) },
            ]}
          >
            <TaskLine tone="info" icon={<MessageSquareWarning />}>
              {t('correction.keeps')}
            </TaskLine>
          </TaskCard>
          <div className="fw-floor-stack">
            <CountsPanel counts={step.counts} expected={expected} open={step.open} problem={step.problem ?? null} t={t} locale={locale} send={send} withButtons />
            <section className="fw-floor-stack" aria-labelledby="fw-scans-why">
              <h3 id="fw-scans-why" className="fw-floor-subtitle">
                {t('correction.why')}
              </h3>
              <div className="fw-scans-why" role="group" aria-labelledby="fw-scans-why">
                {CORRECTION_REASONS.map((reason) => (
                  <FloorButton key={reason} size="lg" block variant={step.reason === reason ? 'primary' : 'secondary'} aria-pressed={step.reason === reason} onClick={() => send({ type: 'correctionReason', reason })}>
                    {t(`correction.reason.${reason}`)}
                  </FloorButton>
                ))}
              </div>
            </section>
          </div>
        </div>
      )
      break
    }

    case 'asked':
      actions = [home, scanAnother]
      body = (
        <FloorState tone="success" icon={<Send />} title={t('correction.sent.title')} text={t('correction.sent.body')}>
          <p className="fw-floor-card-code">{step.target.bundleCode}</p>
          <Ticks state={step.ticks} />
        </FloorState>
      )
      break
  }

  const showStrip = model.last && !(model.receipt && step.kind === 'scan') && (step.kind === 'scan' || step.kind === 'loading' || step.kind === 'wrongType' || step.kind === 'notOnTablet' || step.kind === 'unknownCode' || step.kind === 'pick')

  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={actions ? <FloorActionBar label={t('title')} actions={actions} /> : undefined}>
      <div className="fw-floor-stack">
        {showStrip ? <LastLine last={model.last!} t={t} shared={shared} send={send} /> : null}
        {body}
      </div>
      <Modal open={Boolean(model.leave)} onClose={() => send({ type: 'leave', leave: false })} title={t('leave.title')} size="sm" className="fw-floor-dialog">
        {model.leave ? (
          <div className="fw-floor-dialog-body">
            <p className="fw-floor-dialog-line">
              <span className="fw-floor-code">{model.leave.bundleCode}</span> · {t('opShort', { seq: model.leave.operationSeq })}
              {model.leave.scrap > 0 ? ` · ${t('count.scrap', { count: model.leave.scrap })}` : ''}
              {model.leave.rework > 0 ? ` · ${t('count.rework', { count: model.leave.rework })}` : ''}
            </p>
            <p className="fw-floor-dialog-line fw-floor-muted">{t('leave.body')}</p>
            <div className="fw-floor-dialog-actions">
              <FloorButton size="lg" variant="secondary" icon={<X />} onClick={() => send({ type: 'leave', leave: true })}>
                {t('leave.leave')}
              </FloorButton>
              <FloorButton size="lg" variant="primary" icon={<Check />} autoFocus onClick={() => send({ type: 'leave', leave: false })}>
                {t('leave.keep')}
              </FloorButton>
            </div>
          </div>
        ) : null}
      </Modal>
    </FloorFrameView>
  )
}

const sumOf = (lines: Readonly<Record<string, number>>) => Object.values(lines).reduce((total, value) => total + value, 0)

/** The big receipt of the report just made: what, and where it stands (one tick, then two). */
function Receipt({ last, t, shared, send }: { last: LastStrip; t: Translate; shared: Translate; send: (action: OperationAction) => void }) {
  const tone = last.ticks === 'refused' ? 'danger' : 'success'
  return (
    <section className="fw-scans-receipt" data-tone={tone} aria-live="polite">
      <span className="fw-scans-receipt-icon" aria-hidden="true">
        {tone === 'danger' ? <CircleAlert /> : <CircleCheckBig />}
      </span>
      <span className="fw-scans-receipt-text">
        <span className="fw-scans-receipt-what">
          <span className="fw-floor-code">{last.bundleCode}</span> · {t('opShort', { seq: last.operationSeq })} · {countsText(t, last)}
        </span>
        {last.ticks ? <Ticks state={last.ticks} /> : null}
        {last.refusal ? <span className="fw-floor-muted">{last.refusal}</span> : null}
      </span>
      {last.undo === 'open' ? (
        <FloorButton size="md" variant="secondary" icon={<ArrowLeft />} onClick={() => send({ type: 'undo' })}>
          {shared('undo.label')}
        </FloorButton>
      ) : null}
    </section>
  )
}

/** The last action strip: Undo while its window is open, then Ask a correction. */
function LastLine({ last, t, shared, send }: { last: LastStrip; t: Translate; shared: Translate; send: (action: OperationAction) => void }) {
  const what = `${last.bundleCode} · ${t('opShort', { seq: last.operationSeq })} · ${countsText(t, last)}`
  if (last.undo === 'undone') return <UndoStrip text={t('undo.done', { what })} ticks={last.undoTicks ?? null} />
  if (last.undo === 'open') return <UndoStrip text={what} ticks={last.ticks} onUndo={() => send({ type: 'undo' })} undoLabel={shared('undo.label')} />
  return (
    <UndoStrip
      text={what}
      ticks={last.ticks}
      extra={
        <FloorButton size="md" variant="secondary" icon={<ClipboardPen />} onClick={() => send({ type: 'corrections' })}>
          {shared('undo.ask')}
        </FloorButton>
      }
    />
  )
}

function BundleFacts({ card, operation, asOf, t, shared, locale, time }: { card: BundleCard; operation: CardOperation | null; asOf: string | null; t: Translate; shared: Translate; locale: Locale; time: (value: string) => string }) {
  const colourSize = [card.bundle.colourwayName || card.bundle.colourwayCode, card.bundle.size].filter(Boolean).join(' · ')
  return (
    <TaskCard
      icon={<Layers />}
      type={t('fact.bundle')}
      code={card.bundle.code}
      big={{ value: formatNumber(card.bundle.quantity, locale), label: t('fact.pieces', { count: card.bundle.quantity }) }}
      flags={
        <>
          <p className="fw-scans-size">{colourSize}</p>
          {operation ? (
            <p className="fw-scans-op">
              {t('opCode', { seq: operation.seq, code: operation.code })} · {operation.name}
            </p>
          ) : null}
          {asOf ? (
            <TaskLine tone="info" icon={<CloudOff />}>
              {shared('asOf', { time: time(asOf) })}
            </TaskLine>
          ) : null}
        </>
      }
      facts={[
        { label: t('fact.style'), value: `${card.workOrder.style.code} · ${card.workOrder.style.name}` },
        { label: t('fact.workOrder'), value: card.workOrder.batchNumber ? `${card.workOrder.number} · ${card.workOrder.batchNumber}` : card.workOrder.number },
        ...(card.bundle.part ? [{ label: t('fact.part'), value: card.bundle.part }] : []),
      ]}
    />
  )
}

function PickTiles({ options, t, onPick }: { options: readonly CardOperation[]; t: Translate; onPick: (operationId: string) => void }) {
  const group = useRef<HTMLDivElement>(null)
  // Arrows move between the tiles (design operation.op-picker "Arrows + Enter"); Enter presses the focused one.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) return
    const tiles = [...(group.current?.querySelectorAll<HTMLElement>('button, a[href]') ?? [])]
    const at = tiles.indexOf(document.activeElement as HTMLElement)
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1
    const next = tiles[(at + step + tiles.length) % tiles.length]
    if (next) {
      event.preventDefault()
      next.focus()
    }
  }
  return (
    <div ref={group} onKeyDown={onKeyDown}>
      <FloorTileGrid label={t('pick.title')} columns={2}>
        {options.map((operation, index) => (
          <FloorTile
            key={operation.id}
            icon={<Layers />}
            label={`${t('opCode', { seq: operation.seq, code: operation.code })} · ${operation.name}`}
            hint={operation.expected !== null ? t('pick.expected', { count: operation.expected }) : t(`pick.state.${operation.state}`)}
            tone={index === 0 ? 'primary' : 'neutral'}
            current={index === 0}
            onPress={() => onPick(operation.id)}
          />
        ))}
      </FloorTileGrid>
    </div>
  )
}

/** Good, Scrap and Rework with the expected number beside each; the pad of Good when open (Scrap and Rework open the reason picker). */
function CountsPanel({
  counts,
  expected,
  open,
  problem,
  t,
  locale,
  send,
  withButtons,
}: {
  counts: Counts
  expected: number
  open: CountsOpen
  problem: 'atMost' | null
  t: Translate
  locale: Locale
  send: (action: OperationAction) => void
  /** Scrap and Rework as buttons here (the correction: the action bar holds Back and Send). */
  withButtons?: boolean
}) {
  const good = goodOf(counts, expected)
  const scrap = scrapOf(counts)
  const rework = reworkOf(counts)
  const of = t('counts.of', { count: expected })
  const counter = (what: 'good' | 'scrap' | 'rework', value: number, icon: ReactNode) => (
    <FloorButton
      size="lg"
      block
      variant={open === what ? 'primary' : 'secondary'}
      aria-pressed={open === what}
      aria-label={`${t(`counts.${what}`)}: ${formatNumber(value, locale)} ${of}`}
      onClick={() => send({ type: 'open', what: open === what ? null : what })}
    >
      <span className="fw-scans-counter-body">
        <span className="fw-scans-counter-name">
          <span className="fw-floor-inline-icon" aria-hidden="true">
            {icon}
          </span>
          {t(`counts.${what}`)}
        </span>
        <span className="fw-scans-counter-value" data-kind={what}>
          {formatNumber(value, locale)}
        </span>
        <span className="fw-scans-counter-of">{of}</span>
      </span>
    </FloorButton>
  )
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-scans-counts">
      <h2 id="fw-scans-counts" className="fw-floor-section-title">
        {t('counts.title')}
      </h2>
      <div className="fw-scans-counters">
        {counter('good', good, <Check />)}
        {counter('scrap', scrap, <TriangleAlert />)}
        {counter('rework', rework, <Wrench />)}
      </div>
      {problem ? (
        <TaskLine tone="warning" icon={<TriangleAlert />} alert>
          {t('counts.atMost', { count: expected })}
        </TaskLine>
      ) : null}
      {open === 'good' ? (
        <QuantityPad
          label={t('counts.good')}
          value={good}
          onChange={(value) => send({ type: 'good', value })}
          min={0}
          max={maxGood(counts, expected)}
          expected={expected}
          expectedLabel={(count) => t('counts.of', { count })}
          quickValues={[{ value: maxGood(counts, expected), label: t('counts.allLeft') }]}
          decimalSeparator={locale === 'it' ? ',' : '.'}
          decrementLabel={t('pad.less')}
          incrementLabel={t('pad.more')}
          clearLabel={t('pad.clear')}
          backLabel={t('pad.back')}
          emptyLabel={t('pad.empty')}
          rangeLabel={(_min, max) => t('counts.atMost', { count: max ?? expected })}
          onConfirm={() => send({ type: 'open', what: null })}
          confirmLabel={t('pad.done')}
          autoFocus
        />
      ) : null}
      {withButtons && open !== 'good' ? <p className="fw-floor-muted">{t('counts.tapHint')}</p> : null}
    </section>
  )
}
