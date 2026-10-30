'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Download, MoreHorizontal, Plus, Search } from 'lucide-react'
import { Banner, EmptyState, Menu, MetricStrip } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Select } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { CountRow } from '../../api'
import { LIST_VIEWS, TILES, type ListView } from '../../model'
import { CountsMessages, KeysModal, KindTag, Money, NoCountsAccess, say, scopeText, StatusPill, useWords } from '../../parts'
import type { CountsListActions, CountsListModel } from '../../view-model'
import { NewCountDialog } from './NewCountDialog'

export type { CountsListActions, CountsListModel } from '../../view-model'

/**
 * SCR-132 — Counts (Warehouse › In the warehouse; design warehouse.counts, cn-metrics + cn-grid): the tiles that wait for
 * someone (counting, waiting for approval, to apply, the year-end inventory — each a saved row), and every cycle count and
 * year-end physical inventory on the shared list frame: number, kind, scope, state, lines counted ("84 of 120"), the
 * differences (how many; their value with the cost grain only), started and applied. No person's name in a row, a filter
 * or a total (Owner W1). New count (`c`) opens the dialog; Export N (CSV) for the selection; row ⋯ the count sheets.
 */
export function CountsListView({ model, actions }: { model: CountsListModel; actions?: CountsListActions }) {
  return (
    <CountsMessages>
      <CountsList model={model} actions={actions} />
    </CountsMessages>
  )
}

function CountsList({ model, actions }: { model: CountsListModel; actions?: CountsListActions }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const [query, setQuery] = useState(model.q)
  useEffect(() => setQuery(model.q), [model.q])
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onSearch?.(query), 300)
    return () => clearTimeout(timer)
  }, [query])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [help, setHelp] = useState(!!model.helpOpen)
  const rowsKey = model.rows.items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  useEffect(() => setSelected(model.selected ?? []), [model.selected, model.view])

  // c: a new count (design kb "c new count") — never while typing, in a dialog or a menu. The frame keeps / j k x Enter ?.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.newCount || help) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      if (event.key === 'c' && model.can.manage) {
        event.preventDefault()
        latest.current?.onNew?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model.newCount, model.can.manage, help])

  const columns = useMemo<ColDef<CountRow>[]>(() => {
    const href = (row: CountRow) => `${model.prefix}/warehouse/counts/${encodeURIComponent(row.id)}`
    const NumberCell = ({ data }: ICellRendererParams<CountRow>) =>
      data ? (
        <span className="fw-st-cell">
          <Link className="fw-st-link fw-cn-code" href={href(data)}>
            {data.number}
          </Link>
          <span className="fw-st-sub">{data.site.code}</span>
        </span>
      ) : null
    const KindCell = ({ data }: ICellRendererParams<CountRow>) =>
      data ? (
        <span className="fw-st-cell">
          <span>
            <KindTag kind={data.kind} short />
          </span>
          {data.inventoryDate && <span className="fw-st-sub">{t('list.asOf', { date: formatDate(data.inventoryDate, place) })}</span>}
        </span>
      ) : null
    const ScopeCell = ({ data }: ICellRendererParams<CountRow>) => {
      if (!data) return null
      const scope = scopeText(t, data.scope)
      return (
        <span className="fw-st-cell" title={scope}>
          <span className="fw-st-ellipsis">{scope}</span>
          {data.countTeam && <span className="fw-st-sub">{t('list.team', { team: data.countTeam })}</span>}
        </span>
      )
    }
    const StatusCell = ({ data }: ICellRendererParams<CountRow>) => {
      if (!data) return null
      const sub =
        data.status === 'SUBMITTED'
          ? t(data.approvalRequired ? 'list.waitsApproval' : 'list.waitsApply')
          : data.status === 'APPLIED' && data.kind === 'YEAR_END'
            ? t('list.waitsSignOff')
            : data.status === 'COUNTING' && data.rejectedAt
              ? t('list.sentBack')
              : null
      return (
        <span className="fw-st-cell">
          <span>
            <StatusPill status={data.status} />
          </span>
          {sub && <span className="fw-st-sub">{sub}</span>}
        </span>
      )
    }
    const LinesCell = ({ data }: ICellRendererParams<CountRow>) =>
      data ? (
        <span className="fw-st-num" title={t('list.linesTitle', { counted: data.lines.counted, all: data.lines.all })}>
          {data.status === 'DRAFT' ? '—' : t('list.lines', { counted: data.lines.counted, all: data.lines.all })}
        </span>
      ) : null
    const DiffCell = ({ data }: ICellRendererParams<CountRow>) => {
      if (!data) return null
      if (data.status === 'DRAFT') return <span className="fw-st-num">—</span>
      return (
        <span className="fw-st-cell">
          <span className={data.lines.differing > 0 ? 'fw-st-num strong' : 'fw-st-num'}>{t('list.diffs', { count: data.lines.differing })}</span>
          {model.can.cost && data.differenceAmount !== undefined && data.submittedAt && (
            <span className="fw-st-sub">
              <Money minor={data.differenceAmount} currency={data.currency} />
            </span>
          )}
        </span>
      )
    }
    const DateCell =
      (pick: (row: CountRow) => string | null) =>
      ({ data }: ICellRendererParams<CountRow>) => {
        const value = data ? pick(data) : null
        return <span className="fw-st-num">{value ? formatDate(value, place) : '—'}</span>
      }
    const MoreCell = ({ data }: ICellRendererParams<CountRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { number: data.number }) }}
          items={[
            { id: 'open', label: t('list.open'), href: href(data) },
            { id: 'tab', label: t('list.openNewTab'), href: href(data), target: '_blank' },
            { id: 'differences', label: t('tab.differences'), href: `${href(data)}?tab=differences` },
            { id: 'approval', label: t('tab.approval'), href: `${href(data)}?tab=approval` },
            ...(data.status !== 'DRAFT' && data.status !== 'CANCELLED'
              ? [
                  { id: 'sheets', label: t('sheets.withExpected'), onSelect: () => actions?.onSheets?.(data.id, true) },
                  { id: 'blind', label: t('sheets.blind'), onSelect: () => actions?.onSheets?.(data.id, false) },
                ]
              : []),
          ]}
        />
      ) : null
    const base: ColDef<CountRow>[] = [
      { colId: 'number', headerName: t('col.number'), minWidth: 150, flex: 0.9, cellRenderer: NumberCell },
      { colId: 'kind', headerName: t('col.kind'), minWidth: 140, flex: 0.8, cellRenderer: KindCell },
      { colId: 'scope', headerName: t('col.scope'), minWidth: 220, flex: 1.7, cellRenderer: ScopeCell },
      { colId: 'status', headerName: t('col.status'), minWidth: 180, flex: 1.1, cellRenderer: StatusCell },
      { colId: 'lines', headerName: t('col.lines'), minWidth: 140, flex: 0.8, type: 'rightAligned', cellRenderer: LinesCell },
      { colId: 'diffs', headerName: t(model.can.cost ? 'col.diffsValue' : 'col.diffs'), minWidth: 170, flex: 0.9, type: 'rightAligned', cellRenderer: DiffCell },
      { colId: 'started', headerName: t('col.started'), minWidth: 115, flex: 0.6, cellRenderer: DateCell((row) => row.startedAt) },
      { colId: 'applied', headerName: t('col.applied'), minWidth: 120, flex: 0.6, cellRenderer: DateCell((row) => row.appliedAt) },
      { colId: 'more', headerName: t('col.actions'), minWidth: 84, maxWidth: 84, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    return base
  }, [t, locale, model.prefix, model.can.cost, model.timeZone])

  if (!model.can.view) {
    return (
      <div className="fw-cn">
        <NoCountsAccess />
      </div>
    )
  }

  const tileView = TILES.find((tile) => tile.view === model.view)?.view ?? null
  const picked = (model.rows.items ?? []).filter((row) => selected.includes(row.id))
  const filtered = model.q.trim() !== '' || model.view !== 'open' || model.siteId !== null
  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('keys.new') }]
  const clearFilters = (
    <Button
      size="sm"
      onClick={() => {
        setQuery('')
        actions?.onSearch?.('')
        actions?.onView?.('open')
        actions?.onSite?.(null)
      }}
    >
      {t('stock:common.clearFilters')}
    </Button>
  )
  const newButton = (
    <Button size="sm" variant="primary" heldReason={model.can.manage ? null : t('held.noManage')} onClick={() => actions?.onNew?.()} aria-keyshortcuts="c">
      <Plus size={14} aria-hidden /> {t('list.new')}
    </Button>
  )
  const state = model.rows.problem ? (
    <EmptyState title={t('list.failed')} description={t(`stock:${model.rows.problem}`)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('stock:problem.retry')}</Button>} />
  ) : model.rows.items && model.rows.items.length === 0 ? (
    filtered ? (
      <EmptyState title={t('list.noMatch')} description={t('stock:common.noMatch')} action={clearFilters} />
    ) : (
      <EmptyState title={t('list.empty')} description={t('list.emptyBody')} action={model.can.manage ? newButton : undefined} />
    )
  ) : undefined

  const search = (
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
  )
  const tools = (
    <>
      <Select size="sm" aria-label={t('list.viewLabel')} value={model.view} onChange={(event) => actions?.onView?.(event.target.value as ListView)}>
        {LIST_VIEWS.map((view) => (
          <option key={view} value={view}>
            {t(`view.${view}`)}
          </option>
        ))}
      </Select>
      {model.sites.length > 1 && (
        <Select size="sm" aria-label={t('stock:common.site')} value={model.siteId ?? ''} onChange={(event) => actions?.onSite?.(event.target.value || null)}>
          <option value="">{t('stock:common.allSites')}</option>
          {model.sites.map((site) => (
            <option key={site.id} value={site.id}>
              {`${site.code} · ${site.name}`}
            </option>
          ))}
        </Select>
      )}
    </>
  )

  return (
    <div className="fw-cn">
      <div className="fw-cn-head">
        <span className="fw-cn-status" role="status">
          {model.asOf ? t('stock:live.updated', { time: formatTime(model.asOf, place) }) : t('list.notYet')}
          {' · '}
          {t(`stock:live.${model.live}`)}
        </span>
        {newButton}
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={say(t, model.notice.words) ?? ''}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('stock:common.close')}
              </Button>
            ) : undefined
          }
        />
      )}

      <MetricStrip
        metrics={TILES.map((tile) => ({
          label: t(`tile.${tile.id}`),
          value: model.tiles ? String(tile.count(model.tiles)) : '—',
          hint: t(`tileHint.${tile.id}`),
          onClick: () => actions?.onView?.(model.view === tile.view ? 'open' : tile.view),
          active: tileView === tile.view,
        }))}
      />

      <ListFrame<CountRow>
        label={t('list.tableLabel')}
        rows={state ? [] : model.rows.items}
        rowId={(row) => row.id}
        columns={columns}
        count={model.rows.items ? t(model.rows.more ? 'list.countMore' : 'list.count', { count: model.rows.items.length }) : '—'}
        search={search}
        tools={tools}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" aria-label={t('stock:common.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
              <Download size={13} aria-hidden /> <SelectionLabel>{t('stock:common.export', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.rows.more && model.rows.items && model.rows.items.length > 0 ? { label: t('list.showMore'), onMore: () => actions?.onMore?.() } : null}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
      />
      <p className="fw-cn-hint">{t(model.can.cost ? 'list.footCost' : 'list.foot')}</p>

      {model.newCount && <NewCountDialog model={model.newCount} sites={model.sites} can={model.can} actions={actions} />}
      {help && <KeysModal own={ownKeys} onClose={() => setHelp(false)} />}
    </div>
  )
}
