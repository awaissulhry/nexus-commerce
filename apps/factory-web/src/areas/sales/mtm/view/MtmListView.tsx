'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Copy, MoreHorizontal, Plus, Ruler, X } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, MetricStrip, type MenuItemDef } from '@nexus/ui/components'
import { Tabs } from '@nexus/ui/components' // F-SA-222: the segment tabs
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Select, Tag } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import { Freshness } from '../../../quality/_shared/parts'
import type { ProfileRow } from '../api'
import { chipsOf, HOME_ADDRESS, isFiltered, recordHref, ROW_VIEWS, rowVerbHeld, templatesHref, TILE_VIEW, tileValue, TILES, worksheetHref, type RowVerb, type RowView } from '../model'
import { isPageKey, MtmMessages, NoticeLine, ReviewPill, useWords } from '../parts'
import type { MtmListActions, MtmListModel } from '../view-model'
// ---- F-SA-222 (sales page plan N7, pick P12; 12-lists-board §4.4, §4.7): Orders | Riders ----
import { riderOrdersHref, SEGMENTS } from '../model'
import type { MtmCan } from '../model'
import type { MtmSegments } from '../view-model'
import type { OrdersListActions, OrdersListModel } from '../../orders/list/list-model'
import { OrdersLayoutSwitch, OrdersListView, OrdersTiles } from '../../orders/list/view/OrdersListView'
// B-W2b-371 (XF2:03): the certified range of a row, the customer filter.
import { customerName } from '../list-filters/model'
import { CustomerFilter, RangeCell as RangeTag } from '../list-filters/view/ListFilterParts'
import { ExtrasMessages } from '../photos/words'
import { LinkDialog } from './LinkDialog'
import { MeasurementsDialog } from './MeasurementsDialog'
import { QuoteDialog } from './QuoteDialog'

export type { MtmListActions, MtmListModel } from '../view-model'

/**
 * SCR-036 — Sales › Special orders › Made-to-measure (design sales.mtm, a workspace list; B-W1-18 deferred on 10-28, built by
 * B-W2b-362 with its W2b parts): the band (one sentence, freshness and live state, ⋯ Send a measurement link · Measurement
 * templates, New measurements `c`), the off state of made-to-measure (Owner 11-10: switched off per template — said in words
 * with the way to start it), the tiles (Waiting for factory review · Need more from the rider · Outside the certified range ·
 * Fittings this week · Older than 12 months; a tile presses its saved row — B-W2b-371: "Outside" and "Fittings" filter the list
 * too), Rows ▾ / Garment type ▾ / Customer (B-W2b-371) / search with chips, Export ▾ and Export N (B-W2b-371), then the shared
 * list frame: Rider (a real link), Customer, Garment type, Revision, Taken on, Taken by, Base size, Inside certified range,
 * Review, Open orders, Next fitting, Privacy notice given and ⋯ (Open · Open in new tab · New revision · Use in a new quote ·
 * Print worksheet), each verb held with why.
 *
 * F-SA-222: the band's second row holds the page's link tabs Orders | Riders; a rider's Open orders count is a door to its orders
 * (the Orders segment, `?profile=`). MtmOrdersSegment is the Orders segment: this band (⋯ Measurement templates only: units are
 * made from quotes), List · Board with By promise week held with why, the sheet's tiles, then the ONE Orders sheet embedded, an
 * empty view saying why (GATE-MTM: made-to-measure not started for any template, or no order yet).
 */
export function MtmListView({ model, actions }: { model: MtmListModel; actions?: MtmListActions }) {
  return (
    <MtmMessages>
      <List model={model} actions={actions} />
    </MtmMessages>
  )
}

function List({ model, actions }: { model: MtmListModel; actions?: MtmListActions }) {
  const { t, say, day, when, locale } = useWords()
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [search, setSearch] = useState(model.address.q)
  useEffect(() => setSearch(model.address.q), [model.address.q])
  const rows = model.rows.items
  const rowsKey = rows?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  const offline = model.live === 'offline'
  const act = useRef(actions)
  act.current = actions
  const dialogOpen = !!(model.measurements || model.link || model.quote)

  // c: New measurements (never while typing, in a dialog or a menu).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || dialogOpen) return
      if (event.key === 'c' && model.can.record) {
        event.preventDefault()
        act.current?.onNew?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialogOpen, model.can.record])

  const columns = useMemo<ColDef<ProfileRow>[]>(() => {
    const verbItem = (row: ProfileRow, verb: RowVerb, label: string): MenuItemDef => {
      const held = say(rowVerbHeld(verb, model.can, offline))
      return verb === 'worksheet'
        ? { id: verb, label, disabled: !!held, description: held ?? undefined, href: held ? undefined : worksheetHref(model.prefix, row.id), target: '_blank' }
        : { id: verb, label, disabled: !!held, description: held ?? undefined, onSelect: () => act.current?.onRowVerb?.(row, verb) }
    }
    const RiderCell = ({ data }: ICellRendererParams<ProfileRow>) =>
      data ? (
        <span className="fw-mtm-cell">
          <Link className="fw-mtm-link" href={recordHref(model.prefix, data.id)}>
            {data.riderName}
          </Link>
          <span className="fw-mtm-hint">{data.byLink ? t('row.byLink') : t('row.byOffice')}</span>
        </span>
      ) : null
    const CustomerCell = ({ data }: ICellRendererParams<ProfileRow>) =>
      data ? (
        <span className="fw-mtm-cell">
          <span>{data.customer.name}</span>
          <span className="fw-mtm-hint">{data.customer.code}</span>
        </span>
      ) : null
    const TakenCell = ({ data }: ICellRendererParams<ProfileRow>) =>
      data ? (
        <span className="fw-mtm-cell">
          <span>{data.takenBy}</span>
          <span className="fw-mtm-hint">{data.measuredPlace ?? ' '}</span>
        </span>
      ) : null
    const TakenOnCell = ({ data }: ICellRendererParams<ProfileRow>) =>
      data ? (
        <span className="fw-mtm-row">
          <span>{day(data.takenAt)}</span>
          {data.old && <Tag tone="warning">{t('row.old')}</Tag>}
        </span>
      ) : null
    const ReviewCell = ({ data }: ICellRendererParams<ProfileRow>) =>
      data ? (
        <span className="fw-mtm-row">
          <ReviewPill status={data.review.status} />
        </span>
      ) : null
    const RangeCell = ({ data }: ICellRendererParams<ProfileRow>) =>
      data ? (
        <ExtrasMessages>
          <RangeTag range={data.range} />
        </ExtrasMessages>
      ) : null
    const OpenOrdersCell = ({ data }: ICellRendererParams<ProfileRow>) =>
      data ? (
        model.can.ordersView ? (
          <Link className="fw-mtm-link" href={riderOrdersHref(model.prefix, data.id)} aria-label={t('row.openOrders', { rider: data.riderName, count: data.openUnits })}>
            {data.openUnits}
          </Link>
        ) : (
          <span>{data.openUnits}</span>
        )
      ) : null
    const MoreCell = ({ data }: ICellRendererParams<ProfileRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('row.menu', { rider: data.riderName }) }}
          items={[
            { id: 'open', label: t('row.open'), href: recordHref(model.prefix, data.id) },
            { id: 'tab', label: t('row.openNewTab'), href: recordHref(model.prefix, data.id), target: '_blank' },
            verbItem(data, 'revision', t('row.revision')),
            verbItem(data, 'quote', t('row.quote')),
            verbItem(data, 'worksheet', t('row.worksheet')),
          ]}
        />
      ) : null
    return [
      { colId: 'rider', headerName: t('col.rider'), minWidth: 170, flex: 1.1, valueGetter: (params) => params.data?.riderName ?? '', cellRenderer: RiderCell },
      { colId: 'customer', headerName: t('col.customer'), minWidth: 160, flex: 1, valueGetter: (params) => params.data?.customer.name ?? '', cellRenderer: CustomerCell },
      { colId: 'garment', headerName: t('col.garment'), minWidth: 110, flex: 0.6, valueGetter: (params) => params.data?.garmentType ?? '' },
      { colId: 'revision', headerName: t('col.revision'), minWidth: 90, flex: 0.4, valueGetter: (params) => (params.data ? t('row.revisionValue', { revision: params.data.revision }) : '') },
      { colId: 'takenOn', headerName: t('col.takenOn'), minWidth: 130, flex: 0.6, valueGetter: (params) => (params.data ? day(params.data.takenAt) : ''), cellRenderer: TakenOnCell },
      { colId: 'takenBy', headerName: t('col.takenBy'), minWidth: 140, flex: 0.8, valueGetter: (params) => params.data?.takenBy ?? '', cellRenderer: TakenCell },
      { colId: 'baseSize', headerName: t('col.baseSize'), minWidth: 90, flex: 0.4, valueGetter: (params) => params.data?.baseSize ?? '—' },
      { colId: 'range', headerName: t('col.range'), minWidth: 150, flex: 0.7, sortable: false, valueGetter: (params) => params.data?.range.points.join(', ') ?? '', cellRenderer: RangeCell },
      { colId: 'review', headerName: t('col.review'), minWidth: 130, flex: 0.6, valueGetter: (params) => (params.data ? t(`review.${params.data.review.status}`) : ''), cellRenderer: ReviewCell },
      // F-SA-222: the count is a door to the rider's orders (any revision of the garment profile) for a reader of orders.
      { colId: 'openUnits', headerName: t('col.openUnits'), minWidth: 100, flex: 0.4, type: 'numericColumn', valueGetter: (params) => params.data?.openUnits ?? 0, cellRenderer: OpenOrdersCell },
      { colId: 'nextFitting', headerName: t('col.nextFitting'), minWidth: 140, flex: 0.6, valueGetter: (params) => (params.data?.nextFittingAt ? when(params.data.nextFittingAt) : '—') },
      { colId: 'notice', headerName: t('col.notice'), minWidth: 120, flex: 0.5, valueGetter: (params) => (params.data ? day(params.data.privacyNoticeAt) : '') },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    // The cells read the model through these values only.
  }, [t, say, day, when, model.prefix, model.can, offline])

  if (!model.can.view)
    return (
      <div className="fw-mtm">
        <Card padded>
          <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
        </Card>
      </div>
    )

  const filtered = isFiltered(model.address)
  const started = (model.templates ?? []).filter((template) => template.rulesOn && template.status === 'ACTIVE')
  const newButton = (
    <Button size="sm" variant="primary" heldReason={model.can.record ? (offline ? t('held.offline') : null) : say({ key: 'held.right', params: { right: 'right.record' } })} onClick={() => actions?.onNew?.()} aria-keyshortcuts="c">
      <Plus size={14} aria-hidden /> {t('list.new')}
    </Button>
  )
  const state: ReactNode = model.rows.problem ? (
    <EmptyState
      title={t('list.failed')}
      description={t(model.rows.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : rows !== null && rows.length === 0 ? (
    filtered ? (
      <EmptyState
        title={t('list.noMatch')}
        description={t('list.noMatchBody')}
        action={
          <Button size="sm" onClick={() => actions?.onClearFilters?.()}>
            {t('common.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState icon={<Ruler size={20} aria-hidden />} title={t('list.empty')} description={t('list.emptyBody')} action={model.can.record ? newButton : undefined} />
    )
  ) : undefined

  const chips = chipsOf(model.address, customerName(model.customers, rows, model.address.customer))
  const linkHeld = !model.can.link ? say({ key: 'held.right', params: { right: 'right.link' } }) : offline ? t('held.offline') : !rows || rows.length === 0 ? t('link.held.noRiders') : null
  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('keys.new') }]
  const tools = (
    <>
      <Select size="sm" aria-label={t('list.rows')} value={model.address.view} onChange={(event) => actions?.onAddress?.({ view: event.target.value as RowView })}>
        {ROW_VIEWS.map((view) => (
          <option key={view} value={view}>
            {t(`view.${view}`)}
          </option>
        ))}
      </Select>
      <Select size="sm" aria-label={t('list.garmentLabel')} value={model.address.garment ?? ''} onChange={(event) => actions?.onAddress?.({ garment: event.target.value || null })}>
        <option value="">{t('list.allGarments')}</option>
        {(model.templates ?? []).map((template) => (
          <option key={template.id} value={template.code}>
            {template.code} · {template.nameI18n[locale] ?? template.name}
          </option>
        ))}
      </Select>
      <ExtrasMessages>
        <CustomerFilter customers={model.customers ?? null} value={model.address.customer} onChange={(customer) => actions?.onAddress?.({ customer })} />
      </ExtrasMessages>
    </>
  )

  return (
    <div className="fw-mtm">
      <div className="fw-mtm-head">
        <div className="fw-mtm-head-text">
          <p className="fw-mtm-intro">{t('list.intro')}</p>
          <Freshness asOf={model.asOf} live={model.live} />
        </div>
        <div className="fw-mtm-actions">
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('list.more') }}
            items={[
              { id: 'link', label: t('list.sendLink'), disabled: !!linkHeld, description: linkHeld ?? undefined, onSelect: () => actions?.onLink?.() },
              { id: 'templates', label: t('list.templates'), href: templatesHref(model.prefix) },
            ]}
          />
          {newButton}
        </div>
      </div>
      {model.segments && <SegmentTabs segments={model.segments} t={t} /> /* F-SA-222 */}
      {model.templates !== null && (
        <Banner
          tone="info"
          title={started.length === 0 ? t('off.none') : t('off.some', { templates: started.map((template) => template.code).join(', ') })}
          action={
            <Button size="sm" variant="quiet" asChild>
              <Link href={templatesHref(model.prefix)}>{t('off.where')}</Link>
            </Button>
          }
        >
          {started.length === 0 ? t('off.noneBody') : t('off.someBody')}
        </Banner>
      )}
      <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} />
      <MetricStrip
        metrics={TILES.map((tile) => {
          const view = TILE_VIEW[tile]
          return {
            label: t(`tile.${tile}`),
            // B-W2b-371: an unknown count says "—", never an empty tile or 0 (design mtm.tiles).
            value: tileValue(model.tiles, tile) ?? '—',
            hint: model.tilesFailed ? t('tile.failed') : t(`tile.hint.${tile}`),
            ...(view ? { onClick: () => actions?.onAddress?.({ view: model.address.view === view ? HOME_ADDRESS.view : view }), active: model.address.view === view } : {}),
          }
        })}
      />
      {chips.length > 0 && (
        <div className="fw-mtm-chips" aria-label={t('chip.label')}>
          {chips.map((chip) => (
            <FilterChip key={chip.id} pressed onClick={() => actions?.onAddress?.(chip.clear)} aria-label={t('chip.clear', { what: say(chip.label) ?? '' })}>
              {say(chip.label)} <X size={12} aria-hidden />
            </FilterChip>
          ))}
          <Button size="sm" variant="quiet" onClick={() => actions?.onClearFilters?.()}>
            {t('chip.clearAll')}
          </Button>
        </div>
      )}
      <ListFrame<ProfileRow>
        label={t('list.tableLabel')}
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? (model.rows.more ? t('list.countMore', { count: rows.length, matching: model.rows.matching ?? rows.length }) : t('list.count', { count: rows.length })) : t('list.countReading')}
        search={
          <Input
            size="sm"
            type="search"
            className="fw-mtm-search"
            aria-label={t('list.search')}
            placeholder={t('list.search')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') actions?.onAddress?.({ q: search })
            }}
            onBlur={() => search !== model.address.q && actions?.onAddress?.({ q: search })}
          />
        }
        tools={tools}
        selection={{
          selected,
          onChange: setSelected,
          // B-W2b-371 (XF2:03): "Export N" of the selected riders through the list's export.
          exportSelected: true,
          actions: (
            <Button size="sm" aria-label={t('list.copyMany', { count: selected.length })} onClick={() => actions?.onCopy?.((rows ?? []).filter((row) => selected.includes(row.id)).map((row) => `${row.riderName}\t${row.customer.name}\t${row.garmentType}\t${t('row.revisionValue', { revision: row.revision })}`))}>
              <Copy size={13} aria-hidden /> <SelectionLabel>{t('list.copyMany', { count: selected.length })}</SelectionLabel>
            </Button>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.rows.more ? { label: t('list.showMore'), onMore: () => actions?.onMore?.(), held: offline ? t('held.offline') : null } : null}
        keys={ownKeys}
        keysOpen={model.keysOpen}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
        focusRow={model.focusRow}
        title={t('list.tableLabel')}
        cards={{ hrefOf: (row) => recordHref(model.prefix, row.id) }}
      />
      <p className="fw-mtm-hint">{t('list.foot')}</p>
      {model.measurements && <MeasurementsDialog model={model.measurements} actions={actions?.measurements} />}
      {model.link && <LinkDialog model={model.link} can={model.can} actions={actions?.link} />}
      {model.quote && <QuoteDialog model={model.quote} can={model.can} companyId={model.companyId} actions={actions?.quote} />}
    </div>
  )
}

// ── F-SA-222 (sales page plan N7, pick P12; 12-lists-board §4.4, §4.7) ──────────────────────────────────────────────────────────
type Words = ReturnType<typeof useWords>['t']

/** The page's link tabs in its band's second row (real links: back, forward and ⌘-click work). */
function SegmentTabs({ segments, t }: { segments: MtmSegments; t: Words }) {
  return <Tabs ariaLabel={t('segment.label')} tabs={SEGMENTS.map((id) => ({ id, label: t(`segment.${id}`), href: segments.href(id) }))} active={segments.active} size="sm" />
}

/** The Orders segment: this page's band, the layouts (week held), the tiles, and the ONE Orders sheet embedded. */
export function MtmOrdersSegment(props: { sheet: { model: OrdersListModel; actions: OrdersListActions }; gate: 'off' | 'none' | null; segments: MtmSegments | null; can: Pick<MtmCan, 'styles'> }) {
  return (
    <MtmMessages>
      <OrdersSegment {...props} />
    </MtmMessages>
  )
}

function OrdersSegment({ sheet, gate, segments, can }: { sheet: { model: OrdersListModel; actions: OrdersListActions }; gate: 'off' | 'none' | null; segments: MtmSegments | null; can: Pick<MtmCan, 'styles'> }) {
  const { t } = useWords()
  const { model, actions } = sheet
  // GATE-MTM: an empty view says why — made-to-measure not started for any template (a door for who may open them), or no order yet.
  const empty = gate === 'off' ? { title: t('gate.offTitle'), body: t('gate.offBody'), link: can.styles ? { href: templatesHref(model.prefix), label: t('off.where') } : null } : gate === 'none' ? { title: t('gate.noneTitle'), body: t('gate.noneBody'), link: null } : null
  return (
    <div className="fw-mtm">
      <div className="fw-mtm-head">
        <div className="fw-mtm-head-text">
          <p className="fw-mtm-intro">{t('list.intro')}</p>
          <Freshness asOf={model.asOf} live={model.live} />
        </div>
        <div className="fw-mtm-actions">
          <OrdersLayoutSwitch model={model} actions={actions} held={{ layout: 'week', why: t('week.held') }} />
          <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('list.more') }} items={[{ id: 'templates', label: t('list.templates'), href: templatesHref(model.prefix) }]} />
        </div>
      </div>
      {segments && <SegmentTabs segments={segments} t={t} />}
      <OrdersTiles model={model} actions={actions} />
      <OrdersListView model={{ ...model, empty }} actions={actions} />
    </div>
  )
}
// ── end F-SA-222 ──
