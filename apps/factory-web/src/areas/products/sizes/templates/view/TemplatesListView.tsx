'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Download, MoreHorizontal, Plus, Search, ShieldOff } from 'lucide-react'
import { EmptyState, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, TokenChip } from '@nexus/ui/primitives'
import type { TemplatePointBody } from '@nexus/factory-domain/sales/mtm/contracts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { Freshness, PageHead } from '../../../library/parts'
import { isPageKey, keepLoaded } from '../../../library/model'
import { depthFiltered, NO_DEPTH_FILTERS, STATUS_VIEWS, type DepthFilters } from '../../depth/model'
import { LibrarySwitch, type LibrarySwitchActions, type LibrarySwitchModel } from '../../depth/view/LibrarySwitch'
import type { TemplateOption } from '../api'
import { nameIn, recordHref, ridersHref, type NewTemplateDraft, type Notice, type RowFacts, type TemplateCan } from '../model'
import { NoticeLine, OnOffTag, TemplatesMessages, useWords } from '../parts'
import { NewTemplateDialog } from './NewTemplateDialog'

export interface NewTemplateModel {
  readonly draft: NewTemplateDraft
  readonly companies: ReadonlyArray<{ id: string; name: string }>
  /** The templates a copy may start from (the list's rows). */
  readonly templates: readonly TemplateOption[]
  /** The source's points for a copy: null while read, 'failed' when the read failed. */
  readonly copy: readonly TemplatePointBody[] | null | 'failed'
  readonly busy: boolean
  /** A refusal in this catalogue's words. */
  readonly problem: string | null
  /** The refused fields (`code`, `points/0/code`). */
  readonly refused: readonly string[]
}

export interface TemplatesListModel {
  readonly prefix: string
  readonly can: TemplateCan
  readonly filters: DepthFilters
  /** null while read; `problem` when the read failed (never drawn as an empty list). */
  readonly rows: { readonly items: readonly TemplateOption[] | null; readonly more: boolean; readonly problem: string | null }
  /** What each row's page adds (required points, where used); absent while read, 'failed' when it could not be read. */
  readonly facts: Readonly<Record<string, RowFacts | 'failed'>>
  readonly asOf: string | null
  readonly updates: number
  readonly notice: Notice | null
  readonly newTemplate: NewTemplateModel | null
  readonly switch: LibrarySwitchModel
  /** Design only: the rows picked, the focused row. */
  readonly selected?: readonly string[]
  readonly focusRow?: number
}

export interface TemplatesListActions {
  onFilters?: (filters: DepthFilters) => void
  onRetry?: () => void
  onMore?: () => void
  onShowUpdates?: () => void
  onOpen?: (id: string) => void
  onExport?: (ids: readonly string[]) => void
  onNew?: (open: boolean) => void
  onDraft?: (draft: NewTemplateDraft) => void
  onCreate?: () => void
  onDismissNotice?: () => void
  switch?: LibrarySwitchActions
}

/**
 * SCR-049-templates — Products › Sizes & measurements › Measurement templates (B-W1-17; design products.sizes sec:sizes.templates):
 * which body measures are taken per garment type for made-to-measure, on the shared list frame (select-all, shift range, x;
 * Export N; the keys only in the footer's info icon): Code (a real link) with its name, Product type, Points with how many are
 * required, Used by styles and rider profiles, Made-to-measure On / Off (built OFF per template, Owner 11-10: Off says nothing
 * is checked and where it is started), Status, the row's ⋯. Rows ▾ Active / Archived / All and the search; New template (`c`).
 * The view switch with Import sits above it, as on every Sizes view. It fetches nothing.
 */
export function TemplatesListView({ model, actions }: { model: TemplatesListModel; actions?: TemplatesListActions }) {
  return (
    <TemplatesMessages>
      <List model={model} actions={actions} />
    </TemplatesMessages>
  )
}

function List({ model, actions }: { model: TemplatesListModel; actions?: TemplatesListActions }) {
  const { t, locale } = useWords()
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
  const items = model.rows.items
  const rowsKey = items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => keepLoaded(current, items ? [...items] : null)), [rowsKey])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.newTemplate) return
      if (event.key === 'c' && model.can.manage) {
        event.preventDefault()
        actions?.onNew?.(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const hrefOf = useCallback((row: TemplateOption) => recordHref(model.prefix, row.id), [model.prefix])
  const picked = (items ?? []).filter((row) => selected.includes(row.id))
  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('list.keyNew') }]

  const columns = useMemo<ColDef<TemplateOption>[]>(() => {
    const factsOf = (row: TemplateOption | undefined): RowFacts | 'failed' | null => (row ? (model.facts[row.id] ?? null) : null)
    const CodeCell = ({ data }: ICellRendererParams<TemplateOption>) =>
      data ? (
        <span className="fw-lib-cell">
          <Link className="fw-lib-rowlink" href={hrefOf(data)}>
            {data.code}
          </Link>
          <span className="fw-lib-sub">{nameIn(data, locale)}</span>
        </span>
      ) : null
    const PointsCell = ({ data }: ICellRendererParams<TemplateOption>) => {
      if (!data) return null
      const facts = factsOf(data)
      return (
        <span className="fw-lib-cell fw-lib-right">
          <span>{t('list.points', { count: data.points })}</span>
          <span className="fw-lib-sub">{facts && facts !== 'failed' ? t('list.required', { count: facts.required }) : '—'}</span>
        </span>
      )
    }
    const UsedCell = ({ data }: ICellRendererParams<TemplateOption>) => {
      if (!data) return null
      const facts = factsOf(data)
      if (!facts || facts === 'failed')
        return (
          <span className="fw-lib-cell" title={facts === 'failed' ? t('list.factsFailed') : undefined}>
            —
          </span>
        )
      return (
        <span className="fw-lib-cell">
          <span>{t('list.styles', { count: facts.styles.measured, mtm: facts.styles.madeToMeasure })}</span>
          <span className="fw-lib-sub">{t('list.profiles', { count: facts.profiles })}</span>
        </span>
      )
    }
    const MtmCell = ({ data }: ICellRendererParams<TemplateOption>) =>
      data ? (
        <span className="fw-lib-cell">
          <OnOffTag on={data.rulesOn} />
          <span className="fw-lib-sub">{t(data.rulesOn ? 'list.mtmOnHint' : 'list.mtmOffHint')}</span>
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<TemplateOption>) => (data ? <Pill tone={data.status === 'ACTIVE' ? 'success' : 'neutral'}>{t(`status.${data.status}`)}</Pill> : null)
    const MoreCell = ({ data }: ICellRendererParams<TemplateOption>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { code: data.code }) }}
          items={[
            { id: 'open', label: t('list.open'), href: hrefOf(data) },
            { id: 'tab', label: t('list.openNewTab'), href: hrefOf(data), target: '_blank' },
            { id: 'mtm', label: t('list.openMtm'), href: recordHref(model.prefix, data.id, 'mtm') },
            { id: 'used', label: t('list.openUsed'), href: recordHref(model.prefix, data.id, 'whereused') },
            { id: 'riders', label: t('list.openRiders'), href: ridersHref(model.prefix, data.code) },
            { id: 'copy', label: t('list.copyCode'), onSelect: () => void navigator.clipboard?.writeText(data.code).catch(() => undefined) },
          ]}
        />
      ) : null
    return [
      { colId: 'code', headerName: t('col.code'), field: 'code', minWidth: 200, flex: 1.4, cellRenderer: CodeCell },
      { colId: 'type', headerName: t('col.type'), minWidth: 120, flex: 0.7, valueGetter: (params) => (params.data ? t(`type.${params.data.productType}`) : '') },
      { colId: 'points', headerName: t('col.points'), field: 'points', minWidth: 130, flex: 0.7, type: 'rightAligned', cellRenderer: PointsCell },
      { colId: 'used', headerName: t('col.used'), minWidth: 200, flex: 1.1, sortable: false, cellRenderer: UsedCell },
      { colId: 'mtm', headerName: t('col.mtm'), minWidth: 220, flex: 1.1, valueGetter: (params) => (params.data ? t(params.data.rulesOn ? 'mtm.on' : 'mtm.off') : ''), cellRenderer: MtmCell },
      { colId: 'status', headerName: t('col.status'), field: 'status', minWidth: 100, maxWidth: 130, cellRenderer: StatusCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, hrefOf, model.prefix, model.facts])

  const newButton = (
    <Button size="sm" variant="primary" heldReason={model.can.manage ? null : t('held.noManage')} onClick={() => actions?.onNew?.(true)} aria-keyshortcuts="c">
      <Plus size={14} aria-hidden /> {t('list.new')}
    </Button>
  )
  const filtered = depthFiltered(model.filters)
  let state: ReactNode | undefined
  if (!model.can.view || model.rows.problem === 'problem.forbidden') state = <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('list.forbidden.title')} description={t('list.forbidden.body')} />
  else if (model.rows.problem)
    state = (
      <EmptyState
        title={t('list.failed')}
        description={t(model.rows.problem)}
        action={
          <Button size="sm" onClick={() => actions?.onRetry?.()}>
            {t('common.retry')}
          </Button>
        }
      />
    )
  else if (items && items.length === 0)
    state = filtered ? (
      <EmptyState
        title={t('list.noMatch.title')}
        description={t('list.noMatch.body')}
        action={
          <Button size="sm" onClick={() => actions?.onFilters?.(NO_DEPTH_FILTERS)}>
            {t('list.clearAll')}
          </Button>
        }
      />
    ) : (
      <EmptyState title={t('list.empty.title')} description={t(model.can.manage ? 'list.empty.body' : 'list.empty.bodyView')} action={model.can.manage ? newButton : undefined} />
    )

  return (
    <div className="fw-lib">
      <LibrarySwitch model={model.switch} actions={actions?.switch} />
      <PageHead intro={t('list.intro')} status={<Freshness asOf={model.asOf} />} actions={newButton} />
      <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} />
      {filtered && (
        <div className="fw-lib-chips" aria-label={t('list.activeFilters')}>
          {model.filters.status !== 'open' && (
            <TokenChip removeLabel={t('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, status: 'open' })}>
              {t(`view.${model.filters.status}`)}
            </TokenChip>
          )}
          {model.filters.q.trim() && (
            <TokenChip removeLabel={t('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, q: '' })}>
              {t('list.chipSearch', { q: model.filters.q.trim() })}
            </TokenChip>
          )}
          <Button size="sm" variant="quiet" onClick={() => actions?.onFilters?.(NO_DEPTH_FILTERS)}>
            {t('list.clearAll')}
          </Button>
        </div>
      )}
      <ListFrame<TemplateOption>
        label={t('list.tableLabel')}
        title={t('list.tableLabel')}
        rows={state ? [] : items}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? t(model.rows.more ? 'list.countMore' : 'list.count', { count: items.length }) : '—'}
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
          <Select size="sm" aria-label={t('list.viewFilter')} value={model.filters.status} onChange={(event) => actions?.onFilters?.({ ...model.filters, status: event.target.value as DepthFilters['status'] })}>
            {STATUS_VIEWS.map((view) => (
              <option key={view} value={view}>
                {t(`view.${view}`)}
              </option>
            ))}
          </Select>
        }
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" aria-label={t('list.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
              <Download size={13} aria-hidden /> <SelectionLabel>{t('list.export', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.rows.more && items && items.length > 0 ? { label: t('list.more'), onMore: () => actions?.onMore?.() } : null}
        keys={ownKeys}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
        focusRow={model.focusRow}
        cards={{ hrefOf }}
      />
      {model.newTemplate && <NewTemplateDialog model={model.newTemplate} can={model.can} actions={actions} />}
    </div>
  )
}
