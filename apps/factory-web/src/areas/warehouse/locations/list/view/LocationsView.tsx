'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Download, FolderInput, Lock, MapPin, MoreHorizontal, Plus, Printer, Search, Unlock } from 'lucide-react'
import { Banner, EmptyState, EntityPath, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Toggle } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { LiveState } from '../../../../_shared/buying/hooks'
import type { LocationView, SiteLocations, StockOverview, Uom } from '../../../../_shared/stock/api'
import { movesHref, unitTotals } from '../../../../_shared/stock/model'
import { NoAccess, ReadFailed, StockMessages } from '../../../../_shared/stock/parts'
import { LOCATIONS_NAMESPACES, placeRows, searchRows, type ListAddress, type LocationsCan, type PlaceRow } from '../../model'
import { LocationDialogs, type DialogActions, type LocationDialog } from '../../view/LocationDialogs'
import '../../locations.css'
// B-W2b-327: Status (blocked), Default for, the label code, Block / Unblock, Print labels and the bin labels PDF.
import type { DefaultView, PartyChoice, PlaceSite, PlaceView } from '../../depth/api'
import { blockHeldOf, countHref, defaultsOf, depthCan, labelRefusalOf, placeStatus, printStartHeldKey, STATUS_TONE, type Loaded, type PrintActions, type PrintDialogModel } from '../../depth/model'
import { DEPTH_WORDS, DepthDialogs, PrintDialog, type DepthDialog, type DepthDialogActions } from '../../depth/view/DepthDialogs'
import '../../../stock/depth/depth.css'

export interface LocationsListModel {
  prefix: string
  can: LocationsCan
  sites: { status: 'loading' } | { status: 'ready'; items: (SiteLocations | PlaceSite)[] } | { status: 'error'; problem: string }
  /** The site shown (the address's, else the first); its places carry their label code and block (B-W2b-327). */
  site: SiteLocations | PlaceSite | null
  address: ListAddress
  /** The site's stock (inventory.stock.view): what each place holds. */
  stock: { value: StockOverview | null; problem: string | null }
  asOf: string | null
  live: LiveState
  /** Stock moved meanwhile: the column waits behind "N updates · Show". */
  updates: number
  timeZone: string
  notice?: { tone: 'success' | 'danger' | 'info'; key: string; params?: Record<string, string | number> } | null
  /** Design cases: a dialog open, rows selected, the keys panel open. */
  dialog?: LocationDialog | null
  selected?: readonly string[]
  helpOpen?: boolean
  /** B-W2b-327: the site's default locations (what each place is the default for). */
  defaults?: readonly DefaultView[] | null
  /** B-W2b-327: Print labels (the dialog's model), Block / Unblock open (design cases), today at the site, a new place's parties. */
  print?: PrintDialogModel | null
  depthDialog?: DepthDialog | null
  today?: string
  parties?: Loaded<PartyChoice[]> | null
  /** The permissions (print, parties) the W2b parts read. */
  permissions?: readonly string[]
}

export interface LocationsListActions extends DialogActions, DepthDialogActions {
  /** B-W2b-327: Print labels of the places picked; the parties a new workshop's or customer's place may name. */
  onPrint?: (places: PlaceView[]) => void
  onParties?: (roles: readonly string[]) => void
  onSite?: (siteId: string) => void
  onArchived?: (show: boolean) => void
  onSearch?: (q: string) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onOpen?: (location: LocationView) => void
  onExport?: (rows: readonly PlaceRow[]) => void
  onDismissNotice?: () => void
}

/**
 * SCR-065 — Warehouse › Settings › Locations (design warehouse.locations, lc-tree): the site's places as a tree on the
 * shared list frame (indented by depth, the places above as an EntityPath under the name), each with its code, kind,
 * state, what lies there (stock keys · hides · quantity per unit, linked to Movements filtered by the place) and how
 * many places sit inside; row ⋯ New location inside, Move under…, Archive (held, with the amount, while the place holds
 * stock or active places), Open. New location (primary, `c`), ⋯ Import locations (the inventory.locations importer)
 * and Export. Blocks and bin labels are W2b: not drawn. Fetches nothing.
 */
export function LocationsView({ model, actions, printActions }: { model: LocationsListModel; actions?: LocationsListActions; printActions?: PrintActions }) {
  return (
    <StockMessages extra={[...LOCATIONS_NAMESPACES, DEPTH_WORDS]}>
      <LocationsList model={model} actions={actions} printActions={printActions} />
    </StockMessages>
  )
}

function LocationsList({ model, actions, printActions }: { model: LocationsListModel; actions?: LocationsListActions; printActions?: PrintActions }) {
  const t = useT('warehouse-locations')
  const w = useT(DEPTH_WORDS)
  const deep = useMemo(() => depthCan(model.permissions ?? []), [model.permissions])
  const [depthDialog, setDepthDialog] = useState<DepthDialog | null>(model.depthDialog ?? null)
  useEffect(() => setDepthDialog(model.depthDialog ?? null), [model.depthDialog])
  const stock = useT('stock')
  const lists = useT('lists')
  const locale = useLocale()
  const unit = (uom: Uom) => stock(`uom.${uom}`)
  const [query, setQuery] = useState(model.address.q)
  useEffect(() => setQuery(model.address.q), [model.address.q])
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onSearch?.(query), 250)
    return () => clearTimeout(timer)
  }, [query])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [dialog, setDialog] = useState<LocationDialog | null>(model.dialog ?? null)
  useEffect(() => setDialog(model.dialog ?? null), [model.dialog])
  const [help, setHelp] = useState(!!model.helpOpen)

  const all = useMemo(() => (model.site ? placeRows(model.site, model.stock.value, model.can) : []), [model.site, model.stock.value, model.can])
  const rows = useMemo(() => searchRows(all, query), [all, query])
  const siteName = model.site ? `${model.site.code} · ${model.site.name}` : ''

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || dialog || depthDialog || model.print || help) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      if (event.key === 'c' && model.can.manage && model.site) {
        event.preventDefault()
        setDialog({ kind: 'new', parentId: null })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const ownKeys: ListKey[] = model.can.manage ? [{ keys: ['c'], does: t('lc.keys.new') }] : []
  const place = { locale, timeZone: model.timeZone }
  const recordHref = (location: LocationView) => `${model.prefix}/warehouse/locations/${encodeURIComponent(location.id)}`

  const columns = useMemo<ColDef<PlaceRow>[]>(() => {
    const NameCell = ({ data }: ICellRendererParams<PlaceRow>) =>
      data ? (
        <span className="fw-lc-place" style={{ paddingInlineStart: `calc(var(--nds-space-16) * ${data.location.depth})` }}>
          <Link className="fw-st-link fw-st-ellipsis" href={recordHref(data.location)}>
            {data.location.name}
          </Link>
          {data.above.length > 0 ? (
            <EntityPath className="fw-st-sub" label={t('lc.col.above')} items={data.above.map((entry) => ({ id: entry.id, name: entry.code }))} />
          ) : (
            <span className="fw-st-sub">{t('lc.top')}</span>
          )}
        </span>
      ) : null
    const CodeCell = ({ data }: ICellRendererParams<PlaceRow>) => (data ? <span className={data.location.status === 'ARCHIVED' ? 'fw-lc-code fw-st-struck' : 'fw-lc-code'}>{data.location.code}</span> : null)
    // B-W2b-327 (design lc-tree "Status (Active / Blocked W2b / Archived)"): a block that holds says its reason, its day or its count.
    const StatusCell = ({ data }: ICellRendererParams<PlaceRow>) => {
      if (!data) return null
      const place = data.location as PlaceView
      const status = placeStatus(place)
      const block = status === 'BLOCKED' ? place.block! : null
      return (
        <span className="fw-st-cell">
          <span>
            <Pill tone={STATUS_TONE[status]}>{w(`wd.loc.status.${status}`)}</Pill>
          </span>
          {block && (
            <span className="fw-st-sub" title={block.note ?? undefined}>
              {block.countNumber ? (
                <Link className="fw-st-link" href={countHref(model.prefix, block.countNumber)}>
                  {w('wd.loc.status.byCount', { number: block.countNumber })}
                </Link>
              ) : block.until ? (
                w('wd.loc.status.until', { reason: w(`wd.loc.reason.${block.reason}`), day: formatDate(`${block.until}T12:00:00Z`, { locale, timeZone: 'UTC' }) })
              ) : (
                w(`wd.loc.reason.${block.reason}`)
              )}
            </span>
          )}
        </span>
      )
    }
    // B-W2b-327 (design lc-tree "Default for (W2b)", SCM-179): the purposes the site's default locations name this place for.
    const DefaultCell = ({ data }: ICellRendererParams<PlaceRow>) => {
      if (!data) return null
      const own = defaultsOf(data.location.id, model.defaults)
      if (own.length === 0) return <span className="fw-st-sub">—</span>
      const words = own.map((entry) => (entry.itemKind ? w('wd.loc.purposeFor', { purpose: w(`wd.loc.purpose.${entry.purpose}`), kind: w(`wd.loc.itemKind.${entry.itemKind}`) }) : w(`wd.loc.purpose.${entry.purpose}`))).join(' · ')
      return (
        <span className="fw-st-ellipsis" title={words}>
          {words}
        </span>
      )
    }
    // B-W2b-327 (design lc-tree "Label printed", SCM-178): the code its bin label carries, or why it has none.
    const LabelCell = ({ data }: ICellRendererParams<PlaceRow>) => {
      if (!data) return null
      const place = data.location as PlaceView
      const refusal = labelRefusalOf(place)
      if (place.labelCode) return <span className="fw-lc-code">{place.labelCode}</span>
      return <span className="fw-st-sub">{refusal && place.status === 'ACTIVE' ? w('wd.loc.label.noneKind') : w('wd.loc.label.none')}</span>
    }
    const StockCell = ({ data }: ICellRendererParams<PlaceRow>) => {
      if (!data?.stock) return null
      if (data.stock.lines === 0) return <span className="fw-st-sub">{t('lc.stock.empty')}</span>
      const href = movesHref(model.prefix, { siteId: data.location.siteId, locationId: data.location.id })
      return (
        <span className="fw-st-cell">
          <Link className="fw-st-link fw-st-num" href={href} title={t('lc.stock.toMoves')}>
            {unitTotals(data.stock.quantities, unit, locale)}
          </Link>
          <span className="fw-st-sub">{data.stock.hides > 0 ? t('lc.stock.linesHides', { lines: t('lc.stock.lines', { count: data.stock.lines }), hides: stock('hides', { count: data.stock.hides }) }) : t('lc.stock.lines', { count: data.stock.lines })}</span>
        </span>
      )
    }
    const InsideCell = ({ data }: ICellRendererParams<PlaceRow>) => (data ? <span className="fw-st-num">{data.inside > 0 ? t('lc.inside', { count: data.inside }) : '—'}</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<PlaceRow>) => {
      if (!data) return null
      const active = data.location.status === 'ACTIVE'
      const held = (key: string | null) => (key ? t(key, data.archiveParams) : undefined)
      const place = data.location as PlaceView
      const blocked = placeStatus(place) === 'BLOCKED'
      const blockHeld = blockHeldOf(place, model.can)
      const labelHeld = labelRefusalOf(place)
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('lc.rowMenu', { code: data.location.code }) }}
          items={[
            { id: 'open', label: stock('common.open'), href: recordHref(data.location) },
            ...(model.can.manage
              ? [
                  { id: 'inside', label: t('lc.menu.newInside'), disabled: !active, description: active ? undefined : t('lc.held.archived'), onSelect: () => setDialog({ kind: 'new', parentId: data.location.id }) },
                  { id: 'move', label: t('lc.menu.move'), disabled: !active, description: active ? undefined : t('lc.held.archived'), onSelect: () => setDialog({ kind: 'move', locationId: data.location.id }) },
                  { id: 'archive', label: t('lc.menu.archive'), tone: 'danger' as const, disabled: !!data.archiveHeld, description: held(data.archiveHeld), onSelect: () => setDialog({ kind: 'archive', locationId: data.location.id }) },
                  // B-W2b-327 (design lc-tree row ⋯ "Block (W2b)"): block, change the block, or unblock.
                  { id: 'block', label: w(blocked ? 'wd.loc.menu.changeBlock' : 'wd.loc.menu.block'), icon: <Lock size={14} aria-hidden />, disabled: !!blockHeld, description: blockHeld ? w(blockHeld.key, blockHeld.params) : undefined, onSelect: () => setDepthDialog({ kind: 'block', locationId: place.id }) },
                  ...(blocked ? [{ id: 'unblock', label: w('wd.loc.menu.unblock'), icon: <Unlock size={14} aria-hidden />, disabled: !!blockHeld, description: blockHeld ? w(blockHeld.key, blockHeld.params) : undefined, onSelect: () => setDepthDialog({ kind: 'unblock', locationId: place.id }) }] : []),
                ]
              : []),
            { id: 'label', label: w('wd.loc.menu.printLabel'), icon: <Printer size={14} aria-hidden />, disabled: !!labelHeld, description: labelHeld ? w(labelHeld) : undefined, onSelect: () => actions?.onPrint?.([place]) },
            ...(data.stock && data.stock.lines > 0 ? [{ id: 'moves', label: t('lc.menu.moves'), href: movesHref(model.prefix, { siteId: data.location.siteId, locationId: data.location.id }) }] : []),
          ]}
        />
      )
    }
    return [
      { colId: 'place', headerName: t('lc.col.place'), minWidth: 240, flex: 2, cellRenderer: NameCell },
      { colId: 'code', headerName: t('lc.col.code'), minWidth: 140, flex: 1, cellRenderer: CodeCell },
      { colId: 'kind', headerName: t('lc.col.kind'), minWidth: 130, flex: 0.9, valueGetter: (params) => (params.data ? stock(`locationKind.${params.data.location.kind}`) : '') },
      { colId: 'status', headerName: t('lc.col.status'), minWidth: 150, flex: 0.8, cellRenderer: StatusCell },
      { colId: 'defaults', headerName: w('wd.loc.col.defaults'), minWidth: 140, flex: 0.9, cellRenderer: DefaultCell },
      { colId: 'label', headerName: w('wd.loc.col.label'), minWidth: 130, flex: 0.8, cellRenderer: LabelCell },
      ...(model.can.stock ? [{ colId: 'stock', headerName: t('lc.col.stock'), minWidth: 180, flex: 1.3, cellRenderer: StockCell } satisfies ColDef<PlaceRow>] : []),
      { colId: 'inside', headerName: t('lc.col.inside'), minWidth: 120, flex: 0.6, cellRenderer: InsideCell },
      { colId: 'more', headerName: '', headerTooltip: stock('common.more'), minWidth: 64, maxWidth: 64, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, w, stock, locale, model.prefix, model.can, model.defaults])

  if (!model.can.view) return <NoAccess permission="inventory.locations.view" />

  const picked = rows.filter((row) => selected.includes(row.location.id))
  const search = (
    <Input
      size="sm"
      type="search"
      leadingIcon={<Search size={13} aria-hidden />}
      aria-label={t('lc.search')}
      placeholder={t('lc.search')}
      value={query}
      onChange={(event) => {
        typed.current = true
        setQuery(event.target.value)
      }}
    />
  )
  const tools = (
    <label className="fw-lc-switch">
      <Toggle size="sm" checked={model.address.archived} onChange={(next) => actions?.onArchived?.(next)} aria-label={t('lc.showArchived')} />
      <span>{t('lc.showArchived')}</span>
    </label>
  )
  const right = (
    <Menu
      label={<MoreHorizontal size={16} aria-hidden />}
      align="right"
      triggerProps={{ 'aria-label': stock('common.more') }}
      items={[
        ...(model.can.importer ? [{ id: 'import', label: t('lc.import'), icon: <FolderInput size={14} aria-hidden />, href: `${model.prefix}/admin/import?importer=inventory.locations` }] : []),
        { id: 'export', label: t('lc.exportAll', { count: rows.length }), icon: <Download size={14} aria-hidden />, disabled: rows.length === 0, onSelect: () => actions?.onExport?.(rows) },
      ]}
    />
  )

  let state = null
  if (model.sites.status === 'error') state = <ReadFailed problem={model.sites.problem} onRetry={actions?.onRetry} />
  else if (model.sites.status === 'ready' && model.sites.items.length === 0) state = <EmptyState icon={<MapPin size={22} aria-hidden />} title={t('lc.noSites.title')} description={t('lc.noSites.body')} />
  else if (model.site && all.length === 0)
    state = (
      <EmptyState
        icon={<MapPin size={22} aria-hidden />}
        title={t('lc.empty.title')}
        description={model.can.manage ? t('lc.empty.body') : t('lc.empty.bodyView')}
        action={
          model.can.manage ? (
            <span className="fw-st-actions">
              <Button size="sm" variant="primary" onClick={() => setDialog({ kind: 'new', parentId: null })}>
                <Plus size={13} aria-hidden /> {t('lc.new.button')}
              </Button>
              {model.can.importer && (
                <Button size="sm" asChild>
                  <Link href={`${model.prefix}/admin/import?importer=inventory.locations`}>{t('lc.import')}</Link>
                </Button>
              )}
            </span>
          ) : undefined
        }
      />
    )
  else if (model.site && rows.length === 0)
    state = (
      <EmptyState
        title={stock('common.noMatch')}
        action={
          <Button size="sm" onClick={() => setQuery('')}>
            {stock('common.clearFilters')}
          </Button>
        }
      />
    )

  const sites = model.sites.status === 'ready' ? model.sites.items : []
  const loading = model.sites.status === 'loading'
  const active = all.filter((row) => row.location.status === 'ACTIVE').length

  return (
    <div className="fw-st">
      <div className="fw-st-head">
        <span className="fw-st-sub" role="status">
          {model.asOf ? stock('live.updated', { time: formatTime(model.asOf, place) }) : '—'}
          {' · '}
          {stock(`live.${model.live}`)}
          {!model.can.stock ? ` · ${t('lc.stock.noAccess')}` : ''}
        </span>
        <span className="fw-st-actions">
          {sites.length > 1 && (
            <Select size="sm" aria-label={stock('common.site')} value={model.site?.id ?? ''} onChange={(event) => actions?.onSite?.(event.target.value)}>
              {sites.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {`${entry.code} · ${entry.name}`}
                </option>
              ))}
            </Select>
          )}
          {/* B-W2b-327 (design page.h "Print labels (W2b)"): selection-aware — the selected places print. */}
          <Button size="sm" heldReason={printStartHeldKey(picked.length) ? w(printStartHeldKey(picked.length)!) : null} onClick={() => actions?.onPrint?.(picked.map((row) => row.location as PlaceView))}>
            <Printer size={14} aria-hidden /> {w('wd.loc.print.band')}
          </Button>
          {model.can.manage && (
            <Button size="sm" variant="primary" heldReason={model.site ? null : t('lc.held.noSite')} onClick={() => setDialog({ kind: 'new', parentId: null })} aria-keyshortcuts="c">
              <Plus size={14} aria-hidden /> {t('lc.new.button')}
            </Button>
          )}
        </span>
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={model.notice.key.startsWith('wd.') ? w(model.notice.key, model.notice.params) : t(model.notice.key, model.notice.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('lc.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}
      {model.can.stock && model.stock.problem && <ReadFailed problem={model.stock.problem} onRetry={actions?.onRetry} />}

      <ListFrame<PlaceRow>
        label={t('lc.tableLabel', { site: siteName })}
        rows={loading ? null : rows}
        rowId={(row) => row.location.id}
        columns={columns}
        count={loading ? '—' : query.trim() ? t('lc.countOf', { shown: rows.length, count: all.length }) : t('lc.count', { count: all.length, active })}
        search={search}
        tools={tools}
        right={right}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <>
              <Button size="sm" aria-label={t('lc.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked)}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('lc.export', { count: picked.length })}</SelectionLabel>
              </Button>
              <Button size="sm" aria-label={w('wd.loc.print.bulk', { count: picked.length })} onClick={() => actions?.onPrint?.(picked.map((row) => row.location as PlaceView))}>
                <Printer size={13} aria-hidden /> <SelectionLabel>{w('wd.loc.print.bulk', { count: picked.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        onOpen={(row) => actions?.onOpen?.(row.location)}
        state={state}
        rowKind="two-line"
      />

      {model.site && (
        <DepthDialogs
          dialog={depthDialog}
          places={model.site.locations as PlaceView[]}
          today={model.today ?? new Date().toISOString().slice(0, 10)}
          onClose={() => setDepthDialog(null)}
          actions={{
            onBlock: async (place, draft) => {
              const answer = (await actions?.onBlock?.(place, draft)) ?? null
              if (!answer) setDepthDialog(null)
              return answer
            },
            onUnblock: async (place) => {
              const answer = (await actions?.onUnblock?.(place)) ?? null
              if (!answer) setDepthDialog(null)
              return answer
            },
          }}
        />
      )}
      {model.print && <PrintDialog model={model.print} can={{ printLabels: deep.printLabels, manage: model.can.manage }} actions={printActions} />}

      {model.site && (
        <LocationDialogs
          dialog={dialog}
          locations={model.site.locations}
          siteName={siteName}
          onClose={() => setDialog(null)}
          parties={model.parties ?? null}
          partiesAllowed={deep.parties}
          onParties={actions?.onParties}
          actions={{
            onCreate: async (form) => {
              const answer = (await actions?.onCreate?.(form)) ?? null
              if (!answer) setDialog(null)
              return answer
            },
            onMove: async (location, parentId) => {
              const answer = (await actions?.onMove?.(location, parentId)) ?? null
              if (!answer) setDialog(null)
              return answer
            },
            onArchive: async (location) => {
              const answer = (await actions?.onArchive?.(location)) ?? null
              if (!answer) setDialog(null)
              return answer
            },
          }}
        />
      )}

      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('lc.keys.title')} size="sm">
          <ul className="fw-lc-keys">
            {listKeys(ownKeys, true).map((entry) => (
              <li key={entry.does}>
                <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  )
}
