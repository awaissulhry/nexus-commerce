'use client'

import type { ReactNode } from 'react'
import { ArrowLeft, Check, CircleAlert, CircleCheckBig, CircleHelp, ClipboardCheck, CloudOff, Gauge, House, Layers, Lock, RotateCcw, Ruler, ScanLine, Scissors, Send, ShieldCheck, ShieldX, TrafficCone, Undo2, Workflow, X } from 'lucide-react'
import { FloorActionBar, FloorButton, FloorList, FloorListRow, FloorTile, FloorTileGrid, QuantityPad, ScanInput, type CameraScanner, type FloorAction, type FloorActions, type FloorTone } from '@nexus/ui/floor'
import { FloorChecklist, type FloorChecklistAnswer, type FloorChecklistGroup } from '@nexus/ui/floor/FloorChecklist/index'
import { ReasonGrid, type ReasonTile } from '@nexus/ui/floor/ReasonGrid/index'
import { LimitMeter } from '@nexus/ui/components/LimitMeter/index'
import { PinSignBlock } from '@nexus/ui/components/PinSignBlock/index'
import { useReasonWords } from '../../../../lib/ds-words/reason-grid'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatNumber, formatTime } from '../../../../lib/i18n/format'
import { INTL_LOCALE, type Locale } from '../../../../lib/i18n/locales'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import type { TaskProblem } from '../../shared/task-api'
import { ListFooter, ProblemState, TaskCard, TaskLine, Ticks, type PinProblem, type TickState } from '../../shared/view/TaskParts'
import { tilesOf, type PickerReason } from '../../reasons/model'
import { glyphOf } from '../../reasons/view/ReasonPicker'
import type { BundleCard } from '../../scans/model'
import type { CheckRecord, CheckRow, LineDhu, RovingBoard, RovingTile, StageDefect } from '../api'
import {
  approveHeld,
  checkWords,
  colourHeld,
  isKnownRefusal,
  kindHeld,
  KIND_ORDER,
  resultOf,
  ROVING_COLOURS,
  rovingColour,
  rovingColourOf,
  sendBackHeld,
  sendBackOperations,
  verdictOf,
  wayOf,
  type CuttingDraft,
  type EolDraft,
  type InlineKind,
  type RovingColour,
  type RovingDraft,
} from '../model'
import '../inline.css'

/**
 * SCR-176 — Floor › In-line inspection (design floor.inline; QHS-039 first piece, QHS-040 cutting, QHS-041 roving, QHS-042 end of
 * line and DHU; B-W2b-105 on B-W2b-99's API). Tablet first, one job per screen, centred. The header says the tablet's line and
 * its DHU today (defects per 100 pieces from the end-of-line checks), never a person.
 *
 *   Which check?      four tiles (First piece · Cutting · Roving · End of line), a tile held with its reason (signed or recorded at
 *                     once: the network; roving: the tablet's line); the site's first pieces waiting for approval as a list
 *   First piece       scan the first bundle → which operation waits for it (or every one) → the plan's checks (DS FloorChecklist)
 *                     and the key measurements (a value, its verdict by the numbers, DS LimitMeter) → Approve or Reject with the PIN
 *                     (DS PinSignBlock): the operation screens of the run lift their hold at once (live)
 *   Cutting           scan a bundle → pieces looked at, pieces rejected, the cutting defect → Pass or Fail (rejected pieces are recut)
 *   Roving            the line's operations as tiles with today's light → a few pieces → green, amber or red (suggested), per
 *                     operation; never per person
 *   End of line       scan → Pass (main, Enter: one tap) or Defect → how many, which defect → which operation caused it → Send back
 *                     (the rework loop): 3 taps after the scan
 * Never money. The view fetches nothing: the container (Inline.tsx) reads and maps.
 */

export interface DefectList {
  readonly state: 'ready' | 'loading' | 'offline' | 'error'
  readonly defects: readonly StageDefect[]
  readonly asOf: string | null
}

export type ScanKind = Exclude<InlineKind, 'ROVING'>

export type InlineStep =
  | { readonly kind: 'noPermission' }
  | { readonly kind: 'kinds'; readonly open: readonly CheckRow[] | null }
  | { readonly kind: 'scan'; readonly check: ScanKind; readonly wrong?: { readonly why: 'notBundle' | 'notFound' | 'notOnTablet' | 'otherFactory' | 'typo'; readonly code: string } | null }
  | { readonly kind: 'loading'; readonly code: string }
  | { readonly kind: 'fpOperation'; readonly card: BundleCard }
  | { readonly kind: 'fpChecks'; readonly record: CheckRecord; readonly measuring: string | null; readonly value: number | null; readonly choice: string | null; readonly busy?: boolean }
  | { readonly kind: 'fpSign'; readonly record: CheckRecord; readonly outcome: 'APPROVED' | 'REJECTED'; readonly busy?: boolean; readonly pin?: PinProblem }
  | { readonly kind: 'fpDone'; readonly record: CheckRecord }
  | { readonly kind: 'cutting'; readonly card: BundleCard; readonly draft: CuttingDraft; readonly defects: DefectList; readonly busy?: boolean }
  | { readonly kind: 'roving'; readonly board: RovingBoard | null; readonly asOf: string | null }
  | { readonly kind: 'rovingTile'; readonly tile: RovingTile; readonly draft: RovingDraft; readonly defects: DefectList; readonly busy?: boolean }
  | { readonly kind: 'eol'; readonly card: BundleCard; readonly asOf: string | null; readonly busy?: boolean }
  | { readonly kind: 'eolDefect'; readonly card: BundleCard; readonly draft: EolDraft; readonly stage: 'defect' | 'operation' | 'reason'; readonly defects: DefectList; readonly reworkReasons: readonly PickerReason[]; readonly needsReason: boolean; readonly busy?: boolean }
  | { readonly kind: 'problem'; readonly problem: TaskProblem; readonly code: string | null }

/** What was just recorded, on top of the next step (a receipt with its ticks). */
export interface DoneLine {
  readonly kind: 'pass' | 'sentBack' | 'defectKept' | 'roving' | 'cutting'
  readonly code: string
  readonly pieces?: number
  readonly operation?: string
  readonly colour?: RovingColour
  readonly ticks: TickState | null
  /** The rework could not be opened (a refusal's code, or a problem's kind); the defect stands. */
  readonly problem?: string | null
}

export interface InlineViewModel {
  readonly frame: FrameModel
  readonly online: boolean
  readonly step: InlineStep
  /** The tablet's line, or null (a bench without one). */
  readonly line: { readonly code: string; readonly name: string } | null
  readonly dhu: LineDhu | null
  /** The DHU as this tablet read it last (offline), else null. */
  readonly dhuAsOf?: string | null
  readonly done?: DoneLine | null
  /** A write that did not go, under the step (a refusal, the network). */
  readonly notice?: TaskProblem | null
  /** The signer's name (the person signed in on the tablet). */
  readonly signer?: string
  /** This tablet read the roving board in this visit (Roving opens offline from it). */
  readonly boardKept?: boolean
  readonly timeZone?: string
}

export type InlineAction =
  | { type: 'kind'; kind: InlineKind }
  | { type: 'openRow'; id: string }
  | { type: 'scan'; code: string }
  | { type: 'back' }
  | { type: 'home' }
  | { type: 'retry' }
  | { type: 'fpOperation'; operationId: string | null }
  | { type: 'fpPass'; code: string }
  | { type: 'fpFail'; code: string }
  | { type: 'fpPassGroup'; codes: readonly string[] }
  | { type: 'measure'; code: string | null }
  | { type: 'measureValue'; value: number | null }
  | { type: 'measureChoice'; value: string }
  | { type: 'measureSave'; outcome: 'PASS' | 'FAIL' }
  | { type: 'sign'; outcome: 'APPROVED' | 'REJECTED' }
  | { type: 'pin'; pin: string }
  | { type: 'cuttingPieces'; value: number | null }
  | { type: 'cuttingRejected'; value: number | null }
  | { type: 'cuttingDefect'; id: string }
  | { type: 'cuttingSave' }
  | { type: 'tile'; operationId: string; workOrderId: string }
  | { type: 'rovingPieces'; value: number | null }
  | { type: 'rovingDefective'; value: number | null }
  | { type: 'rovingDefect'; id: string }
  | { type: 'rovingColour'; colour: RovingColour }
  | { type: 'rovingSave' }
  | { type: 'pass' }
  | { type: 'defect' }
  | { type: 'eolDefective'; value: number | null }
  | { type: 'eolDefect'; id: string }
  | { type: 'eolOperation'; id: string }
  | { type: 'eolReason'; code: string }
  | { type: 'eolStage'; stage: 'defect' | 'operation' | 'reason' }
  | { type: 'sendBack' }

export interface InlineViewProps {
  model: InlineViewModel
  onAction?: (action: InlineAction) => void
  onFrame?: (action: FrameAction) => void
  camera?: CameraScanner
}

const KIND_ICON: Readonly<Record<InlineKind, ReactNode>> = {
  FIRST_PIECE: <ShieldCheck />,
  CUTTING: <Scissors />,
  ROVING: <TrafficCone />,
  END_OF_LINE: <ClipboardCheck />,
}

const COLOUR_TONE: Readonly<Record<RovingColour, FloorTone>> = { GREEN: 'success', AMBER: 'warning', RED: 'danger' }

/** A defect of the vocabulary as a reason tile (its icon and colour as the office set them; critical says so in words). */
function defectTiles(defects: readonly StageDefect[], locale: Locale, critical: string): ReasonTile[] {
  const reasons: PickerReason[] = defects.map((defect) => ({ id: defect.id, list: 'DEFECT', code: defect.code, labelIt: defect.label, labelEn: defect.label, labelI18n: {}, icon: defect.icon, colour: defect.colour, photo: null, needsDetail: false, sortOrder: 0 }))
  const byId = new Map(defects.map((defect) => [defect.id, defect]))
  return tilesOf(reasons, locale).map((tile) => ({ id: tile.id, label: tile.label, hint: byId.get(tile.id)?.severity === 'CRITICAL' ? critical : undefined, icon: glyphOf(tile.icon), tone: byId.get(tile.id)?.severity === 'CRITICAL' ? 'danger' : tile.tone }))
}

export function InlineView({ model, onAction, onFrame, camera }: InlineViewProps) {
  const t = useT('floor-inline')
  const shared = useT('floor-tasks')
  const locale = useLocale()
  const ds = useDsWords()
  const reasonWords = useReasonWords()
  const send = (action: InlineAction) => onAction?.(action)
  const { step, online } = model
  const time = (value: string) => formatTime(value, { locale, timeZone: model.timeZone })
  const number = (value: number) => formatNumber(value, locale)
  const refusal = (code: string) => (isKnownRefusal(code) ? { message: t(`refusal.${code}.message`), fix: t(`refusal.${code}.fix`) } : null)

  const home: FloorAction = { label: shared('action.home'), icon: <House />, onPress: () => send({ type: 'home' }) }
  const back: FloorAction = { label: shared('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }), variant: 'secondary' }

  const scanField = (label: string, hint: string) => (
    <ScanInput
      label={label}
      hint={hint}
      scannedLabel={(code) => t('scan.read', { code })}
      keyboardLabel={t('scan.type')}
      camera={camera ? { scanner: camera, startLabel: t('scan.camera.start'), stopLabel: t('scan.camera.stop'), errorLabel: t('scan.camera.error') } : undefined}
      onScan={(code) => send({ type: 'scan', code })}
    />
  )

  const defectGrid = (list: DefectList, value: string | null, onPick: (id: string) => void, question: string, hideLabel = false) =>
    list.state === 'loading' ? (
      <p className="fw-floor-muted" aria-busy="true">
        {t('defects.loading')}
      </p>
    ) : list.state === 'offline' || list.state === 'error' ? (
      <TaskLine tone="warning" icon={<CloudOff />}>
        {t(`defects.${list.state}`)}
      </TaskLine>
    ) : list.defects.length === 0 ? (
      <TaskLine tone="info" icon={<CircleHelp />}>
        {t('defects.empty')}
      </TaskLine>
    ) : (
      <>
        {list.asOf ? (
          <TaskLine tone="info" icon={<CloudOff />}>
            {shared('asOf', { time: time(list.asOf) })}
          </TaskLine>
        ) : null}
        <ReasonGrid label={question} hideLabel={hideLabel} reasons={defectTiles(list.defects, locale, t('defects.critical'))} value={value} onChange={onPick} words={reasonWords} locale={INTL_LOCALE[locale]} />
      </>
    )

  let actions: FloorActions | null = null
  let body: ReactNode = null
  let header = false

  switch (step.kind) {
    case 'noPermission':
      actions = [home]
      body = <FloorState tone="warning" icon={<Lock />} title={t('noPermission.title')} text={t('noPermission.body')} alert />
      break

    case 'problem':
      actions = [back, { label: shared('action.retry'), icon: <RotateCcw />, onPress: () => send({ type: 'retry' }) }]
      body = <ProblemState problem={step.problem} code={step.code} words={refusal} />
      break

    case 'loading':
      actions = [back]
      body = (
        <p className="fw-floor-muted" aria-busy="true">
          {t('loading', { code: step.code })}
        </p>
      )
      break

    case 'kinds': {
      header = true
      actions = [home]
      const open = step.open ?? []
      body = (
        <>
          <section className="fw-floor-stack" aria-labelledby="fw-in-kinds">
            <h2 id="fw-in-kinds" className="fw-floor-section-title">
              {t('kinds.title')}
            </h2>
            <FloorTileGrid label={t('kinds.title')}>
              {KIND_ORDER.map((kind) => {
                const held = kindHeld(kind, { online, hasLine: model.line !== null, boardKept: model.boardKept ?? false })
                const count = kind === 'FIRST_PIECE' && open.length > 0 ? open.length : undefined
                return (
                  <FloorTile
                    key={kind}
                    icon={KIND_ICON[kind]}
                    label={t(`kind.${kind}`)}
                    hint={t(`kindHint.${kind}`)}
                    count={count}
                    countLabel={count ? t('kinds.waiting', { count }) : undefined}
                    tone={kind === 'FIRST_PIECE' && count ? 'warning' : 'neutral'}
                    heldReason={held ? t(`kindHeld.${held}`) : null}
                    onPress={() => send({ type: 'kind', kind })}
                  />
                )
              })}
            </FloorTileGrid>
          </section>
          <FirstPieceRows rows={step.open} t={t} time={time} send={send} />
        </>
      )
      break
    }

    case 'scan': {
      header = step.check === 'END_OF_LINE'
      actions = [back]
      const what = step.check === 'FIRST_PIECE' ? 'firstPiece' : step.check === 'CUTTING' ? 'cutting' : 'eol'
      body = (
        <>
          {scanField(t(`scan.${what}.label`), t(`scan.${what}.hint`))}
          {step.wrong ? (
            <TaskLine tone="danger" icon={<CircleAlert />} alert>
              {t(`scan.wrong.${step.wrong.why}`, { code: step.wrong.code })}
            </TaskLine>
          ) : null}
          {step.check === 'FIRST_PIECE' && !online ? (
            <TaskLine tone="warning" icon={<CloudOff />}>
              {t('kindHeld.online')}
            </TaskLine>
          ) : null}
        </>
      )
      break
    }

    case 'fpOperation': {
      actions = [back]
      const card = step.card
      const ops = sendBackOperations(card.operations)
      body = (
        <div className="fw-task-split">
          <BundleCardFacts card={card} t={t} number={number} />
          <section className="fw-floor-stack" aria-labelledby="fw-in-fp-op">
            <h2 id="fw-in-fp-op" className="fw-floor-section-title">
              {t('fp.operation.title')}
            </h2>
            <p className="fw-floor-muted">{t('fp.operation.hint')}</p>
            <ReasonGrid
              label={t('fp.operation.title')}
              hideLabel
              reasons={[
                ...ops.map((operation): ReasonTile => ({ id: operation.id, label: operation.name, hint: t('opCode', { seq: operation.seq, code: operation.code }), icon: <Workflow />, tone: 'info' })),
                { id: 'ALL', label: t('fp.operation.all'), hint: t('fp.operation.allHint'), icon: <Layers />, tone: 'neutral' },
              ]}
              value={null}
              onChange={(id) => send({ type: 'fpOperation', operationId: id === 'ALL' ? null : id })}
              words={reasonWords}
              locale={INTL_LOCALE[locale]}
            />
          </section>
        </div>
      )
      break
    }

    case 'fpChecks': {
      const { record } = step
      const held = approveHeld(record)
      const heldWords = !online ? t('kindHeld.online') : step.busy ? t('busy') : held ? (held.key === 'critical' ? t('fp.held.critical', { check: checkName(record, held.code, locale) }) : t('fp.held.left', { count: held.count })) : null
      // Approve is the main action; Reject sits under the checks (three actions broke words in half at 1024).
      actions = [back, { label: t('fp.approve'), icon: <ShieldCheck />, onPress: () => send({ type: 'sign', outcome: 'APPROVED' }), heldReason: heldWords, id: 'approve' }]
      if (step.measuring) {
        const check = record.checks.find((entry) => entry.code === step.measuring)
        if (check) {
          body = <MeasureStep check={check} value={step.value} choice={step.choice} busy={step.busy ?? false} t={t} locale={locale} send={send} />
          actions = [{ label: shared('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'measure', code: null }), variant: 'secondary' }]
          break
        }
      }
      body = (
        <>
          <RecordHead record={record} t={t} />
          <FirstPieceChecks record={record} busy={step.busy ?? false} online={online} t={t} locale={locale} send={send} />
          {heldWords && !step.busy ? (
            <TaskLine tone="warning" icon={<CircleAlert />}>
              {heldWords}
            </TaskLine>
          ) : null}
          <FloorButton size="lg" block variant="danger" icon={<ShieldX />} heldReason={!online ? t('kindHeld.online') : step.busy ? t('busy') : null} onClick={() => send({ type: 'sign', outcome: 'REJECTED' })}>
            {t('fp.reject')}
          </FloorButton>
          <Notice notice={model.notice ?? null} refusal={refusal} t={shared} />
        </>
      )
      break
    }

    case 'fpSign': {
      const { record } = step
      // No action bar: the DS block's own Cancel goes back, and the PIN pad gets the room.
      actions = null
      const passed = record.results.filter((result) => result.outcome === 'PASS').length
      const failed = record.results.filter((result) => result.outcome === 'FAIL').length
      body = (
        <div className="fw-in-sign">
          <section className="fw-floor-stack" aria-labelledby="fw-in-sign-title">
            <h2 id="fw-in-sign-title" className="fw-floor-section-title">
              {t(step.outcome === 'APPROVED' ? 'sign.approveTitle' : 'sign.rejectTitle')}
            </h2>
            <RecordHead record={record} t={t} />
            <p className="fw-floor-lead">{record.checks.length > 0 ? t('sign.results', { passed, failed }) : t('sign.noPlan')}</p>
            <Notice notice={model.notice ?? null} refusal={refusal} t={shared} />
          </section>
          <div className="fw-in-sign-pin">
            <PinSignBlock
              meaning={step.outcome === 'APPROVED' ? t('sign.approveMeaning', { number: record.workOrder?.number ?? '', operation: operationWords(record, t) }) : t('sign.rejectMeaning', { number: record.workOrder?.number ?? '' })}
              signer={{ name: model.signer ?? '', detail: t('sign.detail') }}
              onSign={(pin) => send({ type: 'pin', pin })}
              onCancel={() => send({ type: 'back' })}
              state={step.busy ? 'busy' : 'idle'}
              heldReason={online ? null : t('kindHeld.online')}
              message={step.pin ? shared(`pin.problem.${step.pin}`) : undefined}
              messageTone={step.pin === 'wrong' || step.pin === 'locked' ? 'danger' : 'warning'}
              autoFocus
              labels={ds.pinSignBlock}
            />
          </div>
        </div>
      )
      break
    }

    case 'fpDone': {
      const { record } = step
      const approved = record.outcome === 'APPROVED'
      actions = [home, { label: t('fp.next'), icon: <ScanLine />, onPress: () => send({ type: 'kind', kind: 'FIRST_PIECE' }) }]
      body = (
        <FloorState tone={approved ? 'success' : 'danger'} icon={approved ? <CircleCheckBig /> : <ShieldX />} title={t(approved ? 'fp.done.approved' : 'fp.done.rejected')} text={approved ? t('fp.done.approvedText', { operation: operationWords(record, t) }) : t('fp.done.rejectedText')} alert>
          <p className="fw-floor-card-code">{[record.workOrder?.number, record.bundle?.code].filter(Boolean).join(' · ')}</p>
          {record.signatureSha256 ? <p className="fw-floor-muted">{t('fp.done.signed', { fingerprint: record.signatureSha256.slice(0, 12) })}</p> : null}
        </FloorState>
      )
      break
    }

    case 'cutting': {
      const { card, draft } = step
      const rejected = Math.min(draft.rejected, draft.pieces)
      const busyWords = !online ? t('kindHeld.online') : step.busy ? t('busy') : null
      actions = [
        back,
        rejected > 0
          ? { label: t('cutting.fail', { count: rejected }), icon: <Scissors />, variant: 'danger', onPress: () => send({ type: 'cuttingSave' }), heldReason: busyWords, id: 'save' }
          : { label: t('cutting.pass'), icon: <Check />, onPress: () => send({ type: 'cuttingSave' }), heldReason: busyWords, id: 'save' },
      ]
      body = (
        <>
          <div className="fw-task-split">
            <div className="fw-floor-stack">
              <BundleCardFacts card={card} t={t} number={number} />
              <QuantityPad label={t('cutting.pieces')} value={draft.pieces} onChange={(value) => send({ type: 'cuttingPieces', value })} min={1} max={Math.max(1, card.bundle.quantity * 20)} showPad={false} {...padWords(t)} />
            </div>
            <div className="fw-floor-stack">
              <QuantityPad label={t('cutting.rejected')} value={draft.rejected} onChange={(value) => send({ type: 'cuttingRejected', value })} min={0} max={draft.pieces} quickValues={[0]} showPad={false} {...padWords(t)} />
              {rejected > 0 ? defectGrid(step.defects, draft.defectId, (id) => send({ type: 'cuttingDefect', id }), t('cutting.defect')) : null}
              {rejected > 0 ? (
                <TaskLine tone="info" icon={<Scissors />}>
                  {t('cutting.recut', { count: rejected })}
                </TaskLine>
              ) : null}
            </div>
          </div>
          <Notice notice={model.notice ?? null} refusal={refusal} t={shared} />
        </>
      )
      break
    }

    case 'roving': {
      header = true
      actions = [back]
      body = (
        <>
          <DoneStrip done={model.done ?? null} t={t} number={number} />
          {step.asOf ? (
            <TaskLine tone="info" icon={<CloudOff />}>
              {shared('asOf', { time: time(step.asOf) })}
            </TaskLine>
          ) : null}
          {step.board === null ? (
            <p className="fw-floor-muted" aria-busy="true">
              {t('roving.loading')}
            </p>
          ) : step.board.tiles.length === 0 ? (
            <FloorState tone="info" icon={<TrafficCone />} title={t('roving.empty.title')} text={t('roving.empty.body')} />
          ) : (
            <section className="fw-floor-stack" aria-labelledby="fw-in-roving">
              <h2 id="fw-in-roving" className="fw-floor-section-title">
                {t('roving.title')}
              </h2>
              <FloorTileGrid label={t('roving.title')}>
                {step.board.tiles.map((tile) => (
                  <FloorTile
                    key={`${tile.workOrder.id}:${tile.operation.id}`}
                    icon={<TrafficCone />}
                    label={tile.operation.name}
                    hint={`${t('opCode', { seq: tile.operation.seq, code: tile.operation.code })} · ${tile.workOrder.number} · ${tile.latest ? t('roving.latest', { colour: t(`colour.${tile.latest.outcome}`), time: time(tile.latest.at) }) : t('roving.none')}`}
                    count={tile.checksToday > 0 ? tile.checksToday : undefined}
                    countLabel={tile.checksToday > 0 ? t('roving.checks', { count: tile.checksToday }) : undefined}
                    tone={tile.latest ? COLOUR_TONE[tile.latest.outcome] : 'neutral'}
                    onPress={() => send({ type: 'tile', operationId: tile.operation.id, workOrderId: tile.workOrder.id })}
                  />
                ))}
              </FloorTileGrid>
            </section>
          )}
        </>
      )
      break
    }

    case 'rovingTile': {
      const { tile, draft } = step
      const critical = step.defects.defects.find((defect) => defect.id === draft.defectId)?.severity === 'CRITICAL'
      const colour = rovingColour(draft, critical)
      const suggested = rovingColourOf({ defectivePieces: draft.defective, critical })
      const held = colourHeld(colour, { defectivePieces: draft.defective, critical })
      actions = [
        back,
        {
          label: t('roving.record', { colour: t(`colourWord.${colour}`) }),
          icon: <Check />,
          variant: colour === 'RED' ? 'danger' : colour === 'AMBER' ? 'warning' : 'success',
          onPress: () => send({ type: 'rovingSave' }),
          heldReason: step.busy ? t('busy') : held ? t(`roving.held.${held}`) : null,
          id: 'save',
        },
      ]
      body = (
        <>
          <TaskCard icon={<TrafficCone />} type={t('kind.ROVING')} code={`${t('opCode', { seq: tile.operation.seq, code: tile.operation.code })} · ${tile.operation.name}`} facts={[{ label: t('fact.workOrder'), value: tile.workOrder.number }]} />
          <p className="fw-floor-muted">{t('roving.perOperation')}</p>
          <div className="fw-task-split">
            <div className="fw-floor-stack">
              <QuantityPad label={t('roving.pieces')} value={draft.pieces} onChange={(value) => send({ type: 'rovingPieces', value })} min={1} max={500} quickValues={[5, 7, 10]} showPad={false} {...padWords(t)} />
              <QuantityPad label={t('roving.defective')} value={draft.defective} onChange={(value) => send({ type: 'rovingDefective', value })} min={0} max={draft.pieces} quickValues={[0, 1, 2]} showPad={false} {...padWords(t)} />
            </div>
            <div className="fw-floor-stack">
              {draft.defective > 0 ? defectGrid(step.defects, draft.defectId, (id) => send({ type: 'rovingDefect', id }), t('roving.defect')) : null}
              <section className="fw-floor-stack" aria-labelledby="fw-in-colour">
                <h2 id="fw-in-colour" className="fw-floor-section-title">
                  {t('roving.colour')}
                </h2>
                <p className="fw-floor-muted">{t('roving.suggested', { colour: t(`colourWord.${suggested}`) })}</p>
                <div className="fw-in-colours" role="group" aria-label={t('roving.colour')}>
                  {ROVING_COLOURS.map((option) => {
                    const why = colourHeld(option, { defectivePieces: draft.defective, critical })
                    return (
                      <FloorButton key={option} size="lg" block variant={option === colour ? (option === 'RED' ? 'danger' : option === 'AMBER' ? 'warning' : 'success') : 'secondary'} aria-pressed={option === colour} heldReason={why ? t(`roving.held.${why}`) : null} onClick={() => send({ type: 'rovingColour', colour: option })}>
                        {t(`colour.${option}`)}
                      </FloorButton>
                    )
                  })}
                </div>
              </section>
            </div>
          </div>
          <Notice notice={model.notice ?? null} refusal={refusal} t={shared} />
        </>
      )
      break
    }

    case 'eol': {
      header = true
      const { card } = step
      const busy = step.busy ? t('busy') : null
      // The next ticket is scanned right here (each garment or bundle); Enter in the empty scan field is Pass.
      actions = [
        { label: t('eol.defect'), icon: <CircleAlert />, variant: 'danger', onPress: () => send({ type: 'defect' }), heldReason: busy ?? (online ? null : t('eol.sendBackOnline')) },
        { label: t('eol.pass', { count: card.bundle.quantity }), icon: <Check />, onPress: () => send({ type: 'pass' }), heldReason: busy, id: 'pass' },
      ]
      body = (
        <>
          <BundleCardFacts card={card} t={t} number={number} asOf={step.asOf} time={time} />
          {scanField(t('scan.eol.next'), t('scan.eol.nextHint'))}
          {!online ? (
            <TaskLine tone="warning" icon={<CloudOff />}>
              {t('eol.offline')}
            </TaskLine>
          ) : null}
          <Notice notice={model.notice ?? null} refusal={refusal} t={shared} />
        </>
      )
      break
    }

    case 'eolDefect': {
      const { card, draft } = step
      const held = sendBackHeld(draft, step.needsReason)
      const ops = sendBackOperations(card.operations)
      const operation = ops.find((entry) => entry.id === draft.operationId) ?? null
      const busy = !online ? t('eol.sendBackOnline') : step.busy ? t('busy') : null
      const next: FloorAction =
        step.stage === 'defect'
          ? { label: t('eol.next'), icon: <Workflow />, onPress: () => send({ type: 'eolStage', stage: 'operation' }), heldReason: draft.defectId ? null : t('eol.held.defect'), id: 'next' }
          : step.stage === 'operation' && step.needsReason
            ? { label: t('eol.next'), icon: <Workflow />, onPress: () => send({ type: 'eolStage', stage: 'reason' }), heldReason: draft.operationId ? null : t('eol.held.operation'), id: 'next' }
            : { label: t('eol.sendBack', { count: draft.defective }), icon: <Send />, variant: 'danger', onPress: () => send({ type: 'sendBack' }), heldReason: busy ?? (held ? t(`eol.held.${held}`) : null), id: 'send' }
      actions = [{ label: shared('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }), variant: 'secondary' }, next]
      body = (
        <>
          <p className="fw-in-subject">
            <span className="fw-floor-card-code">{card.bundle.code}</span> · {t('eol.subject', { defective: draft.defective, pieces: card.bundle.quantity })}
            {operation ? ` · ${t('eol.to', { operation: `${t('opCode', { seq: operation.seq, code: operation.code })} ${operation.name}` })}` : ''}
          </p>
          {step.stage === 'defect' ? (
            <div className="fw-task-split">
              <QuantityPad label={t('eol.defective')} value={draft.defective} onChange={(value) => send({ type: 'eolDefective', value })} min={1} max={Math.max(1, card.bundle.quantity)} quickValues={[1, 2]} showPad={false} {...padWords(t)} />
              <section className="fw-floor-stack" aria-labelledby="fw-in-eol-defect">
                <h2 id="fw-in-eol-defect" className="fw-floor-section-title">
                  {t('eol.whichDefect')}
                </h2>
                {defectGrid(step.defects, draft.defectId, (id) => send({ type: 'eolDefect', id }), t('eol.whichDefect'), true)}
              </section>
            </div>
          ) : step.stage === 'operation' ? (
            <section className="fw-floor-stack" aria-labelledby="fw-in-eol-op">
              <h2 id="fw-in-eol-op" className="fw-floor-section-title">
                {t('eol.whichOperation')}
              </h2>
              <p className="fw-floor-muted">{t('eol.perOperation')}</p>
              <ReasonGrid
                label={t('eol.whichOperation')}
                hideLabel
                reasons={ops.map((entry): ReasonTile => ({ id: entry.id, label: entry.name, hint: t('opCode', { seq: entry.seq, code: entry.code }), icon: <Workflow />, tone: 'info' }))}
                value={draft.operationId}
                onChange={(id) => send({ type: 'eolOperation', id })}
                words={reasonWords}
                locale={INTL_LOCALE[locale]}
              />
            </section>
          ) : (
            <section className="fw-floor-stack" aria-labelledby="fw-in-eol-reason">
              <h2 id="fw-in-eol-reason" className="fw-floor-section-title">
                {t('eol.whyRework')}
              </h2>
              <ReasonGrid
                label={t('eol.whyRework')}
                hideLabel
                reasons={tilesOf(step.reworkReasons, locale).map((tile) => ({ id: tile.id, label: tile.label, icon: glyphOf(tile.icon), tone: tile.tone }))}
                value={draft.reasonCode}
                onChange={(code) => send({ type: 'eolReason', code })}
                words={reasonWords}
                locale={INTL_LOCALE[locale]}
              />
            </section>
          )}
          <Notice notice={model.notice ?? null} refusal={refusal} t={shared} />
        </>
      )
      break
    }
  }

  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={actions ? <FloorActionBar label={t('title')} actions={actions} /> : null}>
      <div className="fw-floor-stack fw-in" id="fw-in-flash">
        {header ? <LineHeader line={model.line} dhu={model.dhu} asOf={model.dhuAsOf ?? null} t={t} number={number} time={time} /> : null}
        {step.kind === 'kinds' || step.kind === 'scan' ? <DoneStrip done={model.done ?? null} t={t} number={number} /> : null}
        {body}
      </div>
    </FloorFrameView>
  )
}

// ---- parts -----------------------------------------------------------------------------------------------------------------------

/** "Line L1 · Linea 1" and the DHU today, big (design floor.inline status: Line, DHU today (line)). Never per person. */
function LineHeader({ line, dhu, asOf, t, number, time }: { line: InlineViewModel['line']; dhu: LineDhu | null; asOf: string | null; t: Translate; number: (value: number) => string; time: (value: string) => string }) {
  if (!line) {
    return (
      <TaskLine tone="info" icon={<Gauge />}>
        {t('line.none')}
      </TaskLine>
    )
  }
  const value = dhu?.dhu ? number(Number(dhu.dhu)) : '–'
  return (
    <TaskCard
      icon={<Gauge />}
      type={t('line.type')}
      code={`${line.code} · ${line.name}`}
      id="fw-in-line"
      big={{ value, label: t('line.dhu') }}
      facts={dhu ? [{ label: t('line.checks'), value: number(dhu.checks) }, { label: t('line.pieces'), value: number(dhu.pieces) }, { label: t('line.defects'), value: number(dhu.defects) }] : []}
    >
      {dhu && dhu.dhu === null ? <p className="fw-floor-muted">{t('line.noChecks')}</p> : null}
      {asOf ? (
        <TaskLine tone="info" icon={<CloudOff />}>
          {t('line.asOf', { time: time(asOf) })}
        </TaskLine>
      ) : null}
    </TaskCard>
  )
}

function BundleCardFacts({ card, t, number, asOf, time }: { card: BundleCard; t: Translate; number: (value: number) => string; asOf?: string | null; time?: (value: string) => string }) {
  return (
    <TaskCard
      icon={<Layers />}
      type={t('fact.bundle')}
      code={card.bundle.code}
      id="fw-in-card"
      big={{ value: number(card.bundle.quantity), label: t('fact.pieces', { count: card.bundle.quantity }) }}
      facts={[
        { label: t('fact.style'), value: `${card.workOrder.style.code} · ${card.workOrder.style.name}` },
        { label: t('fact.workOrder'), value: card.workOrder.number },
        { label: t('fact.size'), value: [card.bundle.colourwayName || card.bundle.colourwayCode, card.bundle.size].filter(Boolean).join(' · ') },
      ]}
    >
      {asOf && time ? (
        <TaskLine tone="info" icon={<CloudOff />}>
          {t('asOfCard', { time: time(asOf) })}
        </TaskLine>
      ) : null}
    </TaskCard>
  )
}

/** The site's first pieces waiting for approval: one row each, tap opens it (the list's keys in its footer). */
function FirstPieceRows({ rows, t, time, send }: { rows: readonly CheckRow[] | null; t: Translate; time: (value: string) => string; send: (action: InlineAction) => void }) {
  if (rows === null) return null
  if (rows.length === 0) {
    return (
      <TaskLine tone="success" icon={<CircleCheckBig />}>
        {t('open.none')}
      </TaskLine>
    )
  }
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-in-open">
      <h2 id="fw-in-open" className="fw-floor-subtitle">
        {t('open.title')}
      </h2>
      <FloorList label={t('open.title')}>
        {rows.map((row) => (
          <FloorListRow
            key={row.id}
            icon={<ShieldCheck />}
            tone="warning"
            title={<span className="fw-floor-code">{[row.workOrder?.number, row.bundle?.code].filter(Boolean).join(' · ')}</span>}
            meta={[row.operation ? `${t('opCode', { seq: row.operation.seq, code: row.operation.code })} ${row.operation.name}` : t('fp.operation.all'), t('open.since', { time: time(row.createdAt) }), row.hasPlan ? t('open.plan') : t('open.noPlan')].join(' · ')}
            onPress={() => send({ type: 'openRow', id: row.id })}
          />
        ))}
      </FloorList>
      <ListFooter count={t('open.count', { count: rows.length })} keys={[{ key: 'Tab', does: t('keys.move') }, { key: 'Enter', does: t('keys.open') }]} />
    </section>
  )
}

function RecordHead({ record, t }: { record: CheckRecord; t: Translate }) {
  return (
    <TaskCard
      icon={<ShieldCheck />}
      type={t('kind.FIRST_PIECE')}
      code={[record.workOrder?.number, record.bundle?.code].filter(Boolean).join(' · ')}
      id="fw-in-record"
      facts={[{ label: t('fact.operation'), value: operationWords(record, t) }, { label: t('fact.plan'), value: record.plan ? `${record.plan.code} · ${record.plan.name}` : t('open.noPlan') }]}
    >
      <TaskLine tone="warning" icon={<Lock />}>
        {t('fp.holds')}
      </TaskLine>
    </TaskCard>
  )
}

const operationWords = (record: Pick<CheckRecord, 'operation'>, t: Translate): string => (record.operation ? `${t('opCode', { seq: record.operation.seq, code: record.operation.code })} ${record.operation.name}` : t('fp.operation.all'))

const checkName = (record: CheckRecord, code: string, locale: Locale): string => {
  const check = record.checks.find((entry) => entry.code === code)
  return check ? checkWords(check, locale) : code
}

/** The plan's checks: the taps (DS FloorChecklist, one group per class), the key measurements, the instructions and office-only checks. */
function FirstPieceChecks({ record, busy, online, t, locale, send }: { record: CheckRecord; busy: boolean; online: boolean; t: Translate; locale: Locale; send: (action: InlineAction) => void }) {
  const ds = useDsWords()
  const reasonWords = useReasonWords()
  if (record.checks.length === 0) {
    return (
      <TaskLine tone="info" icon={<CircleHelp />}>
        {t('fp.noPlan')}
      </TaskLine>
    )
  }
  const taps = record.checks.filter((check) => wayOf(check) === 'tap')
  const values = record.checks.filter((check) => wayOf(check) === 'value')
  const reads = record.checks.filter((check) => wayOf(check) === 'read')
  const office = record.checks.filter((check) => wayOf(check) === 'office')
  const classes = [...new Set(taps.map((check) => check.checkClass ?? 'OTHER'))]
  const groups: FloorChecklistGroup[] = classes.map((klass) => ({
    id: klass,
    label: t(`class.${['CRITICAL', 'MAJOR', 'MINOR'].includes(klass) ? klass : 'OTHER'}`),
    items: taps.filter((check) => (check.checkClass ?? 'OTHER') === klass).map((check) => ({ id: check.code, label: checkWords(check, locale), hint: check.mandatory ? undefined : t('fp.optional'), required: check.mandatory })),
  }))
  const answers: Record<string, FloorChecklistAnswer> = {}
  for (const check of taps) {
    const result = resultOf(record.results, check.code)
    if (result && result.outcome !== 'NOT_APPLICABLE') answers[check.code] = { result: result.outcome === 'PASS' ? 'pass' : 'fail' }
  }
  const held = !online ? t('kindHeld.online') : busy ? t('busy') : null
  return (
    <>
      {groups.length > 0 ? (
        <FloorChecklist
          groups={groups}
          answers={answers}
          onPass={(code) => send({ type: 'fpPass', code })}
          onFail={(code) => send({ type: 'fpFail', code })}
          onPassGroup={(_group, codes) => send({ type: 'fpPassGroup', codes })}
          heldReason={held}
          title={t('fp.checks')}
          labels={ds.floorChecklist}
          reasonWords={reasonWords}
          locale={INTL_LOCALE[locale]}
        />
      ) : null}
      {values.length > 0 ? (
        <section className="fw-floor-stack" aria-labelledby="fw-in-measures">
          <h2 id="fw-in-measures" className="fw-floor-section-title">
            {t('fp.measures')}
          </h2>
          <FloorList label={t('fp.measures')}>
            {values.map((check) => {
              const result = resultOf(record.results, check.code)
              return (
                <FloorListRow
                  key={check.code}
                  icon={<Ruler />}
                  tone={result ? (result.outcome === 'PASS' ? 'success' : result.outcome === 'FAIL' ? 'danger' : 'neutral') : check.mandatory ? 'warning' : 'neutral'}
                  title={checkWords(check, locale)}
                  meta={[
                    check.nominal !== null ? t('fp.nominal', { nominal: check.nominal, tolerance: check.tolerance ?? '0', uom: check.uom ?? '' }) : null,
                    result ? t(`fp.result.${result.outcome}`, { value: result.value ?? '' }) : check.mandatory ? t('fp.toMeasure') : t('fp.optional'),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  onPress={held ? undefined : () => send({ type: 'measure', code: check.code })}
                />
              )
            })}
          </FloorList>
        </section>
      ) : null}
      {office.map((check) => (
        <TaskLine key={check.code} tone="info" icon={<CircleHelp />}>
          {t('fp.office', { check: checkWords(check, locale) })}
        </TaskLine>
      ))}
      {reads.map((check) => (
        <TaskLine key={check.code} tone="info" icon={<ClipboardCheck />}>
          {checkWords(check, locale)}
        </TaskLine>
      ))}
    </>
  )
}

/** One key measurement: the value on the pad (or a choice), its verdict by the numbers when the plan gives a tolerance (DS LimitMeter). */
function MeasureStep({ check, value, choice, busy, t, locale, send }: { check: CheckRecord['checks'][number]; value: number | null; choice: string | null; busy: boolean; t: Translate; locale: Locale; send: (action: InlineAction) => void }) {
  const ds = useDsWords()
  const text = check.type === 'CHOICE' ? (choice ?? '') : value === null ? '' : String(value)
  const verdict = check.type === 'CHOICE' ? null : verdictOf(check, text)
  const missing = text.trim() === ''
  const nominal = check.nominal !== null ? Number(check.nominal) : null
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-in-measure">
      <h2 id="fw-in-measure" className="fw-floor-section-title">
        {checkWords(check, locale)}
      </h2>
      {check.type === 'CHOICE' ? (
        <div className="fw-in-choices" role="group" aria-label={checkWords(check, locale)}>
          {check.choices.map((option) => (
            <FloorButton key={option} size="lg" block variant={option === choice ? 'primary' : 'secondary'} aria-pressed={option === choice} onClick={() => send({ type: 'measureChoice', value: option })}>
              {option}
            </FloorButton>
          ))}
        </div>
      ) : (
        <QuantityPad label={checkWords(check, locale)} hideLabel unit={check.uom ?? undefined} value={value} onChange={(next) => send({ type: 'measureValue', value: next })} min={0} max={99_999} decimals={check.type === 'MEASUREMENT' ? 3 : 0} decimalSeparator={locale === 'it' ? ',' : '.'} {...padWords(t)} />
      )}
      {nominal !== null && check.type === 'MEASUREMENT' ? (
        <LimitMeter label={checkWords(check, locale)} value={value} unit={check.uom ?? undefined} nominal={nominal} tolerance={check.tolerance !== null ? Number(check.tolerance) : 0} locale={INTL_LOCALE[locale]} labels={ds.limitMeter} />
      ) : null}
      {verdict ? (
        <FloorButton size="lg" block variant={verdict === 'PASS' ? 'success' : 'danger'} icon={<Check />} heldReason={busy ? t('busy') : null} onClick={() => send({ type: 'measureSave', outcome: verdict })}>
          {t(verdict === 'PASS' ? 'measure.savePass' : 'measure.saveFail')}
        </FloorButton>
      ) : (
        <div className="fw-in-verdict">
          <FloorButton size="lg" block variant="danger" icon={<X />} heldReason={busy ? t('busy') : missing ? t('measure.held') : null} onClick={() => send({ type: 'measureSave', outcome: 'FAIL' })}>
            {t('measure.fail')}
          </FloorButton>
          <FloorButton size="lg" block variant="success" icon={<Check />} heldReason={busy ? t('busy') : missing ? t('measure.held') : null} onClick={() => send({ type: 'measureSave', outcome: 'PASS' })}>
            {t('measure.pass')}
          </FloorButton>
        </div>
      )}
    </section>
  )
}

/** What was just recorded, with its ticks (saved here → recorded by the office) or why the rework did not open. */
function DoneStrip({ done, t, number }: { done: DoneLine | null; t: Translate; number: (value: number) => string }) {
  if (!done) return null
  const tone = done.problem ? 'warning' : 'success'
  return (
    <div className="fw-floor-notice fw-in-done" role="status" data-tone={tone}>
      <span className="fw-floor-inline-icon" aria-hidden="true">
        {done.problem ? <Undo2 /> : <CircleCheckBig />}
      </span>
      <span className="fw-in-done-text">
        {t(`done.${done.kind}`, { code: done.code, pieces: done.pieces !== undefined ? number(done.pieces) : '', count: done.pieces ?? 0, operation: done.operation ?? '', colour: done.colour ? t(`colourWord.${done.colour}`) : '' })}
        {done.problem ? ` ${isKnownRefusal(done.problem) ? t(`refusal.${done.problem}.message`) : t('done.reworkNotOpened')}` : ''}
      </span>
      {done.ticks ? <Ticks state={done.ticks} /> : null}
    </div>
  )
}

function Notice({ notice, refusal, t }: { notice: TaskProblem | null; refusal: (code: string) => { message: string; fix: string } | null; t: Translate }) {
  if (!notice) return null
  if (notice.kind === 'refused') {
    const own = refusal(notice.code)
    return (
      <TaskLine tone="danger" icon={<CircleAlert />} alert>
        {own ? `${own.message} ${own.fix}` : `${notice.message} ${notice.fix ?? ''}`.trim()}
      </TaskLine>
    )
  }
  const kind = notice.kind === 'stepUp' ? 'forbidden' : notice.kind
  return (
    <TaskLine tone={kind === 'offline' || kind === 'unavailable' ? 'warning' : 'danger'} icon={<CircleAlert />} alert>
      {t(`problem.${kind}.title`)}
    </TaskLine>
  )
}

const padWords = (t: Translate) => ({
  decrementLabel: t('pad.less'),
  incrementLabel: t('pad.more'),
  clearLabel: t('pad.clear'),
  backLabel: t('pad.back'),
  emptyLabel: t('pad.empty'),
  rangeLabel: (min: number | undefined, max: number | undefined) => t('pad.range', { min: min ?? 0, max: max ?? '' }),
})
