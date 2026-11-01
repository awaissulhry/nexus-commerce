'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CalendarX2, ChevronLeft, ChevronRight, MoreHorizontal, Search } from 'lucide-react'
import { Banner, Disclosure, EmptyState, Menu, type MenuItemDef } from '@nexus/ui/components'
import { Button, FilterChip, Input, SegmentedControl, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { PlanningBoard, type PlanningMove, type PlanningPlace } from '@nexus/ui/patterns/planning-board/index'
import { DateField } from '../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { BOARD_KIT_NAMESPACE, useBoardWords } from '../../../_shared/planning-board/words'
import type { Board, BoardBucket } from '../api'
import {
  BOARD_VIEWS,
  bandPublishHeld,
  dayWords,
  dropHeldOf,
  drawBoard,
  laneKeyOf,
  NAMESPACE,
  problemRows,
  publishHeldWords,
  refusalWords,
  shiftFrom,
  timeWords,
  whenWords,
  windowFrom,
  WO_STATUSES,
  type BoardControls,
  type Words,
} from '../model'
import type { BoardActions, BoardViewModel } from '../view-model'
import { BoardDialogs } from './BoardDialogs'
import '../board.css'

/**
 * SCR-122 — the planning board (design planning.board: Board controls, Load per lane, Schedule, Not on the board,
 * Problems in this plan; the bar, drop-warning, publish, cell and legend pop-ups). The DS PlanningBoard (D18) draws the
 * lanes, the load per lane and bucket, the bars and the tray; this view draws the band (site, as of, save words,
 * Publish to floor held with its reason), the controls (every choice in the address), the problems and the dialogs.
 * Never optimistic: a bar shows "Saving" until the API answers, and a refused move stays where it was.
 *
 * With no `actions` (the design index) the controls and moves work in this view only: nothing is saved.
 */
export function BoardView({ model, actions }: { model: BoardViewModel; actions?: BoardActions }) {
  return (
    <WithMessages namespaces={[NAMESPACE, BOARD_KIT_NAMESPACE]}>
      <BoardBody model={model} actions={actions} />
    </WithMessages>
  )
}

const ZOOMS: readonly BoardBucket[] = ['DAY', 'WEEK', 'MONTH']

const isTyping = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null
  if (!element || typeof element.closest !== 'function') return false
  return element.isContentEditable || element.closest('input, textarea, select, [role="dialog"], [role="menu"], [data-pb-card], [data-pb-move]') !== null
}

function BoardBody({ model, actions }: { model: BoardViewModel; actions?: BoardActions }) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const kit = useBoardWords()
  const board = model.read.status === 'ready' ? model.read.value : null
  const timeZone = board?.site.timeZone ?? 'Europe/Rome'
  const words = useMemo<Words>(() => ({ t, locale, timeZone }), [t, locale, timeZone])
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // The design index has no container: the controls and the moves stay in this view.
  const [localControls, setLocalControls] = useState(model.controls)
  useEffect(() => setLocalControls(model.controls), [model.controls])
  const controls = actions?.onControls ? model.controls : localControls
  const setControls = useCallback((next: Partial<BoardControls>) => (actions?.onControls ? actions.onControls(next) : setLocalControls((current) => ({ ...current, ...next }))), [actions])
  const [localPlaces, setLocalPlaces] = useState<Record<string, PlanningPlace>>({})

  const drawn = useMemo(() => (board ? drawBoard(board, controls, words, model.me) : null), [board, controls, words, model.me])
  const cards = useMemo(() => (drawn ? (actions?.onMove ? drawn.cards : drawn.cards.map((card) => (localPlaces[card.id] ? { ...card, ...localPlaces[card.id] } : card))) : []), [drawn, actions?.onMove, localPlaces])
  const mayChange = board?.plan.mayChange ?? false
  const held = !board ? null : !mayChange ? t('held.readOnly') : model.offline ? t('held.offline') : null
  const onMove = useMemo(() => {
    if (!board || !mayChange) return undefined
    if (actions?.onMove) return actions.onMove
    return (move: PlanningMove) => {
      setLocalPlaces((current) => ({ ...current, [move.cardId]: move.to }))
      return true
    }
  }, [board, mayChange, actions?.onMove])
  const dropHeld = useCallback((card: { id: string; laneId: string | null }, to: PlanningPlace) => (board ? dropHeldOf(board, controls, card, to, t) : null), [board, controls, t])
  const problems = useMemo(() => (board ? problemRows(board, words) : []), [board, words])

  // The page's keys: / search, t today, 1 / 2 / 3 zoom, o / r view (never while typing or on a card: the board's keys).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target) || model.dialog) return
      const key = event.key
      if (key === '/') {
        event.preventDefault()
        searchRef.current?.focus()
      } else if (key === 't') setControls({ from: null })
      else if (key === '1' || key === '2' || key === '3') setControls({ zoom: ZOOMS[Number(key) - 1]!, from: null })
      else if (key === 'o') setControls({ view: 'orders' })
      else if (key === 'r') setControls({ view: 'resources' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setControls, model.dialog])

  // "Show on board": the bar (or the first bar of the lane) is scrolled to and takes the focus.
  useEffect(() => {
    const target = model.focus
    const root = rootRef.current
    if (!target || !root) return
    const escape = (value: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value)
    const card = target.cardId ? root.querySelector<HTMLElement>(`[data-pb-card="${escape(target.cardId)}"]`) : null
    const first = !card && target.laneId ? cards.find((entry) => entry.laneId === target.laneId) : undefined
    const element = card ?? (first ? root.querySelector<HTMLElement>(`[data-pb-card="${escape(first.id)}"]`) : null) ?? root.querySelector<HTMLElement>('.fw-pb-board')
    element?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' })
    element?.focus({ preventScroll: true })
  }, [model.focus, cards])

  const today = board?.today ?? null
  const from = today ? windowFrom(controls, today) : (controls.from ?? '')
  const publishHeld = board ? publishHeldWords(bandPublishHeld(board.plan), words) : t('held.loading')
  const placeHeld = !board ? t('held.loading') : !mayChange ? t('held.readOnly') : model.offline ? t('held.offline') : board.tray.length === 0 ? t('held.trayEmpty') : null

  const more: MenuItemDef[] = [
    { id: 'legend', label: t('more.legend'), onSelect: () => actions?.onOpenDialog?.('legend') },
    { id: 'versions', label: t('more.versions'), onSelect: () => actions?.onOpenDialog?.('versions') },
    { id: 'keys', label: t('more.keys'), onSelect: () => actions?.onOpenDialog?.('keys') },
    { id: 'sep', separator: true },
    { id: 'allocation', label: t('more.allocation'), href: `${model.prefix}/planning/allocation` },
    { id: 'office', label: t('more.office'), href: `${model.prefix}/home` },
  ]

  return (
    <div className="fw-pb" ref={rootRef}>
      <div className="fw-pb-band">
        <div className="fw-pb-scope">
          {model.sites.length > 1 ? (
            <Select size="sm" aria-label={t('band.site')} value={controls.site ?? board?.site.id ?? ''} onChange={(event) => setControls({ site: event.target.value || null, wo: null })}>
              {model.sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {`${site.code} · ${site.name}`}
                </option>
              ))}
            </Select>
          ) : board ? (
            <span className="fw-pb-site">{`${board.site.code} · ${board.site.name}`}</span>
          ) : null}
          <span className="fw-pb-status" role="status">
            {board ? t('band.asOf', { time: timeWords(board.asOf, words) }) : model.read.status === 'loading' ? t('band.reading') : t('band.notRead')}
            {' · '}
            {saveWords(model, words)}
            {model.notice ? ` · ${model.notice}` : ''}
          </span>
        </div>
        <div className="fw-pb-actions">
          <Button size="sm" variant="secondary" heldReason={placeHeld} onClick={() => actions?.onOpenDialog?.('place')}>
            {t('band.place')}
          </Button>
          <Button size="sm" variant="primary" heldReason={publishHeld} onClick={() => actions?.onOpenDialog?.('publish')}>
            {t('band.publish')}
          </Button>
          <Menu label={<MoreHorizontal size={16} aria-hidden />} items={more} align="right" triggerProps={{ 'aria-label': t('more.label') }} />
        </div>
      </div>

      {board ? <p className="fw-pb-plan">{planWords(board, words)}</p> : null}

      <div className="fw-pb-toolbar" role="group" aria-label={t('toolbar.label')}>
        <SegmentedControl size="sm" ariaLabel={t('toolbar.view')} options={BOARD_VIEWS.map((view) => ({ value: view, label: t(`toolbar.views.${view}`) }))} value={controls.view} onChange={(value) => setControls({ view: value === 'orders' ? 'orders' : 'resources' })} />
        <SegmentedControl size="sm" ariaLabel={t('toolbar.zoom')} options={ZOOMS.map((zoom) => ({ value: zoom, label: t(`toolbar.zooms.${zoom}`) }))} value={controls.zoom} onChange={(value) => setControls({ zoom: value as BoardBucket, from: null })} />
        <span className="fw-pb-dates">
          <Button size="sm" variant="secondary" onClick={() => setControls({ from: null })}>
            {t('toolbar.today')}
          </Button>
          <Button size="sm" variant="quiet" aria-label={t('toolbar.earlier')} heldReason={today ? null : t('held.loading')} onClick={() => today && setControls({ from: shiftFrom(controls, today, -1) })}>
            <ChevronLeft size={16} aria-hidden />
          </Button>
          <Button size="sm" variant="quiet" aria-label={t('toolbar.later')} heldReason={today ? null : t('held.loading')} onClick={() => today && setControls({ from: shiftFrom(controls, today, 1) })}>
            <ChevronRight size={16} aria-hidden />
          </Button>
          <DateField className="fw-pb-date" value={from} locale={INTL_LOCALE[locale]} ariaLabel={t('toolbar.date')} onChange={(value) => setControls({ from: value || null })} />
        </span>
        <span className="fw-pb-search">
          <Input
            ref={searchRef}
            size="sm"
            type="search"
            leadingIcon={<Search size={14} aria-hidden />}
            aria-label={t('toolbar.search')}
            placeholder={t('toolbar.searchPlaceholder')}
            value={controls.q}
            onChange={(event) => setControls({ q: event.target.value })}
          />
        </span>
      </div>

      {board ? (
        <div className="fw-pb-filters" role="group" aria-label={t('filters.label')}>
          <span className="fw-pb-filter-name">{t('filters.lanes')}</span>
          {board.lanes.map((lane) => {
            const key = laneKeyOf(lane)
            const on = controls.lanes.includes(key)
            return (
              <FilterChip key={key} pressed={on} onClick={() => setControls({ lanes: on ? controls.lanes.filter((entry) => entry !== key) : [...controls.lanes, key] })}>
                {lane.name}
              </FilterChip>
            )
          })}
          <span className="fw-pb-filter-name">{t('filters.status')}</span>
          {WO_STATUSES.map((status) => {
            const on = controls.statuses.includes(status)
            return (
              <FilterChip key={status} pressed={on} onClick={() => setControls({ statuses: on ? controls.statuses.filter((entry) => entry !== status) : [...controls.statuses, status] })}>
                {t(`woStatus.${status}`)}
              </FilterChip>
            )
          })}
          <FilterChip pressed={controls.material} onClick={() => setControls({ material: !controls.material })}>
            {t('filters.material')}
          </FilterChip>
          <Select size="sm" aria-label={t('filters.style')} value={controls.styles[0] ?? ''} onChange={(event) => setControls({ styles: event.target.value ? [event.target.value] : [] })}>
            <option value="">{t('filters.anyStyle')}</option>
            {stylesOf(board).map((style) => (
              <option key={style.id} value={style.id}>
                {`${style.code} · ${style.name}`}
              </option>
            ))}
          </Select>
          <span className="fw-pb-filter-name">{t('filters.highlight')}</span>
          <FilterChip pressed={controls.late} onClick={() => setControls({ late: !controls.late })}>
            {t('filters.late')}
          </FilterChip>
          <FilterChip pressed={controls.materialMark} onClick={() => setControls({ materialMark: !controls.materialMark })}>
            {t('filters.materialMark')}
          </FilterChip>
        </div>
      ) : null}

      {board && held ? (
        <Banner tone={model.offline ? 'warning' : 'info'} title={held}>
          {model.offline ? t('held.offlineBody') : t('held.readOnlyBody')}
        </Banner>
      ) : null}

      <section className="fw-pb-board" aria-labelledby="fw-pb-schedule" tabIndex={-1}>
        <div className="fw-pb-section-head">
          <h2 className="fw-pb-h2" id="fw-pb-schedule">
            {t(controls.view === 'orders' ? 'board.titleOrders' : 'board.title')}
          </h2>
          <span className="fw-pb-hint">{t(controls.view === 'orders' ? 'board.hintOrders' : 'board.hint')}</span>
        </div>
        {model.read.status === 'loading' ? (
          <div className="fw-pb-skeleton" aria-busy="true" aria-label={t('band.reading')}>
            <Skeleton width="30%" />
            <Skeleton height={56} />
            <Skeleton height={56} />
            <Skeleton height={56} />
          </div>
        ) : model.read.status === 'error' ? (
          <EmptyState
            icon={<CalendarX2 size={28} aria-hidden />}
            title={t('error.title')}
            description={t(`error.${model.read.problem}`)}
            action={
              model.read.problem === 'forbidden' || model.read.problem === 'noSite' ? undefined : (
                <Button size="sm" onClick={() => actions?.onRetry?.()}>
                  {t('error.retry')}
                </Button>
              )
            }
          />
        ) : drawn ? (
          <PlanningBoard
            label={t('board.label', { site: board!.site.name })}
            lanes={drawn.lanes}
            buckets={drawn.buckets}
            cards={cards}
            onMove={onMove}
            onOpen={(card) => actions?.onOpen?.(card)}
            dropHeld={dropHeld}
            heldReason={held}
            cellDetails={controls.view === 'resources'}
            words={{ ...kit.board, empty: t('board.empty'), trayEmpty: t('board.trayEmpty') }}
            loadWords={kit.load}
            locale={INTL_LOCALE[locale]}
          />
        ) : null}
      </section>

      {board ? (
        <section className="fw-pb-problems" aria-labelledby="fw-pb-problems">
          <h2 className="fw-pb-h2" id="fw-pb-problems">
            {t('problems.title')}
          </h2>
          {problems.length === 0 ? (
            <p className="fw-pb-hint">{t('problems.none')}</p>
          ) : (
            <Disclosure summary={t('problems.summary', { count: problems.length })} open>
              <ul className="fw-pb-problem-list">
                {problems.map((row) => (
                  <li key={row.id} className="fw-pb-problem">
                    <Tag tone={row.kind === 'OVERBOOKED' ? 'warning' : 'danger'}>{t(`problems.kind.${row.kind}`)}</Tag>
                    <span className="fw-pb-problem-words">{row.words}</span>
                    <Button size="sm" variant="quiet" onClick={() => actions?.onShowProblem?.(row)}>
                      {t('problems.show')}
                    </Button>
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}
        </section>
      ) : null}

      <BoardDialogs model={model} actions={actions} words={words} />
    </div>
  )
}

function stylesOf(board: Board) {
  const seen = new Map<string, { id: string; code: string; name: string }>()
  for (const workOrder of board.workOrders) seen.set(workOrder.style.id, workOrder.style)
  return [...seen.values()].sort((a, b) => a.code.localeCompare(b.code))
}

function saveWords(model: BoardViewModel, words: Words): string {
  const { t } = words
  if (model.save.state === 'saving') return t('save.saving')
  if (model.save.state === 'saved') return t('save.saved', { time: timeWords(model.save.at, words) })
  if (model.save.state === 'failed') return t('save.failed', { reason: refusalWords(model.save.refusal, words) })
  return model.offline ? t('save.offline') : t('save.idle')
}

/** "Working plan v7 · the floor works to v3 (16–20 Nov, from 16 Nov, 06:00) · since then: 1 moved, 2 added, 0 removed". */
function planWords(board: Board, words: Words): string {
  const { t, locale } = words
  const parts: string[] = [board.plan.version === null ? t('plan.none') : t('plan.working', { version: board.plan.version })]
  const published = board.plan.published
  if (published) {
    parts.push(t('plan.published', { version: published.number, from: dayWords(published.coversFrom, locale, false), to: dayWords(published.coversTo, locale, false), start: whenWords(published.effectiveFrom, words) }))
    const changes = board.plan.changesSincePublished
    if (changes) parts.push(t('plan.changes', { moved: changes.moved, added: changes.added, removed: changes.removed }))
  } else parts.push(t('plan.neverPublished'))
  return parts.join(' · ')
}
