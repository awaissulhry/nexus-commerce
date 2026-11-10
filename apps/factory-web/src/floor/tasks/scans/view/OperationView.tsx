'use client'

import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowLeft, Camera, Check, CircleAlert, CircleCheckBig, ClipboardPen, Clock, CloudOff, Coffee, Flame, Hand, House, Layers, MessageSquareWarning, Minus, Pause, Play, Plus, ScanLine, Send, ShieldAlert, ShieldOff, TriangleAlert, UserRoundCheck, Workflow, Wrench, X } from 'lucide-react'
import { FloorActionBar, FloorButton, FloorList, FloorListRow, FloorTile, FloorTileGrid, QuantityPad, ScanInput, type CameraScanner, type FloorAction, type FloorActions } from '@nexus/ui/floor'
import { Field } from '@nexus/ui/components'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
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
import type { PickerList, PickerReason } from '../../reasons/model'
import { componentRows, garmentsOn, overridable, quantityRule, toldFindings, workHold, type GuardLine, type LotLine, type OperationCheck, type OperationSteps, type StepOutcome } from '../checks'
import { extraHeld, routingStep, unplannedHere, type ExtraChoices, type ExtraDraft, type ExtraPay } from '../extra'
import type { OffStandardBlock, OffStandardTile } from '../indirect'
import { noteHeld, type NoteDraft } from '../notes'
import type { StackRow } from '../stack'
import { stackTotals } from '../stack'
import { barOf, piecesLeft, resumeRows, type OpenItem, type Timing } from '../timing'
import { ComponentsPanel } from './ComponentsPanel'
import { ExtraBody, type ExtraAction } from './ExtraView'
import { IndirectTiles, RunningBlock } from './IndirectView'
import { NoteBody, type NoteAction } from './NoteView'
import { OverrideDialog, type OverrideAction, type OverrideModel } from './OverrideDialog'
import { StackBody, type StackAction, type StackLine } from './StackView'
import { StepsPanel } from './StepsPanel'
import { TimingPanel } from './TimingPanel'
import { FirstPieceLine } from './FirstPieceLine'
import { InstructionLines, InstructionsButton } from '../../instructions/view/OperationLines'
import type { InstructionFlag } from '../../instructions/model'
import type { NewerSpec } from '../../instructions/api'
import { firstPieceHolds } from '../first-piece'
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
  causeOperations,
  causedAtOf,
  totalOf,
  totalOfTarget,
  touched,
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
 *
 * B-W2b-69, the screen every shift: Start, Pause, Resume, Pieces so far and Hand back around the bundle's own clock (Finish stays
 * one tap with or without a Start, F3), the checks before it counts as a red screen with the team leader's override, the lots to
 * scan and the steps to tick when the operation asks them (and only then), several bundles at once with size buttons, no-bundle
 * time, a photo or comment on the work order, and counts stepped without typing (MES-106). Every action answers in colour, with
 * vibration and sound together (MES-108, the DS confirmFeedback: the container flashes `#fw-op-flash`).
 */

export type CountsOpen = 'scrap' | 'rework' | 'good' | null

/** What the API said about the bundle at this operation, beyond the card (all of it may be missing offline). */
export interface Work {
  readonly timing: Timing | null
  /** Tablet clock − server clock (ms). */
  readonly skewMs: number
  readonly check: OperationCheck | null
  readonly steps: OperationSteps | null
  readonly lots: readonly LotLine[]
  /** The last lot scanned was refused. */
  readonly lotRefusal: { readonly code: string; readonly message: string; readonly fix: string | null } | null
  /** A lot was read offline (the office checks it when the report arrives). */
  readonly lotsUnchecked?: boolean
  /** The site's skill rule only warns: said once at Start. */
  readonly qualification?: { readonly message: string } | null
  /** B-W2b-232: the instruction in force (null: none; absent: not read) and the work order's newer-spec read (PRD-195). */
  readonly instruction?: InstructionFlag | null
  readonly newerSpec?: NewerSpec | null
}

export const NO_WORK: Work = Object.freeze({ timing: null, skewMs: 0, check: null, steps: null, lots: Object.freeze([]) as readonly LotLine[], lotRefusal: null })

export type CountsStep = {
  readonly kind: 'counts'
  readonly card: BundleCard
  readonly operation: CardOperation
  readonly counts: Counts
  readonly open: CountsOpen
  readonly asOf: string | null
  readonly problem?: 'atMost' | null
  readonly busy?: boolean
  readonly work?: Work
  /** B-W2b-105: the first piece was approved while this bundle was on screen (the success line). */
  readonly firstPieceLifted?: boolean
}

export type OperationStep =
  | { readonly kind: 'scan' }
  | { readonly kind: 'loading'; readonly code: string }
  | { readonly kind: 'pick'; readonly card: BundleCard; readonly options: readonly CardOperation[]; readonly asOf: string | null }
  | CountsStep
  /** A check holds it: why, what to do, and the team leader's override when one lifts it (`target`: the report, or a Start). */
  | { readonly kind: 'guard'; readonly from: CountsStep; readonly lines: readonly GuardLine[]; readonly target: 'report' | 'start' }
  /** Pause asks a reason (the one picker, PAUSE list); a reason that asks more takes a few words. */
  | { readonly kind: 'pause'; readonly from: CountsStep; readonly list: PickerList; readonly picked: string | null; readonly words: string; readonly busy?: boolean }
  /** Pieces so far: another person may continue the bundle. */
  | { readonly kind: 'pieces'; readonly from: CountsStep; readonly value: number | null; readonly busy?: boolean }
  | { readonly kind: 'stack'; readonly rows: readonly StackRow[]; readonly size: string | null; readonly line?: StackLine | null; readonly busy?: boolean; readonly mismatch?: boolean }
  /** No bundle: the tiles; null: not read (offline with nothing kept, or reading). */
  | { readonly kind: 'indirect'; readonly codes: readonly OffStandardTile[] | null }
  | { readonly kind: 'note'; readonly from: CountsStep; readonly draft: NoteDraft }
  /** B-W2b-82: a team leader adds an unplanned operation to the bundle's work order (`back`: the step it was opened from). */
  | { readonly kind: 'extra'; readonly card: BundleCard; readonly back: OperationStep; readonly choices: ExtraChoices | null; readonly draft: ExtraDraft; readonly problem?: TaskProblem | null; readonly busy?: boolean }
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
  /** A stack finished at once: how many bundles (`bundleCode` then says nothing). */
  readonly bundles?: number
}

/** What the screen just did that is not a report: pieces so far, a hand back, a note. */
export interface DoneLine {
  readonly kind: 'pieces' | 'handBack' | 'note' | 'extra'
  readonly bundleCode: string
  readonly count?: number
  readonly ticks: TickState | null
  /** B-W2b-82: the operation just added and what a report at it pays. */
  readonly extra?: { readonly seq: number | null; readonly name: string; readonly pays: ExtraPay } | null
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
  /** The person's open work (the scan step's Continue). */
  resume?: readonly OpenItem[]
  /** A no-bundle block running here. */
  running?: { readonly block: OffStandardBlock; readonly skewMs: number } | null
  override?: OverrideModel | null
  /** "Hand back?" (no undo: said once). */
  handBack?: { readonly bundleCode: string; readonly operationSeq: number } | null
  /** "Leave this stack?" (several scans would go). */
  stackLeave?: { readonly bundles: number; readonly good: number } | null
  done?: DoneLine | null
  /** The pause reasons this tablet read (their words on a paused bundle). */
  pauseReasons?: readonly PickerReason[]
  timeZone?: string
  /** B-W2b-82: this person may add an unplanned operation (production.extraops.add). */
  mayAdd?: boolean
}

export type OperationAction =
  | { type: 'scan'; code: string }
  | { type: 'pick'; operationId: string }
  | { type: 'reason'; kind: DefectKind; code: string }
  | { type: 'unreason'; kind: DefectKind; code: string }
  /** B-W2b-105 (MES-127): the operation the kind's pieces are charged to (null: not known). */
  | { type: 'cause'; kind: DefectKind; operationId: string | null }
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
  // B-W2b-69
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'pausePick'; id: string }
  | { type: 'pauseWords'; words: string }
  | { type: 'pauseSend' }
  | { type: 'resume' }
  | { type: 'notAllGood' }
  | { type: 'pickerSwitch' }
  | { type: 'stepGood'; delta: 1 | -1 }
  | { type: 'pieces' }
  | { type: 'piecesValue'; value: number | null }
  | { type: 'piecesSend' }
  | { type: 'handBack' }
  | { type: 'handBackConfirm'; confirm: boolean }
  | { type: 'tick'; code: string; outcome: StepOutcome }
  | { type: 'lot'; code: string }
  | { type: 'lotStep'; code: string; delta: 1 | -1 }
  | { type: 'lotDrop'; code: string }
  | { type: 'override' }
  | { type: 'changeCounts' }
  | { type: 'stackOpen' }
  | { type: 'stackFinish' }
  | { type: 'stackLeave'; leave: boolean }
  | { type: 'indirectOpen' }
  | { type: 'indirectPick'; id: string }
  | { type: 'indirectDone' }
  | { type: 'noteOpen' }
  | { type: 'notePost' }
  | { type: 'noteBack' }
  | { type: 'continue'; code: string }
  // B-W2b-232: Instructions (design h.more "Instructions (W2b)").
  | { type: 'instructions' }
  // B-W2b-82
  | { type: 'operationOpen'; operationId: string }
  | { type: 'extraOpen' }
  | { type: 'extraBack' }
  | { type: 'extraSend' }
  | ExtraAction
  | OverrideAction
  | StackAction
  | NoteAction

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
export function pickerOf(input: { bundleCode: string; operation: { seq: number; name: string }; kind: DefectKind; reasons: readonly CardReason[]; counts: Counts; expected: number; problem: 'atMost' | null; card?: BundleCard; at?: CardOperation }): ReasonPickerModel {
  return {
    // B-W2b-105 (MES-127): "Which operation caused it?" over the bundle's operations up to this one (a correction asks none).
    cause: input.card && input.at ? { operations: causeOperations(input.card, input.at), value: causedAtOf(input.counts, input.kind) } : null,
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
    if (action.type === 'cause') send({ type: 'cause', kind, operationId: action.operationId })
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
  // A held main action says why on screen too, not only to a screen reader.
  let barWords: string | null = null
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
  // A check's words: the screen's own for a code it knows (the API's are English), never a person's name.
  const guardWords = (code: string, message: string) => refusalWords({ code: '', scanned: '', number: '', status: '', seq: '', operation: '' })(code)?.message ?? message
  const guardFix = (code: string, fix: string | null) => refusalWords({ code: '', scanned: '', number: '', status: '', seq: '', operation: '' })(code)?.fix ?? fix

  switch (step.kind) {
    case 'noPermission':
      actions = [home]
      body = <FloorState tone="warning" icon={<ShieldOff />} title={t('noPermission.title')} text={t('noPermission.body')} alert />
      break

    case 'scan':
      body = (
        <>
          {model.receipt && model.last ? <Receipt last={model.last} t={t} shared={shared} send={send} /> : null}
          {model.done ? <DoneStrip done={model.done} t={t} /> : null}
          {model.running ? <RunningBlock block={model.running.block} skewMs={model.running.skewMs} t={t} onDone={() => send({ type: 'indirectDone' })} /> : null}
          {resumeRows(model.resume ?? []).length > 0 ? (
            <FloorList label={t('resume.title')}>
              {resumeRows(model.resume ?? []).map((item) => (
                <FloorListRow
                  key={`${item.bundleId}:${item.operation.id}`}
                  icon={item.state === 'PAUSED' ? <Pause /> : <Play />}
                  tone={item.state === 'PAUSED' ? 'warning' : 'info'}
                  title={t(`resume.${item.state}`, { code: item.bundleCode, seq: item.operation.seq, time: time(item.pausedAt ?? item.runningSince ?? '') })}
                  status={t('resume.continue')}
                  onPress={() => send({ type: 'continue', code: item.bundleCode })}
                />
              ))}
            </FloorList>
          ) : null}
          {scanField()}
          {model.held ? (
            <TaskLine tone="warning" icon={<TriangleAlert />}>
              {floor('tile.held.notice')}
            </TaskLine>
          ) : (
            <>
              <div className="fw-scans-more">
                <FloorButton size="lg" block variant="secondary" icon={<Layers />} onClick={() => send({ type: 'stackOpen' })}>
                  {t('stack.open')}
                </FloorButton>
                <FloorButton size="lg" block variant="secondary" icon={<Coffee />} onClick={() => send({ type: 'indirectOpen' })}>
                  {t('indirect.open')}
                </FloorButton>
              </div>
              {model.running || model.done || model.receipt ? null : (
                <div className="fw-scans-invite">
                  <span className="fw-floor-hero" aria-hidden="true">
                    <Layers />
                  </span>
                  <p className="fw-floor-lead">{t('scan.empty')}</p>
                </div>
              )}
            </>
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
          {model.done ? <DoneStrip done={model.done} t={t} /> : null}
          {card && card.refusal === null ? <UnplannedActions card={card} current={null} mayAdd={model.mayAdd ?? false} online={model.online} t={t} send={send} /> : null}
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
          {model.done ? <DoneStrip done={model.done} t={t} /> : null}
          <UnplannedActions card={step.card} current={null} mayAdd={model.mayAdd ?? false} online={model.online} t={t} send={send} />
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
      const work = step.work ?? NO_WORK
      const expected = step.operation.expected ?? step.card.bundle.quantity
      const ceiling = step.card.bundle.quantity
      const good = goodOf(step.counts, expected)
      const asked = work.check?.components.asked ?? []
      const held = finishHeld(step.counts, step.operation.expected, ceiling)
      // B-W2b-105 (QHS-039): the run waits for its first piece here: Finish, Start and Resume are held (the API refuses them).
      const waiting = firstPieceHolds(step.card, step.operation.id)
      const hold = held ? null : workHold({ steps: work.steps, asked, lots: work.lots, counts: step.counts, expected, firstPiece: waiting })
      const heldWords = held ? t(`finish.held.${held}`, { count: ceiling }) : step.busy ? t('finish.busy') : hold ? t(`finish.work.${hold.key}`, hold) : null
      const finish: FloorAction = { label: t('finish.label', { count: good }), icon: <Check />, onPress: () => send({ type: 'finish' }), heldReason: heldWords, id: 'finish' }
      barWords = heldWords
      const kind = pickerKindOf(step.open)
      if (kind) {
        // Scrap or Rework opened the reason picker: Done goes back to the counts, Finish stays one tap away.
        actions = [
          { label: reasonsT('done'), icon: <ArrowLeft />, variant: 'secondary', onPress: () => send({ type: 'open', what: null }) },
          { label: t(kind === 'SCRAP' ? 'counts.rework' : 'counts.scrap'), icon: kind === 'SCRAP' ? <Wrench /> : <TriangleAlert />, variant: 'secondary', onPress: () => send({ type: 'pickerSwitch' }) },
          finish,
        ]
        const picker = pickerOf({ bundleCode: step.card.bundle.code, operation: step.operation, kind, reasons: step.card.reasons, counts: step.counts, expected, problem: step.problem ?? null, card: step.card, at: step.operation })
        body = (
          <>
            {model.last ? <LastLine last={model.last} t={t} shared={shared} send={send} /> : null}
            <ReasonPickerBody model={picker} onAction={pickerSend(kind)} onBack={() => send({ type: 'open', what: null })} timeZone={model.timeZone} />
          </>
        )
        break
      }
      const bar = barOf(work.timing)
      // B-W2b-82: an unplanned operation counts good pieces only, so it has no "Not all good".
      const goodOnly = step.operation.unplanned === true
      const notAllGood: FloorAction = { label: t('timing.notAllGood'), icon: <TriangleAlert />, onPress: () => send({ type: 'notAllGood' }) }
      const waitHeld = waiting ? t('firstPiece.held') : null
      const first: FloorAction | null = bar === 'running' ? { label: t('timing.pause'), icon: <Pause />, onPress: () => send({ type: 'pause' }) } : bar === 'paused' || bar === 'other' ? null : { label: t('timing.start'), icon: <Play />, onPress: () => send({ type: 'start' }), heldReason: waitHeld }
      const resume: FloorAction = { label: t('timing.resume'), icon: <Play />, onPress: () => send({ type: 'resume' }), id: 'resume', heldReason: waitHeld }
      if (goodOnly) actions = bar === 'paused' ? [finish, resume] : first ? [first, finish] : [finish]
      else actions = bar === 'paused' ? [notAllGood, finish, resume] : first ? [first, notAllGood, finish] : [notAllGood, finish]
      const total = totalOf(step.counts, expected)
      const rule = quantityRule(work.check, total)
      const told = toldFindings(work.check)
      const mine = bar === 'running' || bar === 'paused'
      body = (
        <>
          {model.last ? <LastLine last={model.last} t={t} shared={shared} send={send} /> : null}
          {model.done ? <DoneStrip done={model.done} t={t} /> : null}
          <div className="fw-task-split">
            <div className="fw-floor-stack">
              <BundleFacts card={step.card} operation={step.operation} asOf={step.asOf} t={t} shared={shared} locale={locale} time={time} lifted={step.firstPieceLifted ?? false} />
              {/* B-W2b-232: New instruction (opens before Start, MES-110) and Spec changed (PRD-195). */}
              <InstructionLines flag={work.instruction} newer={work.newerSpec} />
              <TimingPanel timing={work.timing} skewMs={work.skewMs} reasons={model.pauseReasons ?? []} />
              {goodOnly ? (
                <TaskLine tone="info" icon={<Workflow />}>
                  {t('unplanned.goodOnly')}
                </TaskLine>
              ) : null}
              {work.qualification ? (
                <TaskLine tone="warning" icon={<ShieldAlert />}>
                  {t('timing.qualification')}
                </TaskLine>
              ) : null}
              {told.map((finding) => (
                <TaskLine key={finding.code} tone="warning" icon={<TriangleAlert />}>
                  {t('guard.told', { what: guardWords(finding.code, finding.message) })}
                </TaskLine>
              ))}
            </div>
            <div className="fw-floor-stack">
              {/* What the operation asks first: Finish waits for it, so it never hides under the counts. */}
              {work.steps ? <StepsPanel list={work.steps} t={t} time={time} onTick={(code, outcome) => send({ type: 'tick', code, outcome })} /> : null}
              <ComponentsPanel rows={componentRows(asked, work.lots, garmentsOn(step.counts, expected))} garments={garmentsOn(step.counts, expected)} refusal={work.lotRefusal ? { message: guardWords(work.lotRefusal.code, work.lotRefusal.message), fix: guardFix(work.lotRefusal.code, work.lotRefusal.fix) } : null} unchecked={Boolean(work.lotsUnchecked)} t={t} camera={camera} onLot={(code) => send({ type: 'lot', code })} onStep={(code, delta) => send({ type: 'lotStep', code, delta })} onDrop={(code) => send({ type: 'lotDrop', code })} />
              <CountsPanel counts={step.counts} expected={expected} ceiling={ceiling} open={step.open} problem={step.problem ?? null} t={t} locale={locale} send={send} stepper goodOnly={goodOnly} />
              {rule ? (
                <TaskLine tone="warning" icon={<TriangleAlert />}>
                  {t(`counts.rule.${rule}`, { count: step.operation.expected ?? expected })}
                </TaskLine>
              ) : null}
              <div className="fw-scans-more">
                {mine ? (
                  <>
                    <FloorButton size="lg" block variant="secondary" icon={<Hand />} heldReason={piecesLeft(step.card.bundle.quantity, work.timing) < 1 ? t('timing.noPieces') : null} onClick={() => send({ type: 'pieces' })}>
                      {t('timing.piecesOpen')}
                    </FloorButton>
                    <FloorButton size="lg" block variant="secondary" icon={<ArrowLeft />} onClick={() => send({ type: 'handBack' })}>
                      {t('timing.handBack')}
                    </FloorButton>
                  </>
                ) : goodOnly ? null : (
                  <FloorButton size="lg" block variant="secondary" icon={<Layers />} heldReason={touched(step.counts) ? t('stack.heldCounts') : null} onClick={() => send({ type: 'stackOpen' })}>
                    {t('stack.add')}
                  </FloorButton>
                )}
                <FloorButton size="lg" block variant="secondary" icon={<Camera />} onClick={() => send({ type: 'noteOpen' })}>
                  {t('note.open')}
                </FloorButton>
                <InstructionsButton flag={work.instruction} onPress={() => send({ type: 'instructions' })} />
              </div>
              {mine ? null : <UnplannedActions card={step.card} current={step.operation} mayAdd={model.mayAdd ?? false} online={model.online} t={t} send={send} />}
            </div>
          </div>
        </>
      )
      break
    }

    case 'guard': {
      const { from, lines, target } = step
      const lift = overridable(lines)
      // Back is the counts (change them, or scan another ticket from there); a line no override lifts ends here.
      actions = lift
        ? [
            { label: shared('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'changeCounts' }) },
            { label: t('guard.override'), icon: <UserRoundCheck />, onPress: () => send({ type: 'override' }), heldReason: model.online ? null : t('override.offline') },
          ]
        : [home, scanAnother]
      body = (
        <FloorState tone="danger" icon={<ShieldAlert />} title={t('guard.title')} text={!lift ? t('guard.noLift') : target === 'report' ? t('guard.liftReport') : t('guard.lift')} alert>
          <p className="fw-floor-card-code">{from.card.bundle.code}</p>
          <p className="fw-scans-op">
            {t('opCode', { seq: from.operation.seq, code: from.operation.code })} · {from.operation.name}
          </p>
          {lines.map((line) => (
            <div key={line.code} className="fw-scans-guard-line">
              <p className="fw-floor-state-text">{guardWords(line.code, line.message)}</p>
              {guardFix(line.code, line.fix) ? <p className="fw-floor-muted">{guardFix(line.code, line.fix)}</p> : null}
            </div>
          ))}
        </FloorState>
      )
      break
    }

    case 'pause': {
      const picked = step.list.reasons.find((reason) => reason.id === step.picked) ?? null
      const needsWords = Boolean(picked?.needsDetail)
      const wordsHeld = !picked ? t('pause.choose') : needsWords && !step.words.trim() ? t('pause.needsWords') : step.busy ? t('finish.busy') : null
      barWords = wordsHeld
      actions = [
        { label: shared('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }) },
        { label: t('timing.pause'), icon: <Pause />, onPress: () => send({ type: 'pauseSend' }), heldReason: wordsHeld },
      ]
      const picker: ReasonPickerModel = { purpose: 'pause', subject: `${step.from.card.bundle.code} · ${t('opShort', { seq: step.from.operation.seq })}`, reasons: step.list.reasons, state: step.list.state, value: step.picked, asOf: step.list.asOf }
      body = (
        <>
          <ReasonPickerBody model={picker} onAction={(action) => (action.type === 'pick' ? send({ type: 'pausePick', id: action.id }) : undefined)} onBack={() => send({ type: 'back' })} timeZone={model.timeZone} />
          {needsWords ? (
            <Field label={t('pause.words')} htmlFor="fw-scans-pause-words">
              <Textarea id="fw-scans-pause-words" value={step.words} limit={200} maxLength={200} rows={2} autoFocus onChange={(event) => send({ type: 'pauseWords', words: event.target.value })} />
            </Field>
          ) : null}
        </>
      )
      break
    }

    case 'pieces': {
      const most = piecesLeft(step.from.card.bundle.quantity, step.from.work?.timing ?? null)
      const sendHeld = step.value === null || step.value < 1 ? t('timing.piecesEmpty') : step.value > most ? t('counts.atMost', { count: most }) : step.busy ? t('finish.busy') : null
      barWords = sendHeld
      actions = [
        { label: shared('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }) },
        { label: t('timing.piecesSend'), icon: <Check />, onPress: () => send({ type: 'piecesSend' }), heldReason: sendHeld },
      ]
      body = (
        <section className="fw-floor-stack" aria-labelledby="fw-scans-pieces">
          <h2 id="fw-scans-pieces" className="fw-floor-section-title">
            {t('timing.piecesTitle', { code: step.from.card.bundle.code })}
          </h2>
          <p className="fw-floor-muted">{t('timing.piecesHint')}</p>
          <QuantityPad
            label={t('timing.piecesOpen')}
            value={step.value}
            onChange={(value) => send({ type: 'piecesValue', value })}
            min={1}
            max={most}
            expected={most}
            expectedLabel={(count) => t('counts.of', { count })}
            decimalSeparator={locale === 'it' ? ',' : '.'}
            decrementLabel={t('pad.less')}
            incrementLabel={t('pad.more')}
            clearLabel={t('pad.clear')}
            backLabel={t('pad.back')}
            emptyLabel={t('pad.empty')}
            rangeLabel={(_min, max) => t('counts.atMost', { count: max ?? most })}
            autoFocus
          />
        </section>
      )
      break
    }

    case 'stack': {
      const totals = stackTotals(step.rows)
      const stackHeld = step.rows.length === 0 ? t('stack.heldEmpty') : step.mismatch ? t('stack.heldShade') : step.rows.some((row) => row.refusal) ? t('stack.heldRefused') : step.busy ? t('finish.busy') : null
      barWords = stackHeld
      actions = [
        { label: shared('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }) },
        { label: t('stack.finish', { count: totals.bundles, good: formatNumber(totals.good, locale) }), icon: <Check />, onPress: () => send({ type: 'stackFinish' }), heldReason: stackHeld },
      ]
      body = <StackBody rows={step.rows} size={step.size} line={step.line ?? null} online={model.online} refusalText={(refusal) => `${guardWords(refusal.code, refusal.message)} ${guardFix(refusal.code, refusal.fix) ?? ''}`.trim()} t={t} camera={camera} send={send} />
      break
    }

    case 'indirect':
      actions = [{ label: shared('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }) }]
      body = (
        <section className="fw-floor-stack" aria-labelledby="fw-scans-indirect">
          <h2 id="fw-scans-indirect" className="fw-floor-section-title">
            {t('indirect.question')}
          </h2>
          <IndirectTiles codes={step.codes} online={model.online} t={t} onPick={(id) => send({ type: 'indirectPick', id })} />
        </section>
      )
      break

    case 'note': {
      const noteWait = noteHeld(step.draft)
      if (step.draft.capture === null) {
        barWords = noteWait ? t(`note.held.${noteWait}`) : null
        actions = [
          { label: shared('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'noteBack' }) },
          { label: t('note.post'), icon: <Send />, onPress: () => send({ type: 'notePost' }), heldReason: noteWait ? t(`note.held.${noteWait}`) : null },
        ]
      }
      body = <NoteBody draft={step.draft} subject={`${step.from.card.bundle.code} · ${t('opShort', { seq: step.from.operation.seq })}`} online={model.online} t={t} send={send} />
      break
    }

    case 'extra': {
      const held = extraHeld(step.draft, step.choices)
      const addHeld = !model.online ? t('extra.offline') : step.busy ? t('extra.adding') : held ? t(`extra.held.${held}`) : null
      barWords = addHeld
      actions = [
        { label: shared('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'extraBack' }) },
        { label: t('extra.add'), icon: <Plus />, onPress: () => send({ type: 'extraSend' }), heldReason: addHeld },
      ]
      body = <ExtraBody card={step.card} choices={step.choices} draft={step.draft} problem={step.problem ?? null} busy={step.busy ?? false} online={model.online} t={t} send={send} />
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
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={actions ? <FloorActionBar label={t('title')} actions={actions} start={barWords ? <span className="fw-scans-bar-words">{barWords}</span> : undefined} /> : undefined}>
      <div id="fw-op-flash" className="fw-floor-stack">
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
      <Modal open={Boolean(model.handBack)} onClose={() => send({ type: 'handBackConfirm', confirm: false })} title={t('timing.handBackTitle')} size="sm" className="fw-floor-dialog">
        {model.handBack ? (
          <div className="fw-floor-dialog-body">
            <p className="fw-floor-dialog-line">
              <span className="fw-floor-code">{model.handBack.bundleCode}</span> · {t('opShort', { seq: model.handBack.operationSeq })}
            </p>
            <p className="fw-floor-dialog-line fw-floor-muted">{t('timing.handBackBody')}</p>
            <div className="fw-floor-dialog-actions">
              <FloorButton size="lg" variant="secondary" icon={<X />} onClick={() => send({ type: 'handBackConfirm', confirm: false })}>
                {t('leave.keep')}
              </FloorButton>
              <FloorButton size="lg" variant="primary" icon={<Check />} autoFocus onClick={() => send({ type: 'handBackConfirm', confirm: true })}>
                {t('timing.handBack')}
              </FloorButton>
            </div>
          </div>
        ) : null}
      </Modal>
      <Modal open={Boolean(model.stackLeave)} onClose={() => send({ type: 'stackLeave', leave: false })} title={t('stack.leaveTitle')} size="sm" className="fw-floor-dialog">
        {model.stackLeave ? (
          <div className="fw-floor-dialog-body">
            <p className="fw-floor-dialog-line">{t('stack.total', { count: model.stackLeave.bundles, good: formatNumber(model.stackLeave.good, locale) })}</p>
            <p className="fw-floor-dialog-line fw-floor-muted">{t('stack.leaveBody')}</p>
            <div className="fw-floor-dialog-actions">
              <FloorButton size="lg" variant="secondary" icon={<X />} onClick={() => send({ type: 'stackLeave', leave: true })}>
                {t('stack.leave')}
              </FloorButton>
              <FloorButton size="lg" variant="primary" icon={<Check />} autoFocus onClick={() => send({ type: 'stackLeave', leave: false })}>
                {t('stack.keep')}
              </FloorButton>
            </div>
          </div>
        ) : null}
      </Modal>
      <OverrideDialog model={model.override ?? null} send={send} words={guardWords} />
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
          {last.bundles ? (
            t('stack.done', { count: last.bundles, what: countsText(t, last) })
          ) : (
            <>
              <span className="fw-floor-code">{last.bundleCode}</span> · {t('opShort', { seq: last.operationSeq })} · {countsText(t, last)}
            </>
          )}
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

/** Pieces so far, a hand back, a note or an operation added: what was just done, with its ticks. */
function DoneStrip({ done, t }: { done: DoneLine; t: Translate }) {
  if (done.kind === 'extra') {
    const added = t('done.extra', { code: done.bundleCode, seq: done.extra?.seq ?? 0, name: done.extra?.name ?? '' })
    return <UndoStrip text={done.extra?.pays === 'OFF_STANDARD' ? `${added} ${t('extra.noRate')}` : added} ticks={done.ticks} />
  }
  return <UndoStrip text={t(`done.${done.kind}`, { code: done.bundleCode, count: done.count ?? 0 })} ticks={done.ticks} />
}

/**
 * B-W2b-82: the unplanned operations this station may report on the bundle's work order, picked by hand (a scan keeps opening the
 * routing's next step: one tap stays one tap), the way back to that step, and a team leader's Add.
 */
function UnplannedActions({ card, current, mayAdd, online, t, send }: { card: BundleCard; current: CardOperation | null; mayAdd: boolean; online: boolean; t: Translate; send: (action: OperationAction) => void }) {
  const open = unplannedHere(card, current?.id ?? null)
  const routing = current?.unplanned ? routingStep(card) : null
  if (open.length === 0 && !routing && !mayAdd) return null
  return (
    <div className="fw-scans-more">
      {routing ? (
        <FloorButton size="lg" block variant="secondary" icon={<ArrowLeft />} onClick={() => send({ type: 'operationOpen', operationId: routing.id })}>
          {t('unplanned.back', { seq: routing.seq, name: routing.name })}
        </FloorButton>
      ) : null}
      {open.map((operation) => (
        <FloorButton key={operation.id} size="lg" block variant="secondary" icon={<Workflow />} onClick={() => send({ type: 'operationOpen', operationId: operation.id })}>
          {t('unplanned.open', { seq: operation.seq, name: operation.name })}
        </FloorButton>
      ))}
      {mayAdd ? (
        <FloorButton size="lg" block variant="secondary" icon={<Plus />} heldReason={online ? null : t('extra.offline')} onClick={() => send({ type: 'extraOpen' })}>
          {t('extra.open')}
        </FloorButton>
      ) : null}
    </div>
  )
}

/** The last action strip: Undo while its window is open, then Ask a correction. */
function LastLine({ last, t, shared, send }: { last: LastStrip; t: Translate; shared: Translate; send: (action: OperationAction) => void }) {
  const what = last.bundles ? t('stack.done', { count: last.bundles, what: countsText(t, last) }) : `${last.bundleCode} · ${t('opShort', { seq: last.operationSeq })} · ${countsText(t, last)}`
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

function BundleFacts({ card, operation, asOf, t, shared, locale, time, lifted = false }: { card: BundleCard; operation: CardOperation | null; asOf: string | null; t: Translate; shared: Translate; locale: Locale; time: (value: string) => string; lifted?: boolean }) {
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
          {card.workOrder.rush ? (
            <TaskLine tone="danger" icon={<Flame />}>
              {t('fact.rush')}
            </TaskLine>
          ) : null}
          {operation ? (
            <p className="fw-scans-op">
              {t('opCode', { seq: operation.seq, code: operation.code })} · {operation.name}
            </p>
          ) : null}
          <FirstPieceLine card={card} operationId={operation?.id ?? null} lifted={lifted} t={t} />
          {operation?.unplanned ? (
            <TaskLine tone="info" icon={<Workflow />}>
              {t('unplanned.flag')}
            </TaskLine>
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
  ceiling = expected,
  open,
  problem,
  t,
  locale,
  send,
  withButtons,
  stepper,
  goodOnly,
}: {
  counts: Counts
  expected: number
  /** The most a report takes (the bundle's own pieces); above what passed the site's rule decides. */
  ceiling?: number
  open: CountsOpen
  problem: 'atMost' | null
  t: Translate
  locale: Locale
  send: (action: OperationAction) => void
  /** Scrap and Rework as buttons here (the correction: the action bar holds Back and Send). */
  withButtons?: boolean
  /** − and + on Good: a count without typing (MES-106). */
  stepper?: boolean
  /** B-W2b-82: no Scrap and Rework (an unplanned operation counts good pieces only). */
  goodOnly?: boolean
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
  // "+ and − step the focused counter" (design floor.operation keys).
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!stepper || open === 'good' || event.ctrlKey || event.metaKey || event.altKey) return
    const delta = event.key === '+' ? 1 : event.key === '-' ? -1 : null
    if (delta === null) return
    event.preventDefault()
    send({ type: 'stepGood', delta })
  }
  const most = Math.max(0, ceiling - scrap - rework)
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-scans-counts" onKeyDown={onKeyDown}>
      <h2 id="fw-scans-counts" className="fw-floor-section-title">
        {t('counts.title')}
      </h2>
      <div className="fw-scans-counters" data-good-only={goodOnly ? 'true' : undefined}>
        {counter('good', good, <Check />)}
        {goodOnly ? null : counter('scrap', scrap, <TriangleAlert />)}
        {goodOnly ? null : counter('rework', rework, <Wrench />)}
      </div>
      {stepper && open !== 'good' ? (
        <div className="fw-scans-stepper" role="group" aria-label={t('counts.stepGood')}>
          <FloorButton size="lg" block variant="secondary" icon={<Minus />} heldReason={good <= 0 ? t('counts.least') : null} onClick={() => send({ type: 'stepGood', delta: -1 })}>
            {t('counts.oneLess')}
          </FloorButton>
          <FloorButton size="lg" block variant="secondary" icon={<Plus />} heldReason={good >= most ? t('counts.atMost', { count: ceiling }) : null} onClick={() => send({ type: 'stepGood', delta: 1 })}>
            {t('counts.oneMore')}
          </FloorButton>
        </div>
      ) : null}
      {problem ? (
        <TaskLine tone="warning" icon={<TriangleAlert />} alert>
          {t('counts.atMost', { count: ceiling })}
        </TaskLine>
      ) : null}
      {open === 'good' ? (
        <QuantityPad
          label={t('counts.good')}
          value={good}
          onChange={(value) => send({ type: 'good', value })}
          min={0}
          max={maxGood(counts, ceiling)}
          expected={expected}
          expectedLabel={(count) => t('counts.of', { count })}
          quickValues={[{ value: maxGood(counts, expected), label: t('counts.allLeft') }]}
          decimalSeparator={locale === 'it' ? ',' : '.'}
          decrementLabel={t('pad.less')}
          incrementLabel={t('pad.more')}
          clearLabel={t('pad.clear')}
          backLabel={t('pad.back')}
          emptyLabel={t('pad.empty')}
          rangeLabel={(_min, max) => t('counts.atMost', { count: max ?? ceiling })}
          onConfirm={() => send({ type: 'open', what: null })}
          confirmLabel={t('pad.done')}
          autoFocus
        />
      ) : null}
      {withButtons && open !== 'good' ? <p className="fw-floor-muted">{t('counts.tapHint')}</p> : null}
    </section>
  )
}
