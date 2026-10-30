'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Archive, Download, Euro, MoreHorizontal, Plus, Search } from 'lucide-react'
import { Banner, Field, Menu, MetricStrip, Modal } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Tag, Textarea, TokenChip } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { moneyText } from '../../styles/model'
import { isPageKey, keepLoaded } from '../../library/model'
import { Freshness, KeysDialog, LibraryMessages, listState, NoticeBanner, PageHead, showsState } from '../../library/parts'
import type { MaterialRow } from '../api'
import type { MaterialsListActions, MaterialsListViewModel } from '../list-model'
import { archiveHeld, costHeld, costInput, costOf, crViText, isFiltered, ITEM_KINDS, NO_FILTERS, STATUS_TONE, tilesFor, viewsFor } from '../model'
import { NewMaterialDialog } from './NewMaterialDialog'

export type { MaterialsListViewModel, MaterialsListActions } from '../list-model'

/**
 * SCR-047 — Materials & trims (Products; design products.materials, 00 §2.1 list frame): the saved-filter tiles (each
 * sets its view: one filter model you can see), the filter chips, the list on the shared list frame (select-all with
 * mixed state, shift range, x; bulk Export N, Set standard cost for N (the cost grain and product.materials.cost),
 * Archive N; keys only in the footer's information icon), each code a real link to the material record, and New
 * material (`c`). The standard cost column exists only for the cost grain (the API drops the field otherwise). It
 * fetches nothing.
 */
export function MaterialsListView({ model, actions }: { model: MaterialsListViewModel; actions?: MaterialsListActions }) {
  return (
    <LibraryMessages>
      <MaterialsList model={model} actions={actions} />
    </LibraryMessages>
  )
}

function MaterialsList({ model, actions }: { model: MaterialsListViewModel; actions?: MaterialsListActions }) {
  const t = useT('library')
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
  const [dialog, setDialog] = useState<'archive' | 'cost' | 'help' | null>(model.dialog ?? null)
  const items = model.rows.items
  const rowsKey = items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => keepLoaded(current, items)), [rowsKey])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])

  // c: a new material (00 §3.17) — never while typing or inside a dialog. The list frame keeps / j k x Enter ?.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.newMaterial || dialog) return
      if (event.key === 'c' && model.can.materialsManage) {
        event.preventDefault()
        actions?.onNew?.(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const recordHref = useCallback((row: MaterialRow) => `${model.prefix}/products/materials/${row.id}`, [model.prefix])
  const picked = (items ?? []).filter((row) => selected.includes(row.id))
  const ownKeys: ListKey[] = [{ keys: ['c'], does: t('materials.list.keyNew') }]
  const seesCost = model.can.seesCost

  const columns = useMemo<ColDef<MaterialRow>[]>(() => {
    const unit = (uom: string) => t(`uom.${uom}`)
    const CodeCell = ({ data }: ICellRendererParams<MaterialRow>) =>
      data ? (
        <span className="fw-lib-cell">
          <Link className="fw-lib-rowlink" href={recordHref(data)}>
            {data.code}
          </Link>
          <span className="fw-lib-sub">{data.name}</span>
        </span>
      ) : null
    const KindCell = ({ data }: ICellRendererParams<MaterialRow>) =>
      data ? (
        <span className="fw-lib-cell">
          <span>{t(`kind.${data.kind}`)}</span>
          <span className="fw-lib-sub">{t(`sourcing.${data.sourcing}`)}</span>
        </span>
      ) : null
    const UnitsCell = ({ data }: ICellRendererParams<MaterialRow>) =>
      data ? (
        <span className="fw-lib-cell">
          {/* Bought → stocked → used: "hide → ft² → dm²" (a unit shown once when two are the same). */}
          <span className="fw-lib-nowrap" title={t('materials.list.unitsTitle', { buy: unit(data.purchaseUom), stock: unit(data.baseUom), use: unit(data.consumptionUom) })}>
            {[data.purchaseUom, data.baseUom, data.consumptionUom].filter((uom, index, all) => index === 0 || uom !== all[index - 1]).map(unit).join(' → ')}
          </span>
          <span className="fw-lib-sub">{t(`tracking.${data.tracking}`)}</span>
        </span>
      ) : null
    const SupplierCell = ({ data }: ICellRendererParams<MaterialRow>) =>
      data ? (
        data.defaultSupplier ? (
          <span className="fw-lib-cell">
            <span>{data.defaultSupplier.name}</span>
            <span className="fw-lib-sub">{data.supplierArticleCode ? t('materials.list.theirCode', { code: data.supplierArticleCode }) : data.defaultSupplier.code}</span>
          </span>
        ) : (
          <span className="fw-lib-hint">{data.sourcing === 'MAKE' ? t('materials.list.made') : t('materials.list.noSupplier')}</span>
        )
      ) : null
    const CostCell = ({ data }: ICellRendererParams<MaterialRow>) => {
      if (!data) return null
      const cost = costOf(data)
      if (!cost) return <span className="fw-lib-hint">{t('common.notInRole')}</span>
      return cost.value === null ? (
        <span className="fw-lib-warn">{t('materials.list.missingCost')}</span>
      ) : (
        <span className="fw-lib-cell fw-lib-right">
          <span>{moneyText(cost.value, cost.currency, locale)}</span>
          <span className="fw-lib-sub">{t('materials.list.perUnit', { unit: unit(data.baseUom) })}</span>
        </span>
      )
    }
    const ComplianceCell = ({ data }: ICellRendererParams<MaterialRow>) => {
      if (!data) return null
      const crvi = crViText(data, locale)
      return (
        <span className="fw-lib-tags">
          {crvi ? <Tag tone="info">{t('materials.list.crvi', { limit: crvi })}</Tag> : null}
          {data.isPpeComponent ? <Tag tone="warning">{t('materials.list.ppe')}</Tag> : null}
          {!crvi && !data.isPpeComponent ? <span className="fw-lib-hint">—</span> : null}
        </span>
      )
    }
    const StatusCell = ({ data }: ICellRendererParams<MaterialRow>) => (data ? <Pill tone={STATUS_TONE[data.status]}>{t(`status.${data.status}`)}</Pill> : null)
    const MoreCell = ({ data }: ICellRendererParams<MaterialRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { code: data.code }) }}
          items={[
            { id: 'open', label: t('list.open'), href: recordHref(data) },
            { id: 'tab', label: t('list.openNewTab'), href: recordHref(data), target: '_blank' },
            { id: 'colours', label: t('materials.list.openColours'), href: `${recordHref(data)}?tab=colours` },
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
      { colId: 'code', headerName: t('materials.col.material'), field: 'code', minWidth: 200, flex: 2, cellRenderer: CodeCell },
      { colId: 'kind', headerName: t('materials.col.kind'), field: 'kind', minWidth: 130, flex: 1, cellRenderer: KindCell },
      { colId: 'units', headerName: t('materials.col.units'), field: 'baseUom', minWidth: 170, flex: 1, cellRenderer: UnitsCell },
      { colId: 'supplier', headerName: t('materials.col.supplier'), field: 'supplierArticleCode', cellDataType: false, minWidth: 170, flex: 1.4, cellRenderer: SupplierCell },
      { colId: 'colours', headerName: t('materials.col.colours'), field: 'colourCount', minWidth: 90, maxWidth: 120, type: 'rightAligned' },
      ...(seesCost ? [{ colId: 'cost', headerName: t('materials.col.cost'), field: 'standardCost', cellDataType: false, minWidth: 130, flex: 1, type: 'rightAligned', cellRenderer: CostCell } as ColDef<MaterialRow>] : []),
      { colId: 'compliance', headerName: t('materials.col.compliance'), field: 'requiresCrViTest', cellDataType: false, minWidth: 150, flex: 1, cellRenderer: ComplianceCell },
      { colId: 'status', headerName: t('materials.col.status'), field: 'status', minWidth: 100, maxWidth: 130, cellRenderer: StatusCell },
      { colId: 'more', headerName: t('list.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, recordHref, seesCost])

  const filtered = isFiltered(model.filters)
  const state = showsState(model.rows.problem, items)
    ? listState({
        problem: model.rows.problem,
        rows: items,
        filtered,
        forbidden: { title: t('materials.forbidden.title'), body: t('materials.forbidden.body') },
        empty: {
          title: t('materials.empty.title'),
          body: t(model.can.materialsManage ? 'materials.empty.body' : 'materials.empty.bodyView'),
          action: model.can.materialsManage ? (
            <Button size="sm" variant="primary" onClick={() => actions?.onNew?.(true)}>
              {t('materials.empty.create')}
            </Button>
          ) : undefined,
        },
        onRetry: () => actions?.onRetry?.(),
        onClear: () => actions?.onFilters?.(NO_FILTERS),
      })
    : undefined

  const views = viewsFor(model.can)
  const archiveReason = archiveHeld(picked, model.can)
  const costReason = costHeld(picked, model.can)

  return (
    <div className="fw-lib">
      <PageHead
        intro={t('materials.list.intro')}
        status={<Freshness asOf={model.asOf} />}
        actions={
          <Button size="sm" variant="primary" heldReason={model.can.materialsManage ? null : t('held.noManage')} onClick={() => actions?.onNew?.(true)} aria-keyshortcuts="c">
            <Plus size={14} aria-hidden /> {t('materials.list.new')}
          </Button>
        }
      />

      <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />

      <MetricStrip
        metrics={tilesFor(model.can).map((tile) => {
          const count = model.tiles[tile]
          return {
            label: t(`materials.tile.${tile}`),
            value: count === null || count === undefined ? '—' : String(count),
            hint: t(`materials.tileHint.${tile}`),
            onClick: () => actions?.onFilters?.({ ...model.filters, view: model.filters.view === tile ? 'open' : tile }),
            active: model.filters.view === tile,
          }
        })}
      />

      {filtered && (
        <div className="fw-lib-chips" aria-label={t('list.activeFilters')}>
          {model.filters.view !== 'open' && (
            <TokenChip removeLabel={t('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, view: 'open' })}>
              {t(`materials.view.${model.filters.view}`)}
            </TokenChip>
          )}
          {model.filters.kind && (
            <TokenChip removeLabel={t('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, kind: '' })}>
              {t(`kind.${model.filters.kind}`)}
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

      <ListFrame<MaterialRow>
        label={t('materials.list.tableLabel')}
        rows={state ? [] : items}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? t(model.rows.more ? 'list.countMore' : 'list.count', { count: items.length, total: model.rows.count ?? items.length }) : '—'}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={13} aria-hidden />}
            aria-label={t('materials.list.search')}
            placeholder={t('materials.list.search')}
            value={query}
            onChange={(event) => {
              typed.current = true
              setQuery(event.target.value)
            }}
          />
        }
        tools={
          <>
            <Select size="sm" aria-label={t('list.viewFilter')} value={model.filters.view} onChange={(event) => actions?.onFilters?.({ ...model.filters, view: event.target.value as MaterialsListViewModel['filters']['view'] })}>
              {views.map((view) => (
                <option key={view} value={view}>
                  {t(`materials.view.${view}`)}
                </option>
              ))}
            </Select>
            <Select size="sm" aria-label={t('materials.list.kindFilter')} value={model.filters.kind} onChange={(event) => actions?.onFilters?.({ ...model.filters, kind: event.target.value as MaterialsListViewModel['filters']['kind'] })}>
              <option value="">{t('materials.list.allKinds')}</option>
              {ITEM_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`kind.${kind}`)}
                </option>
              ))}
            </Select>
          </>
        }
        // Every row may be selected: Export applies to any material; Archive and Set standard cost say why they are held.
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <>
              <Button size="sm" aria-label={t('list.bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('list.bulk.export', { count: picked.length })}</SelectionLabel>
              </Button>
              {seesCost && (
                <Button size="sm" aria-label={t('materials.bulk.cost', { count: picked.length })} heldReason={costReason ? t(costReason) : null} onClick={() => setDialog('cost')}>
                  <Euro size={13} aria-hidden /> <SelectionLabel>{t('materials.bulk.cost', { count: picked.length })}</SelectionLabel>
                </Button>
              )}
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

      {model.newMaterial && <NewMaterialDialog model={model.newMaterial} can={model.can} actions={actions} />}
      {dialog === 'archive' && <ArchiveDialog rows={picked} busy={model.busy} actions={actions} onDone={() => setSelected([])} onClose={() => setDialog(null)} />}
      {dialog === 'cost' && <CostDialog rows={picked} busy={model.busy} actions={actions} onDone={() => setSelected([])} onClose={() => setDialog(null)} />}
      {dialog === 'help' && <KeysDialog keys={listKeys(ownKeys, true)} onClose={() => setDialog(null)} />}
    </div>
  )
}

/** Archive several materials: what it does and how to undo it; one reason for all (each with its own version). */
function ArchiveDialog({ rows, busy, actions, onDone, onClose }: { rows: readonly MaterialRow[]; busy: boolean; actions?: MaterialsListActions; onDone: () => void; onClose: () => void }) {
  const t = useT('library')
  const [reason, setReason] = useState('')
  const held = busy ? t('held.busy') : null
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
      title={t('materials.archive.title', { count: rows.length })}
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
      <div className="fw-lib-dialog">
        <ul className="fw-lib-list">
          <li>{t('materials.archive.reach')}</li>
          <li>{t('materials.archive.kept')}</li>
          <li>{t('materials.archive.back')}</li>
        </ul>
        <ul className="fw-lib-list">
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

/** Set the standard purchase price of several materials: old → new per material, one reason for the audit (GAP-006). */
function CostDialog({ rows, busy, actions, onDone, onClose }: { rows: readonly MaterialRow[]; busy: boolean; actions?: MaterialsListActions; onDone: () => void; onClose: () => void }) {
  const t = useT('library')
  const locale = useLocale()
  const [values, setValues] = useState<Record<string, string>>({})
  const [reason, setReason] = useState('')
  const changes = rows.flatMap((row) => {
    const text = values[row.id] ?? ''
    const next = costInput(text)
    if (text.trim() === '' || next === undefined) return []
    return next === (row.standardCost ?? null) ? [] : [{ id: row.id, cost: next }]
  })
  const invalid = rows.some((row) => (values[row.id] ?? '').trim() !== '' && costInput(values[row.id] ?? '') === undefined)
  const held = invalid ? t('materials.cost.held.invalid') : changes.length === 0 ? t('materials.cost.held.none') : busy ? t('held.busy') : null
  const go = () => {
    if (held) return
    void actions?.onSetCosts?.(changes, reason.trim()).then((done) => {
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
      title={t('materials.cost.title', { count: rows.length })}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={go} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('materials.cost.apply', { count: changes.length })}
          </Button>
        </>
      }
    >
      <div
        className="fw-lib-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            go()
          }
        }}
      >
        <p className="fw-lib-hint">{t('materials.cost.intro')}</p>
        <div className="fw-lib-rows">
          {rows.map((row) => {
            const text = values[row.id] ?? ''
            const bad = text.trim() !== '' && costInput(text) === undefined
            return (
              <div key={row.id} className="fw-lib-row">
                <span className="fw-lib-cell">
                  <b>{row.code}</b>
                  <span className="fw-lib-sub">
                    {t('materials.cost.now', { cost: row.standardCost ? moneyText(row.standardCost, row.currency, locale) : t('materials.list.missingCost'), unit: t(`uom.${row.baseUom}`) })}
                  </span>
                </span>
                <Field label={t('materials.cost.new', { unit: t(`uom.${row.baseUom}`) })} error={bad ? t('materials.cost.badNumber') : undefined}>
                  <Input inputMode="decimal" value={text} onChange={(event) => setValues((current) => ({ ...current, [row.id]: event.target.value }))} aria-label={t('materials.cost.newOf', { code: row.code })} />
                </Field>
                <span className="fw-lib-hint">{row.currency}</span>
              </div>
            )
          })}
        </div>
        <Field label={t('materials.cost.reason')} hint={t('materials.cost.reasonHint')}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} />
        </Field>
        <Banner tone="info" title={t('materials.cost.styles')} />
      </div>
    </Modal>
  )
}
