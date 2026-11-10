'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Archive, ArchiveRestore, MoreHorizontal, Plus, Search, Stamp } from 'lucide-react'
import { Banner, Field, Menu, MetricStrip } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Tag, TokenChip } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { recordAddress } from '../../../../lib/records/record-links'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import type { ListEdit } from '../../../../list-frame/w2b/model'
import { WithMessages } from '../../../../record-panels/i18n'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { Swatch } from '../../_shared/Swatch'
import { isPageKey, keepLoaded } from '../../library/model'
import { Freshness, KeysDialog, listState, PageHead, showsState } from '../../library/parts'
import type { Notice } from '../../library/model'
import { archiveHeldKey, archiveReach, COLOUR_SYSTEMS, COLOUR_VIEWS, isFiltered, NO_FILTERS, otherNames, pageNotices, pictureAddress, restoreHeldKey, STATUS_TONE, type ColourLibraryRow, type ColourNotice, type ColourSystem } from '../model'
import type { ColoursActions, ColoursViewModel } from '../view-model'
import { BrandingSection } from './BrandingSection'
import { BrandingSetModal } from './BrandingSetModal'
import { ColourFormDialog } from './ColourFormDialog'
import { NewSetDialog } from './NewSetDialog'
import '../../library/library.css'
import '../colours.css'

export type { ColoursViewModel, ColoursActions } from '../view-model'

/** The page's catalogues: its own words, the libraries' shared words (problems, common), the list frame's. */
export function ColoursMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={['products-colours', 'library', 'lists']}>{children}</WithMessages>
}

/**
 * SCR-118 — Colours & artwork (Products › Libraries; design products.colours, workspace-list): the saved-filter tiles
 * (Unused colours puts its chip in the filter row; Branding sets narrows the sets to those in use), the notices (one Banner,
 * the most serious; the rest behind "N more notices"; a dismissal kept by value), the colour library on the shared list
 * frame (select-all, shift range, x; Archive N, Restore N, Export N; inline edit of name, system, reference, family and hex,
 * saved per cell; ⋯ per row; keys only in the footer's information icon; `c` a new colour), and the branding sets of
 * private-label customers (a row opens its DetailModal). It fetches nothing.
 */
export function ColoursView({ model, actions }: { model: ColoursViewModel; actions?: ColoursActions }) {
  return (
    <ColoursMessages>
      <Colours model={model} actions={actions} />
    </ColoursMessages>
  )
}

function Colours({ model, actions }: { model: ColoursViewModel; actions?: ColoursActions }) {
  const t = useT('products-colours')
  const tl = useT('library')
  const systemWord = useCallback((system: ColourSystem) => t(`system.${system}`), [t])
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
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const [dialog, setDialog] = useState<'archive' | 'restore' | 'help' | null>(model.dialog === 'archiveSets' ? null : (model.dialog ?? null))
  const [noticesOpen, setNoticesOpen] = useState(model.noticesOpen ?? false)
  const items = model.rows.items
  const rowsKey = items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => keepLoaded(current, items)), [rowsKey])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const brandingRef = useRef<HTMLElement>(null)

  // c: a new colour (design kb "c — new colour row") — never while typing or inside a dialog.
  const anyDialog = !!(model.colourForm || model.setModal || model.newSet || dialog)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || anyDialog) return
      if (event.key === 'c' && model.can.colours) {
        event.preventDefault()
        actions?.onColourForm?.('new')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const panelsHref = useCallback((row: ColourLibraryRow) => `${model.prefix}${recordAddress({ type: 'Colour', id: row.id, label: row.code, companyId: row.companyId }, OFFICE_PAGES)}`, [model.prefix])
  const picked = (items ?? []).filter((row) => selected.includes(row.id))
  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('keys.new') }]
  const noHex = t('swatch.noHex')

  const columns = useMemo<ColDef<ColourLibraryRow>[]>(() => {
    const SwatchCell = ({ data }: ICellRendererParams<ColourLibraryRow>) => (data ? <Swatch hex={data.hex} name={`${data.code} · ${data.name}`} size="md" noHex={noHex} /> : null)
    const CodeCell = ({ data }: ICellRendererParams<ColourLibraryRow>) =>
      data ? (
        <span className="fw-lib-cell">
          <Link className="fw-lib-rowlink" href={panelsHref(data)}>
            {data.code}
          </Link>
          <span className="fw-lib-sub">{data.companyId ? t('list.ofCompany') : t('list.everyCompany')}</span>
        </span>
      ) : null
    const NameCell = ({ data }: ICellRendererParams<ColourLibraryRow>) =>
      data ? (
        <span className="fw-lib-cell">
          <span>{data.name}</span>
          {otherNames(data).length > 0 && <span className="fw-lib-sub">{otherNames(data).map((entry) => `${entry.locale} ${entry.name}`).join(' · ')}</span>}
        </span>
      ) : null
    const SystemCell = ({ data }: ICellRendererParams<ColourLibraryRow>) => (data ? data.system ? <Tag tone="info">{systemWord(data.system)}</Tag> : <span className="fw-lib-hint">—</span> : null)
    const ReferenceCell = ({ data }: ICellRendererParams<ColourLibraryRow>) => (data ? <span className={data.reference ? 'fw-col-mono' : 'fw-lib-hint'}>{data.reference ?? '—'}</span> : null)
    const HexCell = ({ data }: ICellRendererParams<ColourLibraryRow>) => (data ? <span className={data.hex ? 'fw-col-mono' : 'fw-lib-hint'}>{data.hex ?? t('list.noHex')}</span> : null)
    const PhotoCell = ({ data }: ICellRendererParams<ColourLibraryRow>) => {
      if (!data) return null
      const src = pictureAddress(data.photo?.url)
      return src ? <img className="fw-col-photo" src={src} alt={t('list.photoOf', { code: data.code })} loading="lazy" /> : <span className="fw-lib-hint">—</span>
    }
    const count = (value: number | null) => (value === null ? <span className="fw-lib-hint" title={t('use.notInRole')}>—</span> : value === 0 ? <span className="fw-lib-hint">0</span> : <span>{value}</span>)
    const MaterialsCell = ({ data }: ICellRendererParams<ColourLibraryRow>) => (data ? count(data.use.materialColours) : null)
    const WaysCell = ({ data }: ICellRendererParams<ColourLibraryRow>) => (data ? count(data.use.colourways) : null)
    const SetsCell = ({ data }: ICellRendererParams<ColourLibraryRow>) => (data ? count(data.use.brandingSets) : null)
    const StatusCell = ({ data }: ICellRendererParams<ColourLibraryRow>) =>
      data ? (
        <span className="fw-lib-cell">
          <Pill tone={STATUS_TONE[data.status]}>{t(`status.${data.status}`)}</Pill>
          {data.status === 'ACTIVE' && !data.use.inUse && <span className="fw-lib-sub">{t('use.unused')}</span>}
          {data.use.inUse && (data.use.colourways ?? 0) + (data.use.materialColours ?? 0) + (data.use.brandingSets ?? 0) === 0 && <span className="fw-lib-sub">{t('use.elsewhere')}</span>}
        </span>
      ) : null
    const MoreCell = ({ data }: ICellRendererParams<ColourLibraryRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { code: data.code }) }}
          items={[
            ...(model.can.colours && data.status === 'ACTIVE' ? [{ id: 'edit', label: t('list.edit'), onSelect: () => actions?.onColourForm?.('edit', data) }] : []),
            { id: 'panels', label: t('list.openPanels'), href: panelsHref(data) },
            ...(model.can.colours
              ? [
                  data.status === 'ACTIVE'
                    ? { id: 'archive', label: t('list.archive'), onSelect: () => (setSelected([data.id]), setDialog('archive')) }
                    : { id: 'restore', label: t('list.restore'), onSelect: () => (setSelected([data.id]), setDialog('restore')) },
                ]
              : []),
            {
              id: 'copy',
              label: tl('list.copyCode'),
              onSelect: () => {
                void navigator.clipboard?.writeText(data.code).catch(() => undefined)
              },
            },
          ]}
        />
      ) : null
    return [
      { colId: 'swatch', headerName: t('col.swatch'), minWidth: 112, maxWidth: 120, sortable: false, cellRenderer: SwatchCell },
      { colId: 'code', headerName: t('col.code'), field: 'code', minWidth: 140, flex: 1, cellRenderer: CodeCell },
      { colId: 'name', headerName: t('col.name'), field: 'name', minWidth: 170, flex: 1.6, cellRenderer: NameCell },
      { colId: 'system', headerName: t('col.system'), field: 'system', cellDataType: false, minWidth: 110, flex: 0.7, cellRenderer: SystemCell },
      { colId: 'reference', headerName: t('col.reference'), field: 'reference', cellDataType: false, minWidth: 140, flex: 1, cellRenderer: ReferenceCell },
      { colId: 'family', headerName: t('col.family'), field: 'family', cellDataType: false, minWidth: 110, flex: 0.8 },
      { colId: 'hex', headerName: t('col.hex'), field: 'hex', cellDataType: false, minWidth: 140, flex: 0.7, cellRenderer: HexCell },
      { colId: 'photo', headerName: t('col.photo'), minWidth: 76, maxWidth: 96, sortable: false, cellRenderer: PhotoCell },
      { colId: 'materials', headerName: t('col.materials'), minWidth: 156, flex: 0.6, type: 'rightAligned', cellRenderer: MaterialsCell },
      { colId: 'colourways', headerName: t('col.colourways'), minWidth: 156, flex: 0.6, type: 'rightAligned', cellRenderer: WaysCell },
      { colId: 'sets', headerName: t('col.sets'), minWidth: 136, flex: 0.6, type: 'rightAligned', cellRenderer: SetsCell },
      { colId: 'status', headerName: t('col.status'), field: 'status', minWidth: 136, flex: 0.7, cellRenderer: StatusCell },
      { colId: 'more', headerName: tl('list.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, tl, panelsHref, systemWord, noHex, model.can.colours, actions])

  // Inline edit of every simple field, saved per cell through the list's bulk target (product.colours.manage).
  const archivedHeld = (row: ColourLibraryRow) => (row.status === 'ARCHIVED' ? t('held.archived') : null)
  const edit: ListEdit<ColourLibraryRow> = {
    fields: {
      name: { kind: 'text', maxLength: 120, valueOf: (row) => row.name, held: archivedHeld },
      system: { kind: 'choice', nullable: true, choices: COLOUR_SYSTEMS, choiceLabels: Object.fromEntries(COLOUR_SYSTEMS.map((system) => [system, systemWord(system)])), valueOf: (row) => row.system, held: archivedHeld },
      reference: { kind: 'text', nullable: true, maxLength: 40, valueOf: (row) => row.reference, held: archivedHeld },
      family: { kind: 'text', nullable: true, maxLength: 40, valueOf: (row) => row.family, held: archivedHeld },
      hex: { kind: 'text', nullable: true, maxLength: 20, valueOf: (row) => row.hex, held: archivedHeld },
    },
    versionOf: (row) => row.version,
    labelOf: (row) => row.code,
    onSaved: (id, after, version) => actions?.onSaved?.(id, after, version),
    bulk: { noun: { one: t('list.noun_one'), other: t('list.noun_other') } },
    held: model.can.colours ? null : t('held.noColours'),
  }

  const filtered = isFiltered(model.filters)
  const state = showsState(model.rows.problem, items)
    ? listState({
        problem: model.rows.problem,
        rows: items,
        filtered,
        forbidden: { title: t('forbidden.title'), body: t('forbidden.body') },
        empty: {
          title: t('empty.title'),
          body: t(model.can.colours ? 'empty.body' : 'empty.bodyView'),
          action: model.can.colours ? (
            <Button size="sm" variant="primary" onClick={() => actions?.onColourForm?.('new')}>
              {t('empty.create')}
            </Button>
          ) : undefined,
        },
        onRetry: () => actions?.onRetry?.(),
        onClear: () => actions?.onFilters?.({ ...NO_FILTERS, sets: model.filters.sets }),
      })
    : undefined

  const notices = pageNotices(model.rows.ignored, model.counts, new Set(model.dismissed))
  const tile = (value: number | undefined): string => (model.counts && value !== undefined ? String(value) : '—')
  const archiveHeld = archiveHeldKey(picked, model.can)
  const restoreHeld = restoreHeldKey(picked, model.can)
  const ignored = new Set(model.rows.ignored)

  return (
    <div className="fw-lib fw-col">
      <PageHead
        intro={t('page.intro')}
        status={<Freshness asOf={model.asOf} />}
        actions={
          <>
            <Button size="sm" heldReason={model.can.branding ? null : t('held.noBranding')} onClick={() => actions?.onNewSet?.(true)}>
              <Stamp size={14} aria-hidden /> {t('sets.new')}
            </Button>
            <Button size="sm" variant="primary" heldReason={model.can.colours ? null : t('held.noColours')} onClick={() => actions?.onColourForm?.('new')} aria-keyshortcuts="c">
              <Plus size={14} aria-hidden /> {t('page.new')}
            </Button>
          </>
        }
      />

      <ResultBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />

      {notices.length > 0 && (
        <div className="fw-col-notices" aria-label={t('notice.label')}>
          {(noticesOpen ? notices : notices.slice(0, 1)).map((notice) => (
            <NoticeView key={`${notice.kind}:${notice.value}`} notice={notice} model={model} actions={actions} />
          ))}
          {notices.length > 1 && (
            <Button size="sm" variant="quiet" aria-expanded={noticesOpen} onClick={() => setNoticesOpen((open) => !open)}>
              {noticesOpen ? t('notice.fewer') : t('notice.more', { count: notices.length - 1 })}
            </Button>
          )}
        </div>
      )}

      <MetricStrip
        metrics={[
          {
            label: t('tile.unused'),
            value: model.countsFailed ? '—' : tile(model.counts?.tiles.unused),
            hint: model.countsFailed ? t('tile.failed') : t('tile.unusedHint'),
            onClick: () => actions?.onFilters?.({ ...model.filters, view: model.filters.view === 'unused' ? 'active' : 'unused' }),
            active: model.filters.view === 'unused',
          },
          {
            label: t('tile.sets'),
            value: model.countsFailed ? '—' : tile(model.counts?.tiles.brandingSets),
            hint: model.countsFailed ? t('tile.failed') : t('tile.setsHint'),
            onClick: () => {
              actions?.onFilters?.({ ...model.filters, sets: model.filters.sets === 'active' ? 'all' : 'active' })
              brandingRef.current?.focus()
            },
            active: model.filters.sets === 'active',
          },
        ]}
      />

      {filtered && (
        <div className="fw-lib-chips" aria-label={tl('list.activeFilters')}>
          {model.filters.view !== 'active' && (
            <TokenChip removeLabel={tl('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, view: 'active' })}>
              {t(`view.${model.filters.view}`)}
            </TokenChip>
          )}
          {model.filters.system && (
            <TokenChip removeLabel={tl('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, system: '' })}>
              {ignored.has(`system=${model.filters.system}`) ? t('filter.ignored', { value: model.filters.system }) : t('filter.system', { system: (COLOUR_SYSTEMS as readonly string[]).includes(model.filters.system) ? systemWord(model.filters.system as ColourSystem) : model.filters.system })}
            </TokenChip>
          )}
          {model.filters.family && (
            <TokenChip removeLabel={tl('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, family: '' })}>
              {ignored.has(`family=${model.filters.family}`) ? t('filter.ignored', { value: model.filters.family }) : t('filter.family', { family: model.filters.family })}
            </TokenChip>
          )}
          {model.filters.q.trim() && (
            <TokenChip removeLabel={tl('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, q: '' })}>
              {tl('list.chipSearch', { q: model.filters.q.trim() })}
            </TokenChip>
          )}
          <Button size="sm" variant="quiet" onClick={() => actions?.onFilters?.({ ...NO_FILTERS, sets: model.filters.sets })}>
            {tl('list.clearAll')}
          </Button>
        </div>
      )}

      <ListFrame<ColourLibraryRow>
        label={t('list.label')}
        title={t('list.title')}
        rows={state ? [] : items}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? tl(model.rows.more ? 'list.countMore' : 'list.count', { count: items.length, total: model.rows.count ?? items.length }) : '—'}
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
            <Select size="sm" aria-label={t('filter.view')} value={model.filters.view} onChange={(event) => actions?.onFilters?.({ ...model.filters, view: event.target.value as ColoursViewModel['filters']['view'] })}>
              {COLOUR_VIEWS.map((view) => (
                <option key={view} value={view}>
                  {t(`view.${view}`)}
                </option>
              ))}
            </Select>
            <Select size="sm" aria-label={t('filter.systemLabel')} value={(COLOUR_SYSTEMS as readonly string[]).includes(model.filters.system) ? model.filters.system : ''} onChange={(event) => actions?.onFilters?.({ ...model.filters, system: event.target.value })}>
              <option value="">{t('filter.allSystems')}</option>
              {COLOUR_SYSTEMS.map((system) => (
                <option key={system} value={system}>
                  {systemWord(system)}
                </option>
              ))}
            </Select>
            <Select size="sm" aria-label={t('filter.familyLabel')} value={model.rows.families.includes(model.filters.family) ? model.filters.family : ''} onChange={(event) => actions?.onFilters?.({ ...model.filters, family: event.target.value })}>
              <option value="">{t('filter.allFamilies')}</option>
              {model.rows.families.map((family) => (
                <option key={family} value={family}>
                  {family}
                </option>
              ))}
            </Select>
          </>
        }
        selection={{
          selected,
          onChange: setSelected,
          exportSelected: true,
          actions: (
            <>
              <Button size="sm" aria-label={t('bulk.restore', { count: picked.length })} heldReason={restoreHeld ? t(restoreHeld) : null} onClick={() => setDialog('restore')}>
                <ArchiveRestore size={13} aria-hidden /> <SelectionLabel>{t('bulk.restore', { count: picked.length })}</SelectionLabel>
              </Button>
              <Button size="sm" variant="danger-outline" aria-label={t('bulk.archive', { count: picked.length })} heldReason={archiveHeld ? t(archiveHeld) : null} onClick={() => setDialog('archive')}>
                <Archive size={13} aria-hidden /> <SelectionLabel>{t('bulk.archive', { count: picked.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        edit={edit}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.rows.more && items && items.length > 0 ? { label: tl('list.more'), onMore: () => actions?.onMore?.() } : null}
        keys={ownKeys}
        onHelp={() => setDialog('help')}
        onOpen={(row) => actions?.onOpenColour?.(row)}
        state={state}
        focusRow={model.focusRow}
      />

      <BrandingSection model={model} actions={actions} sectionRef={brandingRef} />

      {model.colourForm && <ColourFormDialog form={model.colourForm} can={model.can} actions={actions} />}
      {model.setModal && <BrandingSetModal modal={model.setModal} model={model} actions={actions} />}
      {model.newSet && <NewSetDialog form={model.newSet} model={model} actions={actions} />}
      {(dialog === 'archive' || dialog === 'restore') && (
        <ArchiveDialog to={dialog} rows={picked} busy={model.busy} actions={actions} onDone={() => setSelected([])} onClose={() => setDialog(null)} />
      )}
      {dialog === 'help' && <KeysDialog keys={listKeys(ownKeys, true)} onClose={() => setDialog(null)} />}
    </div>
  )
}

/** What the last action did: this page's words, or a problem in the libraries' words (`problem.*`); Dismiss. */
function ResultBanner({ notice, onDismiss }: { notice: Notice | null; onDismiss?: () => void }) {
  const t = useT('products-colours')
  const tl = useT('library')
  if (!notice) return null
  const words = notice.key.startsWith('problem.') ? tl(notice.key, notice.params) : t(notice.key, notice.params)
  return (
    <Banner
      tone={notice.tone}
      title={words}
      action={
        onDismiss ? (
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            {t('notice.dismiss')}
          </Button>
        ) : undefined
      }
    />
  )
}

/** One notice of the page: its words from its kind and value, its action, Dismiss (kept by value). */
function NoticeView({ notice, model, actions }: { notice: ColourNotice; model: ColoursViewModel; actions?: ColoursActions }) {
  const t = useT('products-colours')
  const key = `${notice.kind}:${notice.value}`
  const dismiss = (
    <Button size="sm" variant="quiet" onClick={() => actions?.onDismiss?.(key)}>
      {t('notice.dismiss')}
    </Button>
  )
  if (notice.kind === 'IGNORED_FILTER') {
    const [term] = notice.value.split('=')
    return (
      <Banner tone="warning" title={t('notice.ignored.title', { value: notice.value })} action={
        <Button size="sm" variant="quiet" onClick={() => actions?.onFilters?.({ ...model.filters, ...(term === 'system' ? { system: '' } : { family: '' }) })}>
          {t('notice.ignored.remove')}
        </Button>
      }>
        {t('notice.ignored.body')}
      </Banner>
    )
  }
  if (notice.kind === 'BRANDS_WITHOUT_SET') {
    const brands = model.counts?.brandsWithoutSet.brands ?? []
    return (
      <Banner
        tone="warning"
        title={t('notice.brands.title', { count: notice.count })}
        action={
          <span className="fw-lib-actions">
            {model.can.branding && (
              <Button size="sm" onClick={() => actions?.onNewSet?.(true)}>
                {t('sets.new')}
              </Button>
            )}
            {dismiss}
          </span>
        }
      >
        {brands.map((brand) => t('notice.brands.one', { code: brand.code, name: brand.name, count: brand.styles })).join(' · ')}
      </Banner>
    )
  }
  return (
    <Banner tone="info" title={t('notice.noHex.title', { count: notice.count })} action={dismiss}>
      {t('notice.noHex.body')}
    </Banner>
  )
}

/** Archive or restore the chosen colours: what it does (what names one keeps it), one reason for all. */
function ArchiveDialog({ to, rows, busy, actions, onDone, onClose }: { to: 'archive' | 'restore'; rows: readonly ColourLibraryRow[]; busy: boolean; actions?: ColoursActions; onDone: () => void; onClose: () => void }) {
  const t = useT('products-colours')
  const tl = useT('library')
  const [reason, setReason] = useState('')
  const chosen = rows.filter((row) => row.status === (to === 'archive' ? 'ACTIVE' : 'ARCHIVED'))
  const reach = archiveReach(rows)
  const held = chosen.length === 0 ? t(to === 'archive' ? 'held.noneActive' : 'held.noneArchived') : busy ? tl('held.busy') : null
  const go = () => {
    if (held) return
    void actions?.onArchiveColours?.(chosen.map((row) => row.id), to, reason.trim()).then((done) => {
      if (done) {
        onDone()
        onClose()
      }
    })
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t(to === 'archive' ? 'archive.title' : 'restore.title', { count: chosen.length })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{tl('common.back')}</Button>
          <Button variant={to === 'archive' ? 'danger' : 'primary'} heldReason={held} onClick={go}>
            {t(to === 'archive' ? 'bulk.archive' : 'bulk.restore', { count: chosen.length })}
          </Button>
        </>
      }
    >
      <div className="fw-lib-dialog">
        <ul className="fw-lib-list">
          {to === 'archive' ? (
            <>
              <li>{t('archive.reach')}</li>
              {reach.inUse > 0 && <li>{t('archive.inUse', { count: reach.inUse })}</li>}
              <li>{t('archive.back')}</li>
            </>
          ) : (
            <li>{t('restore.reach')}</li>
          )}
        </ul>
        <ul className="fw-lib-list">
          {chosen.map((row) => (
            <li key={row.id} className="fw-col-li">
              <Swatch hex={row.hex} name={row.name} code={row.code} withText noHex={t('swatch.noHex')} />
            </li>
          ))}
        </ul>
        <Field label={tl('dialog.reason')} hint={tl('dialog.reasonHint')}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} />
        </Field>
      </div>
    </Modal>
  )
}
