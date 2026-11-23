'use client'

import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import Link from 'next/link'
import { Archive, Ban, Building2, ChevronDown, MoreHorizontal, Search, ShieldCheck, X } from 'lucide-react'
import { EmptyState, Menu, MetricStrip, type MenuItemDef, type Metric } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Skeleton } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { useListSearch } from '../../../../list-frame/search/use-list-search' // F-SA-223
import type { ListKey } from '../../../../list-frame/model'
import type { ListCards } from '../../../../list-frame/w2b/model' // F-CL-101: a side's phone card
import { PARTY_KINDS, PARTY_TAX_MODES, type PartyKind, type PartyRow, type PartySort, type PartyWorkGroup, type TaxMode } from '../api'
import { barOf, sharedActsOf, whyNotOf, type BarAct, type SharedActId } from '../bar' // F-CL-103
import {
  BULK_MAX,
  countryName,
  emptyWordsOf, // F-CL-101
  languageName,
  partyName,
  recordHref,
  rowActsOf, // F-CL-101
  sdiState,
  SIDES,
  TILE_VIEW,
  viesApplies,
  viewsOf, // F-CL-101
  type ListDialog,
  type ListFilters,
  type ListView,
  type NewPartyDraft,
  type PartiesListModel,
  type RowAct, // F-CL-101
  type TileId,
} from '../model'
import { ArchiveModal, BlockModal, BulkModal, NewPartyModal, type NotOnLine } from './dialogs'
import { dash, Freshness, NoAccess, NoticeBanner, PageHead, PartiesMessages, RoleTags, StatusPill, ViesMark } from './parts'

export interface PartiesListActions {
  onQuery?: (query: string) => void
  onView?: (view: ListView) => void
  /** F-CL-203: another order from Sort ▾ (a side with `sort`). */
  onSort?: (sort: PartySort) => void
  /** F-CL-202: the band's door pressed or left (its chip's ✕). */
  onWork?: (group: PartyWorkGroup | null) => void
  onFilters?: (filters: ListFilters) => void
  onMore?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onSelect?: (ids: readonly string[]) => void
  onDialog?: (dialog: ListDialog | null) => void
  /** Enter on a row: open its record. */
  onOpen?: (row: PartyRow) => void
  onLookup?: (draft: NewPartyDraft) => void
  onCreate?: (draft: NewPartyDraft) => Promise<boolean>
  /** Block these parties with one reason (one call each). */
  onBlock?: (partyIds: readonly string[], reason: string) => void
  onUnblock?: (partyId: string) => void
  onArchive?: (partyIds: readonly string[]) => void
  onReactivate?: (partyId: string) => void
  /** Check these parties with VIES, one gateway call each (F-CL-103: from the bar, with the selected ones it leaves out). */
  onCheckVies?: (partyIds: readonly string[], notOn?: readonly string[]) => void
  /** F-CL-103: run the failed ones of the last bulk run again (its receipt's "Run the rest again"). */
  onRunRest?: (partyIds: readonly string[]) => void
  /** Every EU business of this list (customers' ⋯ "Re-check every EU VAT number now"). */
  onRecheckAll?: () => void
  onDismissNotice?: () => void
}

/**
 * SCR-032 Customers and SCR-056 Suppliers (design sales.customers / purchasing.suppliers, 00 §2.1): the list of one
 * side of the party record, on the ONE list frame (src/list-frame, Owner rule 2026-10-29). The head (one sentence,
 * Updated, New), the saved-filter tiles (Suppliers; each a named view), then the frame: count, search, Views ▾ (the side's
 * views, its saved views, Customise), Filters ▾, the filter chips and ⋯ — swapped for the bulk actions while rows are
 * selected — the grid with the header select-all box and shift-click ranges, and the footer with Show more and the keys
 * icon. Fetches nothing: the container (PartiesList.tsx) reads and writes. F-CL-101 (customers list plan §2, K12): an act
 * the reader has no right for is not drawn; one Views ▾; the keys only in the footer's icon; an empty view says its own words.
 */
/**
 * B-W2b-334: a side's own list parts (Suppliers, areas/purchasing/suppliers/list): tiles after the side's own, a view of
 * its own drawn in place of the grid while it is on (its own list frame), bulk actions after Export N.
 */
export interface ListDepth {
  readonly tiles?: readonly Metric[]
  readonly body?: ReactNode
  /**
   * F-CL-103 (13-backend §8.2): the side's own acts on a selection, each with its place (Customers: Add task 10, Set supervisor 20;
   * Suppliers: Request documents 20) — merged with the shared VIES · Block · Archive into the bar "3 + More ▾". An act the reader
   * has no right for is left out by the side (hidden), never held.
   */
  readonly acts?: readonly BarAct[]
  // ---- F-CL-101 (customers list plan §1, 13-backend §8.1, settles T22 / T28): a side's own parts, each optional — a side that
  // passes none (Suppliers) draws exactly as before.
  /** Drawn in the head row's left part in place of the sentence (the customers' band, W2). */
  readonly band?: ReactNode
  /** The side's own first column in place of the shared Name column (same id `name`: the Customer cell). */
  readonly nameColumn?: ColDef<PartyRow>
  /** Columns right after the name, before the identity columns (New messages; W2: the work columns). */
  readonly leadingColumns?: readonly ColDef<PartyRow>[]
  /** Column ids hidden at first: still in Customise (a layout shows them) and in the full file. */
  readonly hiddenColumns?: readonly string[]
  /** Items of a row's ⋯ after "Open in new tab" (doors of the side), before the identity acts. */
  readonly rowItems?: (row: PartyRow) => readonly MenuItemDef[]
  /** The phone card's places and drawings per column (the frame's card overrides). */
  readonly card?: ListCards<PartyRow>['fields']
  // ---- end F-CL-101
}

export function PartiesListView({ model, actions, headActions, columns: sideColumns, depth }: { model: PartiesListModel; actions?: PartiesListActions; headActions?: ReactNode; columns?: readonly ColDef<PartyRow>[]; depth?: ListDepth | undefined }) {
  return (
    <PartiesMessages>
      <PartiesList model={model} actions={actions} headActions={headActions} sideColumns={sideColumns} depth={depth} />
    </PartiesMessages>
  )
}

function PartiesList({ model, actions, headActions, sideColumns, depth }: { model: PartiesListModel; actions?: PartiesListActions; headActions?: ReactNode; sideColumns?: readonly ColDef<PartyRow>[]; depth?: ListDepth | undefined }) {
  const t = useT('parties')
  // F-CL-101: a side's own columns and row items (the host keeps each the same object between renders: the columns rebuild only on a change).
  const sideName = depth?.nameColumn
  const sideLeading = depth?.leadingColumns
  const sideHidden = depth?.hiddenColumns
  const sideRowItems = depth?.rowItems
  const locale = useLocale()
  const config = SIDES[model.side]
  const side = model.side
  const dialog = model.dialog ?? null
  const rows = useMemo(() => model.rows.items ?? [], [model.rows.items])
  const selectedRows = rows.filter((row) => model.selected.includes(row.id))
  const open = (next: ListDialog | null) => actions?.onDialog?.(next)
  const can = model.can
  const c = useT('customers-list') // F-CL-101: the list's new words (settle T11)
  // F-SA-223: the one search rule of every list (300 ms after the last key, Enter at once, Esc clears, 100 at most, follows the list).
  const search = useListSearch(model.query, (q) => actions?.onQuery?.(q))

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
      data ? <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ className: 'nds-btn sm icon', 'aria-label': t('row.menu', { name: partyName(data) }) }} items={rowItems(data)} /> : null
    // F-CL-101 (K12, settle T15): an act the reader has no right for is not drawn (each act reads its OWN right); held only by state.
    const rowItems = (row: PartyRow): MenuItemDef[] => {
      const href = recordHref(model.prefix, config, row.id)
      const items: MenuItemDef[] = [
        { id: 'open', label: t('row.open'), href },
        { id: 'tab', label: t('row.openNewTab'), href, target: '_blank' },
        ...(sideRowItems?.(row) ?? []),
      ]
      const item: Record<RowAct, MenuItemDef> = {
        vies: { id: 'vies', label: t('row.checkVies'), onSelect: () => live.current.actions?.onCheckVies?.([row.id]) },
        block: { id: 'block', label: t('row.block'), onSelect: () => live.current.open({ kind: 'block', partyIds: [row.id] }) },
        unblock: { id: 'unblock', label: t('row.unblock'), onSelect: () => live.current.actions?.onUnblock?.(row.id) },
        archive: { id: 'archive', label: t('row.archive'), onSelect: () => live.current.open({ kind: 'archive', partyIds: [row.id] }) },
        'archive-held': { id: 'archive-held', label: t('row.archive'), disabled: true, description: t('held.archiveBlocked') },
        reactivate: { id: 'reactivate', label: t('row.reactivate'), onSelect: () => live.current.actions?.onReactivate?.(row.id) },
      }
      const acts = rowActsOf(row, can).map((act) => item[act])
      return acts.length > 0 && items.length > 2 ? [...items, { id: 'sep-acts', separator: true }, ...acts] : [...items, ...acts]
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<PartyRow>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number }): ColDef<PartyRow> => ({
      colId,
      headerName: header,
      cellRenderer,
      sortable: false,
      ...size,
    })
    const name = sideName ?? column('name', t('list.col.name'), NameCell, { flex: 2.2, minWidth: 220 })
    // F-CL-102 (C1-B9, 10-design §3): the row's ⋯ is a narrow column without a visible header (its name in Customise and on hover),
    // pinned right — so the phone card takes it as its actions, never as a labelled line, and the file never writes it.
    const actionsColumn: ColDef<PartyRow> = {
      colId: 'actions',
      headerName: '',
      headerTooltip: t('list.col.actions'),
      cellRenderer: ActionsCell,
      sortable: false,
      width: 52,
      minWidth: 52,
      maxWidth: 52,
      pinned: 'right',
      suppressHeaderMenuButton: true,
      suppressMovable: true,
      context: { toolLabel: t('list.col.actions') },
    }
    // F-CL-101 (settle T28): a column hidden at first is an opt-in column — Customise shows it again, a saved view keeps it.
    const hidden = new Set(sideHidden ?? [])
    const later = (columns: ColDef<PartyRow>[]): ColDef<PartyRow>[] =>
      columns.map((entry) => (entry.colId && hidden.has(entry.colId) ? { ...entry, hide: true, context: { ...((entry.context as object | undefined) ?? {}), optIn: true } } : entry))
    if (side === 'customers')
      return later([
        name,
        ...(sideLeading ?? []), // F-CL-101
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
        // B-W2a-81: the side's own columns (Customers: Overdue, by the price grain), before Language as the design orders them.
        ...(sideColumns ?? []),
        { colId: 'language', headerName: t('list.col.language'), sortable: false, flex: 0.8, minWidth: 100, valueGetter: (params) => (params.data ? languageName(params.data.language, locale) : '') },
        actionsColumn,
      ])
    return later([
      name,
      ...(sideLeading ?? []), // F-CL-101
      column('roles', t('list.col.roles'), RolesCell, { flex: 1.3, minWidth: 160 }),
      column('status', t('list.col.status'), StatusCell, { flex: 1, minWidth: 130 }),
      column('vat', t('list.col.vat'), VatCell, { flex: 1.6, minWidth: 210 }),
      column('country', t('list.col.country'), CountryCell, { flex: 1, minWidth: 130 }),
      // B-W2b-334: the side's own columns (Suppliers: Documents), before Language.
      ...(sideColumns ?? []),
      { colId: 'language', headerName: t('list.col.language'), sortable: false, flex: 0.8, minWidth: 110, valueGetter: (params) => (params.data ? languageName(params.data.language, locale) : '') },
      actionsColumn,
    ])
    // The cells close over the words, the rights and the actions: a change of language or rights rebuilds them.
  }, [t, locale, side, config, model.prefix, can.vies, can.block, can.manage, sideColumns, sideName, sideLeading, sideHidden, sideRowItems])

  if (!can.view) return <NoAccess title={t(`${side}.noAccess.title`)} body={t(`${side}.noAccess.body`)} />

  const filterCount = (model.filters.kind ? 1 : 0) + (model.filters.taxMode ? 1 : 0)

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
  const tiles = [...config.tiles.map(tile), ...(depth?.tiles ?? [])]

  // ---- the toolbar's menus and chips ----
  // F-CL-101 (K12, settle T10): ONE Views ▾ — the side's views on top of the frame's Views ▾ (its saved views, Customise); Rows ▾ went.
  const views = viewsOf(side, model.view)
  const builtInViews = { items: views.ids.map((id) => ({ id, label: t(`view.${id}`) })), active: views.active, onPick: (id: string) => actions?.onView?.(views.ids.find((view) => view === id) ?? 'open') }
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
  // F-SA-225: the view's file is the frame's Export ▾ (the export job: exports/sources/parties.ts), never a CSV made here.
  // F-CL-101 (P0-B2, settle T15): ⋯ holds only the customers' re-check (hidden without parties.vies); with nothing in it there is no ⋯.
  const moreItems: MenuItemDef[] =
    side === 'customers' && can.vies ? [{ id: 'recheck', label: t('list.recheckAll'), onSelect: () => actions?.onRecheckAll?.(), description: t('list.recheckAllHint', { max: BULK_MAX }) }] : []
  const chip = (key: string, label: string, onRemove: () => void) => (
    <FilterChip key={key} pressed onClick={onRemove} aria-label={t('list.removeFilter', { name: label })}>
      {label} <X size={12} aria-hidden />
    </FilterChip>
  )
  // F-CL-101 (K12): the chips row holds the real filters only (the view is the Views ▾ label, the search is its field); Clear all with ≥ 2.
  const tools = (
    <>
      <Menu label={filterCount > 0 ? t('list.filtersCount', { count: filterCount }) : t('list.filters')} items={filterItems} />
      {filterCount > 0 && (
        <span className="fw-pty-chips" aria-label={t('list.activeFilters')}>
          {model.filters.kind && chip('kind', t(`kind.${model.filters.kind}`), () => actions?.onFilters?.({ ...model.filters, kind: null }))}
          {model.filters.taxMode && chip('mode', t(`taxMode.${model.filters.taxMode}`), () => actions?.onFilters?.({ ...model.filters, taxMode: null }))}
          {filterCount >= 2 && (
            <Button size="sm" variant="quiet" onClick={() => actions?.onFilters?.({})}>
              {t('list.clearAll')}
            </Button>
          )}
        </span>
      )}
    </>
  )

  // ---- F-CL-103 (13-backend §8.2, settles T8 / T9): the bar "3 + More ▾" — the side's acts and the shared ones by their place, two
  // promoted, Export N third (the frame's), the rest in More ▾ right of it; an act without its right is not drawn, a reach of 0 is held.
  const LABEL: Readonly<Record<SharedActId, string>> = { vies: 'list.bulkVies', block: 'list.bulkBlock', archive: 'list.bulkArchive' }
  const NO_COUNT: Readonly<Record<SharedActId, string>> = { vies: 'row.checkVies', block: 'row.block', archive: 'row.archive' }
  const ICON: Readonly<Record<SharedActId, ReactNode>> = { vies: <ShieldCheck size={13} aria-hidden />, block: <Ban size={13} aria-hidden />, archive: <Archive size={13} aria-hidden /> }
  const sharedActs: BarAct[] = sharedActsOf(side, can, selectedRows).map((act) => {
    const ids = act.reach.map((row) => row.id)
    const notOn = act.skipped.map((row) => row.id)
    return {
      id: act.id,
      order: act.order,
      label: act.reach.length === 0 ? t(NO_COUNT[act.id]) : t(LABEL[act.id], { count: act.reach.length }),
      icon: ICON[act.id],
      held: act.held ? t(act.held.key, act.held.params) : null,
      run: () => (act.id === 'vies' ? actions?.onCheckVies?.(ids, notOn) : open({ kind: act.id, partyIds: ids, notOn })),
      ...(act.id === 'archive' ? { tone: 'danger' as const } : {}),
    }
  })
  const exportShown = can.export === true
  const bar = barOf([...(depth?.acts ?? []), ...sharedActs], exportShown)
  const bulkActions =
    bar.promoted.length === 0 && !exportShown ? (
      <span className="fw-pty-hint">{c(`bar.none.${side}`)}</span>
    ) : (
      <>
        {bar.promoted.map((act) => (
          <Button key={act.id} size="sm" variant={act.tone === 'danger' ? 'danger-outline' : undefined} onClick={act.run} heldReason={act.held}>
            {act.icon} {act.label}
          </Button>
        ))}
        {/* F-SA-225: Export N is the frame's (the export job with the picked rows), after these; More ▾ is the frame's `trailing`. */}
      </>
    )
  const moreActs =
    bar.more.length > 0 ? (
      <Menu
        align="right"
        label={
          <>
            {c('bar.more')} <ChevronDown size={13} aria-hidden />
          </>
        }
        triggerProps={{ className: 'nds-btn sm' }}
        items={bar.more.map((act) => ({ id: act.id, label: act.label, icon: act.icon, onSelect: act.run, ...(act.held ? { disabled: true, description: act.held } : {}), ...(act.tone === 'danger' ? { tone: 'danger' as const } : {}) }))}
      />
    ) : null
  /** A selected row a run leaves out, with why in words. */
  const notOnLines = (kind: SharedActId, ids: readonly string[] | undefined): NotOnLine[] =>
    (ids ?? []).flatMap((id) => {
      const row = rows.find((entry) => entry.id === id)
      if (!row) return []
      const why = whyNotOf(kind, side, row)
      return [{ id, name: partyName(row), why: why.ns === 'parties' ? t(why.key) : c(why.key) }]
    })
  // A name in a receipt opens its record with the thread open (any record page takes ?thread=open).
  const receiptHref = (id: string) => `${recordHref(model.prefix, config, id)}?thread=open`

  // ---- states in place of the grid (the toolbar stays) ----
  // F-CL-101 (P0-B1, K12): an empty list names what is empty — the search, the chips, the view ("No blocked customers.") — with ONE Clear.
  const empty = emptyWordsOf(side, model.view, model.filters, model.query)
  const clearButton = (label: string, onClick: () => void) => (
    <Button size="sm" onClick={onClick}>
      {label}
    </Button>
  )
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
    empty.kind === 'search' ? (
      <EmptyState title={c(empty.key, { q: empty.q })} action={clearButton(c('empty.clearSearch'), () => actions?.onQuery?.(''))} />
    ) : empty.kind === 'filters' ? (
      <EmptyState title={c(empty.key)} action={clearButton(c('empty.clear'), () => actions?.onFilters?.({}))} />
    ) : empty.kind === 'view' ? (
      <EmptyState title={c(empty.key, { view: t(`view.${empty.view}`) })} action={clearButton(c('empty.clear'), () => actions?.onView?.('open'))} />
    ) : (
      <EmptyState
        icon={<Building2 size={24} aria-hidden />}
        title={t(`${side}.empty.title`)}
        description={t(`${side}.empty.body`)}
        action={
          can.manage ? (
            <Button variant="primary" onClick={() => open({ kind: 'new' })}>
              {t(`${side}.new.action`)}
            </Button>
          ) : undefined
        }
      />
    )
  ) : undefined

  // F-CL-101: `c` New only for a reader who may create (the key and the button are hidden alike).
  const ownKeys: ListKey[] = can.manage ? [{ keys: ['c'], does: t(`${side}.keys.new`) }] : []
  const blockRows = dialog?.kind === 'block' ? rows.filter((row) => dialog.partyIds.includes(row.id)) : []
  const archiveRows = dialog?.kind === 'archive' ? rows.filter((row) => dialog.partyIds.includes(row.id)) : []

  return (
    <div className="fw-pty">
      <PageHead
        intro={t(`${side}.intro`)}
        band={depth?.band /* F-CL-101 (settle T22): drawn only when a side passes one */}
        status={<Freshness asOf={model.asOf} live={model.live} />}
        actions={
          <>
            {/* A side's own band actions (Customers: Import, B-W2a-49), before New. F-CL-101: New only with the right. */}
            {headActions}
            {can.manage && (
              <Button size="sm" variant="primary" onClick={() => open({ kind: 'new' })}>
                {t(`${side}.new.action`)}
              </Button>
            )}
          </>
        }
      />
      <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
      {tiles.length > 0 && <MetricStrip metrics={tiles} />}

      {/* B-W2b-334: a side's own view in place of the grid (Suppliers: Documents expiring in 30 days). */}
      {depth?.body ?? (
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
            {...search.field /* F-SA-223 */}
          />
        }
        tools={tools}
        builtInViews={builtInViews /* F-CL-101: ONE Views ▾ */}
        right={moreItems.length > 0 ? <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('list.more') }} items={moreItems} /> : undefined}
        selection={{ selected: model.selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulkActions, exportSelected: true /* F-SA-225 */, trailing: moreActs /* F-CL-103 */ }}
        // F-SA-225: the rest of a row opens its record (⌘ / Ctrl: a new tab), on Customers and Purchasing › Suppliers alike (one list).
        onRowClick={(row, event) => (event.metaKey || event.ctrlKey ? window.open(recordHref(model.prefix, config, row.id), '_blank', 'noopener') : actions?.onOpen?.(row))}
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
        onOpen={(row) => actions?.onOpen?.(row)}
        state={state}
        focusRow={model.focusRow}
        {...(depth?.card ? { cards: { fields: depth.card } } : {}) /* F-CL-101: the side's phone card */}
      />
      )}

      <NewPartyModal
        side={side}
        prefix={model.prefix}
        open={dialog?.kind === 'new' && can.manage}
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
        notOn={dialog?.kind === 'block' ? notOnLines('block', dialog.notOn) : []}
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
        notOn={dialog?.kind === 'archive' ? notOnLines('archive', dialog.notOn) : []}
        busy={model.busy}
        problem={model.dialogProblem}
        onArchive={() => actions?.onArchive?.(archiveRows.map((row) => row.id))}
        onClose={() => open(null)}
      />
      <BulkModal
        run={model.bulk}
        open={dialog?.kind === 'bulk'}
        side={side}
        notOn={model.bulk ? notOnLines(model.bulk.kind, model.bulk.notOn) : []}
        hrefOf={receiptHref}
        onRunRest={actions?.onRunRest}
        onClose={() => open(null)}
      />
    </div>
  )
}
