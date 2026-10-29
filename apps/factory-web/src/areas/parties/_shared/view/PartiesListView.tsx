'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { Building2, MoreHorizontal, Search, X } from 'lucide-react'
import { Card, Menu, MetricStrip, SummaryTable, type MenuItemDef } from '@nexus/ui/components'
import { Button, Checkbox, FilterChip, Input, Kbd, Skeleton } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../lib/i18n/provider'
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
import { dash, Freshness, NoAccess, NoticeBanner, PageHead, PartiesMessages, ReadState, RoleTags, StatusPill, ViesMark } from './parts'

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
  onLookup?: (q: string) => void
  onCreate?: (draft: NewPartyDraft) => Promise<boolean>
  onBlock?: (partyId: string, reason: string) => void
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
 * side of the party record. The head (one sentence, Updated + live state, New), the saved-filter tiles (each a named
 * view: pressing it puts its chip in the filter row), the toolbar (search, Rows ▾, Filters ▾, ⋯), the filter chips, the
 * selection row (counts and reach before the click), the table (50 a page, Show more), the row verbs (⋯: the same list
 * as the keys), and the dialogs. Fetches nothing: the container (PartiesList.tsx) reads and writes.
 */
export function PartiesListView({ model, actions }: { model: PartiesListModel; actions?: PartiesListActions }) {
  return (
    <PartiesMessages>
      <PartiesList model={model} actions={actions} />
    </PartiesMessages>
  )
}

function PartiesList({ model, actions }: { model: PartiesListModel; actions?: PartiesListActions }) {
  const t = useT('parties')
  const locale = useLocale()
  const config = SIDES[model.side]
  const side = model.side
  const searchRef = useRef<HTMLInputElement>(null)
  const tableRef = useRef<HTMLDivElement>(null)
  const dialog = model.dialog ?? null
  const rows = model.rows.items ?? []
  const selected = new Set(model.selected)
  const selectedRows = rows.filter((row) => selected.has(row.id))
  const open = (next: ListDialog | null) => actions?.onDialog?.(next)

  // Keys (00 §3.17): c new · / search · j / k (↓ / ↑) between rows · x select · ? the list of keys. Never while typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || dialog) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      const links = Array.from(tableRef.current?.querySelectorAll<HTMLAnchorElement>('a[data-row]') ?? [])
      const at = links.findIndex((link) => link === document.activeElement)
      if (event.key === 'c' && model.can.manage) {
        event.preventDefault()
        open({ kind: 'new' })
      } else if (event.key === '/') {
        event.preventDefault()
        searchRef.current?.focus()
      } else if (event.key === '?') {
        event.preventDefault()
        open({ kind: 'shortcuts' })
      } else if ((event.key === 'j' || (event.key === 'ArrowDown' && at >= 0)) && links.length > 0) {
        event.preventDefault()
        links[Math.min(links.length - 1, at + 1)]?.focus()
      } else if ((event.key === 'k' || (event.key === 'ArrowUp' && at >= 0)) && links.length > 0) {
        event.preventDefault()
        links[Math.max(0, at - 1)]?.focus()
      } else if (event.key === 'x' && at >= 0) {
        event.preventDefault()
        const id = links[at]!.dataset.row!
        actions?.onSelect?.(selected.has(id) ? model.selected.filter((held) => held !== id) : [...model.selected, id])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  // A design case's focused row (the keyboard case).
  useEffect(() => {
    if (model.focusRow === undefined) return
    tableRef.current?.querySelectorAll<HTMLAnchorElement>('a[data-row]')[model.focusRow]?.focus()
  }, [model.focusRow, model.rows.items])

  if (!model.can.view) return <NoAccess title={t(`${side}.noAccess.title`)} body={t(`${side}.noAccess.body`)} />

  const manageHeld = model.can.manage ? null : t('held.manage')
  const filterCount = (model.filters.kind ? 1 : 0) + (model.filters.taxMode ? 1 : 0)
  const filtered = model.view !== 'open' || !!model.filters.kind || !!model.filters.taxMode || model.query.trim() !== ''

  // ---- the head and the tiles ----
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

  // ---- menus ----
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
            disabled: !model.can.vies,
            description: model.can.vies ? t('list.recheckAllHint', { max: BULK_MAX }) : t('held.vies'),
          },
        ]
      : []),
    { id: 'sep', separator: true },
    { id: 'keys', label: t('keys.title'), onSelect: () => open({ kind: 'shortcuts' }) },
  ]

  const rowItems = (row: PartyRow): MenuItemDef[] => {
    const href = recordHref(model.prefix, config, row.id)
    const items: MenuItemDef[] = [
      { id: 'open', label: t('row.open'), href },
      { id: 'tab', label: t('row.openNewTab'), href, target: '_blank' },
    ]
    if (viesApplies(row) && row.status !== 'ARCHIVED')
      items.push({ id: 'vies', label: t('row.checkVies'), onSelect: () => actions?.onCheckVies?.([row.id]), disabled: !model.can.vies, description: model.can.vies ? undefined : t('held.vies') })
    if (row.status === 'ACTIVE')
      items.push({
        id: 'block',
        label: t('row.block'),
        onSelect: () => open({ kind: 'block', partyId: row.id }),
        disabled: !model.can.block,
        description: model.can.block ? undefined : t('held.block'),
      })
    if (row.status === 'BLOCKED')
      items.push({ id: 'unblock', label: t('row.unblock'), onSelect: () => actions?.onUnblock?.(row.id), disabled: !model.can.block, description: model.can.block ? undefined : t('held.block') })
    if (row.status === 'ACTIVE' || row.status === 'PROSPECT')
      items.push({ id: 'archive', label: t('row.archive'), onSelect: () => open({ kind: 'archive', partyIds: [row.id] }), disabled: !model.can.manage, description: manageHeld ?? undefined })
    if (row.status === 'BLOCKED') items.push({ id: 'archive-held', label: t('row.archive'), disabled: true, description: t('held.archiveBlocked') })
    if (row.status === 'ARCHIVED')
      items.push({ id: 'reactivate', label: t('row.reactivate'), onSelect: () => actions?.onReactivate?.(row.id), disabled: !model.can.manage, description: manageHeld ?? undefined })
    return items
  }

  // ---- the table ----
  const nameCell = (row: PartyRow, index: number) => (
    <span className="fw-pty-cell">
      <Link className="fw-pty-name" href={recordHref(model.prefix, config, row.id)} data-row={row.id} data-index={index}>
        {partyName(row)}
      </Link>
      <span className="fw-pty-hint">
        <span className="fw-pty-code">{row.code}</span>
        {row.tradeName && row.tradeName !== row.legalName ? ` · ${row.legalName}` : ''}
      </span>
    </span>
  )
  const selectCell = (row: PartyRow) => (
    <Checkbox
      aria-label={t('list.selectRow', { name: partyName(row) })}
      checked={selected.has(row.id)}
      onChange={(event) => actions?.onSelect?.(event.target.checked ? [...model.selected, row.id] : model.selected.filter((id) => id !== row.id))}
    />
  )
  const whereCell = (row: PartyRow) => (
    <span className="fw-pty-cell">
      <span>{countryName(row.country, locale)}</span>
      {row.city && <span className="fw-pty-hint">{row.city}</span>}
    </span>
  )
  const rowMenu = (row: PartyRow) => (
    <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('row.menu', { name: partyName(row) }) }} items={rowItems(row)} />
  )
  const sdi = (row: PartyRow) => {
    const state = sdiState(row)
    return state === null ? <span className="fw-pty-hint">{t('sdi.notNeeded')}</span> : state === 'set' ? t('sdi.set') : <span className="fw-pty-cell-row">{t('sdi.missing')}</span>
  }
  const viesCell = (row: PartyRow) => <ViesMark standing={row.vies} onCheck={model.can.vies ? () => actions?.onCheckVies?.([row.id]) : undefined} />
  const invoiceMark = (row: PartyRow) => (row.invoiceBlocked ? <span className="fw-pty-hint">{t('list.cannotInvoice')}</span> : null)

  const customerTable = {
    columns: [
      t('list.col.select'),
      t('list.col.name'),
      t('list.col.roles'),
      t('list.col.status'),
      t('list.col.country'),
      t('list.col.taxMode'),
      t('list.col.vies'),
      t('list.col.sdi'),
      t('list.col.language'),
      t('list.col.actions'),
    ],
    widths: ['72px', '20%', '12%', '11%', '11%', '12%', '16%', '9%', '8%', '80px'],
    rows: rows.map((row, index) => ({
      id: row.id,
      cells: [
        selectCell(row),
        nameCell(row, index),
        <RoleTags key="roles" roles={row.roles} />,
        <span key="status" className="fw-pty-cell">
          <StatusPill status={row.status} />
          {invoiceMark(row)}
        </span>,
        whereCell(row),
        row.taxMode ? t(`taxMode.${row.taxMode}`) : <span className="fw-pty-hint">{t('list.noIdentity')}</span>,
        viesCell(row),
        sdi(row),
        languageName(row.language, locale),
        rowMenu(row),
      ],
    })),
  }
  const supplierTable = {
    columns: [t('list.col.select'), t('list.col.name'), t('list.col.roles'), t('list.col.status'), t('list.col.vat'), t('list.col.country'), t('list.col.language'), t('list.col.actions')],
    widths: ['72px', '27%', '15%', '12%', '21%', '12%', '8%', '80px'],
    rows: rows.map((row, index) => ({
      id: row.id,
      cells: [
        selectCell(row),
        nameCell(row, index),
        <RoleTags key="roles" roles={row.roles} />,
        <StatusPill key="status" status={row.status} />,
        <span key="vat" className="fw-pty-cell">
          <span className="fw-pty-code">{dash(row.vatNumber ?? row.fiscalCode)}</span>
          {viesApplies(row) && viesCell(row)}
        </span>,
        whereCell(row),
        languageName(row.language, locale),
        rowMenu(row),
      ],
    })),
  }
  const table = side === 'customers' ? customerTable : supplierTable

  // ---- selection reach (held before the click) ----
  const viesReach = bulkReach('vies', selectedRows)
  const archiveReach = bulkReach('archive', selectedRows)
  const viesHeld = !model.can.vies ? t('held.vies') : viesReach.reach.length === 0 ? t('held.noEuNumber') : viesReach.reach.length > BULK_MAX ? t('held.bulkMax', { max: BULK_MAX }) : null
  const archiveHeld = manageHeld ?? (archiveReach.reach.length === 0 ? t('held.nothingToArchive') : null)

  const blockParty = dialog?.kind === 'block' ? rows.find((row) => row.id === dialog.partyId) : undefined
  const archiveRows = dialog?.kind === 'archive' ? rows.filter((row) => dialog.partyIds.includes(row.id)) : []

  return (
    <div className="fw-pty">
      <PageHead
        intro={t(`${side}.intro`)}
        status={<Freshness asOf={model.asOf} live={model.live} />}
        actions={
          <Button size="sm" variant="primary" onClick={() => open({ kind: 'new' })} heldReason={manageHeld}>
            {t(`${side}.new.action`)}
          </Button>
        }
      />
      <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
      <MetricStrip metrics={config.tiles.map(tile)} />

      <div className="fw-pty-toolbar">
        <div className="fw-pty-toolbar-row">
          <span className="fw-pty-search">
            <Input
              ref={searchRef}
              size="sm"
              fieldClassName="fw-pty-fill"
              type="search"
              leadingIcon={<Search size={14} aria-hidden />}
              aria-label={t(`${side}.search`)}
              placeholder={t(`${side}.search`)}
              value={model.query}
              onChange={(event) => actions?.onQuery?.(event.target.value)}
            />
          </span>
          <Menu label={t('list.rows', { view: t(`view.${model.view}`) })} items={viewItems} />
          <Menu label={filterCount > 0 ? t('list.filtersCount', { count: filterCount }) : t('list.filters')} items={filterItems} />
          <span className="fw-pty-grow" />
          {model.updates > 0 && (
            <Button size="sm" variant="tonal" onClick={() => actions?.onShowUpdates?.()}>
              {t('list.updates', { count: model.updates })}
            </Button>
          )}
          <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('list.more') }} items={moreItems} />
        </div>
        {filtered && (
          <div className="fw-pty-chips" aria-label={t('list.activeFilters')}>
            {model.view !== 'open' && (
              <FilterChip pressed onClick={() => actions?.onView?.('open')} aria-label={t('list.removeFilter', { name: t(`view.${model.view}`) })}>
                {t(`view.${model.view}`)} <X size={12} aria-hidden />
              </FilterChip>
            )}
            {model.filters.kind && (
              <FilterChip pressed onClick={() => actions?.onFilters?.({ ...model.filters, kind: null })} aria-label={t('list.removeFilter', { name: t(`kind.${model.filters.kind}`) })}>
                {t(`kind.${model.filters.kind}`)} <X size={12} aria-hidden />
              </FilterChip>
            )}
            {model.filters.taxMode && (
              <FilterChip pressed onClick={() => actions?.onFilters?.({ ...model.filters, taxMode: null })} aria-label={t('list.removeFilter', { name: t(`taxMode.${model.filters.taxMode}`) })}>
                {t(`taxMode.${model.filters.taxMode}`)} <X size={12} aria-hidden />
              </FilterChip>
            )}
            {model.query.trim() !== '' && (
              <FilterChip pressed onClick={() => actions?.onQuery?.('')} aria-label={t('list.removeFilter', { name: model.query.trim() })}>
                “{model.query.trim()}” <X size={12} aria-hidden />
              </FilterChip>
            )}
            <Button size="sm" variant="quiet" onClick={() => actions?.onClearAll?.()}>
              {t('list.clearAll')}
            </Button>
          </div>
        )}
        {selectedRows.length > 0 && (
          <div className="fw-pty-selection" role="region" aria-label={t('list.selection')}>
            <span role="status">{t('list.selected', { count: selectedRows.length })}</span>
            <Button size="sm" onClick={() => actions?.onCheckVies?.(viesReach.reach.map((row) => row.id))} heldReason={viesHeld}>
              {t('list.bulkVies', { count: viesReach.reach.length })}
            </Button>
            <Button size="sm" onClick={() => actions?.onExport?.(selectedRows)}>
              {t('list.bulkExport', { count: selectedRows.length })}
            </Button>
            <Button size="sm" variant="danger-outline" onClick={() => open({ kind: 'archive', partyIds: archiveReach.reach.map((row) => row.id) })} heldReason={archiveHeld}>
              {t('list.bulkArchive', { count: archiveReach.reach.length })}
            </Button>
            <span className="fw-pty-grow" />
            {selectedRows.length < rows.length && (
              <Button size="sm" variant="quiet" onClick={() => actions?.onSelect?.(rows.map((row) => row.id))}>
                {t('list.selectPage', { count: rows.length })}
              </Button>
            )}
            <Button size="sm" variant="quiet" onClick={() => actions?.onSelect?.([])}>
              {t('list.clearSelection')}
            </Button>
          </div>
        )}
      </div>

      {model.rows.problem || model.rows.items === null ? (
        <ReadState problem={model.rows.problem} loading={model.rows.items === null && !model.rows.problem} onRetry={actions?.onRetry} failedTitle={t(`${side}.failedTitle`)} rows={8} />
      ) : rows.length === 0 ? (
        filtered ? (
          <ReadState
            loading={false}
            empty={{
              title: t('list.noMatch'),
              action: (
                <Button size="sm" onClick={() => actions?.onClearAll?.()}>
                  {t('list.clearAll')}
                </Button>
              ),
            }}
          />
        ) : (
          <ReadState
            loading={false}
            empty={{
              icon: <Building2 size={24} aria-hidden />,
              title: t(`${side}.empty.title`),
              body: t(`${side}.empty.body`),
              action: (
                <Button variant="primary" onClick={() => open({ kind: 'new' })} heldReason={manageHeld}>
                  {t(`${side}.new.action`)}
                </Button>
              ),
            }}
          />
        )
      ) : (
        <Card className="fw-pty-tablecard">
          <p className="fw-pty-count" role="status">
            {model.total === null ? t('list.countShown', { shown: rows.length }) : t('list.count', { shown: rows.length, total: model.total })}
            {' · '}
            <span aria-hidden>
              <Kbd>j</Kbd> <Kbd>k</Kbd> <Kbd>x</Kbd> <Kbd>?</Kbd>
            </span>
            <span className="fw-pty-sr">{t('list.keysSr')}</span>
          </p>
          <div className="fw-pty-table" ref={tableRef}>
            <SummaryTable label={t(`${side}.table`)} columns={table.columns} rows={table.rows} density="roomy" stackOnPhone widths={table.widths} align={table.columns.map(() => 'left')} />
          </div>
          {model.more && (
            <div className="fw-pty-more">
              <Button size="sm" onClick={() => actions?.onMore?.()} heldReason={model.loadingMore ? t('list.loading') : null}>
                {t('list.showMore', { count: Math.min(50, Math.max(0, (model.total ?? rows.length + 50) - rows.length)) })}
              </Button>
            </div>
          )}
        </Card>
      )}

      <NewPartyModal
        side={side}
        prefix={model.prefix}
        open={dialog?.kind === 'new'}
        busy={model.busy}
        problem={model.dialogProblem}
        refused={model.refused}
        duplicates={model.duplicates}
        canVies={model.can.vies}
        initial={model.newDraft}
        companies={model.companies}
        actions={{ onLookup: actions?.onLookup, onCreate: actions?.onCreate, onClose: () => open(null) }}
      />
      <BlockModal
        side={side}
        open={dialog?.kind === 'block'}
        name={blockParty ? partyName(blockParty) : ''}
        busy={model.busy}
        problem={model.dialogProblem}
        onBlock={(reason) => blockParty && actions?.onBlock?.(blockParty.id, reason)}
        onClose={() => open(null)}
      />
      <ArchiveModal
        side={side}
        open={dialog?.kind === 'archive'}
        names={archiveRows.map(partyName)}
        skipped={dialog?.kind === 'archive' && selectedRows.length > archiveRows.length && archiveRows.length > 1 ? archiveReach.skipped.length : 0}
        busy={model.busy}
        problem={model.dialogProblem}
        onArchive={() => actions?.onArchive?.(archiveRows.map((row) => row.id))}
        onClose={() => open(null)}
      />
      <BulkModal run={model.bulk} open={dialog?.kind === 'bulk'} onClose={() => open(null)} />
      <ShortcutsModal
        open={dialog?.kind === 'shortcuts'}
        onClose={() => open(null)}
        keys={[
          { keys: ['c'], does: t(`${side}.keys.new`) },
          { keys: ['/'], does: t('keys.search') },
          { keys: ['j', 'k'], does: t('keys.rows') },
          { keys: ['↵'], does: t('keys.open') },
          { keys: ['x'], does: t('keys.select') },
          { keys: ['⌘', 'K'], does: t('keys.palette') },
          { keys: ['?'], does: t('keys.help') },
        ]}
      />
    </div>
  )
}
