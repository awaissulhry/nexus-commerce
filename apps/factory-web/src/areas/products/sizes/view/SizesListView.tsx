'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Archive, Download, MoreHorizontal, Plus, Search } from 'lucide-react'
import { Banner, Field, Menu, Modal } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Textarea, TokenChip } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { useT } from '../../../../lib/i18n/provider'
import { isPageKey, keepLoaded, type LibraryCan, type Notice } from '../../library/model'
import { Freshness, KeysDialog, LibraryMessages, listState, NoticeBanner, PageHead, showsState } from '../../library/parts'
import type { ScaleRow } from '../api'
import { archiveHeld, badSizes, createHeld, isFiltered, NO_FILTERS, parseSizes, SCALE_VIEWS, sizesText, STATUS_TONE, type NewScaleDraft, type ScaleFilters } from '../model'

export interface NewScaleModel {
  draft: NewScaleDraft
  companies: Array<{ id: string; name: string }>
  busy: boolean
  problem: string | null
  refused: string[]
}

export interface SizesListViewModel {
  prefix: string
  can: LibraryCan
  filters: ScaleFilters
  rows: { items: ScaleRow[] | null; more: boolean; count: number | null; problem: string | null }
  asOf: string | null
  updates: number
  newScale: NewScaleModel | null
  busy: boolean
  notice: Notice | null
  selected?: string[]
  focusRow?: number
  dialog?: 'archive' | 'help' | null
}

export interface SizesListActions {
  onFilters?: (filters: ScaleFilters) => void
  onRetry?: () => void
  onMore?: () => void
  onShowUpdates?: () => void
  onOpen?: (id: string) => void
  onExport?: (ids: string[]) => void
  onArchiveMany?: (ids: string[], reason: string) => Promise<boolean>
  onNew?: (open: boolean) => void
  onDraft?: (draft: NewScaleDraft) => void
  onCreate?: () => void
  onDismissNotice?: () => void
}

/**
 * SCR-049 — Sizes & measurements (Products › Libraries; design products.sizes): the size scales the styles draw from
 * (EU 44–64, S–4XL, gloves 7–13 …) on the shared list frame (select-all, shift range, x; Export N, Archive N; keys only in
 * the footer icon), each code a real link to the scale (its sizes and their body measures), and New size scale (`c`:
 * sizes typed or pasted in order). Measurement templates, points of measure and grade rules are not served by the API
 * yet: no view switch is drawn for them. It fetches nothing.
 */
export function SizesListView({ model, actions }: { model: SizesListViewModel; actions?: SizesListActions }) {
  return (
    <LibraryMessages>
      <SizesList model={model} actions={actions} />
    </LibraryMessages>
  )
}

function SizesList({ model, actions }: { model: SizesListViewModel; actions?: SizesListActions }) {
  const t = useT('library')
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
  const [dialog, setDialog] = useState<'archive' | 'help' | null>(model.dialog ?? null)
  const items = model.rows.items
  const rowsKey = items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => keepLoaded(current, items)), [rowsKey])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.newScale || dialog) return
      if (event.key === 'c' && model.can.scalesManage) {
        event.preventDefault()
        actions?.onNew?.(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const recordHref = useCallback((row: ScaleRow) => `${model.prefix}/products/sizes/${row.id}`, [model.prefix])
  const picked = (items ?? []).filter((row) => selected.includes(row.id))
  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('sizes.list.keyNew') }]

  const columns = useMemo<ColDef<ScaleRow>[]>(() => {
    const CodeCell = ({ data }: ICellRendererParams<ScaleRow>) =>
      data ? (
        <span className="fw-lib-cell">
          <Link className="fw-lib-rowlink" href={recordHref(data)}>
            {data.code}
          </Link>
          <span className="fw-lib-sub">{data.name}</span>
        </span>
      ) : null
    const SizesCell = ({ data }: ICellRendererParams<ScaleRow>) =>
      data ? (
        <span className="fw-lib-cell">
          <span className="fw-lib-nowrap">{data.codes.length ? sizesText(data.codes) : '—'}</span>
          <span className="fw-lib-sub">{t('sizes.list.sizeCount', { count: data.codes.length })}</span>
        </span>
      ) : null
    const StylesCell = ({ data }: ICellRendererParams<ScaleRow>) =>
      data ? (
        <span className="fw-lib-cell fw-lib-right">
          <span>{t('sizes.list.styles', { count: data.styleCount })}</span>
          <span className="fw-lib-sub">{data.styleCount > 0 ? t('sizes.list.orderFixed') : t('sizes.list.orderFree')}</span>
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<ScaleRow>) => (data ? <Pill tone={STATUS_TONE[data.status]}>{t(`status.${data.status}`)}</Pill> : null)
    const MoreCell = ({ data }: ICellRendererParams<ScaleRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { code: data.code }) }}
          items={[
            { id: 'open', label: t('list.open'), href: recordHref(data) },
            { id: 'tab', label: t('list.openNewTab'), href: recordHref(data), target: '_blank' },
            { id: 'used', label: t('sizes.list.openUsed'), href: `${recordHref(data)}?tab=whereused` },
            {
              id: 'copy',
              label: t('list.copyCode'),
              onSelect: () => {
                void navigator.clipboard?.writeText(data.code).catch(() => undefined)
              },
            },
          ]}
        />
      ) : null
    return [
      { colId: 'code', headerName: t('sizes.col.scale'), field: 'code', minWidth: 200, flex: 1.5, cellRenderer: CodeCell },
      { colId: 'sizes', headerName: t('sizes.col.sizes'), field: 'codes', cellDataType: false, minWidth: 200, flex: 2, cellRenderer: SizesCell },
      { colId: 'styles', headerName: t('sizes.col.styles'), field: 'styleCount', minWidth: 150, flex: 1, type: 'rightAligned', cellRenderer: StylesCell },
      { colId: 'status', headerName: t('sizes.col.status'), field: 'status', minWidth: 100, maxWidth: 130, cellRenderer: StatusCell },
      { colId: 'more', headerName: t('list.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, recordHref])

  const filtered = isFiltered(model.filters)
  const state = showsState(model.rows.problem, items)
    ? listState({
        problem: model.rows.problem,
        rows: items,
        filtered,
        forbidden: { title: t('sizes.forbidden.title'), body: t('sizes.forbidden.body') },
        empty: {
          title: t('sizes.empty.title'),
          body: t(model.can.scalesManage ? 'sizes.empty.body' : 'sizes.empty.bodyView'),
          action: model.can.scalesManage ? (
            <Button size="sm" variant="primary" onClick={() => actions?.onNew?.(true)}>
              {t('sizes.empty.create')}
            </Button>
          ) : undefined,
        },
        onRetry: () => actions?.onRetry?.(),
        onClear: () => actions?.onFilters?.(NO_FILTERS),
      })
    : undefined
  const archiveReason = archiveHeld(picked, model.can)

  return (
    <div className="fw-lib">
      <PageHead
        intro={t('sizes.list.intro')}
        status={<Freshness asOf={model.asOf} />}
        actions={
          <Button size="sm" variant="primary" heldReason={model.can.scalesManage ? null : t('held.noManage')} onClick={() => actions?.onNew?.(true)} aria-keyshortcuts="c">
            <Plus size={14} aria-hidden /> {t('sizes.list.new')}
          </Button>
        }
      />
      <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
      {filtered && (
        <div className="fw-lib-chips" aria-label={t('list.activeFilters')}>
          {model.filters.view !== 'open' && (
            <TokenChip removeLabel={t('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, view: 'open' })}>
              {t(`sizes.view.${model.filters.view}`)}
            </TokenChip>
          )}
          {model.filters.q.trim() && (
            <TokenChip removeLabel={t('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, q: '' })}>
              {t('list.chipSearch', { q: model.filters.q.trim() })}
            </TokenChip>
          )}
          <Button size="sm" variant="quiet" onClick={() => actions?.onFilters?.(NO_FILTERS)}>
            {t('list.clearAll')}
          </Button>
        </div>
      )}
      <ListFrame<ScaleRow>
        label={t('sizes.list.tableLabel')}
        rows={state ? [] : items}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? t(model.rows.more ? 'list.countMore' : 'list.count', { count: items.length, total: model.rows.count ?? items.length }) : '—'}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={13} aria-hidden />}
            aria-label={t('sizes.list.search')}
            placeholder={t('sizes.list.search')}
            value={query}
            onChange={(event) => {
              typed.current = true
              setQuery(event.target.value)
            }}
          />
        }
        tools={
          <Select size="sm" aria-label={t('list.viewFilter')} value={model.filters.view} onChange={(event) => actions?.onFilters?.({ ...model.filters, view: event.target.value as ScaleFilters['view'] })}>
            {SCALE_VIEWS.map((view) => (
              <option key={view} value={view}>
                {t(`sizes.view.${view}`)}
              </option>
            ))}
          </Select>
        }
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <>
              <Button size="sm" aria-label={t('list.bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('list.bulk.export', { count: picked.length })}</SelectionLabel>
              </Button>
              <Button size="sm" variant="danger-outline" aria-label={t('list.bulk.archive', { count: picked.length })} heldReason={archiveReason ? t(archiveReason) : null} onClick={() => setDialog('archive')}>
                <Archive size={13} aria-hidden /> <SelectionLabel>{t('list.bulk.archive', { count: picked.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.rows.more && items && items.length > 0 ? { label: t('list.more'), onMore: () => actions?.onMore?.() } : null}
        keys={ownKeys}
        onHelp={() => setDialog('help')}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
        focusRow={model.focusRow}
      />
      {model.newScale && <NewScaleDialog model={model.newScale} actions={actions} />}
      {dialog === 'archive' && <ArchiveDialog rows={picked} busy={model.busy} actions={actions} onDone={() => setSelected([])} onClose={() => setDialog(null)} />}
      {dialog === 'help' && <KeysDialog keys={listKeys(ownKeys, true)} onClose={() => setDialog(null)} />}
    </div>
  )
}

function ArchiveDialog({ rows, busy, actions, onDone, onClose }: { rows: readonly ScaleRow[]; busy: boolean; actions?: SizesListActions; onDone: () => void; onClose: () => void }) {
  const t = useT('library')
  const [reason, setReason] = useState('')
  const go = () => {
    if (busy) return
    void actions?.onArchiveMany?.(rows.map((row) => row.id), reason.trim()).then((done) => {
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
      title={t('sizes.archive.title', { count: rows.length })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('common.back')}</Button>
          <Button variant="danger" heldReason={busy ? t('held.busy') : null} onClick={go}>
            {t('list.bulk.archive', { count: rows.length })}
          </Button>
        </>
      }
    >
      <div className="fw-lib-dialog">
        <ul className="fw-lib-list">
          <li>{t('sizes.archive.reach')}</li>
          <li>{t('sizes.archive.kept')}</li>
          <li>{t('sizes.archive.back')}</li>
        </ul>
        <ul className="fw-lib-list">
          {rows.map((row) => (
            <li key={row.id}>
              <b>{row.code}</b> · {row.name} — {t('sizes.list.styles', { count: row.styleCount })}
            </li>
          ))}
        </ul>
        <Field label={t('dialog.reason')} hint={t('dialog.reasonHint')}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} />
        </Field>
      </div>
    </Modal>
  )
}

/** New size scale (design sizes.newScale): code, name, the sizes typed or pasted in order ("44, 46, 48 …"). */
function NewScaleDialog({ model, actions }: { model: NewScaleModel; actions?: SizesListActions }) {
  const t = useT('library')
  const draft = model.draft
  const set = (patch: Partial<NewScaleDraft>) => actions?.onDraft?.({ ...draft, ...patch })
  const held = createHeld(draft, model.busy)
  const codes = parseSizes(draft.sizes)
  const bad = badSizes(codes)
  const refused = (field: string) => (model.refused.some((path) => path === field || path.startsWith(`${field}/`)) ? t('newMaterial.refused') : undefined)
  const create = () => {
    if (!held) actions?.onCreate?.()
  }
  return (
    <Modal
      open
      onClose={() => actions?.onNew?.(false)}
      title={t('newScale.title')}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onNew?.(false)}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held ? t(held, { sizes: bad.join(' ') }) : null} onClick={create} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('newScale.create')}
          </Button>
        </>
      }
    >
      <div
        className="fw-lib-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            create()
          }
        }}
      >
        <p className="fw-lib-hint">{t('newScale.intro')}</p>
        <div className="fw-lib-form-grid">
          {model.companies.length > 1 && (
            <Field label={t('newMaterial.company')} hint={t('newScale.companyHint')}>
              <Select value={draft.companyId ?? ''} onChange={(event) => set({ companyId: event.target.value || null })}>
                <option value="">{t('newMaterial.everyCompany')}</option>
                {model.companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('scale.code')} required hint={t('material.codeHint')} error={refused('code')}>
            <Input value={draft.code} maxLength={40} autoFocus onChange={(event) => set({ code: event.target.value.toUpperCase() })} />
          </Field>
          <Field label={t('scale.name')} required error={refused('name')}>
            <Input value={draft.name} maxLength={120} onChange={(event) => set({ name: event.target.value })} />
          </Field>
          <div className="fw-lib-span">
            <Field label={t('newScale.sizes')} required hint={t('newScale.sizesHint')} error={bad.length > 0 ? t('newScale.held.badSizes', { sizes: bad.join(' ') }) : refused('sizes')}>
              <Textarea value={draft.sizes} rows={2} onChange={(event) => set({ sizes: event.target.value })} />
            </Field>
          </div>
        </div>
        {codes.length > 0 && <p className="fw-lib-converter">{t('newScale.preview', { count: codes.length, sizes: codes.join(' · ') })}</p>}
        <p className="fw-lib-hint">{t('newScale.after')}</p>
        {model.problem && <Banner tone="danger" title={t(model.problem)} />}
      </div>
    </Modal>
  )
}
