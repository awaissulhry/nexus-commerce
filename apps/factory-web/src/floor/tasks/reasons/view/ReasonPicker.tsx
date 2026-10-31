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
  Wrench,
} from 'lucide-react'
import { tagIconSpec } from '@nexus/ui/primitives'
import { FloorActionBar, FloorButton } from '@nexus/ui/floor'
import { ReasonGrid, type ReasonTile } from '@nexus/ui/floor/ReasonGrid/index'
import { formatNumber, formatTime } from '../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { useReasonWords } from '../../../../lib/ds-words/reason-grid'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import { TaskCard, TaskLine } from '../../shared/view/TaskParts'
import { countedOf, doneHeld, MODE_OF, NOTE_IN_OFFICE, pickedOf, tilesOf, wordOf, type IconKey, type PickerPurpose, type PickerReason, type PickerState, type StandardIcon } from '../model'
import '../reasons.css'

/**
 * SCR-091 — the floor's reason picker (design floor.reasons; MES-125, QHS-007; the DS icon reason grid, gap D20):
 * "What this is for" first ("Scrap · B-000123 · Op 30 Collar" and the running count), then the reasons as big tiles —
 * icon or example photo, a colour, the word in the worker's language — nine a page, "More reasons" for the rest. Pick one
 * (pause, put last, split, hold, reject) or count (scrap, rework, defects: each tap adds one, − on the tile takes one off).
 * Tap = pick, no long press; arrows move, Enter or Space picks, Esc is Back (the host's keys). ONE picker for every floor
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
}

export type ReasonPickerAction = { type: 'pick'; id: string } | { type: 'count'; id: string; delta: 1 | -1 } | { type: 'retry' }

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
      </TaskCard>
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
