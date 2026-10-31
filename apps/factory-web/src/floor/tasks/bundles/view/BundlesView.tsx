'use client'

import type { ReactNode } from 'react'
import { ArrowLeft, Ban, CircleAlert, CircleCheck, CircleDashed, Hash, Layers, Minus, Plus, Printer, RotateCcw, ScanLine, ShieldOff, Split, Tag, Trash2, X } from 'lucide-react'
import { Modal } from '@nexus/ui/components'
import { LabelPreview, type LabelPrintState } from '@nexus/ui/components/LabelPreview/index'
import { FloorActionBar, FloorButton, FloorList, FloorListRow, QuantityPad, ScanInput, qtyHeldReason, type CameraScanner, type FloorAction, type FloorActions } from '@nexus/ui/floor'
import { formatNumber, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Translate } from '../../../../lib/i18n/messages'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import type { TaskProblem } from '../../shared/task-api'
import { HeldLine, ListFooter, ProblemState, TaskCard, TaskLine, Ticks, type TickState } from '../../shared/view/TaskParts'
import { fromFixedReason } from '../../reasons/model'
import { ReasonPickerBody, useDoneHeld, type ReasonPickerModel } from '../../reasons/view/ReasonPicker'
import { MAX_BUNDLE_SIZE, MAX_BUNDLES_PER_TAP, MIN_BUNDLE_SIZE, REPRINT_REASONS, SPLIT_REASONS, splitMax, ticketLayout, VOID_REASONS, type ReprintReason, type SplitReason, type TicketContent, type TicketPrint, type VoidReason } from '../model'
import { TicketQr } from './TicketQr'
import '../bundles.css'

/**
 * SCR-095 — Bundles & tickets (design floor.bundles; MES-065, MES-066, MES-068, MES-073, MES-184): a cutting table makes
 * bundles from what was cut and prints one ticket per bundle, and fixes a ticket that was lost (a new code; the old one
 * says "replaced") or a bundle made by mistake (void, only before any scan). One job per step:
 *
 *   pick      what was cut and waits for bundles (scan the traveller, or a row)
 *   proposal  the proposed bundles per size and colour with the bundle size (a tap on a bundle changes its quantity), the
 *             printer, then "Make N bundles · print N tickets" (one tap); the tickets made here with their two ticks and
 *             their print state (queued, sent, printed, failed with Retry)
 *   bundle    a scanned ticket: its facts, its operations with ticks, Reprint (a reason), Void (a confirm and a reason)
 *             and — W2a, B-W2a-75 (MES-071) — Split: how many garments come off (the pad, at least one stays) and why
 *             (rework, recut, hold: the floor's one reason picker, SCR-091) into a child bundle with its own ticket; the
 *             genealogy stays
 *
 * Making a bundle is saved on this tablet first and works offline (its ticket numbered from the tablet's own block; it
 * prints on the station's printer when the office records it). Reprint, void and split need the network: held with the
 * reason.
 * No money, no person: the floor never sees who made a bundle.
 */

export interface PickRowModel {
  id: string
  number: string
  batchNumber: string | null
  style: string
  toBundle: number
  cells: readonly { label: string; cut: number | null; bundled: number; toBundle: number }[]
}

export interface ProposalCellModel {
  id: string
  /** "NERO 52". */
  label: string
  cut: number | null
  bundled: number
  /** Still to bundle, after what this tablet made and the office has not counted yet. */
  toBundle: number
  /** This tablet's bundles on their way (not counted by the last read). */
  pending: number
  quantities: readonly number[]
}

export type PrinterModel =
  | { kind: 'station'; name: string }
  | { kind: 'site'; name: string }
  | { kind: 'choose'; printers: readonly { id: string; name: string }[]; picked: string | null }
  | { kind: 'none' }

export interface TicketModel {
  key: string
  content: TicketContent
  ticks: TickState
  print: TicketPrint
  /** Refused by the office: its words (Waiting to send has the fix). */
  refusal?: { message: string; fix: string } | null
  retrying?: boolean
}

export interface EditingModel {
  cellId: string
  index: number
  value: number | null
  max: number
}

export interface CardModel {
  id: string
  code: string
  scanned: string
  status: 'ACTIVE' | 'VOID'
  /** REPLACED (an old ticket, with the new code) or VOIDED; null when the code takes the bundle. */
  refusal: { code: string; message: string } | null
  workOrder: { number: string; batchNumber: string | null; style: string }
  colourway: string
  size: string
  part: string | null
  quantity: number
  scans: number
  operations: readonly { seq: number; code: string; name: string; done: boolean }[]
  replacedCodes: readonly string[]
  ticket: TicketContent
  /** The garments still in it when garments were split off (B-W2a-75); null: not read. */
  live?: number | null
}

export type BundleDone =
  | { kind: 'reprinted'; replacedCode: string; ticket: TicketModel }
  | { kind: 'voided'; code: string; quantity: number }
  /** B-W2a-75: garments split off into a child bundle (its ticket), the garments still in the parent. */
  | { kind: 'split'; parentCode: string; quantity: number; reason: SplitReason; live: number; ticket: TicketModel }

/** B-W2a-75: the split step: how many come off (the pad), why; `live` once the work order is read. */
export interface SplitModel {
  quantity: number | null
  reason: SplitReason | null
  live: number | null
  reading?: boolean
}

export type BundlesStep =
  | { kind: 'loading'; code?: string | null }
  | { kind: 'pick'; rows: readonly PickRowModel[]; asOf?: string | null }
  | {
      kind: 'proposal'
      order: { id: string; number: string; batchNumber: string | null; style: string; open: boolean }
      cells: readonly ProposalCellModel[]
      bundleSize: number
      standardBundleSize: number
      singlePiece: boolean
      printer: PrinterModel
      seesJobs: boolean
      editing: EditingModel | null
      tickets: readonly TicketModel[]
      making?: boolean
      asOf?: string | null
    }
  | { kind: 'bundle'; card: CardModel; stage: 'card' | 'reprint' | 'void' | 'split'; reason?: VoidReason | null; busy?: boolean; done?: BundleDone | null; problem?: TaskProblem | null; asOf?: string | null; split?: SplitModel | null }
  | { kind: 'problem'; problem: TaskProblem; code?: string | null }
  | { kind: 'noPermission' }

export interface BundlesViewModel {
  frame: FrameModel
  online: boolean
  step: BundlesStep
  /** BUNDLE ticket numbers left on this tablet, when they run low (said while offline: online it tops up itself). */
  lowNumbers?: number | null
  timeZone?: string
}

export type BundlesAction =
  | { type: 'scan'; code: string }
  | { type: 'open'; workOrderId: string }
  | { type: 'back' }
  | { type: 'home' }
  | { type: 'size'; step: 1 | -1 }
  | { type: 'edit'; cellId: string; index: number }
  | { type: 'pad'; value: number | null }
  | { type: 'padConfirm' }
  | { type: 'padCancel' }
  | { type: 'printer'; printerId: string }
  | { type: 'make' }
  | { type: 'retryPrint'; key: string }
  | { type: 'reprint' }
  | { type: 'reprintReason'; reason: ReprintReason }
  | { type: 'void' }
  | { type: 'voidReason'; reason: VoidReason }
  | { type: 'voidConfirm' }
  | { type: 'split' }
  | { type: 'splitQuantity'; value: number | null }
  | { type: 'splitReason'; reason: SplitReason }
  | { type: 'splitConfirm' }
  | { type: 'cancel' }
  | { type: 'reload' }

export interface BundlesViewProps {
  model: BundlesViewModel
  onAction?: (action: BundlesAction) => void
  onFrame?: (action: FrameAction) => void
  camera?: CameraScanner
}

/** The refusal codes the screen has its own words for (factory-domain production/bundles BUNDLE_REFUSALS). */
export const BUNDLE_REFUSAL_WORDS = ['FLOOR_NOT_READY', 'WORK_ORDER_NOT_OPEN', 'NOT_CUT_FROM_HIDES', 'NOTHING_TO_BUNDLE', 'MORE_THAN_CUT', 'NOT_A_PART', 'SINGLE_PIECE', 'TOO_MANY_BUNDLES', 'VOIDED', 'SCANNED', 'REPLACED', 'SPLIT_TOO_MANY', 'WORK_ORDER_ON_HOLD'] as const

/** The words of a refusal code the screen knows, else null (the API's then). */
export function refusalWords(t: Translate, code: string): { message: string; fix: string | null } | null {
  return (BUNDLE_REFUSAL_WORDS as readonly string[]).includes(code) ? { message: t(`refusal.${code}.message`), fix: t(`refusal.${code}.fix`) } : null
}

export function BundlesView({ model, onAction, onFrame, camera }: BundlesViewProps) {
  const t = useT('floor-bundles')
  const tt = useT('floor-tasks')
  const locale = useLocale()
  const send = (action: BundlesAction) => onAction?.(action)
  const { step } = model
  const time = (value: string) => formatTime(value, { locale, timeZone: model.timeZone })
  const number = (value: number) => formatNumber(value, locale)
  // B-W2a-F6: why garments come off a bundle is asked by the floor's one reason picker (purpose split, the API's three codes).
  const splitStep = step.kind === 'bundle' && step.stage === 'split' ? step : null
  const splitPicker: ReasonPickerModel | null = splitStep
    ? {
        purpose: 'split',
        subject: splitStep.card.code,
        reasons: SPLIT_REASONS.map((reason, index) => fromFixedReason({ list: 'SPLIT', code: reason, label: t(`split.reason.${reason}.label`), hint: t(`split.reason.${reason}.hint`), sortOrder: (index + 1) * 10 })),
        value: splitStep.split?.reason ?? null,
        heldReason: model.online ? null : t('card.held.network'),
      }
    : null
  const splitReasonHeld = useDoneHeld(splitPicker ?? { purpose: 'split', value: null })

  const scanField = (hint: string, disabled = false) => (
    <ScanInput
      label={t('scan.label')}
      hint={hint}
      scannedLabel={(code) => t('scan.read', { code })}
      keyboardLabel={t('scan.type')}
      disabled={disabled}
      camera={camera ? { scanner: camera, startLabel: t('scan.camera.start'), stopLabel: t('scan.camera.stop'), errorLabel: t('scan.camera.error') } : undefined}
      onScan={(code) => send({ type: 'scan', code })}
    />
  )
  const asOfLine = (asOf: string | null | undefined) => (asOf && !model.online ? <p className="fw-floor-muted">{tt('asOf', { time: time(asOf) })}</p> : null)
  const lowLine =
    !model.online && model.lowNumbers !== null && model.lowNumbers !== undefined ? (
      <TaskLine tone="warning" icon={<Hash />}>
        {t('tickets.numbersLow', { count: model.lowNumbers })}
      </TaskLine>
    ) : null

  let body: ReactNode
  let actions: FloorActions | null = null
  const back: FloorAction = { label: tt('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }) }

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
      body = <FloorState tone="warning" icon={<ShieldOff />} title={t('noPermission.title')} text={t('noPermission.body')} alert />
      actions = [{ label: tt('action.home'), icon: <ArrowLeft />, onPress: () => send({ type: 'home' }) }]
      break
    case 'problem':
      body = (
        <div className="fw-floor-stack">
          {scanField(t('scan.hint.pick'))}
          <ProblemState problem={step.problem} code={step.code} words={(code) => refusalWords(t, code)} />
        </div>
      )
      actions = step.problem.kind === 'offline' || step.problem.kind === 'unavailable' ? [back, { label: tt('action.retry'), icon: <RotateCcw />, onPress: () => send({ type: 'reload' }) }] : [back]
      break
    case 'pick':
      body = (
        <div className="fw-floor-stack">
          {scanField(t('scan.hint.pick'))}
          {asOfLine(step.asOf)}
          {step.rows.length === 0 ? (
            <FloorState tone="info" icon={<Layers />} title={t('pick.empty.title')} text={t('pick.empty.body')} />
          ) : (
            <section className="fw-floor-section" aria-labelledby="fw-bundles-pick">
              <h2 id="fw-bundles-pick" className="fw-floor-section-title">
                {t('pick.title')}
              </h2>
              <FloorList label={t('pick.title')}>
                {step.rows.map((row) => (
                  <FloorListRow
                    key={row.id}
                    icon={<Layers />}
                    tone="info"
                    title={
                      <span>
                        <span className="fw-floor-code">{row.number}</span> · {row.style}
                      </span>
                    }
                    meta={row.cells
                      .filter((cell) => cell.toBundle > 0 || cell.bundled > 0)
                      .map((cell) => t('pick.cell', { cell: cell.label, cut: cell.cut === null ? '—' : number(cell.cut), bundled: number(cell.bundled) }))
                      .join(' · ')}
                    count={number(row.toBundle)}
                    countLabel={t('pick.toBundle')}
                    onPress={() => send({ type: 'open', workOrderId: row.id })}
                  />
                ))}
              </FloorList>
              <ListFooter
                count={t('pick.footer', { count: step.rows.length })}
                keys={[
                  { key: 'Tab', does: tt('keys.tab') },
                  { key: 'Enter', does: tt('keys.enter') },
                  { key: 'Esc', does: tt('keys.escape') },
                ]}
              />
            </section>
          )}
        </div>
      )
      actions = null
      break
    case 'proposal': {
      const bundles = step.cells.reduce((sum, cell) => sum + cell.quantities.length, 0)
      const printerHeld = step.printer.kind === 'choose' && step.printer.picked === null ? t('proposal.held.printer') : null
      const held = !step.order.open
        ? t('proposal.held.closed')
        : bundles === 0
          ? t('proposal.held.nothing')
          : bundles > MAX_BUNDLES_PER_TAP
            ? t('proposal.held.tooMany', { count: MAX_BUNDLES_PER_TAP })
            : step.making
              ? t('proposal.held.making')
              : printerHeld
      const editing = step.editing
      const editedCell = editing ? step.cells.find((cell) => cell.id === editing.cellId) : undefined
      body = (
        <div className="fw-floor-stack">
          {scanField(t('scan.hint.proposal'))}
          {asOfLine(step.asOf)}
          {lowLine}
          {!step.order.open ? (
            <TaskLine tone="danger" icon={<Ban />} alert>
              {t('proposal.closed')}
            </TaskLine>
          ) : null}
          <div className="fw-task-split">
            <div className="fw-floor-stack">
              <TaskCard
                id="fw-bundles-order"
                icon={<Layers />}
                type={t('proposal.type')}
                code={step.order.number}
                status={step.order.batchNumber}
                facts={[{ label: t('fact.style'), value: step.order.style }]}
              />
              <section className="fw-floor-section" aria-labelledby="fw-bundles-proposal">
                <div className="fw-task-step-head">
                  <h2 id="fw-bundles-proposal" className="fw-floor-section-title">
                    {t('proposal.title')}
                  </h2>
                </div>
                {step.singlePiece ? (
                  <TaskLine tone="info" icon={<Tag />}>
                    {t('proposal.singlePiece')}
                  </TaskLine>
                ) : (
                  <div className="fw-bundles-size" role="group" aria-label={t('proposal.size.label')}>
                    <span className="fw-bundles-size-text">
                      <span className="fw-floor-step">{t('proposal.size.label')}</span>
                      <span className="fw-bundles-size-value">{number(step.bundleSize)}</span>
                      <span className="fw-floor-muted">{t('proposal.size.standard', { size: number(step.standardBundleSize) })}</span>
                    </span>
                    <span className="fw-bundles-size-buttons">
                      <FloorButton size="md" variant="secondary" icon={<Minus />} aria-label={t('proposal.size.smaller')} heldReason={step.bundleSize <= MIN_BUNDLE_SIZE ? t('proposal.size.min') : null} onClick={() => send({ type: 'size', step: -1 })} />
                      <FloorButton size="md" variant="secondary" icon={<Plus />} aria-label={t('proposal.size.bigger')} heldReason={step.bundleSize >= MAX_BUNDLE_SIZE ? t('proposal.size.max', { size: MAX_BUNDLE_SIZE }) : null} onClick={() => send({ type: 'size', step: 1 })} />
                    </span>
                  </div>
                )}
                <ul className="fw-bundles-cells">
                  {step.cells.map((cell) => (
                    <li key={cell.id} className="fw-bundles-cell" data-editing={editing?.cellId === cell.id || undefined}>
                      <p className="fw-bundles-cell-line">
                        <strong>{cell.quantities.length > 0 ? t('proposal.cell.bundles', { cell: cell.label, count: cell.quantities.length, sizes: cell.quantities.map(number).join(' + ') }) : t('proposal.cell.nothing', { cell: cell.label })}</strong>
                      </p>
                      <p className="fw-floor-muted">
                        {t('proposal.cell.counts', { cut: cell.cut === null ? '—' : number(cell.cut), bundled: number(cell.bundled), toBundle: number(cell.toBundle) })}
                        {cell.pending > 0 ? ` · ${t('proposal.cell.pending', { count: cell.pending })}` : ''}
                      </p>
                      {cell.quantities.length > 0 ? (
                        <div className="fw-bundles-chips" role="group" aria-label={t('proposal.cell.chips', { cell: cell.label })}>
                          {cell.quantities.map((quantity, index) => (
                            <FloorButton
                              key={`${cell.id}-${index}`}
                              size="md"
                              variant={editing?.cellId === cell.id && editing.index === index ? 'primary' : 'secondary'}
                              aria-label={t('proposal.cell.edit', { index: index + 1, cell: cell.label, quantity })}
                              aria-pressed={editing?.cellId === cell.id && editing.index === index}
                              heldReason={step.singlePiece ? t('proposal.singlePieceHeld') : null}
                              onClick={() => send({ type: 'edit', cellId: cell.id, index })}
                            >
                              {number(quantity)}
                            </FloorButton>
                          ))}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
              <PrinterLine printer={step.printer} seesJobs={step.seesJobs} onPick={(printerId) => send({ type: 'printer', printerId })} t={t} />
            </div>
            <div className="fw-floor-stack">
              {editing && editedCell ? (
                <section className="fw-floor-section" aria-label={t('pad.title', { cell: editedCell.label })}>
                  <h2 className="fw-floor-section-title">{t('pad.title', { cell: editedCell.label })}</h2>
                  <QuantityPad
                    label={t('pad.label', { index: editing.index + 1 })}
                    value={editing.value}
                    onChange={(value) => send({ type: 'pad', value })}
                    min={1}
                    max={editing.max}
                    unit={t('pad.unit')}
                    expected={editing.max}
                    expectedLabel={(count) => t('pad.expected', { count })}
                    decrementLabel={t('pad.less')}
                    incrementLabel={t('pad.more')}
                    clearLabel={t('pad.clear')}
                    backLabel={t('pad.back')}
                    emptyLabel={t('pad.empty')}
                    rangeLabel={(min, max) => t('pad.range', { min: min ?? 1, max: max ?? editing.max })}
                    decimalSeparator={locale === 'it' ? ',' : '.'}
                    autoFocus
                  />
                </section>
              ) : (
                <TicketList tickets={step.tickets} online={model.online} t={t} onRetry={(key) => send({ type: 'retryPrint', key })} />
              )}
            </div>
          </div>
        </div>
      )
      if (editing) {
        actions = [
          { label: tt('action.back'), icon: <X />, onPress: () => send({ type: 'padCancel' }) },
          {
            label: t('pad.set'),
            icon: <CircleCheck />,
            onPress: () => send({ type: 'padConfirm' }),
            heldReason: qtyHeldReason(editing.value, { min: 1, max: editing.max }, { emptyLabel: t('pad.empty'), rangeLabel: (min, max) => t('pad.range', { min: min ?? 1, max: max ?? editing.max }) }),
          },
        ]
      } else {
        actions = [
          { label: t('proposal.another'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }) },
          { label: bundles > 0 ? t('proposal.make', { count: bundles }) : t('proposal.makeNone'), icon: <Printer />, onPress: () => send({ type: 'make' }), heldReason: held },
        ]
      }
      break
    }
    case 'bundle': {
      const { card } = step
      const voided = card.status === 'VOID'
      const networkHeld = model.online ? null : t('card.held.network')
      const split = step.stage === 'split' ? (step.split ?? { quantity: null, reason: null, live: null }) : null
      const splitLive = split?.live ?? null
      const splitTop = splitLive === null ? Math.max(0, card.quantity - 1) : splitMax(splitLive)
      const splitHeld = split
        ? (networkHeld ??
          (split.reading ? t('split.held.reading') : splitTop < 1 ? t('split.held.one') : step.busy ? t('busy') : split.quantity === null || split.quantity < 1 || split.quantity > splitTop ? t('split.held.quantity', { max: splitTop }) : splitReasonHeld))
        : null
      body = (
        <div className="fw-floor-stack">
          {step.stage === 'card' ? scanField(t('scan.hint.card')) : null}
          {asOfLine(step.asOf)}
          {step.done?.kind === 'voided' ? (
            <FloorState tone="success" icon={<CircleCheck />} title={t('void.done.title', { code: step.done.code })} text={t('void.done.body', { count: step.done.quantity })} />
          ) : null}
          {step.done?.kind === 'reprinted' ? (
            <TaskLine tone="success" icon={<CircleCheck />}>
              {t('reprint.done', { code: step.done.ticket.content.code ?? '—', old: step.done.replacedCode })}
            </TaskLine>
          ) : null}
          {step.done?.kind === 'split' ? (
            <TaskLine tone="success" icon={<CircleCheck />}>
              {t('split.done', { count: step.done.quantity, code: step.done.ticket.content.code ?? '—', parent: step.done.parentCode, reason: t(`split.reason.${step.done.reason}.label`), live: number(step.done.live) })}
            </TaskLine>
          ) : null}
          {step.problem ? <ProblemState problem={step.problem} words={(code) => refusalWords(t, code)} /> : null}
          {card.refusal?.code === 'REPLACED' ? (
            <TaskLine tone="danger" icon={<CircleAlert />} alert>
              {t('card.replaced', { scanned: card.scanned, code: card.code })}
            </TaskLine>
          ) : null}
          {voided && step.done?.kind !== 'voided' ? (
            <TaskLine tone="danger" icon={<Ban />} alert>
              {t('card.voided')}
            </TaskLine>
          ) : null}
          {!model.online && step.stage === 'card' && !voided ? <HeldLine text={t('card.held.network')} /> : null}
          <div className="fw-task-split">
            <TaskCard
              id="fw-bundles-card"
              icon={<Layers />}
              type={t('card.type')}
              code={card.code}
              status={t(`card.status.${card.status}`)}
              statusTone={voided ? 'danger' : 'success'}
              big={{ value: number(card.quantity), label: card.part ? t('card.piecesOf', { part: card.part }) : t('card.garments') }}
              facts={[
                { label: t('fact.workOrder'), value: card.workOrder.batchNumber ? `${card.workOrder.number} · ${card.workOrder.batchNumber}` : card.workOrder.number },
                { label: t('fact.style'), value: card.workOrder.style },
                { label: t('fact.colour'), value: card.colourway },
                { label: t('fact.size'), value: card.size },
                { label: t('fact.scans'), value: number(card.scans) },
                ...(card.live !== null && card.live !== undefined && card.live < card.quantity ? [{ label: t('fact.live'), value: t('fact.liveValue', { live: number(card.live), quantity: number(card.quantity) }) }] : []),
                ...(card.replacedCodes.length > 0 ? [{ label: t('fact.replaced'), value: card.replacedCodes.join(', ') }] : []),
              ]}
            >
              {card.operations.length > 0 ? (
                <section aria-labelledby="fw-bundles-ops" className="fw-floor-stack">
                  <h2 id="fw-bundles-ops" className="fw-floor-subtitle">
                    {t('card.operations')}
                  </h2>
                  <ul className="fw-bundles-ops">
                    {card.operations.map((operation) => (
                      <li key={operation.seq} className="fw-bundles-op" data-done={operation.done || undefined}>
                        <span className="fw-floor-inline-icon" aria-hidden="true">
                          {operation.done ? <CircleCheck /> : <CircleDashed />}
                        </span>
                        <span className="fw-floor-code">{operation.seq}</span>
                        <span>
                          {operation.code} · {operation.name}
                        </span>
                        <span className="fw-floor-pill" data-tone={operation.done ? 'success' : 'neutral'}>
                          {operation.done ? t('card.op.done') : t('card.op.open')}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {/* Void sits in the card, away from the action bar: rare, final, and only before any scan (W2a: the bar holds Split). */}
              {step.stage === 'card' && !step.done && !voided ? (
                <div className="fw-floor-row-actions">
                  <FloorButton size="md" variant="danger" icon={<Trash2 />} heldReason={networkHeld} onClick={() => send({ type: 'void' })}>
                    {t('card.void')}
                  </FloorButton>
                </div>
              ) : null}
            </TaskCard>
            <div className="fw-floor-stack">
              {step.stage === 'reprint' ? (
                <section className="fw-floor-section" aria-labelledby="fw-bundles-reprint">
                  <h2 id="fw-bundles-reprint" className="fw-floor-section-title">
                    {t('reprint.title')}
                  </h2>
                  <p className="fw-floor-lead">{t('reprint.body')}</p>
                  <div className="fw-task-reasons" role="group" aria-label={t('reprint.title')}>
                    {(Object.keys(REPRINT_REASONS) as ReprintReason[]).map((reason) => (
                      <FloorButton key={reason} size="lg" variant="secondary" block heldReason={step.busy ? t('busy') : networkHeld} onClick={() => send({ type: 'reprintReason', reason })}>
                        {t(`reprint.reason.${reason}`)}
                      </FloorButton>
                    ))}
                  </div>
                  {networkHeld ? <HeldLine text={networkHeld} /> : null}
                </section>
              ) : split ? (
                <section className="fw-floor-section" aria-labelledby="fw-bundles-split">
                  <h2 id="fw-bundles-split" className="fw-floor-section-title">
                    {t('split.title')}
                  </h2>
                  <p className="fw-floor-lead">{splitLive === null ? t('split.bodyReading') : t('split.body', { count: splitLive })}</p>
                  {splitTop < 1 && !split.reading ? (
                    <HeldLine text={t('split.held.one')} />
                  ) : (
                    <QuantityPad
                      label={t('split.pad.label')}
                      value={split.quantity}
                      onChange={(value) => send({ type: 'splitQuantity', value })}
                      min={1}
                      max={Math.max(1, splitTop)}
                      unit={t('pad.unit')}
                      decrementLabel={t('pad.less')}
                      incrementLabel={t('pad.more')}
                      clearLabel={t('pad.clear')}
                      backLabel={t('pad.back')}
                      emptyLabel={t('pad.empty')}
                      rangeLabel={(min, max) => t('pad.range', { min: min ?? 1, max: max ?? splitTop })}
                      decimalSeparator={locale === 'it' ? ',' : '.'}
                      autoFocus
                    />
                  )}
                  {splitPicker ? (
                    <ReasonPickerBody
                      model={splitPicker}
                      onAction={(action) => {
                        if (action.type === 'pick') send({ type: 'splitReason', reason: action.id as SplitReason })
                      }}
                      onBack={() => send({ type: 'cancel' })}
                      timeZone={model.timeZone}
                    />
                  ) : null}
                  <p className="fw-floor-muted">{t('split.genealogy')}</p>
                  {networkHeld ? <HeldLine text={networkHeld} /> : null}
                </section>
              ) : step.done?.kind === 'reprinted' || step.done?.kind === 'split' ? (
                <TicketList tickets={[step.done.ticket]} online={model.online} t={t} onRetry={(key) => send({ type: 'retryPrint', key })} />
              ) : (
                <div className="fw-bundles-label">
                  <LabelPreview layout={ticketLayout(card.ticket, labelWords(t))} scale={3} renderQr={renderQr(t)} codeLabel={codeLabel(t)} invalidCodeLabel={(value) => t('label.invalid', { code: value })} />
                </div>
              )}
            </div>
          </div>
          <Modal open={step.stage === 'void'} onClose={() => send({ type: 'cancel' })} title={t('void.title')} size="sm" className="fw-floor-dialog">
            <div className="fw-floor-dialog-body">
              <p className="fw-floor-dialog-line">
                <strong>{t('void.body', { code: card.code })}</strong>
              </p>
              <p className="fw-floor-dialog-line fw-floor-muted">{t('void.reason.label')}</p>
              <div className="fw-task-reasons" role="group" aria-label={t('void.reason.label')}>
                {(Object.keys(VOID_REASONS) as VoidReason[]).map((reason) => (
                  <FloorButton key={reason} size="md" variant={step.reason === reason ? 'warning' : 'secondary'} aria-pressed={step.reason === reason} block onClick={() => send({ type: 'voidReason', reason })}>
                    {t(`void.reason.${reason}`)}
                  </FloorButton>
                ))}
              </div>
              {networkHeld ? <HeldLine text={networkHeld} /> : null}
              <div className="fw-floor-dialog-actions">
                {/* Enter = Cancel (design bundles.void): the safe action has the focus. */}
                <FloorButton size="lg" variant="secondary" icon={<X />} autoFocus onClick={() => send({ type: 'cancel' })}>
                  {t('void.cancel')}
                </FloorButton>
                <FloorButton
                  size="lg"
                  variant="danger"
                  icon={<Trash2 />}
                  heldReason={networkHeld ?? (step.busy ? t('busy') : step.reason ? null : t('void.reason.needed'))}
                  onClick={() => send({ type: 'voidConfirm' })}
                >
                  {t('void.confirm')}
                </FloorButton>
              </div>
            </div>
          </Modal>
        </div>
      )
      if (step.stage === 'reprint') actions = [{ label: tt('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'cancel' }) }]
      else if (split)
        actions = [
          { label: tt('action.back'), icon: <X />, onPress: () => send({ type: 'cancel' }) },
          { label: split.quantity !== null && split.quantity >= 1 ? t('split.confirm', { count: split.quantity }) : t('split.confirmNone'), icon: <Split />, onPress: () => send({ type: 'splitConfirm' }), heldReason: splitHeld },
        ]
      else if (step.done || voided)
        actions = [back, { label: tt('action.scanAnother'), icon: <ScanLine />, onPress: () => send({ type: 'back' }) }]
      else
        actions = [
          back,
          { label: t('card.split'), icon: <Split />, onPress: () => send({ type: 'split' }), heldReason: networkHeld ?? (card.quantity < 2 ? t('split.held.one') : null) },
          { label: t('card.reprint'), icon: <Printer />, onPress: () => send({ type: 'reprint' }), heldReason: networkHeld },
        ]
      break
    }
  }

  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={actions ? <FloorActionBar label={t('title')} actions={actions} /> : undefined}>
      {body}
    </FloorFrameView>
  )
}

function PrinterLine({ printer, seesJobs, onPick, t }: { printer: PrinterModel; seesJobs: boolean; onPick: (printerId: string) => void; t: Translate }) {
  switch (printer.kind) {
    case 'station':
    case 'site':
      return (
        <TaskLine tone="info" icon={<Printer />}>
          {t(`printer.${printer.kind}`, { name: printer.name })}
          {seesJobs ? null : ` ${t('printer.noView')}`}
        </TaskLine>
      )
    case 'none':
      return (
        <TaskLine tone="warning" icon={<Printer />}>
          {t('printer.none')}
        </TaskLine>
      )
    case 'choose':
      return (
        <section className="fw-floor-section" aria-labelledby="fw-bundles-printer">
          <h2 id="fw-bundles-printer" className="fw-floor-subtitle">
            {t('printer.choose')}
          </h2>
          <div className="fw-floor-row-actions" role="group" aria-labelledby="fw-bundles-printer">
            {printer.printers.map((option) => (
              <FloorButton key={option.id} size="md" variant={printer.picked === option.id ? 'primary' : 'secondary'} aria-pressed={printer.picked === option.id} icon={<Printer />} onClick={() => onPick(option.id)}>
                {option.name}
              </FloorButton>
            ))}
          </div>
        </section>
      )
  }
}

const labelWords = (t: Translate) => ({
  name: (code: string) => t('label.name', { code }),
  workOrder: t('label.workOrder'),
  style: t('label.style'),
  colour: t('label.colour'),
  size: t('label.size'),
  pieces: t('label.pieces'),
  operations: t('label.operations'),
  numbering: t('label.numbering'),
})
const renderQr = (t: Translate) => (value: string) => <TicketQr value={value} label={t('label.qr', { code: value })} />
const codeLabel = (t: Translate) => (value: string, kind: 'barcode' | 'qr') => t(`label.${kind}`, { code: value })

const PRINT_STATUS = { QUEUED: 'queued', SENT: 'sent', PRINTED: 'printed', FAILED: 'failed' } as const

function printState(print: TicketPrint, t: Translate): LabelPrintState | undefined {
  if (print.kind !== 'job') return undefined
  const status = PRINT_STATUS[print.job.status]
  return { status, label: t(`tickets.print.${status}`), detail: print.job.status === 'FAILED' ? (print.job.lastError ?? undefined) : undefined }
}

function TicketList({ tickets, online, t, onRetry }: { tickets: readonly TicketModel[]; online: boolean; t: Translate; onRetry: (key: string) => void }) {
  if (tickets.length === 0) return null
  const waiting = tickets.some((ticket) => ticket.ticks === 'saved' || ticket.ticks === 'sending')
  return (
    <section className="fw-floor-section" aria-labelledby="fw-bundles-tickets">
      <h2 id="fw-bundles-tickets" className="fw-floor-section-title">
        {t('tickets.title', { count: tickets.length })}
      </h2>
      {waiting && !online ? <HeldLine text={t('tickets.offline')} /> : null}
      <ul className="fw-bundles-tickets">
        {tickets.map((ticket) => (
          <li key={ticket.key} className="fw-bundles-ticket">
            <div className="fw-bundles-ticket-head">
              <span className="fw-floor-code fw-bundles-ticket-code">{ticket.content.code ?? t('tickets.codePending')}</span>
              <span className="fw-floor-muted">
                {ticket.content.colourway} {ticket.content.size} · {t('tickets.garments', { count: ticket.content.quantity })}
              </span>
              <Ticks state={ticket.ticks} />
            </div>
            {ticket.refusal ? (
              <TaskLine tone="danger" icon={<CircleAlert />}>
                {ticket.refusal.message} {ticket.refusal.fix}
              </TaskLine>
            ) : (
              <PrintLine print={ticket.print} t={t} />
            )}
            <div className="fw-bundles-label">
              <LabelPreview
                layout={ticketLayout(ticket.content, labelWords(t))}
                scale={3}
                renderQr={renderQr(t)}
                codeLabel={codeLabel(t)}
                invalidCodeLabel={(value) => t('label.invalid', { code: value })}
                print={printState(ticket.print, t)}
                onRetry={ticket.print.kind === 'job' && ticket.print.job.status === 'FAILED' ? () => onRetry(ticket.key) : undefined}
                retryLabel={t('tickets.retry')}
                retryHeldReason={!online ? t('tickets.retryOffline') : ticket.retrying ? t('busy') : null}
              />
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function PrintLine({ print, t }: { print: TicketPrint; t: Translate }) {
  switch (print.kind) {
    case 'job':
      return null
    case 'waiting':
      return <p className="fw-floor-muted">{t('tickets.print.waiting')}</p>
    case 'none':
      return <p className="fw-floor-muted">{t('tickets.print.none')}</p>
    case 'hidden':
      return <p className="fw-floor-muted">{t('tickets.print.hidden')}</p>
    case 'looking':
      return <p className="fw-floor-muted">{t('tickets.print.looking')}</p>
  }
}
