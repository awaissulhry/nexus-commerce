'use client'

import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import Link from 'next/link'
import { Archive, Ban, Building2, Download, MoreHorizontal, Search, ShieldCheck, X } from 'lucide-react'
import { EmptyState, Menu, MetricStrip, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Skeleton } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { PARTY_KINDS, PARTY_TAX_MODES, type PartyKind, type PartyRow, type TaxMode } from '../api'
import {
  BULK_MAX,
  bulkReach,
  countryName,
  languageName,
  partyName,
  recordHref,
  sdiState,
  SIDES,
  TILE_VIEW,
  viesApplies,
  type ListDialog,
  type ListFilters,
  type ListView,
  type NewPartyDraft,
  type PartiesListModel,
  type TileId,
} from '../model'
import { ArchiveModal, BlockModal, BulkModal, NewPartyModal, ShortcutsModal } from './dialogs'
import { dash, Freshness, NoAccess, NoticeBanner, PageHead, PartiesMessages, RoleTags, StatusPill, ViesMark } from './parts'

export interface PartiesListActions {
  onQuery?: (query: string) => void
  onView?: (view: ListView) => void
  onFilters?: (filters: ListFilters) => void
  onClearAll?: () => void
  onMore?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onSelect?: (ids: readonly string[]) => void
  onDialog?: (dialog: ListDialog | null) => void
  /** Enter on a row: open its record. */
  onOpen?: (row: PartyRow) => void
  onLookup?: (q: string) => void
  onCreate?: (draft: NewPartyDraft) => Promise<boolean>
  /** Block these parties with one reason (one call each). */
  onBlock?: (partyIds: readonly string[], reason: string) => void
  onUnblock?: (partyId: string) => void
  onArchive?: (partyIds: readonly string[]) => void
  onReactivate?: (partyId: string) => void
  /** Check these parties with VIES, one gateway call each. */
  onCheckVies?: (partyIds: readonly string[]) => void
  /** Every EU business of this list (customers' ⋯ "Re-check every EU VAT number now"). */
  onRecheckAll?: () => void
  onExport?: (rows: readonly PartyRow[]) => void
  onDismissNotice?: () => void
}

/**
 * SCR-032 Customers and SCR-056 Suppliers (design sales.customers / purchasing.suppliers, 00 §2.1): the list of one
 * side of the party record, on the ONE list frame (src/list-frame, Owner rule 2026-10-29). The head (one sentence,
 * Updated + live state, New), the saved-filter tiles (each a named view: pressing it puts its chip in the toolbar), then
 * the frame: count, search, Rows ▾, Filters ▾, the filter chips and ⋯ — swapped for the bulk actions while rows are
 * selected (Check VIES for N, Export N, Block N, Archive N: each says its reach and is held with its reason) — the grid
 * with the header select-all box and shift-click ranges, and the footer with Show more and the keys icon. Fetches
 * nothing: the container (PartiesList.tsx) reads and writes.
 */
export function PartiesListView({ model, actions, headActions }: { model: PartiesListModel; actions?: PartiesListActions; headActions?: ReactNode }) {
  return (
    <PartiesMessages>
      <PartiesList model={model} actions={actions} headActions={headActions} />
    </PartiesMessages>
  )
}

function PartiesList({ model, actions, headActions }: { model: PartiesListModel; actions?: PartiesListActions; headActions?: ReactNode }) {
  const t = useT('parties')
  const locale = useLocale()
  const config = SIDES[model.side]
  const side = model.side
  const dialog = model.dialog ?? null
  const rows = useMemo(() => model.rows.items ?? [], [model.rows.items])
  const selectedRows = rows.filter((row) => model.selected.includes(row.id))
  const open = (next: ListDialog | null) => actions?.onDialog?.(next)
  const can = model.can
  const manageHeld = can.manage ? null : t('held.manage')
  const lists = useListWords()

  // c: New (the frame's keys are / j k x ↵ ?; its handler skips fields, menus and dialogs the same way).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.key !== 'c' || event.metaKey || event.ctrlKey || event.altKey || dialog || !can.manage) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      event.preventDefault()
      open({ kind: 'new' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ---- the row cells (built once per language and right; AG keeps them between reads) ----
  // The cells reach the page's actions through a ref: a new actions object on each render must not rebuild the columns.
  const live = useRef({ actions, open })
  live.current = { actions, open }
  const columns = useMemo<ColDef<PartyRow>[]>(() => {
    const NameCell = ({ data }: ICellRendererParams<PartyRow>) =>
      data ? (
        <span className="fw-pty-cell">
          <Link className="fw-pty-name" href={recordHref(model.prefix, config, data.id)} tabIndex={-1}>
            {partyName(data)}
          </Link>
          <span className="fw-pty-hint">
            <span className="fw-pty-code">{data.code}</span>
            {data.tradeName && data.tradeName !== data.legalName ? ` · ${data.legalName}` : ''}
          </span>
        </span>
      ) : null
    const RolesCell = ({ data }: ICellRendererParams<PartyRow>) => (data ? <RoleTags roles={data.roles} /> : null)
    const StatusCell = ({ data }: ICellRendererParams<PartyRow>) =>
      data ? (
        <span className="fw-pty-cell">
          <StatusPill status={data.status} />
          {side === 'customers' && data.invoiceBlocked && <span className="fw-pty-hint">{t('list.cannotInvoice')}</span>}
        </span>
      ) : null
    const CountryCell = ({ data }: ICellRendererParams<PartyRow>) =>
      data ? (
        <span className="fw-pty-cell">
          <span>{countryName(data.country, locale)}</span>
          {data.city && <span className="fw-pty-hint">{data.city}</span>}
        </span>
      ) : null
    const ViesCell = ({ data }: ICellRendererParams<PartyRow>) => (data ? <ViesMark standing={data.vies} onCheck={can.vies ? () => live.current.actions?.onCheckVies?.([data.id]) : undefined} /> : null)
    const SdiCell = ({ data }: ICellRendererParams<PartyRow>) => {
      if (!data) return null
      const state = sdiState(data)
      return state === null ? <span className="fw-pty-hint">{t('sdi.notNeeded')}</span> : <span>{t(state === 'set' ? 'sdi.set' : 'sdi.missing')}</span>
    }
    const VatCell = ({ data }: ICellRendererParams<PartyRow>) =>
      data ? (
        <span className="fw-pty-cell">
          <span className="fw-pty-code">{dash(data.vatNumber ?? data.fiscalCode)}</span>
          {viesApplies(data) && <ViesMark standing={data.vies} onCheck={can.vies ? () => live.current.actions?.onCheckVies?.([data.id]) : undefined} />}
        </span>
      ) : null
    const ActionsCell = ({ data }: ICellRendererParams<PartyRow>) =>
      data ? <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('row.menu', { name: partyName(data) }) }} items={rowItems(data)} /> : null
    const rowItems = (row: PartyRow): MenuItemDef[] => {
      const href = recordHref(model.prefix, config, row.id)
      const items: MenuItemDef[] = [
        { id: 'open', label: t('row.open'), href },
        { id: 'tab', label: t('row.openNewTab'), href, target: '_blank' },
      ]
      if (viesApplies(row) && row.status !== 'ARCHIVED')
        items.push({ id: 'vies', label: t('row.checkVies'), onSelect: () => live.current.actions?.onCheckVies?.([row.id]), disabled: !can.vies, description: can.vies ? undefined : t('held.vies') })
      if (row.status === 'ACTIVE')
        items.push({
          id: 'block',
          label: t('row.block'),
          onSelect: () => live.current.open({ kind: 'block', partyIds: [row.id] }),
          disabled: !can.block,
          description: can.block ? undefined : t('held.block'),
        })
      if (row.status === 'BLOCKED')
        items.push({ id: 'unblock', label: t('row.unblock'), onSelect: () => live.current.actions?.onUnblock?.(row.id), disabled: !can.block, description: can.block ? undefined : t('held.block') })
      if (row.status === 'ACTIVE' || row.status === 'PROSPECT')
        items.push({ id: 'archive', label: t('row.archive'), onSelect: () => live.current.open({ kind: 'archive', partyIds: [row.id] }), disabled: !can.manage, description: manageHeld ?? undefined })
      if (row.status === 'BLOCKED') items.push({ id: 'archive-held', label: t('row.archive'), disabled: true, description: t('held.archiveBlocked') })
      if (row.status === 'ARCHIVED')
        items.push({ id: 'reactivate', label: t('row.reactivate'), onSelect: () => live.current.actions?.onReactivate?.(row.id), disabled: !can.manage, description: manageHeld ?? undefined })
      return items
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<PartyRow>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number }): ColDef<PartyRow> => ({
      colId,
      headerName: header,
      cellRenderer,
      sortable: false,
      ...size,
    })
    const name = column('name', t('list.col.name'), NameCell, { flex: 2.2, minWidth: 220 })
    const actionsColumn = { ...column('actions', t('list.col.actions'), ActionsCell, { width: 92, minWidth: 92 }), suppressHeaderMenuButton: true }
    if (side === 'customers')
      return [
        name,
        column('roles', t('list.col.roles'), RolesCell, { flex: 1.2, minWidth: 140 }),
        column('status', t('list.col.status'), StatusCell, { flex: 1.1, minWidth: 120 }),
        column('country', t('list.col.country'), CountryCell, { flex: 1, minWidth: 110 }),
        {
          colId: 'taxMode',
          headerName: t('list.col.taxMode'),
          sortable: false,
          flex: 1.1,
          minWidth: 120,
          valueGetter: (params) => (params.data?.taxMode ? t(`taxMode.${params.data.taxMode}`) : t('list.noIdentity')),
        },
        column('vies', t('list.col.vies'), ViesCell, { flex: 1.4, minWidth: 170 }),
        column('sdi', t('list.col.sdi'), SdiCell, { flex: 1, minWidth: 140 }),
        { colId: 'language', headerName: t('list.col.language'), sortable: false, flex: 0.8, minWidth: 100, valueGetter: (params) => (params.data ? languageName(params.data.language, locale) : '') },
        actionsColumn,
      ]
    return [
      name,
      column('roles', t('list.col.roles'), RolesCell, { flex: 1.3, minWidth: 160 }),
      column('status', t('list.col.status'), StatusCell, { flex: 1, minWidth: 130 }),
      column('vat', t('list.col.vat'), VatCell, { flex: 1.6, minWidth: 210 }),
      column('country', t('list.col.country'), CountryCell, { flex: 1, minWidth: 130 }),
      { colId: 'language', headerName: t('list.col.language'), sortable: false, flex: 0.8, minWidth: 110, valueGetter: (params) => (params.data ? languageName(params.data.language, locale) : '') },
      actionsColumn,
    ]
    // The cells close over the words, the rights and the actions: a change of language or rights rebuilds them.
  }, [t, locale, side, config, model.prefix, can.vies, can.block, can.manage, manageHeld])

  if (!can.view) return <NoAccess title={t(`${side}.noAccess.title`)} body={t(`${side}.noAccess.body`)} />

  const filterCount = (model.filters.kind ? 1 : 0) + (model.filters.taxMode ? 1 : 0)
  const filtered = model.view !== 'open' || filterCount > 0 || model.query.trim() !== ''

  // ---- the tiles ----
  const tile = (id: TileId) => {
    const count = model.tiles[id]
    const active = model.view === TILE_VIEW[id]
    return {
      label: t(`tile.${side}.${id}`),
      value: count === undefined ? <Skeleton width={36} height={22} /> : count === null ? '—' : String(count),
      hint: count === null ? t('tile.unknown') : t(`tile.${side}.${id}Hint`),
      active,
      onClick: () => actions?.onView?.(active ? 'open' : TILE_VIEW[id]),
    }
  }

  // ---- the toolbar's menus and chips ----
  const viewItems: MenuItemDef[] = [
    { id: 'heading', heading: true, label: t('list.rowsHeading') },
    ...config.views.map((view) => ({ id: view, label: t(`view.${view}`), checked: model.view === view, onSelect: () => actions?.onView?.(view) })),
  ]
  const filterItems: MenuItemDef[] = [
    { id: 'kind', heading: true, label: t('field.kind') },
    ...PARTY_KINDS.map((kind) => ({
      id: `kind-${kind}`,
      label: t(`kind.${kind}`),
      checked: model.filters.kind === kind,
      onSelect: () => actions?.onFilters?.({ ...model.filters, kind: model.filters.kind === kind ? null : (kind as PartyKind) }),
    })),
    { id: 'sep', separator: true },
    { id: 'mode', heading: true, label: t('field.taxMode') },
    ...PARTY_TAX_MODES.map((mode) => ({
      id: `mode-${mode}`,
      label: t(`taxMode.${mode}`),
      checked: model.filters.taxMode === mode,
      onSelect: () => actions?.onFilters?.({ ...model.filters, taxMode: model.filters.taxMode === mode ? null : (mode as TaxMode) }),
    })),
  ]
  const moreItems: MenuItemDef[] = [
    {
      id: 'export',
      label: t('list.exportView'),
      onSelect: () => actions?.onExport?.(rows),
      disabled: rows.length === 0,
      description: rows.length === 0 ? t('list.exportNothing') : t('list.exportViewHint', { count: rows.length }),
    },
    ...(side === 'customers'
      ? [
          {
            id: 'recheck',
            label: t('list.recheckAll'),
            onSelect: () => actions?.onRecheckAll?.(),
            disabled: !can.vies,
            description: can.vies ? t('list.recheckAllHint', { max: BULK_MAX }) : t('held.vies'),
          },
        ]
      : []),
    { id: 'sep', separator: true },
    { id: 'keys', label: t('keys.title'), onSelect: () => open({ kind: 'shortcuts' }) },
  ]
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
        <span className="fw-pty-chips" aria-label={t('list.activeFilters')}>
          {model.view !== 'open' && chip('view', t(`view.${model.view}`), () => actions?.onView?.('open'))}
          {model.filters.kind && chip('kind', t(`kind.${model.filters.kind}`), () => actions?.onFilters?.({ ...model.filters, kind: null }))}
          {model.filters.taxMode && chip('mode', t(`taxMode.${model.filters.taxMode}`), () => actions?.onFilters?.({ ...model.filters, taxMode: null }))}
          {model.query.trim() !== '' && chip('q', `“${model.query.trim()}”`, () => actions?.onQuery?.(''))}
          <Button size="sm" variant="quiet" onClick={() => actions?.onClearAll?.()}>
            {t('list.clearAll')}
          </Button>
        </span>
      )}
    </>
  )

  // ---- the bulk actions: each says its reach and is held with its reason before the click ----
  const viesReach = bulkReach('vies', selectedRows)
  const blockReach = bulkReach('block', selectedRows)
  const archiveReach = bulkReach('archive', selectedRows)
  const viesHeld = !can.vies ? t('held.vies') : viesReach.reach.length === 0 ? t('held.noEuNumber') : viesReach.reach.length > BULK_MAX ? t('held.bulkMax', { max: BULK_MAX }) : null
  const blockHeld = !can.block ? t('held.block') : blockReach.reach.length === 0 ? t('held.nothingToBlock') : blockReach.reach.length > BULK_MAX ? t('held.bulkMax', { max: BULK_MAX }) : null
  const archiveHeld = manageHeld ?? (archiveReach.reach.length === 0 ? t('held.nothingToArchive') : null)
  const bulk = (label: string, icon: ReactNode, onClick: () => void, held: string | null, variant?: 'danger-outline') => (
    <Button size="sm" variant={variant} onClick={onClick} heldReason={held} aria-label={label}>
      {icon} <SelectionLabel>{label}</SelectionLabel>
    </Button>
  )
  const bulkActions = (
    <>
      {bulk(t('list.bulkVies', { count: viesReach.reach.length }), <ShieldCheck size={13} aria-hidden />, () => actions?.onCheckVies?.(viesReach.reach.map((row) => row.id)), viesHeld)}
      {bulk(t('list.bulkExport', { count: selectedRows.length }), <Download size={13} aria-hidden />, () => actions?.onExport?.(selectedRows), null)}
      {bulk(t('list.bulkBlock', { count: blockReach.reach.length }), <Ban size={13} aria-hidden />, () => open({ kind: 'block', partyIds: blockReach.reach.map((row) => row.id) }), blockHeld)}
      {bulk(
        t('list.bulkArchive', { count: archiveReach.reach.length }),
        <Archive size={13} aria-hidden />,
        () => open({ kind: 'archive', partyIds: archiveReach.reach.map((row) => row.id) }),
        archiveHeld,
        'danger-outline',
      )}
    </>
  )

  // ---- states in place of the grid (the toolbar stays) ----
  const state = model.rows.problem ? (
    <EmptyState
      title={t(`${side}.failedTitle`)}
      description={t(model.rows.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : model.rows.items !== null && rows.length === 0 ? (
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
        icon={<Building2 size={24} aria-hidden />}
        title={t(`${side}.empty.title`)}
        description={t(`${side}.empty.body`)}
        action={
          <Button variant="primary" onClick={() => open({ kind: 'new' })} heldReason={manageHeld}>
            {t(`${side}.new.action`)}
          </Button>
        }
      />
    )
  ) : undefined

  const ownKeys: ListKey[] = [{ keys: ['c'], does: t(`${side}.keys.new`) }]
  const blockRows = dialog?.kind === 'block' ? rows.filter((row) => dialog.partyIds.includes(row.id)) : []
  const archiveRows = dialog?.kind === 'archive' ? rows.filter((row) => dialog.partyIds.includes(row.id)) : []

  return (
    <div className="fw-pty">
      <PageHead
        intro={t(`${side}.intro`)}
        status={<Freshness asOf={model.asOf} live={model.live} />}
        actions={
          <>
            {/* A side's own band actions (Customers: Import, B-W2a-49), before New. */}
            {headActions}
            <Button size="sm" variant="primary" onClick={() => open({ kind: 'new' })} heldReason={manageHeld}>
              {t(`${side}.new.action`)}
            </Button>
          </>
        }
      />
      <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
      <MetricStrip metrics={config.tiles.map(tile)} />

      <ListFrame<PartyRow>
        label={t(`${side}.table`)}
        rows={model.rows.problem ? [] : model.rows.items}
        rowId={(row) => row.id}
        columns={columns}
        count={model.total === null ? t('list.countShown', { shown: rows.length }) : t('list.count', { shown: rows.length, total: model.total })}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={14} aria-hidden />}
            aria-label={t(`${side}.search`)}
            placeholder={t(`${side}.search`)}
            value={model.query}
            onChange={(event) => actions?.onQuery?.(event.target.value)}
          />
        }
        tools={tools}
        right={<Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('list.more') }} items={moreItems} />}
        selection={{ selected: model.selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulkActions }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={
          model.more
            ? {
                label: t('list.showMore', { count: Math.min(50, Math.max(0, (model.total ?? rows.length + 50) - rows.length)) }),
                onMore: () => actions?.onMore?.(),
                held: model.loadingMore ? t('list.loading') : null,
              }
            : null
        }
        keys={ownKeys}
        onHelp={() => open({ kind: 'shortcuts' })}
        onOpen={(row) => actions?.onOpen?.(row)}
        state={state}
        focusRow={model.focusRow}
      />

      <NewPartyModal
        side={side}
        prefix={model.prefix}
        open={dialog?.kind === 'new'}
        busy={model.busy}
        problem={model.dialogProblem}
        refused={model.refused}
        duplicates={model.duplicates}
        canVies={can.vies}
        initial={model.newDraft}
        companies={model.companies}
        actions={{ onLookup: actions?.onLookup, onCreate: actions?.onCreate, onClose: () => open(null) }}
      />
      <BlockModal
        side={side}
        open={dialog?.kind === 'block'}
        names={blockRows.map(partyName)}
        busy={model.busy}
        problem={model.dialogProblem}
        onBlock={(reason) =>
          actions?.onBlock?.(
            blockRows.map((row) => row.id),
            reason,
          )
        }
        onClose={() => open(null)}
      />
      <ArchiveModal
        side={side}
        open={dialog?.kind === 'archive'}
        names={archiveRows.map(partyName)}
        skipped={dialog?.kind === 'archive' && archiveRows.length > 1 ? archiveReach.skipped.length : 0}
        busy={model.busy}
        problem={model.dialogProblem}
        onArchive={() => actions?.onArchive?.(archiveRows.map((row) => row.id))}
        onClose={() => open(null)}
      />
      <BulkModal run={model.bulk} open={dialog?.kind === 'bulk'} onClose={() => open(null)} />
      <ShortcutsModal open={dialog?.kind === 'shortcuts'} onClose={() => open(null)} keys={listKeys(ownKeys).map((entry) => ({ keys: entry.keys, does: lists(entry.does) }))} />
    </div>
  )
}

/** A key's words: a `lists` message key (the frame's keys), else the list's own words. */
function useListWords() {
  const t = useT('lists')
  return (does: string) => {
    const text = t(does)
    return text === does ? does : text
  }
}
