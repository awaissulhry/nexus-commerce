'use client'

import { useEffect, useMemo, useRef } from 'react'
import Link from 'next/link'
import { BookOpen, Download, MoreHorizontal, Search, X } from 'lucide-react'
import { Banner, EmptyState, Menu, MetricStrip, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Skeleton } from '@nexus/ui/primitives'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { Freshness, NoAccess, NoticeBanner, PageHead } from '../../../quality/_shared/parts'
import { REGISTER_KINDS, REGISTER_RISKS, type Entry, type RegisterKind, type RegisterRisk } from '../api'
import { concernSummary, isFiltered, LIST_MAX, PAGE, sourceKey, TILES, type ListDialog, type RegisterFilters, type RegisterListModel, type RegisterView, type TileId } from '../model'
import { NewEntryModal, type NewEntryActions } from './NewEntryModal'
import { codesText, DayText, RegisterMessages, RiskTag, ShortcutsModal, StatusPill } from './parts'

export interface RegisterListActions extends NewEntryActions {
  onQuery?: (query: string) => void
  onView?: (view: RegisterView) => void
  onFilters?: (filters: RegisterFilters) => void
  onClearAll?: () => void
  onMore?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onSelect?: (ids: readonly string[]) => void
  onDialog?: (dialog: ListDialog | null) => void
  /** Enter on a row: open its record. */
  onOpen?: (row: Entry) => void
  onExport?: (rows: readonly Entry[]) => void
  onCopy?: (text: string) => void
  onDismissNotice?: () => void
}

/**
 * SCR-113 PPE register & recalls (design compliance.register, W1; Reg. (EU) 2016/425 art. 8(4), 8(8)): the legal
 * register of complaints, non-conformities and recalls. The head (one sentence, Updated · Live, New entry), who keeps the
 * register (at rest), the tiles (each a saved view: pressing one puts its chip in the toolbar), then the ONE list frame:
 * count, search, Rows ▾, Filters ▾, chips, ⋯ — swapped for the bulk actions while rows are selected (Export N) — the grid
 * with the header select-all and shift-click ranges, and the footer with Show more and the keys icon. Entries are never
 * deleted: a correction is a note. No money here. Fetches nothing: RegisterPage.tsx reads and writes.
 */
export function RegisterListView({ model, actions }: { model: RegisterListModel; actions?: RegisterListActions }) {
  return (
    <RegisterMessages>
      <RegisterList model={model} actions={actions} />
    </RegisterMessages>
  )
}

function RegisterList({ model, actions }: { model: RegisterListModel; actions?: RegisterListActions }) {
  const t = useT('register')
  const q = useT('quality')
  const lists = useT('lists')
  const locale = useLocale()
  const can = model.can
  const dialog = model.dialog ?? null
  const rows = useMemo(() => model.rows.value ?? [], [model.rows.value])
  const selectedRows = rows.filter((row) => model.selected.includes(row.id))
  const manageHeld = can.registerManage ? null : t('held.manage')
  const open = (next: ListDialog | null) => actions?.onDialog?.(next)

  // c: New entry (the frame's keys are / j k x ↵ ?; this handler skips fields, menus and dialogs the same way).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.key !== 'c' || event.metaKey || event.ctrlKey || event.altKey || dialog || !can.registerManage) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      event.preventDefault()
      open({ kind: 'new' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // The cells reach the page's actions through a ref: a new actions object must not rebuild the columns.
  const live = useRef({ actions })
  live.current = { actions }
  const columns = useMemo<ColDef<Entry>[]>(() => {
    const href = (row: Entry) => `${model.prefix}/compliance/register/${encodeURIComponent(row.id)}`
    const EntryCell = ({ data }: ICellRendererParams<Entry>) =>
      data ? (
        <span className="fw-q-cell">
          <Link className="fw-q-name fw-q-code" href={href(data)} tabIndex={-1}>
            {data.reference}
          </Link>
          <span className="fw-q-hint">{t('list.reportedOn', { date: formatDate(data.reportedAt, { locale }) })}</span>
        </span>
      ) : null
    const StyleCell = ({ data }: ICellRendererParams<Entry>) =>
      data ? (
        <span className="fw-q-cell">
          <span className="fw-q-code">{data.style.code}</span>
          <span className="fw-q-hint">{data.style.name}</span>
        </span>
      ) : null
    const ConcernCell = ({ data }: ICellRendererParams<Entry>) => {
      if (!data) return null
      const concern = concernSummary(data)
      if (concern.kind === 'none') return <span className="fw-q-hint">{t('list.noGarments')}</span>
      return (
        <span className="fw-q-cell">
          <span className="fw-q-code">{codesText(concern.shown, concern.more, t)}</span>
          <span className="fw-q-hint">{t(`list.concern.${concern.kind}`)}</span>
        </span>
      )
    }
    const RiskCell = ({ data }: ICellRendererParams<Entry>) => (data ? <RiskTag risk={data.risk} /> : null)
    const StatusCell = ({ data }: ICellRendererParams<Entry>) => (data ? <StatusPill status={data.status} /> : null)
    const InformedCell = ({ data }: ICellRendererParams<Entry>) =>
      data ? data.distributorsInformedAt ? <DayText value={data.distributorsInformedAt} /> : <span className="fw-q-hint">{data.status === 'OPEN' ? t('list.notYet') : '—'}</span> : null
    const AuthorityCell = ({ data }: ICellRendererParams<Entry>) =>
      data ? (
        data.authorityNotifiedAt ? (
          <span className="fw-q-cell">
            <DayText value={data.authorityNotifiedAt} />
            {data.authorityReference && <span className="fw-q-hint fw-q-code">{data.authorityReference}</span>}
          </span>
        ) : (
          <span className="fw-q-hint">—</span>
        )
      ) : null
    const ActionsCell = ({ data }: ICellRendererParams<Entry>) =>
      data ? (
        <Menu
          align="right"
          label={<MoreHorizontal size={16} aria-hidden />}
          triggerProps={{ 'aria-label': t('row.menu', { reference: data.reference }) }}
          items={[
            { id: 'open', label: t('row.open'), href: href(data) },
            { id: 'tab', label: t('row.openNewTab'), href: href(data), target: '_blank' },
            { id: 'copy', label: t('row.copy'), onSelect: () => live.current.actions?.onCopy?.(data.reference) },
          ]}
        />
      ) : null
    const column = (colId: string, header: string, cellRenderer: ColDef<Entry>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number }): ColDef<Entry> => ({
      colId,
      headerName: header,
      cellRenderer,
      sortable: false,
      ...size,
    })
    return [
      column('entry', t('list.col.entry'), EntryCell, { flex: 1.3, minWidth: 160 }),
      { colId: 'kind', headerName: t('list.col.kind'), sortable: false, flex: 1, minWidth: 120, valueGetter: (params) => (params.data ? t(`kind.${params.data.kind}`) : '') },
      column('style', t('list.col.style'), StyleCell, { flex: 1.3, minWidth: 150 }),
      column('concern', t('list.col.concern'), ConcernCell, { flex: 1.3, minWidth: 160 }),
      { colId: 'reporter', headerName: t('list.col.reporter'), sortable: false, flex: 1.1, minWidth: 130, valueGetter: (params) => (params.data ? (params.data.party?.name ?? '—') : '') },
      column('risk', t('list.col.risk'), RiskCell, { flex: 1, minWidth: 140 }),
      { colId: 'source', headerName: t('list.col.source'), sortable: false, flex: 1.1, minWidth: 140, valueGetter: (params) => (params.data ? t(sourceKey(params.data)) : '') },
      column('status', t('list.col.status'), StatusCell, { flex: 0.8, minWidth: 100 }),
      column('informed', t('list.col.informed'), InformedCell, { flex: 1, minWidth: 120 }),
      column('authority', t('list.col.authority'), AuthorityCell, { flex: 1.1, minWidth: 130 }),
      { ...column('actions', t('list.col.actions'), ActionsCell, { width: 72, minWidth: 72 }), suppressHeaderMenuButton: true },
    ]
    // The cells close over the words and the prefix: a change of language rebuilds them.
  }, [t, locale, model.prefix])

  if (!can.registerView) return <NoAccess title={t('noAccess.title')} body={t('noAccess.body')} />

  const filtered = isFiltered(model.view, model.filters, model.query)
  const tile = (id: TileId) => {
    const count = model.tiles[id]
    const active = model.view === id
    return {
      label: t(`tile.${id}`),
      value: count === undefined ? <Skeleton width={36} height={22} /> : count === null ? '—' : count.complete ? String(count.count) : t('tile.atLeast', { count: count.count }),
      hint: count === null ? t('tile.unknown') : t(`tile.${id}Hint`),
      active,
      onClick: () => actions?.onView?.(active ? 'all' : id),
    }
  }

  const viewItems: MenuItemDef[] = [
    { id: 'heading', heading: true, label: t('list.rowsHeading') } as MenuItemDef,
    ...(['all', ...TILES] as RegisterView[]).map((view) => ({ id: view, label: t(`view.${view}`), checked: model.view === view, onSelect: () => actions?.onView?.(view) }) as MenuItemDef),
  ]
  const filterItems: MenuItemDef[] = [
    { id: 'kind', heading: true, label: t('list.col.kind') } as MenuItemDef,
    ...REGISTER_KINDS.map(
      (kind) =>
        ({
          id: `kind-${kind}`,
          label: t(`kind.${kind}`),
          checked: model.filters.kind === kind,
          onSelect: () => actions?.onFilters?.({ ...model.filters, kind: model.filters.kind === kind ? null : (kind as RegisterKind) }),
        }) as MenuItemDef,
    ),
    { id: 'sep', separator: true } as MenuItemDef,
    { id: 'risk', heading: true, label: t('list.col.risk') } as MenuItemDef,
    ...REGISTER_RISKS.map(
      (risk) =>
        ({
          id: `risk-${risk}`,
          label: t(`risk.${risk}`),
          checked: model.filters.risk === risk,
          disabled: model.view === 'risk' || model.view === 'assessing',
          description: model.view === 'risk' || model.view === 'assessing' ? t('held.viewSetsRisk') : undefined,
          onSelect: () => actions?.onFilters?.({ ...model.filters, risk: model.filters.risk === risk ? null : (risk as RegisterRisk) }),
        }) as MenuItemDef,
    ),
  ]
  const moreItems: MenuItemDef[] = [
    {
      id: 'export',
      label: t('list.exportView'),
      onSelect: () => actions?.onExport?.(rows),
      disabled: rows.length === 0,
      description: rows.length === 0 ? t('list.exportNothing') : t('list.exportViewHint', { count: rows.length }),
    },
    { id: 'sep', separator: true } as MenuItemDef,
    { id: 'keys', label: t('keys.title'), onSelect: () => open({ kind: 'shortcuts' }) },
  ]
  const filterCount = (model.filters.kind ? 1 : 0) + (model.filters.risk ? 1 : 0)
  const chip = (key: string, label: string, onRemove: () => void) => (
    <FilterChip key={key} pressed onClick={onRemove} aria-label={t('list.removeFilter', { name: label })}>
      {label} <X size={12} aria-hidden />
    </FilterChip>
  )
  const tools = (
    <>
      <Menu label={t('list.rows', { view: t(`view.${model.view}`) })} items={viewItems} />
      <Menu label={filterCount > 0 ? t('list.filtersCount', { count: filterCount }) : t('list.filters')} items={filterItems} />
      {filtered && (
        <span className="fw-q-chips" aria-label={t('list.activeFilters')}>
          {model.view !== 'all' && chip('view', t(`view.${model.view}`), () => actions?.onView?.('all'))}
          {model.filters.kind && chip('kind', t(`kind.${model.filters.kind}`), () => actions?.onFilters?.({ ...model.filters, kind: null }))}
          {model.filters.risk && chip('risk', t(`risk.${model.filters.risk}`), () => actions?.onFilters?.({ ...model.filters, risk: null }))}
          {model.query.trim() !== '' && chip('q', `“${model.query.trim()}”`, () => actions?.onQuery?.(''))}
          <Button size="sm" variant="quiet" onClick={() => actions?.onClearAll?.()}>
            {t('list.clearAll')}
          </Button>
        </span>
      )}
    </>
  )

  // Every row can be exported (closed ones too): no row is without a bulk action, so isRowSelectable is not used.
  const bulkActions = (
    <Button size="sm" onClick={() => actions?.onExport?.(selectedRows)} aria-label={t('list.bulkExport', { count: selectedRows.length })}>
      <Download size={13} aria-hidden /> <SelectionLabel>{t('list.bulkExport', { count: selectedRows.length })}</SelectionLabel>
    </Button>
  )

  const state = model.rows.problem ? (
    <EmptyState
      title={t('list.failedTitle')}
      description={q(model.rows.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {q('common.retry')}
        </Button>
      }
    />
  ) : model.rows.value !== null && rows.length === 0 ? (
    filtered ? (
      <EmptyState
        title={t('list.noMatch')}
        action={
          <Button size="sm" onClick={() => actions?.onClearAll?.()}>
            {t('list.clearAll')}
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={<BookOpen size={24} aria-hidden />}
        title={t('list.empty.title')}
        description={t('list.empty.body')}
        action={
          <Button variant="primary" onClick={() => open({ kind: 'new' })} heldReason={manageHeld}>
            {t('new.action')}
          </Button>
        }
      />
    )
  ) : undefined

  const atMax = model.limit >= LIST_MAX
  const more =
    model.rows.value !== null && (model.pageFull ?? model.rows.value.length >= model.limit)
      ? {
          label: atMax ? t('list.atMax', { max: LIST_MAX }) : t('list.showMore', { count: Math.min(PAGE, LIST_MAX - model.limit) }),
          onMore: () => actions?.onMore?.(),
          held: atMax ? t('held.atMax', { max: LIST_MAX }) : model.loadingMore ? q('common.loading') : null,
        }
      : null
  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('keys.new') }]
  const word = (does: string) => {
    const text = lists(does)
    return text === does ? does : text
  }

  return (
    <div className="fw-q">
      <PageHead
        intro={t('intro')}
        status={<Freshness asOf={model.asOf} live={model.live} />}
        actions={
          <Button size="sm" variant="primary" onClick={() => open({ kind: 'new' })} heldReason={manageHeld}>
            {t('new.action')}
          </Button>
        }
      />
      <Banner tone="info" title={t('keeper.title')}>
        {t('keeper.body')}
      </Banner>
      <NoticeBanner notice={model.notice} namespace="register" onDismiss={actions?.onDismissNotice} />
      <MetricStrip metrics={TILES.map(tile)} />

      <ListFrame<Entry>
        label={t('list.table')}
        rows={model.rows.problem ? [] : model.rows.value}
        rowId={(row) => row.id}
        columns={columns}
        count={t('list.count', { count: rows.length })}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={14} aria-hidden />}
            aria-label={t('list.search')}
            placeholder={t('list.search')}
            value={model.query}
            onChange={(event) => actions?.onQuery?.(event.target.value)}
          />
        }
        tools={tools}
        right={<Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('list.more') }} items={moreItems} />}
        selection={{ selected: model.selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulkActions }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={more}
        keys={ownKeys}
        onHelp={() => open({ kind: 'shortcuts' })}
        onOpen={(row) => actions?.onOpen?.(row)}
        state={state}
        focusRow={model.focusRow}
      />

      <NewEntryModal open={dialog?.kind === 'new'} model={model.newEntry} actions={{ ...actions, onClose: () => open(null) }} />
      <ShortcutsModal open={dialog?.kind === 'shortcuts'} onClose={() => open(null)} keys={listKeys(ownKeys).map((entry) => ({ keys: entry.keys, does: word(entry.does) }))} />
    </div>
  )
}
