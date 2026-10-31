'use client'

import type { ReactNode } from 'react'
import {
  ArrowLeft,
  Ban,
  Camera,
  Check,
  CheckCheck,
  CircleAlert,
  CircleSlash,
  ClipboardList,
  MapPin,
  Package,
  PackageCheck,
  PackageOpen,
  PackageX,
  RotateCcw,
  ScanLine,
  ShieldAlert,
  Shirt,
  Sparkles,
  Star,
  ThumbsUp,
  Trash2,
  Undo2,
  Wrench,
  X,
} from 'lucide-react'
import { PhotoCapture, type CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import { FloorActionBar, FloorButton, FloorList, FloorListRow, QuantityPad, ScanInput, type CameraScanner, type FloorAction, type FloorActions, type FloorTone } from '@nexus/ui/floor'
import { ReasonGrid, type ReasonTile } from '@nexus/ui/floor/ReasonGrid/index'
import { usePhotoWords, PHOTO_KIT_NAMESPACE } from '../../../../lib/ds-words/photo-capture'
import { useReasonWords, REASON_KIT_NAMESPACE } from '../../../../lib/ds-words/reason-grid'
import { formatDate, type FormatPlace } from '../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import type { TaskProblem } from '../../shared/task-api'
import { HeldLine, ListFooter, ProblemState, TaskCard, TaskLine, UndoStrip } from '../../shared/view/TaskParts'
import type { DockLine, DockReturn, ParcelCondition, ReturnGrade } from '../api'
import { garmentOf, GRADES, lineToGrade, MAX_PARCELS, MAX_PHOTOS, PARCEL_CONDITIONS, piecesIn, placeOf, receiveHeld, roomOf, suggestionOf, takes, toGrade, type Arrival, type ReturnsStage } from '../model'
import '../returns-in.css'

/**
 * SCR-180 — Receive a return on the floor (design floor.returnsin; SAL-346, LOG-114, QHS-117): scan the RMA (its sheet or the
 * box label) → the parcel's condition with photos of the parcel and the products only → the lines it brings (scan each
 * garment's serial or batch label, or tap its line; a partial receipt leaves the rest expected) → ONE receipt, its photos
 * after it → grade each garment (five tiles; the return policy's suggestion beside them, restocking as new held for a used
 * or defective protective garment, with the reason) → where it goes (the inspection place until the office decides; scan
 * the place to confirm). The office decides the outcome: the floor never sees a price, a credit or a decision.
 * Online only for the receipt and the grades (they are the office's records); entries stay on screen offline.
 */

export interface ReturnsInViewModel {
  frame: FrameModel
  online: boolean
  /** The worker notice holds scans. */
  held?: boolean
  stage: ReturnsStage
  /** The person may grade (sales.returns.inspect); without it the goods go to the inspection place ungraded. */
  mayGrade?: boolean
  dock?: DockReturn | null
  arrival?: Arrival | null
  /** grade: the line being graded and the tile picked. */
  gradeLineId?: string | null
  grade?: ReturnGrade | null
  /** Photos taken of the garment being graded (sent with its grade). */
  linePhotos?: number
  /** The photo step is open (the parcel's, or the garment's). */
  camera?: 'parcel' | 'line' | null
  /** lines: the line the last piece was counted on (Take one off). */
  lastLineId?: string | null
  /** route: the place label was scanned. */
  placeOk?: boolean
  busy?: 'read' | 'receive' | 'grade' | null
  /** Photos that could not be sent with the last receipt or grade. */
  photosFailed?: number
  /** done: what this visit recorded. */
  done?: { readonly pieces: number; readonly graded: number } | null
  problem?: { readonly problem: TaskProblem; readonly code: string | null } | null
  timeZone?: string
}

export type ReturnsInAction =
  | { type: 'scan'; code: string }
  | { type: 'condition'; condition: ParcelCondition }
  | { type: 'parcels'; value: number | null }
  | { type: 'camera'; target: 'parcel' | 'line' | null }
  | { type: 'photo'; target: 'parcel' | 'line'; photo: CapturedPhoto }
  | { type: 'removePhoto'; key: string }
  | { type: 'clearDdt' }
  | { type: 'toLines' }
  | { type: 'toParcel' }
  | { type: 'count'; lineId: string; delta: 1 | -1 }
  | { type: 'countAll' }
  | { type: 'receive' }
  | { type: 'toGrade' }
  | { type: 'pickLine'; lineId: string }
  | { type: 'grade'; grade: ReturnGrade }
  | { type: 'confirmGrade' }
  | { type: 'toRoute' }
  | { type: 'finish' }
  | { type: 'next' }
  | { type: 'dismiss' }
  | { type: 'retry' }

export interface ReturnsInViewProps {
  model: ReturnsInViewModel
  onAction?: (action: ReturnsInAction) => void
  onFrame?: (action: FrameAction) => void
  camera?: CameraScanner
}

/** The catalogues this screen draws from (the DS reason grid's and photo capture's words with the floor's). */
const NAMESPACES = ['floor', 'floor-tasks', 'floor-returns-in', REASON_KIT_NAMESPACE, PHOTO_KIT_NAMESPACE] as const

/** The refusals the screen words itself (`refusal.<CODE>`). */
const OWN_REFUSALS = new Set(['NOT_OPEN', 'CHANGED', 'FULL', 'NO_LINE', 'PLACE', 'BADGE', 'GRADED'])

export function refusalWords(t: Translate, code: string): { message: string; fix: string | null } | null {
  return OWN_REFUSALS.has(code) ? { message: t(`refusal.${code}.message`), fix: t(`refusal.${code}.fix`) } : null
}

const CONDITION_ICON: Record<ParcelCondition, ReactNode> = { INTACT: <PackageCheck />, DAMAGED: <PackageX />, OPENED: <PackageOpen /> }
const CONDITION_TONE: Record<ParcelCondition, FloorTone> = { INTACT: 'success', DAMAGED: 'warning', OPENED: 'warning' }
const GRADE_ICON: Record<ReturnGrade, ReactNode> = { NEW: <Sparkles />, LIKE_NEW: <Star />, GOOD: <ThumbsUp />, DAMAGED: <Wrench />, UNUSABLE: <Trash2 /> }
const GRADE_TONE: Record<ReturnGrade, FloorTone> = { NEW: 'success', LIKE_NEW: 'success', GOOD: 'info', DAMAGED: 'warning', UNUSABLE: 'danger' }

export function ReturnsInView(props: ReturnsInViewProps) {
  return (
    <WithMessages namespaces={NAMESPACES}>
      <ReturnsIn {...props} />
    </WithMessages>
  )
}

function ReturnsIn({ model, onAction, onFrame, camera }: ReturnsInViewProps) {
  const t = useT('floor-returns-in')
  const shared = useT('floor-tasks')
  const floor = useT('floor')
  const locale = useLocale()
  const reasonWords = useReasonWords()
  const photoWords = usePhotoWords()
  const intl = INTL_LOCALE[locale]
  const send = (action: ReturnsInAction) => onAction?.(action)
  const place: FormatPlace = { locale, timeZone: model.timeZone }
  const day = (value: string | null) => (value ? formatDate(`${value}T12:00:00Z`, place) : '—')
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
  const lineName = (line: DockLine) => garmentOf(line) || t('line.number', { seq: line.seq })
  const reasonOf = (line: DockLine) => (line.reason ? (locale === 'it' ? line.reason.labelIt : line.reason.labelEn) : line.reasonCode)

  let actions: FloorActions | null = null
  let body: ReactNode
  const dock = model.dock ?? null
  const arrival = model.arrival ?? null

  const rmaCard = (big?: { value: string; label: string } | null) =>
    dock ? (
      <TaskCard
        icon={<Undo2 />}
        type={t('card.type')}
        code={dock.number}
        status={t(`status.${dock.status}`)}
        statusTone={dock.status === 'AUTHORISED' ? 'info' : 'success'}
        big={big ?? null}
        facts={[
          ...(dock.customerRef ? [{ label: t('card.customerRef'), value: dock.customerRef }] : []),
          { label: t('card.lines'), value: t('card.linesValue', { received: dock.lines.filter((line) => line.receivedQuantity > 0).length, count: dock.lines.length }) },
          ...(dock.goodsDueBy ? [{ label: t('card.dueBy'), value: day(dock.goodsDueBy) }] : []),
        ]}
      />
    ) : null

  if (model.stage === 'noPermission') {
    body = <FloorState tone="warning" icon={<CircleSlash />} title={t('noPermission.title')} text={t('noPermission.body')} alert />
  } else if (model.problem) {
    const { problem, code } = model.problem
    body = <ProblemState problem={problem} code={code} words={(refusal) => refusalWords(t, refusal)} />
    const back: FloorAction = { label: dock ? t('action.back') : shared('action.scanAnother'), icon: dock ? <ArrowLeft /> : <ScanLine />, onPress: () => send({ type: 'dismiss' }) }
    actions = problem.kind === 'unavailable' || problem.kind === 'offline' ? [back, { label: shared('action.retry'), icon: <RotateCcw />, onPress: () => send({ type: 'retry' }) }] : [back]
  } else if (model.camera) {
    const target = model.camera
    const taken = target === 'parcel' ? (arrival?.photos.length ?? 0) : (model.linePhotos ?? 0)
    body = (
      <div className="fw-floor-stack">
        <h2 className="fw-floor-section-title">{t(target === 'parcel' ? 'photo.parcelTitle' : 'photo.lineTitle')}</h2>
        <TaskLine tone="info" icon={<Camera />}>
          {t(target === 'parcel' ? 'photo.parcelHint' : 'photo.lineHint')}
        </TaskLine>
        <PhotoCapture
          label={t(target === 'parcel' ? 'photo.parcelTitle' : 'photo.lineTitle')}
          words={photoWords}
          markup={target === 'line'}
          heldReason={taken >= MAX_PHOTOS ? t('photo.full', { count: MAX_PHOTOS }) : null}
          onCapture={(photo) => send({ type: 'photo', target, photo })}
          onCancel={() => send({ type: 'camera', target: null })}
        />
      </div>
    )
    actions = [{ label: t('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'camera', target: null }) }]
  } else if (model.stage === 'scan' || !dock || !arrival) {
    body = (
      <div className="fw-floor-stack">
        {!model.online ? <HeldLine text={t('offline.scan')} /> : null}
        {model.busy === 'read' ? <FloorState tone="info" icon={<ClipboardList />} title={t('scan.loading')} busy /> : null}
        {scanField(t('scan.label'), t('scan.hint'), !model.online)}
        <TaskLine tone="info" icon={<Package />}>
          {t('scan.where')}
        </TaskLine>
      </div>
    )
  } else if (model.stage === 'parcel') {
    const reasons: ReasonTile[] = PARCEL_CONDITIONS.map((condition) => ({ id: condition, label: t(`condition.${condition}`), hint: t(`condition.hint.${condition}`), icon: CONDITION_ICON[condition], tone: CONDITION_TONE[condition] }))
    body = (
      <div className="fw-floor-stack">
        {rmaCard()}
        <ReasonGrid label={t('parcel.question')} reasons={reasons} value={arrival.condition} onChange={(id) => send({ type: 'condition', condition: id as ParcelCondition })} words={reasonWords} locale={intl} />
        <div className="fw-returns-row">
          <QuantityPad
            label={t('parcel.parcels')}
            value={arrival.parcels}
            onChange={(value) => send({ type: 'parcels', value })}
            min={1}
            max={MAX_PARCELS}
            showPad={false}
            decrementLabel={t('pad.less')}
            incrementLabel={t('pad.more')}
            clearLabel={t('pad.clear')}
            backLabel={t('pad.back')}
            emptyLabel={t('pad.empty')}
            rangeLabel={(min, max) => t('pad.range', { min: min ?? 1, max: max ?? MAX_PARCELS })}
          />
          <div className="fw-floor-stack">
            <FloorButton size="lg" variant="secondary" icon={<Camera />} heldReason={arrival.photos.length >= MAX_PHOTOS ? t('photo.full', { count: MAX_PHOTOS }) : null} onClick={() => send({ type: 'camera', target: 'parcel' })}>
              {t('parcel.photo')}
            </FloorButton>
            <p className="fw-floor-muted">{arrival.photos.length > 0 ? t('parcel.photos', { count: arrival.photos.length }) : t('parcel.noPhotos')}</p>
            {arrival.photos.length > 0 ? (
              <div className="fw-returns-chips">
                {arrival.photos.map((photo, index) => (
                  <FloorButton key={photo.key} size="sm" variant="quiet" icon={<X />} onClick={() => send({ type: 'removePhoto', key: photo.key })}>
                    {t('parcel.removePhoto', { n: index + 1 })}
                  </FloorButton>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        {scanField(t('parcel.ddtLabel'), arrival.ddtNumber ? t('parcel.ddtKept', { code: arrival.ddtNumber }) : t('parcel.ddtHint'))}
        {arrival.ddtNumber ? (
          <FloorButton size="sm" variant="quiet" icon={<X />} onClick={() => send({ type: 'clearDdt' })}>
            {t('parcel.ddtClear')}
          </FloorButton>
        ) : null}
      </div>
    )
    actions = [
      { label: shared('action.scanAnother'), icon: <ScanLine />, onPress: () => send({ type: 'next' }) },
      { label: t('action.toLines'), icon: <ClipboardList />, heldReason: arrival.condition === null ? t('held.condition') : null, onPress: () => send({ type: 'toLines' }) },
    ]
  } else if (model.stage === 'lines') {
    const open = dock.lines.filter(takes)
    const held = receiveHeld(arrival)
    const pieces = piecesIn(arrival)
    const lastLine = model.lastLineId && (arrival.counts[model.lastLineId] ?? 0) > 0 ? (dock.lines.find((line) => line.id === model.lastLineId) ?? null) : null
    body = (
      <div className="fw-floor-stack">
        {rmaCard({ value: String(pieces), label: t('lines.inParcel', { count: pieces }) })}
        {!model.online ? <HeldLine text={t('offline.receive')} /> : null}
        {open.length === 0 ? (
          <FloorState tone="success" icon={<CheckCheck />} title={t('lines.allIn.title')} text={toGrade(dock).length > 0 ? t('lines.allIn.grade') : t('lines.allIn.body')} />
        ) : (
          <>
            {scanField(t('lines.scanLabel'), t('lines.scanHint'))}
            {lastLine ? <UndoStrip text={t('lines.last', { seq: lastLine.seq, counted: arrival.counts[lastLine.id] ?? 0, expected: lastLine.expected })} onUndo={() => send({ type: 'count', lineId: lastLine.id, delta: -1 })} undoLabel={t('lines.takeOff')} /> : null}
            <section className="fw-floor-stack" aria-labelledby="fw-returns-lines">
              <h2 id="fw-returns-lines" className="fw-floor-subtitle">
                {t('lines.title')}
              </h2>
              <FloorList label={t('lines.title')}>
                {open.map((line) => {
                  const counted = arrival.counts[line.id] ?? 0
                  const room = roomOf(line, arrival)
                  return (
                    <FloorListRow
                      key={line.id}
                      icon={<Shirt />}
                      tone={counted === line.expected ? 'success' : counted > 0 ? 'info' : 'neutral'}
                      selected={model.lastLineId === line.id}
                      title={
                        <>
                          <span className="fw-floor-code">{t('line.number', { seq: line.seq })}</span> · {lineName(line)}
                        </>
                      }
                      meta={[line.serial ? t('line.serial', { code: line.serial }) : null, line.batchNumber ? t('line.batch', { code: line.batchNumber }) : null, reasonOf(line), line.ppe ? t('line.ppe') : null].filter(Boolean).join(' · ')}
                      status={counted === line.expected ? t('line.complete') : line.receivedQuantity > 0 ? t('line.partly', { count: line.receivedQuantity }) : t('line.waiting')}
                      count={`${counted} / ${line.expected}`}
                      countLabel={t('line.countLabel', { counted, expected: line.expected })}
                      heldReason={room === 0 ? t('line.full') : null}
                      onPress={() => send({ type: 'count', lineId: line.id, delta: 1 })}
                    />
                  )
                })}
              </FloorList>
              <ListFooter
                count={t('lines.count', { count: open.length })}
                keys={[
                  { key: 'Tab', does: shared('keys.tab') },
                  { key: 'Enter', does: t('keys.count') },
                  { key: 'Esc', does: shared('keys.escape') },
                ]}
              />
            </section>
            {pieces > 0 && pieces < open.reduce((sum, line) => sum + line.expected, 0) ? <TaskLine tone="info" icon={<ClipboardList />}>{t('lines.partial')}</TaskLine> : null}
          </>
        )}
      </div>
    )
    actions =
      open.length === 0
        ? [
            { label: t('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'toParcel' }) },
            toGrade(dock).length > 0 && model.mayGrade ? { label: t('action.toGrade'), icon: <Star />, onPress: () => send({ type: 'toGrade' }) } : { label: t('action.toRoute'), icon: <MapPin />, onPress: () => send({ type: 'toRoute' }) },
          ]
        : [
            { label: t('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'toParcel' }) },
            { label: t('action.countAll'), icon: <CheckCheck />, onPress: () => send({ type: 'countAll' }) },
            {
              label: t('action.receive'),
              icon: <PackageCheck />,
              heldReason: model.busy === 'receive' ? t('held.busy') : (offlineHeld ?? (held ? t(`held.${held}`) : null)),
              onPress: () => send({ type: 'receive' }),
            },
          ]
  } else if (model.stage === 'grade') {
    const line = lineToGrade(dock, model.gradeLineId ?? null)
    const waiting = toGrade(dock)
    if (!model.mayGrade || !line) {
      body = (
        <div className="fw-floor-stack">
          {rmaCard()}
          <FloorState tone={line ? 'warning' : 'success'} icon={line ? <ShieldAlert /> : <CheckCheck />} title={line ? t('grade.noPermission.title') : t('grade.none.title')} text={line ? t('grade.noPermission.body') : t('grade.none.body')} />
        </div>
      )
      actions = [{ label: t('action.toRoute'), icon: <MapPin />, onPress: () => send({ type: 'toRoute' }) }]
    } else {
      const picked = model.grade ?? null
      const suggestion = picked ? suggestionOf(line, picked) : null
      const reasons: ReasonTile[] = GRADES.map((grade) => ({ id: grade, label: t(`grade.${grade}`), hint: t(`grade.hint.${grade}`), icon: GRADE_ICON[grade], tone: GRADE_TONE[grade] }))
      body = (
        <div className="fw-floor-stack">
          <TaskCard
            icon={<Shirt />}
            type={t('grade.garment', { seq: line.seq })}
            code={lineName(line)}
            status={line.ppe ? t('line.ppe') : null}
            statusTone="warning"
            big={{ value: String(line.receivedQuantity), label: t('grade.pieces', { count: line.receivedQuantity }) }}
            facts={[
              { label: t('grade.reason'), value: reasonOf(line) },
              ...(line.serial ? [{ label: t('grade.serial'), value: line.serial }] : []),
              ...(line.batchNumber ? [{ label: t('grade.batch'), value: line.batchNumber }] : []),
              { label: t('grade.return'), value: dock.number },
            ]}
          />
          <ReasonGrid label={t('grade.question')} reasons={reasons} value={picked} onChange={(id) => send({ type: 'grade', grade: id as ReturnGrade })} words={reasonWords} locale={intl} />
          {suggestion ? (
            <div className="fw-floor-stack" aria-live="polite">
              <TaskLine tone="info" icon={<ClipboardList />}>
                {t('grade.suggested', { outcome: t(`outcome.${suggestion.outcome}`) })}
              </TaskLine>
              {suggestion.held ? (
                <TaskLine tone="warning" icon={<ShieldAlert />}>
                  {t(`restockHeld.${suggestion.held}`)}
                </TaskLine>
              ) : null}
              <p className="fw-floor-muted">{t('grade.officeDecides')}</p>
            </div>
          ) : (
            <p className="fw-floor-muted">{t('grade.pickFirst')}</p>
          )}
          <div className="fw-returns-row-inline">
            <FloorButton size="md" variant="secondary" icon={<Camera />} heldReason={(model.linePhotos ?? 0) >= MAX_PHOTOS ? t('photo.full', { count: MAX_PHOTOS }) : null} onClick={() => send({ type: 'camera', target: 'line' })}>
              {t('grade.photo')}
            </FloorButton>
            <span className="fw-floor-muted">{(model.linePhotos ?? 0) > 0 ? t('grade.photos', { count: model.linePhotos ?? 0 }) : t('grade.noPhotos')}</span>
          </div>
          {waiting.length > 1 ? (
            <section className="fw-floor-stack" aria-labelledby="fw-returns-waiting">
              <h2 id="fw-returns-waiting" className="fw-floor-subtitle">
                {t('grade.waiting', { count: waiting.length })}
              </h2>
              <FloorList label={t('grade.waiting', { count: waiting.length })}>
                {waiting.map((row) => (
                  <FloorListRow key={row.id} icon={<Shirt />} selected={row.id === line.id} title={`${t('line.number', { seq: row.seq })} · ${lineName(row)}`} count={row.receivedQuantity} countLabel={t('grade.pieces', { count: row.receivedQuantity })} onPress={() => send({ type: 'pickLine', lineId: row.id })} />
                ))}
              </FloorList>
            </section>
          ) : null}
        </div>
      )
      actions = [
        { label: t('action.toRoute'), icon: <MapPin />, onPress: () => send({ type: 'toRoute' }) },
        { label: t('action.confirmGrade'), icon: <Check />, heldReason: model.busy === 'grade' ? t('held.busy') : (offlineHeld ?? (picked ? null : t('held.grade'))), onPress: () => send({ type: 'confirmGrade' }) },
      ]
    }
  } else if (model.stage === 'route') {
    const where = placeOf(dock)
    body = (
      <div className="fw-floor-stack">
        <TaskCard
          icon={<MapPin />}
          type={t('route.type')}
          code={where ? where.code : t('route.noPlace')}
          status={model.placeOk ? t('route.confirmed') : t('route.toConfirm')}
          statusTone={model.placeOk ? 'success' : 'info'}
          facts={[...(where && where.name !== where.code ? [{ label: t('route.name'), value: where.name }] : []), { label: t('route.return'), value: dock.number }, { label: t('route.why'), value: t('route.inspection') }]}
        />
        {where ? scanField(t('route.scanLabel'), t('route.scanHint', { code: where.code })) : <TaskLine tone="warning" icon={<CircleAlert />}>{t('route.noPlaceBody')}</TaskLine>}
        {model.placeOk ? (
          <TaskLine tone="success" icon={<Check />}>
            {t('route.placed', { code: where?.code ?? '' })}
          </TaskLine>
        ) : null}
        <TaskLine tone="info" icon={<Ban />}>
          {t('route.noLabel')}
        </TaskLine>
        {model.photosFailed ? (
          <TaskLine tone="warning" icon={<Camera />}>
            {t('photo.failed', { count: model.photosFailed })}
          </TaskLine>
        ) : null}
      </div>
    )
    actions = [
      { label: t('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'toGrade' }) },
      { label: t('action.finish'), icon: <CheckCheck />, heldReason: where && !model.placeOk ? t('held.place') : null, onPress: () => send({ type: 'finish' }) },
    ]
  } else {
    const done = model.done ?? { pieces: 0, graded: 0 }
    body = (
      <div className="fw-floor-stack">
        <FloorState tone="success" icon={<CheckCheck />} title={t('done.title', { number: dock.number })} text={t('done.body', { pieces: done.pieces, graded: done.graded })} />
        {model.photosFailed ? (
          <TaskLine tone="warning" icon={<Camera />}>
            {t('photo.failed', { count: model.photosFailed })}
          </TaskLine>
        ) : null}
        <TaskLine tone="info" icon={<ClipboardList />}>
          {t('done.office')}
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
