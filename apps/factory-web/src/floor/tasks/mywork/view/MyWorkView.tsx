'use client'

import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowLeft, Check, CircleAlert, CircleCheckBig, CloudOff, Flame, House, ListEnd, ListTodo, MapPinOff, PackageSearch, PauseCircle, RefreshCw, RotateCcw, ScanLine, ShieldOff, Siren, Ban, Clock, X } from 'lucide-react'
import { FloorActionBar, FloorButton, FloorList, FloorListRow, ScanInput, type CameraScanner, type FloorActions } from '@nexus/ui/floor'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime, formatNumber, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Translate } from '../../../../lib/i18n/messages'
import type { Locale } from '../../../../lib/i18n/locales'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import type { FloorMode } from '../../../model'
import { ListFooter, TaskCard, TaskLine } from '../../shared/view/TaskParts'
import { ReasonPickerBody, useDoneHeld, type ReasonPickerAction, type ReasonPickerModel } from '../../reasons/view/ReasonPicker'
import { arranged, emptyOf, leftOf, putLastWords, STATE_TONE, type DispatchEntry, type DispatchList, type PutLast, type QueueRow } from '../model'
import '../mywork.css'

/**
 * SCR-089 — My work (design floor.mywork; MES-021; Owner answers P3, F2): the station's queue from the plan the office
 * published. "Next": the one next task, big — work order, style, operation, pieces left, its status word in its tone,
 * Rush with an icon and a word. "Then": the rest, rush first, then due date, then sequence. Nothing starts from a row: the
 * worker scans the real bundle (no wrong-row mistakes, MES-188); a row opens its card. A fresher list waits behind
 * "List changed · Show" (rows never move under a gloved finger). "I can't find it" puts the task last on this tablet
 * with a reason tile (the office's plan does not change); calling for material is W2b and says so. Offline: the queue
 * from this tablet with its as-of time. Per work order and operation only: no person, no money, no pace (art. 4, F2).
 */

export type MyWorkStep =
  | { readonly kind: 'loading' }
  | { readonly kind: 'list' }
  /** A row opened: its card as a step (scanning still starts the work). */
  | { readonly kind: 'entry'; readonly slotId: string }
  /** Put it last: the reason tile (the office's PAUSE list). */
  | { readonly kind: 'reason'; readonly slotId: string; readonly picker: ReasonPickerModel }
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

export function MyWorkView({ model, onAction, onFrame, camera }: MyWorkViewProps) {
  const t = useT('floor-mywork')
  const shared = useT('floor-tasks')
  const floor = useT('floor')
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

  /** The big card of one task (Next, or a row opened). */
  const card = (row: QueueRow, id: string, title: string) => {
    const { entry } = row
    const left = leftOf(entry)
    return (
      <TaskCard
        icon={<ListTodo />}
        type={title}
        code={entry.workOrder.number}
        id={id}
        status={stateWord(t, entry)}
        statusTone={STATE_TONE[entry.state]}
        big={{ value: formatNumber(left, locale), label: t('pieces', { count: left }) }}
        flags={
          <>
            <p className="fw-mywork-style">{entry.workOrder.style.name}</p>
            <p className="fw-mywork-op">{opText(t, entry.operation)}</p>
            {entry.workOrder.rush ? (
              <TaskLine tone="danger" icon={<Flame />}>
                {t('rush')}
              </TaskLine>
            ) : null}
            {entry.state === 'ON_HOLD' ? (
              <TaskLine tone="danger" icon={<PauseCircle />}>
                {entry.workOrder.holdReason ? t('onHoldWhy', { reason: entry.workOrder.holdReason }) : t('state.ON_HOLD')}
              </TaskLine>
            ) : null}
            {row.putLast ? (
              <TaskLine tone="info" icon={<ListEnd />}>
                {t('putLast.row', { reason: putLastWords(row.putLast, locale) })}
              </TaskLine>
            ) : null}
          </>
        }
        facts={[
          { label: t('fact.style'), value: `${entry.workOrder.style.code} · ${entry.workOrder.style.name}` },
          ...(entry.workOrder.dueDate ? [{ label: t('fact.due'), value: day(entry.workOrder.dueDate) }] : []),
          { label: t('fact.planned'), value: formatDateTime(entry.startAt, { locale, timeZone }) },
          ...(entry.previous ? [{ label: t('fact.waiting'), value: t('waitingHere', { count: entry.waiting }) }] : []),
        ]}
      >
        <TaskLine tone="info" icon={<ScanLine />}>
          {t('scanToStart')}
        </TaskLine>
      </TaskCard>
    )
  }

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
          {model.changed ? (
            // Stand-in for the DS "FloorList updates slot" (design part, new): the fresher list waits for a tap.
            <div className="fw-mywork-changed" role="status">
              <FloorButton size="lg" block variant="primary" icon={<RefreshCw />} onClick={() => send({ type: 'show' })}>
                {t('changed')}
              </FloorButton>
            </div>
          ) : null}
          {list ? <Status list={list} asOf={model.asOf ?? null} t={t} time={time} /> : null}
          {list?.upcoming && list.version ? (
            <TaskLine tone="info" icon={<Clock />}>
              {t('upcoming', { number: list.upcoming.number, time: time(list.upcoming.effectiveFrom) })}
            </TaskLine>
          ) : null}
          {model.putLastDone ? <PutLastLine row={rowOf(model.putLastDone.slotId)} t={t} locale={locale} /> : null}
          {model.problem === 'error' && !list ? (
            <FloorState tone="danger" icon={<CircleAlert />} title={t('error.title')} text={t('error.body')} alert>
              <FloorButton size="lg" variant="secondary" icon={<RotateCcw />} onClick={() => send({ type: 'retry' })}>
                {shared('action.retry')}
              </FloorButton>
            </FloorState>
          ) : null}
          {model.problem === 'offline' && !list ? <FloorState tone="warning" icon={<CloudOff />} title={shared('notOnTablet.title')} text={t('offline.body')} alert /> : null}
          {list && empty ? <EmptyState kind={empty} list={list} t={t} time={time} /> : null}
          {list && view && !empty ? (
            <>
              <section className="fw-floor-stack" aria-labelledby="fw-mywork-next">
                <h2 id="fw-mywork-next" className="fw-floor-section-title">
                  {t('next.title')}
                </h2>
                {view.next ? card(view.next, 'fw-mywork-next-code', t('next.type')) : <FloorState tone="info" icon={<Clock />} title={t('next.none.title')} text={t('next.none.body')} />}
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
              {/* Calling for help is W2b (design "Call for help: Material (W2b)"): in view, held with the reason. */}
              <FloorButton size="lg" block variant="secondary" icon={<Siren />} heldReason={t('cantFind.helpHeld')} onClick={() => undefined}>
                {t('cantFind.help')}
              </FloorButton>
              <FloorButton size="lg" block variant="primary" icon={<ListEnd />} autoFocus heldReason={open ? null : t('entry.gone.title')} onClick={() => send({ type: 'putLast', slotId: model.cantFind! })}>
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

/** "SEW-04 · plan v12 · as of 10:42" (design header status: the station view and the as-of time). */
function Status({ list, asOf, t, time }: { list: DispatchList; asOf: string | null; t: Translate; time: (value: string) => string }) {
  const where = list.target ? list.target.name : null
  return (
    <p className="fw-mywork-status fw-floor-muted">
      {[where ? t('status.station', { station: where }) : null, list.version ? t('status.plan', { number: list.version.number }) : null, t('status.asOf', { time: time(asOf ?? list.asOf) })].filter(Boolean).join(' · ')}
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

function Queue({ rows, done, t, shared, locale, day, send }: { rows: readonly QueueRow[]; done: number; t: Translate; shared: Translate; locale: Locale; day: (value: string) => string; send: (action: MyWorkAction) => void }) {
  const group = useRef<HTMLDivElement>(null)
  // Arrows move between the rows (design floor.mywork "Arrows move rows; Enter opens"); Enter presses the focused row.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = [...(group.current?.querySelectorAll<HTMLElement>('.nds-floor-row.is-pressable') ?? [])]
    if (items.length === 0) return
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1)
    event.preventDefault()
    items[next]?.focus()
  }
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
                  <span className="fw-floor-code">{entry.workOrder.number}</span> · {entry.workOrder.style.name}
                </span>
              }
              meta={[opText(t, entry.operation), entry.workOrder.dueDate ? t('due', { date: day(entry.workOrder.dueDate) }) : null, putLast ? t('putLast.row', { reason: putLastWords(putLast, locale) }) : null].filter(Boolean).join(' · ')}
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
