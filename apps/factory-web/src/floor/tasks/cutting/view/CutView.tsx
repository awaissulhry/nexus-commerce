'use client'

import type { ReactNode } from 'react'
import { ArrowLeft, Ban, Camera, CircleAlert, CircleCheck, ClipboardList, CloudOff, House, Layers, MapPin, RotateCcw, Ruler, ScanLine, Scissors, ShieldAlert, ShieldCheck, Undo2 } from 'lucide-react'
import { FloorActionBar, FloorButton, FloorList, FloorListRow, QuantityPad, ScanInput, SizeButtons, type CameraScanner, type FloorActions } from '@nexus/ui/floor'
import type { CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatNumber, formatTime } from '../../../../lib/i18n/format'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import type { TaskProblem } from '../../shared/task-api'
import { HeldLine, ListFooter, ProblemState, TaskCard, TaskLine, UndoStrip, type TickState } from '../../shared/view/TaskParts'
import type { CutWorkOrderRow, RemnantPlace } from '../api'
import { areaPlain, convertArea, isAreaUom, otherUnitOf, type AnywayHeld, type AreaUom, type CheckWarning, type CutWarningKind, type HideChecks, type RemnantProblem, type ShadeMatch, type SizeState, type ThicknessView } from '../model'
import { AnywayDialog, type AnywayAction, type AnywayModel } from './AnywayDialog'
import { kindsWords, lotWords, mmWords, rangeWords, thicknessWords, warningWords } from './check-words'
import { HidePhoto } from './HidePhoto'
import '../cutting.css'

/**
 * SCR-094 — Hide check & cut log (design floor.hidecut; MES-051, MES-056, MES-058, SCM-194, SCM-253) inside the floor
 * frame, one step at a time:
 *
 *   workOrder  which work order the pieces are for: scan its traveller, or pick it from the released ones at this site
 *   scan       scan the hide's tag (the work order stays as a chip line with Change; the last cut on its undo strip)
 *   check      the hide's card — area in its unit and the other beside, grade big, thickness, shade and dye batch, lot,
 *              state, defects, the shade information — then the size buttons at once: "+ 1 set" (Enter) logs one garment
 *              set of the picked size into the tablet's draft ("From this hide: 52 × 2 · 54 × 1"; Undo last set)
 *   done       Hide done: two big choices, "No remnant · done" or the remnant's area
 *   remnant    the remnant's area on the pad (decimals, the other unit beside, at most what is left), where it goes, and
 *              the area used (= left − remnant, shown, never typed)
 *
 * A refusal is a full-screen state with the reason and what to do (the lot on hold: "Do not cut. Put it back on …").
 * The cut is saved on this tablet first and sent by the queue (two ticks). No money anywhere (the hide's cost is never
 * shown on the floor). One view model, no fetching.
 *
 * B-W2b-110 (on B-W2b-103's API) adds to the check:
 *   the hide check in depth  shade lot against the work order's, the reserved hides, thickness against the leather's range,
 *              the pieces' minimum grade, each in words on the card; a warning no lead passed STOPS on the card (never a
 *              tap on a size): the size buttons pick the first set, the main action is "Cut anyway"
 *   Cut anyway   the pop-up: what differs, a reason tile, the lead's badge or name and PIN; online only (held with the
 *              reason offline or while this work order's cuts wait to be sent); the signature records the first set
 *   measure      the thickness at the table on a pad (mm): it goes with every cut of the hide this visit
 *   photo        the photo of the hide on the table (DS PhotoCapture, outline guide, faces out); optional per site
 */

export type CutStage = 'workOrder' | 'scan' | 'check' | 'done' | 'remnant' | 'measure' | 'photo'

/** B-W2b-110: the hide check of the work order at the table, as the card shows it (the table measure counted in). */
export interface HideCheckModel {
  readonly workOrderNumber: string
  /** Every warning (standing ones stop the card; passed ones are said as information). */
  readonly warnings: readonly CheckWarning[]
  readonly standing: readonly CutWarningKind[]
  readonly passed: readonly CutWarningKind[]
  readonly shade: HideChecks['shade']
  readonly thickness: ThicknessView
  readonly grade: HideChecks['grade']
  readonly reserved: HideChecks['reserved']
  /** The thickness measured at this table for this hide this visit (mm). */
  readonly measuredMm: string | null
  /** The leather has a thickness range: "Measure here" is offered. */
  readonly measurable: boolean
}

/** B-W2b-110: the photo of the hide on the card. */
export interface HidePhotoModel {
  /** A photo was taken and confirmed this visit: it goes with the next cut of the hide. */
  readonly taken: boolean
  /** The site asks one before cutting (no setting yet: false everywhere). */
  readonly required: boolean
  /** The photo needs the network (it is sent at once, never queued). */
  readonly held: 'offline' | null
}

export interface WorkOrderChip {
  readonly id: string
  readonly number: string
  readonly style: string
  readonly colours: readonly string[]
}

export interface HideCardModel {
  readonly code: string
  readonly item: string
  readonly colour: string | null
  /** As measured, in its unit. */
  readonly area: string
  readonly areaUom: string
  readonly grade: string | null
  readonly thicknessMm: string | null
  readonly shade: string | null
  readonly dyeBatch: string | null
  readonly lotCode: string
  readonly state: string
  readonly defects: string | null
  /** What the hide can still give this work order, in the base unit. */
  readonly left: string
  readonly baseUom: string
  /** Not at the work order yet: the cut issues it first (SCM-215). */
  readonly issuedByCut: boolean
  readonly match: ShadeMatch
  /** The hide's last cut: when, for which work order, at which table (never who). */
  readonly lastCut: { readonly at: string; readonly workOrderNumber: string; readonly station: string | null } | null
  /** B-W2b-110: the hide check (null: an office without it; the W1 dye batch information shows instead). */
  readonly checks?: HideCheckModel | null
  readonly photo?: HidePhotoModel | null
  /** B-W2b-110: scanned by a remnant's RM tag (B-W2b-100): the tag, said on the card. */
  readonly remnantTag?: string | null
}

export type CutRefusalModel =
  /** The lot may not be cut (Cr VI pending or failed, on hold, blocked, rejected): the lot's words, where to put it back. */
  | { readonly kind: 'lot'; readonly code: string; readonly reason: string; readonly lotCode: string; readonly words: string | null; readonly place: string | null }
  | { readonly kind: 'usedUp'; readonly code: string; readonly state: string; readonly lastCut: { readonly at: string } | null }
  /** The work order may not cut this hide (the API's refusal, its code and words). */
  | { readonly kind: 'workOrder'; readonly code: string; readonly number: string; readonly refusal: { readonly code: string; readonly message: string } }
  /** No open work order here cuts this hide's leather (or not the one at the table). */
  | { readonly kind: 'noWorkOrder'; readonly code: string; readonly number: string | null }
  /** Offline, and the tablet has no copy of it. */
  | { readonly kind: 'notOnTablet'; readonly code: string }
  | { readonly kind: 'problem'; readonly problem: TaskProblem; readonly code?: string | null }

export interface RemnantModel {
  /** On the pad, in `uom`; null: nothing typed. */
  readonly value: number | null
  readonly uom: AreaUom
  readonly max: number
  /** What is left for the work order (`uom`). */
  readonly left: string
  /** The area this Hide done uses (`uom`): left − remnant. */
  readonly used: string
  readonly problem: RemnantProblem
  /** Where it may go: null while loading. */
  readonly places: readonly RemnantPlace[] | null
  readonly placeId: string | null
  /** Why the places are not listed (no permission to see the site's locations, no network). */
  readonly placesHeld?: 'noPermission' | 'unavailable' | null
  /** B-W2b-110: the smallest remnant kept, in `uom` (B-W2b-100: a smaller piece is waste). */
  readonly minimum?: string | null
}

export interface LastCut {
  /** "HD-… · 52 × 2 · 54 × 1". */
  readonly text: string
  readonly ticks: TickState
  /** The refusal in words, when the office refused it. */
  readonly refused?: string | null
  /** Where the remnant goes ("R2"). */
  readonly place?: string | null
  /** Undo of the recorded cut (online only): null hides it; a reason holds it. */
  readonly undo?: { readonly held: 'offline' | 'notRecorded' | null } | null
}

export interface CutViewModel {
  frame: FrameModel
  stage: CutStage
  /** Without `production.cut`: nothing to do here. */
  noPermission?: boolean
  /** The pick step's rows (null while loading). */
  workOrders?: readonly CutWorkOrderRow[] | null
  workOrder?: WorkOrderChip | null
  /** A code being looked up. */
  loading?: string | null
  hide?: HideCardModel | null
  sizes?: readonly SizeState[]
  picked?: string | null
  /** The draft: sets per size. */
  draft?: readonly { readonly label: string; readonly sets: number }[]
  remnant?: RemnantModel | null
  last?: LastCut | null
  refusal?: CutRefusalModel | null
  /** Sets not saved yet: confirm before leaving the hide. */
  confirm?: { readonly sets: number } | null
  /** The code scanned is not a hide tag. */
  wrongType?: boolean
  /** Read from this tablet's memory (offline): when it was read. */
  asOf?: string | null
  /** A line in the job (an undo done, an undo refused). */
  notice?: { readonly tone: 'success' | 'warning' | 'danger' | 'info'; readonly text: string } | null
  timeZone?: string
  /** B-W2b-110: the card stops on warnings no lead passed: "Cut anyway" (held with the reason) instead of "+ 1 set". */
  stopped?: { readonly held: AnywayHeld; readonly waiting: number } | null
  /** B-W2b-110: "+ 1 set" waits for the photo the site asks for. */
  photoFirst?: boolean
  /** B-W2b-110: the thickness at the table (stage `measure`). */
  measure?: { readonly value: number | null; readonly problem: 'empty' | 'invalid' | null } | null
  /** B-W2b-110: the photo step (stage `photo`): sending, or the last try failed. */
  photoStep?: { readonly sending: boolean; readonly failed: boolean; readonly held: 'offline' | null } | null
  /** B-W2b-110: the "Cut anyway?" pop-up. */
  anyway?: AnywayModel | null
}

export type CutAction =
  | { type: 'scan'; code: string }
  | { type: 'pickWorkOrder'; id: string }
  | { type: 'changeWorkOrder' }
  | { type: 'confirmSave' }
  | { type: 'confirmCancel' }
  | { type: 'pickSize'; id: string }
  | { type: 'addSet' }
  | { type: 'undoSet' }
  | { type: 'hideDone' }
  | { type: 'noRemnant' }
  | { type: 'remnant' }
  | { type: 'remnantValue'; value: number | null }
  | { type: 'pickPlace'; id: string }
  | { type: 'saveRemnant' }
  | { type: 'back' }
  | { type: 'retry' }
  | { type: 'undoCut' }
  | { type: 'home' }
  // B-W2b-110
  | { type: 'openAnyway' }
  | { type: 'openMeasure' }
  | { type: 'measureValue'; value: number | null }
  | { type: 'measureSave' }
  | { type: 'measureClear' }
  | { type: 'openPhoto' }
  | { type: 'photoTaken'; photo: CapturedPhoto }
  | AnywayAction

export interface CutViewProps {
  model: CutViewModel
  onAction?: (action: CutAction) => void
  onFrame?: (action: FrameAction) => void
  camera?: CameraScanner
}

const UNIT_WORD: Readonly<Record<string, string>> = { M2: 'm²', DM2: 'dm²', FT2: 'ft²' }
export const unitWord = (uom: string): string => UNIT_WORD[uom] ?? uom

/** The cut refusal codes this screen has its own words for (else the API's sentence). B-W2b-110: the table's warnings and the lead's signature (B-W2b-103), a remnant under the minimum (B-W2b-100). */
export const CUT_WORDS = ['WORK_ORDER_NOT_OPEN', 'NOT_AT_WORK_ORDER', 'NOTHING_LEFT', 'FLOOR_NOT_READY', 'CR_VI_PENDING', 'CR_VI_FAILED', 'QUALITY_HOLD', 'BLOCKED', 'REJECTED', 'CUT_WARNING', 'LEAD_PIN_WRONG', 'LEAD_IS_CUTTER', 'NOT_A_LEAD', 'LEAD_NOTE_MISSING', 'REMNANT_TOO_SMALL'] as const

export function CutView({ model, onAction, onFrame, camera }: CutViewProps) {
  const t = useT('floor-cutting')
  const shared = useT('floor-tasks')
  const locale = useLocale()
  const send = (action: CutAction) => onAction?.(action)
  const place = { locale, timeZone: model.timeZone }
  const number = (value: string) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? formatNumber(parsed, locale, { maximumFractionDigits: 2 }) : value
  }
  const area = (value: string, uom: string) => `${number(value)} ${unitWord(uom)}`
  const both = (value: string, uom: string) => {
    if (!isAreaUom(uom)) return area(value, uom)
    const other = otherUnitOf(uom)
    const converted = convertArea(value, uom, other)
    return converted ? `${area(value, uom)} · ${area(converted, other)}` : area(value, uom)
  }
  const scanField = (label: string, hint: string) => (
    <ScanInput
      label={label}
      hint={hint}
      scannedLabel={(code) => t('scan.read', { code })}
      keyboardLabel={t('scan.type')}
      disabled={Boolean(model.loading)}
      camera={camera ? { scanner: camera, startLabel: t('scan.camera.start'), stopLabel: t('scan.camera.stop'), errorLabel: t('scan.camera.error') } : undefined}
      onScan={(code) => send({ type: 'scan', code })}
    />
  )

  let actions: FloorActions | null = null
  let body: ReactNode

  if (model.noPermission) {
    actions = [{ label: shared('action.home'), icon: <House />, onPress: () => send({ type: 'home' }) }]
    body = <FloorState tone="warning" icon={<Ban />} title={t('noPermission.title')} text={t('noPermission.body')} alert />
  } else if (model.refusal) {
    const another = { label: t('action.scanAnother'), icon: <ScanLine />, onPress: () => send({ type: 'back' }) }
    actions = model.refusal.kind === 'problem' && model.refusal.problem.kind !== 'refused' ? [another, { label: shared('action.retry'), icon: <RotateCcw />, onPress: () => send({ type: 'retry' }) }] : [another]
    body = <Refusal refusal={model.refusal} t={t} words={(code) => wordsOf(t, code)} place={place} />
  } else if (model.stage === 'workOrder') {
    body = (
      <div className="fw-floor-stack">
        {scanField(t('workOrder.scanLabel'), t('workOrder.scanHint'))}
        {model.asOf ? <HeldLine text={shared('asOf', { time: formatTime(model.asOf, place) })} /> : null}
        {model.loading ? <Looking code={model.loading} t={t} /> : null}
        <section className="fw-floor-stack" aria-labelledby="fw-cut-wo-title">
          <h2 id="fw-cut-wo-title" className="fw-floor-section-title">
            <span className="fw-floor-inline-icon" aria-hidden="true">
              <ClipboardList />
            </span>
            {t('workOrder.title')}
          </h2>
          {model.workOrders === null || model.workOrders === undefined ? (
            <p className="fw-floor-muted" aria-busy="true">
              {t('workOrder.loading')}
            </p>
          ) : model.workOrders.length === 0 ? (
            <FloorState tone="info" icon={<ClipboardList />} title={t('workOrder.empty.title')} text={t('workOrder.empty.body')} />
          ) : (
            <>
              <FloorList label={t('workOrder.title')}>
                {model.workOrders.map((row) => (
                  <FloorListRow
                    key={row.id}
                    icon={<Scissors />}
                    tone={row.toCut > 0 ? 'primary' : 'neutral'}
                    title={
                      <span>
                        <span className="fw-floor-code">{row.number}</span> · {row.style.name}
                      </span>
                    }
                    meta={[row.colourways.join(', '), row.sizesLeft.length > 0 ? t('workOrder.sizesLeft', { sizes: row.sizesLeft.join(', ') }) : t('workOrder.allCut'), row.dueDate ? t('workOrder.due', { date: formatDate(`${row.dueDate}T12:00:00Z`, place) }) : null]
                      .filter(Boolean)
                      .join(' · ')}
                    count={row.toCut}
                    countLabel={t('workOrder.toCut')}
                    onPress={() => send({ type: 'pickWorkOrder', id: row.id })}
                  />
                ))}
              </FloorList>
              <ListFooter
                count={t('workOrder.count', { count: model.workOrders.length })}
                keys={[
                  { key: 'Tab', does: shared('keys.tab') },
                  { key: 'Enter', does: shared('keys.enter') },
                  { key: 'Esc', does: shared('keys.escape') },
                ]}
              />
            </>
          )}
        </section>
      </div>
    )
  } else {
    const chip = model.workOrder ? <WorkOrderLine chip={model.workOrder} t={t} onChange={() => send({ type: 'changeWorkOrder' })} /> : null
    const lastStrip = model.last ? (
      <UndoStrip
        text={model.last.place ? `${model.last.text} · ${t('last.place', { place: model.last.place })}` : model.last.text}
        ticks={model.last.ticks}
        onUndo={model.last.undo ? () => send({ type: 'undoCut' }) : null}
        undoHeld={model.last.undo?.held ? t(`last.undoHeld.${model.last.undo.held}`) : null}
        undoLabel={t('last.undo')}
      />
    ) : null
    const notices = (
      <>
        {model.notice ? (
          <TaskLine tone={model.notice.tone} icon={model.notice.tone === 'success' ? <CircleCheck /> : <CircleAlert />}>
            {model.notice.text}
          </TaskLine>
        ) : null}
        {model.last?.refused ? (
          <TaskLine tone="danger" icon={<CircleAlert />} alert>
            {t('last.refused', { why: model.last.refused })}
          </TaskLine>
        ) : null}
        {model.asOf ? <HeldLine text={shared('asOf', { time: formatTime(model.asOf, place) })} /> : null}
      </>
    )
    if (model.stage === 'scan') {
      body = (
        <div className="fw-floor-stack">
          {chip}
          {lastStrip}
          {notices}
          {scanField(t('scan.label'), t('scan.hint'))}
          {model.wrongType ? (
            <TaskLine tone="danger" icon={<CircleAlert />} alert>
              {t('scan.wrongType')}
            </TaskLine>
          ) : null}
          {model.loading ? <Looking code={model.loading} t={t} /> : <p className="fw-floor-lead">{t('scan.empty')}</p>}
        </div>
      )
    } else if (model.stage === 'check' && model.hide && model.stopped) {
      // B-W2b-110: warnings no lead passed stop on the card. The size buttons pick the first set; the lead's signature records it.
      const sizes = model.sizes ?? []
      const picked = sizes.find((size) => size.id === model.picked) ?? null
      const stopped = model.stopped
      const held = anywayHeldWords(t, stopped.held, stopped.waiting, picked?.label ?? '')
      actions = [
        { label: t('action.scanAnother'), icon: <ScanLine />, onPress: () => send({ type: 'back' }), variant: 'secondary' },
        { label: t('anyway.open'), icon: <ShieldAlert />, onPress: () => send({ type: 'openAnyway' }), variant: 'warning', heldReason: held },
      ]
      body = (
        <div className="fw-floor-stack">
          {chip}
          {notices}
          <div className="fw-task-split">
            <HideCard hide={model.hide} t={t} both={both} area={area} place={place} send={send} />
            <section className="fw-floor-stack fw-cut-stop" aria-labelledby="fw-cut-stop-title">
              <h2 id="fw-cut-stop-title" className="fw-floor-section-title">
                <span className="fw-floor-inline-icon" aria-hidden="true">
                  <ShieldAlert />
                </span>
                {t('anyway.title')}
              </h2>
              <p className="fw-floor-lead">{t('anyway.lead')}</p>
              {sizes.length === 0 ? (
                <FloorState tone="info" icon={<Layers />} title={t('sets.none.title')} text={t('sets.none.body')} />
              ) : (
                <SizeButtons
                  label={t('anyway.firstSet')}
                  sizes={sizes.map((size) => ({ id: size.id, label: size.label, remaining: size.remaining, heldReason: size.allCut ? t('sets.allCut', { size: size.label }) : null }))}
                  value={model.picked ?? null}
                  onChange={(id) => send({ type: 'pickSize', id })}
                  remainingLabel={(count) => t('sets.remaining', { count })}
                  doneLabel={t('sets.done')}
                />
              )}
              {held ? <HeldLine text={held} /> : null}
              <p className="fw-floor-muted">{t('anyway.another')}</p>
            </section>
          </div>
        </div>
      )
    } else if (model.stage === 'check' && model.hide) {
      const sizes = model.sizes ?? []
      const picked = sizes.find((size) => size.id === model.picked) ?? null
      const draft = model.draft ?? []
      const setsHeld = model.photoFirst ? t('photo.heldFirst') : !picked ? t('sets.pickSize') : picked.allCut ? t('sets.allCut', { size: picked.label }) : null
      actions = [
        { label: t('action.hideDone'), icon: <CircleCheck />, onPress: () => send({ type: 'hideDone' }), variant: 'secondary' },
        // The label carries its own "+" (design: "+ 1 set"): no second plus as an icon.
        { label: t('action.addSet'), onPress: () => send({ type: 'addSet' }), heldReason: setsHeld },
      ]
      body = (
        <div className="fw-floor-stack">
          {chip}
          {notices}
          <div className="fw-task-split">
            <HideCard hide={model.hide} t={t} both={both} area={area} place={place} send={send} />
            <section className="fw-floor-stack" aria-labelledby="fw-cut-sets-title">
              <h2 id="fw-cut-sets-title" className="fw-floor-section-title">
                <span className="fw-floor-inline-icon" aria-hidden="true">
                  <Layers />
                </span>
                {t('sets.title')}
              </h2>
              {sizes.length === 0 ? (
                <FloorState tone="info" icon={<Layers />} title={t('sets.none.title')} text={t('sets.none.body')} />
              ) : (
                <SizeButtons
                  label={t('sets.sizes')}
                  sizes={sizes.map((size) => ({ id: size.id, label: size.label, remaining: size.remaining, heldReason: size.allCut ? t('sets.allCut', { size: size.label }) : null }))}
                  value={model.picked ?? null}
                  onChange={(id) => send({ type: 'pickSize', id })}
                  remainingLabel={(count) => t('sets.remaining', { count })}
                  doneLabel={t('sets.done')}
                />
              )}
              <div className="fw-cut-draft" role="status">
                <span className="fw-cut-draft-text">
                  {draft.length > 0 ? t('sets.fromHide', { lines: draft.map((line) => `${line.label} × ${line.sets}`).join(' · ') }) : t('sets.nothingYet')}
                </span>
                {draft.length > 0 ? (
                  <FloorButton size="md" variant="secondary" icon={<Undo2 />} onClick={() => send({ type: 'undoSet' })}>
                    {t('sets.undo')}
                  </FloorButton>
                ) : null}
              </div>
              <p className="fw-floor-muted">{t('sets.draftNote')}</p>
            </section>
          </div>
        </div>
      )
    } else if (model.stage === 'done' && model.hide) {
      actions = [{ label: shared('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }) }]
      const sets = (model.draft ?? []).reduce((sum, line) => sum + line.sets, 0)
      body = (
        <div className="fw-floor-stack">
          {chip}
          {notices}
          <section className="fw-floor-stack" aria-labelledby="fw-cut-done-title">
            <h2 id="fw-cut-done-title" className="fw-floor-section-title">
              <span className="fw-floor-inline-icon" aria-hidden="true">
                <CircleCheck />
              </span>
              {t('done.title', { code: model.hide.code })}
            </h2>
            <p className="fw-floor-lead">
              {t('done.summary', { count: sets, left: both(model.hide.left, model.hide.baseUom) })}
              {sets > 0 ? ` ${t('sets.fromHide', { lines: (model.draft ?? []).map((line) => `${line.label} × ${line.sets}`).join(' · ') })}` : ''}
            </p>
            <div className="fw-cut-choices">
              <FloorButton size="lg" variant="primary" icon={<CircleCheck />} block onClick={() => send({ type: 'noRemnant' })}>
                {t('done.noRemnant')}
              </FloorButton>
              <FloorButton size="lg" variant="secondary" icon={<Scissors />} block onClick={() => send({ type: 'remnant' })}>
                {t('done.remnant')}
              </FloorButton>
            </div>
            <p className="fw-floor-muted">{t('done.noRemnantMeans', { used: both(model.hide.left, model.hide.baseUom) })}</p>
          </section>
        </div>
      )
    } else if (model.stage === 'remnant' && model.hide && model.remnant) {
      const remnant = model.remnant
      const other = otherUnitOf(remnant.uom)
      const otherValue = remnant.value !== null ? convertArea(String(remnant.value), remnant.uom, other) : null
      const tooSmall = remnant.minimum ? t('remnant.tooSmall', { min: area(remnant.minimum, remnant.uom) }) : null
      const held =
        remnant.problem === 'empty'
          ? t('remnant.held.empty')
          : remnant.problem === 'tooLarge'
            ? t('remnant.tooLarge', { left: area(remnant.left, remnant.uom) })
            : remnant.problem === 'tooSmall'
              ? tooSmall
              : !remnant.placeId
                ? t('remnant.held.place')
                : null
      actions = [
        { label: shared('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }) },
        { label: t('remnant.save'), icon: <CircleCheck />, onPress: () => send({ type: 'saveRemnant' }), heldReason: held },
      ]
      const decimalSeparator = locale === 'it' ? ',' : '.'
      body = (
        <div className="fw-floor-stack">
          {chip}
          {notices}
          <div className="fw-task-split">
            <section className="fw-floor-stack" aria-labelledby="fw-cut-remnant-title">
              <h2 id="fw-cut-remnant-title" className="fw-floor-section-title">
                <span className="fw-floor-inline-icon" aria-hidden="true">
                  <Scissors />
                </span>
                {t('remnant.title')}
              </h2>
              <QuantityPad
                label={t('remnant.area')}
                value={remnant.value}
                onChange={(value) => send({ type: 'remnantValue', value })}
                unit={unitWord(remnant.uom)}
                min={0.01}
                max={remnant.max}
                decimals={2}
                decimalSeparator={decimalSeparator}
                separatorLabel={t('remnant.separator')}
                decrementLabel={t('pad.less')}
                incrementLabel={t('pad.more')}
                clearLabel={t('pad.clear')}
                backLabel={t('pad.back')}
                emptyLabel={t('remnant.held.empty')}
                rangeLabel={(_min, max) => t('remnant.range', { max: max === undefined ? '—' : formatNumber(max, locale, { maximumFractionDigits: 2 }) })}
                message={remnant.problem === 'tooLarge' ? t('remnant.tooLarge', { left: area(remnant.left, remnant.uom) }) : remnant.problem === 'tooSmall' && tooSmall ? tooSmall : otherValue ? t('remnant.other', { other: area(otherValue, other) }) : undefined}
                messageTone={remnant.problem === 'tooLarge' || remnant.problem === 'tooSmall' ? 'danger' : 'info'}
                autoFocus
              />
              <p className="fw-cut-used">{t('remnant.used', { used: both(remnant.used, remnant.uom), left: both(remnant.left, remnant.uom) })}</p>
            </section>
            <section className="fw-floor-stack" aria-labelledby="fw-cut-place-title">
              <h2 id="fw-cut-place-title" className="fw-floor-section-title">
                <span className="fw-floor-inline-icon" aria-hidden="true">
                  <MapPin />
                </span>
                {t('remnant.where')}
              </h2>
              {remnant.placesHeld ? (
                <HeldLine text={t(`remnant.placesHeld.${remnant.placesHeld}`)} />
              ) : remnant.places === null ? (
                <p className="fw-floor-muted" aria-busy="true">
                  {t('remnant.placesLoading')}
                </p>
              ) : (
                <>
                  <FloorList label={t('remnant.where')}>
                    {remnant.places.map((entry) => (
                      <FloorListRow
                        key={entry.id}
                        icon={<MapPin />}
                        tone={entry.id === remnant.placeId ? 'success' : 'neutral'}
                        title={<span className="fw-floor-code">{entry.code}</span>}
                        meta={entry.name}
                        status={entry.id === remnant.placeId ? t('remnant.picked') : undefined}
                        selected={entry.id === remnant.placeId}
                        onPress={() => send({ type: 'pickPlace', id: entry.id })}
                      />
                    ))}
                  </FloorList>
                  <ListFooter
                    count={t('remnant.placesCount', { count: remnant.places.length })}
                    keys={[
                      { key: 'Tab', does: shared('keys.tab') },
                      { key: 'Enter', does: t('remnant.keyPick') },
                    ]}
                  />
                </>
              )}
              <p className="fw-floor-muted">{t('remnant.tag')}</p>
            </section>
          </div>
        </div>
      )
    } else if (model.stage === 'measure' && model.hide && model.measure) {
      // B-W2b-110 (MES-064): the thickness measured at the table, in mm; it goes with every cut of this hide this visit.
      const measure = model.measure
      const checks = model.hide.checks ?? null
      const range = checks ? rangeWords(t, checks.thickness, locale) : null
      const held = measure.problem === 'empty' ? t('measure.held.empty') : measure.problem === 'invalid' ? t('measure.held.invalid') : null
      actions = [
        { label: shared('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }) },
        { label: t('measure.save'), icon: <CircleCheck />, onPress: () => send({ type: 'measureSave' }), heldReason: held },
      ]
      body = (
        <div className="fw-floor-stack">
          {chip}
          {notices}
          <section className="fw-floor-stack fw-cut-measure" aria-labelledby="fw-cut-measure-title">
            <h2 id="fw-cut-measure-title" className="fw-floor-section-title">
              <span className="fw-floor-inline-icon" aria-hidden="true">
                <Ruler />
              </span>
              {t('measure.title', { code: model.hide.code })}
            </h2>
            {range ? <p className="fw-floor-lead">{t('measure.spec', { range })}</p> : null}
            {checks && checks.thickness.source === 'HIDE' && checks.thickness.valueMm ? <p className="fw-floor-muted">{t('measure.recorded', { value: mmWords(checks.thickness.valueMm, locale) })}</p> : null}
            <QuantityPad
              label={t('measure.value')}
              value={measure.value}
              onChange={(value) => send({ type: 'measureValue', value })}
              unit="mm"
              min={0.01}
              max={99.99}
              decimals={2}
              decimalSeparator={locale === 'it' ? ',' : '.'}
              separatorLabel={t('remnant.separator')}
              decrementLabel={t('pad.less')}
              incrementLabel={t('pad.more')}
              clearLabel={t('pad.clear')}
              backLabel={t('pad.back')}
              emptyLabel={t('measure.held.empty')}
              rangeLabel={() => t('measure.range')}
              message={held ?? undefined}
              messageTone={measure.problem === 'invalid' ? 'danger' : 'info'}
              autoFocus
            />
            <p className="fw-floor-muted">{t('measure.goes')}</p>
            {checks?.measuredMm ? (
              <FloorButton size="md" variant="quiet" icon={<RotateCcw />} onClick={() => send({ type: 'measureClear' })}>
                {t('measure.clear', { value: mmWords(checks.measuredMm, locale) })}
              </FloorButton>
            ) : null}
          </section>
        </div>
      )
    } else if (model.stage === 'photo' && model.hide && model.photoStep) {
      // B-W2b-110 (MES-060): the photo of the hide on the table, before cutting; online (sent at once, never queued).
      const step = model.photoStep
      body = (
        <div className="fw-floor-stack">
          {chip}
          {notices}
          <section className="fw-floor-stack fw-cut-photo" aria-labelledby="fw-cut-photo-title">
            <h2 id="fw-cut-photo-title" className="fw-floor-section-title">
              <span className="fw-floor-inline-icon" aria-hidden="true">
                <Camera />
              </span>
              {t('photo.title', { code: model.hide.code })}
            </h2>
            <p className="fw-floor-lead">{t('photo.hint')}</p>
            {step.failed ? (
              <TaskLine tone="danger" icon={<CircleAlert />} alert>
                {t('photo.failed')}
              </TaskLine>
            ) : null}
            {step.sending ? (
              <p className="fw-floor-muted" aria-busy="true">
                {t('photo.sending')}
              </p>
            ) : null}
            <HidePhoto label={t('photo.label')} heldReason={step.held ? t('photo.held.offline') : null} onCapture={(photo) => send({ type: 'photoTaken', photo })} onCancel={() => send({ type: 'back' })} />
          </section>
        </div>
      )
    } else {
      body = <p className="fw-floor-lead">{t('scan.empty')}</p>
    }
  }

  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={actions ? <FloorActionBar label={t('title')} actions={actions} /> : undefined}>
      {body}
      <AnywayDialog model={model.anyway ?? null} send={send} />
      <Modal open={Boolean(model.confirm)} onClose={() => send({ type: 'confirmCancel' })} title={t('confirm.title')} size="sm" className="fw-floor-dialog">
        <div className="fw-floor-dialog-body">
          <p className="fw-floor-dialog-line">{t('confirm.body', { count: model.confirm?.sets ?? 0 })}</p>
          <div className="fw-floor-dialog-actions">
            <FloorButton size="lg" variant="secondary" icon={<ArrowLeft />} onClick={() => send({ type: 'confirmCancel' })} autoFocus>
              {shared('action.back')}
            </FloorButton>
            <FloorButton size="lg" variant="primary" icon={<CircleCheck />} onClick={() => send({ type: 'confirmSave' })}>
              {t('confirm.save')}
            </FloorButton>
          </div>
        </div>
      </Modal>
    </FloorFrameView>
  )
}

/** The screen's words for a cut refusal it knows (message, fix), else null (the API's sentence is shown). */
export function wordsOf(t: Translate, code: string): { message: string; fix: string | null } | null {
  return (CUT_WORDS as readonly string[]).includes(code) ? { message: t(`refusal.${code}.message`), fix: t(`refusal.${code}.fix`) } : null
}

/** B-W2b-110: why "Cut anyway" cannot open now, in words (null: it may). */
function anywayHeldWords(t: Translate, held: AnywayHeld, waiting: number, size: string): string | null {
  switch (held) {
    case null:
      return null
    case 'waiting':
      return t('anyway.held.waiting', { count: waiting })
    case 'allCut':
      return t('anyway.held.allCut', { size })
    default:
      return t(`anyway.held.${held}`)
  }
}

function Looking({ code, t }: { code: string; t: Translate }) {
  return (
    <div className="fw-floor-card" aria-busy="true">
      <p className="fw-floor-card-code">{code}</p>
      <p className="fw-floor-muted">{t('scan.loading')}</p>
    </div>
  )
}

function WorkOrderLine({ chip, t, onChange }: { chip: WorkOrderChip; t: Translate; onChange: () => void }) {
  return (
    <div className="fw-cut-chip" role="status">
      <span className="fw-cut-chip-text">
        <span className="fw-floor-step">{t('workOrder.for')}</span>
        <span className="fw-cut-chip-what">
          <span className="fw-floor-code">{chip.number}</span> · {chip.style}
          {chip.colours.length > 0 ? ` · ${chip.colours.join(', ')}` : ''}
        </span>
      </span>
      <FloorButton size="md" variant="secondary" icon={<ClipboardList />} onClick={onChange} aria-label={t('workOrder.changeLabel', { number: chip.number })}>
        {t('workOrder.change')}
      </FloorButton>
    </div>
  )
}

function HideCard({
  hide,
  t,
  both,
  area,
  place,
  send,
}: {
  hide: HideCardModel
  t: Translate
  both: (value: string, uom: string) => string
  area: (value: string, uom: string) => string
  place: { locale: 'it' | 'en'; timeZone?: string }
  send: (action: CutAction) => void
}) {
  const shade = hide.match
  const checks = hide.checks ?? null
  const photo = hide.photo ?? null
  const context = { number: checks?.workOrderNumber ?? '', locale: place.locale }
  const standing = checks ? checks.warnings.filter((warning) => checks.standing.includes(warning.kind)) : []
  const graded = checks ? checks.grade.pieces.filter((piece) => piece.minGrade !== null) : []
  return (
    <TaskCard
      icon={<Scissors />}
      type={t('hide.type')}
      code={hide.code}
      status={t(`hide.state.${['FULL', 'PARTLY_CUT', 'REMNANT', 'CONSUMED', 'SCRAPPED'].includes(hide.state) ? hide.state : 'OTHER'}`)}
      statusTone={hide.state === 'FULL' ? 'success' : hide.state === 'PARTLY_CUT' || hide.state === 'REMNANT' ? 'info' : 'neutral'}
      big={hide.grade ? { value: hide.grade, label: t('hide.grade') } : null}
      flags={
        <>
          {hide.remnantTag ? (
            <TaskLine tone="info" icon={<Scissors />}>
              {t('hide.remnantTag', { tag: hide.remnantTag })}
            </TaskLine>
          ) : null}
          {hide.issuedByCut ? (
            <TaskLine tone="info" icon={<ClipboardList />}>
              {t('hide.issuedByCut')}
            </TaskLine>
          ) : null}
          {checks ? (
            <CheckLines checks={checks} standing={standing} t={t} context={context} />
          ) : shade.kind === 'same' ? (
            <TaskLine tone="success" icon={<CircleCheck />}>
              {t('hide.shade.same', { batch: shade.batch })}
            </TaskLine>
          ) : shade.kind === 'different' ? (
            <TaskLine tone="warning" icon={<CircleAlert />}>
              {t('hide.shade.different', { others: shade.others.join(', '), batch: shade.batch ?? '—' })}
            </TaskLine>
          ) : shade.kind === 'first' ? (
            <TaskLine tone="info" icon={<Layers />}>
              {t('hide.shade.first')}
            </TaskLine>
          ) : null}
          {hide.lastCut ? (
            <TaskLine tone="info" icon={<Scissors />}>
              {hide.lastCut.station
                ? t('hide.lastCut.station', { station: hide.lastCut.station, time: formatTime(hide.lastCut.at, place), number: hide.lastCut.workOrderNumber, left: area(hide.left, hide.baseUom) })
                : t('hide.lastCut.noStation', { time: formatTime(hide.lastCut.at, place), number: hide.lastCut.workOrderNumber, left: area(hide.left, hide.baseUom) })}
            </TaskLine>
          ) : null}
        </>
      }
      facts={[
        { label: t('hide.item'), value: hide.colour ? `${hide.item} · ${hide.colour}` : hide.item },
        { label: t('hide.area'), value: both(hide.area, hide.areaUom) },
        { label: t('hide.left'), value: both(hide.left, hide.baseUom) },
        { label: t('hide.thickness'), value: checks && checks.thickness.verdict !== 'NO_SPEC' ? thicknessWords(t, checks.thickness, place.locale) : hide.thicknessMm ? `${areaPlain(hide.thicknessMm)} mm` : '—' },
        { label: t('hide.shadeLabel'), value: [hide.shade, hide.dyeBatch ? t('hide.batch', { batch: hide.dyeBatch }) : null].filter(Boolean).join(' · ') || '—' },
        { label: t('hide.lot'), value: hide.lotCode },
        ...(graded.length > 0 ? [{ label: t('check.grade.label'), value: graded.map((piece) => t(`check.grade.piece.${piece.verdict}`, { name: piece.name, grade: piece.minGrade ?? '—' })).join(' · ') + (checks?.grade.byText ? ` ${t('check.grade.byText')}` : '') }] : []),
        { label: t('hide.defects'), value: hide.defects ?? t('hide.noDefects') },
      ]}
    >
      {photo || checks?.measurable ? (
        <div className="fw-cut-card-tools">
          {photo ? (
            <FloorButton size="md" variant={photo.required && !photo.taken ? 'primary' : 'secondary'} icon={<Camera />} heldReason={photo.held ? t('photo.held.offline') : null} onClick={() => send({ type: 'openPhoto' })}>
              {photo.taken ? t('photo.retake') : t('photo.open')}
            </FloorButton>
          ) : null}
          {checks?.measurable ? (
            <FloorButton size="md" variant="secondary" icon={<Ruler />} onClick={() => send({ type: 'openMeasure' })}>
              {checks.measuredMm ? t('measure.again') : t('measure.open')}
            </FloorButton>
          ) : null}
        </div>
      ) : null}
      {photo?.taken ? (
        <TaskLine tone="success" icon={<Camera />}>
          {t('photo.taken')}
        </TaskLine>
      ) : photo?.required ? (
        <TaskLine tone="warning" icon={<Camera />}>
          {t('photo.required')}
        </TaskLine>
      ) : null}
    </TaskCard>
  )
}

/** B-W2b-110: the hide check on the card: what stops it (amber, in words), what a lead passed, and what is fine. */
function CheckLines({ checks, standing, t, context }: { checks: HideCheckModel; standing: readonly CheckWarning[]; t: Translate; context: { number: string; locale: 'it' | 'en' } }) {
  const shadeStands = standing.some((warning) => warning.kind === 'SHADE')
  const shadeWarned = checks.warnings.some((warning) => warning.kind === 'SHADE')
  return (
    <>
      {standing.length > 0 ? (
        <TaskLine tone="warning" icon={<ShieldAlert />} alert>
          {t('check.stops', { count: standing.length })}
        </TaskLine>
      ) : null}
      {standing.map((warning) => (
        <TaskLine key={`${warning.kind}-${warning.code}`} tone="warning" icon={<CircleAlert />}>
          {warningWords(t, warning, context)}
        </TaskLine>
      ))}
      {checks.passed.length > 0 ? (
        <TaskLine tone="info" icon={<ShieldCheck />}>
          {t('check.passed', { kinds: kindsWords(t, checks.passed) })}
        </TaskLine>
      ) : null}
      {!shadeStands && !shadeWarned && checks.shade.same === true ? (
        <TaskLine tone="success" icon={<CircleCheck />}>
          {t('check.shade.same', { number: context.number, cutFrom: checks.shade.cutFrom.map((lot) => lotWords(lot, context.locale)).join('; '), hide: lotWords(checks.shade.hide, context.locale) })}
        </TaskLine>
      ) : !shadeStands && !shadeWarned && checks.shade.same === null ? (
        <TaskLine tone="info" icon={<Layers />}>
          {t('check.shade.first', { number: context.number, hide: lotWords(checks.shade.hide, context.locale) })}
        </TaskLine>
      ) : null}
      {checks.reserved.forIt ? (
        <TaskLine tone="success" icon={<CircleCheck />}>
          {t('check.reserved', { number: context.number })}
        </TaskLine>
      ) : null}
      {standing.length === 0 && checks.passed.length === 0 ? (
        <TaskLine tone="success" icon={<ShieldCheck />}>
          {t('check.clear')}
        </TaskLine>
      ) : null}
    </>
  )
}

function Refusal({ refusal, t, words, place }: { refusal: CutRefusalModel; t: Translate; words: (code: string) => { message: string; fix: string | null } | null; place: { locale: 'it' | 'en'; timeZone?: string } }) {
  switch (refusal.kind) {
    case 'lot': {
      const own = words(refusal.reason)
      return (
        <FloorState tone="danger" icon={<Ban />} title={own?.message ?? t('refusal.lotGeneric', { lot: refusal.lotCode })} alert>
          <p className="fw-floor-card-code">{refusal.code}</p>
          <p className="fw-floor-state-text">{t('refusal.doNotCut')}</p>
          {refusal.place ? <p className="fw-floor-state-text">{t('refusal.putBack', { place: refusal.place })}</p> : null}
          {!own && refusal.words ? <p className="fw-floor-muted">{refusal.words}</p> : null}
        </FloorState>
      )
    }
    case 'usedUp':
      return (
        <FloorState tone="danger" icon={<Ban />} title={refusal.lastCut ? t('refusal.usedUpOn', { date: formatDate(refusal.lastCut.at, place) }) : t('refusal.usedUp')} text={t('refusal.usedUpFix')} alert>
          <p className="fw-floor-card-code">{refusal.code}</p>
        </FloorState>
      )
    case 'workOrder': {
      const own = words(refusal.refusal.code)
      return (
        <FloorState tone="danger" icon={<CircleAlert />} title={own?.message ?? refusal.refusal.message} alert>
          <p className="fw-floor-card-code">{refusal.code}</p>
          {own?.fix ? <p className="fw-floor-state-text">{own.fix}</p> : null}
        </FloorState>
      )
    }
    case 'noWorkOrder':
      return (
        <FloorState tone="danger" icon={<CircleAlert />} title={refusal.number ? t('refusal.notForThis', { number: refusal.number }) : t('refusal.noWorkOrder')} text={t('refusal.noWorkOrderFix')} alert>
          <p className="fw-floor-card-code">{refusal.code}</p>
        </FloorState>
      )
    case 'notOnTablet':
      return (
        <FloorState tone="warning" icon={<CloudOff />} title={t('refusal.notOnTablet.title')} text={t('refusal.notOnTablet.body')} alert>
          <p className="fw-floor-card-code">{refusal.code}</p>
        </FloorState>
      )
    case 'problem':
      return <ProblemState problem={refusal.problem} words={words} code={refusal.code ?? null} />
  }
}
