'use client'

import type { ReactNode } from 'react'
import { Check, CircleAlert, CircleSlash, ClipboardList, Package, PackageCheck, Scissors, ScanLine, Undo2, X } from 'lucide-react'
import { FloorActionBar, FloorList, FloorListRow, QuantityPad, ScanInput, qtyHeldReason, type CameraScanner, type FloorAction, type FloorActions } from '@nexus/ui/floor'
import { formatDate, formatNumber, formatTime } from '../../../../lib/i18n/format'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import type { TaskProblem } from '../../shared/task-api'
import { HeldLine, ListFooter, ProblemState, TaskCard, TaskLine, Ticks, UndoStrip } from '../../shared/view/TaskParts'
import { coveredCount, ISSUE_REFUSAL_WORDS, lineName, num, undoStock, type PadBounds, type PickLine, type PickList, type PickWorkOrderRow } from '../model'
import '../issue.css'

/**
 * SCR-093 — Pick & issue on the floor (design floor.pick; SCM-215, SCM-194; A2 SCR-093): for which work order (scan its
 * traveller, or pick one of the site's released work orders), what it needs (per material and colour: the need big,
 * what is issued, a tick when covered; stock that may not be issued, with why), and the scan that IS the action — a hide
 * is issued whole by its scan, a lot or a material asks its quantity on the pad, defaulted to what is still needed (never
 * more than is on hand or still needed: an over-issue is the office's). Undo the last issue in one tap. Issuing needs the
 * network (it is not one of the queue's actions): offline the scan is held and says so, and the last pick list read
 * stays on screen as this tablet's copy, with its time. No money anywhere.
 */

export interface PickPad {
  readonly code: string
  readonly lineKey: string
  readonly value: number | null
  readonly bounds: PadBounds
  readonly uom: string
}

export type PickLast =
  | { readonly kind: 'issued'; readonly code: string; readonly quantity: number; readonly uom: string; readonly workOrder: string }
  | { readonly kind: 'undone'; readonly code: string; readonly quantity: number; readonly uom: string }

export interface PickViewModel {
  frame: FrameModel
  online: boolean
  /** The worker notice holds scans. */
  held?: boolean
  stage: 'choose' | 'list' | 'noPermission'
  /** choose: the site's work orders to pick for; null while they are read. */
  workOrders?: readonly PickWorkOrderRow[] | null
  /** What is on screen is this tablet's copy (no network): when it was read. */
  asOf?: string | null
  /** choose, offline: the tablet has no copy of the list. */
  notOnTablet?: boolean
  list?: PickList | null
  pad?: PickPad | null
  last?: PickLast | null
  /** The code being issued (or undone: `undo`). */
  busy?: string | null
  /** A refusal or a failure, full screen. */
  problem?: { readonly problem: TaskProblem; readonly code: string | null } | null
  /** The site's time zone. */
  timeZone?: string
}

export type PickAction =
  | { type: 'scan'; code: string }
  | { type: 'open'; workOrderId: string }
  | { type: 'material'; lineKey: string }
  | { type: 'pad'; value: number | null }
  | { type: 'issue' }
  | { type: 'cancelPad' }
  | { type: 'undo' }
  | { type: 'done' }
  | { type: 'dismiss' }
  | { type: 'retry' }

export interface PickViewProps {
  model: PickViewModel
  onAction?: (action: PickAction) => void
  onFrame?: (action: FrameAction) => void
  camera?: CameraScanner
}

const KNOWN = new Set<string>(ISSUE_REFUSAL_WORDS)

/** A unit's short name (`unit.FT2` → "ft²"), else its code. */
export function unitWord(t: Translate, uom: string): string {
  const key = `unit.${uom}`
  const word = t(key)
  return word === key ? uom : word
}

/** The words of a refusal the screen knows (`refusal.<CODE>`), else null: the API's own. */
export function refusalWords(t: Translate, code: string): { message: string; fix: string | null } | null {
  return KNOWN.has(code) ? { message: t(`refusal.${code}.message`), fix: t(`refusal.${code}.fix`) } : null
}

export function PickView({ model, onAction, onFrame, camera }: PickViewProps) {
  const t = useT('floor-issue')
  const shared = useT('floor-tasks')
  const floor = useT('floor')
  const locale = useLocale()
  const send = (action: PickAction) => onAction?.(action)
  const place = { locale, timeZone: model.timeZone }
  const amount = (value: number, uom: string) => `${formatNumber(value, locale, { maximumFractionDigits: 2 })} ${unitWord(t, uom)}`
  const statusOf = (status: string) => {
    const key = `status.workOrder.${status}`
    const word = floor(key)
    return word === key ? status : word
  }
  const camProps = camera ? { scanner: camera, startLabel: floor('scan.camera.start'), stopLabel: floor('scan.camera.stop'), errorLabel: floor('scan.camera.error') } : undefined

  let actions: FloorActions | null = null
  let body: ReactNode

  if (model.stage === 'noPermission') {
    body = <FloorState tone="warning" icon={<CircleSlash />} title={t('noPermission.title')} text={t('noPermission.body')} alert />
  } else if (model.problem) {
    const { problem, code } = model.problem
    body = <ProblemState problem={problem} code={code} words={(refusal) => refusalWords(t, refusal)} />
    const scanAnother: FloorAction = { label: shared('action.scanAnother'), icon: <ScanLine />, onPress: () => send({ type: 'dismiss' }) }
    actions = problem.kind === 'unavailable' || problem.kind === 'offline' ? [scanAnother, { label: shared('action.retry'), icon: <Undo2 />, onPress: () => send({ type: 'retry' }) }] : [scanAnother]
  } else if (model.stage === 'choose') {
    body = (
      <div className="fw-floor-stack">
        {!model.online ? <HeldLine text={t('offline.choose')} /> : null}
        <ScanInput
          label={t('choose.scan.label')}
          hint={model.held ? floor('tile.held.notice') : t('choose.scan.hint')}
          scannedLabel={(code) => floor('scan.read', { code })}
          keyboardLabel={floor('scan.type')}
          disabled={Boolean(model.held)}
          camera={camProps}
          onScan={(code) => send({ type: 'scan', code })}
        />
        {model.asOf ? <p className="fw-floor-muted">{shared('asOf', { time: formatTime(model.asOf, place) })}</p> : null}
        {model.notOnTablet ? (
          <FloorState tone="warning" icon={<CircleAlert />} title={shared('notOnTablet.title')} text={shared('notOnTablet.body')} />
        ) : model.workOrders === null || model.workOrders === undefined ? (
          <FloorState tone="info" icon={<ClipboardList />} title={t('choose.loading')} busy />
        ) : model.workOrders.length === 0 ? (
          <FloorState tone="info" icon={<ClipboardList />} title={t('choose.empty.title')} text={t('choose.empty.body')} />
        ) : (
          <section className="fw-floor-stack" aria-labelledby="fw-pick-choose">
            <h2 id="fw-pick-choose" className="fw-floor-subtitle">
              {t('choose.list')}
            </h2>
            <FloorList label={t('choose.list')}>
              {model.workOrders.map((row) => (
                <FloorListRow
                  key={row.id}
                  icon={<ClipboardList />}
                  tone={row.status === 'IN_PROGRESS' ? 'info' : 'neutral'}
                  title={<span className="fw-floor-code">{row.number}</span>}
                  meta={[`${row.style.code} · ${row.style.name}`, row.colourways.join(', '), row.dueDate ? t('choose.due', { date: formatDate(`${row.dueDate}T12:00:00Z`, place) }) : null].filter(Boolean).join(' · ')}
                  status={statusOf(row.status)}
                  count={formatNumber(row.pieces, locale)}
                  countLabel={t('choose.pieces', { count: row.pieces })}
                  onPress={() => send({ type: 'open', workOrderId: row.id })}
                />
              ))}
            </FloorList>
            <ListFooter
              count={t('choose.count', { count: model.workOrders.length })}
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
  } else {
    const list = model.list
    if (!list) {
      body = <FloorState tone="info" icon={<ClipboardList />} title={t('list.loading')} busy />
    } else {
      const { covered, total } = coveredCount(list)
      const undo = undoStock(list)
      const pad = model.pad
      const padLine = pad ? list.lines.find((line) => line.key === pad.lineKey) ?? null : null
      const issuing = Boolean(model.busy)
      const scanHeld = !model.online || !list.workOrder.issuable || Boolean(model.held)
      const offlineHeld = model.online ? null : t('offline.short')
      if (pad && padLine) {
        const words = { emptyLabel: t('pad.empty'), rangeLabel: (min: number | undefined, max: number | undefined) => t('pad.range', { min: formatNumber(min ?? 0, locale), max: formatNumber(max ?? 0, locale) }) }
        const held = pad.bounds.covered ? t('pad.covered') : (offlineHeld ?? (issuing ? t('busy', { code: pad.code }) : qtyHeldReason(pad.value, pad.bounds, words)))
        actions = [
          { label: t('action.cancel'), icon: <X />, onPress: () => send({ type: 'cancelPad' }) },
          {
            label: pad.value !== null && !pad.bounds.covered ? t('action.issue', { quantity: amount(pad.value, pad.uom) }) : t('action.issueNothing'),
            icon: <PackageCheck />,
            heldReason: held,
            onPress: () => send({ type: 'issue' }),
          },
        ]
      } else {
        actions = [{ label: t('action.done'), icon: <Check />, onPress: () => send({ type: 'done' }) }]
      }
      body = (
        <div className="fw-floor-stack">
          {!model.online ? <HeldLine text={t('offline.held')} /> : null}
          {model.asOf ? <p className="fw-floor-muted">{shared('asOf', { time: formatTime(model.asOf, place) })}</p> : null}
          <TaskCard
            icon={<ClipboardList />}
            type={t('list.workOrder')}
            code={list.workOrder.number}
            status={statusOf(list.workOrder.status)}
            statusTone={list.workOrder.issuable ? (list.workOrder.status === 'IN_PROGRESS' ? 'info' : 'success') : 'danger'}
            big={{ value: `${covered}/${total}`, label: t('list.coveredLabel') }}
            facts={[
              { label: t('list.fact.style'), value: `${list.workOrder.style.code} · ${list.workOrder.style.name}` },
              { label: t('list.fact.batch'), value: list.workOrder.batchNumber ?? '—' },
              { label: t('list.fact.due'), value: list.workOrder.dueDate ? formatDate(`${list.workOrder.dueDate}T12:00:00Z`, place) : '—' },
            ]}
            flags={!list.workOrder.issuable ? <TaskLine tone="danger" icon={<CircleAlert />}>{t('list.notOpen', { status: statusOf(list.workOrder.status) })}</TaskLine> : null}
          />
          {model.last?.kind === 'issued' ? (
            <div className="fw-pick-result" role="status">
              <TaskLine tone="success" icon={<PackageCheck />}>
                {t('last.issued', { code: model.last.code, quantity: amount(model.last.quantity, model.last.uom), workOrder: model.last.workOrder })}
              </TaskLine>
              <Ticks state="recorded" />
            </div>
          ) : model.last?.kind === 'undone' ? (
            <TaskLine tone="info" icon={<Undo2 />}>
              {t('last.undone', { code: model.last.code, quantity: amount(model.last.quantity, model.last.uom) })}
            </TaskLine>
          ) : null}
          {undo && !pad ? (
            <UndoStrip
              text={t('undo.text', { code: undo.code, quantity: amount(undo.quantity, undo.line?.baseUom ?? '') })}
              ticks="recorded"
              onUndo={() => send({ type: 'undo' })}
              undoHeld={offlineHeld ?? (model.busy === 'undo' ? t('busyUndo') : null)}
            />
          ) : null}
          {pad && padLine ? (
            <section className="fw-pick-pad" aria-labelledby="fw-pick-pad-title">
              <h2 id="fw-pick-pad-title" className="fw-floor-section-title">
                <span className="fw-floor-inline-icon" aria-hidden="true">
                  <Package />
                </span>
                {t('pad.title', { code: pad.code })}
              </h2>
              <p className="fw-floor-muted">{lineName(padLine)}</p>
              {pad.bounds.covered ? (
                <TaskLine tone="warning" icon={<CircleAlert />}>
                  {t('pad.covered')}
                </TaskLine>
              ) : (
                <QuantityPad
                  label={t('pad.label')}
                  value={pad.value}
                  onChange={(value) => send({ type: 'pad', value })}
                  unit={unitWord(t, pad.uom)}
                  min={pad.bounds.min}
                  max={pad.bounds.max}
                  decimals={pad.bounds.decimals}
                  expected={pad.bounds.suggested}
                  expectedLabel={(expected) => t('pad.expected', { quantity: formatNumber(expected, locale, { maximumFractionDigits: 2 }) })}
                  quickValues={[{ value: pad.bounds.suggested, label: t('pad.all') }]}
                  decimalSeparator={locale === 'it' ? ',' : '.'}
                  separatorLabel={t('pad.separator')}
                  decrementLabel={t('pad.minus')}
                  incrementLabel={t('pad.plus')}
                  clearLabel={t('pad.clear')}
                  backLabel={t('pad.back')}
                  emptyLabel={t('pad.empty')}
                  rangeLabel={(min, max) => t('pad.range', { min: formatNumber(min ?? 0, locale), max: formatNumber(max ?? 0, locale) })}
                  message={num(padLine.toIssue) > pad.bounds.max ? t('pad.onHandOnly', { quantity: amount(pad.bounds.max, pad.uom) }) : undefined}
                  messageTone="info"
                  autoFocus
                />
              )}
            </section>
          ) : (
            <ScanInput
              label={t('list.scan.label')}
              hint={model.held ? floor('tile.held.notice') : !model.online ? t('offline.short') : !list.workOrder.issuable ? t('list.notOpenShort') : issuing ? t('busy', { code: model.busy ?? '' }) : t('list.scan.hint')}
              scannedLabel={(code) => floor('scan.read', { code })}
              keyboardLabel={floor('scan.type')}
              disabled={scanHeld || issuing}
              camera={camProps}
              onScan={(code) => send({ type: 'scan', code })}
            />
          )}
          <section className="fw-floor-stack" aria-labelledby="fw-pick-need">
            <h2 id="fw-pick-need" className="fw-floor-subtitle">
              {t('list.title')}
            </h2>
            {list.lines.length === 0 ? (
              <FloorState tone="info" icon={<ClipboardList />} title={t('list.empty.title')} text={t('list.empty.body')} />
            ) : (
              <>
                <FloorList label={t('list.title')}>
                  {list.lines.map((line) => (
                    <LineRow key={line.key} line={line} t={t} amount={amount} figure={(value) => formatNumber(value, locale, { maximumFractionDigits: 2 })} selected={pad?.lineKey === line.key} onMaterial={!scanHeld && !issuing && !pad && line.tracking === 'NONE' && !line.covered && num(line.usable.onHand) > 0 ? () => send({ type: 'material', lineKey: line.key }) : undefined} />
                  ))}
                </FloorList>
                <ListFooter
                  count={t('list.count', { covered, total })}
                  keys={[
                    { key: 'Enter', does: pad ? t('keys.issue') : t('keys.done') },
                    { key: '0–9', does: t('keys.digits') },
                    { key: 'Esc', does: shared('keys.escape') },
                  ]}
                />
              </>
            )}
          </section>
          <HeldStock list={list} t={t} amount={amount} />
        </div>
      )
    }
  }

  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={actions ? <FloorActionBar label={t('title')} actions={actions} /> : undefined}>
      {body}
    </FloorFrameView>
  )
}

function LineRow({ line, t, amount, figure, selected, onMaterial }: { line: PickLine; t: Translate; amount: (value: number, uom: string) => string; figure: (value: number) => string; selected: boolean; onMaterial?: () => void }) {
  const next = line.usable.candidates[0]
  const toIssue = num(line.toIssue)
  const usable = num(line.usable.onHand)
  const meta = [
    t('line.issued', { issued: amount(num(line.issued), line.baseUom), planned: amount(num(line.planned), line.baseUom) }),
    !line.covered && next ? t('line.next', { code: next.hideCode ?? next.lotCode ?? line.itemCode, location: next.locationCode }) : null,
    !line.covered && line.tracking === 'NONE' && usable > 0 ? t('line.tapMaterial') : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <FloorListRow
      icon={line.covered ? <Check /> : line.tracking === 'HIDE' ? <Scissors /> : <Package />}
      tone={line.covered ? 'success' : usable <= 0 ? 'warning' : 'neutral'}
      title={lineName(line)}
      meta={meta}
      status={line.covered ? t('line.covered') : usable <= 0 ? t('line.noStock') : t('line.toIssue', { quantity: amount(toIssue, line.baseUom) })}
      count={figure(num(line.planned))}
      countLabel={t('line.need', { unit: unitWord(t, line.baseUom) })}
      selected={selected}
      onPress={onMaterial}
    />
  )
}

function HeldStock({ list, t, amount }: { list: PickList; t: Translate; amount: (value: number, uom: string) => string }) {
  const rows = list.lines.flatMap((line) => line.held.map((held) => ({ line, held })))
  if (rows.length === 0) return null
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-pick-held">
      <h2 id="fw-pick-held" className="fw-floor-subtitle">
        {t('held.title')}
      </h2>
      {rows.map(({ line, held }) => {
        const reasonKey = `held.reason.${held.reason}`
        const reason = t(reasonKey) === reasonKey ? held.reason : t(reasonKey)
        return (
          <TaskLine key={`${line.key}-${held.lotCode}`} tone="warning" icon={<CircleSlash />}>
            {t('held.row', { lot: held.lotCode, item: lineName(line), reason, quantity: amount(num(held.onHand), line.baseUom) })}
            {held.hides > 0 ? ` · ${t('held.hides', { count: held.hides })}` : ''}
          </TaskLine>
        )
      })}
    </section>
  )
}
