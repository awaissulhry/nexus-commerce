'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Archive, Download, MoreHorizontal, Plus, Search } from 'lucide-react'
import { Banner, EmptyState, Field, Menu, MetricStrip } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, RadioCard, Select, Tag, Toggle, TokenChip } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { StyleRow } from '../../api'
import { PpeFields, RangeFields, settlePpe } from '../../forms'
import { DuplicateDialog } from '../../duplicate/view/DuplicateDialog'
import { completenessOf, decimalText, moneyText, rangeWords, revisionChips, STATUS_TONE, STYLE_TILES, STYLE_VIEWS } from '../../model'
import { extraFilterCount, NO_FILTERS, START_FROM, type NewStyleModel, type StylesListActions, type StylesListViewModel } from '../list-model'
import { usePhoneList } from '../use-phone'
import { StyleCards } from './StyleCards'
import '../../styles.css'

export type { StylesListViewModel, StylesListActions } from '../list-model'

const PRODUCT_TYPES: StyleRow['productType'][] = ['JACKET', 'TROUSERS', 'SUIT', 'GLOVES', 'VEST', 'OTHER']
const PPE_CATEGORIES: StyleRow['ppeCategory'][] = ['NOT_PPE', 'CATEGORY_I', 'CATEGORY_II', 'CATEGORY_III']

/**
 * SCR-040 — Styles (Products; design products.styles, 00 §2.1 list frame): the saved-filter tiles (each sets the saved
 * view: one filter model you can see), the toolbar (search over code, name and season; product type; PPE; the time it
 * was read; live changes wait behind "N updates · Show" so rows never move under the cursor), the list on the shared
 * list frame (select-all with mixed state, shift range, x; bulk Export N (CSV) and Archive N…; keys only in the footer's
 * information icon) with each code a real link, and the New style dialog (`c`). It fetches nothing.
 */
export function StylesListView({ model, actions }: { model: StylesListViewModel; actions?: StylesListActions }) {
  return (
    <WithMessages namespaces={['products', 'lists']}>
      <StylesList model={model} actions={actions} />
    </WithMessages>
  )
}

function StylesList({ model, actions }: { model: StylesListViewModel; actions?: StylesListActions }) {
  const t = useT('products')
  const lists = useT('lists')
  const locale = useLocale()
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
  const [dialog, setDialog] = useState<'archive' | 'help' | 'filters' | null>(model.phoneFilters ? 'filters' : null)
  const phoneWidth = usePhoneList()
  const phone = model.phone === true || phoneWidth
  const rowsKey = model.rows.items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])

  // c: a new style (00 §3.17) — never while typing or inside a dialog. The list frame keeps / j k x Enter ?.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.newStyle || model.duplicate || dialog) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      if (event.key === 'c' && model.can.manage) {
        event.preventDefault()
        actions?.onNewStyle?.(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const items = model.rows.items
  const recordHref = useCallback((row: StyleRow) => `${model.prefix}/products/styles/${row.id}`, [model.prefix])
  const picked = (items ?? []).filter((row) => selected.includes(row.id))
  const archived = picked.filter((row) => row.status === 'ARCHIVED').length
  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('list.keyNew') }]
  const duplicateHeld = model.can.manage ? null : t('held.noManage')
  // List price and margin (W2a): only with pricelists.view and their grain; the column is absent otherwise (S2).
  const showPrice = model.can.prices && model.grains.price && model.prices.state !== 'hidden'
  const showMargin = model.can.prices && model.grains.margin && model.prices.state !== 'hidden'
  const prices = model.prices

  const columns = useMemo<ColDef<StyleRow>[]>(() => {
    const CodeCell = ({ data }: ICellRendererParams<StyleRow>) =>
      data ? (
        <span className="fw-st-cell">
          <Link className="fw-st-rowlink" href={recordHref(data)}>
            {data.code}
          </Link>
          <span className="fw-st-row-sub">{data.name}</span>
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<StyleRow>) => (data ? <Pill tone={STATUS_TONE[data.status]}>{t(`status.${data.status}`)}</Pill> : null)
    const RevisionCell = ({ data }: ICellRendererParams<StyleRow>) => {
      if (!data) return null
      const chips = revisionChips(data)
      return chips.length === 0 ? (
        <span className="fw-st-hint">{t('list.noRevision')}</span>
      ) : (
        <span className="fw-st-inline fw-st-nowrap">
          {chips.map((chip) => (
            <Tag key={chip.kind} tone={chip.kind === 'released' ? 'success' : 'info'}>
              {t(`list.rev.${chip.kind}`, { revision: chip.revision })}
            </Tag>
          ))}
        </span>
      )
    }
    const RangeCell = ({ data }: ICellRendererParams<StyleRow>) =>
      data ? (
        <span className="fw-st-cell">
          <span>{data.sizes.length ? rangeWords(data.sizes) : '—'}</span>
          <span className="fw-st-row-sub" title={data.sizeScale.name}>{data.baseSize ? t('list.base', { size: data.baseSize }) : data.sizeScale.code}</span>
        </span>
      ) : null
    const PpeCell = ({ data }: ICellRendererParams<StyleRow>) =>
      data ? (
        data.ppeCategory === 'NOT_PPE' ? (
          <span className="fw-st-hint">{t('ppe.short.NOT_PPE')}</span>
        ) : (
          <span className="fw-st-cell">
            <span>{t(`ppe.short.${data.ppeCategory}`)}</span>
            <span className="fw-st-row-sub">{[data.ppeStandard, data.ppeClass].filter(Boolean).join(' · ') || t('list.noStandard')}</span>
          </span>
        )
      ) : null
    const ReadyCell = ({ data }: ICellRendererParams<StyleRow>) => {
      if (!data) return null
      const done = completenessOf(data)
      return (
        <span className="fw-st-cell" title={done.missing.map((key) => t(`completeness.${key}`)).join(' · ')}>
          <span>{t('list.ready', { done: done.done, of: done.of })}</span>
          {done.missing[0] && <span className="fw-st-row-sub">{t(`completeness.${done.missing[0]}`)}</span>}
        </span>
      )
    }
    const MoreCell = ({ data }: ICellRendererParams<StyleRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { code: data.code }) }}
          items={[
            { id: 'open', label: t('list.open'), href: recordHref(data) },
            { id: 'tab', label: t('list.openNewTab'), href: recordHref(data), target: '_blank' },
            { id: 'variants', label: t('list.openVariants'), href: `${recordHref(data)}?tab=variants` },
            { id: 'duplicate', label: t('list.duplicate'), disabled: !!duplicateHeld, description: duplicateHeld ?? undefined, onSelect: () => latest.current.actions?.onDuplicate?.(data) },
          ]}
        />
      ) : null
    const TypeCell = ({ data }: ICellRendererParams<StyleRow>) =>
      data ? (
        <span className="fw-st-cell">
          <span>{t(`productType.${data.productType}`)}</span>
          <span className="fw-st-row-sub">{[data.season, data.brand?.name].filter(Boolean).join(' · ') || '—'}</span>
        </span>
      ) : null
    const SkusCell = ({ data }: ICellRendererParams<StyleRow>) =>
      data ? (
        <span className="fw-st-cell fw-st-right">
          <span>{data.skuCount}</span>
          <span className="fw-st-row-sub">{t('list.colourwaysCount', { count: data.colourwayCount })}</span>
        </span>
      ) : null
    const PriceCell = ({ data }: ICellRendererParams<StyleRow>) => {
      if (!data) return null
      if (prices.state === 'loading') return <span className="fw-st-hint">…</span>
      if (prices.state !== 'ready') return <span className="fw-st-hint">—</span>
      const price = prices.byStyle[data.id]
      return price?.price ? (
        <span className="fw-st-cell fw-st-right">
          <span>{price.from ? t('list.price.from', { price: moneyText(price.price, prices.list.currency, locale) }) : moneyText(price.price, prices.list.currency, locale)}</span>
          {price.from && <span className="fw-st-row-sub">{t('list.price.fromShort')}</span>}
        </span>
      ) : (
        <span className="fw-st-hint">{t('list.price.none')}</span>
      )
    }
    const MarginCell = ({ data }: ICellRendererParams<StyleRow>) => {
      if (!data) return null
      if (prices.state !== 'ready') return <span className="fw-st-hint">{prices.state === 'loading' ? '…' : '—'}</span>
      const price = prices.byStyle[data.id]
      if (!price?.price) return <span className="fw-st-hint">—</span>
      if (price.marginPct === null) return <span className="fw-st-hint" title={t('list.margin.unknownHint')}>{t('list.margin.unknown')}</span>
      return (
        <span className="fw-st-cell fw-st-right">
          <span>{t('list.margin.pct', { pct: decimalText(price.marginPct, locale, 1) })}</span>
          {price.belowFloor && <span className="fw-st-row-sub fw-st-warn">{t('list.margin.belowFloor')}</span>}
        </span>
      )
    }
    return [
      { colId: 'code', headerName: t('list.col.style'), field: 'code', minWidth: 180, flex: 2, cellRenderer: CodeCell },
      { colId: 'type', headerName: t('list.col.typeSeason'), field: 'productType', minWidth: 120, flex: 1, cellRenderer: TypeCell },
      { colId: 'status', headerName: t('list.col.status'), field: 'status', minWidth: 100, flex: 1, cellRenderer: StatusCell },
      { colId: 'revision', headerName: t('list.col.revision'), field: 'revisionState', minWidth: 200, flex: 1, cellRenderer: RevisionCell },
      { colId: 'range', headerName: t('list.col.range'), field: 'baseSize', cellDataType: false, minWidth: 100, flex: 1, cellRenderer: RangeCell },
      { colId: 'skus', headerName: t('list.col.skus'), field: 'skuCount', minWidth: 125, flex: 1, type: 'rightAligned', cellRenderer: SkusCell },
      { colId: 'ppe', headerName: t('list.col.ppe'), field: 'ppeCategory', minWidth: 150, flex: 1, cellRenderer: PpeCell },
      { colId: 'ready', headerName: t('list.col.ready'), field: 'skuCount', cellDataType: false, minWidth: 110, flex: 1, cellRenderer: ReadyCell },
      ...(showPrice ? [{ colId: 'price', headerName: t('list.col.price'), field: 'id' as const, cellDataType: false, minWidth: 130, flex: 1, type: 'rightAligned', sortable: false, cellRenderer: PriceCell }] : []),
      ...(showMargin ? [{ colId: 'margin', headerName: t('list.col.margin'), field: 'id' as const, cellDataType: false, minWidth: 130, flex: 0.8, type: 'rightAligned', sortable: false, cellRenderer: MarginCell }] : []),
      { colId: 'updated', headerName: t('list.col.updated'), field: 'updatedAt', minWidth: 100, flex: 1, valueFormatter: (params) => (params.value ? formatDate(params.value as string, { locale }) : '—') },
      { colId: 'more', headerName: t('list.col.more'), minWidth: 80, maxWidth: 80, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, recordHref, prices, showPrice, showMargin, duplicateHeld])

  const filtered = model.filters.view !== 'open' || extraFilterCount(model.filters) > 0
  const state = model.rows.problem === 'problem.read.forbidden' ? (
    <EmptyState title={t('list.forbidden.title')} description={t('list.forbidden.body')} />
  ) : model.rows.problem ? (
    <EmptyState title={t('list.failed')} description={t(model.rows.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : items && items.length === 0 ? (
    filtered ? (
      <EmptyState title={t('list.noMatch.title')} description={t('list.noMatch.body')} action={<Button size="sm" onClick={() => actions?.onFilters?.(NO_FILTERS)}>{t('list.clearAll')}</Button>} />
    ) : (
      <EmptyState
        title={t('list.empty.title')}
        description={t(model.can.manage ? 'list.empty.body' : 'list.empty.bodyView')}
        action={
          model.can.manage ? (
            <Button size="sm" variant="primary" onClick={() => actions?.onNewStyle?.(true)}>
              {t('list.emptyCreate')}
            </Button>
          ) : undefined
        }
      />
    )
  ) : undefined

  const bulkActions = (
    <>
      <Button size="sm" aria-label={t('list.bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
        <Download size={13} aria-hidden /> <SelectionLabel>{t('list.bulk.export', { count: picked.length })}</SelectionLabel>
      </Button>
      <Button
        size="sm"
        variant="danger-outline"
        aria-label={t('list.bulk.archive', { count: picked.length })}
        heldReason={!model.can.manage ? t('held.noManage') : archived > 0 ? t('list.bulk.archiveHeld', { count: archived }) : null}
        onClick={() => setDialog('archive')}
      >
        <Archive size={13} aria-hidden /> <SelectionLabel>{t('list.bulk.archive', { count: picked.length })}</SelectionLabel>
      </Button>
    </>
  )
  const countWords = items ? t(model.rows.more ? 'list.countMore' : 'list.count', { count: items.length, total: model.rows.count ?? items.length }) : '—'
  const searchField = (
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
  )
  const filterSelects = (
    <>
      <Select size="sm" aria-label={t('list.viewFilter')} value={model.filters.view} onChange={(event) => actions?.onFilters?.({ ...model.filters, view: event.target.value as StylesListViewModel['filters']['view'] })}>
        {STYLE_VIEWS.map((view) => (
          <option key={view} value={view}>
            {t(`list.view.${view}`)}
          </option>
        ))}
      </Select>
      <Select size="sm" aria-label={t('list.typeFilter')} value={model.filters.type} onChange={(event) => actions?.onFilters?.({ ...model.filters, type: event.target.value })}>
        <option value="">{t('list.allTypes')}</option>
        {PRODUCT_TYPES.map((type) => (
          <option key={type} value={type}>
            {t(`productType.${type}`)}
          </option>
        ))}
      </Select>
      <Select size="sm" aria-label={t('list.ppeFilter')} value={model.filters.ppe} onChange={(event) => actions?.onFilters?.({ ...model.filters, ppe: event.target.value })}>
        <option value="">{t('list.allPpe')}</option>
        {PPE_CATEGORIES.map((category) => (
          <option key={category} value={category}>
            {t(`ppe.short.${category}`)}
          </option>
        ))}
      </Select>
    </>
  )

  return (
    <div className="fw-stl">
      <div className="fw-stl-head">
        <div className="fw-stl-head-text">
          <p className="fw-st-hint">{t('list.intro')}</p>
          <span className="fw-st-hint" role="status">
            {model.asOf ? t('list.updated', { time: formatTime(model.asOf, { locale }) }) : t('list.notYet')}
          </span>
          {(showPrice || showMargin) && prices.state === 'ready' && <span className="fw-st-hint">{t('list.price.list', { code: prices.list.code, name: prices.list.name })}</span>}
          {(showPrice || showMargin) && prices.state === 'none' && <span className="fw-st-hint">{t('list.price.noList')}</span>}
          {(showPrice || showMargin) && prices.state === 'error' && <span className="fw-st-hint">{t('list.price.failed')}</span>}
        </div>
        <Button size="sm" variant="primary" heldReason={model.can.manage ? null : t('held.noManage')} onClick={() => actions?.onNewStyle?.(true)} aria-keyshortcuts="c">
          <Plus size={14} aria-hidden /> {t('list.new')}
        </Button>
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
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
        metrics={STYLE_TILES.map((tile) => {
          const count = model.tiles[tile]
          return {
            label: t(`list.tile.${tile}`),
            value: count === null || count === undefined ? '—' : String(count),
            hint: t(`list.tileHint.${tile}`),
            onClick: () => actions?.onFilters?.({ ...model.filters, view: model.filters.view === tile ? 'open' : tile }),
            active: model.filters.view === tile,
          }
        })}
      />

      {filtered && (
        <div className="fw-stl-chips" aria-label={t('list.activeFilters')}>
          {model.filters.view !== 'open' && (
            <TokenChip removeLabel={t('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, view: 'open' })}>
              {t(`list.view.${model.filters.view}`)}
            </TokenChip>
          )}
          {model.filters.type && (
            <TokenChip removeLabel={t('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, type: '' })}>
              {t(`productType.${model.filters.type}`)}
            </TokenChip>
          )}
          {model.filters.ppe && (
            <TokenChip removeLabel={t('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, ppe: '' })}>
              {t(`ppe.short.${model.filters.ppe}`)}
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

      {phone ? (
        <StyleCards
          rows={state ? [] : items}
          state={state}
          count={countWords}
          search={searchField}
          filterCount={(model.filters.view !== 'open' ? 1 : 0) + (model.filters.type ? 1 : 0) + (model.filters.ppe ? 1 : 0)}
          onFilters={() => setDialog('filters')}
          selected={selected}
          onSelected={setSelected}
          bulk={bulkActions}
          prices={prices}
          showPrice={showPrice}
          recordHref={recordHref}
          onDuplicate={(row) => actions?.onDuplicate?.(row)}
          duplicateHeld={duplicateHeld}
          more={model.rows.more && items && items.length > 0 ? { label: t('list.more'), onMore: () => actions?.onMore?.() } : null}
          selectMode={model.phoneSelect}
        />
      ) : (
      <ListFrame<StyleRow>
        label={t('list.tableLabel')}
        rows={state ? [] : items}
        rowId={(row) => row.id}
        columns={columns}
        count={countWords}
        search={searchField}
        tools={filterSelects}
        // Every row may be selected: Export applies to any style; Archive N is held with its reason when an archived one
        // is among them (no isRowSelectable: no row is without a bulk action).
        selection={{
          selected,
          onChange: setSelected,
          actions: bulkActions,
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.rows.more && items && items.length > 0 ? { label: t('list.more'), onMore: () => actions?.onMore?.() } : null}
        keys={ownKeys}
        onHelp={() => setDialog('help')}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
        focusRow={model.focusRow}
      />
      )}

      {model.newStyle && <NewStyleDialog model={model.newStyle} actions={actions} />}
      {model.duplicate && <DuplicateDialog model={model.duplicate} can={model.can} prefix={model.prefix} actions={actions?.duplicate} />}
      {dialog === 'filters' && (
        <Modal
          open
          onClose={() => setDialog(null)}
          title={t('phone.filtersTitle')}
          size="sm"
          footer={
            <>
              <Button onClick={() => actions?.onFilters?.({ ...NO_FILTERS, q: model.filters.q })}>{t('list.clearAll')}</Button>
              <Button variant="primary" onClick={() => setDialog(null)}>
                {t('phone.showResults')}
              </Button>
            </>
          }
        >
          <div className="fw-st-dialog fw-stc-filters">{filterSelects}</div>
        </Modal>
      )}
      {dialog === 'archive' && <ArchiveManyDialog rows={picked} busy={model.busy} actions={actions} onDone={() => setSelected([])} onClose={() => setDialog(null)} />}
      {dialog === 'help' && (
        <Modal open onClose={() => setDialog(null)} title={t('keys.title')} size="sm">
          <ul className="fw-st-list">
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

/** Archive several styles: what it does, one reason for all (each archived with its own version). */
function ArchiveManyDialog({ rows, busy, actions, onDone, onClose }: { rows: readonly StyleRow[]; busy?: boolean; actions?: StylesListActions; onDone: () => void; onClose: () => void }) {
  const t = useT('products')
  const [reason, setReason] = useState('')
  const held = reason.trim().length > 500 ? t('held.long') : busy ? t('held.busy') : null
  const go = () => {
    if (held) return
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
      title={t('list.bulk.archiveTitle', { count: rows.length })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('common.back')}</Button>
          <Button variant="danger" heldReason={held} onClick={go}>
            {t('list.bulk.archive', { count: rows.length })}
          </Button>
        </>
      }
    >
      <div className="fw-st-dialog">
        <ul className="fw-st-list">
          <li>{t('archive.reach')}</li>
          <li>{t('archive.kept')}</li>
          <li>{t('archive.back')}</li>
        </ul>
        <ul className="fw-st-list">
          {rows.map((row) => (
            <li key={row.id}>
              <b>{row.code}</b> · {row.name}
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

const STYLE_CODE = /^[A-Z0-9](?:[A-Z0-9._-]{0,22}[A-Z0-9])?$/

function NewStyleDialog({ model, actions }: { model: NewStyleModel; actions?: StylesListActions }) {
  const t = useT('products')
  const draft = model.draft
  const set = (patch: Partial<typeof draft>) => actions?.onNewDraft?.({ ...draft, ...patch })
  const code = draft.code.trim().toUpperCase()
  const held = !STYLE_CODE.test(code)
    ? t('newStyle.held.code')
    : draft.name.trim() === ''
      ? t('newStyle.held.name')
      : !draft.range.sizeScaleId
        ? t('newStyle.held.scale')
        : draft.range.sizes.length > 0 && !draft.range.baseSize
          ? t('range.held.base')
          : model.busy
            ? t('held.busy')
            : null
  const create = () => {
    if (!held) actions?.onCreate?.()
  }
  const refused = (path: string) => (model.refused.some((entry) => entry === path || entry.startsWith(`${path}/`)) ? t('newStyle.refused') : undefined)
  return (
    <Modal
      open
      onClose={() => actions?.onNewStyle?.(false)}
      title={t('newStyle.title')}
      size="lg"
      footer={
        <>
          <Button onClick={() => actions?.onNewStyle?.(false)}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={create} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('newStyle.create')}
          </Button>
        </>
      }
    >
      <div
        className="fw-st-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            create()
          }
        }}
      >
        <div className="fw-st-start" role="radiogroup" aria-label={t('newStyle.startFrom')}>
          {START_FROM.map((from) => (
            <RadioCard
              key={from}
              name="fw-new-style-from"
              value={from}
              checked={from === 'blank'}
              selected={from === 'blank'}
              disabled={from === 'template' || from === 'commerce'}
              title={
                <span className="fw-st-inline">
                  {t(`newStyle.from.${from}`)}
                  {(from === 'template' || from === 'commerce') && <Tag tone="neutral">{t(`newStyle.fromWhen.${from}`)}</Tag>}
                </span>
              }
              description={t(`newStyle.fromHint.${from}`)}
              onChange={() => {
                if (from === 'copy') actions?.onStartFrom?.('copy')
              }}
            />
          ))}
        </div>
        <p className="fw-st-hint">{t('newStyle.intro')}</p>
        <div className="fw-st-form-grid">
          {model.companies.length > 1 && (
            <Field label={t('newStyle.company')} hint={t('newStyle.companyHint')}>
              <Select value={draft.companyId ?? ''} onChange={(event) => set({ companyId: event.target.value || null })}>
                <option value="">{t('newStyle.everyCompany')}</option>
                {model.companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('identity.code')} required hint={t('identity.codeHint')} error={refused('code')}>
            <Input value={draft.code} maxLength={24} autoFocus onChange={(event) => set({ code: event.target.value.toUpperCase() })} />
          </Field>
          <Field label={t('identity.name')} required error={refused('name')}>
            <Input value={draft.name} maxLength={200} onChange={(event) => set({ name: event.target.value })} />
          </Field>
          <Field label={t('identity.type')}>
            <Select value={draft.productType} onChange={(event) => set({ productType: event.target.value as StyleRow['productType'], ppe: settlePpe(draft.ppe, event.target.value as StyleRow['productType']) })}>
              {PRODUCT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`productType.${type}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('identity.season')} hint={t('identity.seasonHint')}>
            <Input value={draft.season} maxLength={20} onChange={(event) => set({ season: event.target.value })} />
          </Field>
          {model.brands && (
            <Field label={t('identity.brand')} hint={t('identity.brandHint')}>
              <Select value={draft.brandPartyId ?? ''} onChange={(event) => set({ brandPartyId: event.target.value || null })}>
                <option value="">{t('identity.ownCollection')}</option>
                {model.brands.map((brand) => (
                  <option key={brand.id} value={brand.id}>
                    {brand.tradeName ?? brand.legalName} · {brand.code}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('identity.mtm')} hint={t('identity.mtmHint')}>
            <span className="fw-st-inline">
              <Toggle checked={draft.mtmAllowed} onChange={(next) => set({ mtmAllowed: next })} aria-label={t('identity.mtm')} />
              {t(draft.mtmAllowed ? 'common.yes' : 'common.no')}
            </span>
          </Field>
        </div>
        <h3 className="fw-st-h3">{t('range.title')}</h3>
        {model.scales && model.scales.length === 0 ? <Banner tone="warning" title={t('newStyle.noScales')} /> : <RangeFields value={draft.range} scales={model.scales} onChange={(range) => set({ range })} />}
        <h3 className="fw-st-h3">{t('identity.ppe')}</h3>
        <PpeFields value={draft.ppe} productType={draft.productType} onChange={(ppe) => set({ ppe })} />
        <p className="fw-st-hint">{t('newStyle.after')}</p>
        {model.problem && <Banner tone="danger" title={t(model.problem)} />}
      </div>
    </Modal>
  )
}
