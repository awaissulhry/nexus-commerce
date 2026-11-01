'use client'

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { AlarmClock, AlertOctagon, AlertTriangle, ArrowRight, AtSign, CalendarCheck, CalendarClock, CheckCircle2, ChevronRight, Circle, ExternalLink, Eye, ListTodo, MoreHorizontal, Sun, UserRound, X } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, MetricStrip, PressableRow, type Metric } from '@nexus/ui/components'
import { Button, FilterChip, InfoTip, SegmentedControl, Skeleton, Tag } from '@nexus/ui/primitives'
import { AsOf } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListKeysInfo } from '../../../../list-frame/ListKeysInfo'
import type { ListKey } from '../../../../list-frame/model'
import type { Translate } from '../../../../lib/i18n/messages'
import { WithMessages } from '../../../../record-panels/i18n'
import {
  arrangePanels,
  comingIsEmpty,
  dueWords,
  groupItems,
  inTile,
  offersVerb,
  ownVerbHeld,
  ownVerbKey,
  snoozesUntilChange,
  snoozeTarget,
  lensesInOrder,
  panelRows,
  queueKey,
  sectionOrder,
  sectionShown,
  tileCount,
  TILES,
  verbHeld,
  verbKey,
  type Category,
  type ComingUpView,
  type Loaded,
  type LiveState,
  type OwnVerb,
  type QueueItem,
  type Tile,
  type TodayDialog,
  type TodayLayout,
  type TodayViewModel,
} from '../model'
import { phraseText, sentenceText } from '../words'
import { AssignDialog, HandledDialog, ResolveDialog } from './ActionDialogs'
import { ArrangeModal } from './ArrangeModal'
import { DecideModal, type DecideActions } from './DecideModal'
import { SnoozeDialog } from './SnoozeDialog'
import { SNOOZE_MAX_DAYS } from '../snooze'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { KeyNumbersSection } from '../numbers/view/KeyNumbers'
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
  /** Open a dialog: Assign to, Resolve, Handled today, Arrange Today (null closes it); the container loads what it shows. */
  onDialog?: (dialog: DialogRequest | null) => void
  /** Read the open dialog's data again (the assignee list, Handled today). */
  onRetryDialog?: () => void
  onAssign?: (key: string, assigneeId: string | null) => Promise<boolean>
  onResolve?: (key: string, note: string) => Promise<boolean>
  /** Apply the arrangement (PUT /home/today/layout). */
  onArrange?: (layout: TodayLayout) => Promise<void>
  /** W2a: Snooze a row until a time, or (null) until something changes (resolves true when done). */
  onSnooze?: (key: string, until: string | null) => Promise<boolean>
  /** W2a: read Coming up again. */
  onRetryComing?: () => void
  /** B-W2a-79: read My numbers again. */
  onRetryNumbers?: () => void
}

/** What a control asks to open (the container turns it into a TodayDialog with its data). */
export type DialogRequest =
  | { readonly kind: 'assign'; readonly key: string }
  | { readonly kind: 'resolve'; readonly key: string }
  | { readonly kind: 'handled' }
  | { readonly kind: 'arrange' }
  | { readonly kind: 'snooze'; readonly key: string }

/**
 * Today's keys, in the list footer's info icon. Not a grid: no cells, no selection, no "?" list — j / k and Enter in the
 * list (j / k also step through rows in the decide modal), a / r in a quote approval's review. W2a (`own`): e is also
 * Done for my task or mention, and h snoozes.
 */
export function todayKeys(t: Translate, own = false): ListKey[] {
  return [
    { keys: ['j', 'k'], does: 'keys.rows' },
    { keys: ['↵'], does: 'keys.open' },
    { keys: ['e'], does: t(own ? 'today.keys.doneOrAcknowledge' : 'today.keys.acknowledge') },
    ...(own ? [{ keys: ['h'], does: t('today.keys.snooze') }] : []),
    { keys: ['a'], does: t('today.keys.approve') },
    { keys: ['r'], does: t('today.keys.reject') },
  ]
}

const SEVERITY_ICON = { HIGH: AlertOctagon, MEDIUM: AlertTriangle, LOW: Circle } as const
const SEVERITY_TONE = { HIGH: 'danger', MEDIUM: 'warning', LOW: 'neutral' } as const

/**
 * SCR-029 — Home › Today (design home.today, the W1 parts): the band's status and actions (when it was read, the live
 * channel, how many rows need the person; Work through, New, Print my list), "Your day" tiles that filter the list in
 * place, "Needs me now" grouped Now · Today · This week · Later (severity word and icon, the sentence, what waits on
 * it, the due date in days, the record as a real link: ⌘-click opens it in a new tab), the decide modal (a quote
 * approval approved or rejected here; any other row opens its own review or its record), the role's flow strip and its
 * lists. It draws ONE view model and fetches nothing (Today.tsx loads it). Keys: j / k move, Enter opens, e acknowledges
 * an alert, and in the modal a approves, r rejects, j / k step through.
 *
 * An alert row also says who it is assigned to and who acknowledged it, and its ⋯ (and the decide modal) offer the alert
 * verbs: Acknowledge, Assign to…, Resolve… — held with the reason when the person cannot use one now (offline, already
 * acknowledged, a decision in flight). "Handled today: N · Show" closes the list; "Arrange this page" (band ⋯) orders and
 * hides the sections and lists, sets each list's width and the main lens.
 */
export function TodayView({ model, actions }: { model: TodayViewModel; actions?: TodayActions }) {
  return (
    <WithMessages namespaces={['home', 'lists']}>
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
  // The dialogs: the container's (with their data), else the view's own (the design index).
  const [ownDialog, setOwnDialog] = useState<TodayDialog | null>(model.dialog)
  useEffect(() => setOwnDialog(model.dialog), [model.dialog])
  const dialog = actions?.onDialog ? model.dialog : ownDialog
  const openDialog = (next: DialogRequest | null) => {
    if (actions?.onDialog) return actions.onDialog(next)
    if (next === null) return setOwnDialog(null)
    setOwnDialog(next.kind === 'assign' ? { ...next, people: model.dialog?.kind === 'assign' ? model.dialog.people : { status: 'loading' } } : next.kind === 'handled' ? { kind: 'handled', list: model.dialog?.kind === 'handled' ? model.dialog.list : { status: 'loading' } } : next)
  }
  const acknowledge = (item: QueueItem) => {
    if (verbHeld(item, 'ACKNOWLEDGE', { live: model.live, busy: model.busy }) !== null) return
    void actions?.onAcknowledge?.(item.key)
  }
  /** W2a: Done (my task or mention) and Snooze (those, and an alert the reader may snooze). */
  const own = (item: QueueItem, verb: OwnVerb) => {
    if (ownVerbHeld(item, verb, { live: model.live, busy: model.busy }) !== null) return
    if (verb === 'DONE') void actions?.onDone?.(item.key)
    else openDialog({ kind: 'snooze', key: item.key })
  }

  const listRef = useRef<HTMLDivElement>(null)
  const queue = model.queue.status === 'ready' ? model.queue.data : null
  const items = useMemo(() => {
    const all = queue?.items ?? []
    // The design index filters in the view; the container's list is filtered by the API already.
    if (actions?.onTile) return all
    return all.filter((item) => inTile(item, tile) && (!kind || item.kind === kind))
  }, [queue, tile, kind, actions?.onTile])
  const keys = useMemo(() => items.map((item) => item.key), [items])

  // j / k move between rows (also with the arrows inside the list); Enter opens the focused row (the row's own button);
  // e acknowledges the focused alert.
  const itemsRef = useRef(items)
  itemsRef.current = items
  const acknowledgeRef = useRef(acknowledge)
  acknowledgeRef.current = acknowledge
  const ownRef = useRef(own)
  ownRef.current = own
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (open !== null || dialog !== null || event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') !== null)) return
      const inList = target ? listRef.current?.contains(target) === true : false
      const modifiers = { alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, inField: false }
      const rowOf = () => {
        const key = target?.closest<HTMLElement>('[data-today-row]')?.dataset.todayRow
        return key ? itemsRef.current.find((entry) => entry.key === key) : undefined
      }
      // W2a: e is Done on my task or mention, h snoozes; on an alert e still acknowledges.
      const ownVerb = inList ? ownVerbKey(event.key, modifiers) : null
      if (ownVerb) {
        const item = rowOf()
        if (item && offersVerb(item, ownVerb) && !(ownVerb === 'DONE' && item.category === 'ALERT')) {
          event.preventDefault()
          ownRef.current(item, ownVerb)
          return
        }
      }
      if (inList && verbKey(event.key, modifiers) === 'acknowledge') {
        const item = rowOf()
        if (item) {
          event.preventDefault()
          acknowledgeRef.current(item)
        }
        return
      }
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
  }, [open, dialog])

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
          items={[
            { id: 'arrange', label: t('today.more.arrange'), onSelect: () => openDialog({ kind: 'arrange' }) },
            { id: 'print', label: t('today.more.print'), href: model.printHref, target: '_blank' },
          ]}
        />
      </div>
    </div>
  )

  // ---- Your day: tiles that filter the list ---------------------------------------------------------------------------
  // The design's three tiles (home.today focus-strip, W1), always: every row, Approvals, Alerts on my records. A tile
  // is a filter of the list (aria-pressed); pressing it again clears it. 0 is an answer; a count that could not be read
  // is "—", a lower bound "at least N", each with its reason.
  const readyQueue = model.queue.status === 'ready' ? model.queue.data : null
  const pressed = (entry: Tile) => (entry === 'ALL' ? tile === null && kind === null : tile === entry)
  const tiles: Metric[] = (model.tileSet ?? TILES).map((entry): Metric => {
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

  // ---- the sections, in the person's order (Arrange Today) ------------------------------------------------------------
  const order = sectionOrder(model.layout)
  const shownSection = (id: Parameters<typeof sectionShown>[1]) => sectionShown(model.layout, id)
  const panels = arrangePanels(model.panels, model.layout)
  const handled = queue?.handledToday ?? null
  const handledLine =
    handled !== null ? (
      <Button size="sm" variant="link" onClick={() => openDialog({ kind: 'handled' })}>
        {t('today.handled.footer', { count: handled })}
      </Button>
    ) : null

  const daySection = shownSection('focus-strip') ? (
    <section key="focus-strip" className="fw-today-section" aria-labelledby="fw-today-day">
      <h2 id="fw-today-day" className="fw-today-h">
        {t('today.day.title')}
      </h2>
      <MetricStrip metrics={tiles} minTileWidth={180} />
    </section>
  ) : null

  const needsSection = (
    <section key="needs-me" className="fw-today-section" aria-labelledby="fw-today-needs">
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
          <>
            <EmptyState
              icon={<CalendarCheck size={24} aria-hidden />}
              title={t(chip ? 'today.queue.emptyKind.title' : 'today.queue.empty.title')}
              description={t(chip ? 'today.queue.emptyKind.body' : 'today.queue.empty.body')}
            />
            {handled !== null && handled > 0 && <div className="fw-today-queue-foot fw-today-queue-foot--empty">{handledLine}</div>}
          </>
        ) : (
          <>
            {groupItems(items).map((entry) => (
              <div key={entry.group} className="fw-today-group">
                <h3 className="fw-today-group-h">
                  {t(`today.group.${entry.group}`)} <span className="fw-today-muted">{t('today.group.count', { count: entry.items.length })}</span>
                </h3>
                <ul className="fw-today-list" aria-label={t(`today.group.${entry.group}`)}>
                  {entry.items.map((item) => (
                    <QueueRow
                      key={item.key}
                      item={item}
                      current={open === item.key}
                      kindLabel={kindLabel(item.kind, item.kind)}
                      live={model.live}
                      busy={model.busy}
                      onOpen={() => setOpen(item.key)}
                      onAcknowledge={() => acknowledge(item)}
                      onOwn={(verb) => own(item, verb)}
                      onDialog={openDialog}
                    />
                  ))}
                </ul>
              </div>
            ))}
            {/* The list's footer: more rows, Handled today, and its keys in ONE info icon (Owner rule 2026-10-29: no key
                hints above a list). */}
            <div className="fw-today-queue-foot">
              {queue?.more && (
                <Button variant="secondary" onClick={() => actions?.onMore?.()} disabled={queue.loadingMore}>
                  {t(queue.loadingMore ? 'today.queue.loadingMore' : 'today.queue.more')}
                </Button>
              )}
              {handledLine}
              <ListKeysInfo keys={todayKeys(t, model.tileSet !== undefined)} />
            </div>
          </>
        )}
      </div>
    </section>
  )

  const flowSection = model.flow && shownSection('flow') ? <FlowSection key="flow" model={model} lens={lens} onLens={setLens} onRetry={() => actions?.onRetry?.('flow')} /> : null
  // W2a: Coming up — after the work (not one of the arranged sections yet: the layout's sections are the API's).
  const comingSection = model.comingUp ? <ComingUpSection key="coming-up" state={model.comingUp} onRetry={() => actions?.onRetryComing?.()} /> : null
  // B-W2a-79: My numbers — the picked lens's key numbers, after the flow strip (design order), before Coming up.
  const numbersSection = model.numbers ? <KeyNumbersSection key="key-numbers" state={model.numbers} lens={lens} built={OFFICE_PAGES} onRetry={() => actions?.onRetryNumbers?.()} /> : null

  // My lists: beside the work on wide screens (one list per row) when it comes after "Needs me now"; above the work,
  // across the page with each list's width, when the person put it first; on narrow screens in its place.
  const listsFirst = order.indexOf('role-panels') < order.indexOf('needs-me')
  const listsSection =
    panels.length > 0 && shownSection('role-panels') ? (
      <section key="role-panels" className={listsFirst ? 'fw-today-section' : 'fw-today-section fw-today-side'} aria-labelledby="fw-today-lists">
        <h2 id="fw-today-lists" className="fw-today-h">
          {t('today.panels.title')}
        </h2>
        <div className="fw-today-panels">
          {panelRows(panels).map((row) => (
            <div key={row.map((panel) => panel.id).join(' ')} className="fw-today-panels-row">
          {row.map((panel) => (
            <Card key={panel.id} header={t(panel.titleKey)} headingLevel={3} className={`fw-today-panel fw-today-panel--${panel.width.toLowerCase().replace('_', '-')}`}>
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
          ))}
        </div>
      </section>
    ) : null

  const node = { 'focus-strip': daySection, 'needs-me': needsSection, flow: flowSection, 'role-panels': listsSection } as const
  const at = order.indexOf('needs-me')
  // Before "Needs me now": across the page. From it on: the work column, with My lists beside it (unless it came first).
  const head = order.slice(0, at).map((id) => node[id])
  const work = [...order.slice(at).filter((id) => id !== 'role-panels').map((id) => node[id]), numbersSection, comingSection]
  const side = listsFirst ? null : listsSection
  const assignItem = dialog?.kind === 'assign' ? (items.find((entry) => entry.key === dialog.key) ?? null) : null
  const resolveItem = dialog?.kind === 'resolve' ? (items.find((entry) => entry.key === dialog.key) ?? null) : null
  const snoozeItem = dialog?.kind === 'snooze' ? (items.find((entry) => entry.key === dialog.key) ?? null) : null
  const held = (item: QueueItem, verb: 'ASSIGN' | 'RESOLVE') => verbHeld(item, verb, { live: model.live, busy: false })

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

      {head}

      {/* Wide screens: the work (the list, the flow strip) and my lists side by side (design: panels half / two-thirds). */}
      <div className={side ? 'fw-today-columns fw-today-columns--split' : 'fw-today-columns'}>
        <div className="fw-today-main">{work}</div>
        {side}
      </div>

      <DecideModal
        items={items}
        keys={keys}
        open={open}
        total={queue?.total ?? null}
        reviews={model.reviews}
        busy={model.busy}
        live={model.live}
        notice={model.notice}
        onGo={setOpen}
        onClose={() => setOpen(null)}
        onDialog={openDialog}
        paused={dialog !== null}
        alertRecords={model.alertRecords ?? {}}
        actions={actions}
      />

      {assignItem && dialog?.kind === 'assign' && (
        <AssignDialog
          item={assignItem}
          people={dialog.people}
          busy={model.busy}
          held={held(assignItem, 'ASSIGN')}
          onAssign={(assigneeId) => void actions?.onAssign?.(assignItem.key, assigneeId)}
          onRetry={() => actions?.onRetryDialog?.()}
          onClose={() => openDialog(null)}
        />
      )}
      {resolveItem && (
        <ResolveDialog
          item={resolveItem}
          busy={model.busy}
          held={held(resolveItem, 'RESOLVE')}
          onResolve={async (note) => (actions?.onResolve ? actions.onResolve(resolveItem.key, note) : false)}
          onClose={() => openDialog(null)}
        />
      )}
      {dialog?.kind === 'handled' && <HandledDialog list={dialog.list} onRetry={() => actions?.onRetryDialog?.()} onClose={() => openDialog(null)} />}
      {snoozeItem && (
        <SnoozeDialog
          what={snoozeItem.kind === 'TASK_DUE' ? snoozeItem.record.label : snoozeItem.kind === 'MENTION' ? t('today.snooze.mention', { record: snoozeItem.record.label }) : snoozeItem.record.label}
          now={model.now}
          untilChange={snoozesUntilChange(snoozeItem)}
          maxDays={SNOOZE_MAX_DAYS[snoozeTarget(snoozeItem).kind === 'task' ? 'task' : snoozeTarget(snoozeItem).kind === 'notification' ? 'notification' : 'alert']}
          held={(() => {
            const held = ownVerbHeld(snoozeItem, 'SNOOZE', { live: model.live, busy: model.busy })
            return held ? t(held) : null
          })()}
          onSnooze={async (until) => (actions?.onSnooze ? actions.onSnooze(snoozeItem.key, until) : true)}
          onClose={() => openDialog(null)}
        />
      )}
      <ArrangeModal
        open={dialog?.kind === 'arrange'}
        layout={model.layout}
        panels={model.arrangeable.panels}
        lenses={model.arrangeable.lenses}
        onApply={async (layout) => {
          if (actions?.onArrange) await actions.onArrange(layout)
          else openDialog(null)
        }}
        onClose={() => openDialog(null)}
      />
    </div>
  )
}

/** One row: the sentence as its button (Enter, a click: the decide modal), the record as a real link beside it. */
function QueueRow({
  item,
  current,
  kindLabel,
  live,
  busy,
  onOpen,
  onAcknowledge,
  onOwn,
  onDialog,
}: {
  item: QueueItem
  current: boolean
  kindLabel: string
  live: LiveState
  busy: boolean
  onOpen: () => void
  onAcknowledge: () => void
  /** W2a: Done or Snooze (my task or mention; Snooze on an alert the reader may snooze). */
  onOwn: (verb: OwnVerb) => void
  onDialog: (dialog: DialogRequest) => void
}) {
  const t = useT('home')
  const locale = useLocale()
  const alert = item.category === 'ALERT'
  const heldWords = (verb: 'ASSIGN' | 'RESOLVE' | 'ACKNOWLEDGE') => {
    const held = verbHeld(item, verb, { live, busy })
    return held === null ? null : t(held, { name: item.actions.acknowledged?.by.name ?? '' })
  }
  const verbItem = (id: string, verb: 'ASSIGN' | 'RESOLVE' | 'ACKNOWLEDGE', label: string, icon: ReactNode, run: () => void) => {
    const held = heldWords(verb)
    return held === null ? { id, label, icon, onSelect: run } : { id, label, icon, disabled: true, description: held }
  }
  const ownItem = (id: string, verb: OwnVerb, label: string, icon: ReactNode) => {
    const held = ownVerbHeld(item, verb, { live, busy })
    return held === null ? { id, label, icon, onSelect: () => onOwn(verb) } : { id, label, icon, disabled: true, description: t(held) }
  }
  // The row's ⋯: an alert's verbs (and Snooze when the reader may snooze it); my task's or mention's Done and Snooze.
  const alertVerbs = alert && item.actions.verbs.length > 0
  const menuItems = [
    ...(alertVerbs
      ? [
          verbItem('acknowledge', 'ACKNOWLEDGE', t('today.actions.acknowledge'), <Eye size={14} aria-hidden />, onAcknowledge),
          verbItem('assign', 'ASSIGN', t('today.actions.assign'), <UserRound size={14} aria-hidden />, () => onDialog({ kind: 'assign', key: item.key })),
          verbItem('resolve', 'RESOLVE', t('today.actions.resolve'), <CheckCircle2 size={14} aria-hidden />, () => onDialog({ kind: 'resolve', key: item.key })),
        ]
      : []),
    ...(offersVerb(item, 'DONE') ? [ownItem('done', 'DONE', t('today.own.done'), <CheckCircle2 size={14} aria-hidden />)] : []),
    ...(offersVerb(item, 'SNOOZE') ? [ownItem('snooze', 'SNOOZE', t('today.own.snooze'), <AlarmClock size={14} aria-hidden />)] : []),
  ]
  const Icon = item.kind === 'TASK_DUE' ? ListTodo : item.kind === 'MENTION' ? AtSign : SEVERITY_ICON[item.severity]
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
          <span className="fw-today-row-actions">
            <a className="fw-today-record" href={item.href} title={t('today.row.openRecord', { record: item.record.label })}>
              {item.record.label}
              <ExternalLink size={12} aria-hidden />
            </a>
            {menuItems.length > 0 && (
              <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('today.actions.menu', { record: item.record.label }) }} items={menuItems} />
            )}
          </span>
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
          <RowMarks item={item} />
        </span>
      </PressableRow>
    </li>
  )
}

/** Who an alert is assigned to and who acknowledged it (in this condition), for everyone who sees the row. */
export function RowMarks({ item }: { item: Pick<QueueItem, 'actions'> }) {
  const t = useT('home')
  const locale = useLocale()
  const { assigned, acknowledged } = item.actions
  if (!assigned && !acknowledged) return null
  return (
    <span className="fw-today-marks">
      {assigned && (
        <Tag tone={assigned.to.me ? 'info' : 'neutral'}>
          <UserRound size={12} aria-hidden /> {assigned.to.me ? t('today.marks.assignedYou', { by: assigned.by.name }) : t('today.marks.assigned', { name: assigned.to.name })}
        </Tag>
      )}
      {acknowledged && (
        <Tag tone="neutral">
          <Eye size={12} aria-hidden /> {t(acknowledged.by.me ? 'today.marks.acknowledgedYou' : 'today.marks.acknowledged', { name: acknowledged.by.name, time: formatTime(acknowledged.at, { locale }) })}
        </Tag>
      )}
    </span>
  )
}

/** Where the work is: the lens's stages left to right, each with its count, late rows and the oldest age. */
function FlowSection({ model, lens, onLens, onRetry }: { model: TodayViewModel; lens: string | null; onLens: (lens: string) => void; onRetry: () => void }) {
  const t = useT('home')
  const flow = model.flow!
  const lenses = flow.status === 'ready' ? lensesInOrder(flow.data, model.layout.mainLens) : []
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


/**
 * Coming up (design home.today `coming-up`, W2a): my next five working days, one row per day (the filtered site's or
 * company's calendar; none: Monday to Friday), each item one line with its record as a real link. The design's
 * AgendaList (new) is composed here (app CSS), as W1 composed QueueList: no DS part yet.
 */
function ComingUpSection({ state, onRetry }: { state: Loaded<ComingUpView>; onRetry: () => void }) {
  const t = useT('home')
  const locale = useLocale()
  const weekday = (date: string) => new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00.000Z`))
  return (
    <section className="fw-today-section" aria-labelledby="fw-today-coming">
      <div className="fw-today-head">
        <h2 id="fw-today-coming" className="fw-today-h">
          {t('today.coming.title')}
        </h2>
        <span className="fw-today-muted">{t('today.coming.hint')}</span>
      </div>
      {state.status === 'loading' ? (
        <div className="fw-today-agenda" aria-busy="true">
          <p className="fw-today-muted" role="status">
            {t('today.coming.loading')}
          </p>
          <Skeleton height={20} />
          <Skeleton height={20} />
        </div>
      ) : state.status === 'error' ? (
        <Banner tone="danger" title={t('today.coming.error')} action={<Button size="sm" onClick={onRetry}>{t('today.retry')}</Button>}>
          {t(state.problem)}
        </Banner>
      ) : comingIsEmpty(state.data) ? (
        <EmptyState icon={<CalendarClock size={22} aria-hidden />} title={t('today.coming.empty')} description={t(state.data.calendar ? 'today.coming.calendar' : 'today.coming.noCalendar')} />
      ) : (
        <>
          <ol className="fw-today-agenda" aria-label={t('today.coming.title')}>
            {state.data.days.map((day) => (
              <li key={day.date} className="fw-today-agenda-day">
                <h3 className="fw-today-group-h">
                  <span className="fw-today-agenda-weekday">{weekday(day.date)}</span> {formatDate(day.date, { locale, timeZone: 'UTC' })}
                  {!day.working && <Tag tone="neutral">{t('today.coming.closed')}</Tag>}
                </h3>
                {day.items.length === 0 ? (
                  <p className="fw-today-muted">{t('today.coming.nothing')}</p>
                ) : (
                  <ul className="fw-today-agenda-items">
                    {day.items.map((item) => (
                      <li key={`${item.kind}:${item.href}`} className="fw-today-agenda-item">
                        <Tag tone="neutral">{t(`today.coming.kind.${item.kind}`)}</Tag>
                        <span className="fw-today-agenda-text">{phraseText(item.words, t, locale)}</span>
                        <a className="fw-today-record" href={item.href} title={t('today.row.openRecord', { record: item.label })}>
                          {item.label}
                          <ExternalLink size={12} aria-hidden />
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
          <p className="fw-today-muted">{t(state.data.calendar ? 'today.coming.calendar' : 'today.coming.noCalendar')}</p>
          {!state.data.complete && <p className="fw-today-muted">{t('today.coming.partial')}</p>}
        </>
      )}
    </section>
  )
}
