'use client'

import type { ReactNode } from 'react'
import { AlertOctagon, ArrowLeft, Bell, Check, CircleAlert, ClipboardList, CloudOff, History, House, Layers, MessageSquare, Package, PenLine, RefreshCw, RotateCcw, ScanLine, Send, ShieldCheck, Timer, Trash2, TriangleAlert, UserCheck, UserX, Users, WifiOff, Wrench, X } from 'lucide-react'
import { Field, MetricStrip, type Metric } from '@nexus/ui/components'
import { PinSignBlock } from '@nexus/ui/components/PinSignBlock/index'
import { FloorActionBar, FloorButton, FloorList, FloorListRow, FloorTile, FloorTileGrid, QuantityPad, ScanInput, type CameraScanner, type FloorActions } from '@nexus/ui/floor'
import { FloorCard } from '@nexus/ui/floor/FloorCard/index'
import { FloorElapsed } from '@nexus/ui/floor/FloorElapsed/index'
import { FloorListUpdates } from '@nexus/ui/floor/FloorListUpdates/index'
import { FloorNamePicker } from '@nexus/ui/floor/FloorNamePicker/index'
import { ReasonGrid, type ReasonTile } from '@nexus/ui/floor/ReasonGrid/index'
import { REASON_KIT_NAMESPACE, useReasonWords } from '../../../../lib/ds-words/reason-grid'
import { Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatTime } from '../../../../lib/i18n/format'
import { INTL_LOCALE, type Locale } from '../../../../lib/i18n/locales'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { reasonWords } from '../../../../lib/line-board/model'
import type { LineBoard } from '../../../../lib/line-board/schema'
import { WithMessages } from '../../../../record-panels/i18n'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import { DANGER_AFTER_MS, WARN_AFTER_MS } from '../../help/model'
import type { TaskProblem } from '../../shared/task-api'
import { ListFooter, PinSign, ProblemState, TaskLine, Ticks, UndoStrip, type PinProblem, type TickState } from '../../shared/view/TaskParts'
import type { BehalfOptions, Conflict, ConflictDecisions, CorrectionRecord, FloorLine, Handover, LineCall, Operator, Operators, RefusalTile, ReassignRow } from '../api'
import {
  behalfHeld,
  CORRECTION_NOTE_MAX,
  correctionChanges,
  countsHeld,
  decisionHeld,
  decisionOf,
  expectedOf,
  handoverHeld,
  isCorrectionRefusal,
  isKnownRefusal,
  lineNumbers,
  NOTE_MAX,
  openOperations,
  OVERRIDE_TILES,
  overrideHeld,
  REASON_MAX,
  reassignHeld,
  rejectHeld,
  rejectTiles,
  stationStates,
  TOPICS,
  waitingKey,
  type BehalfDraft,
  type HandoverDraft,
  type LineCan,
  type OverrideDraft,
  type QueuedAnswer,
  type WaitingItem,
} from '../model'
import '../lineview.css'
import type { HandoverTopic } from '@nexus/factory-domain/production/dispatch/handover'

/**
 * SCR-168 — Floor › Line view (B-W2b-70; design floor.supervisor, MES-033, -099, -128, -145, -196; Owner answer F2): tablet
 * first, one job per screen inside the floor frame. Line-level numbers only; per station only a call, a machine down,
 * waiting for material and "nobody signed in"; never a figure about a person, never a ranking.
 *
 *   My line now      output against the target, WIP bundles, open calls, machines down, DHU
 *   Calls            rows by station with the elapsed time; the action bar answers the row picked (one tap: On my way)
 *   Waiting for you  scrap over the limit, off-standard blocks, sync conflicts, corrections of a report (B-W2b-83, old → new
 *                    counts), oldest first; a row opens its decision (Approve signs with the PIN, Reject takes a reason); the
 *                    next item opens after a decision. A correction alone names the person, in its one record, where the
 *                    scan names someone: the decision needs it (design); never in the list, never with a figure about them
 *   Stations         each station's state; work assigned to someone not clocked in shows Reassign, with no name
 *   Handover note    topic tiles and a short text, the last shift's note above; saved on the tablet first
 *   Scan on behalf   station → person where the site names workers → bundle → counts → reason; "entered by the team leader"
 *
 * The view fetches nothing: the container (LineView.tsx) reads and maps.
 */

export type DecideStage = 'look' | 'reject' | 'keep' | 'send' | 'pin'
export type DecideAct = { readonly type: 'approve' } | { readonly type: 'reject'; readonly tile: string; readonly words: string | null } | { readonly type: 'keep'; readonly reason: string } | { readonly type: 'send'; readonly reason: string }
export type BehalfStage = 'station' | 'person' | 'scan' | 'operation' | 'counts' | 'reason' | 'override' | 'done'

export type LineStep =
  | { readonly kind: 'loading' }
  | { readonly kind: 'noLine' }
  | { readonly kind: 'problem'; readonly problem: TaskProblem }
  | { readonly kind: 'now'; readonly done?: 'decided' | 'reassigned' | 'handover' | null; readonly queued?: string | null }
  | {
      readonly kind: 'decide'
      readonly item: WaitingItem
      readonly stage: DecideStage
      /** The last decision went through: this is the next item. */
      readonly done?: boolean
      readonly tile?: string | null
      readonly words?: string
      /** What the PIN signs: sent again after it. */
      readonly act?: DecideAct | null
      /** A correction's one record, read when it opens. */
      readonly record?: CorrectionRecord | null
      /** That record could not be read now. */
      readonly recordUnread?: boolean
      readonly busy?: boolean
      readonly problem?: TaskProblem | null
      readonly pinProblem?: PinProblem
    }
  | { readonly kind: 'reassign'; readonly station: string; readonly row: ReassignRow; readonly people: Operators | null; readonly chosen: Operator | null; readonly reason: string; readonly busy?: boolean; readonly problem?: TaskProblem | null }
  | { readonly kind: 'handover'; readonly lineId: string; readonly shift: string; readonly note: Handover | null; readonly draft: HandoverDraft; readonly asOf: string | null; readonly problem?: TaskProblem | null }
  | {
      readonly kind: 'behalf'
      readonly stage: BehalfStage
      readonly options: BehalfOptions
      readonly draft: BehalfDraft
      readonly override: OverrideDraft
      /** The report sent, kept for the override (the same clientScanId). */
      readonly report?: Readonly<Record<string, unknown>> | null
      readonly scanned?: string | null
      readonly entered?: { readonly scanId: string; readonly clientScanId: string } | null
      readonly undone?: boolean
      /** Saved on this tablet: its queue id. */
      readonly queued?: string | null
      readonly busy?: boolean
      readonly problem?: TaskProblem | null
    }

export interface LineViewModel {
  readonly frame: FrameModel
  readonly can: LineCan
  readonly online: boolean
  readonly step: LineStep
  /** Who signs (the person on this tablet). */
  readonly signer: string
  readonly board: LineBoard | null
  readonly line: FloorLine | null
  readonly canAnswer: boolean
  readonly calls: readonly LineCall[]
  readonly callsPending: number
  /** The calls could not be read now. */
  readonly callsUnknown: boolean
  readonly picked: string | null
  readonly answers: readonly QueuedAnswer[]
  readonly waiting: readonly WaitingItem[]
  readonly waitingPending: number
  readonly waitingUnknown: boolean
  readonly tiles: readonly RefusalTile[]
  readonly correctionTiles: readonly RefusalTile[]
  readonly decisions: ConflictDecisions
  readonly asOf: string | null
  /** A saved note's or entry's two ticks. */
  readonly ticks: TickState | null
  readonly timeZone?: string
}

export type LineAction =
  | { type: 'back' }
  | { type: 'home' }
  | { type: 'showCalls' }
  | { type: 'showWaiting' }
  | { type: 'pickCall'; id: string }
  | { type: 'onMyWay' }
  | { type: 'solved' }
  | { type: 'open'; item: WaitingItem }
  | { type: 'stage'; stage: DecideStage }
  | { type: 'tile'; code: string }
  | { type: 'words'; text: string }
  | { type: 'approve' }
  | { type: 'reject' }
  | { type: 'conflict' }
  | { type: 'pin'; pin: string }
  | { type: 'reassign'; station: string; assignmentId: string }
  | { type: 'person'; id: string }
  | { type: 'sendReassign' }
  | { type: 'handover' }
  | { type: 'topic'; topic: HandoverTopic }
  | { type: 'sendHandover' }
  | { type: 'behalf' }
  | { type: 'station'; id: string }
  | { type: 'scan'; code: string }
  | { type: 'operation'; id: string }
  | { type: 'good'; value: number | null }
  | { type: 'defects'; kind: 'scrap' | 'rework'; counts: Readonly<Record<string, number>> }
  | { type: 'toReason' }
  | { type: 'behalfReason'; code: string }
  | { type: 'overrideReason'; code: string }
  | { type: 'sendEntry' }
  | { type: 'undoEntry' }
  | { type: 'another' }

export interface LineViewProps {
  model: LineViewModel
  onAction?: (action: LineAction) => void
  onFrame?: (action: FrameAction) => void
  camera?: CameraScanner
}

export function LineViewScreen(props: LineViewProps) {
  return (
    <WithMessages namespaces={[REASON_KIT_NAMESPACE]}>
      <Screen {...props} />
    </WithMessages>
  )
}

const refusalWords =
  (t: Translate) =>
  (code: string): { message: string; fix: string | null } | null =>
    isKnownRefusal(code) ? { message: t(`refusal.${code}.message`), fix: t(`refusal.${code}.fix`) } : null

/** A correction's refusals: the same code on an entry on behalf means another thing. */
const correctionWords =
  (t: Translate) =>
  (code: string): { message: string; fix: string | null } | null =>
    isCorrectionRefusal(code) ? { message: t(`correctionRefusal.${code}.message`), fix: t(`correctionRefusal.${code}.fix`) } : refusalWords(t)(code)

/** A refusal or failure as one line inside a step (the step stays). */
function ProblemLine({ problem, t, words: wordsOf = refusalWords(t) }: { problem: TaskProblem | null | undefined; t: Translate; words?: (code: string) => { message: string; fix: string | null } | null }) {
  const tasks = useT('floor-tasks')
  if (!problem) return null
  const known = problem.kind === 'refused' ? wordsOf(problem.code) : null
  const words = problem.kind === 'refused' ? [known?.message ?? (problem.message || t('refusal.other')), known ? known.fix : problem.fix].filter(Boolean).join(' ') : tasks(`problem.${problem.kind === 'stepUp' ? 'forbidden' : problem.kind}.title`)
  return (
    <TaskLine tone="danger" icon={<CircleAlert />} alert>
      {words}
    </TaskLine>
  )
}

function Screen({ model, onAction, onFrame, camera }: LineViewProps) {
  const t = useT('floor-lineview')
  const locale = useLocale()
  const send = (action: LineAction) => onAction?.(action)
  const { step, online } = model
  const time = (value: string) => formatTime(value, { locale, timeZone: model.timeZone })
  const back = { label: t('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }), variant: 'quiet' as const }
  const offline = online ? null : t('held.offline')
  let actions: FloorActions | null = null
  let body: ReactNode = null

  switch (step.kind) {
    case 'loading':
      body = <FloorState tone="info" icon={<Users />} title={t('loading')} busy />
      break
    case 'noLine':
      body = <FloorState tone="warning" icon={<CircleAlert />} title={t('noLine.title')} text={t('noLine.body')} />
      actions = [{ label: t('action.home'), icon: <House />, onPress: () => send({ type: 'home' }) }]
      break
    case 'problem':
      body = <ProblemState problem={step.problem} words={refusalWords(t)} />
      actions = [{ label: t('action.home'), icon: <House />, onPress: () => send({ type: 'home' }) }]
      break
    case 'now': {
      body = <Now model={model} step={step} send={send} t={t} locale={locale} time={time} />
      const call = model.calls.find((entry) => entry.id === model.picked) ?? null
      if (call && model.canAnswer) {
        const saved = model.answers.some((entry) => entry.callId === call.id)
        const held = saved ? t('held.saved') : null
        const solved = { label: t('action.solved'), icon: <Check />, variant: call.status === 'ON_THE_WAY' ? ('success' as const) : ('secondary' as const), heldReason: held, onPress: () => send({ type: 'solved' }) }
        actions = call.status === 'ON_THE_WAY' ? [solved] : [solved, { label: t('action.onMyWay'), icon: <UserCheck />, heldReason: held, onPress: () => send({ type: 'onMyWay' }) }]
      }
      break
    }
    case 'decide': {
      const held = decisionHeld(step.item)
      const unread = step.item.kind === 'correction' && !step.record
      const heldWords = offline ?? (held ? t(`held.${held}`) : unread ? t('held.record') : null)
      body = <Decide model={model} step={step} send={send} t={t} locale={locale} time={time} />
      if (step.stage === 'look') {
        actions =
          step.item.kind === 'conflict'
            ? [back, { label: t('action.toOffice'), icon: <Send />, variant: 'secondary', heldReason: heldWords, onPress: () => send({ type: 'stage', stage: 'send' }) }, { label: t('action.keepRecorded'), icon: <ShieldCheck />, heldReason: heldWords, onPress: () => send({ type: 'stage', stage: 'keep' }) }]
            : [back, { label: t('action.reject'), icon: <X />, variant: 'secondary', heldReason: heldWords, onPress: () => send({ type: 'stage', stage: 'reject' }) }, { label: t('action.approve'), icon: <Check />, heldReason: heldWords, onPress: () => send({ type: 'approve' }) }]
      } else if (step.stage === 'reject') {
        const tile = rejectTiles(step.item, { scrap: model.tiles, correction: model.correctionTiles }).find((entry) => entry.code === step.tile) ?? null
        const why = rejectHeld({ item: step.item, tile, words: step.words ?? '' })
        actions = [back, { label: t('action.sendReject'), icon: <X />, variant: 'danger', heldReason: offline ?? (why ? t(`held.reject.${why}`) : null), onPress: () => send({ type: 'reject' }) }]
      } else if (step.stage === 'keep' || step.stage === 'send') {
        actions = [back, { label: t(step.stage === 'keep' ? 'action.keepRecorded' : 'action.toOffice'), icon: <Check />, heldReason: offline ?? (step.tile ? null : t('held.reject.tile')), onPress: () => send({ type: 'conflict' }) }]
      }
      break
    }
    case 'reassign':
      body = <Reassign model={model} step={step} send={send} t={t} locale={locale} />
      actions = step.chosen ? [back, { label: t('action.reassign'), icon: <RefreshCw />, heldReason: offline ?? (step.reason.trim() === '' ? t('held.reject.words') : null), onPress: () => send({ type: 'sendReassign' }) }] : [back]
      break
    case 'handover': {
      const why = handoverHeld(step.draft)
      body = <HandoverForm step={step} send={send} t={t} locale={locale} time={time} />
      actions = [back, { label: t('action.saveNote'), icon: <PenLine />, heldReason: why ? t(`held.note.${why}`) : null, onPress: () => send({ type: 'sendHandover' }) }]
      break
    }
    case 'behalf': {
      body = <Behalf model={model} step={step} send={send} t={t} locale={locale} camera={camera} />
      if (step.stage === 'counts') {
        const why = countsHeld(step.draft)
        actions = [back, { label: t('action.next'), icon: <Check />, heldReason: why ? t(`held.counts.${why}`, { count: expectedOf(step.draft) }) : null, onPress: () => send({ type: 'toReason' }) }]
      } else if (step.stage === 'reason') {
        const why = behalfHeld(step.draft, step.options)
        actions = [back, { label: t('action.enter'), icon: <Check />, heldReason: why ? t(`held.behalf.${why}`) : null, onPress: () => send({ type: 'sendEntry' }) }]
      } else if (step.stage === 'done') {
        actions = [{ label: t('action.another'), icon: <ScanLine />, variant: 'secondary', onPress: () => send({ type: 'another' }) }, { label: t('action.toLine'), icon: <Users />, onPress: () => send({ type: 'back' }) }]
      } else actions = [back]
      break
    }
  }

  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={actions ? <FloorActionBar actions={actions} label={t('title')} /> : undefined}>
      {body}
    </FloorFrameView>
  )
}

// ---- My line now, Calls, Waiting for you, Stations ------------------------------------------------------------------------

interface PartProps {
  model: LineViewModel
  send: (action: LineAction) => void
  t: Translate
  locale: Locale
}

function Now({ model, step, send, t, locale, time }: PartProps & { step: Extract<LineStep, { kind: 'now' }>; time: (value: string) => string }) {
  const ds = useDsWords()
  const { board, line, can } = model
  const numbers = board ? lineNumbers(board, model.callsUnknown ? null : { calls: model.calls }) : null
  const metrics: Metric[] = numbers
    ? [
        { label: t('now.output'), value: numbers.target === null ? String(numbers.done) : `${numbers.done} / ${numbers.target}`, hint: t(`now.pace.${numbers.pace}`) },
        { label: t('now.wip'), value: String(numbers.wip), hint: numbers.stuck > 0 ? t('now.stuck', { count: numbers.stuck }) : t('now.noStuck') },
        { label: t('now.calls'), value: String(numbers.calls), hint: numbers.calls > 0 ? t('now.callsOpen') : t('now.noCalls') },
        { label: t('now.machines'), value: String(numbers.machinesDown), hint: numbers.machinesDown > 0 ? t('now.machinesDown') : t('now.machinesFine') },
        { label: t('now.dhu'), value: numbers.dhu === null ? '—' : `${numbers.dhu} %`, hint: numbers.dhu === null ? t('now.noDhu') : t('now.defects', { count: numbers.defects }) },
      ]
    : []
  const stations = board ? stationStates(board, line) : []
  return (
    <div className="fw-floor-stack fw-lv">
      {board ? (
        <p className="fw-lv-head">
          {[`${board.line.code} · ${board.line.name}`, line?.shift ? t('now.shift', { shift: line.shift }) : null, model.asOf ? null : t('now.asOf', { time: time(board.asOf) })].filter(Boolean).join(' · ')}
        </p>
      ) : null}
      {model.asOf ? <TaskLine tone="warning" icon={<History />}>{t('asOf', { time: time(model.asOf) })}</TaskLine> : null}
      {step.done ? (
        <TaskLine tone="success" icon={<Check />}>
          {t(`done.${step.done}`)}
          {model.ticks ? (
            <>
              {' '}
              <Ticks state={model.ticks} />
            </>
          ) : null}
        </TaskLine>
      ) : null}
      <section className="fw-floor-section" aria-labelledby="fw-lv-now">
        <h2 id="fw-lv-now" className="fw-floor-subtitle">
          {t('now.title')}
        </h2>
        <MetricStrip metrics={metrics} className="fw-lv-metrics" minTileWidth={150} />
      </section>
      <section className="fw-floor-section" aria-labelledby="fw-lv-calls">
        <h2 id="fw-lv-calls" className="fw-floor-subtitle">
          {t('calls.title')}
        </h2>
        {model.callsUnknown ? (
          <TaskLine tone="warning" icon={<CloudOff />}>{t('calls.unknown')}</TaskLine>
        ) : model.calls.length === 0 ? (
          <p className="fw-floor-lead">{t('calls.none')}</p>
        ) : (
          <>
            <FloorList label={t('calls.title')} updates={model.callsPending > 0 ? <FloorListUpdates pending={model.callsPending} onShow={() => send({ type: 'showCalls' })} labels={ds.floorListUpdates} /> : undefined}>
              {model.calls.map((call) => {
                const saved = model.answers.some((entry) => entry.callId === call.id)
                return (
                  <FloorListRow
                    key={call.id}
                    icon={callIcon(call)}
                    title={`${call.station.code} · ${reasonWords(call.type, locale)}`}
                    meta={saved ? t('calls.saved') : t(`status.${call.status}`)}
                    tone={call.status === 'SENT' ? 'warning' : 'info'}
                    selected={call.id === model.picked}
                    status={<FloorElapsed since={call.sentAt} warnAfterMs={WARN_AFTER_MS} dangerAfterMs={DANGER_AFTER_MS} size="md" labels={ds.floorElapsed} />}
                    onPress={() => send({ type: 'pickCall', id: call.id })}
                  />
                )
              })}
            </FloorList>
            {model.canAnswer ? null : <p className="fw-floor-muted">{t('held.noAnswer')}</p>}
          </>
        )}
      </section>
      {can.lead ? (
        <section className="fw-floor-section" aria-labelledby="fw-lv-waiting">
          <h2 id="fw-lv-waiting" className="fw-floor-subtitle">
            {t('waiting.title')}
          </h2>
          {model.waitingUnknown ? <TaskLine tone="warning" icon={<CloudOff />}>{t('waiting.unknown')}</TaskLine> : null}
          {model.waiting.length === 0 ? (
            model.waitingUnknown ? null : <p className="fw-floor-lead">{t('waiting.none')}</p>
          ) : (
            <>
              <FloorList label={t('waiting.title')} updates={model.waitingPending > 0 ? <FloorListUpdates pending={model.waitingPending} onShow={() => send({ type: 'showWaiting' })} labels={ds.floorListUpdates} /> : undefined}>
                {model.waiting.map((item) => {
                  const why = decisionHeld(item)
                  return <FloorListRow key={waitingKey(item)} icon={waitingIcon(item)} title={waitingTitle(item, t, locale)} meta={waitingMeta(item, t)} tone={why ? 'neutral' : 'warning'} status={why ? t(`waiting.state.${why}`) : time(item.at)} onPress={() => send({ type: 'open', item })} />
                })}
              </FloorList>
              <ListFooter count={t('waiting.count', { count: model.waiting.length })} keys={[{ key: 'Tab', does: t('keys.move') }, { key: 'Enter', does: t('keys.open') }, { key: 'Esc', does: t('keys.back') }]} />
            </>
          )}
        </section>
      ) : null}
      <section className="fw-floor-section" aria-labelledby="fw-lv-stations">
        <h2 id="fw-lv-stations" className="fw-floor-subtitle">
          {t('stations.title')}
        </h2>
        {stations.length === 0 ? (
          <p className="fw-floor-lead">{t('stations.none')}</p>
        ) : (
          <ul className="fw-lv-stations" aria-label={t('stations.title')}>
            {stations.map((station) => (
              <li key={station.id} className="fw-lv-station" data-tone={station.tone}>
                <span className="fw-lv-station-code">{station.code}</span>
                <span className="fw-lv-station-name">{station.name}</span>
                <ul className="fw-lv-station-states">
                  {station.machineDown ? <State icon={<AlertOctagon />}>{t('stations.machineDown')}</State> : null}
                  {station.call !== 'CLEAR' ? <State icon={station.call === 'CALLING' ? <Bell /> : <UserCheck />}>{t(`stations.${station.call}`)}</State> : null}
                  {station.material ? <State icon={<Package />}>{t('stations.material')}</State> : null}
                  {station.signedIn === false ? <State icon={<UserX />}>{t('stations.nobody')}</State> : null}
                  {!station.machineDown && station.call === 'CLEAR' && !station.material && station.signedIn !== false && station.reassign.length === 0 ? <State icon={<Check />}>{t('stations.clear')}</State> : null}
                </ul>
                {station.reassign.map((row) => (
                  <span key={row.assignmentId} className="fw-lv-reassign">
                    <span>{t('stations.notIn', { work: row.workOrder ? `${row.workOrder.number}${row.operation ? ` · Op ${row.operation.seq}` : ''}` : station.code })}</span>
                    <FloorButton size="md" variant="secondary" icon={<RefreshCw />} heldReason={model.online ? null : t('held.offline')} onClick={() => send({ type: 'reassign', station: station.code, assignmentId: row.assignmentId })}>
                      {t('action.reassign')}
                    </FloorButton>
                  </span>
                ))}
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="fw-lv-more">
        {can.handover ? (
          <FloorButton size="lg" variant="secondary" icon={<PenLine />} onClick={() => send({ type: 'handover' })}>
            {t('action.handover')}
          </FloorButton>
        ) : null}
        {can.behalf ? (
          <FloorButton size="lg" variant="secondary" icon={<ScanLine />} onClick={() => send({ type: 'behalf' })}>
            {t('action.behalf')}
          </FloorButton>
        ) : null}
      </div>
    </div>
  )
}

function State({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="fw-lv-state">
      <span className="fw-floor-inline-icon" aria-hidden="true">
        {icon}
      </span>
      {children}
    </li>
  )
}

function callIcon(call: Pick<LineCall, 'type'>): ReactNode {
  return call.type.kind === 'MATERIAL' ? <Package /> : call.type.kind === 'MACHINE' || call.type.kind === 'MAINTENANCE' ? <Wrench /> : call.type.kind === 'QUALITY' ? <ShieldCheck /> : <Bell />
}

const waitingIcon = (item: WaitingItem): ReactNode => (item.kind === 'scrap' ? <Trash2 /> : item.kind === 'block' ? <Timer /> : item.kind === 'correction' ? <PenLine /> : <Layers />)

function waitingTitle(item: WaitingItem, t: Translate, locale: Locale): string {
  if (item.kind === 'scrap') return t('waiting.scrap', { count: item.row.scrapQuantity, bundle: item.row.bundle.code })
  if (item.kind === 'block') return t('waiting.block', { code: locale === 'it' ? item.row.code.labelIt : item.row.code.labelEn, count: item.row.minutes })
  if (item.kind === 'correction') return t('waiting.correction', { bundle: item.row.bundle.code })
  return t('waiting.conflict', { bundle: item.row.bundle.code })
}

function waitingMeta(item: WaitingItem, t: Translate): string {
  const op = (row: { operation: { seq: number; name: string } }) => t('fact.op', { seq: row.operation.seq, name: row.operation.name })
  if (item.kind === 'scrap') return [op(item.row), item.row.station?.code].filter(Boolean).join(' · ')
  if (item.kind === 'block') return item.row.station?.code ?? t('fact.noStation')
  if (item.kind === 'correction') return [op(item.row), item.row.station?.code, ...correctionChanges(item.row).map((change) => `${t(`fact.${change.key}`)} ${change.from} → ${change.to}`)].filter(Boolean).join(' · ')
  return op(item.row)
}

// ---- a decision ---------------------------------------------------------------------------------------------------------------

function Decide({ model, step, send, t, locale, time }: PartProps & { step: Extract<LineStep, { kind: 'decide' }>; time: (value: string) => string }) {
  const ds = useDsWords()
  const tasks = useT('floor-tasks')
  const words = useReasonWords()
  const { item } = step
  const summary = <Summary item={item} record={step.record ?? null} t={t} locale={locale} time={time} />
  const problemWords = item.kind === 'correction' ? correctionWords(t) : refusalWords(t)
  if (step.stage === 'pin') {
    const problem = step.pinProblem
    return (
      <PinSignBlock
        title={t('pin.title')}
        summary={<p className="fw-floor-subtitle">{waitingTitle(item, t, locale)}</p>}
        meaning={t(item.kind === 'correction' && step.act?.type === 'reject' ? 'pin.meaning.correctionRefused' : `pin.meaning.${item.kind}`)}
        signer={{ name: model.signer }}
        onSign={(pin) => send({ type: 'pin', pin })}
        onCancel={() => send({ type: 'back' })}
        state={step.busy ? 'busy' : 'idle'}
        locked={problem === 'locked' || problem === 'offline'}
        message={problem ? tasks(`pin.problem.${problem}`) : undefined}
        messageTone={problem === 'wrong' || problem === 'locked' ? 'danger' : 'warning'}
        autoFocus
        labels={ds.pinSignBlock}
      />
    )
  }
  if (step.stage === 'reject') {
    const tiles = rejectTiles(item, { scrap: model.tiles, correction: model.correctionTiles })
    const tile = tiles.find((entry) => entry.code === step.tile) ?? null
    const reasons: ReasonTile[] = tiles.map((entry) => ({ id: entry.code, label: locale === 'it' ? entry.labelIt : entry.labelEn, icon: <MessageSquare /> }))
    const asked = item.kind === 'block' || tile?.needsDetail
    return (
      <div className="fw-floor-stack">
        <p className="fw-floor-subtitle">{waitingTitle(item, t, locale)}</p>
        {reasons.length > 0 ? <ReasonGrid label={t('reject.title')} reasons={reasons} value={step.tile ?? null} onChange={(code) => send({ type: 'tile', code })} words={words} locale={INTL_LOCALE[locale]} /> : null}
        {asked ? (
          <Field label={t('reject.words')} required htmlFor="fw-lv-words">
            <Textarea id="fw-lv-words" value={step.words ?? ''} rows={3} limit={item.kind === 'correction' ? CORRECTION_NOTE_MAX : REASON_MAX} maxLength={item.kind === 'correction' ? CORRECTION_NOTE_MAX : REASON_MAX} onChange={(event) => send({ type: 'words', text: event.target.value })} />
          </Field>
        ) : null}
        <ProblemLine problem={step.problem} t={t} words={problemWords} />
      </div>
    )
  }
  if (step.stage === 'keep' || step.stage === 'send') {
    const decision = decisionOf(model.decisions, step.stage === 'keep' ? 'KEEP_RECORDED' : 'SEND_TO_OFFICE')
    const reasons: ReasonTile[] = (decision?.reasons ?? []).map((reason) => ({ id: reason.code, label: t(`conflict.reason.${reason.code}`), icon: <MessageSquare /> }))
    return (
      <div className="fw-floor-stack">
        <p className="fw-floor-lead">{t(`conflict.${step.stage}`)}</p>
        <ReasonGrid label={t('reject.title')} reasons={reasons} value={step.tile ?? null} onChange={(code) => send({ type: 'tile', code })} words={words} locale={INTL_LOCALE[locale]} />
        <ProblemLine problem={step.problem} t={t} />
      </div>
    )
  }
  const held = decisionHeld(item)
  return (
    <div className="fw-floor-stack">
      {step.done ? <TaskLine tone="success" icon={<Check />}>{t('done.next')}</TaskLine> : null}
      {summary}
      {held ? <TaskLine tone="info" icon={<CircleAlert />}>{t(`held.${held}`)}</TaskLine> : null}
      {!model.online ? <TaskLine tone="warning" icon={<WifiOff />}>{t('held.offline')}</TaskLine> : null}
      {item.kind === 'correction' && !step.record && !step.problem ? <TaskLine tone={step.recordUnread ? 'warning' : 'info'} icon={step.recordUnread ? <CloudOff /> : <History />}>{t(step.recordUnread ? 'correction.unread' : 'correction.reading')}</TaskLine> : null}
      <ProblemLine problem={step.problem} t={t} words={problemWords} />
    </div>
  )
}

function Summary({ item, record, t, locale, time }: { item: WaitingItem; record: CorrectionRecord | null; t: Translate; locale: Locale; time: (value: string) => string }) {
  const ds = useDsWords()
  if (item.kind === 'correction') {
    const { row } = item
    const changes = correctionChanges(row)
    const count = (key: 'good' | 'scrap' | 'rework') => {
      const change = changes.find((entry) => entry.key === key)
      return { id: key, label: t(`fact.${key}`), value: change ? `${change.from} → ${change.to}` : String(row.asked[key]), ...(change ? { tone: 'warning' as const } : {}) }
    }
    const lines = (reasons: CorrectionRecord['reasons']) => reasons.map((reason) => `${reasonWords(reason, locale)} · ${reason.quantity}`).join(', ') || null
    return (
      <FloorCard
        icon={<PenLine />}
        kind={t('correction.kind')}
        code={row.bundle.code}
        status={{ label: t('correction.waits'), tone: 'warning' }}
        facts={[
          { id: 'operation', label: t('fact.operation'), value: t('fact.op', { seq: row.operation.seq, name: row.operation.name }) },
          { id: 'station', label: t('fact.station'), value: row.station?.code ?? t('fact.noStation') },
          { id: 'workOrder', label: t('fact.workOrder'), value: row.workOrder.number },
          { id: 'person', label: t('fact.person'), value: record?.person },
          { id: 'reported', label: t('fact.reported'), value: time(row.recorded.at) },
          count('good'),
          count('scrap'),
          count('rework'),
        ]}
        labels={ds.floorCard}
      >
        {record ? (
          <dl className="fw-lv-words">
            {[
              { id: 'why', label: t('fact.why'), value: record.reason },
              { id: 'reasonsBefore', label: t('fact.reasonsBefore'), value: lines(record.recordedReasons) },
              { id: 'reasons', label: t('fact.reasons'), value: lines(record.reasons) },
            ].map((entry) =>
              entry.value ? (
                <div key={entry.id}>
                  <dt>{entry.label}</dt>
                  <dd>{entry.value}</dd>
                </div>
              ) : null,
            )}
          </dl>
        ) : null}
      </FloorCard>
    )
  }
  if (item.kind === 'scrap') {
    const { row } = item
    return (
      <FloorCard
        icon={<Trash2 />}
        kind={t('scrap.kind')}
        code={row.bundle.code}
        status={{ label: t('scrap.waits'), tone: 'warning' }}
        facts={[
          { id: 'operation', label: t('fact.operation'), value: t('fact.op', { seq: row.operation.seq, name: row.operation.name }) },
          { id: 'station', label: t('fact.station'), value: row.station?.code ?? '—' },
          { id: 'workOrder', label: t('fact.workOrder'), value: row.workOrder.number },
          { id: 'good', label: t('fact.good'), value: String(row.goodQuantity) },
          { id: 'scrap', label: t('fact.scrap'), value: String(row.scrapQuantity), tone: 'danger' },
          { id: 'rework', label: t('fact.rework'), value: String(row.reworkQuantity) },
          { id: 'limit', label: t('fact.limit'), value: row.approval.limit === null ? '—' : String(row.approval.limit) },
          { id: 'reasons', label: t('fact.reasons'), value: row.reasons.map((reason) => `${reasonWords(reason, locale)} · ${reason.quantity}`).join(', ') || '—' },
        ]}
        labels={ds.floorCard}
      />
    )
  }
  if (item.kind === 'block') {
    const { row } = item
    return (
      <FloorCard
        icon={<Timer />}
        kind={t('block.kind')}
        code={locale === 'it' ? row.code.labelIt : row.code.labelEn}
        status={{ label: t('block.waits'), tone: 'warning' }}
        facts={[
          { id: 'station', label: t('fact.station'), value: row.station ? `${row.station.code} · ${row.station.name}` : t('fact.noStation') },
          { id: 'from', label: t('fact.from'), value: time(row.startedAt) },
          { id: 'to', label: t('fact.to'), value: row.endedAt ? time(row.endedAt) : '—' },
          { id: 'minutes', label: t('fact.minutes'), value: String(row.minutes) },
        ]}
        labels={ds.floorCard}
      />
    )
  }
  return <ConflictSides conflict={item.row} t={t} time={time} />
}

/** Both reports side by side: the one refused and the one recorded first (design "pick the one that stands"). */
function ConflictSides({ conflict, t, time }: { conflict: Conflict; t: Translate; time: (value: string) => string }) {
  const ds = useDsWords()
  const side = (row: Conflict['refused'], heading: string, tone: 'warning' | 'success', icon: ReactNode) => (
    <FloorCard
      icon={icon}
      kind={heading}
      code={row.station?.code ?? row.deviceName ?? t('conflict.office')}
      status={{ label: time(row.serverTime), tone }}
      facts={[
        { id: 'tablet', label: t('fact.tablet'), value: row.deviceName ?? t('conflict.office') },
        { id: 'good', label: t('fact.good'), value: String(row.good) },
        { id: 'scrap', label: t('fact.scrap'), value: String(row.scrap) },
        { id: 'rework', label: t('fact.rework'), value: String(row.rework) },
      ]}
      headingLevel={3}
      labels={ds.floorCard}
    />
  )
  return (
    <section className="fw-floor-section" aria-label={t('conflict.title', { bundle: conflict.bundle.code })}>
      <p className="fw-floor-subtitle">{t('conflict.title', { bundle: conflict.bundle.code })}</p>
      <p className="fw-floor-muted">{t('fact.op', { seq: conflict.operation.seq, name: conflict.operation.name })}</p>
      <div className="fw-lv-sides">
        {side(conflict.recorded, t('conflict.recorded'), 'success', <ShieldCheck />)}
        {side(conflict.refused, t('conflict.refused'), 'warning', <TriangleAlert />)}
      </div>
    </section>
  )
}

// ---- reassign ---------------------------------------------------------------------------------------------------------------

function Reassign({ model, step, send, t, locale }: PartProps & { step: Extract<LineStep, { kind: 'reassign' }> }) {
  const ds = useDsWords()
  const work = step.row.workOrder ? `${step.row.workOrder.number}${step.row.operation ? ` · ${t('fact.op', { seq: step.row.operation.seq, name: step.row.operation.name })}` : ''}` : step.station
  if (step.chosen) {
    return (
      <div className="fw-floor-stack">
        <p className="fw-floor-subtitle">{t('reassign.to', { name: step.chosen.name })}</p>
        {step.chosen.words ? <TaskLine tone="warning" icon={<TriangleAlert />}>{step.chosen.words}</TaskLine> : null}
        <Field label={t('reassign.why')} required htmlFor="fw-lv-why">
          <Textarea id="fw-lv-why" value={step.reason} rows={2} limit={REASON_MAX} maxLength={REASON_MAX} onChange={(event) => send({ type: 'words', text: event.target.value })} />
        </Field>
        <ProblemLine problem={step.problem} t={t} />
      </div>
    )
  }
  return (
    <div className="fw-floor-stack">
      <p className="fw-floor-subtitle">{t('reassign.title', { station: step.station })}</p>
      <p className="fw-floor-muted">{work}</p>
      <ProblemLine problem={step.problem} t={t} />
      {step.people === null ? (
        step.problem ? null : <FloorState tone="info" icon={<Users />} title={t('reassign.loading')} busy />
      ) : step.people.operators.length === 0 ? (
        <p className="fw-floor-lead">{t('reassign.none')}</p>
      ) : (
        <>
          {step.people.clockedOnly ? <p className="fw-floor-muted">{t('reassign.clocked')}</p> : null}
          <FloorNamePicker
            label={t('reassign.pick')}
            people={step.people.operators.map((person) => ({ id: person.workerId, name: person.name, ...(person.decision === 'WARN' && person.words ? { detail: person.words } : {}), ...(reassignHeld(person) !== null ? { heldReason: reassignHeld(person) || t('reassign.heldPerson') } : {}) }))}
            onPick={(id) => send({ type: 'person', id })}
            heldReason={model.online ? null : t('held.offline')}
            locale={INTL_LOCALE[locale]}
            labels={ds.floorNamePicker}
          />
        </>
      )}
    </div>
  )
}

// ---- the handover note --------------------------------------------------------------------------------------------------------

const TOPIC_ICONS: Readonly<Record<HandoverTopic, ReactNode>> = { PROBLEMS: <TriangleAlert />, HALF_DONE_BUNDLES: <Layers />, MACHINES: <Wrench />, MATERIAL: <Package />, QUALITY: <ShieldCheck />, OTHER: <MessageSquare /> }

function HandoverForm({ step, send, t, locale, time }: { step: Extract<LineStep, { kind: 'handover' }>; send: (action: LineAction) => void; t: Translate; locale: Locale; time: (value: string) => string }) {
  const last = step.note?.notes.find((entry) => entry.id !== step.note?.current?.id) ?? null
  return (
    <div className="fw-floor-stack">
      {step.asOf ? <TaskLine tone="warning" icon={<History />}>{t('asOf', { time: time(step.asOf) })}</TaskLine> : null}
      {last ? (
        <section className="fw-floor-section fw-lv-last" aria-labelledby="fw-lv-last">
          <h2 id="fw-lv-last" className="fw-floor-subtitle">
            {t('handover.last', { shift: last.shiftLabel, day: formatDate(last.shiftDate, { locale }) })}
          </h2>
          <p className="fw-floor-muted">{last.topics.map((topic) => (locale === 'it' ? topic.labelIt : topic.labelEn)).join(' · ')}</p>
          {last.text ? <p className="fw-lv-text">{last.text}</p> : null}
        </section>
      ) : null}
      <section className="fw-floor-section" aria-labelledby="fw-lv-note">
        <h2 id="fw-lv-note" className="fw-floor-subtitle">
          {t('handover.title', { shift: step.shift })}
        </h2>
        <div className="fw-lv-topics" role="group" aria-label={t('handover.topics')}>
          {TOPICS.map((topic) => {
            const on = step.draft.topics.includes(topic)
            return (
              <FloorButton key={topic} size="lg" variant={on ? 'primary' : 'secondary'} icon={TOPIC_ICONS[topic]} aria-pressed={on} onClick={() => send({ type: 'topic', topic })}>
                {t(`topic.${topic}`)}
              </FloorButton>
            )
          })}
        </div>
        <Field label={t('handover.text')} htmlFor="fw-lv-text">
          <Textarea id="fw-lv-text" value={step.draft.text} rows={4} limit={NOTE_MAX} maxLength={NOTE_MAX} onChange={(event) => send({ type: 'words', text: event.target.value })} />
        </Field>
        <p className="fw-floor-muted">{t('handover.wall')}</p>
      </section>
      <ProblemLine problem={step.problem} t={t} />
    </div>
  )
}

// ---- scan on behalf -----------------------------------------------------------------------------------------------------------

function Behalf({ model, step, send, t, locale, camera }: PartProps & { step: Extract<LineStep, { kind: 'behalf' }>; camera?: CameraScanner }) {
  const ds = useDsWords()
  const words = useReasonWords()
  const { draft, options } = step
  const person = options.people.find((entry) => entry.id === draft.personId)?.name ?? null
  const station = options.stations.find((entry) => entry.id === draft.stationId)
  const where = [station ? `${station.code} · ${station.name}` : null, person].filter(Boolean).join(' · ')
  const lineId = model.board?.line.id ?? null
  const scanLabels = camera ? { scanner: camera, startLabel: t('camera.start'), stopLabel: t('camera.stop'), errorLabel: t('camera.error') } : undefined
  const offlineLine = !model.online ? <TaskLine tone="warning" icon={<WifiOff />}>{t('behalf.offline')}</TaskLine> : null
  switch (step.stage) {
    case 'station': {
      // This line's stations first; the site's others after them (a report is at the station of the operation's kind of work).
      const list = [...options.stations].sort((a, b) => Number(b.lineId === lineId) - Number(a.lineId === lineId))
      return (
        <div className="fw-floor-stack">
          <p className="fw-floor-lead">{t('behalf.lead')}</p>
          {offlineLine}
          <FloorTileGrid label={t('behalf.station')} columns={3}>
            {list.map((entry) => (
              <FloorTile key={entry.id} icon={<Users />} label={entry.code} hint={entry.name} onPress={() => send({ type: 'station', id: entry.id })} />
            ))}
          </FloorTileGrid>
        </div>
      )
    }
    case 'person':
      return (
        <div className="fw-floor-stack">
          <p className="fw-floor-muted">{where}</p>
          {options.people.length === 0 ? <p className="fw-floor-lead">{t('behalf.nobody')}</p> : <FloorNamePicker label={t('behalf.person')} people={options.people} onPick={(id) => send({ type: 'person', id })} locale={INTL_LOCALE[locale]} labels={ds.floorNamePicker} />}
        </div>
      )
    case 'scan':
      return (
        <div className="fw-floor-stack">
          <p className="fw-floor-muted">{where}</p>
          {offlineLine}
          <ScanInput label={t('behalf.scan')} hint={t('behalf.scanHint')} scannedLabel={(code) => t('behalf.read', { code })} keyboardLabel={t('behalf.type')} disabled={Boolean(step.busy)} camera={scanLabels} onScan={(code) => send({ type: 'scan', code })} />
          <ProblemLine problem={step.problem} t={t} />
        </div>
      )
    case 'operation':
      return (
        <div className="fw-floor-stack">
          <p className="fw-floor-subtitle">{t('behalf.operation', { bundle: draft.card?.bundle.code ?? '' })}</p>
          <FloorList label={t('behalf.operationList')}>
            {(draft.card ? openOperations(draft.card) : []).map((operation) => (
              <FloorListRow key={operation.id} icon={<ClipboardList />} title={t('fact.op', { seq: operation.seq, name: operation.name })} onPress={() => send({ type: 'operation', id: operation.id })} />
            ))}
          </FloorList>
        </div>
      )
    case 'counts': {
      const expected = expectedOf(draft)
      const tiles = (kind: 'SCRAP' | 'REWORK'): ReasonTile[] => (draft.card?.reasons ?? []).filter((reason) => reason.kind === kind).map((reason) => ({ id: reason.code, label: reason.label[locale === 'it' ? 'it' : 'en'], icon: kind === 'SCRAP' ? <Trash2 /> : <Wrench /> }))
      const held = countsHeld(draft)
      return (
        <div className="fw-floor-stack">
          <p className="fw-floor-subtitle">{[draft.card?.bundle.code, where].filter(Boolean).join(' · ')}</p>
          <QuantityPad
            label={t('counts.good')}
            value={draft.good}
            onChange={(value) => send({ type: 'good', value })}
            min={0}
            max={expected}
            expected={expected}
            expectedLabel={(count) => t('counts.of', { count })}
            decimalSeparator={locale === 'it' ? ',' : '.'}
            decrementLabel={t('pad.less')}
            incrementLabel={t('pad.more')}
            clearLabel={t('pad.clear')}
            backLabel={t('pad.back')}
            emptyLabel={t('pad.empty')}
            rangeLabel={(_min, max) => t('held.counts.atMost', { count: max ?? expected })}
          />
          {held === 'atMost' ? <TaskLine tone="warning" icon={<TriangleAlert />} alert>{t('held.counts.atMost', { count: expected })}</TaskLine> : null}
          <ReasonGrid mode="count" label={t('counts.scrap')} reasons={tiles('SCRAP')} counts={draft.scrap} onCountChange={(counts) => send({ type: 'defects', kind: 'scrap', counts })} words={words} locale={INTL_LOCALE[locale]} />
          <ReasonGrid mode="count" label={t('counts.rework')} reasons={tiles('REWORK')} counts={draft.rework} onCountChange={(counts) => send({ type: 'defects', kind: 'rework', counts })} words={words} locale={INTL_LOCALE[locale]} />
        </div>
      )
    }
    case 'reason': {
      const reason = options.reasons.find((entry) => entry.code === draft.reason)
      const tiles: ReasonTile[] = options.reasons.map((entry) => ({ id: entry.code, label: entry.label[locale === 'it' ? 'it' : 'en'], icon: <MessageSquare /> }))
      return (
        <div className="fw-floor-stack">
          <ProblemLine problem={step.problem} t={t} />
          <p className="fw-floor-subtitle">{t('behalf.summary', { bundle: draft.card?.bundle.code ?? '', count: draft.good })}</p>
          <p className="fw-floor-muted">{where}</p>
          <ReasonGrid label={t('behalf.reason')} reasons={tiles} value={draft.reason} onChange={(code) => send({ type: 'behalfReason', code })} words={words} locale={INTL_LOCALE[locale]} />
          {reason?.needsNote ? (
            <Field label={t('reject.words')} required htmlFor="fw-lv-behalf">
              <Textarea id="fw-lv-behalf" value={draft.note} rows={2} limit={200} maxLength={200} onChange={(event) => send({ type: 'words', text: event.target.value })} />
            </Field>
          ) : null}
          <p className="fw-floor-muted">{t('behalf.mark')}</p>
          {offlineLine}
        </div>
      )
    }
    case 'override': {
      const held = overrideHeld(step.override)
      const tiles: ReasonTile[] = OVERRIDE_TILES.map((entry) => ({ id: entry.code, label: entry.label[locale === 'it' ? 'it' : 'en'], icon: <MessageSquare /> }))
      const reason = OVERRIDE_TILES.find((entry) => entry.code === step.override.reason)
      return (
        <div className="fw-floor-stack">
          <ProblemLine problem={step.problem} t={t} />
          <p className="fw-floor-lead">{t('behalf.override')}</p>
          <ReasonGrid label={t('behalf.overrideReason')} reasons={tiles} value={step.override.reason} onChange={(code) => send({ type: 'overrideReason', code })} words={words} locale={INTL_LOCALE[locale]} />
          {reason?.needsNote ? (
            <Field label={t('reject.words')} required htmlFor="fw-lv-override">
              <Textarea id="fw-lv-override" value={step.override.note} rows={2} limit={200} maxLength={200} onChange={(event) => send({ type: 'words', text: event.target.value })} />
            </Field>
          ) : null}
          {step.override.badge ? (
            <PinSign title={t('behalf.pin')} meaning={t('behalf.pinMeaning')} onPin={(pin) => send({ type: 'pin', pin })} busy={Boolean(step.busy)} problem={null} />
          ) : (
            <ScanInput label={t('behalf.badge')} hint={held === 'badge' ? t('behalf.badgeHint') : t('held.behalf.reason')} scannedLabel={(code) => t('behalf.read', { code })} keyboardLabel={t('behalf.type')} disabled={held !== 'badge'} onScan={(code) => send({ type: 'scan', code })} />
          )}
        </div>
      )
    }
    case 'done':
      return (
        <div className="fw-floor-stack">
          {step.undone ? (
            <TaskLine tone="info" icon={<RotateCcw />}>{t('behalf.undone')}</TaskLine>
          ) : step.entered ? (
            <UndoStrip text={t('behalf.entered', { bundle: draft.card?.bundle.code ?? '', count: draft.good })} ticks="recorded" onUndo={() => send({ type: 'undoEntry' })} undoHeld={model.online ? null : t('held.offline')} />
          ) : (
            <FloorState tone="info" icon={<ScanLine />} title={t('behalf.entered', { bundle: draft.card?.bundle.code ?? '', count: draft.good })}>
              {model.ticks ? (
                <p className="fw-lv-ticks">
                  <Ticks state={model.ticks} />
                </p>
              ) : null}
            </FloorState>
          )}
          <p className="fw-floor-muted">{t('behalf.mark')}</p>
          <ProblemLine problem={step.problem} t={t} />
        </div>
      )
  }
}
