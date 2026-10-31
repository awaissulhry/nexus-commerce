'use client'

import type { ReactNode } from 'react'
import {
  ArrowLeft,
  Boxes,
  Check,
  CheckCheck,
  CircleAlert,
  CircleSlash,
  ClipboardList,
  Factory,
  FileText,
  Layers,
  Package,
  PackageCheck,
  PackageOpen,
  PackagePlus,
  Printer,
  RotateCcw,
  ScanLine,
  ShoppingBag,
  Trash2,
  Truck,
  Undo2,
  Warehouse,
  X,
} from 'lucide-react'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { FloorActionBar, FloorButton, FloorList, FloorListRow, FloorTile, FloorTileGrid, QuantityPad, ScanInput, type CameraScanner, type FloorAction, type FloorActions, type FloorTone } from '@nexus/ui/floor'
import { ReasonGrid, type ReasonTile } from '@nexus/ui/floor/ReasonGrid/index'
import { REASON_KIT_NAMESPACE, useReasonWords } from '../../../../lib/ds-words/reason-grid'
import { formatDate, formatNumber, type FormatPlace } from '../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../lib/pdf/labels'
import { WithMessages } from '../../../../record-panels/i18n'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import type { TaskProblem } from '../../shared/task-api'
import { HeldLine, ListFooter, ProblemState, TaskCard, TaskLine } from '../../shared/view/TaskParts'
import { listOffers, type PickerList } from '../../reasons/model'
import { ReasonPickerBody, useDoneHeld, type ReasonPickerModel } from '../../reasons/view/ReasonPicker'
import type { KitMode, KitOrder, KitRow, TransportBy } from '../api'
import {
  APPEARANCES,
  backBefore,
  backHeld,
  backTotals,
  bundlesOut,
  bundlesToSend,
  ddtHeld,
  entryTotal,
  kitHeld,
  materialAtWorkshop,
  missingOf,
  outOf,
  plannedLines,
  type Appearance,
  type BackDraft,
  type DdtDraft,
  type KitDraft,
  type KitsStage,
  type RejectKind,
} from '../model'
import '../kits.css'

/**
 * SCR-181 — Subcontract kits on the floor (design floor.kits; SCM-140, SCM-142, SCM-145): two tiles, Send a kit · Receive
 * back. Send: scan the subcontract order (or tap one the site has to send), the kit list from the BOM (each line from the
 * place that holds it) and the cut bundles with ticks — scan each bundle or material; a kit not complete is held with the
 * count in words — then the DDT's facts (who carries, parcels, weight, appearance) and Send · print DDT: the stock moves to
 * the workshop's place and stays ours, the DDT for work on our behalf (conto lavorazione) opens full screen with Print.
 * Receive back: scan each bundle (no tap: its garments still out come back good); tap a bundle to reject garments or say
 * the workshop scrapped them, with the reason (the floor's one reason picker over the REWORK list, SCR-091); unused
 * material and offcuts by quantity; Finish receipt. Never a fee, a price or a value. The send and the receipt are online
 * only (the office's numbers); entries stay on screen offline.
 */

export interface KitsViewModel {
  frame: FrameModel
  online: boolean
  held?: boolean
  stage: KitsStage
  /** The person's permissions here: send kits, receive goods back. */
  may: { readonly send: boolean; readonly receive: boolean }
  mode?: KitMode | null
  /** pick: the site's orders for the mode; null while read. */
  orders?: readonly KitRow[] | null
  order?: KitOrder | null
  kit?: KitDraft | null
  ddt?: DdtDraft | null
  /** sent: the DDT and its PDF's bytes (null while read; 'missing' when it was not stored; 'failed' when it could not be read). */
  sent?: { readonly number: string; readonly pdf: Uint8Array | 'loading' | 'missing' | 'failed' } | null
  back?: BackDraft | null
  /** back: the bundle whose rejection is being entered, with the panel's draft. */
  reject?: { readonly bundleId: string; readonly kind: RejectKind; readonly count: number | null; readonly reason: string | null } | null
  /** back: the material line whose return is being entered. */
  material?: { readonly lineId: string; readonly quantity: number | null; readonly toLocationId: string | null } | null
  /** The reasons a rejected bundle may carry, for the floor's one reason picker (the REWORK list; null: not read yet). */
  reasons?: PickerList | null
  received?: { readonly good: number; readonly defective: number; readonly scrapped: number; readonly returned: number } | null
  busy?: 'read' | 'send' | 'receive' | null
  problem?: { readonly problem: TaskProblem; readonly code: string | null } | null
  timeZone?: string
}

export type KitsAction =
  | { type: 'mode'; mode: KitMode }
  | { type: 'modes' }
  | { type: 'scan'; code: string }
  | { type: 'open'; orderId: string }
  | { type: 'line'; lineId: string }
  | { type: 'bundle'; bundleId: string }
  | { type: 'toDdt' }
  | { type: 'toKit' }
  | { type: 'transport'; by: TransportBy }
  | { type: 'packages'; value: number | null }
  | { type: 'weight'; value: number | null }
  | { type: 'appearance'; appearance: Appearance }
  | { type: 'send' }
  | { type: 'print' }
  | { type: 'openReject'; bundleId: string }
  | { type: 'rejectKind'; kind: RejectKind }
  | { type: 'rejectCount'; value: number | null }
  | { type: 'rejectReason'; reason: string }
  | { type: 'rejectReasonsRetry' }
  | { type: 'confirmReject' }
  | { type: 'dropBundle'; bundleId: string }
  | { type: 'openMaterial'; lineId: string }
  | { type: 'materialQuantity'; value: number | null }
  | { type: 'materialPlace'; locationId: string }
  | { type: 'confirmMaterial' }
  | { type: 'closePanel' }
  | { type: 'clearDdt' }
  | { type: 'receive' }
  | { type: 'next' }
  | { type: 'dismiss' }
  | { type: 'retry' }

export interface KitsViewProps {
  model: KitsViewModel
  onAction?: (action: KitsAction) => void
  onFrame?: (action: FrameAction) => void
  camera?: CameraScanner
}

const NAMESPACES = ['floor', 'floor-tasks', 'floor-kits', 'shell', REASON_KIT_NAMESPACE] as const
const OWN_REFUSALS = new Set(['NOT_FOUND', 'NOT_SENDING', 'NOT_RECEIVING', 'NOT_IN_KIT', 'SENT_BEFORE', 'NOT_OUT', 'ALL_BACK', 'CHANGED', 'BADGE'])

export function refusalWords(t: Translate, code: string): { message: string; fix: string | null } | null {
  return OWN_REFUSALS.has(code) ? { message: t(`refusal.${code}.message`), fix: t(`refusal.${code}.fix`) } : null
}

const APPEARANCE_ICON: Record<Appearance, ReactNode> = { BOXES: <Package />, BAGS: <ShoppingBag />, PALLET: <Boxes />, LOOSE: <Layers /> }

export function KitsView(props: KitsViewProps) {
  return (
    <WithMessages namespaces={NAMESPACES}>
      <Kits {...props} />
    </WithMessages>
  )
}

function Kits({ model, onAction, onFrame, camera }: KitsViewProps) {
  const t = useT('floor-kits')
  const shared = useT('floor-tasks')
  const floor = useT('floor')
  const shell = useT('shell')
  const locale = useLocale()
  const reasonWords = useReasonWords()
  const intl = INTL_LOCALE[locale]
  const send = (action: KitsAction) => onAction?.(action)
  // B-W2a-F6: why garments came back rejected is asked by the floor's one reason picker (purpose reject, the REWORK list).
  const rejecting = model.stage === 'back' && model.reject ? model.reject : null
  const rejectBundle = rejecting ? (model.order?.bundles.find((entry) => entry.id === rejecting.bundleId) ?? null) : null
  const rejectPicker: ReasonPickerModel | null =
    rejecting && rejectBundle
      ? { purpose: 'reject', subject: `${rejectBundle.code} · ${t(`reject.${rejecting.kind}`)}`, reasons: model.reasons?.reasons ?? [], state: model.reasons?.state ?? 'loading', asOf: model.reasons?.asOf ?? null, value: rejecting.reason }
      : null
  const rejectReasonHeld = useDoneHeld(rejectPicker ?? { purpose: 'reject', value: null })
  /** The reasons are on screen and not empty: a rejection asks one (else it goes without, as the office has none to offer). */
  const reasonsOffered = listOffers(model.reasons)
  const place: FormatPlace = { locale, timeZone: model.timeZone }
  const day = (value: string | null) => (value ? formatDate(`${value}T12:00:00Z`, place) : '—')
  const figure = (value: string | number) => formatNumber(Number(value), locale, { maximumFractionDigits: 3 })
  const unit = (uom: string) => {
    const word = t(`unit.${uom}`)
    return word === `unit.${uom}` ? uom : word
  }
  const offlineHeld = model.online ? null : t('offline.short')
  const camProps = camera ? { scanner: camera, startLabel: floor('scan.camera.start'), stopLabel: floor('scan.camera.stop'), errorLabel: floor('scan.camera.error') } : undefined
  const scanField = (label: string, hint: string, disabled = false) => (
    <ScanInput
      label={label}
      keepFocus
      hint={model.held ? floor('tile.held.notice') : hint}
      scannedLabel={(code) => floor('scan.read', { code })}
      keyboardLabel={floor('scan.type')}
      disabled={Boolean(model.held) || disabled}
      camera={camProps}
      onScan={(code) => send({ type: 'scan', code })}
    />
  )
  const padWords = {
    decrementLabel: t('pad.less'),
    incrementLabel: t('pad.more'),
    clearLabel: t('pad.clear'),
    backLabel: t('pad.back'),
    emptyLabel: t('pad.empty'),
    decimalSeparator: locale === 'it' ? ',' : '.',
    separatorLabel: t('pad.separator'),
    rangeLabel: (min: number | undefined, max: number | undefined) => t('pad.range', { min: min ?? 0, max: max ?? 0 }),
  }

  const order = model.order ?? null
  const orderCard = (big?: { value: string; label: string } | null) =>
    order ? (
      <TaskCard
        icon={<Factory />}
        type={t('card.type')}
        code={order.number}
        status={t(`status.${order.status}`)}
        statusTone={order.late ? 'warning' : 'info'}
        big={big ?? null}
        facts={[
          { label: t('card.workshop'), value: order.workshop.name || order.workshop.code },
          { label: t('card.workOrder'), value: `${order.workOrder.number} · ${order.workOrder.style.code} ${order.workOrder.style.name}`.trim() },
          { label: t('card.backBy'), value: order.expectedBackDate ? `${day(order.expectedBackDate)}${order.late ? ` · ${t('card.late')}` : ''}` : '—' },
          { label: t('card.place'), value: order.location.code },
        ]}
      />
    ) : null

  let actions: FloorActions | null = null
  let body: ReactNode

  if (model.stage === 'noPermission') {
    body = <FloorState tone="warning" icon={<CircleSlash />} title={t('noPermission.title')} text={t('noPermission.body')} alert />
  } else if (model.problem) {
    const { problem, code } = model.problem
    body = <ProblemState problem={problem} code={code} words={(refusal) => refusalWords(t, refusal)} />
    const back: FloorAction = { label: order ? t('action.back') : shared('action.scanAnother'), icon: order ? <ArrowLeft /> : <ScanLine />, onPress: () => send({ type: 'dismiss' }) }
    actions = problem.kind === 'unavailable' || problem.kind === 'offline' ? [back, { label: shared('action.retry'), icon: <RotateCcw />, onPress: () => send({ type: 'retry' }) }] : [back]
  } else if (model.stage === 'mode') {
    body = (
      <div className="fw-floor-stack">
        <h2 className="fw-floor-section-title">{t('mode.question')}</h2>
        <FloorTileGrid label={t('mode.question')} columns={2}>
          <FloorTile icon={<PackagePlus />} label={t('mode.send')} hint={t('mode.sendHint')} tone="primary" heldReason={model.may.send ? null : t('mode.sendHeld')} onPress={() => send({ type: 'mode', mode: 'send' })} />
          <FloorTile icon={<PackageCheck />} label={t('mode.receive')} hint={t('mode.receiveHint')} tone="info" heldReason={model.may.receive ? null : t('mode.receiveHeld')} onPress={() => send({ type: 'mode', mode: 'receive' })} />
        </FloorTileGrid>
      </div>
    )
  } else if (model.stage === 'pick' || !order) {
    const mode = model.mode ?? 'send'
    const orders = model.orders
    body = (
      <div className="fw-floor-stack">
        {!model.online ? <HeldLine text={t('offline.scan')} /> : null}
        {scanField(t('pick.label'), t(mode === 'send' ? 'pick.hintSend' : 'pick.hintReceive'), !model.online)}
        {model.busy === 'read' && orders ? <FloorState tone="info" icon={<ClipboardList />} title={t('pick.opening')} busy /> : null}
        {orders === null || orders === undefined ? (
          <FloorState tone="info" icon={<ClipboardList />} title={t('pick.loading')} busy />
        ) : orders.length === 0 ? (
          <FloorState tone="info" icon={<Truck />} title={t(mode === 'send' ? 'pick.emptySend.title' : 'pick.emptyReceive.title')} text={t(mode === 'send' ? 'pick.emptySend.body' : 'pick.emptyReceive.body')} />
        ) : (
          <section className="fw-floor-stack" aria-labelledby="fw-kits-orders">
            <h2 id="fw-kits-orders" className="fw-floor-subtitle">
              {t(mode === 'send' ? 'pick.toSend' : 'pick.toReceive')}
            </h2>
            <FloorList label={t(mode === 'send' ? 'pick.toSend' : 'pick.toReceive')}>
              {orders.map((row) => (
                <FloorListRow
                  key={row.id}
                  icon={mode === 'send' ? <PackagePlus /> : <PackageCheck />}
                  tone={row.late ? 'warning' : 'neutral'}
                  title={
                    <>
                      <span className="fw-floor-code">{row.number}</span> · {row.workshop.name || row.workshop.code}
                    </>
                  }
                  meta={[`${row.workOrder.number} · ${row.workOrder.style.code}`, row.expectedBackDate ? t('pick.backBy', { date: day(row.expectedBackDate) }) : null, row.late ? t('card.late') : null].filter(Boolean).join(' · ')}
                  status={t(`status.${row.status}`)}
                  count={mode === 'send' ? row.kit.planned : row.pieces.atWorkshop}
                  countLabel={mode === 'send' ? t('pick.linesToSend', { count: row.kit.planned }) : t('pick.piecesOut', { count: row.pieces.atWorkshop })}
                  heldReason={offlineHeld}
                  onPress={() => send({ type: 'open', orderId: row.id })}
                />
              ))}
            </FloorList>
            <ListFooter
              count={t('pick.count', { count: orders.length })}
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
    actions = [{ label: t('action.modes'), icon: <ArrowLeft />, onPress: () => send({ type: 'modes' }) }]
  } else if (model.stage === 'kit') {
    const kit = model.kit ?? { lines: {}, bundles: [] }
    const planned = plannedLines(order)
    const toSend = bundlesToSend(order)
    const sentBefore = order.bundles.filter((bundle) => bundle.sent).length
    const missing = missingOf(order, kit)
    const held = kitHeld(order, kit)
    const ticked = Object.keys(kit.lines).length + kit.bundles.length
    body = (
      <div className="fw-floor-stack">
        {orderCard({ value: String(ticked), label: t('kit.ticked', { count: ticked }) })}
        {order.actions.send ? (
          <TaskLine tone="warning" icon={<CircleAlert />}>
            {t('kit.stateHeld')}
          </TaskLine>
        ) : null}
        {scanField(t('kit.scanLabel'), t('kit.scanHint'))}
        {planned.length > 0 ? (
          <section className="fw-floor-stack" aria-labelledby="fw-kits-lines">
            <h2 id="fw-kits-lines" className="fw-floor-subtitle">
              {t('kit.lines')}
            </h2>
            <FloorList label={t('kit.lines')}>
              {planned.map((line) => {
                const at = kit.lines[line.id]
                const source = at === undefined ? (line.sources.find((option) => option.covers) ?? line.sources[0]) : line.sources[at]
                return (
                  <FloorListRow
                    key={line.id}
                    icon={<Package />}
                    tone={at !== undefined ? 'success' : line.sources.length === 0 ? 'danger' : 'neutral'}
                    selected={at !== undefined}
                    title={
                      <>
                        <span className="fw-floor-code">{line.item.code}</span> · {line.item.name}
                      </>
                    }
                    meta={[line.colour ? line.colour.name || line.colour.code : null, source?.lot ? t('kit.lot', { code: source.lot.code }) : null, source ? t('kit.from', { place: source.location.code }) : t('kit.noStock')].filter(Boolean).join(' · ')}
                    status={at !== undefined ? t('kit.tickedOne') : t('kit.toTick')}
                    count={figure(line.quantity)}
                    countLabel={unit(line.uom)}
                    heldReason={line.sources.length === 0 ? t('kit.noStockHeld') : null}
                    onPress={() => send({ type: 'line', lineId: line.id })}
                  />
                )
              })}
            </FloorList>
          </section>
        ) : null}
        {toSend.length > 0 ? (
          <section className="fw-floor-stack" aria-labelledby="fw-kits-bundles">
            <h2 id="fw-kits-bundles" className="fw-floor-subtitle">
              {t('kit.bundles')}
            </h2>
            <FloorList label={t('kit.bundles')}>
              {toSend.map((bundle) => {
                const on = kit.bundles.includes(bundle.id)
                return (
                  <FloorListRow
                    key={bundle.id}
                    icon={<Layers />}
                    tone={on ? 'success' : 'neutral'}
                    selected={on}
                    title={<span className="fw-floor-code">{bundle.code}</span>}
                    meta={[`${bundle.colourway} ${bundle.size}`.trim(), bundle.part ? t('kit.part', { part: bundle.part }) : t('kit.wholeGarments')].join(' · ')}
                    status={on ? t('kit.tickedOne') : t('kit.toTick')}
                    count={bundle.quantity}
                    countLabel={t('kit.garments', { count: bundle.quantity })}
                    onPress={() => send({ type: 'bundle', bundleId: bundle.id })}
                  />
                )
              })}
            </FloorList>
          </section>
        ) : null}
        {sentBefore > 0 ? <p className="fw-floor-muted">{t('kit.sentBefore', { count: sentBefore })}</p> : null}
        {planned.length > 0 || toSend.length > 0 ? (
          <ListFooter
            count={t('kit.count', { count: planned.length + toSend.length })}
            keys={[
              { key: 'Tab', does: shared('keys.tab') },
              { key: 'Enter', does: t('keys.tick') },
              { key: 'Esc', does: shared('keys.escape') },
            ]}
          />
        ) : (
          <FloorState tone="success" icon={<CheckCheck />} title={t('kit.nothing.title')} text={t('kit.nothing.body')} />
        )}
        {held === 'missing' ? (
          <TaskLine tone="warning" icon={<CircleAlert />} alert>
            {missing.bundles > 0 && missing.lines > 0 ? t('kit.missingBoth', { bundles: missing.bundles, lines: missing.lines }) : missing.bundles > 0 ? t('kit.missingBundles', { count: missing.bundles }) : t('kit.missingLines', { count: missing.lines })}
          </TaskLine>
        ) : null}
        {held === 'noStock' ? (
          <TaskLine tone="danger" icon={<CircleAlert />}>
            {t('kit.noStockLine', { count: missing.noStock })}
          </TaskLine>
        ) : null}
      </div>
    )
    const heldWords =
      held === 'state'
        ? t('kit.stateShort')
        : held === 'nothing'
          ? t('kit.nothing.title')
          : held === 'noStock'
            ? t('kit.noStockShort')
            : held === 'missing'
              ? missing.bundles > 0 && missing.lines > 0
                ? t('kit.missingBoth', { bundles: missing.bundles, lines: missing.lines })
                : missing.bundles > 0
                  ? t('kit.missingBundles', { count: missing.bundles })
                  : t('kit.missingLines', { count: missing.lines })
              : null
    actions = [
      { label: t('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'next' }) },
      { label: t('action.toDdt'), icon: <FileText />, heldReason: heldWords, onPress: () => send({ type: 'toDdt' }) },
    ]
  } else if (model.stage === 'ddt') {
    const ddt = model.ddt ?? { transportBy: null, packages: 1, grossWeightKg: null, appearance: 'BOXES' as const }
    const held = ddtHeld(ddt)
    const carriers: ReasonTile[] = [
      { id: 'SENDER', label: t('ddt.SENDER'), hint: t('ddt.hint.SENDER'), icon: <Truck />, tone: 'primary' },
      { id: 'RECIPIENT', label: t('ddt.RECIPIENT'), hint: t('ddt.hint.RECIPIENT'), icon: <Warehouse />, tone: 'info' },
    ]
    const looks: ReasonTile[] = APPEARANCES.map((appearance) => ({ id: appearance, label: t(`appearance.${appearance}`), icon: APPEARANCE_ICON[appearance], tone: 'neutral' }))
    body = (
      <div className="fw-floor-stack">
        {orderCard()}
        <TaskLine tone="info" icon={<FileText />}>
          {t('ddt.what')}
        </TaskLine>
        <ReasonGrid label={t('ddt.who')} reasons={carriers} value={ddt.transportBy} onChange={(id) => send({ type: 'transport', by: id as TransportBy })} words={reasonWords} locale={intl} />
        <div className="fw-kits-pads">
          <QuantityPad label={t('ddt.packages')} value={ddt.packages} onChange={(value) => send({ type: 'packages', value })} min={1} max={999} showPad={false} {...padWords} />
          <QuantityPad label={t('ddt.weight')} value={ddt.grossWeightKg} onChange={(value) => send({ type: 'weight', value })} min={0} max={99999} decimals={3} unit={t('unit.KG')} {...padWords} />
        </div>
        <ReasonGrid label={t('ddt.appearance')} reasons={looks} value={ddt.appearance} onChange={(id) => send({ type: 'appearance', appearance: id as Appearance })} words={reasonWords} locale={intl} />
        {!model.online ? <HeldLine text={t('offline.send')} /> : null}
      </div>
    )
    actions = [
      { label: t('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'toKit' }) },
      { label: t('action.send'), icon: <Printer />, heldReason: model.busy === 'send' ? t('held.busy') : (offlineHeld ?? (held ? t(`held.${held}`) : null)), onPress: () => send({ type: 'send' }) },
    ]
  } else if (model.stage === 'sent') {
    const sent = model.sent
    body = (
      <div className="fw-floor-stack">
        <TaskLine tone="success" icon={<CheckCheck />}>
          {t('sent.done', { number: sent?.number ?? '', place: order.location.code })}
        </TaskLine>
        {!sent || sent.pdf === 'loading' ? (
          <FloorState tone="info" icon={<FileText />} title={t('sent.loading')} busy />
        ) : sent.pdf === 'missing' ? (
          <FloorState tone="warning" icon={<FileText />} title={t('sent.missing.title')} text={t('sent.missing.body')} />
        ) : sent.pdf === 'failed' ? (
          <FloorState tone="warning" icon={<FileText />} title={t('sent.failed.title')} text={t('sent.failed.body')} />
        ) : (
          <div className="fw-kits-pdf">
            <PdfViewer src={sent.pdf} title={t('sent.title', { number: sent.number })} fileName={`DDT-${sent.number.replace(/\//g, '-')}.pdf`} labels={pdfViewerLabels(shell)} height="min(64vh, 900px)" />
          </div>
        )}
      </div>
    )
    actions = [
      { label: t('action.print'), icon: <Printer />, heldReason: sent && sent.pdf instanceof Uint8Array ? null : t('held.noPdf'), onPress: () => send({ type: 'print' }) },
      { label: t('action.done'), icon: <Check />, onPress: () => send({ type: 'next' }) },
    ]
  } else if (model.stage === 'back') {
    const back = model.back ?? { entries: {}, returns: {}, ddtNumber: null }
    const out = bundlesOut(order)
    const material = materialAtWorkshop(order)
    const totals = backTotals(back)
    const held = backHeld(order, back, reasonsOffered)
    if (model.reject) {
      const panel = model.reject
      const bundle = order.bundles.find((entry) => entry.id === panel.bundleId)!
      const total = Math.max(entryTotal(back.entries[bundle.id]), outOf(order, bundle))
      const kinds: ReasonTile[] = [
        { id: 'defective', label: t('reject.defective'), hint: t('reject.hint.defective'), icon: <Undo2 />, tone: 'warning' },
        { id: 'scrapped', label: t('reject.scrapped'), hint: t('reject.hint.scrapped'), icon: <Trash2 />, tone: 'danger' },
      ]
      body = (
        <div className="fw-floor-stack">
          <TaskCard icon={<Layers />} type={t('reject.type')} code={bundle.code} big={{ value: String(total), label: t('kit.garments', { count: total }) }} facts={[{ label: t('back.cell'), value: `${bundle.colourway} ${bundle.size}`.trim() }]} />
          <ReasonGrid label={t('reject.kind')} reasons={kinds} value={panel.kind} onChange={(id) => send({ type: 'rejectKind', kind: id as RejectKind })} words={reasonWords} locale={intl} />
          <QuantityPad label={t('reject.count')} value={panel.count} onChange={(value) => send({ type: 'rejectCount', value })} min={0} max={total} expected={total} expectedLabel={(value) => t('reject.of', { count: value })} {...padWords} />
          {rejectPicker ? (
            <ReasonPickerBody
              model={rejectPicker}
              onAction={(action) => {
                if (action.type === 'pick') send({ type: 'rejectReason', reason: action.id })
                else if (action.type === 'retry') send({ type: 'rejectReasonsRetry' })
              }}
              onBack={() => send({ type: 'closePanel' })}
              timeZone={model.timeZone}
            />
          ) : null}
          {!reasonsOffered && rejectPicker?.state !== 'loading' ? (
            <TaskLine tone="info" icon={<CircleAlert />}>
              {t('reject.withoutReason')}
            </TaskLine>
          ) : null}
        </div>
      )
      actions = [
        { label: t('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'closePanel' }) },
        { label: t('reject.drop'), icon: <X />, variant: 'secondary', onPress: () => send({ type: 'dropBundle', bundleId: bundle.id }) },
        { label: t('reject.confirm'), icon: <Check />, heldReason: panel.count === null ? t('held.count') : panel.count > 0 && reasonsOffered ? rejectReasonHeld : null, onPress: () => send({ type: 'confirmReject' }) },
      ]
    } else if (model.material) {
      const panel = model.material
      const line = order.kitLines.find((entry) => entry.id === panel.lineId)!
      const most = Number(line.atWorkshop ?? '0')
      const places: ReasonTile[] = order.places.map((entry) => ({ id: entry.id, label: entry.code, hint: entry.name, icon: <Warehouse />, tone: entry.id === line.from?.id ? 'primary' : 'neutral' }))
      body = (
        <div className="fw-floor-stack">
          <TaskCard icon={<Package />} type={t('material.type')} code={line.item.code} big={{ value: figure(most), label: unit(line.item.baseUom) }} facts={[{ label: t('material.name'), value: line.item.name }, ...(line.lot ? [{ label: t('material.lot'), value: line.lot.code }] : []), { label: t('material.atWorkshop'), value: `${figure(most)} ${unit(line.item.baseUom)}` }]} />
          <QuantityPad label={t('material.quantity')} value={panel.quantity} onChange={(value) => send({ type: 'materialQuantity', value })} min={0} max={most} decimals={3} unit={unit(line.item.baseUom)} {...padWords} />
          <ReasonGrid label={t('material.place')} reasons={places} value={panel.toLocationId} onChange={(id) => send({ type: 'materialPlace', locationId: id })} words={reasonWords} locale={intl} />
        </div>
      )
      actions = [
        { label: t('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'closePanel' }) },
        { label: t('material.confirm'), icon: <Check />, heldReason: panel.toLocationId ? null : t('held.place'), onPress: () => send({ type: 'confirmMaterial' }) },
      ]
    } else {
      body = (
        <div className="fw-floor-stack">
          {orderCard({ value: String(totals.good + totals.rejected + totals.scrapped), label: t('back.now', { count: totals.good + totals.rejected + totals.scrapped }) })}
          {scanField(t('back.scanLabel'), back.ddtNumber ? t('back.ddtKept', { code: back.ddtNumber }) : t('back.scanHint'))}
          {back.ddtNumber ? (
            <FloorButton size="sm" variant="quiet" icon={<X />} onClick={() => send({ type: 'clearDdt' })}>
              {t('back.ddtClear')}
            </FloorButton>
          ) : null}
          {out.length === 0 ? (
            <FloorState tone="info" icon={<Layers />} title={t('back.noBundles.title')} text={t('back.noBundles.body')} />
          ) : (
            <section className="fw-floor-stack" aria-labelledby="fw-kits-out">
              <h2 id="fw-kits-out" className="fw-floor-subtitle">
                {t('back.bundles')}
              </h2>
              <FloorList label={t('back.bundles')}>
                {out.map((bundle) => {
                  const before = backBefore(order, bundle)
                  const entry = back.entries[bundle.id]
                  const left = outOf(order, bundle)
                  const tone: FloorTone = entry && entry.defective + entry.scrapped > 0 ? 'warning' : entry ? 'success' : left === 0 ? 'neutral' : 'info'
                  return (
                    <FloorListRow
                      key={bundle.id}
                      icon={<Layers />}
                      tone={tone}
                      selected={Boolean(entry)}
                      title={
                        <>
                          <span className="fw-floor-code">{bundle.code}</span> · {`${bundle.colourway} ${bundle.size}`.trim()}
                        </>
                      }
                      meta={t('back.row', { out: bundle.quantity, back: before.good + (entry?.good ?? 0), rejected: before.defective + before.scrapped + (entry ? entry.defective + entry.scrapped : 0) })}
                      status={entry ? (entry.defective + entry.scrapped > 0 ? t('back.rejectedNow') : t('back.backNow')) : left === 0 ? t('back.allBack') : t('back.out')}
                      count={entry ? entryTotal(entry) : left}
                      countLabel={entry ? t('back.thisReceipt') : t('back.stillOut')}
                      heldReason={left === 0 && !entry ? t('back.allBackHeld') : null}
                      onPress={() => send({ type: 'openReject', bundleId: bundle.id })}
                    />
                  )
                })}
              </FloorList>
              <ListFooter
                count={t('back.count', { count: out.length })}
                keys={[
                  { key: 'Tab', does: shared('keys.tab') },
                  { key: 'Enter', does: t('keys.reject') },
                  { key: 'Esc', does: shared('keys.escape') },
                ]}
              />
            </section>
          )}
          {material.length > 0 ? (
            <section className="fw-floor-stack" aria-labelledby="fw-kits-material">
              <h2 id="fw-kits-material" className="fw-floor-subtitle">
                {t('back.material')}
              </h2>
              <FloorList label={t('back.material')}>
                {material.map((line) => {
                  const returned = back.returns[line.id]
                  const to = returned ? order.places.find((entry) => entry.id === returned.toLocationId) : null
                  return (
                    <FloorListRow
                      key={line.id}
                      icon={<PackageOpen />}
                      tone={returned ? 'success' : 'neutral'}
                      selected={Boolean(returned)}
                      title={
                        <>
                          <span className="fw-floor-code">{line.item.code}</span> · {line.item.name}
                        </>
                      }
                      meta={[line.lot ? t('kit.lot', { code: line.lot.code }) : null, t('back.atWorkshop', { quantity: `${figure(line.atWorkshop ?? '0')} ${unit(line.item.baseUom)}` }), to ? t('back.to', { place: to.code }) : null].filter(Boolean).join(' · ')}
                      status={returned ? t('back.returning') : t('back.stays')}
                      count={returned ? figure(returned.quantity) : '—'}
                      countLabel={unit(line.item.baseUom)}
                      onPress={() => send({ type: 'openMaterial', lineId: line.id })}
                    />
                  )
                })}
              </FloorList>
            </section>
          ) : null}
          {totals.bundles > 0 ? (
            <TaskLine tone="info" icon={<ClipboardList />}>
              {t('back.totals', { good: totals.good, rejected: totals.rejected, scrapped: totals.scrapped })}
            </TaskLine>
          ) : null}
          {held === 'reason' ? (
            <TaskLine tone="warning" icon={<CircleAlert />}>
              {t('held.reasonLine')}
            </TaskLine>
          ) : null}
          {!model.online ? <HeldLine text={t('offline.receive')} /> : null}
        </div>
      )
      actions = [
        { label: t('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'next' }) },
        { label: t('action.receive'), icon: <PackageCheck />, heldReason: model.busy === 'receive' ? t('held.busy') : (offlineHeld ?? (held === 'state' ? t('back.stateShort') : held ? t(`held.back.${held}`) : null)), onPress: () => send({ type: 'receive' }) },
      ]
    }
  } else {
    const received = model.received ?? { good: 0, defective: 0, scrapped: 0, returned: 0 }
    body = (
      <div className="fw-floor-stack">
        <FloorState tone="success" icon={<CheckCheck />} title={t('received.title', { number: order.number })} text={t('received.body', { good: received.good, rejected: received.defective, scrapped: received.scrapped })} />
        {received.returned > 0 ? (
          <TaskLine tone="info" icon={<PackageOpen />}>
            {t('received.material', { count: received.returned })}
          </TaskLine>
        ) : null}
        <TaskLine tone="info" icon={<ClipboardList />}>
          {t('received.office')}
        </TaskLine>
      </div>
    )
    actions = [{ label: t('action.next'), icon: <ScanLine />, onPress: () => send({ type: 'next' }) }]
  }

  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={actions ? <FloorActionBar label={t('title')} actions={actions} /> : undefined}>
      {body}
    </FloorFrameView>
  )
}
