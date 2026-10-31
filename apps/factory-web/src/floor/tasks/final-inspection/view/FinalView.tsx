'use client'

import type { ReactNode } from 'react'
import { ArrowLeft, Ban, Check as CheckIcon, CircleAlert, CircleCheck, CircleMinus, ClipboardCheck, House, Lock, PackageCheck, Pencil, Printer, RotateCcw, ScanLine, ShieldAlert, ShieldCheck, Tag, UserRoundX, X } from 'lucide-react'
import { Modal } from '@nexus/ui/components'
import { LABEL_PRINT_TONE } from '@nexus/ui/components/LabelPreview/index'
import { FloorActionBar, FloorButton, FloorList, FloorListRow, QuantityPad, ScanInput, type CameraScanner, type FloorAction, type FloorActions, type FloorTone } from '@nexus/ui/floor'
import { formatDate, formatDateTime, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Translate } from '../../../../lib/i18n/messages'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import type { TaskProblem } from '../../shared/task-api'
import { HeldLine, ListFooter, PinSign, ProblemState, ReasonGrid, TaskCard, TaskLine, type PinProblem } from '../../shared/view/TaskParts'
import type { PickerList } from '../../reasons/model'
import { ReasonPickerBody, useDoneHeld, type ReasonPickerModel } from '../../reasons/view/ReasonPicker'
import { assigneeKey, CHECKLIST_GROUPS, groupsDone, groupState, itemsOf, openOf, reasonsOf, type Answer, type BenchAssignee, type Check, type ChecklistGroup, type HoldHeld, type Plan, type PlanField, type ReleaseHeld } from '../model'
import '../final.css'

/**
 * SCR-097 — final inspection and release at the inspection bench (design floor.final; QHS-050, QHS-051, QHS-058, PLT-097;
 * Owner answers Q1 (a): an inspector who made none of the garments releases alone, F1: the PIN signs). One step at a time:
 * the work order (scan its traveller, or pick it from what the site has finished), its gate per colour and size (every
 * release check in words, the maker check, the four-eyes rule), the sampling plan the inspector states, the checklist in
 * four groups (one tap per group after looking; a failed check asks what is wrong), the result signed with the PIN, then
 * the release per colour and size (the PIN again when the window has passed) and the garment labels when they are what
 * holds it. Inspections and releases need the network (their numbers come from the office at once): offline every write
 * waits, with the reason, and the last work order read stays on screen with its time. No money, never another person.
 *
 * W2a (B-W2a-75; design floor.final sec "release": "Hold lot (secondary): a reason, and an NCR"; pop "final.hold"): Hold lot
 * is the secondary action of the work order, the checklist and the release — a reason tile of the tenant's HOLD list (the
 * floor's one reason picker, SCR-091; "Other" asks a written note: held on the floor, quality places it), then ONE call
 * holds the work order's garments and raises the nonconformance that decides it ("Packing is blocked until quality
 * decides"). The work order's holds stay on its screen (why, since when, the NCR); quality releases them in the office,
 * never the worker who held them. Online only.
 */

export interface BenchRowModel {
  id: string
  number: string
  batchNumber: string | null
  style: string
  dueDate: string | null
  pieces: number
  finished: number | null
  released: number
  open: boolean
  /** B-W2b-17: who its open inspection is assigned to (never another worker's name), by when it is due. */
  assigned?: BenchAssignee | null
  inspectionDueAt?: string | null
  overdue?: boolean
}

export interface CellModel {
  id: string
  /** "BLK 50" (colour and size are codes, never translated). */
  label: string
  pieces: number
  released: number
  releasable: number
  labelsPrinted: number
  checks: Check[]
  /** Why a second person releases it (empty: the inspector releases alone). */
  secondPerson: string[]
  /** Release is held for this person (null: it can run). */
  held: ReleaseHeld
  /** The LABELS check holds it and this person may print them here. */
  printLabels: boolean
}

export interface OrderModel {
  id: string
  number: string
  batchNumber: string | null
  style: string
  status: string
  finished: number | null
  released: number
  made: boolean
  rule: 'WHEN_REQUIRED' | 'ALWAYS'
  customerListed: boolean
  documents: string[]
  cells: CellModel[]
  inspections: { label: string; status: string }[]
  /** The OPEN inspection, and whether it is this person's. */
  open: { label: string; yours: boolean } | null
  /** The work order's main action for this person. */
  main: 'continue' | 'start' | 'release' | 'othersOpen' | 'maker' | null
  /** B-W2a-75: its ACTIVE quality holds, oldest first: why (the screen's language), since when, the NCR deciding it. */
  holds: HoldLineModel[]
  /** What holds Hold lot for this person (null: it may run). */
  holdHeld: HoldHeld
}

export interface HoldLineModel {
  id: string
  reason: string
  since: string
  ncr: string | null
}

/** B-W2a-75: the Hold lot dialog (pop "final.hold"): the reason tiles, the pick, the call on its way or refused. */
export interface HoldDialogModel {
  /** The work order held ("WO-… · batch"), what the picker says it is about. */
  subject: string
  /** The tenant's HOLD reasons for the floor's one reason picker (B-W2a-F6): read, being read, failed, offline. */
  reasons: PickerList
  picked: string | null
  busy?: boolean
  problem?: TaskProblem | null
  /** The garments held (the NCR's quantity). */
  quantity: number
}

export interface InspectionModel {
  id: string
  label: string
  plan: Plan
  checklist: Answer[]
  defects: { code: string; quantity: number }[]
  result: 'PASS' | 'FAIL'
  /** Where the site records stations only, the signer ticks "I did not make these goods". */
  statementNeeded: boolean
}

export interface JobModel {
  id: string
  status: 'QUEUED' | 'SENT' | 'PRINTED' | 'FAILED'
  copies: number
  detail: string | null
}

export type FinalStep =
  | { kind: 'loading'; code?: string | null }
  | { kind: 'pick'; rows: BenchRowModel[]; scanned?: { code: string; why: 'notFound' | 'notReady'; status?: string } | null }
  | { kind: 'gate'; order: OrderModel }
  | { kind: 'plan'; order: OrderModel; plan: Plan; field: PlanField | null; maxLot: number }
  | { kind: 'checklist'; order: OrderModel; inspection: InspectionModel; group: ChecklistGroup; failing: string | null }
  | { kind: 'sign'; order: OrderModel; inspection: InspectionModel; result: 'PASS' | 'FAIL'; statement: boolean }
  | { kind: 'release'; order: OrderModel; cell: CellModel; quantity: number; signing: boolean; refused: Check[] }
  | { kind: 'labels'; order: OrderModel; cell: CellModel; jobs: JobModel[]; refused: string | null }
  | { kind: 'done'; order: OrderModel; cell: string; quantity: number; releaseNumber: string | null; secondPerson: boolean }
  | { kind: 'problem'; problem: TaskProblem; code?: string | null }
  | { kind: 'noPermission' }

export interface FinalViewModel {
  frame: FrameModel
  online: boolean
  /** The person's rights here: record an inspection, release garments, print garment labels. */
  can: { record: boolean; release: boolean; labels: boolean }
  step: FinalStep
  /** Shown from what the tablet read before (offline): when. */
  asOf?: string | null
  /** A call is on its way. */
  busy?: boolean
  /** The PIN pad's state while signing. */
  pin?: PinProblem
  /** A refused write, said on the step (not a full screen): the screen's words for it. */
  notice?: TaskProblem | null
  timeZone?: string
  /** B-W2a-75: the Hold lot dialog, open. */
  hold?: HoldDialogModel | null
  /** B-W2a-75: the lot was just held here: its reason and NCR. */
  held?: { reason: string; ncr: string } | null
}

export type FinalAction =
  | { type: 'scan'; code: string }
  | { type: 'open'; id: string }
  | { type: 'back' }
  | { type: 'home' }
  | { type: 'retry' }
  | { type: 'start' }
  | { type: 'plan-field'; field: PlanField | null }
  | { type: 'plan-value'; field: PlanField; value: number }
  | { type: 'open-inspection' }
  | { type: 'group'; group: ChecklistGroup }
  | { type: 'pass-group' }
  | { type: 'pass-item'; code: string }
  | { type: 'fail-item'; code: string | null }
  | { type: 'fail-reason'; reason: string }
  | { type: 'sign' }
  | { type: 'statement'; value: boolean }
  | { type: 'pin'; pin: string }
  | { type: 'hold'; open: boolean }
  | { type: 'hold-reason'; reason: string }
  | { type: 'hold-reasons-retry' }
  | { type: 'hold-confirm' }
  | { type: 'release'; cellId: string }
  | { type: 'release-quantity'; value: number | null }
  | { type: 'release-confirm' }
  | { type: 'labels'; cellId: string }
  | { type: 'print' }
  | { type: 'retry-job'; jobId: string }
  | { type: 'next' }

export interface FinalViewProps {
  model: FinalViewModel
  onAction?: (action: FinalAction) => void
  onFrame?: (action: FrameAction) => void
  camera?: CameraScanner
}

const GROUP_ICON: Readonly<Record<ChecklistGroup, ReactNode>> = { LABELS: <Tag />, GARMENT: <ClipboardCheck />, ARMOUR: <ShieldCheck />, PACKAGING: <PackageCheck /> }

const actions = (list: (FloorAction | null | false)[]): FloorActions => list.filter((entry): entry is FloorAction => Boolean(entry)).slice(-3) as unknown as FloorActions

/** A check's words: its name in the screen's words, the API's sentence, the fix in the screen's words (else the API's). */
function CheckLine({ check, t }: { check: Check; t: Translate }) {
  const icon = check.state === 'OK' ? <CircleCheck /> : check.state === 'OPEN' ? <CircleAlert /> : <CircleMinus />
  const tone = check.state === 'OK' ? 'success' : check.state === 'OPEN' ? 'danger' : 'info'
  return (
    <li className="fw-final-check" data-state={check.state}>
      <span className="fw-floor-inline-icon" data-tone={tone} aria-hidden="true">
        {icon}
      </span>
      <span className="fw-final-check-text">
        <strong>
          {t(`check.${check.code}`)} · {t(`checkState.${check.state}`)}
        </strong>
        <span>{check.message}</span>
        {check.state === 'OPEN' ? <span className="fw-final-check-fix">{t(`fix.${check.code}`)}</span> : null}
      </span>
    </li>
  )
}

function OrderStrip({ order, t, extra }: { order: OrderModel; t: Translate; extra?: string | null }) {
  const open = order.cells.reduce((sum, cell) => sum + openOf(cell.checks).length, 0)
  const parts = [order.number, order.batchNumber ? t('strip.batch', { batch: order.batchNumber }) : null, open > 0 ? t('strip.checksOpen', { count: open }) : t('strip.checksOk'), extra].filter(Boolean)
  return (
    <p className="fw-final-strip" role="status">
      <span className="fw-floor-inline-icon" aria-hidden="true">
        <ClipboardCheck />
      </span>
      <span>{parts.join(' · ')}</span>
    </p>
  )
}

export function FinalView({ model, onAction, onFrame, camera }: FinalViewProps) {
  const t = useT('floor-final')
  const tt = useT('floor-tasks')
  const locale = useLocale()
  const send = (action: FinalAction) => onAction?.(action)
  const { step } = model
  const offlineHeld = model.online ? null : t('offline.held')
  const back: FloorAction = { label: tt('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }), variant: 'secondary' }
  const time = (value: string) => formatTime(value, { locale, timeZone: model.timeZone })

  let body: ReactNode = null
  let bar: FloorActions | null = null

  const asOf = model.asOf ? <TaskLine tone="info" icon={<CircleMinus />}>{tt('asOf', { time: time(model.asOf) })}</TaskLine> : null
  /** B-W2a-75: Hold lot, the secondary action (held with the reason: no right, on hold already, no network). */
  const holdOf = (order: OrderModel): FloorAction => ({ label: t('hold.action'), icon: <Ban />, variant: 'danger', onPress: () => send({ type: 'hold', open: true }), heldReason: order.holdHeld ? t(`hold.held.${order.holdHeld}`) : model.busy ? t('busy') : null })
  const dialog = model.hold
  const holdPicker: ReasonPickerModel | null = dialog ? { purpose: 'hold', subject: dialog.subject, reasons: dialog.reasons.reasons, state: dialog.reasons.state, asOf: dialog.reasons.asOf, value: dialog.picked } : null
  const holdReasonHeld = useDoneHeld(holdPicker ?? { purpose: 'hold', value: null })
  const dialogHeld = dialog ? (offlineHeld ?? (dialog.busy ? t('busy') : holdReasonHeld)) : null
  const notice = model.notice ? <NoticeLine problem={model.notice} t={t} tt={tt} /> : null

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
      bar = [{ label: tt('action.home'), icon: <House />, onPress: () => send({ type: 'home' }) }]
      break

    case 'problem':
      body = <ProblemState problem={step.problem} code={step.code ?? null} words={(code) => refusalWords(t, code)} />
      bar = [back, { label: tt('action.retry'), icon: <RotateCcw />, onPress: () => send({ type: 'retry' }) }]
      break

    case 'pick': {
      body = (
        <>
          <ScanInput
            label={t('pick.scan')}
            hint={t('pick.hint')}
            scannedLabel={(code) => t('pick.read', { code })}
            keyboardLabel={t('pick.type')}
            camera={camera ? { scanner: camera, startLabel: t('pick.camera.start'), stopLabel: t('pick.camera.stop'), errorLabel: t('pick.camera.error') } : undefined}
            onScan={(code) => send({ type: 'scan', code })}
          />
          {step.scanned ? (
            <TaskLine tone="danger" icon={<CircleAlert />} alert>
              {step.scanned.why === 'notFound' ? t('pick.notFound', { code: step.scanned.code }) : t('pick.notReady', { code: step.scanned.code, status: statusWord(t, step.scanned.status ?? '') })}
            </TaskLine>
          ) : null}
          {step.rows.length === 0 ? (
            <FloorState tone="info" icon={<ShieldCheck />} title={t('pick.empty.title')} text={t('pick.empty.body')} />
          ) : (
            <section className="fw-floor-stack" aria-labelledby="fw-final-rows">
              <h2 id="fw-final-rows" className="fw-floor-subtitle">
                {t('pick.title')}
              </h2>
              <FloorList label={t('pick.title')}>
                {step.rows.map((row) => (
                  <FloorListRow
                    key={row.id}
                    icon={<ClipboardCheck />}
                    tone={row.overdue ? 'warning' : row.open ? 'info' : 'neutral'}
                    title={<span className="fw-floor-code">{row.number}</span>}
                    meta={[
                      row.style,
                      row.batchNumber ? t('strip.batch', { batch: row.batchNumber }) : null,
                      row.dueDate ? t('pick.due', { date: formatDate(`${row.dueDate}T12:00:00Z`, { locale, timeZone: model.timeZone }) }) : null,
                      // B-W2b-17: who the open inspection is for, and by when (words, not colour alone).
                      row.assigned ? t(assigneeKey(row.assigned).key, assigneeKey(row.assigned).params) : null,
                      row.inspectionDueAt ? t(row.overdue ? 'pick.inspectionOverdue' : 'pick.inspectionDue', { time: formatDateTime(row.inspectionDueAt, { locale, timeZone: model.timeZone }) }) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    status={row.overdue ? t('pick.overdue') : row.open ? t('pick.open') : t('pick.ready')}
                    count={Math.max(0, (row.finished ?? 0) - row.released)}
                    countLabel={t('pick.toRelease')}
                    onPress={() => send({ type: 'open', id: row.id })}
                  />
                ))}
              </FloorList>
              <ListFooter
                count={t('pick.count', { count: step.rows.length })}
                keys={[
                  { key: 'Tab', does: tt('keys.tab') },
                  { key: 'Enter', does: tt('keys.enter') },
                  { key: 'Esc', does: tt('keys.escape') },
                ]}
              />
            </section>
          )}
        </>
      )
      bar = [{ label: tt('action.home'), icon: <House />, onPress: () => send({ type: 'home' }) }]
      break
    }

    case 'gate': {
      const { order } = step
      const mainLabel: Record<NonNullable<OrderModel['main']>, string> = {
        continue: t('gate.continue'),
        start: t('gate.start'),
        release: t('gate.toRelease'),
        othersOpen: t('gate.start'),
        maker: t('gate.start'),
      }
      const heldOf = (main: OrderModel['main']): string | null => {
        if (main === 'othersOpen') return t('gate.held.othersOpen')
        if (main === 'maker') return t('maker.made')
        if (main === null) return model.can.record ? t('gate.held.nothing') : t('role.record')
        if (!model.online && main !== 'release') return t('offline.held')
        return null
      }
      body = (
        <>
          <OrderStrip order={order} t={t} />
          {model.held ? (
            <TaskLine tone="success" icon={<Ban />}>
              {t('hold.done', { reason: model.held.reason, ncr: model.held.ncr })}
            </TaskLine>
          ) : null}
          <HoldLines order={order} t={t} time={time} />
          <OrderCard order={order} t={t} />
          {order.made ? (
            <TaskLine tone="danger" icon={<UserRoundX />}>
              {t('maker.made')}
            </TaskLine>
          ) : (
            <TaskLine tone="success" icon={<CircleCheck />}>
              {t('maker.ok')}
            </TaskLine>
          )}
          <TaskLine tone="info" icon={<ShieldCheck />}>
            {order.customerListed ? t('rule.customer') : t(`rule.${order.rule}`)}
          </TaskLine>
          {order.documents.map((words) => (
            <TaskLine key={words} tone="warning" icon={<ShieldAlert />}>
              {words}
            </TaskLine>
          ))}
          <section className="fw-floor-stack" aria-labelledby="fw-final-cells">
            <h2 id="fw-final-cells" className="fw-floor-subtitle">
              {t('gate.cells')}
            </h2>
            {order.cells.map((cell) => (
              <CellCard key={cell.id} cell={cell} t={t} send={send} online={model.online} />
            ))}
          </section>
        </>
      )
      const main = order.main
      const holdAction = holdOf(order)
      bar = actions([
        back,
        holdAction,
        main === 'release' ? null : { label: main ? mainLabel[main] : t('gate.start'), icon: <ClipboardCheck />, onPress: () => send({ type: 'start' }), heldReason: heldOf(main) },
      ])
      if (main === 'release') bar = actions([back, holdAction, { label: t('gate.toRelease'), icon: <PackageCheck />, onPress: () => send({ type: 'start' }), heldReason: model.online ? null : order.holds.length > 0 ? t('hold.releaseWaits') : null }])
      break
    }

    case 'plan': {
      const { plan } = step
      const fields: { field: PlanField; value: number; words: string }[] = [
        // Every garment of the lot is checked (the AQL sample is W2b): the lot's row says so.
        { field: 'lotSize', value: plan.lotSize, words: t('plan.hundred', { count: plan.lotSize }) },
        { field: 'acceptMajor', value: plan.acceptMajor, words: t('plan.acceptMajor', { count: plan.acceptMajor }) },
        { field: 'acceptMinor', value: plan.acceptMinor, words: t('plan.acceptMinor', { count: plan.acceptMinor }) },
      ]
      body = (
        <>
          <OrderStrip order={step.order} t={t} />
          <section className="fw-floor-stack" aria-labelledby="fw-final-plan">
            <h2 id="fw-final-plan" className="fw-floor-section-title">
              {t('plan.title')}
            </h2>
            <p className="fw-floor-lead">{t('plan.lead')}</p>
            <div className="fw-final-plan">
              {fields.map((entry) => (
                <FloorButton key={entry.field} size="lg" variant={step.field === entry.field ? 'primary' : 'secondary'} icon={<Pencil />} aria-pressed={step.field === entry.field} onClick={() => send({ type: 'plan-field', field: step.field === entry.field ? null : entry.field })}>
                  {entry.words}
                </FloorButton>
              ))}
            </div>
            {step.field ? (
              <QuantityPad
                label={t(`plan.field.${step.field}`)}
                value={fields.find((entry) => entry.field === step.field)!.value}
                onChange={(value) => (value === null ? undefined : send({ type: 'plan-value', field: step.field!, value }))}
                min={step.field === 'lotSize' ? 1 : 0}
                max={step.field === 'lotSize' ? step.maxLot : plan.sampleSize}
                {...padWords(t)}
                onConfirm={() => send({ type: 'plan-field', field: null })}
                confirmLabel={t('plan.done')}
                autoFocus
              />
            ) : null}
          </section>
          {offlineHeld ? <HeldLine text={offlineHeld} /> : null}
        </>
      )
      bar = actions([back, { label: t('plan.open'), icon: <ClipboardCheck />, onPress: () => send({ type: 'open-inspection' }), heldReason: offlineHeld ?? (model.busy ? t('busy') : null) }])
      break
    }

    case 'checklist': {
      const { inspection, group } = step
      const done = groupsDone(inspection.checklist)
      const complete = done === CHECKLIST_GROUPS.length
      const state = groupState(inspection.checklist, group)
      const unanswered = itemsOf(group).some((code) => !inspection.checklist.some((answer) => answer.code === code))
      const held = offlineHeld ?? (model.busy ? t('busy') : null)
      body = (
        <>
          <OrderStrip order={step.order} t={t} extra={t('strip.groups', { done, total: CHECKLIST_GROUPS.length })} />
          <div className="fw-final-groups" role="group" aria-label={t('checklist.groups')}>
            {CHECKLIST_GROUPS.map((entry) => {
              const groupDone = groupState(inspection.checklist, entry)
              return (
                <FloorButton
                  key={entry}
                  size="md"
                  variant={entry === group ? 'primary' : groupDone === 'failed' ? 'danger' : groupDone === 'passed' ? 'success' : 'secondary'}
                  icon={groupDone === 'passed' ? <CheckIcon /> : groupDone === 'failed' ? <X /> : GROUP_ICON[entry]}
                  aria-pressed={entry === group}
                  onClick={() => send({ type: 'group', group: entry })}
                >
                  {t(`group.${entry}`)}
                </FloorButton>
              )
            })}
          </div>
          <section className="fw-floor-stack" aria-labelledby="fw-final-group">
            <h2 id="fw-final-group" className="fw-floor-section-title">
              <span className="fw-floor-inline-icon" aria-hidden="true">
                {GROUP_ICON[group]}
              </span>
              {t(`group.${group}`)} · {t(`groupState.${state}`)}
            </h2>
            {step.failing ? (
              <>
                <p className="fw-floor-lead">{t('checklist.whatIsWrong', { check: t(`item.${step.failing}`) })}</p>
                <ReasonGrid label={t('checklist.reasons')} reasons={reasonsOf(group).map((reason) => ({ code: reason.code, label: t(`reason.${reason.code}`) }))} onPick={(reason) => send({ type: 'fail-reason', reason })} heldReason={held} />
              </>
            ) : (
              <ul className="fw-final-items">
                {itemsOf(group).map((code) => {
                  const answer = inspection.checklist.find((entry) => entry.code === code)
                  return (
                    <li key={code} className="fw-final-item" data-ok={answer ? String(answer.ok) : 'none'}>
                      <span className="fw-final-item-text">
                        <strong>{t(`item.${code}`)}</strong>
                        {answer?.ok === false && answer.note ? <span className="fw-final-check-fix">{answer.note}</span> : null}
                      </span>
                      <span className="fw-final-item-actions">
                        <FloorButton size="md" variant={answer?.ok === true ? 'success' : 'secondary'} icon={<CheckIcon />} aria-pressed={answer?.ok === true} heldReason={held} onClick={() => send({ type: 'pass-item', code })}>
                          {t('checklist.pass')}
                        </FloorButton>
                        <FloorButton size="md" variant={answer?.ok === false ? 'danger' : 'secondary'} icon={<X />} aria-pressed={answer?.ok === false} heldReason={held} onClick={() => send({ type: 'fail-item', code })}>
                          {t('checklist.fail')}
                        </FloorButton>
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
          <ResultLine inspection={inspection} t={t} />
          {offlineHeld ? <HeldLine text={offlineHeld} /> : null}
        </>
      )
      bar = actions([
        step.failing ? { ...back, label: t('checklist.cancelFail'), onPress: () => send({ type: 'fail-item', code: null }) } : back,
        holdOf(step.order),
        complete && !unanswered
          ? { label: t('checklist.sign', { result: t(`result.${inspection.result}`) }), icon: <Lock />, onPress: () => send({ type: 'sign' }), heldReason: held }
          : { label: t('checklist.groupPasses'), icon: <CheckIcon />, onPress: () => send({ type: 'pass-group' }), heldReason: held ?? (unanswered ? null : t('checklist.groupAnswered')) },
      ])
      break
    }

    case 'sign': {
      const { inspection } = step
      const passed = inspection.checklist.filter((answer) => answer.ok === true).length
      const needsTick = inspection.statementNeeded && !step.statement
      body = (
        <>
          <OrderStrip order={step.order} t={t} />
          {inspection.statementNeeded ? (
            <FloorButton size="lg" block variant={step.statement ? 'success' : 'secondary'} icon={step.statement ? <CheckIcon /> : <CircleMinus />} aria-pressed={step.statement} onClick={() => send({ type: 'statement', value: !step.statement })}>
              {t('sign.statement')}
            </FloorButton>
          ) : null}
          {offlineHeld ? <HeldLine text={offlineHeld} /> : null}
          {needsTick ? (
            <TaskLine tone="warning" icon={<CircleAlert />}>
              {t('sign.tickFirst')}
            </TaskLine>
          ) : (
            <PinSign
              title={t('sign.title', { result: t(`result.${step.result}`) })}
              meaning={step.result === 'PASS' ? t('sign.meaningPass') : t('sign.meaningFail')}
              summary={
                <ul className="fw-final-summary">
                  <li>{inspection.label}</li>
                  <li>{t('sign.plan', { lot: inspection.plan.lotSize, sample: inspection.plan.sampleSize })}</li>
                  <li>{t('sign.checks', { passed, total: inspection.checklist.length })}</li>
                  <li>{inspection.defects.length > 0 ? t('sign.defects', { count: inspection.defects.reduce((sum, line) => sum + line.quantity, 0) }) : t('sign.noDefects')}</li>
                </ul>
              }
              onPin={(pin) => send({ type: 'pin', pin })}
              busy={model.busy}
              problem={model.online ? (model.pin ?? null) : 'offline'}
            />
          )}
          {notice}
        </>
      )
      bar = [back]
      break
    }

    case 'release': {
      const { cell } = step
      body = (
        <>
          <OrderStrip order={step.order} t={t} />
          <TaskCard
            icon={<PackageCheck />}
            type={t('release.cell')}
            code={cell.label}
            big={{ value: String(cell.releasable), label: t('release.canRelease') }}
            facts={[
              { label: t('fact.pieces'), value: String(cell.pieces) },
              { label: t('fact.released'), value: String(cell.released) },
              { label: t('fact.labels'), value: String(cell.labelsPrinted) },
            ]}
          />
          <HoldLines order={step.order} t={t} time={time} />
          {cell.secondPerson.length > 0 ? (
            <TaskLine tone="info" icon={<ShieldCheck />}>
              {t('release.secondPerson', { why: cell.secondPerson.map((reason) => t(`secondPerson.${reason}`)).join('; ') })}
            </TaskLine>
          ) : null}
          {cell.printLabels ? (
            <div className="fw-floor-row-actions">
              <FloorButton size="md" variant="secondary" icon={<Printer />} heldReason={offlineHeld} onClick={() => send({ type: 'labels', cellId: cell.id })}>
                {t('labels.action')}
              </FloorButton>
            </div>
          ) : null}
          {step.refused.length > 0 ? (
            <section className="fw-floor-stack" aria-labelledby="fw-final-refused" role="alert">
              <h2 id="fw-final-refused" className="fw-floor-subtitle">
                {t('release.refused')}
              </h2>
              <ul className="fw-final-checks">
                {step.refused.map((check) => (
                  <CheckLine key={check.code} check={check} t={t} />
                ))}
              </ul>
            </section>
          ) : null}
          {offlineHeld ? <HeldLine text={offlineHeld} /> : null}
          {step.signing ? (
            <PinSign
              title={t('release.signTitle', { count: step.quantity, cell: cell.label })}
              meaning={t('release.meaning')}
              onPin={(pin) => send({ type: 'pin', pin })}
              busy={model.busy}
              problem={model.online ? (model.pin ?? null) : 'offline'}
            />
          ) : (
            <QuantityPad
              label={t('release.quantity')}
              value={step.quantity}
              onChange={(value) => send({ type: 'release-quantity', value })}
              min={1}
              max={Math.max(1, cell.releasable)}
              expected={cell.releasable}
              expectedLabel={(count) => t('release.expected', { count })}
              {...padWords(t)}
            />
          )}
          {notice}
        </>
      )
      bar = actions([
        back,
        step.signing ? null : holdOf(step.order),
        step.signing
          ? null
          : { label: t('release.confirm', { count: step.quantity }), icon: <PackageCheck />, onPress: () => send({ type: 'release-confirm' }), heldReason: offlineHeld ?? (model.busy ? t('busy') : cell.held && cell.held !== 'offline' ? t(`held.${cell.held}`) : null) },
      ])
      break
    }

    case 'labels': {
      const { cell } = step
      body = (
        <>
          <OrderStrip order={step.order} t={t} />
          <TaskCard icon={<Tag />} type={t('labels.title')} code={cell.label} facts={[{ label: t('fact.labels'), value: String(cell.labelsPrinted) }, { label: t('fact.released'), value: String(cell.released) }]} />
          {step.refused ? (
            <TaskLine tone="danger" icon={<CircleAlert />} alert>
              {step.refused}
            </TaskLine>
          ) : null}
          {step.jobs.length > 0 ? (
            <>
              <FloorList label={t('labels.jobs')}>
                {step.jobs.map((job) => (
                  <FloorListRow key={job.id} icon={<Printer />} tone={JOB_TONE[job.status]} title={t('labels.copies', { count: job.copies })} meta={job.detail ?? undefined} status={t(`job.${job.status}`)} />
                ))}
              </FloorList>
              {step.jobs
                .filter((job) => job.status === 'FAILED')
                .map((job) => (
                  <div key={job.id} className="fw-final-job">
                    <FloorButton size="lg" variant="primary" icon={<RotateCcw />} heldReason={offlineHeld} onClick={() => send({ type: 'retry-job', jobId: job.id })}>
                      {t('labels.retry', { count: job.copies })}
                    </FloorButton>
                  </div>
                ))}
            </>
          ) : (
            <p className="fw-floor-lead">{t('labels.lead', { count: Math.max(0, cell.released + 1 - cell.labelsPrinted) })}</p>
          )}
          {offlineHeld ? <HeldLine text={offlineHeld} /> : null}
          {notice}
        </>
      )
      bar = actions([back, step.jobs.length === 0 ? { label: t('labels.print'), icon: <Printer />, onPress: () => send({ type: 'print' }), heldReason: offlineHeld ?? (model.busy ? t('busy') : null) } : { label: t('labels.done'), icon: <CheckIcon />, onPress: () => send({ type: 'back' }) }])
      break
    }

    case 'done':
      body = (
        <FloorState tone="success" icon={<CircleCheck />} title={t('done.title', { batch: step.order.batchNumber ?? step.order.number, count: step.quantity })} text={t('done.body')}>
          <p className="fw-floor-card-code">{step.releaseNumber ? t('done.number', { number: step.releaseNumber, cell: step.cell }) : step.cell}</p>
          {step.secondPerson ? <p className="fw-floor-state-text">{t('done.secondPerson')}</p> : null}
        </FloorState>
      )
      bar = [
        { label: t('done.back'), icon: <ArrowLeft />, variant: 'secondary', onPress: () => send({ type: 'back' }) },
        { label: t('done.next'), icon: <ScanLine />, onPress: () => send({ type: 'next' }) },
      ]
      break
  }

  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={bar ? <FloorActionBar label={t('bar')} actions={bar} /> : undefined}>
      <div className="fw-floor-stack">
        {asOf}
        {body}
        {step.kind !== 'sign' && step.kind !== 'release' && step.kind !== 'labels' ? notice : null}
      </div>
      <Modal
        open={Boolean(dialog)}
        onClose={() => send({ type: 'hold', open: false })}
        title={t('hold.title')}
        size="lg"
        className="fw-floor-dialog"
        footer={
          dialog ? (
            <div className="fw-floor-dialog-actions">
              {/* Enter = Cancel (design final.hold): the safe action has the focus. */}
              <FloorButton size="lg" variant="secondary" icon={<X />} autoFocus onClick={() => send({ type: 'hold', open: false })}>
                {t('hold.cancel')}
              </FloorButton>
              <FloorButton size="lg" variant="danger" icon={<Ban />} heldReason={dialogHeld} onClick={() => send({ type: 'hold-confirm' })}>
                {t('hold.confirm')}
              </FloorButton>
            </div>
          ) : undefined
        }
      >
        {dialog ? (
          <div className="fw-floor-dialog-body">
            <p className="fw-floor-dialog-line">
              <strong>{t('hold.body')}</strong>
            </p>
            <p className="fw-floor-dialog-line fw-floor-muted">{t('hold.ncr', { count: dialog.quantity })}</p>
            {holdPicker ? (
              <ReasonPickerBody
                model={holdPicker}
                onAction={(action) => {
                  if (action.type === 'pick') send({ type: 'hold-reason', reason: action.id })
                  else if (action.type === 'retry') send({ type: 'hold-reasons-retry' })
                }}
                timeZone={model.timeZone}
              />
            ) : null}
            {dialog.problem ? <NoticeLine problem={dialog.problem} t={t} tt={tt} /> : null}
            {offlineHeld ? <HeldLine text={offlineHeld} /> : null}
          </div>
        ) : null}
      </Modal>
    </FloorFrameView>
  )
}

/** A print job's tone, as the DS label preview paints its print state (always with its icon and word). */
const JOB_TONE: Readonly<Record<JobModel['status'], FloorTone>> = {
  QUEUED: LABEL_PRINT_TONE.queued,
  SENT: LABEL_PRINT_TONE.sent,
  PRINTED: LABEL_PRINT_TONE.printed,
  FAILED: LABEL_PRINT_TONE.failed,
}

function OrderCard({ order, t }: { order: OrderModel; t: Translate }) {
  return (
    <TaskCard
      icon={<ClipboardCheck />}
      type={t('fact.workOrder')}
      code={order.number}
      status={statusWord(t, order.status)}
      statusTone={order.status === 'IN_PROGRESS' || order.status === 'COMPLETED' ? 'info' : 'neutral'}
      big={{ value: String(Math.max(0, (order.finished ?? 0) - order.released)), label: t('fact.toRelease') }}
      facts={[
        { label: t('fact.style'), value: order.style },
        { label: t('fact.batch'), value: order.batchNumber ?? '—' },
        { label: t('fact.finished'), value: order.finished === null ? '—' : String(order.finished) },
        { label: t('fact.released'), value: String(order.released) },
        { label: t('fact.inspections'), value: order.inspections.length > 0 ? order.inspections.map((entry) => `${entry.label} · ${t(`inspectionStatus.${entry.status}`)}`).join(', ') : t('fact.none') },
      ]}
    />
  )
}

function CellCard({ cell, t, send, online }: { cell: CellModel; t: Translate; send: (action: FinalAction) => void; online: boolean }) {
  const open = openOf(cell.checks)
  const ok = cell.checks.length - open.length
  return (
    <section className="fw-floor-card fw-final-cell" aria-labelledby={`fw-final-cell-${cell.id}`}>
      <header className="fw-floor-card-head">
        <span className="fw-floor-card-title">
          <span className="fw-floor-card-type">{t('release.cell')}</span>
          <span id={`fw-final-cell-${cell.id}`} className="fw-floor-card-code">
            {cell.label}
          </span>
        </span>
        <span className="fw-floor-pill" data-tone={open.length === 0 ? 'success' : 'danger'}>
          {open.length === 0 ? t('cell.ready') : t('cell.open', { count: open.length })}
        </span>
      </header>
      <p className="fw-floor-muted">{t('cell.counts', { pieces: cell.pieces, released: cell.released, releasable: cell.releasable })}</p>
      {open.length > 0 ? (
        <ul className="fw-final-checks">
          {open.map((check) => (
            <CheckLine key={check.code} check={check} t={t} />
          ))}
        </ul>
      ) : null}
      <p className="fw-floor-muted">{t('cell.checksOk', { count: ok })}</p>
      <div className="fw-floor-row-actions fw-final-cell-actions">
        {cell.printLabels ? (
          <FloorButton size="md" variant="secondary" icon={<Printer />} heldReason={online ? null : t('offline.held')} onClick={() => send({ type: 'labels', cellId: cell.id })}>
            {t('labels.action')}
          </FloorButton>
        ) : null}
        <FloorButton size="md" variant="primary" icon={<PackageCheck />} heldReason={cell.held ? t(`held.${cell.held}`) : null} onClick={() => send({ type: 'release', cellId: cell.id })}>
          {t('cell.release')}
        </FloorButton>
      </div>
    </section>
  )
}

/** B-W2a-75: the work order's holds — why, since when, the NCR deciding it — and what waits for quality. */
function HoldLines({ order, t, time }: { order: OrderModel; t: Translate; time: (value: string) => string }) {
  if (order.holds.length === 0) return null
  return (
    <>
      {order.holds.map((hold) => (
        <TaskLine key={hold.id} tone="danger" icon={<Ban />} alert>
          {hold.ncr ? t('hold.line', { reason: hold.reason, since: time(hold.since), ncr: hold.ncr }) : t('hold.lineNoNcr', { reason: hold.reason, since: time(hold.since) })}
        </TaskLine>
      ))}
    </>
  )
}

function ResultLine({ inspection, t }: { inspection: InspectionModel; t: Translate }) {
  const failed = inspection.checklist.filter((answer) => answer.ok === false).length
  const defects = inspection.defects.reduce((sum, line) => sum + line.quantity, 0)
  return inspection.result === 'PASS' ? (
    <TaskLine tone="success" icon={<CircleCheck />}>
      {t('checklist.resultPass')}
    </TaskLine>
  ) : (
    <TaskLine tone="danger" icon={<CircleAlert />}>
      {t('checklist.resultFail', { failed, defects })}
    </TaskLine>
  )
}

function NoticeLine({ problem, t, tt }: { problem: TaskProblem; t: Translate; tt: Translate }) {
  if (problem.kind === 'forbidden' && problem.path === 'maker') {
    return (
      <TaskLine tone="danger" icon={<UserRoundX />} alert>
        {t('maker.made')}
      </TaskLine>
    )
  }
  if (problem.kind === 'refused') {
    const own = refusalWords(t, problem.code)
    return (
      <TaskLine tone="danger" icon={<CircleAlert />} alert>
        {own ? `${own.message} ${own.fix ?? ''}` : `${problem.message} ${problem.fix ?? ''}`}
      </TaskLine>
    )
  }
  const kind = problem.kind === 'stepUp' ? 'forbidden' : problem.kind
  return (
    <TaskLine tone={kind === 'offline' || kind === 'unavailable' ? 'warning' : 'danger'} icon={<CircleAlert />} alert>
      {`${tt(`problem.${kind}.title`)}: ${tt(`problem.${kind}.body`)}`}
    </TaskLine>
  )
}

/** The screen's words for a release check's code (a 409 `checks/<CODE>`), else null (the API's words show). */
function refusalWords(t: Translate, code: string): { message: string; fix: string | null } | null {
  const message = t(`check.${code}`)
  if (message === `check.${code}`) return null
  return { message: t('refusedCheck', { check: message }), fix: t(`fix.${code}`) }
}

/** A work order status word, else the value as sent. */
function statusWord(t: Translate, status: string): string {
  const key = `workOrderStatus.${status}`
  const word = t(key)
  return word === key ? status : word
}

function padWords(t: Translate) {
  return {
    decrementLabel: t('pad.minus'),
    incrementLabel: t('pad.plus'),
    clearLabel: t('pad.clear'),
    backLabel: t('pad.back'),
    emptyLabel: t('pad.empty'),
    rangeLabel: (min: number | undefined, max: number | undefined) => t('pad.range', { min: min ?? 0, max: max ?? 0 }),
  }
}
