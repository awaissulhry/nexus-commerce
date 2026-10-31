'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Archive, Download, Plus, RotateCcw, Search, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Field, Modal } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Spinner, Tag, Textarea } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayAt, quantity, unitPrice } from '../../../../_shared/buying/model'
import { PREFERENCES, type Source } from '../api'
import {
  addHeld,
  bulkReach,
  cellKey,
  cellText,
  leadTimeSay,
  PREFERENCE_TONE,
  rowHeld,
  SOURCE_VIEWS,
  sourcesMatching,
  sortedSources,
  STATUS_TONE,
  unitsFor,
  type AddDraft,
  type ApprovedSourcesActions,
  type ApprovedSourcesModel,
  type CellField,
  type CellMark,
  type Say,
  type SourceView,
} from '../model'
import '../sources.css'

export type { ApprovedSourcesActions, ApprovedSourcesModel } from '../model'

/** The page's own words (`purchasing-sources`), with a phrase's parameters. */
function useWords() {
  const t = useT('purchasing-sources')
  return useMemo(() => Object.assign((key: string, params?: Say['params']) => t(key, params), { say: (words: Say) => t(words.key, words.params) }), [t])
}

/**
 * Supplier › Items & prices › Approved sources (SCR-057; design purchasing.suppliers "Items & prices", SCM-005): what this
 * supplier sells us and on what terms — the ONE list frame (select-all, shift range, x; Archive N, Restore N, Export N
 * while rows are picked), each cell typed in place and saved when it is left (autosave per cell: one field per change,
 * with the row's version; the cell says saving, saved or why it was refused), the material linked to its record, the
 * price and the last purchase price with the cost grain only (the column is not drawn without it), primary / backup, and
 * Add a source. A person without purchasing.sources.manage reads the cells as text. Import price list is W2b (not drawn).
 * Fetches nothing: ApprovedSources.tsx reads and writes.
 */
export function ApprovedSourcesView({ model, actions }: { model: ApprovedSourcesModel; actions?: ApprovedSourcesActions }) {
  return (
    <WithMessages namespaces={['purchasing-sources', 'lists']}>
      <Sources model={model} actions={actions} />
    </WithMessages>
  )
}

function Sources({ model, actions }: { model: ApprovedSourcesModel; actions?: ApprovedSourcesActions }) {
  const t = useWords()
  const lists = useT('lists')
  const locale = useLocale()
  const [query, setQuery] = useState(model.q)
  useEffect(() => setQuery(model.q), [model.q])
  const rows = useMemo(() => (model.read.status === 'ready' ? sortedSources(sourcesMatching(model.read.rows, model.q)) : null), [model.read, model.q])
  const all = model.read.status === 'ready' ? model.read.rows : []
  const reach = bulkReach(all, model.selected)
  const picked = all.filter((row) => model.selected.includes(row.id))
  const live = useRef({ actions, cells: model.cells, can: model.can, locale })
  live.current = { actions, cells: model.cells, can: model.can, locale }
  const ownKeys: ListKey[] = [{ keys: ['n'], does: t('keys.add') }]

  // n: Add a source; ? the keys — never while typing, in a dialog or a menu.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.dialog) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]') || target.isContentEditable)) return
      if (event.key === 'n' && model.can.view && model.can.manage) {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'add', draft: newDraftOf(model) })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const columns = useMemo<ColDef<Source>[]>(() => {
    const words = t
    const MaterialCell = ({ data }: ICellRendererParams<Source>) =>
      data ? (
        <span className="fw-src-cell">
          {live.current.can.materials ? (
            <Link className="fw-src-link" href={`${model.prefix}/products/materials/${encodeURIComponent(data.itemId)}?tab=suppliers`} tabIndex={-1}>
              {data.item.code}
            </Link>
          ) : (
            <b>{data.item.code}</b>
          )}
          <span className="fw-src-sub" title={data.item.name}>
            {data.item.name} · {data.colour ? `${data.colour.code} ${data.colour.name}` : words('everyColour')}
          </span>
        </span>
      ) : null
    const CompanyCell = ({ data }: ICellRendererParams<Source>) => (data ? <span>{data.company ? data.company.code : words('everyCompany')}</span> : null)
    const text = (field: CellField, align: 'left' | 'right' = 'left') =>
      function TextCell({ data }: ICellRendererParams<Source>) {
        if (!data) return null
        return <CellEditor row={data} field={field} align={align} live={live} words={words} />
      }
    const UnitCell = ({ data }: ICellRendererParams<Source>) => {
      if (!data) return null
      const options = [...new Set([data.purchaseUom, data.item.purchaseUom, data.item.baseUom])]
      return (
        <span className="fw-src-cell">
          <CellEditor row={data} field="purchaseUom" options={options.map((uom) => ({ value: uom, label: words(`uom.${uom}`) }))} live={live} words={words} />
          {data.unitUsable ? (
            data.purchaseUom !== data.baseUom && <span className="fw-src-sub">{words('unit.factor', { unit: words(`uom.${data.purchaseUom}`), factor: quantity(data.purchaseFactor, live.current.locale, 4), base: words(`uom.${data.baseUom}`) })}</span>
          ) : (
            <Tag tone="warning">{words('unit.notUsable')}</Tag>
          )}
        </span>
      )
    }
    const PriceCell = ({ data }: ICellRendererParams<Source>) =>
      data ? (
        <span className="fw-src-cell">
          <CellEditor row={data} field="unitPrice" align="right" live={live} words={words} shown={unitPrice(data.unitPrice, data.currency, live.current.locale)} />
          <span className="fw-src-sub">{words('price.per', { currency: data.currency, unit: words(`uom.${data.purchaseUom}`) })}</span>
        </span>
      ) : null
    const LeadCell = ({ data }: ICellRendererParams<Source>) =>
      data ? (
        <span className="fw-src-cell">
          <CellEditor row={data} field="leadTimeDays" align="right" live={live} words={words} />
          {data.leadTimeDays === null && <span className="fw-src-sub">{words.say(leadTimeSay(data))}</span>}
        </span>
      ) : null
    const PreferenceCell = ({ data }: ICellRendererParams<Source>) =>
      data ? <CellEditor row={data} field="preference" options={PREFERENCES.map((value) => ({ value, label: words(`preference.${value}`) }))} live={live} words={words} pill={<Pill tone={PREFERENCE_TONE[data.preference]}>{words(`preference.${data.preference}`)}</Pill>} /> : null
    const LastCell = ({ data }: ICellRendererParams<Source>) => {
      if (!data) return null
      const last = data.lastPurchase
      if (!last) return <span className="fw-src-sub">{words('last.none')}</span>
      return (
        <span className="fw-src-cell">
          <Link className="fw-src-link" href={`${model.prefix}/purchasing/orders/${encodeURIComponent(last.purchaseOrderId)}`} tabIndex={-1}>
            {last.number}
          </Link>
          <span className="fw-src-sub">
            {formatDate(dayAt(last.orderDate), { locale: live.current.locale })}
            {live.current.can.cost && last.unitPrice !== undefined ? ` · ${unitPrice(last.unitPrice, last.currency, live.current.locale)} / ${words(`uom.${last.uom}`)}` : ''}
          </span>
        </span>
      )
    }
    const StatusCell = ({ data }: ICellRendererParams<Source>) => (data ? <Pill tone={STATUS_TONE[data.status]}>{words(`status.${data.status}`)}</Pill> : null)
    return [
      { colId: 'material', headerName: t('col.material'), minWidth: 190, flex: 1.6, cellRenderer: MaterialCell, valueGetter: (params) => params.data?.item.code ?? '' },
      { colId: 'company', headerName: t('col.company'), minWidth: 110, flex: 0.7, cellRenderer: CompanyCell, valueGetter: (params) => params.data?.company?.code ?? '' },
      { colId: 'article', headerName: t('col.article'), minWidth: 140, flex: 1, cellRenderer: text('supplierArticleCode'), valueGetter: (params) => params.data?.supplierArticleCode ?? '' },
      { colId: 'colourCode', headerName: t('col.colourCode'), minWidth: 130, flex: 0.9, cellRenderer: text('supplierColourCode'), valueGetter: (params) => params.data?.supplierColourCode ?? '' },
      { colId: 'description', headerName: t('col.description'), minWidth: 180, flex: 1.3, cellRenderer: text('description'), valueGetter: (params) => params.data?.description ?? '' },
      { colId: 'unit', headerName: t('col.unit'), minWidth: 150, flex: 0.9, cellRenderer: UnitCell, valueGetter: (params) => params.data?.purchaseUom ?? '' },
      // Money by grain: without the cost grain the price column is not drawn (the API sends no price either).
      ...(model.can.cost ? [{ colId: 'price', headerName: t('col.price'), minWidth: 150, flex: 1, type: 'rightAligned', cellRenderer: PriceCell, valueGetter: (params) => params.data?.unitPrice ?? '' } satisfies ColDef<Source>] : []),
      { colId: 'moq', headerName: t('col.moq'), minWidth: 110, flex: 0.7, type: 'rightAligned', cellRenderer: text('minOrderQty', 'right'), valueGetter: (params) => params.data?.minOrderQty ?? '' },
      { colId: 'multiple', headerName: t('col.multiple'), minWidth: 110, flex: 0.7, type: 'rightAligned', cellRenderer: text('orderMultiple', 'right'), valueGetter: (params) => params.data?.orderMultiple ?? '' },
      { colId: 'lead', headerName: t('col.lead'), minWidth: 130, flex: 0.8, type: 'rightAligned', cellRenderer: LeadCell, valueGetter: (params) => params.data?.leadTimeDays ?? '' },
      { colId: 'preference', headerName: t('col.preference'), minWidth: 130, flex: 0.8, cellRenderer: PreferenceCell, valueGetter: (params) => params.data?.preference ?? '' },
      { colId: 'last', headerName: t('col.last'), minWidth: 160, flex: 1, cellRenderer: LastCell, valueGetter: (params) => params.data?.lastPurchase?.number ?? '' },
      { colId: 'status', headerName: t('col.status'), minWidth: 110, flex: 0.6, cellRenderer: StatusCell, valueGetter: (params) => params.data?.status ?? '' },
    ]
    // Words, the person's grains and the language rebuild the cells; the save marks are read through `live`.
  }, [t, model.prefix, model.can.cost, model.can.manage, model.can.materials, model.cells, locale])

  if (!model.can.view) {
    return (
      <Card padded>
        <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('noAccess.title')} description={t('noAccess.body')} />
      </Card>
    )
  }

  const addHeldWords = !model.can.manage ? t('held.noManage') : model.supplier.status === 'ARCHIVED' ? t('held.supplierArchived') : null
  const state: ReactNode =
    model.read.status === 'error' ? (
      <EmptyState title={t('list.failed')} description={t(model.read.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
    ) : rows && rows.length === 0 ? (
      model.q.trim() !== '' ? (
        <EmptyState
          title={t('list.noMatch')}
          action={
            <Button
              size="sm"
              onClick={() => {
                setQuery('')
                actions?.onSearch?.('')
              }}
            >
              {t('common.clearSearch')}
            </Button>
          }
        />
      ) : model.view === 'active' ? (
        <EmptyState
          title={t('list.empty.title')}
          description={t('list.empty.body')}
          action={
            model.can.manage ? (
              <Button size="sm" variant="primary" heldReason={addHeldWords} onClick={() => actions?.onDialog?.({ kind: 'add', draft: newDraftOf(model) })}>
                <Plus size={13} aria-hidden /> {t('add.open')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <EmptyState title={t(`list.emptyView.${model.view}`)} />
      )
    ) : undefined
  const bulkBusy = model.dialog?.kind === 'archive' || model.dialog?.kind === 'restore' ? t('held.busy') : null

  return (
    <div className="fw-src">
      <div className="fw-src-head">
        <div>
          <h2 className="fw-src-title">{t('title')}</h2>
          <p className="fw-src-hint">{t('intro', { supplier: model.supplier.name })}</p>
        </div>
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t.say(model.notice.words)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      {model.bulk && <BulkBanner outcome={model.bulk} onDismiss={() => actions?.onDismissNotice?.()} />}
      {!model.can.manage && (
        <Banner tone="info" title={t('readOnly.title')}>
          {t('readOnly.body')}
        </Banner>
      )}
      {!model.can.cost && <p className="fw-src-hint">{t('noCost')}</p>}

      <ListFrame<Source>
        label={t('list.label', { supplier: model.supplier.name })}
        listKey={null}
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        rowKind="two-line"
        count={rows ? t(model.read.status === 'ready' && model.read.more ? 'list.countMore' : 'list.count', { count: rows.length }) : '—'}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={13} aria-hidden />}
            aria-label={t('list.search')}
            placeholder={t('list.search')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              actions?.onSearch?.(event.target.value)
            }}
          />
        }
        tools={
          <Select size="sm" aria-label={t('list.viewLabel')} value={model.view} onChange={(event) => actions?.onView?.(event.target.value as SourceView)}>
            {SOURCE_VIEWS.map((view) => (
              <option key={view} value={view}>
                {t(`view.${view}`)}
              </option>
            ))}
          </Select>
        }
        right={
          <Button size="sm" variant="primary" heldReason={addHeldWords} aria-keyshortcuts="n" onClick={() => actions?.onDialog?.({ kind: 'add', draft: newDraftOf(model) })}>
            <Plus size={13} aria-hidden /> {t('add.open')}
          </Button>
        }
        selection={{
          selected: model.selected,
          onChange: (ids) => actions?.onSelect?.(ids),
          actions: (
            <>
              <Button
                size="sm"
                aria-label={t('bulk.archive', { count: reach.archive.length })}
                heldReason={!model.can.manage ? t('held.noManage') : reach.archive.length === 0 ? t('bulk.noneActive') : bulkBusy}
                onClick={() => actions?.onDialog?.({ kind: 'archive', ids: reach.archive.map((row) => row.id), reason: '', busy: false })}
              >
                <Archive size={13} aria-hidden /> <SelectionLabel>{t('bulk.archive', { count: reach.archive.length })}</SelectionLabel>
              </Button>
              <Button
                size="sm"
                aria-label={t('bulk.restore', { count: reach.restore.length })}
                heldReason={!model.can.manage ? t('held.noManage') : reach.restore.length === 0 ? t('bulk.noneArchived') : bulkBusy}
                onClick={() => actions?.onDialog?.({ kind: 'restore', ids: reach.restore.map((row) => row.id), busy: false })}
              >
                <RotateCcw size={13} aria-hidden /> <SelectionLabel>{t('bulk.restore', { count: reach.restore.length })}</SelectionLabel>
              </Button>
              <Button size="sm" aria-label={t('bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: picked.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.read.status === 'ready' && model.read.more ? { label: t('list.more'), onMore: () => actions?.onMore?.() } : null}
        keys={ownKeys}
        onHelp={() => actions?.onDialog?.({ kind: 'keys' })}
        state={state}
        focusRow={model.focusRow}
      />

      {model.dialog?.kind === 'add' && <AddDialog model={model} draft={model.dialog.draft} actions={actions} />}
      {model.dialog?.kind === 'archive' && <ArchiveDialog model={model} actions={actions} />}
      {model.dialog?.kind === 'restore' && <RestoreDialog model={model} actions={actions} />}
      {model.dialog?.kind === 'keys' && (
        <Modal open onClose={() => actions?.onDialog?.(null)} title={t('keys.title')} size="sm">
          <ul className="fw-src-list">
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

const newDraftOf = (model: ApprovedSourcesModel): AddDraft => ({
  materialQuery: '',
  materials: null,
  materialsProblem: null,
  material: null,
  materialProblem: null,
  itemColourId: '',
  scope: model.supplier.companyId === null && !model.company ? 'every' : 'company',
  purchaseUom: '',
  unitPrice: '',
  currency: model.supplier.currency,
  minOrderQty: '',
  orderMultiple: '',
  leadTimeDays: '',
  preference: 'BACKUP',
  supplierArticleCode: '',
  supplierColourCode: '',
  description: '',
  note: '',
  busy: false,
  problem: null,
})

type Words = ReturnType<typeof useWords>
type Live = { current: { actions?: ApprovedSourcesActions; cells: Readonly<Record<string, CellMark>>; can: ApprovedSourcesModel['can']; locale: string } }

/**
 * The cell editor (a composed stand-in for the DS grid's own editors + CellSaveMark, whose words are English only): an
 * input or a select drawn in the cell, saved when it is left (Enter leaves it, Escape puts the value back), and its mark
 * beside it — saving, saved, or why it was refused. A row the person may not change draws the value as text.
 */
function CellEditor({
  row,
  field,
  align = 'left',
  options,
  live,
  words,
  shown,
  pill,
}: {
  row: Source
  field: CellField
  align?: 'left' | 'right'
  options?: { value: string; label: string }[]
  live: Live
  words: Words
  shown?: string
  pill?: ReactNode
}) {
  const { can, cells } = live.current
  const mark = cells[cellKey(row.id, field)]
  const value = cellText(row, field)
  const label = words('cell.label', { field: words(`field.${field}`), material: row.item.code })
  if (rowHeld(row, can)) {
    if (pill) return <>{pill}</>
    const text = options ? (options.find((option) => option.value === value)?.label ?? value) : shown ?? (value || '—')
    return <span className={align === 'right' ? 'fw-src-num' : undefined}>{text}</span>
  }
  const markNode = mark ? (
    <span className={`fw-src-mark ${mark.state}`} role="status" title={mark.state === 'refused' ? words.say(mark.words) : undefined}>
      {mark.state === 'refused' ? words.say(mark.words) : words(`cell.${mark.state}`)}
    </span>
  ) : null
  if (options) {
    return (
      <span className={`fw-src-edit${align === 'right' ? ' right' : ''}`}>
        <Select
          size="sm"
          className="fw-src-edit-field"
          aria-label={label}
          value={value}
          onKeyDown={(event) => event.stopPropagation()}
          onChange={(event) => live.current.actions?.onCell?.(row, field, event.target.value)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        {markNode}
      </span>
    )
  }
  return (
    <span className={`fw-src-edit${align === 'right' ? ' right' : ''}`}>
      <Input
        key={`${row.id}-${field}-${row.version}-${value}`}
        size="sm"
        fieldClassName="fw-src-edit-field"
        inputMode={align === 'right' ? 'decimal' : undefined}
        aria-label={label}
        defaultValue={value}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
          if (event.key === 'Escape') {
            ;(event.target as HTMLInputElement).value = value
            ;(event.target as HTMLInputElement).blur()
          }
        }}
        onBlur={(event) => {
          if (event.target.value.trim() !== value.trim()) live.current.actions?.onCell?.(row, field, event.target.value)
        }}
      />
      {markNode}
    </span>
  )
}

function BulkBanner({ outcome, onDismiss }: { outcome: NonNullable<ApprovedSourcesModel['bulk']>; onDismiss: () => void }) {
  const t = useWords()
  return (
    <Banner
      tone={outcome.refused.length > 0 ? 'warning' : 'success'}
      title={t(`bulk.done.${outcome.verb}`, { count: outcome.done })}
      action={
        <Button size="sm" variant="quiet" onClick={onDismiss}>
          {t('common.dismiss')}
        </Button>
      }
    >
      {outcome.refused.length > 0 && (
        <ul className="fw-src-list">
          {outcome.refused.map((entry) => (
            <li key={entry.label}>{t('bulk.refusedRow', { label: entry.label, why: t.say(entry.words) })}</li>
          ))}
        </ul>
      )}
    </Banner>
  )
}

/** Add a source: the material (and colour, or every colour), the company it holds for, the supplier's terms. */
function AddDialog({ model, draft, actions }: { model: ApprovedSourcesModel; draft: AddDraft; actions?: ApprovedSourcesActions }) {
  const t = useWords()
  const held = addHeld(draft, model.can, { companyId: model.supplier.companyId, companyIdOfAddress: model.company?.id ?? null })
  const change = (next: Partial<AddDraft>) => actions?.add?.onChange?.({ ...draft, ...next, problem: null })
  const material = draft.material
  const units = material ? unitsFor(material) : []
  const colours = material ? material.colours.filter((colour) => colour.status === 'ACTIVE') : []
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('add.title', { supplier: model.supplier.name })}
      size="lg"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onDialog?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held ? t.say(held) : null} onClick={() => actions?.add?.onAdd?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
            {draft.busy && <Spinner size={12} />} {t('add.submit')}
          </Button>
        </>
      }
    >
      <div
        className="fw-src-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held) {
            event.preventDefault()
            actions?.add?.onAdd?.()
          }
        }}
      >
        {!model.can.materials ? (
          <Banner tone="info" title={t('add.noMaterials')} />
        ) : material ? (
          <div className="fw-src-inline">
            <b>{material.code}</b>
            <span className="fw-src-hint">{material.name}</span>
            <Button size="sm" variant="quiet" onClick={() => actions?.add?.onMaterial?.(null)}>
              {t('add.otherMaterial')}
            </Button>
          </div>
        ) : (
          <>
            <Field label={t('add.material')} required hint={t('add.materialHint')}>
              <Input size="sm" type="search" leadingIcon={<Search size={13} aria-hidden />} value={draft.materialQuery} placeholder={t('add.materialSearch')} onChange={(event) => actions?.add?.onMaterialQuery?.(event.target.value)} autoFocus />
            </Field>
            {draft.materialsProblem ? (
              <Banner tone="danger" title={t(draft.materialsProblem)} />
            ) : draft.materials === null ? (
              <p className="fw-src-hint" role="status">
                <Spinner size={12} /> {t('common.loading')}
              </p>
            ) : draft.materials.length === 0 ? (
              <p className="fw-src-hint">{t('add.noMaterial')}</p>
            ) : (
              <div className="fw-src-options" role="list" aria-label={t('add.material')}>
                {draft.materials.slice(0, 10).map((option) => (
                  <Button key={option.id} size="sm" variant="quiet" onClick={() => actions?.add?.onMaterial?.(option.id)}>
                    <span className="fw-src-inline">
                      <b>{option.code}</b>
                      <span className="fw-src-hint">{option.name}</span>
                    </span>
                  </Button>
                ))}
              </div>
            )}
            {draft.materialProblem && <Banner tone="danger" title={t(draft.materialProblem)} />}
          </>
        )}

        <div className="fw-src-fields">
          <Field label={t('add.colour')} hint={t('add.colourHint')}>
            <Select size="sm" value={draft.itemColourId} disabled={!material} onChange={(event) => change({ itemColourId: event.target.value })}>
              <option value="">{t('everyColour')}</option>
              {colours.map((colour) => (
                <option key={colour.id} value={colour.id}>
                  {colour.code} · {colour.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('add.company')} hint={model.supplier.companyId !== null ? t('add.companyOneHint') : t('add.companyHint')}>
            <Select size="sm" value={draft.scope} onChange={(event) => change({ scope: event.target.value as AddDraft['scope'] })}>
              {model.company && <option value="company">{t('add.thisCompany', { company: model.company.code })}</option>}
              <option value="every" disabled={model.supplier.companyId !== null}>
                {t('everyCompany')}
              </option>
            </Select>
          </Field>
          <Field label={t('add.unit')} hint={material ? t('add.unitHint', { unit: t(`uom.${material.purchaseUom}`) }) : undefined}>
            <Select size="sm" value={draft.purchaseUom} disabled={!material} onChange={(event) => change({ purchaseUom: event.target.value })}>
              <option value="">{material ? t('add.unitDefault', { unit: t(`uom.${material.purchaseUom}`) }) : '—'}</option>
              {units.map((uom) => (
                <option key={uom} value={uom}>
                  {t(`uom.${uom}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('add.preference')} hint={t('add.preferenceHint')}>
            <Select size="sm" value={draft.preference} onChange={(event) => change({ preference: event.target.value as AddDraft['preference'] })}>
              {PREFERENCES.map((value) => (
                <option key={value} value={value}>
                  {t(`preference.${value}`)}
                </option>
              ))}
            </Select>
          </Field>
          {model.can.cost && (
            <Field label={t('add.price')} hint={t('add.priceHint')}>
              <Input size="sm" inputMode="decimal" value={draft.unitPrice} onChange={(event) => change({ unitPrice: event.target.value })} />
            </Field>
          )}
          <Field label={t('add.currency')}>
            <Input size="sm" value={draft.currency} maxLength={3} onChange={(event) => change({ currency: event.target.value.toUpperCase() })} />
          </Field>
          <Field label={t('field.minOrderQty')}>
            <Input size="sm" inputMode="decimal" value={draft.minOrderQty} onChange={(event) => change({ minOrderQty: event.target.value })} />
          </Field>
          <Field label={t('field.orderMultiple')}>
            <Input size="sm" inputMode="decimal" value={draft.orderMultiple} onChange={(event) => change({ orderMultiple: event.target.value })} />
          </Field>
          <Field label={t('field.leadTimeDays')} hint={t('add.leadHint')}>
            <Input size="sm" inputMode="numeric" value={draft.leadTimeDays} onChange={(event) => change({ leadTimeDays: event.target.value })} />
          </Field>
          <Field label={t('field.supplierArticleCode')}>
            <Input size="sm" value={draft.supplierArticleCode} maxLength={60} onChange={(event) => change({ supplierArticleCode: event.target.value })} />
          </Field>
          <Field label={t('field.supplierColourCode')}>
            <Input size="sm" value={draft.supplierColourCode} maxLength={60} onChange={(event) => change({ supplierColourCode: event.target.value })} />
          </Field>
          <Field label={t('field.description')}>
            <Input size="sm" value={draft.description} maxLength={300} onChange={(event) => change({ description: event.target.value })} />
          </Field>
        </div>
        <Field label={t('add.note')}>
          <Textarea value={draft.note} rows={2} maxLength={1000} onChange={(event) => change({ note: event.target.value })} />
        </Field>
        {!model.can.cost && <p className="fw-src-hint">{t('add.noCost')}</p>}
        {draft.preference === 'PRIMARY' && <p className="fw-src-hint">{t('add.primaryNote')}</p>}
        {draft.problem && <Banner tone="danger" title={t.say(draft.problem)} />}
      </div>
    </Modal>
  )
}

function ArchiveDialog({ model, actions }: { model: ApprovedSourcesModel; actions?: ApprovedSourcesActions }) {
  const t = useWords()
  const dialog = model.dialog as Extract<NonNullable<ApprovedSourcesModel['dialog']>, { kind: 'archive' }>
  const rows = model.read.status === 'ready' ? model.read.rows.filter((row) => dialog.ids.includes(row.id)) : []
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('archive.title', { count: dialog.ids.length })}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onDialog?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="danger-outline" heldReason={dialog.busy ? t('held.busy') : null} onClick={() => actions?.onArchive?.()}>
            {dialog.busy && <Spinner size={12} />} {t('archive.submit', { count: dialog.ids.length })}
          </Button>
        </>
      }
    >
      <div className="fw-src-dialog">
        <p className="fw-src-hint">{t('archive.body')}</p>
        <ul className="fw-src-list">
          {rows.map((row) => (
            <li key={row.id}>
              {row.item.code} · {row.colour?.code ?? t('everyColour')} · {row.company?.code ?? t('everyCompany')}
            </li>
          ))}
        </ul>
        <Field label={t('archive.reason')} hint={t('archive.reasonHint')}>
          <Textarea value={dialog.reason} rows={2} maxLength={500} onChange={(event) => actions?.onDialog?.({ ...dialog, reason: event.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}

function RestoreDialog({ model, actions }: { model: ApprovedSourcesModel; actions?: ApprovedSourcesActions }) {
  const t = useWords()
  const dialog = model.dialog as Extract<NonNullable<ApprovedSourcesModel['dialog']>, { kind: 'restore' }>
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('restore.title', { count: dialog.ids.length })}
      size="sm"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onDialog?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={dialog.busy ? t('held.busy') : null} onClick={() => actions?.onRestore?.()}>
            {dialog.busy && <Spinner size={12} />} {t('restore.submit', { count: dialog.ids.length })}
          </Button>
        </>
      }
    >
      <p className="fw-src-hint">{t('restore.body')}</p>
    </Modal>
  )
}
