'use client'

import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowLeft, Check, CircleAlert, CircleCheckBig, CircleHelp, ClipboardCheck, CloudOff, Flame, House, ListEnd, ListTodo, MapPinOff, MessageSquare, MessageSquareText, PackageSearch, PauseCircle, RotateCcw, ScanLine, ShieldOff, Siren, Ban, Clock, TriangleAlert, Truck, Wrench, X } from 'lucide-react'
import { FloorActionBar, FloorButton, FloorList, FloorListRow, FloorTile, FloorTileGrid, ScanInput, type CameraScanner, type FloorActions } from '@nexus/ui/floor'
import { FloorCard } from '@nexus/ui/floor/FloorCard/index'
import { FloorListUpdates } from '@nexus/ui/floor/FloorListUpdates/index'
import { ReadAloudButton } from '@nexus/ui/floor/ReadAloud/index'
import { Modal, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime, formatNumber, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Translate } from '../../../../lib/i18n/messages'
import { InstructionsTile } from '../instructions-tile'
import type { Locale } from '../../../../lib/i18n/locales'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import type { FloorMode } from '../../../model'
import { ListFooter, TaskLine, Ticks, type TickState } from '../../shared/view/TaskParts'
import { ReasonPickerBody, useDoneHeld, type ReasonPickerAction, type ReasonPickerModel } from '../../reasons/view/ReasonPicker'
import { arranged, emptyOf, excerptOf, leftOf, MATERIAL_TONE, putLastWords, STATE_TONE, unreadCount, type DispatchEntry, type DispatchList, type HelpHeld, type MaterialFlag, type MyMessages, type PutLast, type QueueRow, type WorkMessage } from '../model'
// B-W2b-126: the repair queue (MES-132).
import { repairHeld, repairTile, type RepairQueue } from '../repair/model'
import { RepairCard, RepairLine, RepairList, RepairOut, RepairUnread, type RepairLineModel } from '../repair/view/RepairViews'
// B-W2b-109: the inspector queue (QHS-068).
import type { InspectorQueue, OpenHeld } from '../inspections/model'
import { InspectionCard, InspectionList, InspectionsUnread } from '../inspections/view/InspectionViews'
// B-W2b-308: at the warehouse My work is the task inbox (SCM-274).
import { InboxView, type InboxViewModel } from '../warehouse/view/InboxView'
import '../mywork.css'

/**
 * SCR-089 — My work (design floor.mywork; MES-021, MES-022, MES-026, COL-036; Owner answers P3, F2): the station's queue from
 * the plan the office published, or what the day names the person for across stations. "Next": the one next task, big —
 * work order, style, operation, pieces left, its status word in its tone, Rush with an icon and a word, the material flag.
 * "For your work": the messages on my work orders not opened on this tablet (hidden at zero; New instructions joins it with
 * W2b-4). "Then": the rest, rush first, then due date, then sequence. Nothing starts from a row: the worker scans the real
 * bundle (no wrong-row mistakes, MES-188); a row opens its card. A fresher list waits behind "List changed · Show" (rows
 * never move under a gloved finger). "I can't find it": Call for help: Material in one tap, through the tablet's queue, or
 * put the task last on this tablet with a reason tile (the office's plan does not change). Offline: the list from this
 * tablet with its as-of time. Per work order and operation only: no person, no money, no pace (art. 4, F2).
 */

export type MyWorkStep =
  | { readonly kind: 'loading' }
  | { readonly kind: 'list' }
  /** A row opened: its card as a step (scanning still starts the work). */
  | { readonly kind: 'entry'; readonly slotId: string }
  /** Put it last: the reason tile (the office's PAUSE list). */
  | { readonly kind: 'reason'; readonly slotId: string; readonly picker: ReasonPickerModel }
  /** "Messages": the open messages on my work orders. */
  | { readonly kind: 'messages' }
  /** One message, whole, with Read aloud. */
  | { readonly kind: 'message'; readonly id: string }
  /** B-W2b-126: the repair queue; one repair's card; how a repair came out (scan out). */
  | { readonly kind: 'repair' }
  | { readonly kind: 'repairItem'; readonly reworkId: string }
  | { readonly kind: 'repairOut'; readonly reworkId: string; readonly code: string | null; readonly good: number | null }
  /** B-W2b-109: my inspections (the inspector queue); one inspection's card. */
  | { readonly kind: 'inspections' }
  | { readonly kind: 'inspection'; readonly key: string }
  | { readonly kind: 'noPermission' }

export interface MyWorkViewModel {
  frame: FrameModel
  step: MyWorkStep
  /** The list on screen (a fresher one waits behind "List changed · Show"). */
  list: DispatchList | null
  putLast: readonly PutLast[]
  /** The list could not be read (and none is kept on this tablet): failed, or offline. */
  problem?: 'error' | 'offline' | null
  /** Shown from this tablet (offline, or the office did not answer): as of when. */
  asOf?: string | null
  /** A fresher list differs from the one on screen. */
  changed?: boolean
  /** "Can't find it?" is open for this task. */
  cantFind?: string | null
  /** Just put last (said once, under the list's head). */
  putLastDone?: { readonly slotId: string } | null
  /** The worker notice holds scans. */
  held?: boolean
  mode: FloorMode | null
  timeZone?: string
  /** How many tasks changed in the fresher list (0: not known). */
  pending?: number
  /** The open messages on my work orders; null: not read yet. */
  messages?: MyMessages | null
  /** The ids opened on this tablet. */
  seen?: readonly string[]
  /** The messages come from this tablet (offline): as of when. */
  messagesAsOf?: string | null
  /** The messages could not be read, and none are kept. */
  messagesFailed?: boolean
  /** B-W2b-232 (FI9:02): the instruction versions waiting for this person's Seen ("New instructions N"; 0 or absent: hidden). */
  instructions?: number
  /** Why Call for help: Material cannot go now; null: one tap sends it. */
  helpHeld?: HelpHeld | null
  /** The call just sent from here. */
  call?: MyWorkCall | null
  /** B-W2b-126: the repair queue as this tablet shows it (null: not read, or no production.repair). */
  repair?: RepairQueue | null
  /** The queue comes from this tablet (offline, or the office did not answer): as of when. */
  repairAsOf?: string | null
  /** The queue could not be read and none is kept. */
  repairProblem?: 'offline' | 'error' | null
  /** What the last repair scan did. */
  repairLine?: RepairLineModel | null
  /** A scan is on its way. */
  repairBusy?: boolean
  /** B-W2b-109: my inspections (null: the person holds no inspection view). */
  inspections?: InspectionsModel | null
  /** B-W2b-308: the warehouse task inbox, drawn instead of the station's queue (the live screen: warehouse/entry.tsx). */
  warehouse?: InboxViewModel | null
}

/** B-W2b-109: the inspector queue as this tablet shows it. */
export interface InspectionsModel {
  /** The queue on screen; null: not read yet (or none kept). */
  readonly queue: InspectorQueue | null
  /** From this tablet: as of when. */
  readonly asOf: string | null
  /** Not read and none kept. */
  readonly problem: 'offline' | 'error' | null
  /** A fresher queue waits behind "List changed · Show", and how many rows differ. */
  readonly changed: boolean
  readonly pending: number
  /** At an inspection bench the queue is My work's list: the station's queue is the secondary action. */
  readonly first: boolean
  /** Why "Inspect" cannot open a row here, by row key. */
  readonly held: Readonly<Record<string, OpenHeld>>
}

export interface MyWorkCall {
  readonly number: string
  readonly seq: number
  readonly ticks: TickState
  /** Why it was refused: a code the screen knows, or nothing it can name. */
  readonly refusal?: string | null
}

export type MyWorkAction =
  | { type: 'scan'; code: string }
  | { type: 'open'; slotId: string }
  | { type: 'back' }
  | { type: 'home' }
  | { type: 'retry' }
  | { type: 'show' }
  | { type: 'cantFind'; slotId: string | null }
  | { type: 'putLast'; slotId: string }
  | { type: 'reason'; action: ReasonPickerAction }
  | { type: 'reasonDone' }
  | { type: 'messages' }
  // B-W2b-232
  | { type: 'instructions' }
  | { type: 'message'; id: string }
  | { type: 'help' }
  | { type: 'repair' }
  | { type: 'repairOpen'; reworkId: string }
  | { type: 'repairStart'; reworkId: string }
  | { type: 'repairGood'; value: number | null }
  | { type: 'repairAllGood' }
  | { type: 'repairConfirm' }
  | { type: 'repairRetry' }
  // B-W2b-109: my inspections.
  | { type: 'inspections' }
  | { type: 'inspectionOpen'; key: string }
  | { type: 'inspectionGo'; key: string }
  | { type: 'inspectionsShow' }
  | { type: 'inspectionsRetry' }
  | { type: 'stationQueue' }

export interface MyWorkViewProps {
  model: MyWorkViewModel
  onAction?: (action: MyWorkAction) => void
  onFrame?: (action: FrameAction) => void
  camera?: CameraScanner
}

const STATE_ICON: Readonly<Record<DispatchEntry['state'], ReactNode>> = {
  READY: <ScanLine />,
  WAITING_FOR_PREVIOUS: <Clock />,
  NOT_RELEASED: <Ban />,
  ON_HOLD: <PauseCircle />,
  DONE: <CircleCheckBig />,
}

/** The status word ("Ready", "Waiting for Op 10", "On hold" …). */
function stateWord(t: Translate, entry: DispatchEntry): string {
  if (entry.state === 'WAITING_FOR_PREVIOUS' && entry.previous) return t('state.waitingFor', { seq: entry.previous.seq })
  return t(`state.${entry.state}`)
}

const opText = (t: Translate, operation: { seq: number; name: string }) => t('op', { seq: operation.seq, name: operation.name })

const MATERIAL_ICON: Readonly<Record<MaterialFlag['state'], ReactNode>> = {
  IN_STOCK: <CircleCheckBig />,
  ON_THE_WAY: <Truck />,
  MISSING: <TriangleAlert />,
  NOT_KNOWN: <CircleHelp />,
}

/** The refusals of a call the screen says in its own words (B-W2b-35 CALL_REFUSALS). */
const KNOWN_CALL_REFUSALS = new Set(['NO_STATION', 'OTHER_STATION', 'TYPE_INACTIVE'])

/** Arrows move between a list's rows (design floor.mywork "Arrows move rows; Enter opens"); Enter presses the focused row. */
function useRowKeys() {
  const group = useRef<HTMLDivElement>(null)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = [...(group.current?.querySelectorAll<HTMLElement>('.nds-floor-row.is-pressable') ?? [])]
    if (items.length === 0) return
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1)
    event.preventDefault()
    items[next]?.focus()
  }
  return { group, onKeyDown }
}

export function MyWorkView(props: MyWorkViewProps) {
  // B-W2b-308: at the warehouse the inbox (its own actions; the design index shows its cases on this screen).
  if (props.model.warehouse) return <InboxView model={props.model.warehouse} onFrame={props.onFrame} camera={props.camera} />
  return <StationWorkView {...props} />
}

function StationWorkView({ model, onAction, onFrame, camera }: MyWorkViewProps) {
  const t = useT('floor-mywork')
  const ti = useT('floor-myinspections')
  const shared = useT('floor-tasks')
  const floor = useT('floor')
  const ds = useDsWords()
  const locale = useLocale()
  const send = (action: MyWorkAction) => onAction?.(action)
  const { step, list } = model
  const timeZone = model.timeZone ?? list?.site.timeZone
  const time = (value: string) => formatTime(value, { locale, timeZone })
  const day = (value: string) => formatDate(`${value}T12:00:00.000Z`, { locale, timeZone: 'UTC' })
  const reasonHeld = useDoneHeld(step.kind === 'reason' ? step.picker : { purpose: 'putLast', value: 'x' })

  const home = { label: shared('action.home'), icon: <House />, onPress: () => send({ type: 'home' }), variant: 'secondary' as const }
  const back = { label: shared('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }), variant: 'secondary' as const }

  const view = list ? arranged(list, model.putLast) : null
  const rowOf = (slotId: string): QueueRow | null => (view ? ([view.next, ...view.queue].find((row) => row?.entry.slotId === slotId) ?? null) : null)

  let actions: FloorActions | null = null
  let body: ReactNode = null

  const scanField = (
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

  // B-W2b-109: on my inspections a scan opens the final bench (QHS-065), and the field says so.
  const inspectScanField = (
    <ScanInput
      label={ti('scan.label')}
      hint={model.held ? floor('tile.held.notice') : ti('scan.hint')}
      scannedLabel={(code) => floor('scan.read', { code })}
      keyboardLabel={floor('scan.type')}
      disabled={Boolean(model.held)}
      camera={camera ? { scanner: camera, startLabel: floor('scan.camera.start'), stopLabel: floor('scan.camera.stop'), errorLabel: floor('scan.camera.error') } : undefined}
      onScan={(code) => send({ type: 'scan', code })}
    />
  )

  /** The big card of one task (Next, or a row opened). */
  const card = (row: QueueRow, id: string, title: string) => {
    const { entry } = row
    const left = leftOf(entry)
    return (
      <FloorCard
        icon={<ListTodo />}
        kind={title}
        code={entry.workOrder.number}
        id={id}
        headingLevel={3}
        title={
          <>
            <p className="fw-mywork-style">
              <span className="fw-floor-code">{entry.workOrder.style.code}</span> · {entry.workOrder.style.name}
            </p>
            <p className="fw-mywork-op">{opText(t, entry.operation)}</p>
          </>
        }
        status={{ label: stateWord(t, entry), tone: STATE_TONE[entry.state] }}
        facts={[
          { id: 'left', label: t('pieces', { count: left }), value: formatNumber(left, locale) },
          { id: 'due', label: t('fact.due'), value: entry.workOrder.dueDate ? day(entry.workOrder.dueDate) : null },
          { id: 'planned', label: t('fact.planned'), value: formatDateTime(entry.startAt, { locale, timeZone }) },
          { id: 'waiting', label: t('fact.waiting'), value: entry.previous ? t('waitingHere', { count: entry.waiting }) : null },
          { id: 'station', label: t('fact.station'), value: entry.station?.name ?? null },
        ]}
        flags={[
          ...(entry.workOrder.rush ? [{ id: 'rush', label: t('rush'), tone: 'danger' as const }] : []),
          ...(entry.state === 'ON_HOLD' ? [{ id: 'hold', label: entry.workOrder.holdReason ? t('onHoldWhy', { reason: entry.workOrder.holdReason }) : t('state.ON_HOLD'), tone: 'danger' as const }] : []),
          ...(entry.material ? [{ id: 'material', label: materialCardWords(entry.material), tone: MATERIAL_TONE[entry.material.state] }] : []),
          ...(row.putLast ? [{ id: 'putLast', label: t('putLast.row', { reason: putLastWords(row.putLast, locale) }), tone: 'info' as const }] : []),
        ]}
        labels={ds.floorCard}
      >
        <TaskLine tone="info" icon={<ScanLine />}>
          {t('scanToStart')}
        </TaskLine>
      </FloorCard>
    )
  }

  /** The material flag on a card: the operation's own (B-W2b-88) or the work order's, and it says which. */
  const materialCardWords = (material: MaterialFlag) => {
    const group = material.scope === 'OPERATION' ? 'material.cardOp' : 'material.card'
    return material.state === 'ON_THE_WAY' && material.date ? t(`${group}.expected`, { date: day(material.date) }) : t(`${group}.${material.state}`)
  }

  const openMessages = model.messages?.messages ?? []
  const unread = unreadCount(openMessages, model.seen ?? [])
  // B-W2b-126: the repair queue's tile (this station's repairs, else the site's), hidden at zero.
  const repairCount = repairTile(model.repair ?? null)
  // B-W2b-109: my inspections' tile (hidden at zero), what waits for me or for nobody yet.
  const inspectionCount = model.inspections?.queue?.rows.length ?? 0
  // B-W2b-232 (FI9:02): "New instructions N", the second tile, counted in the condition.
  const instructionCount = model.instructions ?? 0
  const forYourWork =
    unread > 0 || instructionCount > 0 || repairCount || inspectionCount > 0 ? (
      // Design "For your work": a count as a chip, hidden at zero. "New instructions" joins it with W2b-4.
      <section className="fw-floor-stack fw-mywork-foryou" aria-labelledby="fw-mywork-foryou">
        <h2 id="fw-mywork-foryou" className="fw-floor-section-title">
          {t('foryou.title')}
        </h2>
        <FloorTileGrid label={t('foryou.title')} columns={2}>
          {unread > 0 ? <FloorTile icon={<MessageSquareText />} label={t('foryou.messages')} count={formatNumber(unread, locale)} countLabel={t('foryou.messagesCount', { count: unread })} tone="primary" onPress={() => send({ type: 'messages' })} /> : null}
          <InstructionsTile count={instructionCount} onPress={() => send({ type: 'instructions' })} />
          {repairCount ? (
            <FloorTile
              icon={<Wrench />}
              label={t('foryou.repair')}
              count={formatNumber(repairCount.count, locale)}
              countLabel={t(repairCount.here ? 'foryou.repairHere' : 'foryou.repairSite', { count: repairCount.count })}
              tone={repairCount.here ? 'primary' : 'neutral'}
              onPress={() => send({ type: 'repair' })}
            />
          ) : null}
          {inspectionCount > 0 ? (
            <FloorTile icon={<ClipboardCheck />} label={ti('tile')} count={formatNumber(inspectionCount, locale)} countLabel={ti('tileCount', { count: inspectionCount })} tone="primary" onPress={() => send({ type: 'inspections' })} />
          ) : null}
        </FloorTileGrid>
      </section>
    ) : model.messagesFailed ? (
      <p className="fw-floor-muted">{t('foryou.failed')}</p>
    ) : null

  switch (step.kind) {
    case 'noPermission':
      actions = [home]
      body = <FloorState tone="warning" icon={<ShieldOff />} title={t('noPermission.title')} text={t('noPermission.body')} alert />
      break

    case 'loading':
      actions = [home]
      body = (
        <>
          {scanField}
          <p className="fw-floor-muted" aria-busy="true">
            {t('loading')}
          </p>
        </>
      )
      break

    case 'entry': {
      const row = rowOf(step.slotId)
      actions = row ? [back, { label: t('cantFind.open'), icon: <PackageSearch />, onPress: () => send({ type: 'cantFind', slotId: step.slotId }), variant: 'secondary' }] : [back]
      body = (
        <>
          {scanField}
          {row ? card(row, 'fw-mywork-entry', t('entry.title')) : <FloorState tone="info" icon={<CircleCheckBig />} title={t('entry.gone.title')} text={t('entry.gone.body')} />}
        </>
      )
      break
    }

    case 'messages':
      actions = [back]
      body = (
        <section className="fw-floor-stack" aria-labelledby="fw-mywork-messages">
          <h2 id="fw-mywork-messages" className="fw-floor-section-title">
            {t('messages.title')}
          </h2>
          {model.messagesAsOf ? (
            <p className="fw-mywork-status fw-floor-muted">
              <span className="fw-floor-inline-icon" aria-hidden="true">
                <CloudOff />
              </span>
              {t('messages.fromTablet', { time: time(model.messagesAsOf) })}
            </p>
          ) : null}
          {openMessages.length > 0 ? <Messages rows={openMessages} seen={model.seen ?? []} t={t} shared={shared} when={(value) => formatDateTime(value, { locale, timeZone })} send={send} /> : <FloorState tone="info" icon={<MessageSquare />} title={t('messages.none.title')} text={t('messages.none.body')} />}
        </section>
      )
      break

    case 'message': {
      const message = openMessages.find((row) => row.id === step.id)
      actions = [back]
      body = message ? (
        <FloorCard
          icon={<MessageSquareText />}
          kind={t('message.kind')}
          code={message.workOrder.number}
          title={t(`message.from.${message.from}`)}
          facts={[{ id: 'at', label: t('message.at'), value: formatDateTime(message.at, { locale, timeZone }) }]}
          asOf={model.messagesAsOf ?? null}
          formatTime={time}
          labels={ds.floorCard}
        >
          <div className="fw-floor-stack">
            <p className="fw-mywork-text">{message.text}</p>
            {message.cut ? (
              <TaskLine tone="info" icon={<MessageSquare />}>
                {t('message.cut')}
              </TaskLine>
            ) : null}
            <ReadAloudButton text={message.text} lang={locale === 'it' ? 'it-IT' : 'en-GB'} labels={ds.readAloud} />
          </div>
        </FloorCard>
      ) : (
        <FloorState tone="info" icon={<CircleCheckBig />} title={t('message.gone.title')} text={t('message.gone.body')} />
      )
      break
    }

    // B-W2b-126: the repair queue, one repair, and how it came out.
    case 'repair':
      actions = [back]
      body = (
        <>
          {scanField}
          {model.repairLine ? <RepairLine line={model.repairLine} /> : null}
          {model.repair ? <RepairList queue={model.repair} asOf={model.repairAsOf ?? null} timeZone={timeZone} onOpen={(reworkId) => send({ type: 'repairOpen', reworkId })} /> : model.repairProblem ? <RepairUnread problem={model.repairProblem} onRetry={() => send({ type: 'repairRetry' })} /> : <p className="fw-floor-muted" aria-busy="true">{t('loading')}</p>}
        </>
      )
      break

    case 'repairItem': {
      const row = model.repair?.rows.find((entry) => entry.reworkId === step.reworkId) ?? null
      actions = [back]
      body = (
        <>
          {scanField}
          {model.repairLine ? <RepairLine line={model.repairLine} /> : null}
          {row ? (
            <RepairCard row={row} asOf={model.repairAsOf ?? null} timeZone={timeZone} onStartWithout={!row.bundle && !repairHeld(row) && !model.repairBusy ? () => send({ type: 'repairStart', reworkId: row.reworkId }) : undefined} />
          ) : (
            <FloorState tone="info" icon={<CircleCheckBig />} title={t('repair.gone.title')} text={t('repair.gone.body')} />
          )}
        </>
      )
      break
    }

    case 'repairOut': {
      const row = model.repair?.rows.find((entry) => entry.reworkId === step.reworkId) ?? null
      actions = [back]
      const held = row ? (repairHeld(row) ? t(`repair.held.${repairHeld(row)}`) : model.repairBusy ? t('repair.busy') : null) : t('repair.gone.title')
      body = row ? (
        <RepairOut row={row} good={step.good} onGood={(value) => send({ type: 'repairGood', value })} onAllGood={() => send({ type: 'repairAllGood' })} onConfirm={() => send({ type: 'repairConfirm' })} heldReason={held} />
      ) : (
        <FloorState tone="info" icon={<CircleCheckBig />} title={t('repair.gone.title')} text={t('repair.gone.body')} />
      )
      break
    }

    // B-W2b-109: my inspections (the inspector queue) and one inspection's card.
    case 'inspections': {
      const insp = model.inspections
      actions = insp?.first ? [home, { label: ti('station'), icon: <ListTodo />, onPress: () => send({ type: 'stationQueue' }), variant: 'secondary' }] : [back]
      body = (
        <>
          {inspectScanField}
          {insp?.queue ? (
            <InspectionList queue={insp.queue} asOf={insp.asOf} pending={insp.pending} changed={insp.changed} onShow={() => send({ type: 'inspectionsShow' })} onOpen={(key) => send({ type: 'inspectionOpen', key })} timeZone={timeZone} />
          ) : insp?.problem ? (
            <InspectionsUnread problem={insp.problem} onRetry={() => send({ type: 'inspectionsRetry' })} />
          ) : (
            <p className="fw-floor-muted" aria-busy="true">
              {t('loading')}
            </p>
          )}
        </>
      )
      break
    }

    case 'inspection': {
      const row = model.inspections?.queue?.rows.find((entry) => entry.key === step.key) ?? null
      actions = [back]
      body = (
        <>
          {inspectScanField}
          {row ? <InspectionCard row={row} held={model.inspections?.held[row.key] ?? null} asOf={model.inspections?.asOf ?? null} onGo={() => send({ type: 'inspectionGo', key: row.key })} timeZone={timeZone} /> : <FloorState tone="info" icon={<CircleCheckBig />} title={ti('gone.title')} text={ti('gone.body')} />}
        </>
      )
      break
    }

    case 'reason':
      actions = [back, { label: t('putLast.done'), icon: <Check />, onPress: () => send({ type: 'reasonDone' }), heldReason: reasonHeld }]
      body = <ReasonPickerBody model={step.picker} onAction={(action) => send({ type: 'reason', action })} onBack={() => send({ type: 'back' })} timeZone={timeZone} />
      break

    case 'list': {
      const empty = list ? emptyOf(list) : null
      actions = view?.next ? [home, { label: t('cantFind.open'), icon: <PackageSearch />, onPress: () => send({ type: 'cantFind', slotId: view.next!.entry.slotId }), variant: 'secondary' }] : [home]
      body = (
        <>
          {scanField}
          <FloorListUpdates pending={model.changed ? Math.max(1, model.pending ?? 0) : 0} countUnknown={!model.pending} onShow={() => send({ type: 'show' })} labels={ds.floorListUpdates} />
          {list ? <Status list={list} asOf={model.asOf ?? null} t={t} time={time} /> : null}
          {list?.upcoming && list.version ? (
            <TaskLine tone="info" icon={<Clock />}>
              {t('upcoming', { number: list.upcoming.number, time: time(list.upcoming.effectiveFrom) })}
            </TaskLine>
          ) : null}
          {model.putLastDone ? <PutLastLine row={rowOf(model.putLastDone.slotId)} t={t} locale={locale} /> : null}
          {model.call ? <CallLine call={model.call} t={t} /> : null}
          {model.problem === 'error' && !list ? (
            <FloorState tone="danger" icon={<CircleAlert />} title={t('error.title')} text={t('error.body')} alert>
              <FloorButton size="lg" variant="secondary" icon={<RotateCcw />} onClick={() => send({ type: 'retry' })}>
                {shared('action.retry')}
              </FloorButton>
            </FloorState>
          ) : null}
          {model.problem === 'offline' && !list ? <FloorState tone="warning" icon={<CloudOff />} title={shared('notOnTablet.title')} text={t('offline.body')} alert /> : null}
          {/* B-W2b-126: For your work above an empty list too (a repair station's own queue is often empty): never below the fold. */}
          {empty || !list ? forYourWork : null}
          {list && empty ? <EmptyState kind={empty} list={list} t={t} time={time} /> : null}
          {list && view && !empty ? (
            <>
              {forYourWork}
              <section className="fw-floor-stack" aria-labelledby="fw-mywork-next">
                <h2 id="fw-mywork-next" className="fw-floor-section-title">
                  {t('next.title')}
                </h2>
                {view.next ? card(view.next, 'fw-mywork-next-code', view.next.entry.current ? t('next.current') : t('next.type')) : <FloorState tone="info" icon={<Clock />} title={t('next.none.title')} text={t('next.none.body')} />}
              </section>
              {view.queue.length > 0 ? <Queue rows={view.queue} done={view.done} t={t} shared={shared} locale={locale} day={day} send={send} /> : null}
            </>
          ) : null}
        </>
      )
      break
    }
  }

  const open = model.cantFind ? rowOf(model.cantFind) : null

  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={actions ? <FloorActionBar label={t('title')} actions={actions} /> : undefined}>
      <div className="fw-floor-stack">{body}</div>
      <Modal open={Boolean(model.cantFind)} onClose={() => send({ type: 'cantFind', slotId: null })} title={t('cantFind.title')} size="sm" className="fw-floor-dialog">
        {model.cantFind ? (
          <div className="fw-floor-dialog-body">
            {open ? (
              <p className="fw-floor-dialog-line">
                <span className="fw-floor-code">{open.entry.workOrder.number}</span> · {opText(t, open.entry.operation)}
              </p>
            ) : null}
            <p className="fw-floor-dialog-line fw-floor-muted">{t('cantFind.body')}</p>
            <div className="fw-mywork-cantfind">
              {/* Design: the main action. One tap through the tablet's queue; held with the reason in words. */}
              <FloorButton size="lg" block variant="primary" icon={<Siren />} autoFocus={!model.helpHeld} heldReason={model.helpHeld ? t(`cantFind.held.${model.helpHeld}`) : open ? null : t('entry.gone.title')} onClick={() => send({ type: 'help' })}>
                {t('cantFind.help')}
              </FloorButton>
              {model.helpHeld ? <p className="fw-floor-muted">{t(`cantFind.held.${model.helpHeld}`)}</p> : null}
              <FloorButton size="lg" block variant="secondary" icon={<ListEnd />} autoFocus={Boolean(model.helpHeld)} heldReason={open ? null : t('entry.gone.title')} onClick={() => send({ type: 'putLast', slotId: model.cantFind! })}>
                {t('cantFind.putLast')}
              </FloorButton>
              <FloorButton size="lg" block variant="quiet" icon={<X />} onClick={() => send({ type: 'cantFind', slotId: null })}>
                {shared('action.back')}
              </FloorButton>
            </div>
          </div>
        ) : null}
      </Modal>
    </FloorFrameView>
  )
}

/** "SEW-04 · plan v12 · as of 10:42", or "My list · …" (design header status: the station or person view and the as-of time). */
function Status({ list, asOf, t, time }: { list: DispatchList; asOf: string | null; t: Translate; time: (value: string) => string }) {
  const where = list.person ? t('status.person') : list.target ? t('status.station', { station: list.target.name }) : null
  return (
    <p className="fw-mywork-status fw-floor-muted">
      {[where, list.version ? t('status.plan', { number: list.version.number }) : null, t('status.asOf', { time: time(asOf ?? list.asOf) })].filter(Boolean).join(' · ')}
      {asOf ? (
        <span className="fw-mywork-asof">
          <span className="fw-floor-inline-icon" aria-hidden="true">
            <CloudOff />
          </span>
          {t('fromTablet')}
        </span>
      ) : null}
    </p>
  )
}

function PutLastLine({ row, t, locale }: { row: QueueRow | null; t: Translate; locale: Locale }) {
  if (!row?.putLast) return null
  return (
    <TaskLine tone="success" icon={<ListEnd />}>
      {t('putLast.said', { number: row.entry.workOrder.number, seq: row.entry.operation.seq, reason: putLastWords(row.putLast, locale) })}
    </TaskLine>
  )
}

/** The material call just sent: where it stands, in the tablet's two ticks; a refusal in words. */
function CallLine({ call, t }: { call: MyWorkCall; t: Translate }) {
  const refused = call.ticks === 'refused'
  return (
    <TaskLine tone={refused ? 'danger' : 'success'} icon={<Siren />} alert={refused}>
      {refused ? t(call.refusal && KNOWN_CALL_REFUSALS.has(call.refusal) ? `call.refusal.${call.refusal}` : 'call.refused', { number: call.number, seq: call.seq }) : t('call.said', { number: call.number, seq: call.seq })} <Ticks state={call.ticks} />
    </TaskLine>
  )
}

function EmptyState({ kind, list, t, time }: { kind: NonNullable<ReturnType<typeof emptyOf>>; list: DispatchList; t: Translate; time: (value: string) => string }) {
  switch (kind) {
    case 'noStation':
      return <FloorState tone="warning" icon={<MapPinOff />} title={t('empty.noStation.title')} text={t('empty.noStation.body')} />
    case 'nothingPublished':
      return <FloorState tone="info" icon={<ListTodo />} title={t('empty.nothingPublished.title')} text={t('empty.nothingPublished.body')} />
    case 'firstUpcoming':
      return <FloorState tone="info" icon={<Clock />} title={t('empty.firstUpcoming.title', { number: list.upcoming?.number ?? '', time: list.upcoming ? time(list.upcoming.effectiveFrom) : '' })} text={t('empty.firstUpcoming.body')} />
    case 'nothingQueued':
      return <FloorState tone="info" icon={<ListTodo />} title={t('empty.nothingQueued.title')} text={t('empty.nothingQueued.body')} />
    case 'allDone':
      return <FloorState tone="success" icon={<CircleCheckBig />} title={t('empty.allDone.title')} text={t('empty.allDone.body')} />
  }
}

/** The material flag on a row: a word with its icon, in its tone; nothing when nothing is known. */
function MaterialPill({ material, t }: { material: MaterialFlag | null | undefined; t: Translate }) {
  if (!material || material.state === 'NOT_KNOWN') return null
  return (
    <span className="fw-floor-pill fw-mywork-rush" data-tone={MATERIAL_TONE[material.state]}>
      <span className="fw-floor-inline-icon" aria-hidden="true">
        {MATERIAL_ICON[material.state]}
      </span>
      {t(`material.${material.state}`)}
    </span>
  )
}

function Queue({ rows, done, t, shared, locale, day, send }: { rows: readonly QueueRow[]; done: number; t: Translate; shared: Translate; locale: Locale; day: (value: string) => string; send: (action: MyWorkAction) => void }) {
  const { group, onKeyDown } = useRowKeys()
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-mywork-then">
      <h2 id="fw-mywork-then" className="fw-floor-section-title">
        {t('then.title')}
      </h2>
      <div ref={group} onKeyDown={onKeyDown}>
        <FloorList label={t('then.title')}>
          {rows.map(({ entry, putLast }) => (
            <FloorListRow
              key={entry.slotId}
              icon={STATE_ICON[entry.state]}
              tone={STATE_TONE[entry.state]}
              title={
                <span>
                  {entry.workOrder.rush ? (
                    <span className="fw-floor-pill fw-mywork-rush" data-tone="danger">
                      <span className="fw-floor-inline-icon" aria-hidden="true">
                        <Flame />
                      </span>
                      {t('rush')}
                    </span>
                  ) : null}
                  <MaterialPill material={entry.material} t={t} />
                  <span className="fw-floor-code">{entry.workOrder.number}</span> · {entry.workOrder.style.name}
                </span>
              }
              meta={[entry.station ? entry.station.code : null, opText(t, entry.operation), entry.workOrder.dueDate ? t('due', { date: day(entry.workOrder.dueDate) }) : null, putLast ? t('putLast.row', { reason: putLastWords(putLast, locale) }) : null].filter(Boolean).join(' · ')}
              status={stateWord(t, entry)}
              count={formatNumber(leftOf(entry), locale)}
              countLabel={t('pieces', { count: leftOf(entry) })}
              onPress={() => send({ type: 'open', slotId: entry.slotId })}
            />
          ))}
        </FloorList>
      </div>
      <ListFooter
        count={done > 0 ? `${t('then.count', { count: rows.length })} · ${t('then.done', { count: done })}` : t('then.count', { count: rows.length })}
        keys={[
          { key: '↑ ↓', does: t('keys.rows') },
          { key: 'Enter', does: t('keys.open') },
          { key: 'Esc', does: shared('keys.escape') },
        ]}
      />
    </section>
  )
}

/** The open messages on my work orders, newest first; the ones not opened here say so. Where from, never who. */
function Messages({ rows, seen, t, shared, when, send }: { rows: readonly WorkMessage[]; seen: readonly string[]; t: Translate; shared: Translate; when: (value: string) => string; send: (action: MyWorkAction) => void }) {
  const { group, onKeyDown } = useRowKeys()
  const opened = new Set(seen)
  return (
    <>
      <div ref={group} onKeyDown={onKeyDown}>
        <FloorList label={t('messages.title')}>
          {rows.map((message) => {
            const unread = !opened.has(message.id)
            return (
              <FloorListRow
                key={message.id}
                icon={unread ? <MessageSquareText /> : <MessageSquare />}
                tone={unread ? 'primary' : 'neutral'}
                title={<span className="fw-floor-code">{message.workOrder.number}</span>}
                meta={[excerptOf(message.text), t(`message.from.${message.from}`), when(message.at)].join(' · ')}
                status={unread ? t('messages.unread') : t('messages.read')}
                onPress={() => send({ type: 'message', id: message.id })}
              />
            )
          })}
        </FloorList>
      </div>
      <ListFooter
        count={t('messages.count', { count: rows.length })}
        keys={[
          { key: '↑ ↓', does: t('keys.messages') },
          { key: 'Enter', does: t('keys.openMessage') },
          { key: 'Esc', does: shared('keys.escape') },
        ]}
      />
    </>
  )
}
