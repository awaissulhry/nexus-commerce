'use client'

import { useCallback, useMemo, useState } from 'react'
import { Keyboard, Printer, UserRoundPlus, UserRoundX } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { Button, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { LoadBar, PlanningBoard, type PlanningMove, type PlanningPlace } from '@nexus/ui/patterns/planning-board/index'
import { formatNumber, formatTime } from '../../../../lib/i18n/format'
import { DateField } from '../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { BOARD_KIT_NAMESPACE, useBoardWords } from '../../../_shared/planning-board/words'
import type { Phrase } from '../../_shared/model'
import type { DispatchBoard, DispatchLine, LaneOperator, StationLane } from '../api'
import {
  absentOf,
  boardHeld,
  dayWords,
  dispatchBoardWords,
  DISPATCH_NAMESPACE,
  drawBoard,
  dropHeldOf,
  loadPhrase,
  operatorWords,
  plannedWhy,
  presencePhrase,
  printHrefOf,
  stationLabel,
  stationLoadWords,
  type Words,
} from '../model'
import type { DispatchActions, DispatchViewModel } from '../view-model'
import { DispatchDialogs } from './DispatchDialogs'
import '../dispatch.css'

/**
 * SCR-138 — Production › Dispatch (design production.dispatch: Load against minutes, Board, Not assigned; Assign operator, Move
 * bundles, the dispatch list per station or line). The head says when the board was read, the plan it works to and the site's
 * rules; a card per line holds its load (LoadBar + the design's words) and its stations with who works there (the DS lane
 * head holds text only, so Assign, Reassign and Print stand here); the DS PlanningBoard in its columns layout draws the stations
 * as lanes, Not assigned as the tray, the moves with Undo and every held drop. Load per line and station, never per person.
 *
 * With no `actions` (the design index) the moves stay in this view: nothing is saved.
 */
export function DispatchView({ model, actions }: { model: DispatchViewModel; actions?: DispatchActions }) {
  return (
    <WithMessages namespaces={[DISPATCH_NAMESPACE, BOARD_KIT_NAMESPACE]}>
      <Body model={model} actions={actions} />
    </WithMessages>
  )
}

const say = (t: (key: string, params?: Phrase['params']) => string, phrase: Phrase | null): string | null => (phrase ? t(phrase.key, phrase.params) : null)

function Body({ model, actions }: { model: DispatchViewModel; actions?: DispatchActions }) {
  const t = useT(DISPATCH_NAMESPACE)
  if (!model.can.view) return <EmptyState title={t('noPermission.title')} description={t('noPermission.body')} />
  if (model.read.status === 'error') {
    return (
      <div className="fw-dp">
        <Banner tone="danger" title={t('error.title')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>}>
          {t(model.read.problem)}
        </Banner>
      </div>
    )
  }
  if (model.read.status === 'loading') {
    return (
      <div className="fw-dp" role="status" aria-label={t('common.loading')} aria-busy="true">
        <Skeleton height={32} />
        <div className="fw-dp-lines">
          <Skeleton height={148} />
          <Skeleton height={148} />
        </div>
        <Skeleton height={320} />
      </div>
    )
  }
  return <Ready model={model} board={model.read.value} actions={actions} />
}

function Ready({ model, board, actions }: { model: DispatchViewModel; board: DispatchBoard; actions?: DispatchActions }) {
  const t = useT(DISPATCH_NAMESPACE)
  const locale = useLocale()
  const kit = useBoardWords()
  const words = useMemo<Words>(() => ({ t, locale, timeZone: board.site.timeZone }), [t, locale, board.site.timeZone])
  const place = useMemo(() => ({ locale, timeZone: board.site.timeZone }), [locale, board.site.timeZone])

  // The design index has no container: the moves stay in this view.
  const [localPlaces, setLocalPlaces] = useState<Readonly<Record<string, PlanningPlace>>>({})
  const drawn = useMemo(() => drawBoard(board, model.address, model.aliases, words), [board, model.address, model.aliases, words])
  const cards = useMemo(() => (actions?.onMove ? drawn.cards : drawn.cards.map((card) => (localPlaces[card.id] ? { ...card, ...localPlaces[card.id] } : card))), [drawn, actions?.onMove, localPlaces])
  const held = boardHeld(board, model.offline)
  const onMove = useCallback(
    async (move: PlanningMove) => {
      if (actions?.onMove) return actions.onMove(move)
      setLocalPlaces((current) => ({ ...current, [move.cardId]: move.to }))
      return true
    },
    [actions],
  )
  const dropHeld = useCallback((card: { id: string }, to: PlanningPlace) => say(t, dropHeldOf(board, drawn.byId.get(card.id), to)), [board, drawn, t])
  const boardWords = useMemo(() => ({ ...kit.board, ...dispatchBoardWords(t) }), [kit.board, t])
  const loadWords = useMemo(() => ({ ...kit.load, ...stationLoadWords(t) }), [kit.load, t])
  const lines = model.address.line ? board.lines.filter((line) => line.id === model.address.line) : board.lines
  const printAll = lines.length > 0 ? printHrefOf(model.prefix, { lines: lines.map((line) => line.id) }, board.day) : null

  return (
    <div className="fw-dp">
      <div className="fw-dp-head">
        <span className="fw-dp-status">
          <span role="status">
            {t('head.asOf', { time: formatTime(board.asOf, place) })} · {t(`live.${model.live}`)}
            {model.changedAt ? ` · ${t('head.changed', { time: formatTime(model.changedAt, place) })}` : ''}
          </span>
          <Tag tone="neutral">{board.version ? t('head.plan', { number: board.version.number }) : t('head.noPlan')}</Tag>
          <Tag tone="neutral">{t(`rule.sequence.${board.rules.sequence}`)}</Tag>
          <Tag tone="neutral">{t(`rule.qualification.${board.rules.qualification}`)}</Tag>
          {!board.attendance.open && <Tag tone="neutral">{t('head.attendanceOff')}</Tag>}
        </span>
        <span className="fw-dp-actions">
          {model.sites.length > 1 && (
            <Select size="sm" aria-label={t('head.site')} value={board.site.id} onChange={(event) => actions?.onAddress?.({ site: event.target.value, line: null })}>
              {model.sites.map((site) => (
                <option key={site.id} value={site.id}>{site.code ? `${site.code} · ${site.name}` : site.name}</option>
              ))}
            </Select>
          )}
          <DateField className="fw-dp-date" value={board.day} locale={INTL_LOCALE[locale]} ariaLabel={t('head.day')} onChange={(value) => actions?.onAddress?.({ date: value && value !== board.today ? value : null })} />
          {board.day !== board.today && (
            <Button size="sm" onClick={() => actions?.onAddress?.({ date: null })}>
              {t('head.today')}
            </Button>
          )}
          <Button size="sm" variant="quiet" aria-label={t('keys.title')} onClick={() => actions?.onDialog?.({ kind: 'keys' })}>
            <Keyboard size={14} aria-hidden />
          </Button>
          {printAll ? (
            <Button size="sm" variant="primary" asChild>
              <a href={printAll} target="_blank" rel="noopener">
                <Printer size={14} aria-hidden /> {t('head.print')}
              </a>
            </Button>
          ) : (
            <Button size="sm" variant="primary" heldReason={t('held.noLines')}>
              <Printer size={14} aria-hidden /> {t('head.print')}
            </Button>
          )}
        </span>
      </div>

      {board.past && <Banner tone="info" title={t('banner.past', { day: dayWords(board.day, words) })} />}
      {!board.rules.namesWorkers && <Banner tone="info" title={t('banner.noNames')} />}
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={say(t, model.notice.words)}
          action={
            <span className="fw-dp-inline">
              {model.notice.undo && (
                <Button size="sm" heldReason={model.busy ? t('held.busy') : held ? say(t, held) : null} onClick={() => actions?.onUndoNotice?.()}>
                  {t('common.undo')}
                </Button>
              )}
              <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
                {t('common.dismiss')}
              </Button>
            </span>
          }
        />
      )}

      <section className="fw-dp-section" aria-labelledby="fw-dp-load-title">
        <h2 className="fw-dp-h2" id="fw-dp-load-title">
          {t('load.title')}
        </h2>
        {board.lines.length === 0 && board.otherStations.length === 0 ? (
          <EmptyState title={t('load.none.title')} description={t('load.none.body')} />
        ) : (
          <div className="fw-dp-lines">
            {board.lines.map((line) => (
              <LineCard key={line.id} line={line} board={board} model={model} actions={actions} words={words} />
            ))}
            {board.otherStations.length > 0 && !model.address.line && (
              <Card padded className="fw-dp-line">
                <h3 className="fw-dp-h3">{t('lane.other')}</h3>
                <Stations stations={board.otherStations} board={board} model={model} actions={actions} />
              </Card>
            )}
          </div>
        )}
      </section>

      <section className="fw-dp-section" aria-labelledby="fw-dp-board-title">
        <h2 className="fw-dp-h2" id="fw-dp-board-title">
          {t('board.title')}
        </h2>
        {drawn.lanes.length === 0 && drawn.empty ? null : drawn.empty ? (
          board.version ? (
            <EmptyState title={t('board.empty.title')} description={t('board.empty.body')} />
          ) : (
            <EmptyState
              title={t('board.noPlan.title')}
              description={t('board.noPlan.body')}
              action={
                <Button size="sm" asChild>
                  <a href={`${model.prefix}/planning/board`}>{t('board.noPlan.link')}</a>
                </Button>
              }
            />
          )
        ) : (
          <PlanningBoard
            key={`${board.site.id}:${board.day}`}
            className="fw-dp-board"
            label={t('board.label', { site: board.site.name, day: dayWords(board.day, words) })}
            layout="columns"
            lanes={drawn.lanes}
            buckets={drawn.buckets}
            cards={cards}
            onMove={onMove}
            onOpen={(card) => actions?.onDialog?.({ kind: 'card', cardId: card.id })}
            dropHeld={dropHeld}
            heldReason={held ? say(t, held) : null}
            cellDetails={false}
            words={boardWords}
            loadWords={loadWords}
            locale={INTL_LOCALE[locale]}
            {...(model.moving ? { defaultMove: { cardId: model.moving.cardId, to: { laneId: model.moving.laneId, bucketId: drawn.buckets[0]?.id ?? null } } } : {})}
          />
        )}
      </section>

      <DispatchDialogs model={model} board={board} drawn={drawn} actions={actions} />
    </div>
  )
}

/** One line: its load against minutes (the design's BenchmarkBar words), its stations; the line sets the board below. */
function LineCard({ line, board, model, actions, words }: { line: DispatchLine; board: DispatchBoard; model: DispatchViewModel; actions?: DispatchActions | undefined; words: Words }) {
  const t = useT(DISPATCH_NAMESPACE)
  const locale = useLocale()
  const kit = useBoardWords()
  const pressed = model.address.line === line.id
  const why = plannedWhy(board, line.load)
  const absent = absentOf(board, line.load)
  const name = `${line.code} · ${line.name}`
  return (
    <Card padded className={pressed ? 'fw-dp-line is-chosen' : 'fw-dp-line'}>
      <div className="fw-dp-line-head">
        <h3 className="fw-dp-h3">
          <Button size="sm" variant="link" inline aria-pressed={pressed} title={pressed ? t('load.allLines') : t('load.onlyLine')} onClick={() => actions?.onAddress?.({ line: pressed ? null : line.id })}>
            {name}
          </Button>
        </h3>
        <Button size="xs" variant="quiet" asChild>
          <a href={printHrefOf(model.prefix, { lines: [line.id] }, board.day)} target="_blank" rel="noopener" aria-label={t('stations.printLine', { line: line.code })}>
            <Printer size={14} aria-hidden />
          </a>
        </Button>
      </div>
      <LoadBar booked={line.load.queuedMinutes} available={line.load.availableMinutes} label={name} size="md" labelVisible={false} words={{ ...kit.load, closed: t('load.noMinutes'), sentenceClosed: t('load.noMinutesSentence') }} locale={INTL_LOCALE[locale]} />
      <p className="fw-dp-words">{say(t, loadPhrase(line.load, words.locale))}</p>
      <p className="fw-dp-muted">
        {why ? t(`source.${why}`) : t('source.CLOCKED_IN', { count: line.load.people ?? 0 })}
        {' · '}
        {t('load.efficiency', { pct: formatNumber(Number(line.load.efficiencyPct), locale) })}
        {absent !== null ? ` · ${t('load.absent', { count: absent })}` : ''}
      </p>
      <Stations stations={line.stations} board={board} model={model} actions={actions} />
    </Card>
  )
}

function Stations({ stations, board, model, actions }: { stations: readonly StationLane[]; board: DispatchBoard; model: DispatchViewModel; actions?: DispatchActions | undefined }) {
  const t = useT(DISPATCH_NAMESPACE)
  if (stations.length === 0) return <p className="fw-dp-muted">{t('stations.none')}</p>
  return (
    <ul className="fw-dp-stations" aria-label={t('stations.title')}>
      {stations.map((station) => (
        <StationRow key={station.id} station={station} board={board} model={model} actions={actions} />
      ))}
    </ul>
  )
}

/** A station: its name, who works there with their level for its first card, Assign, its printed list. */
function StationRow({ station, board, model, actions }: { station: StationLane; board: DispatchBoard; model: DispatchViewModel; actions?: DispatchActions | undefined }) {
  const t = useT(DISPATCH_NAMESPACE)
  const held = boardHeld(board, model.offline)
  const label = stationLabel(board, station)
  const assignHeldWords = !board.rules.namesWorkers ? t('refusal.SITE_NAMES_NO_WORKERS') : say(t, held)
  return (
    <li className={station.reassign ? 'fw-dp-station is-flagged' : 'fw-dp-station'}>
      <span className="fw-dp-station-name">
        <strong>{station.code}</strong> <span className="fw-dp-muted">{station.name}</span>
      </span>
      {board.rules.namesWorkers && (
        <span className="fw-dp-station-who">
          {station.operators.length === 0 ? <span className="fw-dp-muted">{t('lane.noOperator')}</span> : station.operators.map((operator) => <Operator key={operator.assignmentId} operator={operator} operationId={station.cards[0]?.operation.id ?? null} place={label} held={held} model={model} actions={actions} />)}
        </span>
      )}
      <span className="fw-dp-inline">
        {board.rules.namesWorkers && (
          <Button size="xs" heldReason={assignHeldWords} onClick={() => actions?.onAssignStart?.({ kind: 'station', stationId: station.id, operationId: station.cards[0]?.operation.id ?? null, place: label })}>
            <UserRoundPlus size={13} aria-hidden /> {t('stations.assign')}
          </Button>
        )}
        <Button size="xs" variant="quiet" asChild>
          <a href={printHrefOf(model.prefix, { station: station.id }, board.day)} target="_blank" rel="noopener" aria-label={t('stations.printStation', { station: station.code })}>
            <Printer size={13} aria-hidden />
          </a>
        </Button>
      </span>
    </li>
  )
}

/** A name, a level, and for whoever runs the board where they stand: a word, never why, never a figure. */
function Operator({ operator, operationId, place, held, model, actions }: { operator: LaneOperator; operationId: string | null; place: string; held: Phrase | null; model: DispatchViewModel; actions?: DispatchActions | undefined }) {
  const t = useT(DISPATCH_NAMESPACE)
  const presence = presencePhrase(operator)
  const heldWords = model.busy ? t('held.busy') : say(t, held)
  return (
    <span className="fw-dp-operator">
      <span>{operatorWords(operator, t)}</span>
      {presence && <Tag tone={presence.tone}>{say(t, presence.words)}</Tag>}
      {operator.reassign && (
        <Button size="xs" heldReason={heldWords} onClick={() => actions?.onAssignStart?.({ kind: 'reassign', assignmentId: operator.assignmentId, version: operator.version, operationId, from: operator.name, place })}>
          {t('stations.reassign')}
        </Button>
      )}
      {model.can.manage && (
        <Button size="xs" variant="quiet" aria-label={t('stations.remove', { person: operator.name })} heldReason={heldWords} onClick={() => actions?.onRemove?.(operator, place)}>
          <UserRoundX size={13} aria-hidden />
        </Button>
      )}
    </span>
  )
}
