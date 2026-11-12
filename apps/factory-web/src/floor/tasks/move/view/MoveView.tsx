'use client'

import type { ReactNode } from 'react'
import { ArrowLeft, ArrowRightLeft, CircleAlert, CircleSlash, Layers, MapPin, Package, PackageCheck, RotateCcw, ScanLine, ShieldAlert, Undo2, Warehouse } from 'lucide-react'
import { FloorActionBar, FloorList, FloorListRow, QuantityPad, ScanInput, type CameraScanner, type FloorActions, type FloorTone } from '@nexus/ui/floor'
import { FloorCard } from '@nexus/ui/floor/FloorCard/index'
import { FloorListUpdates } from '@nexus/ui/floor/FloorListUpdates/index'
import { ReadAloudButton } from '@nexus/ui/floor/ReadAloud/index'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatNumber, formatTime } from '../../../../lib/i18n/format'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import type { TaskProblem } from '../../shared/task-api'
import { HeldLine, ListFooter, ProblemState, TaskLine, Ticks, UndoStrip } from '../../shared/view/TaskParts'
import { codeOfTask, isLate, KIND_TONE, quantityOf, type WarehouseTask } from '../../mywork/warehouse/model'
import { fromOf, goesTo, knownRefusal, num, padOf, placeActOf, placeHeld, purposeOf, QUALITY_TONE, quarantineTaskOf, taskOfMove, type MoveLast, type MoveScan } from '../model'
import '../move.css'

/**
 * SCR-177 — Move & put away (B-W2b-308; design floor.move; SCM-202 put away, SCM-218 move between bins, QHS-078 the quarantine
 * move): one job, three steps on one screen, tablet-first and centred.
 *
 *   Scan what you move   ScanInput: a lot, a hide, a roll or a remnant label; under it what waits to be moved (the person's
 *                        put-aways, moves and quarantine moves, next first: a row opens its card, the scan of the goods starts
 *                        it — confirm by scan, not by reading, MES-188).
 *   In your hands        FloorCard: item, quantity, where it is now, quality status (and why it goes only into quarantine);
 *                        the place it is taken from when it lies in several; the QuantityPad for part of a lot, defaulting to
 *                        all of it (a hide moves whole).
 *   Scan the place       ScanInput: the bin label is the confirmation — the move posts on the scan; Undo for 2 minutes.
 *                        A hold's quarantine move: the quarantine place's scan does its task.
 * Offline: the move is kept on this tablet (one tick) and sent when the network is back; what the tablet read in this visit
 * opens "as of", a code it never read moves on its label alone. A refusal is a full-screen state in words. No money, no person.
 */

export type MoveStep =
  /** Scan what you move, with what waits to be moved. */
  | { readonly kind: 'what' }
  /** Reading what the label names. */
  | { readonly kind: 'reading'; readonly code: string }
  /** A waiting task's card: the scan of its goods (or of its quarantine place) starts it. */
  | { readonly kind: 'task'; readonly task: WarehouseTask }
  /** In your hands, then Scan the place. */
  | { readonly kind: 'hand' }
  | { readonly kind: 'noPermission' }

export interface MoveProblem {
  readonly problem: TaskProblem
  /** What was scanned (the goods, or the place). */
  readonly code: string | null
  /** The place scanned, for the words. */
  readonly place?: string | null
  /** The place the task asks, for the words ("scan the quarantine place A1-QUA"). */
  readonly asked?: string | null
}

export interface MoveViewModel {
  frame: FrameModel
  online: boolean
  /** The worker notice holds scans. */
  held?: boolean
  step: MoveStep
  /** What waits to be moved (put-aways, moves, quarantine moves); null: not read yet. */
  tasks?: readonly WarehouseTask[] | null
  /** The list is this tablet's copy: as of when. */
  tasksAsOf?: string | null
  tasksProblem?: 'offline' | 'error' | null
  /** Rows of a fresher list waiting behind "Show" (0: none). */
  tasksChanged?: number
  /** More tasks wait than the inbox shows. */
  tasksMore?: boolean
  /** In your hands (null: nothing read, or offline a code this tablet never read). */
  scan?: MoveScan | null
  /** The goods' code scanned. */
  code?: string | null
  /** What is in hand comes from this tablet: as of when. */
  handAsOf?: string | null
  /** The place it is taken from, tapped (it lies in several places). */
  picked?: string | null
  /** The pad's number (part of a lot). */
  value?: number | null
  /** The task this move works on (opened from the list). */
  taskId?: string | null
  busy?: boolean
  problem?: MoveProblem | null
  last?: MoveLast | null
  /** Undo: offered, being sent, or not offered. */
  undo?: 'open' | 'busy' | null
  /** Now, for "late" (fixtures pass a fixed time). */
  now?: string
  timeZone?: string
}

export type MoveAction =
  | { type: 'scan'; code: string }
  | { type: 'openTask'; taskId: string }
  | { type: 'pickFrom'; locationId: string }
  | { type: 'pad'; value: number | null }
  | { type: 'undo' }
  | { type: 'back' }
  | { type: 'dismiss' }
  | { type: 'startAgain' }
  | { type: 'retry' }
  | { type: 'showTasks' }

export interface MoveViewProps {
  model: MoveViewModel
  onAction?: (action: MoveAction) => void
  onFrame?: (action: FrameAction) => void
  camera?: CameraScanner
}

/** A unit's short name (`unit.FT2` → "ft²"), else its code. */
export function unitWord(t: Translate, uom: string | null | undefined): string {
  if (!uom) return ''
  const key = `unit.${uom}`
  const word = t(key)
  return word === key ? uom : word
}

/** The words of a refusal the screen knows, with the codes it names; else null (the general problem's words). */
export function refusalWords(t: Translate, code: string, facts: { code?: string | null; place?: string | null; asked?: string | null }): { message: string; fix: string | null } | null {
  if (!knownRefusal(code)) return null
  const values = { code: facts.code ?? '', place: facts.place ?? '', asked: facts.asked ?? '' }
  const fixKey = facts.asked && code === 'NOT_A_QUARANTINE_PLACE' ? `refusal.${code}.fixAsked` : `refusal.${code}.fix`
  return { message: t(`refusal.${code}.message`, values), fix: t(fixKey, values) }
}

const KIND_ICON = { RECEIVE: <Package />, PUT_AWAY: <PackageCheck />, PICK: <Package />, MOVE: <ArrowRightLeft />, COUNT: <Layers />, QUARANTINE: <ShieldAlert /> } as const

export function MoveView({ model, onAction, onFrame, camera }: MoveViewProps) {
  const t = useT('floor-move')
  const shared = useT('floor-tasks')
  const floor = useT('floor')
  const ds = useDsWords()
  const locale = useLocale()
  const send = (action: MoveAction) => onAction?.(action)
  const place = { locale, timeZone: model.timeZone }
  const now = model.now ? new Date(model.now) : new Date()
  const figure = (value: number) => formatNumber(value, locale, { maximumFractionDigits: 2 })
  const amount = (value: number | string | null | undefined, uom: string | null | undefined) => (value === null || value === undefined ? null : `${figure(typeof value === 'string' ? num(value) : value)} ${unitWord(t, uom)}`.trim())
  const camProps = camera ? { scanner: camera, startLabel: floor('scan.camera.start'), stopLabel: floor('scan.camera.stop'), errorLabel: floor('scan.camera.error') } : undefined
  const scanWords = { scannedLabel: (code: string) => floor('scan.read', { code }), keyboardLabel: floor('scan.type') }

  let actions: FloorActions | null = null
  let body: ReactNode

  if (model.step.kind === 'noPermission') {
    body = <FloorState tone="warning" icon={<CircleSlash />} title={t('noPermission.title')} text={t('noPermission.body')} alert />
  } else if (model.problem) {
    const { problem, code, place: scanned, asked } = model.problem
    body = <ProblemState problem={problem} code={scanned ?? code} words={(refusal) => refusalWords(t, refusal, { code, place: scanned, asked })} />
    const again = model.step.kind === 'hand' ? { label: t('action.anotherPlace'), icon: <MapPin />, onPress: () => send({ type: 'dismiss' }) } : { label: t('action.scanAgain'), icon: <ScanLine />, onPress: () => send({ type: 'dismiss' }) }
    actions = problem.kind === 'offline' || problem.kind === 'unavailable' ? [{ label: t('action.startAgain'), icon: <ArrowLeft />, onPress: () => send({ type: 'startAgain' }) }, { label: shared('action.retry'), icon: <RotateCcw />, onPress: () => send({ type: 'retry' }) }] : model.step.kind === 'hand' ? [{ label: t('action.startAgain'), icon: <ArrowLeft />, onPress: () => send({ type: 'startAgain' }) }, again] : [again]
  } else if (model.step.kind === 'reading') {
    body = <FloorState tone="info" icon={<ScanLine />} title={t('what.reading', { code: model.step.code })} busy />
  } else if (model.step.kind === 'task') {
    actions = [{ label: t('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }) }]
    body = <TaskStep task={model.step.task} model={model} t={t} amount={amount} time={(value) => formatTime(value, place)} now={now} camProps={camProps} scanWords={scanWords} send={send} />
  } else if (model.step.kind === 'hand') {
    actions = [{ label: t('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }) }]
    body = <HandStep model={model} t={t} amount={amount} figure={figure} time={(value) => formatTime(value, place)} locale={locale} ds={ds} camProps={camProps} scanWords={scanWords} send={send} />
  } else {
    body = (
      <div className="fw-floor-stack">
        {!model.online ? <HeldLine text={t('offline.line')} /> : null}
        <LastLine last={model.last ?? null} undo={model.undo ?? null} online={model.online} t={t} amount={amount} send={send} />
        <ScanInput
          label={t('what.scan.label')}
          hint={model.held ? floor('tile.held.notice') : t('what.scan.hint')}
          scannedLabel={scanWords.scannedLabel}
          keyboardLabel={scanWords.keyboardLabel}
          disabled={Boolean(model.held)}
          camera={camProps}
          onScan={(code) => send({ type: 'scan', code })}
        />
        <Waiting model={model} t={t} shared={shared} amount={amount} time={(value) => formatTime(value, place)} now={now} ds={ds} send={send} />
      </div>
    )
  }

  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={actions ? <FloorActionBar label={t('title')} actions={actions} /> : undefined}>
      <div className="fw-move">{body}</div>
    </FloorFrameView>
  )
}

type Amount = (value: number | string | null | undefined, uom: string | null | undefined) => string | null
type Send = (action: MoveAction) => void
type CamProps = { scanner: CameraScanner; startLabel: string; stopLabel: string; errorLabel: string } | undefined
type ScanWords = { scannedLabel: (code: string) => string; keyboardLabel: string }

/** A task's row title: its kind and the goods' label (or the item's code). */
export function taskTitle(t: Translate, task: WarehouseTask): string {
  const code = codeOfTask(task) ?? task.item?.code ?? null
  return code ? t('row.title', { kind: t(`kind.${task.kind}`), code }) : t(`kind.${task.kind}`)
}

/** Where a task's goods are and where they go, in words. */
export function routeWords(t: Translate, task: Pick<WarehouseTask, 'from' | 'to'>): string | null {
  if (task.from && task.to) return t('row.fromTo', { from: task.from.code, to: task.to.code })
  if (task.from) return t('row.from', { from: task.from.code })
  if (task.to) return t('row.to', { to: task.to.code })
  return null
}

/** Who a task is for, from the worker's side (never a name). */
export function forWords(t: Translate, task: Pick<WarehouseTask, 'audience' | 'mine'>): string {
  return task.mine ? t('for.inHand') : t(`for.${task.audience}`)
}

function Waiting({ model, t, shared, amount, time, now, ds, send }: { model: MoveViewModel; t: Translate; shared: Translate; amount: Amount; time: (value: string) => string; now: Date; ds: ReturnType<typeof useDsWords>; send: Send }) {
  const tasks = model.tasks
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-move-waiting">
      <h2 id="fw-move-waiting" className="fw-floor-section-title">
        {t('waiting.title')}
      </h2>
      {model.tasksAsOf ? <p className="fw-floor-muted">{t('asOf', { time: time(model.tasksAsOf) })}</p> : null}
      {tasks === null || tasks === undefined ? (
        model.tasksProblem === 'offline' ? (
          <p className="fw-floor-muted">{t('waiting.notOnTablet')}</p>
        ) : model.tasksProblem === 'error' ? (
          <p className="fw-floor-muted">{t('waiting.error')}</p>
        ) : (
          <FloorState tone="info" icon={<Warehouse />} title={t('waiting.loading')} busy />
        )
      ) : tasks.length === 0 ? (
        <FloorState tone="info" icon={<Warehouse />} title={t('waiting.empty.title')} text={t('waiting.empty.body')} />
      ) : (
        <>
          <FloorListUpdates pending={model.tasksChanged ?? 0} onShow={() => send({ type: 'showTasks' })} labels={ds.floorListUpdates} />
          <FloorList label={t('waiting.title')}>
            {tasks.map((task) => (
              <FloorListRow
                key={task.id}
                icon={KIND_ICON[task.kind]}
                tone={isLate(task, now) ? 'danger' : KIND_TONE[task.kind]}
                title={<span className="fw-floor-code">{taskTitle(t, task)}</span>}
                meta={[task.item ? t('row.item', { code: task.item.code, name: task.item.name }) : null, task.colour?.name ?? null, routeWords(t, task), isLate(task, now) ? t('row.late') : task.dueAt ? t('row.due', { time: time(task.dueAt) }) : null].filter(Boolean).join(' · ')}
                status={forWords(t, task)}
                count={amount(quantityOf(task), task.uom) ?? undefined}
                countLabel={quantityOf(task) !== null ? t('row.quantity') : undefined}
                onPress={() => send({ type: 'openTask', taskId: task.id })}
              />
            ))}
          </FloorList>
          {model.tasksMore ? <p className="fw-floor-muted">{t('waiting.more', { count: tasks.length })}</p> : null}
          <ListFooter
            count={t('waiting.count', { count: tasks.length })}
            keys={[
              { key: 'Tab', does: shared('keys.tab') },
              { key: 'Enter', does: shared('keys.enter') },
              { key: 'Esc', does: t('keys.home') },
            ]}
          />
        </>
      )}
    </section>
  )
}

/** A waiting task's card: where its goods are, where they go; the scan of the goods (or the quarantine place) starts it. */
function TaskStep({ task, model, t, amount, time, now, camProps, scanWords, send }: { task: WarehouseTask; model: MoveViewModel; t: Translate; amount: Amount; time: (value: string) => string; now: Date; camProps: CamProps; scanWords: ScanWords; send: Send }) {
  const floor = useT('floor')
  const ds = useDsWords()
  const code = codeOfTask(task)
  const placeOnly = task.kind === 'QUARANTINE' && !code
  const instruction = placeOnly
    ? task.to
      ? t('task.scanQuarantine', { place: task.to.code })
      : t('task.scanQuarantineAny')
    : code
      ? t('task.scanGoods', { code })
      : t('task.scanItem', { item: task.item?.code ?? '', from: task.from?.code ?? '' })
  return (
    <div className="fw-floor-stack">
      {!model.online ? <HeldLine text={t('offline.line')} /> : null}
      <FloorCard
        icon={KIND_ICON[task.kind]}
        kind={t(`kind.${task.kind}`)}
        code={code ?? task.item?.code ?? task.from?.code ?? task.to?.code ?? t(`kind.${task.kind}`)}
        title={task.item ? [task.item.name, task.colour?.name].filter(Boolean).join(' · ') : undefined}
        status={{ label: forWords(t, task), tone: task.mine ? 'primary' : 'neutral' }}
        tone={KIND_TONE[task.kind]}
        facts={[
          { id: 'from', label: t('task.fact.from'), value: task.from?.code ?? null },
          { id: 'to', label: t('task.fact.to'), value: task.to?.code ?? null },
          { id: 'quantity', label: t('task.fact.quantity'), value: amount(quantityOf(task), task.uom) },
          { id: 'due', label: t('task.fact.due'), value: task.dueAt ? time(task.dueAt) : null, tone: isLate(task, now) ? 'danger' : undefined },
        ]}
        flags={[...(isLate(task, now) ? [{ id: 'late', label: t('row.late'), tone: 'danger' as const }] : []), ...(task.note ? [{ id: 'note', label: t('task.note', { note: task.note }), tone: 'info' as const }] : [])]}
        labels={ds.floorCard}
      >
        <TaskLine tone="info" icon={<ScanLine />}>
          {instruction}
        </TaskLine>
      </FloorCard>
      <ScanInput
        label={placeOnly ? t('where.scan.label') : t('what.scan.label')}
        hint={model.held ? floor('tile.held.notice') : instruction}
        scannedLabel={scanWords.scannedLabel}
        keyboardLabel={scanWords.keyboardLabel}
        disabled={Boolean(model.held) || Boolean(model.busy)}
        camera={camProps}
        onScan={(scanned) => send({ type: 'scan', code: scanned })}
      />
    </div>
  )
}

/** In your hands, the place it is taken from, the pad for part of a lot, and Scan the place. */
function HandStep({
  model,
  t,
  amount,
  figure,
  time,
  locale,
  ds,
  camProps,
  scanWords,
  send,
}: {
  model: MoveViewModel
  t: Translate
  amount: Amount
  figure: (value: number) => string
  time: (value: string) => string
  locale: string
  ds: ReturnType<typeof useDsWords>
  camProps: CamProps
  scanWords: ScanWords
  send: Send
}) {
  const floor = useT('floor')
  const scan = model.scan ?? null
  const code = model.code ?? scan?.hand.code ?? ''
  const from = scan ? fromOf(scan, model.picked ?? null, model.taskId ?? null) : null
  const pad = scan ? padOf(scan.hand, from) : null
  const value = model.value ?? null
  const task = scan ? taskOfMove(scan, from, model.taskId ?? null) : null
  const purpose = purposeOf(from)
  const act = placeActOf(scan, from)
  const goes = scan ? goesTo(scan, task, purpose) : null
  const held = placeHeld(scan, from, pad, value)
  const quarantine = scan ? quarantineTaskOf(scan) : null
  const hand = scan?.hand ?? null
  const asked = quarantine?.to?.code ?? null

  const where = hand ? (hand.lying.length === 0 ? t('hand.nowhere') : hand.lying.length === 1 ? hand.lying[0]!.code : t('hand.places', { count: hand.lying.length })) : null
  const goesWords = goes ? (goes.why === 'QUARANTINE' ? t('hand.flag.quarantine', { place: goes.code }) : t(`hand.flag.suggestion.${goes.why}`, { place: goes.code })) : null
  const scanHint = model.held
    ? floor('tile.held.notice')
    : model.busy
      ? t('where.held.busy')
      : held
        ? t(`where.held.${held}`)
        : act.kind === 'quarantine'
          ? asked
            ? t('where.scan.quarantine', { place: asked })
            : t('where.scan.quarantineAny')
          : goes
            ? t('where.scan.to', { place: goes.code })
            : t('where.scan.hint')
  const flags: { id: string; label: string; tone: FloorTone }[] = []
  if (hand && hand.quality !== 'RELEASED') flags.push({ id: 'quality', label: hand.quality === 'ON_HOLD' ? t('hand.flag.hold') : t('hand.flag.notReleased'), tone: 'warning' })
  if (quarantine) flags.push({ id: 'quarantine', label: asked ? t('hand.flag.quarantine', { place: asked }) : t('hand.flag.quarantineAny'), tone: 'warning' })
  else if (goesWords) flags.push({ id: 'goes', label: goesWords, tone: 'info' })
  if (hand?.whole && hand.kind === 'LOT') flags.push({ id: 'whole', label: t('hand.flag.wholeLot'), tone: 'neutral' })
  const readAloud = hand
    ? [t(`scanned.${hand.kind}`), code, hand.item.name, amount(hand.onHand, hand.uom), where ? t('hand.readWhere', { where }) : null, t(`quality.${hand.quality}`), goesWords ?? (quarantine ? t('hand.flag.quarantineAny') : null)].filter(Boolean).join('. ')
    : ''

  return (
    <div className="fw-floor-stack">
      {!model.online ? <HeldLine text={t('offline.line')} /> : null}
      {model.handAsOf ? <p className="fw-floor-muted">{t('asOf', { time: time(model.handAsOf) })}</p> : null}
      {hand ? (
        <FloorCard
          icon={hand.kind === 'HIDE' || hand.kind === 'REMNANT' ? <Layers /> : <Package />}
          kind={t('hand.title', { kind: t(`scanned.${hand.kind}`) })}
          code={code}
          title={[hand.item.code, hand.item.name, hand.colour?.name].filter(Boolean).join(' · ')}
          status={{ label: t(`quality.${hand.quality}`), tone: QUALITY_TONE[hand.quality] }}
          facts={[
            { id: 'onHand', label: t('hand.fact.onHand'), value: amount(hand.onHand, hand.uom) },
            { id: 'where', label: t('hand.fact.where'), value: where },
            { id: 'lot', label: t('hand.fact.lot'), value: hand.kind !== 'LOT' ? (hand.lot?.code ?? null) : null },
            { id: 'move', label: t('hand.fact.move'), value: act.kind === 'quarantine' ? t('kind.QUARANTINE') : t(`purpose.${purpose}`) },
          ]}
          flags={flags}
          asOf={model.handAsOf ?? null}
          formatTime={time}
          labels={ds.floorCard}
        >
          <ReadAloudButton text={readAloud} lang={locale === 'it' ? 'it-IT' : 'en-GB'} labels={ds.readAloud} size="md" />
        </FloorCard>
      ) : (
        <FloorCard icon={<Package />} kind={t('scanned.LABEL')} code={code} status={{ label: t('hand.blind.status'), tone: 'warning' }} flags={[{ id: 'blind', label: t('hand.blind.body'), tone: 'warning' }]} labels={ds.floorCard} />
      )}
      {hand && hand.lying.length > 1 && !quarantine ? (
        <section className="fw-floor-stack" aria-labelledby="fw-move-from">
          <h2 id="fw-move-from" className="fw-floor-section-title">
            {t('from.title')}
          </h2>
          {!from ? <p className="fw-floor-muted">{t('from.hint', { count: hand.lying.length })}</p> : null}
          <FloorList label={t('from.title')}>
            {hand.lying.map((entry) => (
              <FloorListRow
                key={entry.locationId}
                icon={<MapPin />}
                tone={from?.locationId === entry.locationId ? 'primary' : 'neutral'}
                title={<span className="fw-floor-code">{entry.code}</span>}
                meta={entry.name}
                status={from?.locationId === entry.locationId ? t('from.picked') : undefined}
                count={amount(entry.onHand, hand.uom) ?? undefined}
                countLabel={t('hand.fact.onHand')}
                selected={from?.locationId === entry.locationId}
                onPress={() => send({ type: 'pickFrom', locationId: entry.locationId })}
              />
            ))}
          </FloorList>
          <ListFooter
            count={t('from.count', { count: hand.lying.length })}
            keys={[
              { key: 'Tab', does: t('keys.tab') },
              { key: 'Enter', does: t('keys.pick') },
              { key: 'Esc', does: t('keys.back') },
            ]}
          />
        </section>
      ) : null}
      {pad && !quarantine ? (
        <section className="fw-move-pad" aria-labelledby="fw-move-pad-title">
          <h2 id="fw-move-pad-title" className="fw-floor-section-title">
            {t('pad.title')}
          </h2>
          <QuantityPad
            label={t('pad.label')}
            value={value}
            onChange={(next) => send({ type: 'pad', value: next })}
            unit={unitWord(t, hand?.uom)}
            min={pad.min}
            max={pad.max}
            decimals={pad.decimals}
            expected={pad.max}
            expectedLabel={(expected) => t('pad.expected', { quantity: figure(expected) })}
            quickValues={[{ value: pad.max, label: t('pad.all') }]}
            decimalSeparator={locale === 'it' ? ',' : '.'}
            separatorLabel={t('pad.separator')}
            decrementLabel={t('pad.minus')}
            incrementLabel={t('pad.plus')}
            clearLabel={t('pad.clear')}
            backLabel={t('pad.back')}
            emptyLabel={t('pad.empty')}
            rangeLabel={(min, max) => t('pad.range', { min: figure(min ?? 0), max: figure(max ?? 0) })}
          />
        </section>
      ) : null}
      <ScanInput
        label={t('where.scan.label')}
        hint={scanHint}
        scannedLabel={scanWords.scannedLabel}
        keyboardLabel={scanWords.keyboardLabel}
        disabled={Boolean(model.held) || Boolean(model.busy) || held !== null}
        camera={camProps}
        onScan={(scanned) => send({ type: 'scan', code: scanned })}
      />
    </div>
  )
}

/** What the screen did last: the move with its two ticks and Undo while its window is open; a quarantine move; an undo. */
function LastLine({ last, undo, online, t, amount, send }: { last: MoveLast | null; undo: 'open' | 'busy' | null; online: boolean; t: Translate; amount: Amount; send: Send }) {
  if (!last) return null
  if (last.kind === 'undone') {
    return (
      <TaskLine tone="info" icon={<Undo2 />}>
        {t('last.undone', { code: last.code, from: last.from ?? '' })}
      </TaskLine>
    )
  }
  if (last.ticks === 'refused') {
    return (
      <div className="fw-move-last" role="status">
        <TaskLine tone="danger" icon={<CircleAlert />}>
          {t('last.refused', { code: last.code, to: last.to })}
        </TaskLine>
        <Ticks state="refused" />
      </div>
    )
  }
  if (last.kind === 'quarantined') {
    return (
      <div className="fw-move-last" role="status">
        <TaskLine tone="success" icon={<ShieldAlert />}>
          {last.code ? t('last.quarantined', { code: last.code, to: last.to }) : t('last.quarantinedHold', { to: last.to })}
          {last.moved && last.moved.length > 0 ? ` · ${last.moved.map((entry) => t('last.movedFrom', { quantity: amount(entry.onHand, entry.uom) ?? '', from: entry.fromCode })).join(' · ')}` : ''}
        </TaskLine>
        {last.stays && last.stays.length > 0 ? (
          <TaskLine tone="warning" icon={<CircleAlert />}>
            {last.stays.map((entry) => t('last.stays', { at: entry.atCode, quantity: amount(entry.onHand, entry.uom) ?? '' })).join(' · ')}
          </TaskLine>
        ) : null}
        <Ticks state={last.ticks} />
      </div>
    )
  }
  const what = last.quantity ? t('last.moved', { code: last.code, quantity: amount(last.quantity, last.uom) ?? '', to: last.to }) : t('last.movedWhole', { code: last.code, to: last.to })
  return (
    <UndoStrip
      text={last.purpose ? `${t(`purpose.${last.purpose}`)}: ${what}` : what}
      ticks={last.ticks}
      onUndo={undo ? () => send({ type: 'undo' }) : null}
      undoHeld={!online ? t('undo.held.offline') : undo === 'busy' ? t('undo.held.busy') : null}
      undoLabel={t('undo.label')}
    />
  )
}
