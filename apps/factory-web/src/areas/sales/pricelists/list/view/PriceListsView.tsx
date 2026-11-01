'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Archive, Download, MoreHorizontal, Plus, Search, X } from 'lucide-react'
import { Banner, EmptyState, Menu, MetricStrip, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { formatTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { PRICE_LIST_KINDS, type PriceListRow } from '../../api'
import { activeFilterCount, archiveReach, filtersOfTile, LIST_ROWS, LIST_TILES, NO_FILTERS, rowsShown, tileOf, tileValue } from '../../model'
import { Freshness, KeysModal, KindTag, NoListsAccess, PriceListsMessages, say, StatePill, useValidity, useWords } from '../../parts'
import type { PriceListsActions, PriceListsViewModel } from '../list-model'
import { NewPriceListDialog } from './NewPriceListDialog'

export type { PriceListsActions, PriceListsViewModel } from '../list-model'

/**
 * SCR-106 — Price lists & contracts (Sales › Pricing; design sales.pricelists, 00 §2.1 list frame): the head (one
 * sentence, Updated + live state, New price list), ONE notice at a time, the saved-filter tiles (Active, Starting in 30
 * days, Expiring in 30 days: each a named filter whose chip lands in the toolbar), then the ONE list frame — count,
 * search, Rows ▾, Kind ▾, the chips, ⋯ — swapped for the bulk actions while lists are selected (Export N, Archive N held
 * with its reason), the grid with the header select-all and shift ranges, and the footer with the keys icon. Prices are
 * not in this list (no amount column); a list's prices are its record's. Import prices is W2b. It fetches nothing.
 */
export function PriceListsView({ model, actions }: { model: PriceListsViewModel; actions?: PriceListsActions }) {
  return (
    <PriceListsMessages>
      <PriceLists model={model} actions={actions} />
    </PriceListsMessages>
  )
}

function PriceLists({ model, actions }: { model: PriceListsViewModel; actions?: PriceListsActions }) {
  const t = useWords()
  const locale = useLocale()
  const validity = useValidity()
  const [query, setQuery] = useState(model.filters.q)
  useEffect(() => setQuery(model.filters.q), [model.filters.q])
  const typed = useRef(false)
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current.actions?.onFilters?.({ ...latest.current.model.filters, q: query }), 300)
    return () => clearTimeout(timer)
  }, [query])

  // c: New price list (the frame's keys are / j k x ↵ ?; never while typing or inside a dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.key !== 'c' || event.metaKey || event.ctrlKey || event.altKey || model.newList || model.dialog || !model.can.manage) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      event.preventDefault()
      actions?.onNew?.(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const shown = useMemo(() => rowsShown(model.rows.items, model.filters), [model.rows.items, model.filters])
  const rows = shown ?? []
  const picked = rows.filter((row) => model.selected.includes(row.id))
  const filtered = activeFilterCount(model.filters) > 0
  const pressed = tileOf(model.filters)
  const manageHeld = model.can.manage ? null : t('held.noManage')
  const recordHref = useCallback((row: PriceListRow) => `${model.prefix}/sales/price-lists/${encodeURIComponent(row.id)}`, [model.prefix])
  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('keys.new') }]

  const columns = useMemo<ColDef<PriceListRow>[]>(() => {
    const NameCell = ({ data }: ICellRendererParams<PriceListRow>) =>
      data ? (
        <span className="fw-pl-cell">
          <Link className="fw-pl-link" href={recordHref(data)} tabIndex={-1}>
            {data.name}
          </Link>
          <span className="fw-pl-sub">
            {data.code}
            {data.baseList ? ` · ${t('list.fallsBack', { code: data.baseList.code })}` : ''}
          </span>
        </span>
      ) : null
    const KindCell = ({ data }: ICellRendererParams<PriceListRow>) => (data ? <KindTag kind={data.kind} /> : null)
    const StateCell = ({ data }: ICellRendererParams<PriceListRow>) => (data ? <StatePill state={data.state} /> : null)
    const VersionCell = ({ data }: ICellRendererParams<PriceListRow>) =>
      data ? (
        <span className="fw-pl-inline">
          {data.shownVersion ? t('list.versionShown', { revision: data.shownVersion.revision }) : '—'}
          {data.draftVersionId && data.shownVersion?.status !== 'DRAFT' ? <Tag tone="neutral">{t('list.draftWaiting')}</Tag> : null}
        </span>
      ) : null
    const MoreCell = ({ data }: ICellRendererParams<PriceListRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { name: data.name }) }}
          items={[
            { id: 'open', label: t('list.open'), href: recordHref(data) },
            { id: 'tab', label: t('list.openNewTab'), href: recordHref(data), target: '_blank' },
            { id: 'versions', label: t('list.openVersions'), href: `${recordHref(data)}?tab=versions` },
            { id: 'export', label: t('list.exportOne'), onSelect: () => latest.current.actions?.onExport?.([data.id]) },
          ]}
        />
      ) : null
    return [
      { colId: 'name', headerName: t('list.col.name'), field: 'name', minWidth: 220, flex: 2, cellRenderer: NameCell },
      { colId: 'kind', headerName: t('list.col.kind'), field: 'kind', minWidth: 120, flex: 1, cellRenderer: KindCell },
      { colId: 'customers', headerName: t('list.col.customers'), field: 'customers', minWidth: 110, flex: 1, type: 'rightAligned' },
      { colId: 'currency', headerName: t('list.col.currency'), field: 'currency', minWidth: 110, flex: 0.6 },
      {
        colId: 'validity',
        headerName: t('list.col.validity'),
        minWidth: 200,
        flex: 1.5,
        valueGetter: (params) => (params.data?.shownVersion ? validity(params.data.shownVersion.validFrom, params.data.shownVersion.validTo) : '—'),
      },
      { colId: 'styles', headerName: t('list.col.styles'), field: 'stylesPriced', minWidth: 150, flex: 1, type: 'rightAligned' },
      { colId: 'version', headerName: t('list.col.version'), minWidth: 150, flex: 1, cellRenderer: VersionCell },
      { colId: 'state', headerName: t('list.col.state'), field: 'state', minWidth: 130, flex: 1, cellRenderer: StateCell },
      { colId: 'more', headerName: t('list.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
    // The cells read the words and the language through the closure: a change rebuilds them.
  }, [t, locale, recordHref, validity])

  const rowsItems: MenuItemDef[] = [
    { id: 'heading', heading: true, label: t('list.rowsHeading') },
    ...LIST_ROWS.map((rows) => ({ id: rows, label: t(`rows.${rows}`), checked: model.filters.rows === rows && !model.filters.soon, onSelect: () => actions?.onFilters?.({ ...model.filters, rows, soon: null }) })),
  ]
  const kindItems: MenuItemDef[] = [
    { id: 'heading', heading: true, label: t('list.col.kind') },
    ...PRICE_LIST_KINDS.map((kind) => ({ id: kind, label: t(`kind.${kind}`), checked: model.filters.kind === kind, onSelect: () => actions?.onFilters?.({ ...model.filters, kind: model.filters.kind === kind ? null : kind }) })),
  ]
  const chip = (key: string, label: string, onRemove: () => void) => (
    <FilterChip key={key} pressed onClick={onRemove} aria-label={t('list.removeFilter', { name: label })}>
      {label} <X size={12} aria-hidden />
    </FilterChip>
  )
  const tools = (
    <>
      <Menu label={t('list.rows', { rows: t(model.filters.soon ? `tile.${model.filters.soon}` : `rows.${model.filters.rows}`) })} items={rowsItems} />
      <Menu label={model.filters.kind ? t('list.kindIs', { kind: t(`kind.${model.filters.kind}`) }) : t('list.kindAll')} items={kindItems} />
      {filtered && (
        <span className="fw-pl-chips" aria-label={t('list.activeFilters')}>
          {model.filters.rows !== 'all' && chip('rows', t(`rows.${model.filters.rows}`), () => actions?.onFilters?.({ ...model.filters, rows: 'all' }))}
          {model.filters.soon && chip('soon', t(`tile.${model.filters.soon}`), () => actions?.onFilters?.({ ...model.filters, soon: null }))}
          {model.filters.kind && chip('kind', t(`kind.${model.filters.kind}`), () => actions?.onFilters?.({ ...model.filters, kind: null }))}
          {model.filters.q.trim() && chip('q', `“${model.filters.q.trim()}”`, () => actions?.onFilters?.({ ...model.filters, q: '' }))}
          <Button size="sm" variant="quiet" onClick={() => actions?.onFilters?.(NO_FILTERS)}>
            {t('list.clearAll')}
          </Button>
        </span>
      )}
    </>
  )

  const reach = archiveReach(picked)
  const archiveHeld = manageHeld ?? (reach.reach.length === 0 ? t('held.nothingToArchive') : model.busy ? t('held.busy') : null)
  const bulkActions = (
    <>
      <Button size="sm" aria-label={t('list.bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
        <Download size={13} aria-hidden /> <SelectionLabel>{t('list.bulk.export', { count: picked.length })}</SelectionLabel>
      </Button>
      <Button size="sm" variant="danger-outline" aria-label={t('list.bulk.archive', { count: reach.reach.length })} heldReason={archiveHeld} onClick={() => actions?.onDialog?.('archive')}>
        <Archive size={13} aria-hidden /> <SelectionLabel>{t('list.bulk.archive', { count: reach.reach.length })}</SelectionLabel>
      </Button>
    </>
  )

  if (!model.can.view) {
    return (
      <div className="fw-pl">
        <NoListsAccess />
      </div>
    )
  }

  const state = model.rows.problem ? (
    <EmptyState
      title={t('list.failed')}
      description={t(model.rows.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : shown && shown.length === 0 ? (
    filtered ? (
      <EmptyState
        title={t('list.noMatch')}
        action={
          <Button size="sm" onClick={() => actions?.onFilters?.(NO_FILTERS)}>
            {t('list.clearAll')}
          </Button>
        }
      />
    ) : (
      <EmptyState
        title={t('list.empty.title')}
        description={t(model.can.manage ? 'list.empty.body' : 'list.empty.bodyView')}
        action={
          <Button size="sm" variant="primary" heldReason={manageHeld} onClick={() => actions?.onNew?.(true)}>
            {t('list.new')}
          </Button>
        }
      />
    )
  ) : undefined

  return (
    <div className="fw-pl">
      <div className="fw-pl-head">
        <div className="fw-pl-head-text">
          <p className="fw-pl-hint">{t('list.intro')}</p>
          <Freshness asOf={model.asOf} live={model.live} time={(iso) => formatTime(iso, { locale })} />
        </div>
        <Button size="sm" variant="primary" heldReason={manageHeld} onClick={() => actions?.onNew?.(true)} aria-keyshortcuts="c">
          <Plus size={14} aria-hidden /> {t('list.new')}
        </Button>
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={say(t, model.notice.words) ?? ''}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('common.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}

      <MetricStrip
        metrics={LIST_TILES.map((tile) => ({
          label: t(`tile.${tile}`),
          value: tileValue(model.tiles, tile),
          hint: model.tiles === null && model.rows.problem ? t('list.tileUnknown') : undefined,
          onClick: () => actions?.onFilters?.(filtersOfTile(tile, model.filters)),
          active: pressed === tile,
        }))}
      />

      <ListFrame<PriceListRow>
        label={t('list.table')}
        rows={state ? [] : shown}
        rowId={(row) => row.id}
        columns={columns}
        count={shown ? t('list.count', { count: shown.length }) : '—'}
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
        tools={tools}
        right={
          <Menu
            align="right"
            label={<MoreHorizontal size={16} aria-hidden />}
            triggerProps={{ 'aria-label': t('list.more') }}
            items={[
              { id: 'export', label: t('list.exportView'), disabled: rows.length === 0, description: rows.length === 0 ? t('list.exportNothing') : undefined, onSelect: () => actions?.onExport?.(rows.map((row) => row.id)) },
              { id: 'sep', separator: true },
              { id: 'keys', label: t('keys.title'), onSelect: () => actions?.onDialog?.('help') },
            ]}
          />
        }
        selection={{ selected: model.selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulkActions }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        keys={ownKeys}
        onHelp={() => actions?.onDialog?.('help')}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
        focusRow={model.focusRow}
      />

      {model.newList && <NewPriceListDialog model={model.newList} actions={actions} />}
      {model.dialog === 'archive' && (
        <Modal
          open
          onClose={() => actions?.onDialog?.(null)}
          title={t('archive.titleMany', { count: reach.reach.length })}
          size="md"
          footer={
            <>
              <Button onClick={() => actions?.onDialog?.(null)}>{t('common.back')}</Button>
              <Button variant="danger" heldReason={archiveHeld} onClick={() => actions?.onArchive?.(reach.reach.map((row) => row.id))}>
                {t('list.bulk.archive', { count: reach.reach.length })}
              </Button>
            </>
          }
        >
          <div className="fw-pl-dialog">
            <p className="fw-pl-hint">{t('archive.body')}</p>
            <ul className="fw-pl-list">
              {reach.reach.map((row) => (
                <li key={row.id}>
                  {row.code} · {row.name}
                </li>
              ))}
            </ul>
            {reach.skipped.length > 0 && <Banner tone="info" title={t('archive.skipped', { count: reach.skipped.length })} />}
          </div>
        </Modal>
      )}
      {model.dialog === 'help' && <KeysModal own={ownKeys} onClose={() => actions?.onDialog?.(null)} />}
    </div>
  )
}
