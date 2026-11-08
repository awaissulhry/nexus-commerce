'use client'

import type { KeyboardEvent, ReactNode } from 'react'
import {
  ArrowLeft,
  Ban,
  Check,
  CircleDot,
  CircleHelp,
  CloudOff,
  Cog,
  Droplets,
  Hand,
  ListEnd,
  Pause,
  RotateCcw,
  Ruler,
  Scissors,
  SearchCheck,
  Shield,
  Sparkles,
  Spline,
  Split,
  SquareSplitHorizontal,
  TriangleAlert,
  Undo2,
  Unlink,
  Workflow,
  Wrench,
} from 'lucide-react'
import { speechLang } from '@nexus/factory-domain/auth/floor/literacy'
import { tagIconSpec } from '@nexus/ui/primitives'
import { FloorActionBar, FloorButton } from '@nexus/ui/floor'
import { ReadAloudButton } from '@nexus/ui/floor/ReadAloud/index'
import { ReasonGrid, type ReasonTile } from '@nexus/ui/floor/ReasonGrid/index'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatNumber, formatTime } from '../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { useReasonWords } from '../../../../lib/ds-words/reason-grid'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import { TaskCard, TaskLine } from '../../shared/view/TaskParts'
import { causeOf, causeValue, countedOf, doneHeld, MODE_OF, NOT_KNOWN, NOTE_IN_OFFICE, pickedOf, tilesOf, wordOf, type CauseModel, type IconKey, type PickerPurpose, type PickerReason, type PickerState, type StandardIcon } from '../model'
import '../reasons.css'

/**
 * SCR-091 — the floor's reason picker (design floor.reasons; MES-125, QHS-007; the DS icon reason grid, gap D20):
 * "What this is for" first ("Scrap · B-000123 · Op 30 Collar" and the running count), then the reasons as big tiles —
 * icon or example photo, a colour, the word in the worker's language — nine a page, "More reasons" for the rest. Pick one
 * (pause, put last, split, hold, reject) or count (scrap, rework, defects: each tap adds one, − on the tile takes one off).
 * Tap = pick, no long press; arrows move, Enter or Space picks, Esc is Back (the host's keys). B-W2b-67 (D27, MES-188): Read
 * aloud says the question and the tiles in the language on screen, in the device's own voice. ONE picker for every floor
 * reason: a host (Operation, My work, Bundles' split, the bench's Hold lot dialog, Kits' Receive back) draws
 * `ReasonPickerBody` inside its own frame or dialog with its own action bar, or the whole `ReasonPickerView`. Fetches
 * nothing; the host loads the reasons (`readListReasons`) and keeps the counts.
 */

export interface ReasonPickerModel {
  purpose: PickerPurpose
  /** What it is about, composed by the host ("B-000123 · Op 30 Collar"). */
  subject: string
  reasons: readonly PickerReason[]
  /** The grid's state: the reasons, or loading / failed / offline with nothing kept on this tablet. */
  state?: PickerState
  /** Pick mode: the picked reason's id. */
  value?: string | null
  /** Count mode: pieces per reason id. */
  counts?: Readonly<Record<string, number>>
  /** Count mode: the pieces it may count in all (the bundle's), for "2 of 20 counted". */
  of?: number | null
  /** Offline from what this tablet read earlier: as of when. */
  asOf?: string | null
  /** A tap past what the bundle holds. */
  problem?: 'atMost' | null
  /** The host takes a photo after Done for a reason that asks for more ("Other"). */
  withPhotos?: boolean
  /** Why no tile may be picked now (the host's call needs the network), or null. */
  heldReason?: string | null
  /** B-W2b-105 (MES-127): count mode, "Which operation caused it?" under the reasons, once a piece is counted. */
  cause?: CauseModel | null
}

export type ReasonPickerAction = { type: 'pick'; id: string } | { type: 'count'; id: string; delta: 1 | -1 } | { type: 'retry' } | { type: 'cause'; operationId: string | null }

const STANDARD: Readonly<Record<StandardIcon, ReactNode>> = {
  flaw: <CircleDot />,
  scissors: <Scissors />,
  stitch: <Spline />,
  stain: <Droplets />,
  tear: <SquareSplitHorizontal />,
  machine: <Cog />,
  ruler: <Ruler />,
  zip: <Unlink />,
  shield: <Shield />,
  clean: <Sparkles />,
  scrap: <TriangleAlert />,
  rework: <Wrench />,
  hand: <Hand />,
  help: <CircleHelp />,
  dot: <CircleDot />,
}

/** A tile's glyph: the office's DS tag icon, else the standard look of a scan code. */
export function glyphOf(icon: IconKey): ReactNode {
  if (icon.startsWith('tag:')) {
    const spec = tagIconSpec(icon.slice(4))
    if (spec) {
      const Icon = spec.Icon
      return <Icon />
    }
    return <CircleDot />
  }
  return STANDARD[icon.slice(4) as StandardIcon] ?? <CircleDot />
}

export const PURPOSE_ICON: Readonly<Record<PickerPurpose, ReactNode>> = {
  scrap: <TriangleAlert />,
  rework: <Wrench />,
  pause: <Pause />,
  putLast: <ListEnd />,
  defect: <SearchCheck />,
  split: <Split />,
  hold: <Ban />,
  reject: <Undo2 />,
}

export function ReasonPickerBody({ model, onAction, onBack, timeZone }: { model: ReasonPickerModel; onAction?: (action: ReasonPickerAction) => void; /** Esc = Back (design floor.reasons), also while a tile has the focus. */ onBack?: () => void; timeZone?: string }) {
  const t = useT('floor-reasons')
  const locale = useLocale()
  const words = useReasonWords()
  const ds = useDsWords()
  const send = (action: ReasonPickerAction) => onAction?.(action)
  const mode = MODE_OF[model.purpose]
  const state = model.state ?? 'ready'
  const tiles = tilesOf(model.reasons, locale, { withPhotos: model.withPhotos, held: model.heldReason ?? null, noteHeld: NOTE_IN_OFFICE.has(model.purpose) ? t(`noteHeld.${model.purpose}`) : null })
  const gridTiles: ReasonTile[] = tiles.map((tile) => ({
    id: tile.id,
    label: tile.label,
    hint: tile.hint ?? undefined,
    icon: glyphOf(tile.icon),
    photo: tile.photo ?? undefined,
    tone: tile.tone,
    photoNeeded: tile.photoNeeded,
    heldReason: tile.heldReason,
  }))
  const counts = model.counts ?? {}
  const counted = countedOf(counts)
  const picked = pickedOf(model.reasons, model.value)
  const question = t(`question.${model.purpose}`)

  const big =
    mode === 'count'
      ? { value: formatNumber(counted, locale), label: model.of ? t('counted.of', { count: counted, of: formatNumber(model.of, locale) }) : t('counted.all', { count: counted }) }
      : null

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || !onBack || event.defaultPrevented) return
    event.preventDefault()
    onBack()
  }

  return (
    <div className="fw-floor-stack fw-reasons" onKeyDown={onKeyDown}>
      {/* What this is for (design floor.reasons "context"): say what is explained before asking why. */}
      <TaskCard icon={PURPOSE_ICON[model.purpose]} type={t(`what.${model.purpose}`)} code={model.subject} id="fw-reasons-subject" big={big}>
        {mode === 'pick' ? <p className="fw-reasons-chosen">{picked ? t('chosen', { reason: wordOf(picked, locale) }) : t('none')}</p> : null}
        {model.asOf ? (
          <TaskLine tone="info" icon={<CloudOff />}>
            {t('asOf', { time: formatTime(model.asOf, { locale, timeZone }) })}
          </TaskLine>
        ) : null}
        {state === 'ready' && tiles.length > 0 ? <ReadAloudButton text={() => [question, ...tiles.map((tile) => tile.label)].join('. ')} lang={speechLang(locale)} size="sm" showVoice={false} labels={ds.readAloud} /> : null}
      </TaskCard>
      {mode === 'count' && state === 'ready' && model.cause && model.cause.operations.length > 0 ? <CauseRow cause={model.cause} onPick={(operationId) => send({ type: 'cause', operationId })} /> : null}
      {model.problem === 'atMost' && model.of ? (
        <TaskLine tone="warning" icon={<TriangleAlert />} alert>
          {t('atMost', { count: model.of })}
        </TaskLine>
      ) : null}
      {state === 'loading' ? (
        <p className="fw-floor-muted" aria-busy="true">
          {t('loading')}
        </p>
      ) : state === 'error' ? (
        <FloorState tone="danger" icon={<TriangleAlert />} title={t('error.title')} text={t('error.body')} alert>
          <FloorButton size="lg" variant="secondary" icon={<RotateCcw />} onClick={() => send({ type: 'retry' })}>
            {t('error.retry')}
          </FloorButton>
        </FloorState>
      ) : state === 'offline' ? (
        <FloorState tone="warning" icon={<CloudOff />} title={t('offline.title')} text={t('offline.body')} alert />
      ) : tiles.length === 0 ? (
        <FloorState tone="info" icon={<CircleHelp />} title={t('empty.title')} text={t('empty.body')} />
      ) : mode === 'count' ? (
        <ReasonGrid
          mode="count"
          label={question}
          reasons={gridTiles}
          counts={counts}
          max={model.of ?? null}
          onCountChange={(_next, change) => send({ type: 'count', id: change.id, delta: change.delta })}
          words={words}
          locale={INTL_LOCALE[locale]}
        />
      ) : (
        <ReasonGrid label={question} reasons={gridTiles} value={model.value ?? null} onChange={(id) => send({ type: 'pick', id })} words={words} locale={INTL_LOCALE[locale]} />
      )}
      {picked && tiles.find((tile) => tile.id === picked.id)?.photoNeeded ? (
        <TaskLine tone="info" icon={<CircleHelp />}>
          {t('photoNext', { reason: wordOf(picked, locale) })}
        </TaskLine>
      ) : null}
    </div>
  )
}

/**
 * B-W2b-105 — "Which operation caused it?" (design floor.reasons "attribute"; MES-127, QHS-042): the bundle's operations (code and name,
 * this one marked), Not known first and pressed by default — a charge is never guessed. One row of pressed buttons ABOVE the reasons,
 * there from the start: the grid's big tiles put the reasons below the fold on a tablet, and a section appearing after the first tap
 * would move the tiles under the finger. What is counted here is charged to the operation picked, never to a person; where the site's
 * legal gate allows it, the worker sees it on My day and may dispute it.
 */
function CauseRow({ cause, onPick }: { cause: CauseModel; onPick: (operationId: string | null) => void }) {
  const t = useT('floor-reasons')
  const value = causeValue(cause)
  const options = [{ id: NOT_KNOWN, label: t('cause.notKnown') }, ...cause.operations.map((operation) => ({ id: operation.id, label: `${operation.here ? t('cause.here', { seq: operation.seq, code: operation.code }) : t('cause.op', { seq: operation.seq, code: operation.code })} · ${operation.name}` }))]
  return (
    <section className="fw-floor-stack fw-reasons-cause" aria-labelledby="fw-reasons-cause-title">
      <h2 id="fw-reasons-cause-title" className="fw-floor-subtitle">
        {t('cause.title')} <span className="fw-floor-muted">{t('cause.hint')}</span>
      </h2>
      <div className="fw-reasons-cause-row" role="group" aria-labelledby="fw-reasons-cause-title">
        {options.map((option) => (
          <FloorButton key={option.id} size="md" block variant={option.id === value ? 'primary' : 'secondary'} icon={option.id === NOT_KNOWN ? <CircleHelp /> : <Workflow />} aria-pressed={option.id === value} onClick={() => onPick(causeOf(option.id))}>
            {option.label}
          </FloorButton>
        ))}
      </div>
    </section>
  )
}

/** The Done button's reason to wait, in words (pick mode: nothing picked), or null. */
export function useDoneHeld(model: Pick<ReasonPickerModel, 'purpose' | 'value' | 'state'>): string | null {
  const t = useT('floor-reasons')
  if ((model.state ?? 'ready') !== 'ready') return t('doneHeld.notReady')
  return doneHeld(MODE_OF[model.purpose], model.value) ? t('doneHeld.choose') : null
}

// ---- the picker as a screen of its own (the design index; a host with nothing else on screen) ----------------------

export interface ReasonPickerViewModel {
  frame: FrameModel
  picker: ReasonPickerModel
  timeZone?: string
}

export type ReasonPickerViewAction = ReasonPickerAction | { type: 'done' } | { type: 'back' }

export function ReasonPickerView({ model, onAction, onFrame }: { model: ReasonPickerViewModel; onAction?: (action: ReasonPickerViewAction) => void; onFrame?: (action: FrameAction) => void }) {
  const t = useT('floor-reasons')
  const held = useDoneHeld(model.picker)
  const send = (action: ReasonPickerViewAction) => onAction?.(action)
  return (
    <FloorFrameView
      frame={model.frame}
      onFrame={onFrame}
      actions={
        <FloorActionBar
          label={t('title')}
          actions={[
            { label: t('back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }), variant: 'secondary' },
            { label: t('done'), icon: <Check />, onPress: () => send({ type: 'done' }), heldReason: held },
          ]}
        />
      }
    >
      <ReasonPickerBody model={model.picker} onAction={send} onBack={() => send({ type: 'back' })} timeZone={model.timeZone} />
    </FloorFrameView>
  )
}
