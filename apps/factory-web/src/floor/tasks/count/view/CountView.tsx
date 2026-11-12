'use client'

import type { ReactNode } from 'react'
import { ArrowLeft, Check, CircleAlert, CircleCheck, CircleMinus, CircleSlash, ClipboardCheck, Layers, ListChecks, Package, PackagePlus, RotateCcw, Scale, ScanLine, Search, Send, X } from 'lucide-react'
import { FloorActionBar, FloorList, FloorListRow, QuantityPad, ScanInput, qtyHeldReason, type CameraScanner, type FloorActions, type FloorTone } from '@nexus/ui/floor'
import { FloorCard } from '@nexus/ui/floor/FloorCard/index'
import { ReadAloudButton } from '@nexus/ui/floor/ReadAloud/index'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatNumber, formatTime } from '../../../../lib/i18n/format'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import type { TaskProblem } from '../../shared/task-api'
import { HeldLine, ListFooter, ProblemState, TaskLine, Ticks, type TickState } from '../../shared/view/TaskParts'
import {
  binCounted,
  DIFFERENCE_TONE,
  differenceRows,
  knownRefusal,
  lineTally,
  num,
  padBounds,
  padLines,
  passOf,
  unitName,
  unitsScanned,
  type BinDone,
  type BinLine,
  type BinRead,
  type CountLast,
  type CountPad,
  type Difference,
  type Finished,
  type KeptUnit,
  type ToCount,
} from '../model'
import '../count.css'

/**
 * SCR-178 — Count (B-W2b-310; design floor.count; SCM-228): one job per screen, tablet-first and centred, works offline.
 *
 *   What to count     the site's running counts' bins (rows: bin, kind, since; a recount the person counted is shown, never
 *                     offered), or scan any bin's label. Blind: what a bin should hold is never shown before Bin done.
 *   Scan every unit   the bin's card and the units scanned as a big numeral; each scan answers at once (confirmFeedback) and the
 *                     strip says what it counted (two ticks; amber "Already counted" for a tag scanned twice). A hide's, roll's
 *                     or remnant's tag carries its own area or length; a lot's label or a material without a label: the DS
 *                     QuantityPad. Offline the units wait on the tablet (one tick) and count on its copy of the bin.
 *   Differences       after Bin done: missing (expected, not scanned) and extra (scanned, not expected) with their tones, short
 *                     and over lots, "No difference." with a tick; a move into the bin since the count started says so. Look
 *                     again goes back to scanning; Finish bin records the bin and sends the count on for approval.
 * A refusal is a full-screen state in the screen's words. No money, no person.
 */

export type CountStep =
  | { readonly kind: 'what' }
  | { readonly kind: 'reading'; readonly code: string }
  /** Several running counts count the bin: which one. */
  | { readonly kind: 'choose' }
  | { readonly kind: 'bin' }
  | { readonly kind: 'doneReading' }
  | { readonly kind: 'done' }
  | { readonly kind: 'finished' }
  | { readonly kind: 'noPermission' }

export interface CountProblem {
  readonly problem: TaskProblem
  /** What was scanned (a bin's label, a unit's tag). */
  readonly code: string | null
}

export interface CountFinish {
  /** The office's answer; null: kept on this tablet (it is sent after the units it waits for). */
  readonly answer: Finished | null
  readonly ticks: TickState
  /** The bin as finished on this tablet (for the words when the answer is not here yet). */
  readonly place: string
  readonly count: string
  /** Kept on this tablet under this id (its ticks follow the queue). */
  readonly clientEventId?: string | null
}

export interface CountViewModel {
  frame: FrameModel
  online: boolean
  /** The worker notice holds scans. */
  held?: boolean
  step: CountStep
  /** What to count at this site; null: not read yet. */
  toCount?: ToCount | null
  /** The list is this tablet's copy: as of when. */
  toCountAsOf?: string | null
  toCountProblem?: 'offline' | 'error' | null
  /** The bin scanned (blind) and the label it was scanned by. */
  bin?: BinRead | null
  placeCode?: string | null
  /** The bin is this tablet's copy: as of when. */
  binAsOf?: string | null
  /** Units kept on this tablet for this bin (offline). */
  kept?: readonly KeptUnit[]
  pad?: CountPad | null
  last?: CountLast | null
  busy?: boolean
  done?: BinDone | null
  finish?: CountFinish | null
  problem?: CountProblem | null
  timeZone?: string
}

export type CountAction =
  | { type: 'scan'; code: string }
  | { type: 'openBin'; countId: string; placeCode: string }
  | { type: 'pickCount'; countId: string }
  | { type: 'line'; lineId: string }
  | { type: 'pad'; value: number | null }
  | { type: 'countPad' }
  | { type: 'cancelPad' }
  | { type: 'binDone' }
  | { type: 'lookAgain' }
  | { type: 'finish' }
  | { type: 'another' }
  | { type: 'back' }
  | { type: 'dismiss' }
  | { type: 'retry' }

export interface CountViewProps {
  model: CountViewModel
  onAction?: (action: CountAction) => void
  onFrame?: (action: FrameAction) => void
  camera?: CameraScanner
}

/** A unit's short name (`unit.FT2` → "ft²"), else its code. */
export function unitWord(t: Translate, uom: string | null | undefined): string {
  if (!uom) return ''
  const key = `unit.${uom}`
  const word = t(key)
  return word === key ? uom : word
}

/** The words of a refusal the screen knows, else null (the general problem's words). */
export function refusalWords(t: Translate, code: string, facts: { code?: string | null }): { message: string; fix: string | null } | null {
  if (!knownRefusal(code)) return null
  const values = { code: facts.code ?? '' }
  return { message: t(`refusal.${code}.message`, values), fix: t(`refusal.${code}.fix`, values) }
}

/** A count's kind in words (CYCLE, YEAR_END), else its code. */
export function kindWord(t: Translate, kind: string): string {
  const key = `countKind.${kind}`
  const word = t(key)
  return word === key ? kind : word
}

type Amount = (value: number | string | null | undefined, uom: string | null | undefined) => string
type Send = (action: CountAction) => void
type CamProps = { scanner: CameraScanner; startLabel: string; stopLabel: string; errorLabel: string } | undefined

const DIFFERENCE_ICON = { MISSING: <CircleMinus />, EXTRA: <PackagePlus />, SHORT: <Scale />, OVER: <Scale />, MATCH: <CircleCheck /> } as const

export function CountView({ model, onAction, onFrame, camera }: CountViewProps) {
  const t = useT('floor-count')
  const shared = useT('floor-tasks')
  const floor = useT('floor')
  const ds = useDsWords()
  const locale = useLocale()
  const send = (action: CountAction) => onAction?.(action)
  const place = { locale, timeZone: model.timeZone }
  const time = (value: string) => formatTime(value, place)
  const figure = (value: number) => formatNumber(value, locale, { maximumFractionDigits: 2 })
  const amount: Amount = (value, uom) => (value === null || value === undefined ? '' : `${figure(typeof value === 'string' ? num(value) : value)} ${unitWord(t, uom)}`.trim())
  const camProps: CamProps = camera ? { scanner: camera, startLabel: floor('scan.camera.start'), stopLabel: floor('scan.camera.stop'), errorLabel: floor('scan.camera.error') } : undefined
  const scanWords = { scannedLabel: (code: string) => floor('scan.read', { code }), keyboardLabel: floor('scan.type') }

  let actions: FloorActions | null = null
  let body: ReactNode

  if (model.step.kind === 'noPermission') {
    body = <FloorState tone="warning" icon={<CircleSlash />} title={t('noPermission.title')} text={t('noPermission.body')} alert />
  } else if (model.problem) {
    const { problem, code } = model.problem
    body = <ProblemState problem={problem} code={code} words={(refusal) => refusalWords(t, refusal, { code })} />
    const again = { label: t('action.scanAgain'), icon: <ScanLine />, onPress: () => send({ type: 'dismiss' }) }
    actions = problem.kind === 'offline' || problem.kind === 'unavailable' ? [{ label: t('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }) }, { label: shared('action.retry'), icon: <RotateCcw />, onPress: () => send({ type: 'retry' }) }] : [again]
  } else if (model.step.kind === 'reading') {
    body = <FloorState tone="info" icon={<ScanLine />} title={t('what.reading', { code: model.step.code })} busy />
  } else if (model.step.kind === 'doneReading') {
    body = <FloorState tone="info" icon={<ListChecks />} title={t('done.reading')} busy />
  } else if (model.step.kind === 'choose') {
    actions = [{ label: t('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }) }]
    body = <ChooseStep model={model} t={t} send={send} />
  } else if (model.step.kind === 'bin') {
    const pad = model.pad ?? null
    if (pad) {
      const bounds = padBounds(pad.target.uom)
      const words = { emptyLabel: t('pad.empty'), rangeLabel: () => t('pad.range', { min: figure(bounds.min) }) }
      actions = [
        { label: t('action.cancel'), icon: <X />, onPress: () => send({ type: 'cancelPad' }) },
        { label: pad.value !== null && pad.value >= bounds.min ? t('action.countPad', { quantity: amount(pad.value, pad.target.uom) }) : t('action.countNothing'), icon: <Check />, heldReason: model.busy ? t('held.busy') : qtyHeldReason(pad.value, bounds, words), onPress: () => send({ type: 'countPad' }) },
      ]
    } else {
      actions = [
        { label: t('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }) },
        { label: t('action.binDone'), icon: <ClipboardCheck />, heldReason: !model.online ? t('held.binDoneOffline') : model.busy ? t('held.busy') : (model.kept?.length ?? 0) > 0 ? t('held.keptWaiting', { count: model.kept!.length }) : !model.bin?.count ? t('held.noCount') : null, onPress: () => send({ type: 'binDone' }) },
      ]
    }
    body = <BinStep model={model} t={t} amount={amount} figure={figure} time={time} locale={locale} ds={ds} camProps={camProps} scanWords={scanWords} send={send} />
  } else if (model.step.kind === 'done') {
    actions = [
      { label: t('action.lookAgain'), icon: <Search />, onPress: () => send({ type: 'lookAgain' }) },
      { label: t('action.finish'), icon: <Send />, heldReason: model.busy ? t('held.busy') : null, onPress: () => send({ type: 'finish' }) },
    ]
    body = <DoneStep model={model} t={t} amount={amount} locale={locale} ds={ds} />
  } else if (model.step.kind === 'finished') {
    actions = [{ label: t('action.another'), icon: <ScanLine />, onPress: () => send({ type: 'another' }) }]
    body = <FinishedStep finish={model.finish ?? null} t={t} />
  } else {
    body = (
      <div className="fw-floor-stack">
        {!model.online ? <HeldLine text={t('offline.line')} /> : null}
        <ScanInput
          label={t('what.scan.label')}
          hint={model.held ? floor('tile.held.notice') : t('what.scan.hint')}
          scannedLabel={scanWords.scannedLabel}
          keyboardLabel={scanWords.keyboardLabel}
          disabled={Boolean(model.held)}
          camera={camProps}
          onScan={(code) => send({ type: 'scan', code })}
        />
        <WhatToCount model={model} t={t} shared={shared} time={time} send={send} />
      </div>
    )
  }

  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={actions ? <FloorActionBar label={t('title')} actions={actions} /> : undefined}>
      <div className="fw-count">{body}</div>
    </FloorFrameView>
  )
}

/** What to count: the site's running counts' bins, recounts first; a recount of the person's own count is shown, never offered. */
function WhatToCount({ model, t, shared, time, send }: { model: CountViewModel; t: Translate; shared: Translate; time: (value: string) => string; send: Send }) {
  const toCount = model.toCount ?? null
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-count-what">
      <h2 id="fw-count-what" className="fw-floor-section-title">
        {t('what.title')}
      </h2>
      {model.toCountAsOf ? <p className="fw-floor-muted">{t('asOf', { time: time(model.toCountAsOf) })}</p> : null}
      {toCount === null ? (
        model.toCountProblem === 'offline' ? (
          <p className="fw-floor-muted">{t('what.notOnTablet')}</p>
        ) : model.toCountProblem === 'error' ? (
          <p className="fw-floor-muted">{t('what.error')}</p>
        ) : (
          <FloorState tone="info" icon={<Layers />} title={t('what.loading')} busy />
        )
      ) : toCount.bins.length === 0 ? (
        <FloorState tone="info" icon={<Layers />} title={t('what.empty.title')} text={t('what.empty.body')} />
      ) : (
        <>
          <FloorList label={t('what.title')}>
            {toCount.bins.map((bin) => (
              <FloorListRow
                key={`${bin.count.id}:${bin.location.id}:${bin.kind}`}
                icon={bin.kind === 'RECOUNT' ? <RotateCcw /> : <Layers />}
                tone={bin.yours ? 'neutral' : bin.kind === 'RECOUNT' ? 'warning' : 'info'}
                title={<span className="fw-floor-code">{bin.location.code}</span>}
                meta={[bin.location.name, t('what.row.count', { number: bin.count.number }), t('what.row.since', { time: time(bin.since) }), bin.count.freezeMoves ? t('what.row.frozen') : null].filter(Boolean).join(' · ')}
                status={bin.yours ? t('what.row.yours') : t(`pass.${bin.kind}`)}
                heldReason={bin.yours ? t('what.row.yoursWhy') : null}
                onPress={bin.yours ? undefined : () => send({ type: 'openBin', countId: bin.count.id, placeCode: bin.location.labelCode ?? bin.location.code })}
              />
            ))}
          </FloorList>
          <ListFooter
            count={t('what.count', { count: toCount.bins.length })}
            keys={[
              { key: 'Tab', does: shared('keys.tab') },
              { key: 'Enter', does: t('keys.open') },
              { key: 'Esc', does: t('keys.home') },
            ]}
          />
        </>
      )}
    </section>
  )
}

/** Several running counts count this bin: which one is counted here. */
function ChooseStep({ model, t, send }: { model: CountViewModel; t: Translate; send: Send }) {
  const bin = model.bin ?? null
  if (!bin) return null
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-count-choose">
      <h2 id="fw-count-choose" className="fw-floor-section-title">
        {t('choose.title', { place: bin.location.code })}
      </h2>
      <p className="fw-floor-muted">{t('choose.hint', { count: bin.counts.length })}</p>
      <FloorList label={t('choose.title', { place: bin.location.code })}>
        {bin.counts.map((count) => (
          <FloorListRow key={count.id} icon={<ClipboardCheck />} tone="info" title={<span className="fw-floor-code">{count.number}</span>} meta={kindWord(t, count.kind)} status={count.freezeMoves ? t('what.row.frozen') : undefined} onPress={() => send({ type: 'pickCount', countId: count.id })} />
        ))}
      </FloorList>
    </section>
  )
}

/** The bin's card, the big numeral, the last unit, the scan field (or the pad) and the bin's lines, blind. */
function BinStep({
  model,
  t,
  amount,
  figure,
  time,
  locale,
  ds,
  camProps,
  scanWords,
  send,
}: {
  model: CountViewModel
  t: Translate
  amount: Amount
  figure: (value: number) => string
  time: (value: string) => string
  locale: string
  ds: ReturnType<typeof useDsWords>
  camProps: CamProps
  scanWords: { scannedLabel: (code: string) => string; keyboardLabel: string }
  send: Send
}) {
  const floor = useT('floor')
  const bin = model.bin ?? null
  const kept = model.kept ?? []
  const pad = model.pad ?? null
  if (!bin) return null
  const units = unitsScanned(bin, kept)
  const pass = passOf(bin)
  const counted = binCounted(bin)
  const typed = new Set(padLines(bin).map((line) => line.lineId))
  const padLine = pad && pad.target.kind === 'line' ? (bin.lines.find((line) => line.lineId === (pad.target as { lineId: string }).lineId) ?? null) : null
  const padTitle = pad ? (pad.target.kind === 'code' ? t('pad.titleCode', { code: pad.target.code }) : t('pad.titleLine', { item: padLine ? unitName(padLine) : '' })) : null
  const readAloud = [t('bin.kind'), bin.location.code, bin.location.name, bin.count ? t('bin.readCount', { number: bin.count.number }) : null, t('bin.readUnits', { count: units })].filter(Boolean).join('. ')
  const scanHint = model.held ? floor('tile.held.notice') : model.busy ? t('held.busy') : counted ? t('bin.counted') : t('scan.hint')
  return (
    <div className="fw-floor-stack">
      {!model.online ? <HeldLine text={t('offline.bin')} /> : null}
      {model.binAsOf ? <p className="fw-floor-muted">{t('asOf', { time: time(model.binAsOf) })}</p> : null}
      <FloorCard
        icon={<Layers />}
        kind={t('bin.kind')}
        code={bin.location.code}
        title={bin.location.name}
        status={{ label: t(`pass.${pass}`), tone: pass === 'RECOUNT' ? 'warning' : 'info' }}
        facts={[
          { id: 'count', label: t('bin.fact.count'), value: bin.count?.number ?? null },
          { id: 'lines', label: t('bin.fact.lines'), value: bin.lines.length > 0 ? String(bin.lines.length) : null },
          { id: 'frozen', label: t('bin.fact.moves'), value: bin.count?.freezeMoves ? t('bin.frozen') : null },
        ]}
        flags={[{ id: 'blind', label: t('bin.blind'), tone: 'info' }]}
        asOf={model.binAsOf ?? null}
        formatTime={time}
        labels={ds.floorCard}
      >
        <ReadAloudButton text={readAloud} lang={locale === 'it' ? 'it-IT' : 'en-GB'} labels={ds.readAloud} size="md" />
      </FloorCard>
      <p className="fw-count-numeral" aria-live="polite" aria-atomic="true">
        <span className="fw-count-numeral-value">{figure(units)}</span>
        <span className="fw-count-numeral-label">{t('bin.units', { count: units })}</span>
      </p>
      <LastLine last={model.last ?? null} t={t} amount={amount} />
      {pad ? (
        <section className="fw-count-pad" aria-labelledby="fw-count-pad-title">
          <h2 id="fw-count-pad-title" className="fw-floor-section-title">
            <span className="fw-floor-inline-icon" aria-hidden="true">
              <Package />
            </span>
            {padTitle}
          </h2>
          <QuantityPad
            label={t('pad.label')}
            value={pad.value}
            onChange={(value) => send({ type: 'pad', value })}
            unit={unitWord(t, pad.target.uom)}
            min={padBounds(pad.target.uom).min}
            decimals={padBounds(pad.target.uom).decimals}
            decimalSeparator={locale === 'it' ? ',' : '.'}
            separatorLabel={t('pad.separator')}
            decrementLabel={t('pad.minus')}
            incrementLabel={t('pad.plus')}
            clearLabel={t('pad.clear')}
            backLabel={t('pad.back')}
            emptyLabel={t('pad.empty')}
            rangeLabel={(min) => t('pad.range', { min: figure(min ?? 0) })}
            message={t('pad.blind')}
            messageTone="info"
            autoFocus
          />
        </section>
      ) : (
        <ScanInput
          label={t('scan.label')}
          hint={scanHint}
          scannedLabel={scanWords.scannedLabel}
          keyboardLabel={scanWords.keyboardLabel}
          disabled={Boolean(model.held) || Boolean(model.busy)}
          camera={camProps}
          onScan={(code) => send({ type: 'scan', code })}
        />
      )}
      <section className="fw-floor-stack" aria-labelledby="fw-count-lines">
        <h2 id="fw-count-lines" className="fw-floor-section-title">
          {t('lines.title')}
        </h2>
        {bin.lines.length === 0 ? (
          <p className="fw-floor-muted">{kept.length > 0 ? t('lines.keptOnly') : t('lines.empty')}</p>
        ) : (
          <>
            <FloorList label={t('lines.title')}>
              {bin.lines.map((line) => (
                <LineRow key={line.lineId} line={line} kept={kept} t={t} amount={amount} selected={padLine?.lineId === line.lineId} onType={typed.has(line.lineId) && !pad && !model.busy && !model.held ? () => send({ type: 'line', lineId: line.lineId }) : undefined} />
              ))}
            </FloorList>
            {kept.some((unit) => unit.lineId === null) ? <p className="fw-floor-muted">{t('lines.keptUnknown', { count: kept.filter((unit) => unit.lineId === null).length })}</p> : null}
            <ListFooter
              count={t('lines.count', { count: bin.lines.length })}
              keys={[
                { key: 'Enter', does: pad ? t('keys.countPad') : t('keys.binDone') },
                { key: '0–9', does: t('keys.digits') },
                { key: 'Esc', does: pad ? t('keys.cancelPad') : t('keys.back') },
              ]}
            />
          </>
        )}
      </section>
    </div>
  )
}

function LineRow({ line, kept, t, amount, selected, onType }: { line: BinLine; kept: readonly KeptUnit[]; t: Translate; amount: Amount; selected: boolean; onType?: () => void }) {
  const tally = lineTally(line, kept)
  const tag = line.hide !== null
  const meta = [
    line.item.code !== unitName(line) ? line.item.code : null,
    line.item.name,
    line.origin === 'ADDED' ? t('lines.added') : null,
    line.pass === 'RECOUNT' ? t('pass.RECOUNT') : null,
    tally.kept > 0 ? t('lines.kept', { count: tally.kept }) : null,
    onType ? t('lines.tapToType') : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const status = line.pass === null ? t('lines.counted') : tally.scans === 0 ? t('lines.notYet') : t('lines.scans', { count: tally.scans })
  const tone: FloorTone = line.pass === null ? 'success' : tally.scans > 0 ? 'primary' : 'neutral'
  return (
    <FloorListRow
      icon={line.pass === null ? <Check /> : tag ? <Layers /> : <Package />}
      tone={tone}
      title={<span className="fw-floor-code">{unitName(line)}</span>}
      meta={meta}
      status={status}
      count={tally.scans > 0 && line.pass !== null ? amount(tally.scanned, line.item.uom) : undefined}
      countLabel={tally.scans > 0 && line.pass !== null ? t('lines.scanned') : undefined}
      selected={selected}
      onPress={onType}
    />
  )
}

/** The last unit: what it counted and where it stands (two ticks), a unit found that was not expected, or amber "Already counted". */
function LastLine({ last, t, amount }: { last: CountLast | null; t: Translate; amount: Amount }) {
  if (!last) return null
  if (last.kind === 'already') {
    return (
      <TaskLine tone="warning" icon={<CircleAlert />} alert>
        {t('last.already', { code: last.code })}
      </TaskLine>
    )
  }
  if (last.kind === 'kept') {
    return (
      <div className="fw-count-last" role="status">
        <TaskLine tone="info" icon={<ScanLine />}>
          {last.quantity ? t('last.keptQuantity', { code: last.code ?? last.item ?? '', quantity: amount(last.quantity, last.uom) }) : t('last.kept', { code: last.code ?? last.item ?? '' })}
        </TaskLine>
        <Ticks state={last.ticks} />
      </div>
    )
  }
  return (
    <div className="fw-count-last" role="status">
      <TaskLine tone={last.added ? 'warning' : 'success'} icon={last.added ? <PackagePlus /> : <Check />}>
        {last.added ? t('last.added', { code: last.code ?? last.item, quantity: amount(last.quantity, last.uom) }) : t('last.counted', { code: last.code ?? last.item, quantity: amount(last.quantity, last.uom) })}
      </TaskLine>
      <Ticks state={last.ticks} />
    </div>
  )
}

/** Differences after Bin done: missing and extra units with tones, short and over lots, or "No difference." with a tick. */
function DoneStep({ model, t, amount, locale, ds }: { model: CountViewModel; t: Translate; amount: Amount; locale: string; ds: ReturnType<typeof useDsWords> }) {
  const done = model.done ?? null
  if (!done) return null
  const { differ, match } = differenceRows(done.differences)
  const counts = { missing: differ.filter((row) => row.kind === 'MISSING').length, extra: differ.filter((row) => row.kind === 'EXTRA').length, other: differ.filter((row) => row.kind === 'SHORT' || row.kind === 'OVER').length }
  const summary = done.none ? t('done.none') : t('done.summary', counts)
  const note = done.note ? (locale === 'it' ? done.note.it : done.note.en) : done.movedSinceStart > 0 ? t('done.moved', { count: done.movedSinceStart }) : null
  return (
    <div className="fw-floor-stack">
      <FloorCard
        icon={<ListChecks />}
        kind={t('done.kind')}
        code={done.location.code}
        title={done.location.name}
        status={{ label: done.none ? t('done.noneShort') : t('done.differShort', { count: differ.length }), tone: done.none ? 'success' : 'warning' }}
        facts={[
          { id: 'count', label: t('bin.fact.count'), value: done.count.number },
          { id: 'missing', label: t('done.fact.missing'), value: String(counts.missing), tone: counts.missing > 0 ? 'danger' : undefined },
          { id: 'extra', label: t('done.fact.extra'), value: String(counts.extra), tone: counts.extra > 0 ? 'warning' : undefined },
          { id: 'match', label: t('done.fact.match'), value: String(match.length) },
        ]}
        labels={ds.floorCard}
      >
        <ReadAloudButton text={[t('done.kind'), done.location.code, summary, note].filter(Boolean).join('. ')} lang={locale === 'it' ? 'it-IT' : 'en-GB'} labels={ds.readAloud} size="md" />
      </FloorCard>
      {note ? (
        <TaskLine tone="info" icon={<CircleAlert />}>
          {note}
        </TaskLine>
      ) : null}
      <section className="fw-floor-stack" aria-labelledby="fw-count-differences">
        <h2 id="fw-count-differences" className="fw-floor-section-title">
          {t('done.title')}
        </h2>
        {done.none ? (
          <FloorState tone="success" icon={<CircleCheck />} title={t('done.none')} text={t('done.noneBody')} />
        ) : (
          <>
            <FloorList label={t('done.title')}>
              {differ.map((row) => (
                <DifferenceRow key={row.lineId} row={row} t={t} amount={amount} />
              ))}
            </FloorList>
            <p className="fw-floor-muted">{t('done.lookAgainHint')}</p>
          </>
        )}
        {match.length > 0 && !done.none ? <p className="fw-floor-muted">{t('done.matchLine', { count: match.length })}</p> : null}
      </section>
    </div>
  )
}

function DifferenceRow({ row, t, amount }: { row: Difference; t: Translate; amount: Amount }) {
  const difference = num(row.difference)
  return (
    <FloorListRow
      icon={DIFFERENCE_ICON[row.kind]}
      tone={DIFFERENCE_TONE[row.kind]}
      title={<span className="fw-floor-code">{unitName(row)}</span>}
      meta={[t(`difference.${row.kind}`), row.item.code !== unitName(row) ? row.item.code : null, row.item.name].filter(Boolean).join(' · ')}
      status={t('difference.expectedScanned', { expected: amount(row.expected, row.item.uom), scanned: amount(row.scanned, row.item.uom) })}
      count={`${difference > 0 ? '+' : ''}${amount(difference, null)}`}
      countLabel={unitWord(t, row.item.uom)}
    />
  )
}

/** The bin finished: what the office counts now, the lines another person recounts, or kept on this tablet. */
function FinishedStep({ finish, t }: { finish: CountFinish | null; t: Translate }) {
  if (!finish) return null
  const answer = finish.answer
  return (
    <div className="fw-floor-stack">
      <FloorState tone={finish.ticks === 'refused' ? 'danger' : 'success'} icon={finish.ticks === 'refused' ? <CircleAlert /> : <CircleCheck />} title={t('finished.title', { place: answer?.location.code ?? finish.place })} text={answer ? t('finished.body', { counted: answer.counted, lines: answer.lines, number: answer.count.number }) : t('finished.keptBody', { number: finish.count })}>
        <Ticks state={finish.ticks} />
      </FloorState>
      {answer && answer.recountsAsked.length > 0 ? (
        <TaskLine tone="warning" icon={<RotateCcw />}>
          {t('finished.recounts', { count: answer.recountsAsked.length, lines: answer.recountsAsked.map((line) => line.seq).join(', ') })}
        </TaskLine>
      ) : null}
      <TaskLine tone="info" icon={<Send />}>
        {t('finished.approval')}
      </TaskLine>
    </div>
  )
}
