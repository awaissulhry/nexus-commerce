'use client'

import type { ReactNode } from 'react'
import { ArrowLeft, ArrowRightLeft, Check, CircleAlert, CircleSlash, ClipboardList, Hand, Layers, ListTodo, Package, PackageCheck, PackageOpen, RotateCcw, ScanLine, ShieldAlert, Undo2, Warehouse, WifiOff } from 'lucide-react'
import { FloorActionBar, FloorButton, FloorList, FloorListRow, ScanInput, type CameraScanner, type FloorAction, type FloorActions } from '@nexus/ui/floor'
import { FloorCard } from '@nexus/ui/floor/FloorCard/index'
import { FloorListUpdates } from '@nexus/ui/floor/FloorListUpdates/index'
import { ReadAloudButton } from '@nexus/ui/floor/ReadAloud/index'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatNumber, formatTime } from '../../../../../lib/i18n/format'
import type { Translate } from '../../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../../frame/view/FloorFrameView'
import { FloorState } from '../../../../frame/view/FloorState'
import { HeldLine, ListFooter, TaskLine, Ticks, type TickState } from '../../../shared/view/TaskParts'
import { forWords, routeWords, taskTitle, unitWord } from '../../../move/view/MoveView'
import { codeOfTask, countsLine, doneHeld, isLate, KIND_TONE, quantityOf, screenOf, type StepKind, type TaskInbox, type TaskKind, type WarehouseTask } from '../model'
import '../warehouse.css'

/**
 * SCR-089's warehouse variant — My work at the warehouse (B-W2b-308; design floor.mywork sec:queue "Variants: warehouse task
 * inbox (W2b, SCM-274: receive, put away, pick, move, count; next task first)"): the signed-in worker's tasks, never another
 * person's and never a name. "Next" is the first, big, with what to do and where; "Then" the rest (a row opens its card as a
 * step; rows never move under the finger: a fresher list waits behind "List changed · Show"). Each card says how its kind is
 * done: a put-away, a move and a quarantine move on Move & put away by their scans (the bin label confirms; a quarantine move
 * only by its place's scan), a delivery on Receive, a pick on Pick & issue, a count by one tap on Done. Take and Give back say
 * whose hands it is in. Every step is one tap, online first, else kept on this tablet (two ticks). Scanning here opens the job
 * with the label, as on Home. Offline: the list this tablet read, with its time.
 */

export type InboxStep = { readonly kind: 'list' } | { readonly kind: 'task'; readonly taskId: string } | { readonly kind: 'noPermission' }

/** What the last step did, under the status line. */
export interface InboxLine {
  readonly taskId: string
  /** The task's kind and the goods' label (or the item's code), for the words. */
  readonly kind: TaskKind
  readonly code: string | null
  readonly step: StepKind
  readonly ticks: TickState
  /** A refusal's code (the screen's words) when refused. */
  readonly refusal?: string | null
}

export interface InboxViewModel {
  frame: FrameModel
  online: boolean
  /** The worker notice holds scans. */
  held?: boolean
  step: InboxStep
  /** The inbox as this tablet shows it (its own steps applied); null: not read yet and none kept. */
  inbox: TaskInbox | null
  /** From this tablet: as of when. */
  asOf?: string | null
  problem?: 'offline' | 'error' | null
  /** Rows of a fresher list waiting behind "Show" (0: none). */
  changed?: number
  /** Which of the screens a task opens this person may open here. */
  screens: { readonly move: boolean; readonly receive: boolean; readonly pick: boolean }
  /** The task whose step is on its way. */
  busy?: string | null
  line?: InboxLine | null
  now?: string
  timeZone?: string
}

export type InboxAction =
  | { type: 'scan'; code: string }
  | { type: 'open'; taskId: string }
  | { type: 'back' }
  | { type: 'take'; taskId: string }
  | { type: 'giveBack'; taskId: string }
  | { type: 'done'; taskId: string }
  | { type: 'go'; taskId: string }
  | { type: 'show' }
  | { type: 'retry' }

export interface InboxViewProps {
  model: InboxViewModel
  onAction?: (action: InboxAction) => void
  onFrame?: (action: FrameAction) => void
  camera?: CameraScanner
}

const KIND_ICON = { RECEIVE: <PackageOpen />, PUT_AWAY: <PackageCheck />, PICK: <ClipboardList />, MOVE: <ArrowRightLeft />, COUNT: <Layers />, QUARANTINE: <ShieldAlert /> } as const

/** The refusals of a step the screen words itself (`inbox.refusal.<CODE>`). */
export const STEP_REFUSALS = ['DONE', 'CANCELLED', 'TAKEN_BY_OTHER', 'NOT_TAKEN', 'NOT_YOURS', 'NOT_FOR_YOU', 'SCAN_THE_PLACE', 'STILL_THERE', 'NOT_ALLOWED', 'CONFLICT'] as const

export function InboxView({ model, onAction, onFrame, camera }: InboxViewProps) {
  const t = useT('floor-move')
  const shared = useT('floor-tasks')
  const floor = useT('floor')
  const ds = useDsWords()
  const locale = useLocale()
  const send = (action: InboxAction) => onAction?.(action)
  const place = { locale, timeZone: model.timeZone }
  const time = (value: string) => formatTime(value, place)
  const now = model.now ? new Date(model.now) : new Date()
  const amount = (task: WarehouseTask) => {
    const value = quantityOf(task)
    return value === null ? null : `${formatNumber(value, locale, { maximumFractionDigits: 2 })} ${unitWord(t, task.uom)}`.trim()
  }
  const camProps = camera ? { scanner: camera, startLabel: floor('scan.camera.start'), stopLabel: floor('scan.camera.stop'), errorLabel: floor('scan.camera.error') } : undefined
  const tasks = model.inbox?.tasks ?? []

  /** What the main action of a task is, and why it waits (held buttons say why). */
  const mainOf = (task: WarehouseTask): FloorAction => {
    const screen = screenOf(task.kind)
    if (screen === null) return { label: t('inbox.act.done'), icon: <Check />, heldReason: model.busy === task.id ? t('inbox.held.busy') : null, onPress: () => send({ type: 'done', taskId: task.id }) }
    const label = task.kind === 'QUARANTINE' ? t('inbox.act.quarantine') : t(`inbox.act.${screen}`)
    const icon = screen === 'move' ? task.kind === 'QUARANTINE' ? <ShieldAlert /> : <ArrowRightLeft /> : screen === 'receive' ? <PackageOpen /> : <ClipboardList />
    return { label, icon, heldReason: model.screens[screen] ? null : t('inbox.held.noScreen'), onPress: () => send({ type: 'go', taskId: task.id }) }
  }

  /** The card of one task: kind and goods big, where it is and goes, whose hands, what to do; Take / Give back and Done in it. */
  const card = (task: WarehouseTask, heading: string) => {
    const code = codeOfTask(task)
    const late = isLate(task, now)
    const how = howWords(t, task)
    const busy = model.busy === task.id
    const doneWait = doneHeld(task)
    const lineHere = model.line && model.line.taskId === task.id ? model.line : null
    return (
      <section className="fw-floor-stack" aria-labelledby={`fw-inbox-${heading}`}>
        <h2 id={`fw-inbox-${heading}`} className="fw-floor-section-title">
          {t(`inbox.${heading}`)}
        </h2>
        <FloorCard
          icon={KIND_ICON[task.kind]}
          kind={t(`kind.${task.kind}`)}
          code={code ?? task.item?.code ?? task.from?.code ?? task.to?.code ?? t(`kind.${task.kind}`)}
          title={task.item ? [task.item.code !== code ? task.item.code : null, task.item.name, task.colour?.name].filter(Boolean).join(' · ') : undefined}
          status={{ label: forWords(t, task), tone: task.mine ? 'primary' : 'neutral' }}
          tone={late ? 'danger' : KIND_TONE[task.kind]}
          facts={[
            { id: 'from', label: t('task.fact.from'), value: task.from?.code ?? null },
            { id: 'to', label: t('task.fact.to'), value: task.to?.code ?? null },
            { id: 'quantity', label: t('task.fact.quantity'), value: amount(task) },
            { id: 'due', label: t('task.fact.due'), value: task.dueAt ? time(task.dueAt) : null, tone: late ? 'danger' : undefined },
          ]}
          flags={[...(late ? [{ id: 'late', label: t('row.late'), tone: 'danger' as const }] : []), ...(task.note ? [{ id: 'note', label: t('task.note', { note: task.note }), tone: 'info' as const }] : [])]}
          asOf={model.asOf ?? null}
          formatTime={time}
          labels={ds.floorCard}
        >
          <TaskLine tone="info" icon={screenOf(task.kind) === 'move' ? <ScanLine /> : <ListTodo />}>
            {how}
          </TaskLine>
          {lineHere ? <StepLine line={lineHere} t={t} /> : null}
          <div className="fw-inbox-buttons">
            {task.mine ? (
              <FloorButton size="md" variant="secondary" icon={<Undo2 />} heldReason={busy ? t('inbox.held.busy') : null} onClick={() => send({ type: 'giveBack', taskId: task.id })}>
                {t('inbox.act.giveBack')}
              </FloorButton>
            ) : (
              <FloorButton size="md" variant="secondary" icon={<Hand />} heldReason={busy ? t('inbox.held.busy') : null} onClick={() => send({ type: 'take', taskId: task.id })}>
                {t('inbox.act.take')}
              </FloorButton>
            )}
            {screenOf(task.kind) !== null ? (
              <FloorButton size="md" variant="secondary" icon={<Check />} heldReason={doneWait ? t(`inbox.held.${doneWait}`) : busy ? t('inbox.held.busy') : null} onClick={() => send({ type: 'done', taskId: task.id })}>
                {t('inbox.act.done')}
              </FloorButton>
            ) : null}
            <ReadAloudButton text={[t(`kind.${task.kind}`), code ?? task.item?.name ?? '', routeWords(t, task), amount(task), how].filter(Boolean).join('. ')} lang={locale === 'it' ? 'it-IT' : 'en-GB'} labels={ds.readAloud} size="md" />
          </div>
        </FloorCard>
      </section>
    )
  }

  let actions: FloorActions | null = null
  let body: ReactNode

  if (model.step.kind === 'noPermission') {
    body = <FloorState tone="warning" icon={<CircleSlash />} title={t('inbox.noPermission.title')} text={t('inbox.noPermission.body')} alert />
  } else if (model.step.kind === 'task') {
    const taskId = model.step.taskId
    const task = tasks.find((entry) => entry.id === taskId) ?? null
    const back: FloorAction = { label: t('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }) }
    actions = task ? [back, mainOf(task)] : [back]
    body = task ? (
      <div className="fw-floor-stack">
        {!model.online ? <HeldLine text={t('inbox.offline.line')} /> : null}
        {card(task, 'task')}
      </div>
    ) : (
      <div className="fw-floor-stack">
        {model.line && model.line.taskId === taskId ? <StepLine line={model.line} t={t} /> : null}
        <FloorState tone="info" icon={<CircleAlert />} title={t('inbox.gone.title')} text={t('inbox.gone.body')} />
      </div>
    )
  } else {
    const inbox = model.inbox
    const [next, ...rest] = tasks
    if (next) actions = [mainOf(next)]
    const counts = inbox ? countsLine(inbox.counts) : []
    body = (
      <div className="fw-floor-stack">
        {!model.online ? <HeldLine text={t('inbox.offline.line')} /> : null}
        <p className="fw-floor-muted">{model.asOf ? t('inbox.statusAsOf', { time: time(model.asOf) }) : t('inbox.status')}</p>
        {counts.length > 0 ? (
          <p className="fw-inbox-counts" aria-label={t('inbox.countsLabel')}>
            {counts.map((entry) => (
              <span key={entry.kind} className="fw-floor-muted">
                {t('inbox.countOf', { kind: t(`kind.${entry.kind}`), count: entry.count })}
              </span>
            ))}
          </p>
        ) : null}
        {model.line && !tasks.some((task) => task.id === model.line!.taskId) ? <StepLine line={model.line} t={t} /> : null}
        <ScanInput
          label={t('inbox.scan.label')}
          hint={model.held ? floor('tile.held.notice') : t('inbox.scan.hint')}
          scannedLabel={(code) => floor('scan.read', { code })}
          keyboardLabel={floor('scan.type')}
          disabled={Boolean(model.held)}
          camera={camProps}
          onScan={(code) => send({ type: 'scan', code })}
        />
        {inbox === null ? (
          model.problem === 'offline' ? (
            <FloorState tone="warning" icon={<WifiOff />} title={t('inbox.offline.title')} text={t('inbox.offline.body')} />
          ) : model.problem === 'error' ? (
            <FloorState tone="warning" icon={<CircleAlert />} title={t('inbox.error.title')} text={t('inbox.error.body')}>
              <FloorButton size="md" variant="secondary" icon={<RotateCcw />} onClick={() => send({ type: 'retry' })}>
                {shared('action.retry')}
              </FloorButton>
            </FloorState>
          ) : (
            <FloorState tone="info" icon={<Warehouse />} title={t('inbox.loading')} busy />
          )
        ) : tasks.length === 0 ? (
          <FloorState tone="info" icon={<Warehouse />} title={t('inbox.empty.title')} text={t('inbox.empty.body')} />
        ) : (
          <>
            <FloorListUpdates pending={model.changed ?? 0} onShow={() => send({ type: 'show' })} labels={ds.floorListUpdates} />
            {next ? card(next, 'next') : null}
            {rest.length > 0 ? (
              <section className="fw-floor-stack" aria-labelledby="fw-inbox-then">
                <h2 id="fw-inbox-then" className="fw-floor-section-title">
                  {t('inbox.then')}
                </h2>
                <FloorList label={t('inbox.then')}>
                  {rest.map((task) => (
                    <FloorListRow
                      key={task.id}
                      icon={KIND_ICON[task.kind]}
                      tone={isLate(task, now) ? 'danger' : KIND_TONE[task.kind]}
                      title={<span className="fw-floor-code">{taskTitle(t, task)}</span>}
                      meta={[task.item ? t('row.item', { code: task.item.code, name: task.item.name }) : null, routeWords(t, task), isLate(task, now) ? t('row.late') : task.dueAt ? t('row.due', { time: time(task.dueAt) }) : null].filter(Boolean).join(' · ')}
                      status={forWords(t, task)}
                      count={amount(task) ?? undefined}
                      countLabel={quantityOf(task) !== null ? t('row.quantity') : undefined}
                      onPress={() => send({ type: 'open', taskId: task.id })}
                    />
                  ))}
                </FloorList>
                <ListFooter
                  count={t('inbox.count', { count: tasks.length })}
                  keys={[
                    { key: 'Tab', does: shared('keys.tab') },
                    { key: 'Enter', does: shared('keys.enter') },
                    { key: 'Esc', does: t('keys.home') },
                  ]}
                />
              </section>
            ) : null}
            {inbox.more ? <p className="fw-floor-muted">{t('inbox.more', { count: tasks.length })}</p> : null}
          </>
        )}
      </div>
    )
  }

  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={actions ? <FloorActionBar label={t('inbox.title')} actions={actions} /> : undefined}>
      <div className="fw-inbox">{body}</div>
    </FloorFrameView>
  )
}

/** How a task is done here, in words (confirm by scan, not by reading: MES-188). */
export function howWords(t: Translate, task: WarehouseTask): string {
  const code = codeOfTask(task)
  switch (task.kind) {
    case 'QUARANTINE':
      return task.to ? t('inbox.how.quarantine', { place: task.to.code }) : t('inbox.how.quarantineAny')
    case 'PUT_AWAY':
    case 'MOVE':
      if (code && task.to) return t('inbox.how.moveTo', { code, place: task.to.code })
      if (code) return t('inbox.how.move', { code })
      return t('inbox.how.moveItem')
    case 'RECEIVE':
      return t('inbox.how.receive')
    case 'PICK':
      return t('inbox.how.pick')
    case 'COUNT':
      return task.from ? t('inbox.how.countAt', { place: task.from.code }) : t('inbox.how.count')
  }
}

/** The last step on a task: what, and where it stands (two ticks); a refusal in the screen's words. */
function StepLine({ line, t }: { line: InboxLine; t: Translate }) {
  const title = line.code ? t('row.title', { kind: t(`kind.${line.kind}`), code: line.code }) : t(`kind.${line.kind}`)
  if (line.ticks === 'refused') {
    const code = line.refusal && (STEP_REFUSALS as readonly string[]).includes(line.refusal) ? line.refusal : 'CONFLICT'
    return (
      <div className="fw-inbox-step" role="status">
        <TaskLine tone="danger" icon={<CircleAlert />}>
          {t('inbox.step.refused', { task: title })} {t(`inbox.refusal.${code}`)}
        </TaskLine>
        <Ticks state="refused" />
      </div>
    )
  }
  return (
    <div className="fw-inbox-step" role="status">
      <TaskLine tone="success" icon={line.step === 'done' ? <Check /> : line.step === 'take' ? <Hand /> : <Package />}>
        {t(`inbox.step.${line.step}`, { task: title })}
      </TaskLine>
      <Ticks state={line.ticks} />
    </div>
  )
}
