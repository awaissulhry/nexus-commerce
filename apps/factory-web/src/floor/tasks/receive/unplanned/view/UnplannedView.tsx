'use client'

import type { ReactNode } from 'react'
import { ArrowLeft, CalendarDays, Camera, Check, CircleSlash, ClipboardList, FileText, MapPin, Package, PackagePlus, Pencil, RotateCcw, ScanLine, Trash2, Truck, Warehouse, X } from 'lucide-react'
import type { CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import { FloorActionBar, FloorButton, FloorList, FloorListRow, QuantityPad, ScanInput, type CameraScanner, type FloorActions } from '@nexus/ui/floor'
import { formatDate, formatNumber, type FormatPlace } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../../frame/view/FloorFrameView'
import { FloorState } from '../../../../frame/view/FloorState'
import type { TaskProblem } from '../../../shared/task-api'
import { HeldLine, ListFooter, ProblemState, TaskCard, TaskLine } from '../../../shared/view/TaskParts'
import { ddtDays, ddtDigits } from '../../model'
import { DdtPhoto } from '../../view/DdtPhoto'
import { unitWord } from '../../view/ReceiveView'
import type { Material, UnplannedReceipt, UnplannedStart } from '../api'
import { lineProblem, sendHeld, suppliersMatching, type Draft, type UnplannedStage } from '../model'
import '../../receive.css'

/**
 * SCR-378 — Goods without a PO on the goods-in tablet (B-W2b-300; design floor.receive sec:unplanned, SCM-122: "Received to a
 * holding place and sent to a buyer"; "Supplier, item, quantity, photo; 'Put it in the holding area'"). One job per step,
 * opened from Receive goods' first step: who sent it (our suppliers, tap or type), what came (a material by its code, its
 * colour, the quantity on the pad in its stock unit, the hides counted for leather), the supplier's delivery note (number,
 * date, photo), then "Put it in the holding area" (the place the last goods waited in, or its label scanned) — ONE call: the
 * receipt waits there OPEN, nothing of it is used, and a buyer's task asks for the order or a return. Online only (the receipt
 * takes its number from the office): held with the reason offline. No money; nobody's name.
 */

export type UnplannedViewStage = UnplannedStage | 'loading' | 'noPermission'

export interface UnplannedViewModel {
  frame: FrameModel
  online: boolean
  held?: boolean
  stage: UnplannedViewStage
  start: UnplannedStart | null
  /** What is typed in the supplier search. */
  supplierQuery: string
  /** The materials found for the typed code; null while none was asked or it is read. */
  materials: readonly Material[] | null
  materialQuery: string | null
  draft: Draft
  ddt: { readonly today: string; readonly moreDays: boolean; readonly camera: boolean; readonly photo: { readonly url: string } | null }
  busy: 'post' | 'read' | null
  problem: { readonly problem: TaskProblem; readonly code: string | null } | null
  done: { readonly receipt: UnplannedReceipt; readonly photo: 'sending' | 'sent' | 'failed' | null } | null
  timeZone?: string
}

export type UnplannedAction =
  | { type: 'back' }
  | { type: 'supplierQuery'; value: string }
  | { type: 'supplier'; id: string }
  | { type: 'materialScan'; code: string }
  | { type: 'material'; id: string }
  | { type: 'colour'; id: string }
  | { type: 'quantity'; value: number | null }
  | { type: 'hideCount'; value: number | null }
  | { type: 'addLine' }
  | { type: 'editLine'; key: string }
  | { type: 'removeLine'; key: string }
  | { type: 'toStage'; stage: UnplannedStage }
  | { type: 'ddtScan'; code: string }
  | { type: 'ddtPad'; value: number | null }
  | { type: 'ddtClear' }
  | { type: 'ddtDate'; date: string | null }
  | { type: 'ddtMoreDays' }
  | { type: 'ddtCamera'; open: boolean }
  | { type: 'ddtPhoto'; photo: CapturedPhoto }
  | { type: 'ddtPhotoRemove' }
  | { type: 'placeScan'; code: string }
  | { type: 'placeClear' }
  | { type: 'post' }
  | { type: 'photoRetry' }
  | { type: 'next' }
  | { type: 'dismiss' }
  | { type: 'retry' }

export interface UnplannedViewProps {
  model: UnplannedViewModel
  onAction?: (action: UnplannedAction) => void
  onFrame?: (action: FrameAction) => void
  camera?: CameraScanner
}

/** The API's refusals the screen words itself, by the field they are about. */
export function problemCodeOf(problem: TaskProblem): string | null {
  if (problem.kind !== 'invalid') return null
  if (problem.path === 'body/placeCode' || problem.path === 'body/holdingLocationId') return 'PLACE'
  if (problem.path === 'body/supplierId') return 'SUPPLIER'
  if (problem.path?.endsWith('/itemColourId')) return 'COLOUR'
  if (problem.path?.startsWith('body/lines')) return 'LINE'
  return null
}

export function UnplannedView({ model, onAction, onFrame, camera }: UnplannedViewProps) {
  const t = useT('warehouse-receiving-depth')
  const rt = useT('floor-receive')
  const shared = useT('floor-tasks')
  const floor = useT('floor')
  const locale = useLocale()
  const send = (action: UnplannedAction) => onAction?.(action)
  const place: FormatPlace = { locale, timeZone: model.timeZone }
  const figure = (value: number) => formatNumber(value, locale, { maximumFractionDigits: 4 })
  const amount = (value: number, uom: string) => `${figure(value)} ${unitWord(rt, uom)}`
  const draft = model.draft
  const holding = model.draft.placeCode ? null : (model.start?.holding ?? null)
  const camProps = camera ? { scanner: camera, startLabel: floor('scan.camera.start'), stopLabel: floor('scan.camera.stop'), errorLabel: floor('scan.camera.error') } : undefined
  const scanField = (label: string, hint: string, onScan: (code: string) => void, keepFocus = true) => (
    <ScanInput label={label} keepFocus={keepFocus} hint={model.held ? floor('tile.held.notice') : hint} scannedLabel={(code) => floor('scan.read', { code })} keyboardLabel={floor('scan.type')} disabled={Boolean(model.held)} camera={camProps} onScan={onScan} />
  )
  const held = sendHeld(draft, { online: model.online, holding: model.start?.holding ?? null, busy: model.busy === 'post' })
  const heldWords = held ? t(`unplanned.held.${held}`) : null
  const supplierFact = { label: t('unplanned.card.supplier'), value: draft.supplier ? draft.supplier.name : t('unplanned.card.noSupplier') }
  const ddtFact = { label: t('unplanned.card.ddt'), value: [draft.ddtNumber ?? t('unplanned.card.noDdt'), draft.ddtDate ? formatDate(`${draft.ddtDate}T12:00:00Z`, place) : null, model.ddt.photo ? t('unplanned.ddt.photoKept') : null].filter(Boolean).join(' · ') }
  const placeFact = { label: t('unplanned.card.place'), value: draft.placeCode ?? (holding ? `${holding.code} · ${holding.name}` : t('unplanned.card.noPlace')) }

  let body: ReactNode
  let actions: FloorActions | null = null

  if (model.stage === 'noPermission') {
    body = <FloorState tone="warning" icon={<CircleSlash />} title={t('unplanned.noPermission.title')} text={t('unplanned.noPermission.body')} alert />
    actions = [{ label: t('unplanned.action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }) }]
  } else if (model.problem) {
    const own = problemCodeOf(model.problem.problem)
    body = own ? <FloorState tone="danger" icon={<CircleSlash />} title={t(`unplanned.problem.${own}.title`)} text={t(`unplanned.problem.${own}.body`)} alert /> : <ProblemState problem={model.problem.problem} code={model.problem.code} />
    const toDraft = { label: t('unplanned.action.toDraft'), icon: <ArrowLeft />, onPress: () => send({ type: 'dismiss' }) }
    actions = model.problem.problem.kind === 'offline' || model.problem.problem.kind === 'unavailable' ? [toDraft, { label: shared('action.retry'), icon: <RotateCcw />, onPress: () => send({ type: 'retry' }) }] : [toDraft]
  } else if (model.stage === 'loading' || !model.start) {
    body = <FloorState tone="info" icon={<ClipboardList />} title={t('unplanned.loading')} busy />
  } else if (model.stage === 'done' && model.done) {
    const receipt = model.done.receipt
    body = (
      <div className="fw-floor-stack">
        <TaskCard
          icon={<Warehouse />}
          type={t('unplanned.done.type')}
          code={receipt.number}
          status={t('unplanned.done.waiting')}
          statusTone="warning"
          big={{ value: String(receipt.lines.length), label: t('unplanned.done.lines', { count: receipt.lines.length }) }}
          facts={[
            { label: t('unplanned.card.supplier'), value: receipt.supplier.name },
            { label: t('unplanned.card.place'), value: receipt.holding ? `${receipt.holding.code} · ${receipt.holding.name}` : '—' },
            { label: t('unplanned.card.ddt'), value: receipt.supplierDdtNumber ?? t('unplanned.card.noDdt') },
          ]}
        />
        <TaskLine tone="success" icon={<MapPin />}>
          {t('unplanned.done.putIt', { place: receipt.holding?.code ?? '—' })}
        </TaskLine>
        <TaskLine tone="info" icon={<Truck />}>
          {receipt.buyerAsked ? t('unplanned.done.buyerAsked') : t('unplanned.done.buyerLater')}
        </TaskLine>
        {model.done.photo === 'sending' ? <TaskLine tone="info" icon={<Camera />}>{t('unplanned.done.photoSending')}</TaskLine> : null}
        {model.done.photo === 'sent' ? <TaskLine tone="success" icon={<Camera />}>{t('unplanned.done.photoSent')}</TaskLine> : null}
        {model.done.photo === 'failed' ? (
          <TaskLine tone="warning" icon={<Camera />}>
            {t('unplanned.done.photoFailed')}{' '}
            <FloorButton size="sm" variant="secondary" icon={<RotateCcw />} onClick={() => send({ type: 'photoRetry' })}>
              {shared('action.retry')}
            </FloorButton>
          </TaskLine>
        ) : null}
        <FloorList label={t('unplanned.lines.title')}>
          {receipt.lines.map((line) => (
            <FloorListRow key={line.id} icon={<Package />} title={<span className="fw-floor-code">{line.item.code}</span>} meta={[line.item.name, line.colour ? `${line.colour.code} · ${line.colour.name}` : null].filter(Boolean).join(' · ')} count={amount(Number(line.quantity), line.uom)} countLabel={line.hideCount ? t('unplanned.lines.hides', { count: line.hideCount }) : t('unplanned.lines.quantity')} />
          ))}
        </FloorList>
      </div>
    )
    actions = [{ label: t('unplanned.action.next'), icon: <Truck />, onPress: () => send({ type: 'next' }) }]
  } else if (model.stage === 'supplier') {
    const rows = suppliersMatching(model.start.suppliers, model.supplierQuery)
    body = (
      <div className="fw-floor-stack">
        {!model.online ? <HeldLine text={t('unplanned.held.OFFLINE')} /> : null}
        <TaskLine tone="info" icon={<Warehouse />}>
          {t('unplanned.intro')}
        </TaskLine>
        {scanField(t('unplanned.supplier.search'), t('unplanned.supplier.hint'), (code) => send({ type: 'supplierQuery', value: code }), false)}
        {model.supplierQuery ? (
          <TaskLine tone="info" icon={<Truck />}>
            {t('unplanned.supplier.filtered', { text: model.supplierQuery })}{' '}
            <FloorButton size="sm" variant="quiet" icon={<X />} onClick={() => send({ type: 'supplierQuery', value: '' })}>
              {t('unplanned.supplier.clear')}
            </FloorButton>
          </TaskLine>
        ) : null}
        {rows.length === 0 ? (
          <FloorState tone="info" icon={<Truck />} title={t('unplanned.supplier.none.title')} text={t('unplanned.supplier.none.body')} />
        ) : (
          <section className="fw-floor-stack" aria-labelledby="fw-unplanned-suppliers">
            <h2 id="fw-unplanned-suppliers" className="fw-floor-subtitle">
              {t('unplanned.supplier.title')}
            </h2>
            <FloorList label={t('unplanned.supplier.title')}>
              {rows.map((row) => (
                <FloorListRow key={row.id} icon={<Truck />} title={row.name} meta={row.code} selected={draft.supplier?.id === row.id} onPress={() => send({ type: 'supplier', id: row.id })} />
              ))}
            </FloorList>
            <ListFooter count={t('unplanned.supplier.count', { count: rows.length })} keys={[{ key: 'Tab', does: shared('keys.tab') }, { key: 'Enter', does: shared('keys.enter') }, { key: 'Esc', does: shared('keys.escape') }]} />
          </section>
        )}
      </div>
    )
    actions = [{ label: t('unplanned.action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }) }]
  } else if (model.stage === 'material') {
    body = (
      <div className="fw-floor-stack">
        <TaskCard icon={<Truck />} type={t('unplanned.card.type')} code={draft.supplier?.name ?? '—'} facts={[{ label: t('unplanned.card.lines'), value: t('unplanned.card.linesCount', { count: draft.lines.length }) }]} />
        {scanField(t('unplanned.material.scan'), t('unplanned.material.hint'), (code) => send({ type: 'materialScan', code }))}
        {model.busy === 'read' ? (
          <FloorState tone="info" icon={<ClipboardList />} title={t('unplanned.material.reading')} busy />
        ) : model.materials === null ? (
          <FloorState tone="info" icon={<ScanLine />} title={t('unplanned.material.ask.title')} text={t('unplanned.material.ask.body')} />
        ) : model.materials.length === 0 ? (
          <FloorState tone="warning" icon={<Package />} title={t('unplanned.material.none.title', { code: model.materialQuery ?? '' })} text={t('unplanned.material.none.body')} />
        ) : (
          <FloorList label={t('unplanned.material.title')}>
            {model.materials.map((material) => (
              <FloorListRow key={material.id} icon={<Package />} title={<span className="fw-floor-code">{material.code}</span>} meta={material.name} status={t(`unplanned.tracking.${material.tracking}`)} onPress={() => send({ type: 'material', id: material.id })} />
            ))}
          </FloorList>
        )}
      </div>
    )
    actions = [
      { label: draft.lines.length > 0 ? t('unplanned.action.toLines') : t('unplanned.action.toSupplier'), icon: <ArrowLeft />, onPress: () => send({ type: 'toStage', stage: draft.lines.length > 0 ? 'lines' : 'supplier' }) },
    ]
  } else if (model.stage === 'quantity' && draft.editing) {
    const line = draft.editing
    const problem = lineProblem(line)
    const unit = unitWord(rt, line.material.baseUom)
    body = (
      <div className="fw-floor-stack">
        <TaskCard icon={<Package />} type={t(`unplanned.tracking.${line.material.tracking}`)} code={line.material.code} status={line.material.name} facts={[supplierFact]} />
        <div className="fw-task-split">
          {line.material.colours.length > 0 ? (
            <section className="fw-floor-stack" aria-labelledby="fw-unplanned-colour">
              <h2 id="fw-unplanned-colour" className="fw-floor-section-title">
                {t('unplanned.quantity.colour')}
              </h2>
              <div className="fw-task-reasons" role="group" aria-labelledby="fw-unplanned-colour">
                {line.material.colours.map((colour) => (
                  <FloorButton key={colour.id} size="lg" block variant={line.colour?.id === colour.id ? 'primary' : 'secondary'} aria-pressed={line.colour?.id === colour.id} onClick={() => send({ type: 'colour', id: colour.id })}>
                    {`${colour.code} · ${colour.name}`}
                  </FloorButton>
                ))}
              </div>
            </section>
          ) : null}
          <section className="fw-floor-stack" aria-labelledby="fw-unplanned-quantity">
            <h2 id="fw-unplanned-quantity" className="fw-floor-section-title">
              {t('unplanned.quantity.title', { unit })}
            </h2>
            <QuantityPad
              label={t('unplanned.quantity.pad', { unit })}
              value={line.quantity}
              onChange={(value) => send({ type: 'quantity', value })}
              unit={unit}
              min={0}
              max={999_999}
              decimals={line.material.tracking === 'NONE' && ['PCS', 'PAIR', 'SET', 'BOX', 'ROLL', 'CONE', 'HIDE', 'SIDE'].includes(line.material.baseUom) ? 0 : 2}
              decrementLabel={rt('pad.minus')}
              incrementLabel={rt('pad.plus')}
              clearLabel={rt('pad.clear')}
              backLabel={rt('pad.back')}
              emptyLabel={t('unplanned.quantity.empty')}
              rangeLabel={() => t('unplanned.quantity.empty')}
            />
            {line.material.tracking === 'HIDE' ? (
              <QuantityPad
                label={t('unplanned.quantity.hides')}
                value={line.hideCount}
                onChange={(value) => send({ type: 'hideCount', value })}
                min={0}
                max={999}
                decimals={0}
                showPad={false}
                decrementLabel={rt('pad.minus')}
                incrementLabel={rt('pad.plus')}
                clearLabel={rt('pad.clear')}
                backLabel={rt('pad.back')}
                emptyLabel={t('unplanned.quantity.hidesEmpty')}
                rangeLabel={() => t('unplanned.quantity.hidesEmpty')}
              />
            ) : null}
          </section>
        </div>
        {problem ? <TaskLine tone="info" icon={<PackagePlus />}>{t(`unplanned.quantity.held.${problem}`)}</TaskLine> : null}
      </div>
    )
    actions = [
      { label: t('unplanned.action.cancelLine'), icon: <X />, onPress: () => send({ type: 'toStage', stage: draft.lines.length > 0 ? 'lines' : 'material' }) },
      { label: t('unplanned.action.addLine'), icon: <Check />, heldReason: problem ? t(`unplanned.quantity.held.${problem}`) : null, onPress: () => send({ type: 'addLine' }) },
    ]
  } else if (model.stage === 'ddt') {
    const days = ddtDays(model.ddt.today)
    const dayWords = (date: string) => new Intl.DateTimeFormat(INTL_LOCALE[place.locale], { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${date}T12:00:00Z`))
    const tile = (date: string, label: string) => (
      <FloorButton key={date} size="lg" block variant={draft.ddtDate === date ? 'primary' : 'secondary'} aria-pressed={draft.ddtDate === date} icon={<CalendarDays />} onClick={() => send({ type: 'ddtDate', date: draft.ddtDate === date ? null : date })}>
        {label}
      </FloorButton>
    )
    const digits = ddtDigits(draft.ddtNumber)
    body = (
      <div className="fw-floor-stack">
        <TaskCard icon={<FileText />} type={t('unplanned.ddt.title')} code={draft.ddtNumber ?? t('unplanned.card.noDdt')} status={draft.supplier?.name ?? null} facts={[ddtFact]} />
        <div className="fw-task-split">
          <section className="fw-floor-stack" aria-labelledby="fw-unplanned-ddt-number">
            <h2 id="fw-unplanned-ddt-number" className="fw-floor-section-title">
              {t('unplanned.ddt.number')}
            </h2>
            {scanField(t('unplanned.ddt.scan'), t('unplanned.ddt.hint'), (code) => send({ type: 'ddtScan', code }), false)}
            <QuantityPad label={t('unplanned.ddt.pad')} value={digits} onChange={(value) => send({ type: 'ddtPad', value })} min={0} max={999_999_999_999} decimals={0} decrementLabel={rt('pad.minus')} incrementLabel={rt('pad.plus')} clearLabel={rt('pad.clear')} backLabel={rt('pad.back')} emptyLabel={t('unplanned.ddt.empty')} rangeLabel={() => t('unplanned.ddt.empty')} message={draft.ddtNumber && digits === null ? t('unplanned.ddt.kept', { number: draft.ddtNumber }) : undefined} messageTone="info" />
            {draft.ddtNumber ? (
              <FloorButton size="md" variant="quiet" icon={<X />} onClick={() => send({ type: 'ddtClear' })}>
                {t('unplanned.ddt.clear')}
              </FloorButton>
            ) : null}
          </section>
          <div className="fw-floor-stack">
            <section className="fw-floor-stack" aria-labelledby="fw-unplanned-ddt-date">
              <h2 id="fw-unplanned-ddt-date" className="fw-floor-section-title">
                {t('unplanned.ddt.date')}
              </h2>
              <div className="fw-task-reasons" role="group" aria-labelledby="fw-unplanned-ddt-date">
                {tile(days[0]!, t('unplanned.ddt.today'))}
                {tile(days[1]!, t('unplanned.ddt.yesterday'))}
                <FloorButton size="lg" block variant="secondary" aria-expanded={model.ddt.moreDays} icon={<CalendarDays />} onClick={() => send({ type: 'ddtMoreDays' })}>
                  {t('unplanned.ddt.another')}
                </FloorButton>
                {model.ddt.moreDays || (draft.ddtDate !== null && days.indexOf(draft.ddtDate) > 1) ? days.slice(2).map((date) => tile(date, dayWords(date))) : null}
              </div>
            </section>
            <section className="fw-floor-stack" aria-labelledby="fw-unplanned-ddt-photo">
              <h2 id="fw-unplanned-ddt-photo" className="fw-floor-section-title">
                {t('unplanned.ddt.photo')}
              </h2>
              {model.ddt.camera ? (
                <DdtPhoto label={t('unplanned.ddt.photo')} onCapture={(photo) => send({ type: 'ddtPhoto', photo })} onCancel={() => send({ type: 'ddtCamera', open: false })} />
              ) : model.ddt.photo ? (
                <>
                  <img className="fw-receive-ddt-photo" src={model.ddt.photo.url} alt={t('unplanned.ddt.photoAlt', { number: draft.ddtNumber ?? t('unplanned.card.noDdt') })} />
                  <div className="fw-receive-chips">
                    <FloorButton size="md" variant="secondary" icon={<Camera />} onClick={() => send({ type: 'ddtCamera', open: true })}>
                      {t('unplanned.ddt.retake')}
                    </FloorButton>
                    <FloorButton size="md" variant="quiet" icon={<Trash2 />} onClick={() => send({ type: 'ddtPhotoRemove' })}>
                      {t('unplanned.ddt.removePhoto')}
                    </FloorButton>
                  </div>
                </>
              ) : (
                <FloorButton size="lg" block variant="secondary" icon={<Camera />} onClick={() => send({ type: 'ddtCamera', open: true })}>
                  {t('unplanned.ddt.takePhoto')}
                </FloorButton>
              )}
              <p className="fw-floor-muted">{t('unplanned.ddt.photoHint')}</p>
            </section>
          </div>
        </div>
      </div>
    )
    actions = [{ label: t('unplanned.action.toLines'), icon: <Check />, onPress: () => send({ type: 'toStage', stage: 'lines' }) }]
  } else if (model.stage === 'place') {
    body = (
      <div className="fw-floor-stack">
        <TaskCard icon={<MapPin />} type={t('unplanned.place.title')} code={draft.placeCode ?? holding?.code ?? t('unplanned.card.noPlace')} status={holding?.name ?? null} facts={[supplierFact]} />
        {scanField(t('unplanned.place.scan'), t('unplanned.place.hint'), (code) => send({ type: 'placeScan', code }))}
        {draft.placeCode && model.start.holding ? (
          <FloorButton size="md" variant="quiet" icon={<X />} onClick={() => send({ type: 'placeClear' })}>
            {t('unplanned.place.useSuggested', { place: model.start.holding.code })}
          </FloorButton>
        ) : null}
      </div>
    )
    actions = [{ label: t('unplanned.action.toLines'), icon: <Check />, onPress: () => send({ type: 'toStage', stage: 'lines' }) }]
  } else {
    // lines: what came so far, the delivery note, the place, and "Put it in the holding area".
    body = (
      <div className="fw-floor-stack">
        {!model.online ? <HeldLine text={t('unplanned.held.OFFLINE')} /> : null}
        <TaskCard icon={<Warehouse />} type={t('unplanned.card.type')} code={draft.supplier?.name ?? t('unplanned.card.noSupplier')} big={{ value: String(draft.lines.length), label: t('unplanned.card.linesCount', { count: draft.lines.length }) }} facts={[ddtFact, placeFact]} />
        <TaskLine tone="warning" icon={<Warehouse />}>
          {holding || draft.placeCode ? t('unplanned.lines.goesTo', { place: draft.placeCode ?? holding!.code }) : t('unplanned.lines.scanPlace')}
        </TaskLine>
        {draft.lines.length === 0 ? (
          <FloorState tone="info" icon={<Package />} title={t('unplanned.lines.empty.title')} text={t('unplanned.lines.empty.body')} />
        ) : (
          <section className="fw-floor-stack" aria-labelledby="fw-unplanned-lines">
            <h2 id="fw-unplanned-lines" className="fw-floor-subtitle">
              {t('unplanned.lines.title')}
            </h2>
            <FloorList label={t('unplanned.lines.title')}>
              {draft.lines.map((line) => (
                <FloorListRow key={line.key} icon={<Package />} title={<span className="fw-floor-code">{line.material.code}</span>} meta={[line.material.name, line.colour ? `${line.colour.code} · ${line.colour.name}` : null, line.hideCount ? t('unplanned.lines.hides', { count: line.hideCount }) : null].filter(Boolean).join(' · ')} count={amount(line.quantity ?? 0, line.material.baseUom)} countLabel={t('unplanned.lines.quantity')} onPress={() => send({ type: 'editLine', key: line.key })} />
              ))}
            </FloorList>
            <div className="fw-receive-chips">
              {draft.lines.map((line) => (
                <FloorButton key={line.key} size="sm" variant="quiet" icon={<Trash2 />} onClick={() => send({ type: 'removeLine', key: line.key })}>
                  {t('unplanned.lines.remove', { code: line.material.code })}
                </FloorButton>
              ))}
            </div>
            <ListFooter count={t('unplanned.card.linesCount', { count: draft.lines.length })} keys={[{ key: 'Tab', does: shared('keys.tab') }, { key: 'Enter', does: t('unplanned.keys.enter') }, { key: 'Esc', does: shared('keys.escape') }]} />
          </section>
        )}
        <div className="fw-receive-chips">
          <FloorButton size="md" variant="secondary" icon={<PackagePlus />} heldReason={draft.lines.length >= 20 ? t('unplanned.lines.full') : null} onClick={() => send({ type: 'toStage', stage: 'material' })}>
            {t('unplanned.action.addMaterial')}
          </FloorButton>
          <FloorButton size="md" variant="secondary" icon={<FileText />} onClick={() => send({ type: 'toStage', stage: 'ddt' })}>
            {t('unplanned.action.ddt')}
          </FloorButton>
          <FloorButton size="md" variant="secondary" icon={<MapPin />} onClick={() => send({ type: 'toStage', stage: 'place' })}>
            {t('unplanned.action.place')}
          </FloorButton>
          <FloorButton size="md" variant="quiet" icon={<Pencil />} onClick={() => send({ type: 'toStage', stage: 'supplier' })}>
            {t('unplanned.action.changeSupplier')}
          </FloorButton>
        </div>
      </div>
    )
    actions = [
      { label: t('unplanned.action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }) },
      { label: model.busy === 'post' ? t('unplanned.action.posting') : t('unplanned.action.post'), icon: <Warehouse />, heldReason: heldWords, onPress: () => send({ type: 'post' }) },
    ]
  }

  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={actions ? <FloorActionBar label={t('unplanned.title')} actions={actions} /> : undefined}>
      {body}
    </FloorFrameView>
  )
}
