'use client'

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { AlertOctagon, AlertTriangle, ArrowRight, CalendarCheck, ChevronRight, Circle, ExternalLink, MoreHorizontal, Sun, X } from 'lucide-react'
import { AsOf, Banner, Card, EmptyState, Menu, MetricStrip, PressableRow, type Metric } from '@nexus/ui/components'
import { Button, FilterChip, InfoTip, Kbd, SegmentedControl, Skeleton, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { dueWords, groupItems, queueKey, tileCount, TILES, type Category, type QueueItem, type TodayViewModel } from '../model'
import { phraseText, sentenceText } from '../words'
import { DecideModal, type DecideActions } from './DecideModal'
import '../today.css'

export type { TodayViewModel } from '../model'

/** What the page asks of its container (Today.tsx). Absent in the design index: the view then keeps its own state. */
export interface TodayActions extends DecideActions {
  /** A tile was pressed (null: every row; it also clears a `?kind=` deep link): the container sets `?tile=`. */
  onTile?: (tile: Category | null) => void
  onRetry?: (section: 'queue' | 'flow' | 'panels') => void
  onMore?: () => void
  /** Show the rows a live change brought ("N new · Show"). */
  onShowFresh?: () => void
  /** Open a row in the decide modal (null closes it): the container sets `?open=`. */
  onOpen?: (key: string | null) => void
  onLens?: (lens: string) => void
  onDismissNotice?: () => void
}

const SEVERITY_ICON = { HIGH: AlertOctagon, MEDIUM: AlertTriangle, LOW: Circle } as const
const SEVERITY_TONE = { HIGH: 'danger', MEDIUM: 'warning', LOW: 'neutral' } as const

/**
 * SCR-029 — Home › Today (design home.today, the W1 parts): the band's status and actions (when it was read, the live
 * channel, how many rows need the person; Work through, New, Print my list), "Your day" tiles that filter the list in
 * place, "Needs me now" grouped Now · Today · This week · Later (severity word and icon, the sentence, what waits on
 * it, the due date in days, the record as a real link: ⌘-click opens it in a new tab), the decide modal (a quote
 * approval approved or rejected here; any other row opens its own review or its record), the role's flow strip and its
 * lists. It draws ONE view model and fetches nothing (Today.tsx loads it). Keys: j / k move, Enter opens, and in the
 * modal a approves, r rejects, j / k step through.
 */
export function TodayView({ model, actions }: { model: TodayViewModel; actions?: TodayActions }) {
  return (
    <WithMessages namespaces={['home']}>
      <Today model={model} actions={actions} />
    </WithMessages>
  )
}

function Today({ model, actions }: { model: TodayViewModel; actions?: TodayActions }) {
  const t = useT('home')
  const locale = useLocale()
  // Without a container (the design index) the view keeps its own filter, open row and lens, so every key works.
  const [ownTile, setOwnTile] = useState<Category | null>(model.tile)
  const [ownKind, setOwnKind] = useState<string | null>(model.kind)
  const [ownOpen, setOwnOpen] = useState<string | null>(model.open)
  const [ownLens, setOwnLens] = useState<string | null>(model.lens)
  useEffect(() => setOwnOpen(model.open), [model.open])
  const tile = actions?.onTile ? model.tile : ownTile
  const kind = actions?.onTile ? model.kind : ownKind
  const open = actions?.onOpen ? model.open : ownOpen
  const lens = actions?.onLens ? model.lens : ownLens
  const setTile = (next: Category | null) => {
    if (actions?.onTile) return actions.onTile(next)
    setOwnTile(next)
    setOwnKind(null)
  }
  const setOpen = (next: string | null) => (actions?.onOpen ? actions.onOpen(next) : setOwnOpen(next))
  const setLens = (next: string) => (actions?.onLens ? actions.onLens(next) : setOwnLens(next))

  const listRef = useRef<HTMLDivElement>(null)
  const queue = model.queue.status === 'ready' ? model.queue.data : null
  const items = useMemo(() => {
    const all = queue?.items ?? []
    // The design index filters in the view; the container's list is filtered by the API already.
    if (actions?.onTile) return all
    return all.filter((item) => (!tile || item.category === tile) && (!kind || item.kind === kind))
  }, [queue, tile, kind, actions?.onTile])
  const keys = useMemo(() => items.map((item) => item.key), [items])

  // j / k move between rows (also with the arrows inside the list); Enter opens the focused row (the row's own button).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (open !== null || event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') !== null)) return
      const inList = target ? listRef.current?.contains(target) === true : false
      const move = queueKey(event.key, { alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey })
      if (move === null || move === 'open') return
      if (!inList && event.key.startsWith('Arrow')) return
      const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-today-row] button') ?? [])]
      if (rows.length === 0) return
      event.preventDefault()
      const at = rows.findIndex((row) => row === document.activeElement)
      const next = move === 'next' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1)
      rows[next]?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (model.access === 'refused') {
    return (
      <div className="fw-today">
        <EmptyState icon={<Sun size={24} aria-hidden />} title={t('today.refused.title')} description={t('today.refused.body')} />
      </div>
    )
  }

  const needYou = queue?.needYou ?? null
  const first = keys[0] ?? null
  const kindLabel = (code: string, fallback: string) => t(`today.kind.${code}`) === `today.kind.${code}` ? fallback : t(`today.kind.${code}`)

  // ---- the band: status and actions ---------------------------------------------------------------------------------
  const band = (
    <div className="fw-today-band" role="group" aria-label={t('today.band.label')}>
      <div className="fw-today-status">
        {queue ? <AsOf at={queue.asOf} now={model.now} /> : model.queue.status === 'loading' ? <span className="fw-today-muted">{t('today.band.reading')}</span> : null}
        <Tag tone={model.live === 'live' ? 'success' : model.live === 'offline' ? 'warning' : 'neutral'}>{t(`today.live.${model.live}`)}</Tag>
        <strong className="fw-today-needyou" aria-live="polite">
          {needYou === null ? '—' : t('today.band.needYou', { count: needYou })}
        </strong>
      </div>
      <div className="fw-today-actions">
        {model.newVerbs.length > 0 && (
          <Menu
            label={t('today.new.menu')}
            align="right"
            items={model.newVerbs.map((verb) => ({
              id: verb.id,
              label: t(verb.labelKey),
              ...(verb.href ? { href: verb.href } : { disabled: true, description: t('today.new.notBuilt') }),
            }))}
          />
        )}
        <Button
          variant="primary"
          onClick={() => first && setOpen(first)}
          heldReason={first ? undefined : t('today.workThrough.none')}
        >
          {t('today.workThrough.label', { count: queue ? items.length : 0 })}
        </Button>
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('today.more.label') }}
          items={[{ id: 'print', label: t('today.more.print'), href: model.printHref, target: '_blank' }]}
        />
      </div>
    </div>
  )

  // ---- Your day: tiles that filter the list ---------------------------------------------------------------------------
  // The design's three tiles (home.today focus-strip, W1), always: every row, Approvals, Alerts on my records. A tile
  // is a filter of the list (aria-pressed); pressing it again clears it. 0 is an answer; a count that could not be read
  // is "—", a lower bound "at least N", each with its reason.
  const readyQueue = model.queue.status === 'ready' ? model.queue.data : null
  const pressed = (entry: (typeof TILES)[number]) => (entry === 'ALL' ? tile === null && kind === null : tile === entry)
  const tiles: Metric[] = TILES.map((entry): Metric => {
    const counted = readyQueue?.tiles.find((candidate) => candidate.tile === entry)
    const label = t(`today.tile.${entry}.label`)
    if (!counted) {
      return {
        label,
        value:
          model.queue.status === 'error' ? (
            <span className="fw-today-unknown">
              —<InfoTip tip={t('today.tiles.unknown')} />
            </span>
          ) : (
            '—'
          ),
      }
    }
    const words = tileCount(counted)
    return {
      label,
      value: counted.complete ? (
        t(words.key, { count: words.count })
      ) : (
        <span className="fw-today-unknown">
          {t(words.key, { count: words.count })}
          <InfoTip tip={t('today.tiles.partial')} />
        </span>
      ),
      hint: t(`today.tile.${entry}.hint`),
      onClick: () => setTile(entry === 'ALL' || tile === entry ? null : entry),
      active: pressed(entry),
    }
  })
  const chip = tile ? t(`today.tile.${tile}.label`) : kind ? kindLabel(kind, readyQueue?.kindLabels[kind] ?? kind) : null

  return (
    <div className="fw-today">
      {band}
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={actions?.onDismissNotice ? <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>{t('today.dismiss')}</Button> : undefined}
        />
      )}

      <section className="fw-today-section" aria-labelledby="fw-today-day">
        <h2 id="fw-today-day" className="fw-today-h">
          {t('today.day.title')}
        </h2>
        <MetricStrip metrics={tiles} minTileWidth={180} />
      </section>

      {/* Wide screens: the work (the list, the flow strip) and my lists side by side (design: panels half / two-thirds). */}
      <div className={model.panels.length > 0 ? 'fw-today-columns fw-today-columns--split' : 'fw-today-columns'}>
      <div className="fw-today-main">
      <section className="fw-today-section" aria-labelledby="fw-today-needs">
        <div className="fw-today-head">
          <h2 id="fw-today-needs" className="fw-today-h">
            {t('today.queue.title')}
          </h2>
          {chip && (
            <FilterChip pressed onClick={() => setTile(null)} aria-label={t('today.queue.clearFilter', { kind: chip })}>
              {chip} <X size={12} aria-hidden />
            </FilterChip>
          )}
          {queue && queue.fresh > 0 && (
            <Button size="sm" variant="secondary" onClick={() => actions?.onShowFresh?.()}>
              {t('today.queue.fresh', { count: queue.fresh })}
            </Button>
          )}
          <span className="fw-today-keys" aria-hidden>
            <Kbd>J</Kbd> <Kbd>K</Kbd> {t('today.keys.move')} · <Kbd>Enter</Kbd> {t('today.keys.open')}
          </span>
        </div>

        <div ref={listRef}>
          {model.queue.status === 'loading' ? (
            <ul className="fw-today-skeleton" aria-busy="true" aria-label={t('today.queue.loading')}>
              {[0, 1, 2, 3, 4].map((index) => (
                <li key={index}>
                  <Skeleton height={44} />
                </li>
              ))}
            </ul>
          ) : model.queue.status === 'error' ? (
            <Banner tone="danger" title={t('today.queue.error')} action={<Button size="sm" onClick={() => actions?.onRetry?.('queue')}>{t('today.retry')}</Button>}>
              {t(model.queue.problem)}
            </Banner>
          ) : items.length === 0 ? (
            <EmptyState
              icon={<CalendarCheck size={24} aria-hidden />}
              title={t(chip ? 'today.queue.emptyKind.title' : 'today.queue.empty.title')}
              description={t(chip ? 'today.queue.emptyKind.body' : 'today.queue.empty.body')}
            />
          ) : (
            <>
              {groupItems(items).map((entry) => (
                <div key={entry.group} className="fw-today-group">
                  <h3 className="fw-today-group-h">
                    {t(`today.group.${entry.group}`)} <span className="fw-today-muted">{t('today.group.count', { count: entry.items.length })}</span>
                  </h3>
                  <ul className="fw-today-list" aria-label={t(`today.group.${entry.group}`)}>
                    {entry.items.map((item) => (
                      <QueueRow key={item.key} item={item} current={open === item.key} kindLabel={kindLabel(item.kind, item.kind)} onOpen={() => setOpen(item.key)} />
                    ))}
                  </ul>
                </div>
              ))}
              {queue?.more && (
                <Button variant="secondary" onClick={() => actions?.onMore?.()} disabled={queue.loadingMore}>
                  {t(queue.loadingMore ? 'today.queue.loadingMore' : 'today.queue.more')}
                </Button>
              )}
            </>
          )}
        </div>
      </section>

      {model.flow && <FlowSection model={model} lens={lens} onLens={setLens} onRetry={() => actions?.onRetry?.('flow')} />}
      </div>

      {model.panels.length > 0 && (
        <section className="fw-today-section fw-today-side" aria-labelledby="fw-today-lists">
          <h2 id="fw-today-lists" className="fw-today-h">
            {t('today.panels.title')}
          </h2>
          <div className="fw-today-panels">
            {model.panels.map((panel) => (
              <Card key={panel.id} header={t(panel.titleKey)} headingLevel={3} className="fw-today-panel">
                {panel.state.status === 'loading' ? (
                  <div className="fw-today-panel-rows" aria-busy="true">
                    <Skeleton height={20} />
                    <Skeleton height={20} />
                    <Skeleton height={20} />
                  </div>
                ) : panel.state.status === 'error' ? (
                  <div className="fw-today-panel-problem">
                    <p className="fw-today-muted">{t(panel.state.problem)}</p>
                    <Button size="sm" onClick={() => actions?.onRetry?.('panels')}>
                      {t('today.retry')}
                    </Button>
                  </div>
                ) : panel.state.data.rows.length === 0 ? (
                  <p className="fw-today-muted">{t(panel.emptyKey)}</p>
                ) : (
                  <>
                    <ul className="fw-today-panel-rows">
                      {panel.state.data.rows.map((row) => (
                        <li key={row.id}>
                          <a className="fw-today-panel-row" href={row.href}>
                            <span className="fw-today-panel-label">{row.label}</span>
                            {row.sub && <span className="fw-today-muted fw-today-ellipsis">{row.sub}</span>}
                            {row.word && <Tag tone="neutral">{t(row.word.key, row.word.params)}</Tag>}
                            {row.date && <span className="fw-today-muted">{formatDate(row.date, { locale })}</span>}
                          </a>
                        </li>
                      ))}
                    </ul>
                    <p className="fw-today-panel-foot">
                      {panel.seeAllHref ? (
                        <a href={panel.seeAllHref}>
                          {panel.state.data.more ? t('today.panels.seeAllMore') : t('today.panels.seeAll', { count: panel.state.data.rows.length })} <ChevronRight size={12} aria-hidden />
                        </a>
                      ) : (
                        <span className="fw-today-muted">
                          {panel.state.data.more ? t('today.panels.moreNoList') : t('today.panels.allShown', { count: panel.state.data.rows.length })}
                        </span>
                      )}
                    </p>
                  </>
                )}
              </Card>
            ))}
          </div>
        </section>
      )}
      </div>

      <DecideModal
        items={items}
        keys={keys}
        open={open}
        total={queue?.total ?? null}
        reviews={model.reviews}
        busy={model.busy}
        notice={model.notice}
        onGo={setOpen}
        onClose={() => setOpen(null)}
        actions={actions}
      />
    </div>
  )
}

/** One row: the sentence as its button (Enter, a click: the decide modal), the record as a real link beside it. */
function QueueRow({ item, current, kindLabel, onOpen }: { item: QueueItem; current: boolean; kindLabel: string; onOpen: () => void }) {
  const t = useT('home')
  const locale = useLocale()
  const Icon = SEVERITY_ICON[item.severity]
  const due = dueWords(item.due)
  const why = phraseText(item.words.why, t, locale)
  const blocks = item.words.blocks ? phraseText(item.words.blocks, t, locale) : null
  // ⌘-click / Ctrl-click anywhere on the row opens the record in a new tab, as a link would.
  const onClickCapture = (event: ReactMouseEvent<HTMLLIElement>) => {
    if (!(event.metaKey || event.ctrlKey)) return
    if ((event.target as HTMLElement).closest('a[href]')) return
    event.preventDefault()
    event.stopPropagation()
    window.open(item.href, '_blank', 'noopener')
  }
  const onAuxClick = (event: ReactMouseEvent<HTMLLIElement>) => {
    if (event.button !== 1 || (event.target as HTMLElement).closest('a[href]')) return
    event.preventDefault()
    window.open(item.href, '_blank', 'noopener')
  }
  return (
    <li data-today-row={item.key} className={`fw-today-row fw-today-row--${item.severity.toLowerCase()}`} onClickCapture={onClickCapture} onAuxClick={onAuxClick}>
      <PressableRow
        stacked
        current={current}
        leading={<Icon size={18} className="fw-today-sev-icon" aria-hidden />}
        label={sentenceText(item, t, locale)}
        description={`${t(`today.severity.${item.severity}`)}. ${why}`}
        onClick={onOpen}
        actions={
          <a className="fw-today-record" href={item.href} title={t('today.row.openRecord', { record: item.record.label })}>
            {item.record.label}
            <ExternalLink size={12} aria-hidden />
          </a>
        }
      >
        <span className="fw-today-row-body">
          <span className="fw-today-row-line">
            <Tag tone={SEVERITY_TONE[item.severity]}>{t(`today.severity.${item.severity}`)}</Tag>
            <span className="fw-today-muted">{kindLabel}</span>
            {due && (
              <span className={due.key === 'today.due.overdue' ? 'fw-today-due fw-today-due--late' : 'fw-today-due'}>
                {t(due.key, { count: due.count, date: formatDate(due.date, { locale }) })}
              </span>
            )}
            {!due && <span className="fw-today-muted">{t(item.ageDays === 0 ? 'today.row.ageToday' : 'today.row.age', { count: item.ageDays })}</span>}
          </span>
          {blocks && (
            <span className="fw-today-blocks">
              <ArrowRight size={12} aria-hidden /> {blocks}
            </span>
          )}
          <span className="fw-today-why">{why}</span>
        </span>
      </PressableRow>
    </li>
  )
}

/** Where the work is: the lens's stages left to right, each with its count, late rows and the oldest age. */
function FlowSection({ model, lens, onLens, onRetry }: { model: TodayViewModel; lens: string | null; onLens: (lens: string) => void; onRetry: () => void }) {
  const t = useT('home')
  const flow = model.flow!
  const lenses = flow.status === 'ready' ? flow.data : []
  const shown = lenses.find((entry) => entry.lens === lens) ?? lenses[0] ?? null
  const label = (key: string, fallback: string) => (t(key) === key ? fallback : t(key))
  return (
    <section className="fw-today-section" aria-labelledby="fw-today-flow">
      <div className="fw-today-head">
        <h2 id="fw-today-flow" className="fw-today-h">
          {t('today.flow.title')}
        </h2>
        {lenses.length > 1 && shown && (
          <SegmentedControl
            ariaLabel={t('today.flow.lensLabel')}
            size="sm"
            wrap
            value={shown.lens}
            onChange={onLens}
            options={lenses.map((entry) => ({ value: entry.lens, label: label(`today.flow.lens.${entry.lens}`, entry.label) }))}
          />
        )}
      </div>
      {flow.status === 'loading' ? (
        <p className="fw-today-muted" aria-busy="true">
          {t('today.flow.loading')}
        </p>
      ) : flow.status === 'error' ? (
        <Banner tone="danger" title={t('today.flow.error')} action={<Button size="sm" onClick={onRetry}>{t('today.retry')}</Button>} />
      ) : shown ? (
        <>
          <ol className="fw-today-flow" aria-label={label(`today.flow.lens.${shown.lens}`, shown.label)}>
            {shown.stages.map((stage, index) => {
              const name = label(`today.flow.stage.${shown.lens}.${stage.key}`, stage.label)
              const body = (
                <>
                  <span className="fw-today-stage-name">{name}</span>
                  <span className="fw-today-stage-count">{stage.count}</span>
                  <span className="fw-today-muted">
                    {stage.late !== null && stage.late > 0 ? t('today.flow.late', { count: stage.late }) : stage.late === 0 ? t('today.flow.noneLate') : t('today.flow.noDate')}
                  </span>
                  {stage.oldestDays !== null && <span className="fw-today-muted">{t('today.flow.oldest', { count: stage.oldestDays })}</span>}
                  {stage.inexact && stage.href && <span className="fw-today-muted">{t('today.flow.inexact')}</span>}
                </>
              )
              return (
                <li key={stage.key} className="fw-today-stage">
                  {stage.href ? (
                    <a className="fw-today-stage-box" href={stage.href}>
                      {body}
                    </a>
                  ) : (
                    <span className="fw-today-stage-box">{body}</span>
                  )}
                  {index < shown.stages.length - 1 && <ChevronRight size={14} className="fw-today-stage-arrow" aria-hidden />}
                </li>
              )
            })}
          </ol>
          {shown.stages.every((stage) => stage.href === null) && <p className="fw-today-muted">{t('today.flow.noLists')}</p>}
          {!shown.complete && <p className="fw-today-muted">{t('today.flow.partial')}</p>}
        </>
      ) : null}
    </section>
  )
}

