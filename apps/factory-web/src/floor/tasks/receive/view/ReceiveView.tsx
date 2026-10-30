'use client'

import type { ReactNode } from 'react'
import { ArrowLeft, Check, CircleAlert, CircleSlash, ClipboardList, Layers, LogOut, Package, PackageCheck, PackagePlus, Printer, RotateCcw, ScanLine, ShieldAlert, Tag, Truck, X } from 'lucide-react'
import { Modal } from '@nexus/ui/components'
import { LabelPreview, type LabelLayout, type LabelPrintState } from '@nexus/ui/components/LabelPreview/index'
import { FloorActionBar, FloorButton, FloorList, FloorListRow, QuantityPad, ScanInput, qtyHeldReason, type CameraScanner, type FloorAction, type FloorActions, type FloorTone } from '@nexus/ui/floor'
import { formatDate, formatNumber, formatTime, type FormatPlace } from '../../../../lib/i18n/format'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import type { TaskProblem } from '../../shared/task-api'
import { HeldLine, ListFooter, ProblemState, TaskCard, TaskLine, Ticks, UndoStrip } from '../../shared/view/TaskParts'
import type { ExpectedOrder, FloorReceipt, OrderLine, OrderToReceive, ReceiptNote, ReprintReason } from '../api'
import {
  AREA_BOUNDS,
  DEFECT_CODES,
  deliverySummary,
  differenceOf,
  entered,
  entryOf,
  GRADES,
  HOLD_CODES,
  hideProblem,
  hideTotals,
  hideUnitOf,
  lastHide,
  linesInOrder,
  lotHolds,
  num,
  OVER_CODES,
  quantityBounds,
  receivingBase,
  tagCounts,
  tagState,
  THICKNESS_BOUNDS,
  type Delivery,
  type HideForm,
  type HoldCode,
  type OverCode,
  type QuantityForm,
  type TagState,
} from '../model'
import '../receive.css'

/**
 * SCR-092 — Receive goods on the floor (design floor.receive; SCM-113, SCM-116, SCM-117, SCM-233, SCM-247, SCM-259; A2
 * SCR-092): which delivery (scan our PO's number — on the PO or on the supplier's delivery note — or tap an expected
 * order; a code that is no PO number is kept as the delivery note's number), what we expect (the order's lines with what
 * is still to come, big), then per line: leather hide by hide (the tannery's number scanned, the area on the pad in the
 * order's unit, grade, thickness, dye batch and shade staying from the last hide; a new dye batch starts a new lot), a
 * lot-tracked material lot by lot, anything else by quantity, defaulted to what is open. Lots that need a chromium VI
 * result or a PPE certificate check go to quality hold, and the receiver can hold one for a check with a reason; only
 * quality releases. Finish the delivery posts it in ONE call (online only: the receipt, its lots and the hide tags take
 * their numbers from the office), then the hide tags print on the station's label printer, each with its print state,
 * Retry and Reprint. No money anywhere; nobody's output is shown.
 */

export type ReceiveStage = 'scan' | 'lines' | 'line' | 'finish' | 'done' | 'noPermission'

export interface ReceiveViewModel {
  frame: FrameModel
  online: boolean
  /** The worker notice holds scans. */
  held?: boolean
  stage: ReceiveStage
  /** scan: what the site expects; null while it is read. */
  expected?: readonly ExpectedOrder[] | null
  /** What is on screen is this tablet's copy (no network): when it was read. */
  asOf?: string | null
  /** scan: a code that is no PO number, kept as the delivery note's number while the order is picked. */
  ddtCode?: string | null
  order?: OrderToReceive | null
  delivery?: Delivery | null
  /** line: the order line being received. */
  lineId?: string | null
  hideForm?: HideForm | null
  quantityForm?: QuantityForm | null
  /** The hold reason tiles are open (hide or lot). */
  holdAsk?: boolean
  /** Leaving a delivery with entries asks first. */
  leaveAsk?: boolean
  busy?: 'post' | 'tags' | 'retry' | 'read' | null
  posted?: {
    readonly receipt: FloorReceipt
    readonly notes: readonly ReceiptNote[]
  } | null
  /** done: the tag shown in the preview (and the one a reprint prints). */
  selectedHideId?: string | null
  /** done: the reprint's reason tiles are open. */
  reprintAsk?: boolean
  /** A refusal or a failure, full screen. */
  problem?: {
    readonly problem: TaskProblem
    readonly code: string | null
  } | null
  /** A refused line of the last post (its seq), shown on the finish step. */
  refusedSeq?: number | null
  timeZone?: string
}

export type ReceiveAction =
  | { type: 'scan'; code: string }
  | { type: 'open'; orderId: string }
  | { type: 'clearDdt' }
  | { type: 'line'; lineId: string }
  | { type: 'lines' }
  | { type: 'area'; value: number | null }
  | { type: 'thickness'; value: number | null }
  | { type: 'pad'; pad: 'area' | 'thickness' }
  | { type: 'text'; target: HideForm['text'] }
  | { type: 'grade'; grade: string }
  | { type: 'defect'; code: (typeof DEFECT_CODES)[number] }
  | { type: 'holdAsk' }
  | { type: 'hold'; hold: HoldCode | null }
  | { type: 'saveHide' }
  | { type: 'undoHide' }
  | { type: 'quantity'; value: number | null }
  | { type: 'saveQuantity' }
  | { type: 'undoLot' }
  | { type: 'finish' }
  | { type: 'over'; lineId: string; over: OverCode }
  | { type: 'post' }
  | { type: 'tag'; hideId: string }
  | { type: 'retryTag'; hideId: string }
  | { type: 'reprintAsk' }
  | { type: 'reprint'; reason: ReprintReason }
  | { type: 'printAll' }
  | { type: 'next' }
  | { type: 'leave' }
  | { type: 'leaveConfirm' }
  | { type: 'leaveCancel' }
  | { type: 'back' }
  | { type: 'dismiss' }
  | { type: 'retry' }

export interface ReceiveViewProps {
  model: ReceiveViewModel
  onAction?: (action: ReceiveAction) => void
  onFrame?: (action: FrameAction) => void
  camera?: CameraScanner
}

/** The refusals the screen words itself (`refusal.<CODE>`); the others keep the API's words. */
const OWN_REFUSALS = new Set([
  'ORDER_CHANGED',
  'NOT_RECEIVING',
  'STATUS_DRAFT',
  'STATUS_CHANGES_PROPOSED',
  'STATUS_RECEIVED',
  'STATUS_CLOSED',
  'STATUS_CANCELLED',
  'STATUS_DECLINED',
  'NO_DOCK',
  'LINE_REFUSED',
  'BADGE',
])
const NOTE_CODES = new Set(['SHORT', 'WITHIN_TOLERANCE', 'OVER', 'HIDE_COUNT', 'ONE_DYE_BATCH', 'THICKNESS', 'NO_SUPPLIER_DDT'])

/** A unit's short name (`unit.FT2` → "ft²"), else its code. */
export function unitWord(t: Translate, uom: string): string {
  const key = `unit.${uom}`
  const word = t(key)
  return word === key ? uom : word
}

/** A word for a code in `group` (`status.CONFIRMED`), else the code. */
function wordOf(t: Translate, group: string, code: string): string {
  const key = `${group}.${code}`
  const word = t(key)
  return word === key ? code : word
}

export function refusalWords(t: Translate, code: string): { message: string; fix: string | null } | null {
  return OWN_REFUSALS.has(code) ? { message: t(`refusal.${code}.message`), fix: t(`refusal.${code}.fix`) } : null
}

const PRINT_STATUS: Record<Exclude<TagState, 'notPrinted'>, LabelPrintState['status']> = { queued: 'queued', sent: 'sent', printed: 'printed', failed: 'failed' }
const TAG_TONE: Record<TagState, FloorTone> = {
  queued: 'neutral',
  sent: 'info',
  printed: 'success',
  failed: 'danger',
  notPrinted: 'warning',
}

export function ReceiveView({ model, onAction, onFrame, camera }: ReceiveViewProps) {
  const t = useT('floor-receive')
  const shared = useT('floor-tasks')
  const floor = useT('floor')
  const locale = useLocale()
  const send = (action: ReceiveAction) => onAction?.(action)
  const place: FormatPlace = { locale, timeZone: model.timeZone }
  const figure = (value: number, decimals = 2) => formatNumber(value, locale, { maximumFractionDigits: decimals })
  const amount = (value: number, uom: string, decimals = 2) => `${figure(value, decimals)} ${unitWord(t, uom)}`
  const day = (value: string | null) => (value ? formatDate(`${value}T12:00:00Z`, place) : '—')
  const camProps = camera
    ? {
        scanner: camera,
        startLabel: floor('scan.camera.start'),
        stopLabel: floor('scan.camera.stop'),
        errorLabel: floor('scan.camera.error'),
      }
    : undefined
  const offlineHeld = model.online ? null : t('offline.short')
  // Beside a pad the scan field leaves the focus to the pad (a scanner's burst is still read from anywhere).
  const scanField = (label: string, hint: string, extra: { disabled?: boolean; keepFocus?: boolean } = {}) => (
    <ScanInput
      label={label}
      keepFocus={extra.keepFocus ?? true}
      hint={model.held ? floor('tile.held.notice') : hint}
      scannedLabel={(code) => floor('scan.read', { code })}
      keyboardLabel={floor('scan.type')}
      disabled={Boolean(model.held) || Boolean(extra.disabled)}
      camera={camProps}
      onScan={(code) => send({ type: 'scan', code })}
    />
  )

  let actions: FloorActions | null = null
  let body: ReactNode

  if (model.stage === 'noPermission') {
    body = <FloorState tone="warning" icon={<CircleSlash />} title={t('noPermission.title')} text={t('noPermission.body')} alert />
  } else if (model.problem) {
    const { problem, code } = model.problem
    body = <ProblemState problem={problem} code={code} words={(refusal) => refusalWords(t, refusal)} />
    const closed = problem.kind === 'refused' && (problem.code.startsWith('STATUS_') || problem.code === 'NOT_RECEIVING')
    const back: FloorAction = closed
      ? { label: t('action.next'), icon: <Truck />, onPress: () => send({ type: 'next' }) }
      : { label: model.order ? t('action.toLines') : shared('action.scanAnother'), icon: model.order ? <ArrowLeft /> : <ScanLine />, onPress: () => send({ type: 'dismiss' }) }
    actions =
      problem.kind === 'unavailable' || problem.kind === 'offline'
        ? [
            back,
            {
              label: shared('action.retry'),
              icon: <RotateCcw />,
              onPress: () => send({ type: 'retry' }),
            },
          ]
        : [back]
  } else if (model.stage === 'scan') {
    body = (
      <div className="fw-floor-stack">
        {!model.online ? <HeldLine text={t('offline.held')} /> : null}
        {scanField(t('scan.label'), t('scan.hint'))}
        {model.ddtCode ? (
          <TaskLine tone="info" icon={<Truck />}>
            {t('scan.ddtKept', { code: model.ddtCode })}{' '}
            <FloorButton size="sm" variant="quiet" icon={<X />} onClick={() => send({ type: 'clearDdt' })}>
              {t('scan.ddtClear')}
            </FloorButton>
          </TaskLine>
        ) : null}
        {model.asOf ? <p className="fw-floor-muted">{shared('asOf', { time: formatTime(model.asOf, place) })}</p> : null}
        {model.expected === null || model.expected === undefined ? (
          <FloorState tone="info" icon={<ClipboardList />} title={t('scan.loading')} busy />
        ) : model.expected.length === 0 ? (
          <FloorState tone="info" icon={<Truck />} title={t('scan.empty.title')} text={t('scan.empty.body')} />
        ) : (
          <section className="fw-floor-stack" aria-labelledby="fw-receive-expected">
            <h2 id="fw-receive-expected" className="fw-floor-subtitle">
              {model.ddtCode ? t('scan.pick') : t('scan.expected')}
            </h2>
            <FloorList label={t('scan.expected')}>
              {model.expected.map((row) => (
                <FloorListRow
                  key={row.id}
                  icon={<Truck />}
                  tone={row.status === 'PARTLY_RECEIVED' ? 'info' : 'neutral'}
                  title={
                    <>
                      <span className="fw-floor-code">{row.number}</span> · {row.supplier.name}
                    </>
                  }
                  meta={[row.due ? t('scan.due', { date: day(row.due) }) : null, row.receivedBefore ? t('scan.partly') : null].filter(Boolean).join(' · ') || undefined}
                  status={wordOf(t, 'status', row.status)}
                  count={formatNumber(row.openLines, locale)}
                  countLabel={t('scan.openLines', { count: row.openLines })}
                  heldReason={offlineHeld}
                  onPress={() => send({ type: 'open', orderId: row.id })}
                />
              ))}
            </FloorList>
            <ListFooter
              count={t('scan.count', { count: model.expected.length })}
              keys={[
                { key: 'Tab', does: shared('keys.tab') },
                { key: 'Enter', does: shared('keys.enter') },
                { key: 'Esc', does: shared('keys.escape') },
              ]}
            />
          </section>
        )}
      </div>
    )
  } else if (!model.order || !model.delivery) {
    body = <FloorState tone="info" icon={<ClipboardList />} title={t('lines.loading')} busy />
  } else if (model.stage === 'done' && model.posted) {
    ;({ body, actions } = doneStep(model, t, send, {
      amount,
      figure,
      place,
      scanField,
      offlineHeld,
    }))
  } else if (model.stage === 'finish') {
    ;({ body, actions } = finishStep(model, t, send, { amount, offlineHeld }))
  } else if (model.stage === 'line' && model.lineId) {
    const line = model.order.lines.find((entry) => entry.id === model.lineId)
    if (!line) body = <FloorState tone="info" icon={<ClipboardList />} title={t('lines.loading')} busy />
    else
      ({ body, actions } = lineStep(model, line, t, send, {
        amount,
        figure,
        locale,
        scanField,
        offlineHeld,
      }))
  } else {
    ;({ body, actions } = linesStep(model, t, send, {
      amount,
      figure,
      day,
      place,
      scanField,
      offlineHeld,
      shared,
    }))
  }

  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={actions ? <FloorActionBar label={t('title')} actions={actions} /> : undefined}>
      {body}
      <Modal open={Boolean(model.leaveAsk)} onClose={() => send({ type: 'leaveCancel' })} title={t('leave.title')} size="sm" className="fw-floor-dialog">
        <div className="fw-floor-dialog-body">
          <p className="fw-floor-dialog-line">
            <strong>{t('leave.body')}</strong>
          </p>
          <div className="fw-floor-dialog-actions">
            <FloorButton size="lg" variant="secondary" icon={<X />} autoFocus onClick={() => send({ type: 'leaveCancel' })}>
              {t('leave.stay')}
            </FloorButton>
            <FloorButton size="lg" variant="danger" icon={<LogOut />} onClick={() => send({ type: 'leaveConfirm' })}>
              {t('leave.confirm')}
            </FloorButton>
          </div>
        </div>
      </Modal>
    </FloorFrameView>
  )
}

type Send = (action: ReceiveAction) => void
type Step = { body: ReactNode; actions: FloorActions | null }

// ---- the order's lines --------------------------------------------------------------------------------------------------

function orderCard(order: OrderToReceive, delivery: Delivery, t: Translate, extra: { day: (value: string | null) => string }) {
  const open = order.lines.filter((line) => num(line.open) > 0).length
  return (
    <TaskCard
      icon={<Truck />}
      type={t('card.order')}
      code={order.order.number}
      status={wordOf(t, 'status', order.order.status)}
      statusTone={order.order.status === 'PARTLY_RECEIVED' ? 'info' : 'success'}
      big={{ value: String(open), label: t('card.openLines', { count: open }) }}
      facts={[
        { label: t('card.supplier'), value: order.order.supplier.name },
        {
          label: t('card.ddt'),
          value: delivery.ddtNumber ?? t('card.ddtNone'),
        },
        {
          label: t('card.dock'),
          value: order.dock ? `${order.dock.code} · ${order.dock.name}` : t('card.noDock'),
        },
        ...(order.order.requestedDate
          ? [
              {
                label: t('card.requested'),
                value: extra.day(order.order.requestedDate),
              },
            ]
          : []),
      ]}
    />
  )
}

function linesStep(
  model: ReceiveViewModel,
  t: Translate,
  send: Send,
  ui: {
    amount: (value: number, uom: string, decimals?: number) => string
    figure: (value: number, decimals?: number) => string
    day: (value: string | null) => string
    place: FormatPlace
    scanField: (label: string, hint: string, extra?: { disabled?: boolean; keepFocus?: boolean }) => ReactNode
    offlineHeld: string | null
    shared: Translate
  },
): Step {
  const order = model.order!
  const delivery = model.delivery!
  const any = order.lines.some((line) => entered(delivery.entries[line.id]))
  const refused = order.refusal
  const finishHeld = refused ? t('lines.refusedShort') : !any ? t('lines.nothingYet') : null
  const actions: FloorActions = [
    {
      label: t('action.leave'),
      icon: <ArrowLeft />,
      onPress: () => send({ type: 'leave' }),
    },
    {
      label: t('action.finish'),
      icon: <PackageCheck />,
      heldReason: finishHeld,
      onPress: () => send({ type: 'finish' }),
    },
  ]
  const body = (
    <div className="fw-floor-stack">
      {!model.online ? <HeldLine text={t('offline.held')} /> : null}
      {model.asOf ? <p className="fw-floor-muted">{ui.shared('asOf', { time: formatTime(model.asOf, ui.place) })}</p> : null}
      {orderCard(order, delivery, t, { day: ui.day })}
      {refused ? (
        <TaskLine tone="danger" icon={<CircleAlert />} alert>
          {t('lines.refused', {
            status: wordOf(t, 'status', order.order.status),
          })}
        </TaskLine>
      ) : null}
      {ui.scanField(t('lines.ddt.label'), delivery.ddtNumber ? t('lines.ddt.again', { code: delivery.ddtNumber }) : t('lines.ddt.hint'))}
      <section className="fw-floor-stack" aria-labelledby="fw-receive-lines">
        <h2 id="fw-receive-lines" className="fw-floor-subtitle">
          {t('lines.title')}
        </h2>
        <FloorList label={t('lines.title')}>
          {linesInOrder(order.lines).map((line) => {
            const entry = delivery.entries[line.id]
            const here = entry && entered(entry) ? onDelivery(line, entry, t, ui.amount) : null
            const open = num(line.open)
            const unit = line.item.tracking === 'HIDE' ? hideUnitOf(line) : line.item.baseUom
            const shownOpen = line.item.tracking === 'HIDE' ? hideTotals(line, entryOf(delivery, line.id)).open : open
            return (
              <FloorListRow
                key={line.id}
                icon={line.item.tracking === 'HIDE' ? <Layers /> : <Package />}
                tone={here ? 'info' : open <= 0 ? 'success' : 'neutral'}
                title={lineTitle(line)}
                meta={[
                  t('line.ordered', {
                    quantity: ui.amount(num(line.quantity), line.uom),
                  }),
                  t('line.receivedBefore', {
                    quantity: ui.amount(num(line.received), line.item.baseUom),
                  }),
                  t(`tracking.${line.item.tracking}`),
                  line.holds.length > 0 ? t('line.goesToHold') : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                status={here ?? (open <= 0 ? t('line.receivedInFull') : t('line.toCome'))}
                count={ui.figure(Math.max(0, shownOpen))}
                countLabel={t('line.remaining', { unit: unitWord(t, unit) })}
                heldReason={refused ? t('lines.refusedShort') : null}
                onPress={() => send({ type: 'line', lineId: line.id })}
              />
            )
          })}
        </FloorList>
        <ListFooter
          count={t('lines.count', { count: order.lines.length })}
          keys={[
            { key: 'Tab', does: ui.shared('keys.tab') },
            { key: 'Enter', does: ui.shared('keys.enter') },
            { key: 'Esc', does: t('keys.leave') },
          ]}
        />
      </section>
    </div>
  )
  return { body, actions }
}

const lineTitle = (line: OrderLine) => `${line.item.code} · ${line.item.name}${line.colour ? ` · ${line.colour.name}` : ''}`

/** What this delivery holds of a line, short ("3 hides · 152,4 ft²", "2 lots · 120 pairs"). */
function onDelivery(line: OrderLine, entry: ReturnType<typeof entryOf>, t: Translate, amount: (value: number, uom: string, decimals?: number) => string): string {
  if (line.item.tracking === 'HIDE') {
    const totals = hideTotals(line, entry)
    return t('line.hereHides', {
      count: totals.hides,
      area: amount(totals.area, totals.unit),
    })
  }
  const base = num(receivingBase(line, entry))
  if (line.item.tracking === 'LOT')
    return t('line.hereLots', {
      count: entry.lots.length,
      quantity: amount(base, line.item.baseUom),
    })
  return t('line.here', { quantity: amount(base, line.item.baseUom) })
}

// ---- one line ------------------------------------------------------------------------------------------------------------

function holdBanner(model: ReceiveViewModel, holds: readonly string[], t: Translate) {
  if (holds.length === 0) return null
  const why = holds.map((code) => wordOf(t, 'hold', code)).join(' · ')
  const where = model.order?.hold
  return (
    <TaskLine tone="warning" icon={<ShieldAlert />}>
      {where ? t('holdBanner.to', { place: where.code, why }) : t('holdBanner.apart', { why })}
    </TaskLine>
  )
}

function holdPicker(model: ReceiveViewModel, current: HoldCode | null, t: Translate, send: Send) {
  if (!model.holdAsk) {
    return (
      <div className="fw-receive-chips">
        <FloorButton size="md" variant={current ? 'warning' : 'secondary'} icon={<ShieldAlert />} aria-pressed={Boolean(current)} onClick={() => send({ type: 'holdAsk' })}>
          {current ? t('hold.chosen', { reason: t(`hold.reason.${current}`) }) : t('hold.ask')}
        </FloorButton>
      </div>
    )
  }
  return (
    <div className="fw-floor-stack">
      <p className="fw-floor-subtitle">{t('hold.title')}</p>
      <div className="fw-task-reasons" role="group" aria-label={t('hold.title')}>
        {HOLD_CODES.map((code) => (
          <FloorButton key={code} size="md" block variant={current === code ? 'warning' : 'secondary'} aria-pressed={current === code} onClick={() => send({ type: 'hold', hold: code })}>
            {t(`hold.reason.${code}`)}
          </FloorButton>
        ))}
        <FloorButton size="md" block variant="quiet" icon={<X />} onClick={() => send({ type: 'hold', hold: null })}>
          {t('hold.none')}
        </FloorButton>
      </div>
    </div>
  )
}

function lineCard(line: OrderLine, t: Translate, big: { value: string; label: string }, figure: (value: number, decimals?: number) => string) {
  const thickness =
    line.thicknessMinMm || line.thicknessMaxMm
      ? t('card.thicknessRange', {
          min: line.thicknessMinMm ? figure(num(line.thicknessMinMm)) : '…',
          max: line.thicknessMaxMm ? figure(num(line.thicknessMaxMm)) : '…',
        })
      : null
  const asked = [line.grade ? t('card.gradeAsked', { grade: line.grade }) : null, thickness, line.oneDyeBatch ? t('card.oneDyeBatch') : null].filter(Boolean).join(' · ')
  return (
    <TaskCard
      icon={line.item.tracking === 'HIDE' ? <Layers /> : <Package />}
      type={[t('card.line', { seq: line.seq }), line.colour ? `${line.colour.code} · ${line.colour.name}` : null].filter(Boolean).join(' · ')}
      code={line.item.code}
      big={big}
      flags={
        <p className="fw-floor-muted">
          {line.item.name}
          {asked ? ` · ${asked}` : ''}
        </p>
      }
    />
  )
}

function lineStep(
  model: ReceiveViewModel,
  line: OrderLine,
  t: Translate,
  send: Send,
  ui: {
    amount: (value: number, uom: string, decimals?: number) => string
    figure: (value: number, decimals?: number) => string
    locale: string
    scanField: (label: string, hint: string, extra?: { disabled?: boolean; keepFocus?: boolean }) => ReactNode
    offlineHeld: string | null
  },
): Step {
  const delivery = model.delivery!
  const entry = entryOf(delivery, line.id)
  const difference = differenceOf(line, entry)
  const padWords = {
    separatorLabel: t('pad.separator'),
    decrementLabel: t('pad.minus'),
    incrementLabel: t('pad.plus'),
    clearLabel: t('pad.clear'),
    backLabel: t('pad.back'),
    emptyLabel: t('pad.empty'),
    rangeLabel: (min: number | undefined, max: number | undefined) => t('pad.range', { min: ui.figure(min ?? 0), max: ui.figure(max ?? 0) }),
    decimalSeparator: ui.locale === 'it' ? ',' : '.',
  }
  const overLine =
    difference.kind === 'OVER' ? (
      <TaskLine tone="warning" icon={<CircleAlert />}>
        {t('over.now', {
          quantity: ui.amount(num(difference.difference), line.item.baseUom),
        })}
      </TaskLine>
    ) : null

  if (line.item.tracking === 'HIDE') {
    const form = model.hideForm!
    const totals = hideTotals(line, entry)
    const last = lastHide(entry)
    const unit = hideUnitOf(line)
    const thicknessPad = form.pad === 'thickness'
    const saveHeld = ui.offlineHeld ? null : hideProblem(form) ? t('hide.needArea') : null
    const actions: FloorActions = [
      {
        label: t('action.lineDone'),
        icon: <Check />,
        onPress: () => send({ type: 'lines' }),
      },
      {
        label: t('action.saveHide'),
        icon: <Tag />,
        heldReason: saveHeld,
        onPress: () => send({ type: 'saveHide' }),
      },
    ]
    const textLabel = form.text === 'dyeBatch' ? t('hide.scan.dyeBatch') : form.text === 'shade' ? t('hide.scan.shade') : t('hide.scan.supplierCode')
    const textHint = form.text === 'supplierCode' ? (form.supplierCode ? t('hide.scan.supplierRead', { code: form.supplierCode }) : t('hide.scan.supplierHint')) : t('hide.scan.otherHint')
    const body = (
      <div className="fw-floor-stack fw-receive-step">
        <section className="fw-receive-pad" aria-labelledby="fw-receive-pad-title">
          <div className="fw-receive-pad-head">
            <h2 id="fw-receive-pad-title" className="fw-floor-section-title">
              {thicknessPad ? t('hide.thickness') : t('hide.area', { n: totals.hides + 1 })}
            </h2>
            <span className="fw-receive-pad-sum">{t('hide.sum', { hides: totals.hides, area: ui.amount(totals.area, totals.unit), open: ui.amount(Math.max(0, totals.open), totals.unit) })}</span>
            <FloorButton size="md" variant="secondary" aria-pressed={thicknessPad} onClick={() => send({ type: 'pad', pad: thicknessPad ? 'area' : 'thickness' })}>
              {thicknessPad
                ? t('hide.toArea')
                : form.thicknessMm !== null
                  ? t('hide.thicknessIs', {
                      value: ui.figure(form.thicknessMm),
                    })
                  : t('hide.toThickness')}
            </FloorButton>
          </div>
          {thicknessPad ? (
            <QuantityPad
              key="thickness"
              label={t('hide.thickness')}
              hideLabel
              value={form.thicknessMm}
              onChange={(value) => send({ type: 'thickness', value })}
              unit="mm"
              min={THICKNESS_BOUNDS.min}
              max={THICKNESS_BOUNDS.max}
              decimals={THICKNESS_BOUNDS.decimals}
              step={0.1}
              {...padWords}
              autoFocus
            />
          ) : (
            <QuantityPad
              key="area"
              label={t('hide.areaLabel')}
              hideLabel
              value={form.area}
              onChange={(value) => send({ type: 'area', value })}
              unit={unitWord(t, unit)}
              min={AREA_BOUNDS.min}
              max={AREA_BOUNDS.max}
              decimals={AREA_BOUNDS.decimals}
              {...padWords}
              autoFocus
            />
          )}
        </section>
        <div className="fw-receive-head">
          {lineCard(
            line,
            t,
            {
              value: totals.expectedHides === null ? String(totals.hides) : `${totals.hides}/${totals.expectedHides}`,
              label: t('hide.countLabel'),
            },
            ui.figure,
          )}
          <div className="fw-receive-totals" role="status">
            <Total value={ui.figure(totals.area)} unit={unitWord(t, totals.unit)} label={t('hide.total.area')} />
            <Total value={ui.figure(Math.max(0, totals.open))} unit={unitWord(t, totals.unit)} label={t('hide.total.open')} />
            <Total value={ui.figure(Math.max(0, totals.upTo))} unit={unitWord(t, totals.unit)} label={t('hide.total.upTo')} />
          </div>
        </div>
        <div className="fw-receive-more">
          <div className="fw-floor-stack">
            {overLine}
            {holdBanner(model, lotHolds(line, form.hold), t)}
            {last ? (
              <UndoStrip
                text={t('hide.last', {
                  n: totals.hides,
                  area: ui.amount(last.hide.area, last.hide.areaUom),
                  grade: last.hide.grade ?? '—',
                  code: last.hide.supplierCode ?? '—',
                })}
                onUndo={() => send({ type: 'undoHide' })}
                undoLabel={t('hide.undo')}
              />
            ) : null}
            {ui.scanField(textLabel, textHint, { keepFocus: false })}
            <div className="fw-receive-chips" role="group" aria-label={t('hide.same')}>
              <FloorButton
                size="md"
                variant={form.text === 'supplierCode' ? 'primary' : 'secondary'}
                aria-pressed={form.text === 'supplierCode'}
                onClick={() => send({ type: 'text', target: 'supplierCode' })}
              >
                {t('hide.chip.supplierCode', {
                  code: form.supplierCode ?? '—',
                })}
              </FloorButton>
              <FloorButton size="md" variant={form.text === 'dyeBatch' ? 'primary' : 'secondary'} aria-pressed={form.text === 'dyeBatch'} onClick={() => send({ type: 'text', target: 'dyeBatch' })}>
                {t('hide.chip.dyeBatch', { code: form.dyeBatch ?? '—' })}
              </FloorButton>
              <FloorButton size="md" variant={form.text === 'shade' ? 'primary' : 'secondary'} aria-pressed={form.text === 'shade'} onClick={() => send({ type: 'text', target: 'shade' })}>
                {t('hide.chip.shade', { code: form.shade ?? '—' })}
              </FloorButton>
            </div>
          </div>
          <div className="fw-floor-stack">
            <div className="fw-floor-stack">
              <p className="fw-floor-subtitle" id="fw-receive-grade">
                {t('hide.grade')}
              </p>
              <div className="fw-receive-grades" role="group" aria-labelledby="fw-receive-grade">
                {GRADES.map((grade) => (
                  <FloorButton key={grade} size="lg" block variant={form.grade === grade ? 'primary' : 'secondary'} aria-pressed={form.grade === grade} onClick={() => send({ type: 'grade', grade })}>
                    {grade}
                  </FloorButton>
                ))}
              </div>
            </div>
            <div className="fw-floor-stack">
              <p className="fw-floor-subtitle" id="fw-receive-defects">
                {t('hide.defects')}
              </p>
              <div className="fw-receive-chips" role="group" aria-labelledby="fw-receive-defects">
                {DEFECT_CODES.map((code) => (
                  <FloorButton
                    key={code}
                    size="md"
                    variant={form.defects.includes(code) ? 'warning' : 'secondary'}
                    aria-pressed={form.defects.includes(code)}
                    onClick={() => send({ type: 'defect', code })}
                  >
                    {t(`defect.${code}`)}
                  </FloorButton>
                ))}
              </div>
            </div>
            {holdPicker(model, form.hold, t, send)}
            <p className="fw-floor-muted">
              <span className="fw-floor-inline-icon" aria-hidden="true">
                <Printer />
              </span>
              {t('hide.tagsLater')}
            </p>
          </div>
        </div>
      </div>
    )
    return { body, actions }
  }

  // A lot-tracked material lot by lot; anything else one quantity.
  const form = model.quantityForm!
  const lots = line.item.tracking === 'LOT'
  const bounds = quantityBounds(line)
  const uom = line.item.baseUom
  const held = ui.offlineHeld ? null : qtyHeldReason(form.quantity, bounds, padWords)
  const actions: FloorActions = [
    {
      label: t('action.toLines'),
      icon: <ArrowLeft />,
      onPress: () => send({ type: 'lines' }),
    },
    {
      label:
        form.quantity !== null
          ? t(lots ? 'action.receiveLot' : 'action.receive', {
              quantity: ui.amount(form.quantity, uom, bounds.decimals),
            })
          : t('action.receiveNothing'),
      icon: <PackagePlus />,
      heldReason: held,
      onPress: () => send({ type: 'saveQuantity' }),
    },
  ]
  const lastLot = lots && entry.lots.length > 0 ? entry.lots.reduce((top, lot) => (lot.n > top.n ? lot : top)) : null
  const body = (
    <div className="fw-floor-stack fw-receive-step">
      <section className="fw-receive-pad" aria-labelledby="fw-receive-qty-title">
        <h2 id="fw-receive-qty-title" className="fw-floor-section-title">
          {lots ? t('lot.title', { n: entry.lots.length + 1 }) : t('quantity.title')}
        </h2>
        <QuantityPad
          label={t('quantity.label')}
          hideLabel
          value={form.quantity}
          onChange={(value) => send({ type: 'quantity', value })}
          unit={unitWord(t, uom)}
          min={bounds.min}
          max={bounds.max}
          decimals={bounds.decimals}
          expected={bounds.suggested > 0 ? bounds.suggested : undefined}
          expectedLabel={(expected) =>
            t('pad.expected', {
              quantity: ui.figure(expected, bounds.decimals),
            })
          }
          quickValues={bounds.suggested > 0 ? [{ value: bounds.suggested, label: t('pad.all') }] : []}
          {...padWords}
          autoFocus
        />
      </section>
      {lineCard(
        line,
        t,
        {
          value: ui.figure(Math.max(0, num(line.open)), bounds.decimals),
          label: t('line.remaining', { unit: unitWord(t, uom) }),
        },
        ui.figure,
      )}
      <div className="fw-floor-stack">
        {overLine}
        {holdBanner(model, lotHolds(line, form.hold), t)}
        {lastLot ? (
          <UndoStrip
            text={t('lot.last', {
              count: entry.lots.length,
              quantity: ui.amount(lastLot.quantity ?? 0, uom, bounds.decimals),
              ref: lastLot.supplierLotRef ?? '—',
            })}
            onUndo={() => send({ type: 'undoLot' })}
            undoLabel={t('lot.undo')}
          />
        ) : !lots && entry.quantity !== null ? (
          <TaskLine tone="info" icon={<Check />}>
            {t('quantity.here', {
              quantity: ui.amount(entry.quantity, uom, bounds.decimals),
            })}
          </TaskLine>
        ) : null}
        {lots ? ui.scanField(t('lot.scan.label'), form.supplierLotRef ? t('lot.scan.read', { code: form.supplierLotRef }) : t('lot.scan.hint'), { keepFocus: false }) : null}
        <p className="fw-floor-muted">
          {t('quantity.expected', {
            open: ui.amount(Math.max(0, num(line.open)), uom, bounds.decimals),
            upTo: ui.amount(Math.max(0, num(line.upTo)), uom, bounds.decimals),
          })}
        </p>
        {lots ? holdPicker(model, form.hold, t, send) : null}
      </div>
    </div>
  )
  return { body, actions }
}

function Total({ value, unit, label }: { value: string; unit: string; label: string }) {
  return (
    <div className="fw-receive-total">
      <span className="fw-task-big-value">{value}</span>
      <span className="fw-receive-total-unit">{unit}</span>
      <span className="fw-task-big-label">{label}</span>
    </div>
  )
}

// ---- finish ---------------------------------------------------------------------------------------------------------------

function finishStep(
  model: ReceiveViewModel,
  t: Translate,
  send: Send,
  ui: {
    amount: (value: number, uom: string, decimals?: number) => string
    offlineHeld: string | null
  },
): Step {
  const order = model.order!
  const delivery = model.delivery!
  const summary = deliverySummary(order, delivery)
  const busy = model.busy === 'post'
  const held = ui.offlineHeld ?? (summary.lines.length === 0 ? t('lines.nothingYet') : summary.needReason.length > 0 ? t('finish.needReason') : busy ? t('finish.busy') : null)
  const actions: FloorActions = [
    {
      label: t('action.toLines'),
      icon: <ArrowLeft />,
      onPress: () => send({ type: 'lines' }),
    },
    {
      label: t('action.post'),
      icon: <PackageCheck />,
      heldReason: held,
      onPress: () => send({ type: 'post' }),
    },
  ]
  const body = (
    <div className="fw-floor-stack">
      {!model.online ? <HeldLine text={t('offline.post')} /> : null}
      <TaskCard
        icon={<ClipboardList />}
        type={t('finish.title')}
        code={order.order.number}
        status={order.order.supplier.name}
        big={{
          value: String(summary.lines.length),
          label: t('finish.linesLabel', { count: summary.lines.length }),
        }}
        facts={[
          { label: t('finish.lots'), value: String(summary.lots) },
          { label: t('finish.hides'), value: String(summary.hides) },
          { label: t('finish.held'), value: String(summary.held) },
          { label: t('finish.short'), value: String(summary.short) },
          { label: t('finish.over'), value: String(summary.over) },
          {
            label: t('card.ddt'),
            value: delivery.ddtNumber ?? t('card.ddtNone'),
          },
        ]}
      />
      {summary.held > 0 ? (
        <TaskLine tone="warning" icon={<ShieldAlert />}>
          {order.hold
            ? t('finish.heldTo', {
                count: summary.held,
                place: order.hold.code,
              })
            : t('finish.heldApart', { count: summary.held })}
        </TaskLine>
      ) : null}
      {!delivery.ddtNumber ? (
        <p className="fw-floor-muted">
          <span className="fw-floor-inline-icon" aria-hidden="true">
            <Truck />
          </span>
          {t('finish.noDdt')}
        </p>
      ) : null}
      <ul className="fw-receive-summary">
        {summary.lines.map(({ line, entry, difference, hides, lots, held: heldLots }) => {
          const refused = model.refusedSeq === line.seq
          const tone = refused ? 'danger' : difference.kind === 'OVER' ? 'warning' : difference.kind === 'SHORT' ? 'info' : 'success'
          return (
            <li key={line.id} className="fw-receive-summary-line" data-tone={tone}>
              <div className="fw-receive-summary-head">
                <span className="fw-floor-subtitle">{lineTitle(line)}</span>
                <span className="fw-floor-pill" data-tone={tone}>
                  {t(`difference.${difference.kind}`)}
                </span>
              </div>
              <p className="fw-floor-muted">
                {[
                  t('finish.lineNow', {
                    quantity: ui.amount(num(receivingBase(line, entry)), line.item.baseUom),
                  }),
                  hides > 0 ? t('finish.lineHides', { count: hides }) : null,
                  lots > 0 ? t('finish.lineLots', { count: lots }) : null,
                  heldLots > 0 ? t('finish.lineHeld', { count: heldLots }) : null,
                  difference.kind === 'SHORT'
                    ? t('finish.stillOpen', {
                        quantity: ui.amount(num(difference.open), line.item.baseUom),
                      })
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              {refused ? (
                <TaskLine tone="danger" icon={<CircleAlert />}>
                  {t('finish.lineRefused')}
                </TaskLine>
              ) : null}
              {difference.kind === 'OVER' ? (
                <div className="fw-floor-stack">
                  <TaskLine tone="warning" icon={<CircleAlert />}>
                    {t('over.ask', {
                      quantity: ui.amount(num(difference.difference), line.item.baseUom),
                      upTo: ui.amount(num(difference.upTo), line.item.baseUom),
                    })}
                  </TaskLine>
                  <div className="fw-task-reasons" role="group" aria-label={t('over.title')}>
                    {OVER_CODES.map((code) => (
                      <FloorButton
                        key={code}
                        size="md"
                        block
                        variant={entry.over === code ? 'warning' : 'secondary'}
                        aria-pressed={entry.over === code}
                        onClick={() => send({ type: 'over', lineId: line.id, over: code })}
                      >
                        {t(`over.reason.${code}`)}
                      </FloorButton>
                    ))}
                  </div>
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
      <p className="fw-floor-muted">
        <span className="fw-floor-inline-icon" aria-hidden="true">
          <Printer />
        </span>
        {order.printer ? t('finish.printsOn', { printer: order.printer.name }) : t('finish.noPrinter')}
      </p>
    </div>
  )
  return { body, actions }
}

// ---- done -----------------------------------------------------------------------------------------------------------------

function tagLayout(
  receipt: FloorReceipt,
  hideId: string,
  t: Translate,
  amount: (value: number, uom: string, decimals?: number) => string,
  figure: (value: number, decimals?: number) => string,
): LabelLayout | null {
  const hide = receipt.hides.find((entry) => entry.id === hideId)
  if (!hide) return null
  const lot = receipt.lots.find((entry) => entry.id === hide.lotId)
  const line = receipt.lines.find((entry) => entry.seq === lot?.lineSeq)
  const fields = [
    { label: t('label.colour'), value: line?.colour?.name ?? '—' },
    { label: t('label.grade'), value: hide.grade ?? '—', size: 'xl' as const },
    {
      label: t('label.area'),
      value: amount(num(hide.area), hide.areaUom),
      size: 'lg' as const,
    },
    {
      label: t('label.thickness'),
      value: hide.thicknessMm ? `${figure(num(hide.thicknessMm))} mm` : '—',
    },
    { label: t('label.lot'), value: hide.lotCode },
  ]
  return {
    name: t('label.name', { code: hide.code }),
    widthMm: 100,
    heightMm: 50,
    blocks: [
      {
        kind: 'title',
        text: line ? `${line.item.code} · ${line.item.name}` : hide.code,
        size: 'md',
      },
      { kind: 'fields', columns: 3, fields },
      { kind: 'fill' },
      { kind: 'barcode', value: hide.code, heightMm: 9 },
    ],
  }
}

function doneStep(
  model: ReceiveViewModel,
  t: Translate,
  send: Send,
  ui: {
    amount: (value: number, uom: string, decimals?: number) => string
    figure: (value: number, decimals?: number) => string
    place: FormatPlace
    scanField: (label: string, hint: string, extra?: { disabled?: boolean; keepFocus?: boolean }) => ReactNode
    offlineHeld: string | null
  },
): Step {
  const { receipt, notes } = model.posted!
  const jobs = new Map(receipt.tags.jobs.map((job) => [job.hideId, job]))
  const counts = tagCounts(receipt)
  const selected = receipt.hides.find((hide) => hide.id === model.selectedHideId) ?? receipt.hides[0] ?? null
  const selectedState = selected ? tagState(jobs.get(selected.id)) : null
  const busy = model.busy === 'tags' || model.busy === 'retry'
  const printer = receipt.tags.printer
  const reprintHeld = ui.offlineHeld ?? (busy ? t('tags.busy') : !printer ? t('tags.noPrinterShort') : null)
  const actions: FloorActions =
    receipt.hides.length > 0
      ? [
          {
            label: t('action.reprint'),
            icon: <Printer />,
            heldReason: reprintHeld,
            onPress: () => send({ type: 'reprintAsk' }),
          },
          {
            label: t('action.next'),
            icon: <Truck />,
            onPress: () => send({ type: 'next' }),
          },
        ]
      : [
          {
            label: t('action.next'),
            icon: <Truck />,
            onPress: () => send({ type: 'next' }),
          },
        ]
  const ownNotes = notes.filter((note) => NOTE_CODES.has(note.code))
  const lineOf = (seq: number | null) => receipt.lines.find((line) => line.seq === seq)
  const body = (
    <div className="fw-floor-stack">
      <TaskCard
        icon={<PackageCheck />}
        type={t('done.receipt')}
        code={receipt.number}
        status={t('done.posted')}
        statusTone="success"
        big={{
          value: String(receipt.hides.length > 0 ? receipt.hides.length : receipt.lots.length),
          label: receipt.hides.length > 0 ? t('done.hidesLabel', { count: receipt.hides.length }) : t('done.lotsLabel', { count: receipt.lots.length }),
        }}
        facts={[
          {
            label: t('card.order'),
            value: `${receipt.order.number} · ${wordOf(t, 'status', receipt.order.status)}`,
          },
          { label: t('card.supplier'), value: receipt.order.supplier.name },
          {
            label: t('card.ddt'),
            value: receipt.supplierDdtNumber ?? t('card.ddtNone'),
          },
          {
            label: t('done.at'),
            value: formatTime(receipt.receivedAt, ui.place),
          },
        ]}
        flags={
          <p className="fw-receive-ticks">
            <Ticks state="recorded" />
          </p>
        }
      />
      {receipt.hides.length > 0 ? (
        <section className="fw-floor-stack" aria-labelledby="fw-receive-tags">
          <h2 id="fw-receive-tags" className="fw-floor-section-title">
            <span className="fw-floor-inline-icon" aria-hidden="true">
              <Printer />
            </span>
            {printer
              ? t('tags.title', {
                  count: receipt.hides.length,
                  printer: printer.name,
                })
              : t('tags.titleNoPrinter', { count: receipt.hides.length })}
          </h2>
          {!printer ? (
            <TaskLine tone="warning" icon={<CircleAlert />}>
              {t('tags.noPrinter')}
            </TaskLine>
          ) : null}
          {counts.failed > 0 ? (
            <TaskLine tone="danger" icon={<CircleAlert />} alert>
              {t('tags.failed', { count: counts.failed })}
            </TaskLine>
          ) : counts.queued + counts.sent > 0 ? (
            <p className="fw-floor-muted">{t('tags.waiting', { count: counts.queued + counts.sent })}</p>
          ) : counts.printed === receipt.hides.length ? (
            <TaskLine tone="success" icon={<Check />}>
              {t('tags.allPrinted', { count: counts.printed })}
            </TaskLine>
          ) : null}
          {ui.scanField(t('tags.scan.label'), t('tags.scan.hint'))}
          {model.reprintAsk && selected ? (
            <div className="fw-receive-reprint">
              <p className="fw-floor-subtitle">{t('reprint.title', { code: selected.code })}</p>
              <div className="fw-task-reasons" role="group" aria-label={t('reprint.title', { code: selected.code })}>
                {(['DAMAGED', 'LOST', 'OTHER'] as const).map((reason) => (
                  <FloorButton key={reason} size="md" block variant="secondary" heldReason={reprintHeld} onClick={() => send({ type: 'reprint', reason })}>
                    {t(`reprint.reason.${reason}`)}
                  </FloorButton>
                ))}
              </div>
              <div className="fw-receive-chips">
                <FloorButton size="md" variant="secondary" icon={<Printer />} heldReason={reprintHeld} onClick={() => send({ type: 'printAll' })}>
                  {t('reprint.all', { count: receipt.hides.length })}
                </FloorButton>
                <FloorButton size="md" variant="quiet" icon={<X />} onClick={() => send({ type: 'reprintAsk' })}>
                  {t('reprint.cancel')}
                </FloorButton>
              </div>
            </div>
          ) : null}
          <div className="fw-task-split">
            <FloorList label={t('tags.list')}>
              {receipt.hides.map((hide) => {
                const state = tagState(jobs.get(hide.id))
                return (
                  <FloorListRow
                    key={hide.id}
                    icon={<Tag />}
                    tone={TAG_TONE[state]}
                    title={<span className="fw-floor-code">{hide.code}</span>}
                    meta={[hide.lotCode, ui.amount(num(hide.area), hide.areaUom), hide.grade ? t('tags.grade', { grade: hide.grade }) : null].filter(Boolean).join(' · ')}
                    status={t(`tags.state.${state}`)}
                    selected={selected?.id === hide.id}
                    onPress={() => send({ type: 'tag', hideId: hide.id })}
                  />
                )
              })}
            </FloorList>
            {selected ? (
              <div className="fw-receive-label">
                <LabelPreview
                  layout={tagLayout(receipt, selected.id, t, ui.amount, ui.figure)!}
                  scale={3}
                  codeLabel={(value) => t('label.code', { code: value })}
                  invalidCodeLabel={(value) => t('label.invalid', { code: value })}
                  print={
                    selectedState && selectedState !== 'notPrinted'
                      ? {
                          status: PRINT_STATUS[selectedState],
                          label: t(`tags.state.${selectedState}`),
                          detail: selectedState === 'failed' ? (jobs.get(selected.id)?.problem ?? undefined) : undefined,
                        }
                      : undefined
                  }
                  onRetry={selectedState === 'failed' ? () => send({ type: 'retryTag', hideId: selected.id }) : undefined}
                  retryLabel={t('tags.retry')}
                  retryHeldReason={ui.offlineHeld ?? (model.busy === 'retry' ? t('tags.busy') : null)}
                />
                {selectedState === 'notPrinted' ? <p className="fw-floor-muted">{jobs.get(selected.id)?.problem ?? t('tags.state.notPrinted')}</p> : null}
              </div>
            ) : null}
          </div>
          <ListFooter
            count={t('tags.count', {
              printed: counts.printed,
              count: receipt.hides.length,
            })}
            keys={[
              { key: 'Enter', does: t('keys.next') },
              { key: 'Tab', does: t('keys.tab') },
            ]}
          />
        </section>
      ) : null}
      <section className="fw-floor-stack" aria-labelledby="fw-receive-lots">
        <h2 id="fw-receive-lots" className="fw-floor-subtitle">
          {t('done.lots', { count: receipt.lots.length })}
        </h2>
        <ul className="fw-receive-lots">
          {receipt.lots.map((lot) => {
            const held = lot.qualityStatus !== 'RELEASED'
            const line = lineOf(lot.lineSeq)
            return (
              <li key={lot.id}>
                <TaskLine tone={held ? 'warning' : 'success'} icon={held ? <ShieldAlert /> : <Check />}>
                  <strong className="fw-floor-code">{lot.code}</strong> · {line ? line.item.code : t('card.line', { seq: lot.lineSeq })}
                  {lot.hideCount > 0 ? ` · ${t('done.lotHides', { count: lot.hideCount })}` : ''}
                  {' · '}
                  {held
                    ? t('done.lotHeld', {
                        why: lot.holds.map((code) => wordOf(t, 'hold', code)).join(' · ') || t('hold.QUALITY_HOLD'),
                        place: lot.location?.code ?? '—',
                      })
                    : t('done.lotReleased', {
                        place: lot.location?.code ?? '—',
                      })}
                </TaskLine>
              </li>
            )
          })}
        </ul>
      </section>
      {ownNotes.length > 0 ? (
        <section className="fw-floor-stack" aria-labelledby="fw-receive-notes">
          <h2 id="fw-receive-notes" className="fw-floor-subtitle">
            {t('done.notes')}
          </h2>
          {ownNotes.map((note, index) => {
            const line = lineOf(note.seq)
            return (
              <TaskLine
                key={`${note.code}-${note.seq ?? 'r'}-${index}`}
                tone={note.code === 'OVER' || note.code === 'THICKNESS' || note.code === 'ONE_DYE_BATCH' ? 'warning' : 'info'}
                icon={<CircleAlert />}
              >
                {line ? `${line.item.code}: ` : ''}
                {t(`note.${note.code}`)}
              </TaskLine>
            )
          })}
        </section>
      ) : null}
    </div>
  )
  return { body, actions }
}
