'use client'

import { useEffect, useMemo, useRef } from 'react'
import Link from 'next/link'
import { Download, MoreHorizontal, Plus, Search, Tag as TagIcon, X } from 'lucide-react'
import { EmptyState, Menu, MetricStrip, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Skeleton, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { isPageKey } from '../../../quality/_shared/hooks'
import { Freshness, NoAccess, NoticeBanner, PageHead } from '../../../quality/_shared/parts'
import type { LabelTemplate } from '../api'
import { classWords, LABEL_TILES, LABEL_VIEWS, labelHref, LIST_CAP, mmWords, tileCounts, viewRows, type LabelView } from '../model'
import { carriesGpsr, KIND_TONE, kindOf, NO_DEPTH, phraseLibraryHref } from '../depth/model'
import type { LabelsListActions, LabelsListModel } from '../view-model'
import { NewLabelDialog } from './NewLabelDialog'
import { LabelsMessages, ShortcutsDialog, StatusPill, useListWords } from './parts'

export type { LabelsListActions, LabelsListModel } from '../view-model'

/**
 * SCR-053 Labels & marking (design compliance.labels W1: lb-metrics, lb-grid, lb-new): the PPE garment labels on the ONE
 * list frame (Owner rule 2026-10-29) — count, search, Rows ▾ and the chips, swapped for Export N while rows are
 * selected; the header select-all box and shift-click ranges; the footer with the keys icon — and the tiles, each a
 * saved view. A label opens its record (the builder, its versions and test prints). New label (`c`) asks for the style
 * (or a shared code), what to start from, the languages and the size. Fetches nothing: LabelsPage.tsx reads and writes.
 */
export function LabelsListView({ model, actions }: { model: LabelsListModel; actions?: LabelsListActions }) {
  return (
    <LabelsMessages>
      <Labels model={model} actions={actions} />
    </LabelsMessages>
  )
}

function Labels({ model, actions }: { model: LabelsListModel; actions?: LabelsListActions }) {
  const t = useT('labels')
  const d = useT('compliance-labels-depth')
  const q = useT('quality')
  const lists = useListWords()
  const can = model.can
  const depth = model.depth ?? NO_DEPTH
  const all = useMemo(() => model.rows.value ?? [], [model.rows.value])
  const rows = useMemo(() => viewRows(all, model.view, model.query, depth), [all, model.view, model.query, depth])
  const selectedRows = rows.filter((row) => model.selected.includes(row.id))
  const manageHeld = can.manage ? null : t('held.noManage')

  // c: New label (the frame keeps / j k x ↵ ?); never while typing, in a menu or a dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'c' || model.newLabel || model.shortcuts || !can.manage || !isPageKey(event)) return
      event.preventDefault()
      actions?.onNewLabel?.(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions, can.manage, model.newLabel, model.shortcuts])

  const live = useRef({ actions })
  live.current = { actions }
  const columns = useMemo<ColDef<LabelTemplate>[]>(() => {
    const LabelCell = ({ data }: ICellRendererParams<LabelTemplate>) =>
      data ? (
        <span className="fw-q-cell">
          <Link className="fw-q-name fw-q-code" href={labelHref(model.prefix, data.id)} tabIndex={-1}>
            {t('list.codeRevision', { code: data.code, revision: data.revision })}
          </Link>
          <span className="fw-q-hint">{data.name}</span>
        </span>
      ) : null
    const StyleCell = ({ data }: ICellRendererParams<LabelTemplate>) =>
      data ? (
        data.style ? (
          <span className="fw-q-cell">
            {can.styles ? (
              <Link className="fw-q-link fw-q-code" href={`${model.prefix}/products/styles/${encodeURIComponent(data.style.id)}?tab=compliance`} tabIndex={-1}>
                {data.style.code}
              </Link>
            ) : (
              <span className="fw-q-code">{data.style.code}</span>
            )}
            <span className="fw-q-hint">{classWords(data.style) ?? t('list.notPpe')}</span>
          </span>
        ) : (
          <span className="fw-q-cell">
            <Tag tone="neutral">{t('list.shared')}</Tag>
            <span className="fw-q-hint">{t('list.sharedHint')}</span>
          </span>
        )
      ) : null
    // B-W2b-270: what the label is (PRD-336) and whether it carries the GPSR contact (PRD-346).
    const KindCell = ({ data }: ICellRendererParams<LabelTemplate>) =>
      data ? (
        <span className="fw-q-cell-row">
          <Tag tone={KIND_TONE[kindOf(data)]}>{d(`kind.${kindOf(data)}`)}</Tag>
          {carriesGpsr(data) && <Tag tone="neutral">{d('kind.gpsr')}</Tag>}
        </span>
      ) : null
    // B-W2b-270: the markets it cannot print for, for want of a language or an approved warning.
    const LanguagesCell = ({ data }: ICellRendererParams<LabelTemplate>) => {
      if (!data) return null
      const gaps = depth.gaps?.get(data.id) ?? []
      return (
        <span className="fw-q-cell">
          <span className="fw-q-code">{data.languages.join(' · ') || '—'}</span>
          {gaps.length > 0 && <span className="fw-q-hint">{d('list.blocks', { markets: gaps.map((gap) => gap.market).join(', ') })}</span>}
        </span>
      )
    }
    const MakerCell = ({ data }: ICellRendererParams<LabelTemplate>) =>
      data ? (
        <span className="fw-q-cell">
          <span>{data.makerName || '—'}</span>
          <span className="fw-q-hint">{data.makerPartyId ? t('list.makerBrand') : t('list.makerCompany')}</span>
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<LabelTemplate>) => (data ? <StatusPill status={data.status} /> : null)
    const ChecksCell = ({ data }: ICellRendererParams<LabelTemplate>) => {
      if (!data) return null
      // B-W2b-270: a proof waiting for a second person's approval.
      const waiting = depth.waiting?.has(data.id) ? <Tag tone="info">{d('list.proofWaiting')}</Tag> : null
      if (data.status !== 'DRAFT')
        return (
          <span className="fw-q-cell-row">
            <span className="fw-q-hint">{t(data.status === 'ACTIVE' ? 'list.frozen' : 'list.retiredHint')}</span>
            {waiting}
          </span>
        )
      return (
        <span className="fw-q-cell-row">
          {data.problems.length === 0 ? <Tag tone="success">{t('list.ready')}</Tag> : <Tag tone="warning">{t('list.problems', { count: data.problems.length })}</Tag>}
          {waiting}
        </span>
      )
    }
    const ActionsCell = ({ data }: ICellRendererParams<LabelTemplate>) =>
      data ? <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('row.menu', { code: data.code, revision: data.revision }) }} items={rowItems(data)} /> : null
    const rowItems = (row: LabelTemplate): MenuItemDef[] => {
      const href = labelHref(model.prefix, row.id)
      const items: MenuItemDef[] = [
        { id: 'open', label: t('row.open'), href },
        { id: 'tab', label: t('row.openNewTab'), href, target: '_blank' },
      ]
      if (row.status === 'ACTIVE') items.push(can.manage ? { id: 'revise', label: t('row.revise'), href: labelHref(model.prefix, row.id, 'act=revise') } : { id: 'revise', label: t('row.revise'), disabled: true, description: t('held.noManage') })
      if (row.status !== 'RETIRED') items.push(can.manage ? { id: 'retire', label: t('row.retire'), href: labelHref(model.prefix, row.id, 'act=retire') } : { id: 'retire', label: t('row.retire'), disabled: true, description: t('held.noManage') })
      items.push({ id: 'copy', label: t('row.copy'), onSelect: () => live.current.actions?.onCopy?.(row.code) })
      return items
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<LabelTemplate>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number }): ColDef<LabelTemplate> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    return [
      column('label', t('list.col.label'), LabelCell, { flex: 1.6, minWidth: 190 }),
      column('kind', d('list.col.kind'), KindCell, { flex: 1, minWidth: 150 }),
      column('style', t('list.col.style'), StyleCell, { flex: 1.4, minWidth: 170 }),
      column('languages', t('list.col.languages'), LanguagesCell, { flex: 0.8, minWidth: 110 }),
      column('maker', t('list.col.maker'), MakerCell, { flex: 1.4, minWidth: 170 }),
      column('status', t('list.col.status'), StatusCell, { flex: 0.8, minWidth: 110 }),
      { colId: 'size', headerName: t('list.col.size'), sortable: false, flex: 0.7, minWidth: 100, valueGetter: (params) => (params.data ? t('list.size', { width: mmWords(params.data.widthMm), height: mmWords(params.data.heightMm) }) : '') },
      column('checks', t('list.col.checks'), ChecksCell, { flex: 1, minWidth: 140 }),
      { ...column('actions', t('list.col.actions'), ActionsCell, { width: 72, minWidth: 72 }), suppressHeaderMenuButton: true },
    ]
    // The W2b reads land after the list: new columns redraw the cells that show them.
  }, [t, d, model.prefix, can.manage, can.styles, depth.waiting, depth.gaps])

  if (!can.view) return <NoAccess title={t('noAccess.title')} body={t('noAccess.body')} />

  const filtered = model.view !== 'all' || model.query.trim() !== ''
  const tiles = tileCounts(model.rows.value, !!model.rows.problem, depth)
  // B-W2b-270's tiles speak from their own catalogue.
  const tileWords = (id: (typeof LABEL_TILES)[number], hint = false) => (id === 'artwork' || id === 'translations' ? d(`tile.${id}${hint ? 'Hint' : ''}`) : t(`tile.${id}${hint ? 'Hint' : ''}`))
  const tile = (id: (typeof LABEL_TILES)[number]) => {
    const entry = tiles[id]
    const active = model.view === id
    return {
      label: tileWords(id),
      value: entry.count === undefined ? <Skeleton width={36} height={22} /> : entry.count === null ? '—' : entry.atLeast ? t('tile.atLeast', { count: entry.count }) : String(entry.count),
      hint: entry.count === null ? t('tile.unknown') : tileWords(id, true),
      active,
      onClick: () => actions?.onView?.(active ? 'all' : id),
    }
  }

  const viewWords = (view: LabelView) => (view === 'artwork' || view === 'translations' ? d(`view.${view}`) : t(`view.${view}`))
  const viewItems: MenuItemDef[] = [{ id: 'heading', heading: true, label: t('list.rowsHeading') }, ...LABEL_VIEWS.map((view) => ({ id: view, label: viewWords(view), checked: model.view === view, onSelect: () => actions?.onView?.(view) }))]
  const moreItems: MenuItemDef[] = [
    // B-W2b-270 (design page.h more): the phrase library the labels' warnings, care and marking words come from.
    { id: 'phrases', label: d('list.phraseLibrary'), href: phraseLibraryHref(model.prefix), description: d('list.phraseLibraryHint') },
    { id: 'export', label: t('list.exportView'), onSelect: () => actions?.onExport?.(rows), disabled: rows.length === 0, description: rows.length === 0 ? t('list.exportNothing') : t('list.exportViewHint', { count: rows.length }) },
    { id: 'sep', separator: true },
    { id: 'keys', label: t('keys.title'), onSelect: () => actions?.onShortcuts?.(true) },
  ]
  const chip = (key: string, label: string, onRemove: () => void) => (
    <FilterChip key={key} pressed onClick={onRemove} aria-label={t('list.removeFilter', { name: label })}>
      {label} <X size={12} aria-hidden />
    </FilterChip>
  )
  const tools = (
    <>
      <Menu label={t('list.rows', { view: viewWords(model.view) })} items={viewItems} />
      {filtered && (
        <span className="fw-q-chips" aria-label={t('list.activeFilters')}>
          {model.view !== 'all' && chip('view', viewWords(model.view), () => actions?.onView?.('all'))}
          {model.query.trim() !== '' && chip('q', `“${model.query.trim()}”`, () => actions?.onQuery?.(''))}
          <Button size="sm" variant="quiet" onClick={() => actions?.onClearAll?.()}>
            {t('list.clearAll')}
          </Button>
        </span>
      )}
    </>
  )

  const bulkActions = (
    <Button size="sm" onClick={() => actions?.onExport?.(selectedRows)} aria-label={t('list.bulkExport', { count: selectedRows.length })}>
      <Download size={13} aria-hidden /> <SelectionLabel>{t('list.bulkExport', { count: selectedRows.length })}</SelectionLabel>
    </Button>
  )

  // B-W2b-270: a W2b view whose own read failed says so (never drawn as an empty list).
  const depthFailed = (model.view === 'artwork' && depth.waitingFailed) || (model.view === 'translations' && depth.gapsFailed)
  const state = depthFailed ? (
    <EmptyState
      title={d(`list.failed.${model.view}`)}
      description={d('list.failed.body')}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {q('common.retry')}
        </Button>
      }
    />
  ) : model.rows.problem ? (
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
        icon={<TagIcon size={24} aria-hidden />}
        title={t('list.empty.title')}
        description={t(can.manage ? 'list.empty.body' : 'list.empty.bodyView')}
        action={
          can.manage ? (
            <Button variant="primary" onClick={() => actions?.onNewLabel?.(true)}>
              {t('list.new')}
            </Button>
          ) : undefined
        }
      />
    )
  ) : undefined

  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('keys.new') }]
  const capped = (model.rows.value?.length ?? 0) >= LIST_CAP

  return (
    <div className="fw-q">
      <PageHead
        intro={t('list.intro')}
        status={<Freshness asOf={model.asOf} live={model.live} />}
        actions={
          <Button size="sm" variant="primary" onClick={() => actions?.onNewLabel?.(true)} heldReason={manageHeld} aria-keyshortcuts="c">
            <Plus size={14} aria-hidden /> {t('list.new')}
          </Button>
        }
      />
      <NoticeBanner notice={model.notice} namespace="labels" onDismiss={actions?.onDismissNotice} />
      <MetricStrip metrics={LABEL_TILES.map(tile)} />

      <ListFrame<LabelTemplate>
        label={t('list.table')}
        rows={model.rows.problem ? [] : model.rows.value === null ? null : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={model.rows.value === null ? '—' : t(capped ? 'list.countCapped' : 'list.count', { count: rows.length, max: LIST_CAP })}
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
        keys={ownKeys}
        onHelp={() => actions?.onShortcuts?.(true)}
        onOpen={(row) => actions?.onOpen?.(row)}
        state={state}
        focusRow={model.focusRow}
      />

      {model.newLabel && <NewLabelDialog model={model.newLabel} can={can} actions={actions} />}
      <ShortcutsDialog open={!!model.shortcuts} onClose={() => actions?.onShortcuts?.(false)} keys={listKeys(ownKeys, true).map((entry) => ({ keys: entry.keys, does: lists(entry.does) }))} />
    </div>
  )
}

export type { LabelView }
