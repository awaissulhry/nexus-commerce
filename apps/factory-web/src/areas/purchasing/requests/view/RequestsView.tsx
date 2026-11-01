'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Ban, Download, FilePlus2, MoreHorizontal, Search, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, MetricStrip } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { dayAt, money, quantity } from '../../../_shared/buying/model'
import { KINDS, type BuyRequest } from '../api'
import {
  draftHeld,
  GROUPS,
  grouped,
  groupPhrase,
  rejectHeld,
  requestedByPhrase,
  requestsAddress,
  roundingPhrases,
  say,
  selectableWhy,
  sourceHref,
  sourcePhrase,
  statusPhrase,
  supplierFromPhrase,
  TILES,
  tileValue,
  toneOf,
  VIEWS,
  type Filters,
  type RequestsActions,
  type RequestsModel,
} from '../model'
import { RequestDetailView } from './RequestDetail'
import { DraftPosDialog, RejectDialog } from './RequestDialogs'
import '../../../_shared/buying/buying.css'
import '../requests.css'

export type { RequestsActions, RequestsModel } from '../model'

const NS = ['purchasing-requests', 'lists'] as const

/**
 * SCR-236 — Requests to buy (Purchasing; design purchasing.requests, 00 §2.1 inbox): what the plan and the sites' reorder
 * rules ask to buy, in ONE queue. The band (as of, live; "Draft POs for n" held until requests are picked; "Ask to buy" is
 * W2b and not drawn), the tiles "To handle" (open, need date within 14 days, waiting approval — staff requests are W2b:
 * '—' —, converted today; each a saved view), the shared list frame (search; Rows ▾, Kind ▾, Group ▾ by supplier or need
 * week, the site; select-all, shift range, x; bulk Draft POs · Reject with reason · Export; a row that may not be picked
 * says why), the source, the netting and the rounding in our words, the value with the cost grain only (the column is not
 * drawn without it). Enter opens the request (`?open=`); its source record opens in a new tab.
 */
export function RequestsView({ model, actions }: { model: RequestsModel; actions?: RequestsActions }) {
  return (
    <WithMessages namespaces={[...NS]}>
      <Requests model={model} actions={actions} />
    </WithMessages>
  )
}

function Requests({ model, actions }: { model: RequestsModel; actions?: RequestsActions }) {
  const t = useT('purchasing-requests')
  const lists = useT('lists')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const base = `${model.prefix}/purchasing/requests`
  const [query, setQuery] = useState(model.filters.q)
  useEffect(() => setQuery(model.filters.q), [model.filters.q])
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  const filtersRef = useRef(model.filters)
  filtersRef.current = model.filters
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onFilters?.({ ...filtersRef.current, q: query }), 300)
    return () => clearTimeout(timer)
  }, [query])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [help, setHelp] = useState(!!model.helpOpen)
  const items = model.rows.items
  const rowsKey = items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])

  const view = useMemo(() => grouped(items ?? [], model.filters.group), [items, model.filters.group])
  const picked = (items ?? []).filter((row) => selected.includes(row.id))
  const pickedOpen = picked.filter((row) => selectableWhy(row) === null)
  const draftWhy = draftHeld(picked, model.can, model.offline)
  const rejectWhy = rejectHeld(picked, model.can, model.offline)
  const dialogOpen = !!(model.detail || model.draft || model.reject || help)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || dialogOpen) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      if (event.key === 'b' && !draftWhy) {
        event.preventDefault()
        actions?.onDraft?.(pickedOpen.map((row) => row.id))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const ownKeys: ListKey[] = [{ keys: ['b'], does: t('keys.draft') }]
  const setFilters = (next: Partial<Filters>) => actions?.onFilters?.({ ...model.filters, ...next })

  const columns = useMemo<ColDef<BuyRequest>[]>(() => {
    const openHref = (row: BuyRequest) => requestsAddress(base, model.view, model.filters, row.id)
    const GroupCell = ({ data }: ICellRendererParams<BuyRequest>) => {
      if (!data) return null
      const count = view.first.get(data.id)
      const words = groupPhrase(data, model.filters.group)
      return count !== undefined && words ? (
        <span className="fw-by-cell">
          <b className="fw-by-ellipsis">{say(t, words)}</b>
          <span className="fw-by-cell-sub">{t('group.count', { count })}</span>
        </span>
      ) : (
        <span className="fw-rq-group-rest" aria-hidden />
      )
    }
    const SourceCell = ({ data }: ICellRendererParams<BuyRequest>) =>
      data ? (
        <span className="fw-by-cell">
          <span className="fw-by-ellipsis">{say(t, sourcePhrase(data))}</span>
          <span className="fw-by-cell-sub">{data.kind === 'PLAN' ? t('kind.PLAN') : t('kind.REORDER')} · {data.site.code}</span>
        </span>
      ) : null
    const MaterialCell = ({ data }: ICellRendererParams<BuyRequest>) =>
      data ? (
        <span className="fw-by-cell">
          <Link className="fw-by-link" href={openHref(data)} scroll={false}>
            {data.item.code}
          </Link>
          <span className="fw-by-cell-sub">
            {data.item.name}
            {data.colour ? ` · ${data.colour.name}` : ''}
            {data.item.requiresCrViTest ? ` · ${t('crVi')}` : ''}
          </span>
        </span>
      ) : null
    const QuantityCell = ({ data }: ICellRendererParams<BuyRequest>) => {
      if (!data) return null
      const rounding = roundingPhrases(data, locale).map((words) => say(t, words))
      return (
        <span className="fw-by-cell" title={rounding.length > 0 ? rounding.join(' · ') : undefined}>
          <span className="fw-by-num">
            {quantity(data.quantity, locale)} {t(`uom.${data.uom}`)}
          </span>
          <span className="fw-by-cell-sub">
            {data.estimatedHides !== null && data.uom !== 'HIDE' ? t('hides', { count: data.estimatedHides }) : rounding.length > 0 ? t('rounded', { count: rounding.length }) : t(`quantityFrom.${data.quantityFrom}`)}
          </span>
        </span>
      )
    }
    const NeedCell = ({ data }: ICellRendererParams<BuyRequest>) =>
      data ? (
        <span className="fw-by-cell">
          <span>{formatDate(dayAt(data.needDate), place)}</span>
          <span className={data.orderBy.passed && data.status === 'OPEN' ? 'fw-by-cell-sub fw-by-warning' : 'fw-by-cell-sub'}>
            {t(data.orderBy.passed && data.status === 'OPEN' ? 'orderBy.passed' : 'orderBy.on', { date: formatDate(dayAt(data.orderBy.date), place) })}
          </span>
        </span>
      ) : null
    const SupplierCell = ({ data }: ICellRendererParams<BuyRequest>) => {
      if (!data) return null
      const from = supplierFromPhrase(data)
      return (
        <span className="fw-by-cell">
          <span className="fw-by-ellipsis">{data.supplier ? data.supplier.name : t('supplier.none')}</span>
          <span className="fw-by-cell-sub">{from ? say(t, from) : t('supplier.pick')}</span>
        </span>
      )
    }
    const ByCell = ({ data }: ICellRendererParams<BuyRequest>) =>
      data ? (
        <span className="fw-by-cell">
          <span className="fw-by-ellipsis">{say(t, requestedByPhrase(data))}</span>
          <span className="fw-by-cell-sub">{data.plan ? formatDate(data.plan.runStartedAt, place) : t('by.live')}</span>
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<BuyRequest>) => {
      if (!data) return null
      const why = data.status === 'OPEN' ? selectableWhy(data) : null
      const warning = data.warnings[0]
      return (
        <span className="fw-by-cell">
          <span>
            <Pill tone={toneOf(data)}>{say(t, statusPhrase(data))}</Pill>
          </span>
          <span className={why ? 'fw-by-cell-sub fw-by-warning' : 'fw-by-cell-sub'}>{why ? say(t, why) : warning ? t(`warning.${warning.code}`) : ''}</span>
        </span>
      )
    }
    const ValueCell = ({ data }: ICellRendererParams<BuyRequest>) => (data ? <span className="fw-by-num">{data.currency ? money(data.expectedAmount ?? null, data.currency, locale) : '—'}</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<BuyRequest>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('row.menu', { material: data.item.code }) }}
          items={[
            { id: 'open', label: t('row.open'), href: openHref(data) },
            { id: 'source', label: t('row.source'), href: sourceHref(model.prefix, data), target: '_blank' },
            ...(data.status === 'OPEN' && !data.hold && model.can.manage ? [{ id: 'draft', label: t('row.draft'), onSelect: () => actions?.onDraft?.([data.id]) }] : []),
            ...(data.kind === 'PLAN' && data.status === 'OPEN' && model.can.decide ? [{ id: 'reject', label: t('row.reject'), onSelect: () => actions?.onReject?.([data.id]) }] : []),
          ]}
        />
      ) : null
    return [
      ...(model.filters.group !== 'none' ? [{ colId: 'group', headerName: t(`col.group.${model.filters.group}`), minWidth: 150, flex: 1, sortable: false, cellRenderer: GroupCell } satisfies ColDef<BuyRequest>] : []),
      { colId: 'source', headerName: t('col.source'), minWidth: 170, flex: 1.2, cellRenderer: SourceCell },
      { colId: 'material', headerName: t('col.material'), minWidth: 180, flex: 1.5, cellRenderer: MaterialCell },
      { colId: 'quantity', headerName: t('col.quantity'), minWidth: 120, flex: 0.8, type: 'rightAligned', cellRenderer: QuantityCell },
      { colId: 'need', headerName: t('col.need'), minWidth: 140, flex: 0.9, cellRenderer: NeedCell },
      { colId: 'supplier', headerName: t('col.supplier'), minWidth: 170, flex: 1.3, cellRenderer: SupplierCell },
      { colId: 'by', headerName: t('col.by'), minWidth: 140, flex: 0.9, cellRenderer: ByCell },
      { colId: 'status', headerName: t('col.status'), minWidth: 170, flex: 1.1, cellRenderer: StatusCell },
      ...(model.can.cost ? [{ colId: 'value', headerName: t('col.value'), minWidth: 110, flex: 0.7, type: 'rightAligned', cellRenderer: ValueCell } satisfies ColDef<BuyRequest>] : []),
      { colId: 'more', headerName: t('col.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, base, model.view, model.filters, model.prefix, model.can, model.timeZone, view])

  if (!model.can.view) {
    return (
      <div className="fw-by">
        <Card padded>
          <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('noAccess.title')} description={t('noAccess.body')} />
        </Card>
      </div>
    )
  }

  const tileView = TILES.find((tile) => tile.view === model.view)?.view ?? null
  const filtered = model.filters.q.trim() !== '' || model.filters.kind !== null || model.view !== 'open'
  const state = model.rows.problem ? (
    <EmptyState title={t('list.failed')} description={t(model.rows.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : items && items.length === 0 ? (
    filtered ? (
      <EmptyState
        title={t('list.noMatch.title')}
        description={t('list.noMatch.body')}
        action={
          <Button
            size="sm"
            onClick={() => {
              setQuery('')
              actions?.onFilters?.({ ...model.filters, q: '', kind: null })
              actions?.onView?.('open')
            }}
          >
            {t('common.clearFilters')}
          </Button>
        }
      />
    ) : (
      <EmptyState
        title={t('list.empty.title')}
        description={
          <>
            {t('list.empty.body')}{' '}
            {model.can.planView && (
              <Link className="fw-by-link" href={`${model.prefix}/planning/mrp`}>
                {t('list.empty.plan')}
              </Link>
            )}
          </>
        }
      />
    )
  ) : undefined

  const count = items ? (model.rows.matching !== null && model.rows.matching > items.length ? t('list.countOf', { count: items.length, total: model.rows.matching }) : t('list.count', { count: items.length })) : '—'

  return (
    <div className="fw-by">
      <div className="fw-by-head">
        <span className="fw-by-status" role="status">
          {model.asOf ? t('common.asOf', { time: formatTime(model.asOf, place) }) : t('common.notYet')}
          {' · '}
          {t(model.offline ? 'live.offlineNet' : `live.${model.live}`)}
        </span>
        <span className="fw-by-actions">
          {model.can.planView && (
            <Button size="sm" asChild>
              <Link href={`${model.prefix}/planning/mrp`}>{t('band.plan')}</Link>
            </Button>
          )}
          <Button size="sm" variant="primary" heldReason={draftWhy ? say(t, draftWhy) : null} onClick={() => actions?.onDraft?.(pickedOpen.map((row) => row.id))} aria-keyshortcuts="b">
            <FilePlus2 size={14} aria-hidden /> {pickedOpen.length > 0 ? t('band.draft', { count: pickedOpen.length }) : t('band.draftNone')}
          </Button>
        </span>
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={say(t, model.notice.words)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        >
          {model.notice.orders && model.notice.orders.length > 0 && (
            <span className="fw-by-chips">
              {model.notice.orders.map((order) => (
                <Link key={order.id} className="fw-by-link" href={`${model.prefix}/purchasing/orders/${order.id}`}>
                  {order.number}
                </Link>
              ))}
            </span>
          )}
        </Banner>
      )}

      {model.counts.problem ? (
        <Card padded>
          <EmptyState title={t('tiles.failed')} description={t(model.counts.problem)} action={<Button size="sm" onClick={() => actions?.onRetryCounts?.()}>{t('common.retry')}</Button>} />
        </Card>
      ) : (
        <MetricStrip
          metrics={TILES.map((tile) => ({
            label: t(`tile.${tile.id}`),
            value: tileValue(tile, model.counts.value),
            ...(tile.view ? { onClick: () => actions?.onView?.(model.view === tile.view ? 'all' : tile.view!), active: tileView === tile.view } : { hint: t('tile.waitingHint') }),
          }))}
        />
      )}

      <ListFrame<BuyRequest>
        label={t('list.label')}
        rows={state ? [] : items === null ? null : view.rows}
        rowId={(row) => row.id}
        columns={columns}
        count={count}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={13} aria-hidden />}
            aria-label={t('list.search')}
            placeholder={t('list.search')}
            value={query}
            onChange={(event) => {
              typed.current = true
              setQuery(event.target.value)
            }}
          />
        }
        tools={
          <>
            <Select size="sm" aria-label={t('list.viewLabel')} value={model.view} onChange={(event) => actions?.onView?.(event.target.value as RequestsModel['view'])}>
              {VIEWS.map((entry) => (
                <option key={entry} value={entry}>
                  {t(`view.${entry}`)}
                </option>
              ))}
            </Select>
            <Select size="sm" aria-label={t('list.kindLabel')} value={model.filters.kind ?? ''} onChange={(event) => setFilters({ kind: (event.target.value || null) as Filters['kind'] })}>
              <option value="">{t('kind.all')}</option>
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`kind.${kind}`)}
                </option>
              ))}
            </Select>
            <Select size="sm" aria-label={t('list.groupLabel')} value={model.filters.group} onChange={(event) => setFilters({ group: event.target.value as Filters['group'] })}>
              {GROUPS.map((group) => (
                <option key={group} value={group}>
                  {t(`groupBy.${group}`)}
                </option>
              ))}
            </Select>
            {model.sites.length > 1 && (
              <Select size="sm" aria-label={t('list.siteLabel')} value={model.filters.site ?? ''} onChange={(event) => setFilters({ site: event.target.value || null })}>
                <option value="">{t('site.all')}</option>
                {model.sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.code} · {site.name}
                  </option>
                ))}
              </Select>
            )}
          </>
        }
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <>
              <Button size="sm" variant="primary" heldReason={draftWhy ? say(t, draftWhy) : null} aria-label={t('bulk.draft', { count: pickedOpen.length })} onClick={() => actions?.onDraft?.(pickedOpen.map((row) => row.id))}>
                <FilePlus2 size={13} aria-hidden /> <SelectionLabel>{t('bulk.draft', { count: pickedOpen.length })}</SelectionLabel>
              </Button>
              <Button size="sm" heldReason={rejectWhy ? say(t, rejectWhy) : null} aria-label={t('bulk.reject', { count: picked.length })} onClick={() => actions?.onReject?.(picked.map((row) => row.id))}>
                <Ban size={13} aria-hidden /> <SelectionLabel>{t('bulk.reject', { count: picked.length })}</SelectionLabel>
              </Button>
              <Button size="sm" aria-label={t('bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: picked.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        isRowSelectable={(row) => {
          const why = selectableWhy(row)
          return why ? say(t, why) : null
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.rows.more && items && items.length > 0 ? { label: t('common.more'), onMore: () => actions?.onMore?.() } : null}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
        keysOpen={model.keysOpen}
      />
      {model.view !== 'open' && <p className="fw-by-hint">{t('list.viewing', { view: t(`view.${model.view}`) })}</p>}

      {model.detail && <RequestDetailView model={model} ids={view.rows.map((row) => row.id)} actions={actions} />}
      {model.draft && <DraftPosDialog model={model} actions={actions} />}
      {model.reject && <RejectDialog model={model} actions={actions} />}
      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('common.shortcuts')} size="sm">
          <ul className="fw-by-list">
            {listKeys(ownKeys, true).map((entry) => (
              <li key={entry.does}>
                <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
              </li>
            ))}
            <li>
              <b>J K</b> — {t('keys.walk')}
            </li>
          </ul>
        </Modal>
      )}
    </div>
  )
}
