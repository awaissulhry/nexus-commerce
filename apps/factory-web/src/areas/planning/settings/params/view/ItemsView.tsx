'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FileUp, PencilLine, RotateCcw, Search, XCircle } from 'lucide-react'
import { Banner, EmptyState, Field, Modal } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Checkbox, Input, SegmentedControl, Select, Spinner } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../../list-frame/model'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { PlanningMethod, PlanningSite, PlanningSource } from '../../api'
import { manageHeld, type SettingsCan } from '../../model'
import { ReadFailed } from '../../view/parts'
import {
  BULK_FIELDS,
  bulkCounts,
  bulkLines,
  bulkPatch,
  DAY_FIELDS,
  defaultWords,
  EMPTY_BULK,
  ITEM_QTY_FIELDS,
  makeSitesOf,
  markKey,
  methodPatch,
  PARAMS_NAMESPACES,
  planPatch,
  qtyText,
  rowName,
  rowsWithParameters,
  sourcePatch,
  type BulkDraft,
  type BulkField,
  type BulkLine,
  type CellField,
  type ItemRow,
  type Mark,
  type Named,
  type Notice,
  type NumberField,
  type Words,
} from '../model'
import { cellKeys, ElsewhereBanner, KeysDialog, NoticeBanner, SaveMark, useSay } from './cells'
import '../params.css'

export type ItemsDialog =
  | { kind: 'method'; key: string; method?: PlanningMethod; first?: string; second?: string }
  | { kind: 'source'; key: string; source?: PlanningSource | null; supplierId?: string | null; makeSiteId?: string | null }
  | { kind: 'bulk'; step: 'fields' | 'review'; draft: BulkDraft }
  | { kind: 'defaults' }
  | { kind: 'keys' }

export interface SupplierChoices {
  itemId: string
  status: 'loading' | 'ready' | 'error'
  items: readonly Named[]
}

/** The ONE view model of Item parameters: what the container read and what is in flight. It fetches nothing. */
export interface ItemsModel {
  prefix: string
  site: PlanningSite
  sites: readonly PlanningSite[]
  can: SettingsCan
  load: { status: 'loading' } | { status: 'error'; problem: string } | { status: 'ready' }
  rows: readonly ItemRow[] | null
  /** More items to read (`nextCursor`). */
  more: boolean
  loadingMore: boolean
  query: string
  method: PlanningMethod | null
  configured: boolean | null
  marks: Readonly<Record<string, Mark>>
  notice: Notice | null
  changedElsewhere: boolean
  busy: boolean
  suppliers?: SupplierChoices | null
  /** Design cases: rows selected, a dialog open, the focused row. */
  selected?: readonly string[]
  dialog?: ItemsDialog | null
  focusRow?: number
}

export interface ItemsActions {
  onQuery?: (query: string) => void
  onMethod?: (method: PlanningMethod | null) => void
  onConfigured?: (configured: boolean | null) => void
  onMore?: () => void
  onRetry?: () => void
  onReload?: () => void
  /** A number cell typed. */
  onCell?: (row: ItemRow, field: NumberField, raw: unknown) => void
  /** A dialog's change of one row (method with its values; source with supplier or make site). */
  onPatch?: (row: ItemRow, field: CellField, patch: Record<string, unknown>) => void
  onSuppliers?: (row: ItemRow) => void
  /** The reviewed bulk change: each line that writes, one after the other. */
  onBulk?: (lines: readonly BulkLine[]) => Promise<boolean>
  /** "Plan N by defaults": the rows with site parameters are removed. */
  onDefaults?: (rows: readonly ItemRow[]) => Promise<boolean>
  onDismissNotice?: () => void
}

export function ItemsView({ model, actions }: { model: ItemsModel; actions?: ItemsActions }) {
  return (
    <WithMessages namespaces={PARAMS_NAMESPACES}>
      <Items model={model} actions={actions} />
    </WithMessages>
  )
}

const METHODS: PlanningMethod[] = ['ORDERS', 'MANUAL', 'REORDER_POINT', 'MIN_MAX']

function Items({ model, actions }: { model: ItemsModel; actions?: ItemsActions }) {
  const t = useT('planning-params')
  const ts = useT('planning-settings')
  const say = useSay()
  const locale = useLocale()
  const held = manageHeld('items', model.can)
  const heldText = held ? ts(held) : null
  const [query, setQuery] = useState(model.query)
  useEffect(() => setQuery(model.query), [model.query])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const [dialog, setDialog] = useState<ItemsDialog | null>(model.dialog ?? null)
  useEffect(() => setDialog(model.dialog ?? null), [model.dialog])
  const rowsKey = model.rows?.map((row) => row.key).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((key) => model.rows?.some((row) => row.key === key))), [rowsKey])
  const rows = useMemo(() => {
    if (!model.rows) return null
    // Alone (the design index), the search filters the rows it was given; in the page the API does.
    if (actions?.onQuery || !query.trim()) return model.rows
    const needle = query.trim().toLowerCase()
    return model.rows.filter((row) => `${row.item.code} ${row.item.name}`.toLowerCase().includes(needle))
  }, [model.rows, query, actions?.onQuery])
  const picked = (model.rows ?? []).filter((row) => selected.includes(row.key))
  const latest = useRef({ model, actions, setDialog })
  latest.current = { model, actions, setDialog }
  const marksKey = JSON.stringify(model.marks)
  const can = model.can.manageItems

  const columns = useMemo<ColDef<ItemRow>[]>(() => {
    const mark = (key: string, field: string) => latest.current.model.marks[markKey(key, field)]
    const unitOf = (row: ItemRow) => t(`pp.uom.${row.item.baseUom}`)
    const ItemCell = ({ data }: ICellRendererParams<ItemRow>) =>
      data ? (
        <span className="fw-pp-two">
          <span className="fw-pp-code">{data.item.code}</span>
          <span className="fw-pp-sub">{data.item.name}</span>
        </span>
      ) : null
    const ColourCell = ({ data }: ICellRendererParams<ItemRow>) => (data ? <span className={data.colour ? undefined : 'fw-pp-sub'}>{data.colour ? data.colour.name : t('pp.colour.every')}</span> : null)
    const Choice = ({ data, field, text, faint, open }: { data: ItemRow; field: CellField; text: string; faint?: boolean; open: () => void }) => (
      <span className="fw-pp-cell">
        <Button size="sm" variant="quiet" heldReason={can ? null : heldText} aria-label={t('pp.cell.change', { field: t(`pp.field.${field}`), item: rowName(data), value: text })} onClick={open}>
          <span className={faint ? 'fw-pp-sub' : undefined}>{text}</span>
        </Button>
        <SaveMark mark={mark(data.key, field)} />
      </span>
    )
    const MethodCell = ({ data }: ICellRendererParams<ItemRow>) => {
      if (!data) return null
      const method = data.row?.method ?? 'ORDERS'
      return <Choice data={data} field="method" text={t(`pp.method.${method}`)} faint={!data.row} open={() => latest.current.setDialog({ kind: 'method', key: data.key })} />
    }
    const sourceText = (row: ItemRow) => (row.row?.source ? t(`pp.source.${row.row.source}`) : t('pp.source.own', { sourcing: t(`pp.sourcing.${row.defaults.sourcing}`) }))
    const SourceCell = ({ data }: ICellRendererParams<ItemRow>) => (data ? <Choice data={data} field="source" text={sourceText(data)} faint={!data.row?.source} open={() => latest.current.setDialog({ kind: 'source', key: data.key })} /> : null)
    const SupplierCell = ({ data }: ICellRendererParams<ItemRow>) => {
      if (!data) return null
      const own = data.row?.supplier
      const text = own ? own.name : data.defaults.supplier ? t('pp.default.supplier', { name: data.defaults.supplier.name }) : t('pp.none')
      return <Choice data={data} field="source" text={text} faint={!own} open={() => latest.current.setDialog({ kind: 'source', key: data.key, source: 'BUY' })} />
    }
    const MakeSiteCell = ({ data }: ICellRendererParams<ItemRow>) => {
      if (!data) return null
      const own = data.row?.makeSite
      return <Choice data={data} field="source" text={own ? t('pp.siteOption', { code: own.code, name: own.name }) : t('pp.none')} faint={!own} open={() => latest.current.setDialog({ kind: 'source', key: data.key, source: 'MAKE' })} />
    }
    const NumberCell = (field: NumberField) =>
      function NumberValue({ data }: ICellRendererParams<ItemRow>) {
        if (!data) return null
        const value = data.row ? data.row[field] : null
        const fallback = value === null ? defaultWords(field, data.defaults) : null
        const text = value === null ? (fallback ? say(fallback) : '') : DAY_FIELDS.includes(field as never) ? t('pp.days', { count: Number(value) }) : `${qtyText(String(value), locale)} ${unitOf(data)}`
        return (
          <span className="fw-pp-cell num">
            <span className={value === null ? 'fw-pp-sub' : undefined}>{text || '—'}</span>
            <SaveMark mark={mark(data.key, field)} />
          </span>
        )
      }
    const number = (field: NumberField): ColDef<ItemRow> => ({
      colId: field,
      headerName: t(`pp.col.${field}`),
      minWidth: 130,
      flex: 1,
      ...(can ? { editable: true, cellEditor: 'agTextCellEditor', cellEditorParams: { maxLength: 20 } } : {}),
      valueGetter: (params) => (params.data?.row ? (params.data.row[field] === null ? '' : String(params.data.row[field])) : ''),
      valueSetter: (params) => {
        if (params.data) latest.current.actions?.onCell?.(params.data, field, params.newValue)
        return false
      },
      cellRenderer: NumberCell(field),
      suppressKeyboardEvent: cellKeys(),
    })
    const choice = (colId: string, renderer: (params: ICellRendererParams<ItemRow>) => ReactNode, open: (row: ItemRow) => ItemsDialog, minWidth = 150): ColDef<ItemRow> => ({
      colId,
      headerName: t(`pp.col.${colId}`),
      minWidth,
      flex: 1.1,
      cellRenderer: renderer,
      suppressKeyboardEvent: (params: { event: KeyboardEvent; editing: boolean; data?: ItemRow }) => cellKeys(can && params.data ? () => latest.current.setDialog(open(params.data!)) : undefined)(params),
    })
    return [
      { colId: 'item', headerName: t('pp.col.item'), minWidth: 200, flex: 1.6, cellRenderer: ItemCell, suppressKeyboardEvent: cellKeys() },
      { colId: 'colour', headerName: t('pp.col.colour'), minWidth: 130, flex: 0.9, cellRenderer: ColourCell, suppressKeyboardEvent: cellKeys() },
      choice('method', MethodCell, (row) => ({ kind: 'method', key: row.key })),
      choice('source', SourceCell, (row) => ({ kind: 'source', key: row.key })),
      choice('supplier', SupplierCell, (row) => ({ kind: 'source', key: row.key, source: 'BUY' }), 170),
      choice('makeSite', MakeSiteCell, (row) => ({ kind: 'source', key: row.key, source: 'MAKE' })),
      ...DAY_FIELDS.map(number),
      ...ITEM_QTY_FIELDS.map(number),
    ]
    // The marks repaint the cells; the rest of the model is read through `latest`.
  }, [t, locale, can, heldText, marksKey, say])

  const ownKeys: ListKey[] = can
    ? [
        { keys: ['↵'], does: t('pp.keys.edit') },
        { keys: ['Esc'], does: t('pp.keys.cancel') },
        { keys: ['⌘', 'Z'], does: t('pp.keys.undo') },
      ]
    : []
  const withRows = rowsWithParameters(picked)
  const ready = model.load.status === 'ready' && model.rows !== null
  const filtered = !!query.trim() || model.method !== null || model.configured !== null

  let state: ReactNode = undefined
  if (model.load.status === 'error') state = <ReadFailed title={t('pp.items.failed')} problem={model.load.problem} onRetry={actions?.onRetry} />
  else if (ready && rows && rows.length === 0)
    state = filtered ? (
      <EmptyState title={t('pp.items.noMatch')} action={<Button size="sm" onClick={() => { setQuery(''); actions?.onQuery?.(''); actions?.onMethod?.(null); actions?.onConfigured?.(null) }}>{t('pp.clearFilters')}</Button>} />
    ) : (
      <EmptyState title={t('pp.items.empty.title')} description={t('pp.items.empty.body')} />
    )

  const dialogRow = dialog && (dialog.kind === 'method' || dialog.kind === 'source') ? (model.rows ?? []).find((row) => row.key === dialog.key) ?? null : null
  const close = () => setDialog(null)

  return (
    <section className="fw-pp" aria-label={t('pp.items.title')}>
      <p className="fw-ps-hint">{t('pp.items.hint', { site: model.site.name })}</p>
      {model.changedElsewhere && <ElsewhereBanner onReload={actions?.onReload} />}
      <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
      {ready && !can && <Banner tone="neutral" title={t('pp.readOnly.title')}>{heldText}</Banner>}
      <ListFrame<ItemRow>
        label={t('pp.items.table')}
        listKey="planning.settings.items"
        rows={state ? [] : rows}
        rowId={(row) => row.key}
        columns={columns}
        rowKind="two-line"
        count={model.rows ? t('pp.items.count', { count: model.rows.length }) : '—'}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={13} aria-hidden />}
            aria-label={t('pp.items.search')}
            placeholder={t('pp.items.search')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              actions?.onQuery?.(event.target.value)
            }}
          />
        }
        tools={
          <>
            <Select size="sm" aria-label={t('pp.filter.method')} value={model.method ?? ''} onChange={(event) => actions?.onMethod?.((event.target.value || null) as PlanningMethod | null)}>
              <option value="">{t('pp.filter.anyMethod')}</option>
              {METHODS.map((method) => (
                <option key={method} value={method}>
                  {t(`pp.method.${method}`)}
                </option>
              ))}
            </Select>
            <SegmentedControl
              size="sm"
              ariaLabel={t('pp.filter.configured')}
              value={model.configured === null ? 'all' : model.configured ? 'yes' : 'no'}
              options={[
                { value: 'all', label: t('pp.filter.all') },
                { value: 'yes', label: t('pp.filter.yes') },
                { value: 'no', label: t('pp.filter.no') },
              ]}
              onChange={(value) => actions?.onConfigured?.(value === 'all' ? null : value === 'yes')}
            />
          </>
        }
        right={
          <Button size="sm" heldReason={t('pp.import.held')} aria-label={t('pp.import.label')}>
            <FileUp size={13} aria-hidden /> <SelectionLabel>{t('pp.import.label')}</SelectionLabel>
          </Button>
        }
        selection={
          ready
            ? {
                selected,
                onChange: setSelected,
                actions: (
                  <>
                    <Button size="sm" variant="primary" aria-label={t('pp.bulk.edit', { count: picked.length })} heldReason={heldText ?? (model.busy ? ts('ps.held.busy') : null)} onClick={() => setDialog({ kind: 'bulk', step: 'fields', draft: EMPTY_BULK })}>
                      <PencilLine size={13} aria-hidden /> <SelectionLabel>{t('pp.bulk.edit', { count: picked.length })}</SelectionLabel>
                    </Button>
                    <Button
                      size="sm"
                      variant="danger-outline"
                      aria-label={t('pp.bulk.defaults', { count: withRows.length })}
                      heldReason={heldText ?? (withRows.length === 0 ? t('pp.bulk.defaultsNone') : model.busy ? ts('ps.held.busy') : null)}
                      onClick={() => setDialog({ kind: 'defaults' })}
                    >
                      <RotateCcw size={13} aria-hidden /> <SelectionLabel>{t('pp.bulk.defaults', { count: withRows.length })}</SelectionLabel>
                    </Button>
                  </>
                ),
              }
            : undefined
        }
        more={model.more ? { label: t('pp.more'), onMore: () => actions?.onMore?.(), held: model.loadingMore ? t('pp.loadingMore') : null } : null}
        keys={ownKeys}
        onHelp={() => setDialog({ kind: 'keys' })}
        state={state}
        focusRow={model.focusRow}
      />
      {dialog?.kind === 'method' && dialogRow && <MethodDialog dialog={dialog} row={dialogRow} actions={actions} onClose={close} />}
      {dialog?.kind === 'source' && dialogRow && <SourceDialog dialog={dialog} row={dialogRow} model={model} actions={actions} onClose={close} />}
      {dialog?.kind === 'bulk' && <BulkDialog dialog={dialog} rows={picked} busy={model.busy} onDraft={setDialog} actions={actions} onClose={close} onDone={() => setSelected([])} />}
      {dialog?.kind === 'defaults' && <DefaultsDialog rows={withRows} busy={model.busy} actions={actions} onClose={close} onDone={() => setSelected([])} />}
      {dialog?.kind === 'keys' && <KeysDialog keys={ownKeys} selection onClose={close} />}
    </section>
  )
}

/** How the site plans the item: from the orders, by hand, a reorder point (with its lot size) or min/max (both stocks). */
export function MethodDialog({ dialog, row, actions, onClose }: { dialog: Extract<ItemsDialog, { kind: 'method' }>; row: ItemRow; actions?: ItemsActions; onClose: () => void }) {
  const t = useT('planning-params')
  const say = useSay()
  const current = row.row
  const [method, setMethod] = useState<PlanningMethod>(dialog.method ?? current?.method ?? 'ORDERS')
  const pairOf = (next: PlanningMethod): [string, string] =>
    next === 'REORDER_POINT' ? [current?.reorderPoint ?? '', current?.lotSize ?? ''] : next === 'MIN_MAX' ? [current?.minStock ?? '', current?.maxStock ?? ''] : ['', '']
  const [first, setFirst] = useState(dialog.first ?? pairOf(method)[0])
  const [second, setSecond] = useState(dialog.second ?? pairOf(method)[1])
  const typed = methodPatch(method, first, second)
  const plan = 'patch' in typed ? planPatch(current, typed.patch) : null
  const problem: Words | null = 'words' in typed ? typed.words : plan?.kind === 'refused' ? plan.words : null
  const reorder = method === 'REORDER_POINT' || method === 'MIN_MAX'
  const unit = t(`pp.uom.${row.item.baseUom}`)
  const apply = () => {
    if (!plan || plan.kind !== 'write') return
    actions?.onPatch?.(row, 'method', 'patch' in typed ? (typed.patch as Record<string, unknown>) : {})
    onClose()
  }
  const heldReason = problem ? say(problem) : plan?.kind === 'none' ? t('pp.held.same') : null
  return (
    <Modal
      open
      onClose={onClose}
      title={t('pp.methodDialog.title', { item: rowName(row) })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('pp.cancel')}</Button>
          <Button variant="primary" heldReason={heldReason} onClick={apply}>
            {t('pp.methodDialog.apply')}
          </Button>
        </>
      }
    >
      <div className="fw-pp-dialog">
        <SegmentedControl
          ariaLabel={t('pp.field.method')}
          wrap
          value={method}
          options={METHODS.map((value) => ({ value, label: t(`pp.method.${value}`) }))}
          onChange={(value) => {
            const next = value as PlanningMethod
            setMethod(next)
            const [a, b] = pairOf(next)
            setFirst(a)
            setSecond(b)
          }}
        />
        <p className="fw-ps-hint">{t(`pp.methodHint.${method}`)}</p>
        {reorder && (
          <div className="fw-pp-pair">
            <Field label={t(method === 'REORDER_POINT' ? 'pp.field.reorderPoint' : 'pp.field.minStock')} hint={t('pp.inUnit', { unit })} required>
              <Input inputMode="decimal" value={first} onChange={(event) => setFirst(event.target.value)} />
            </Field>
            <Field label={t(method === 'REORDER_POINT' ? 'pp.field.lotSize' : 'pp.field.maxStock')} hint={t('pp.inUnit', { unit })} required>
              <Input inputMode="decimal" value={second} onChange={(event) => setSecond(event.target.value)} />
            </Field>
          </div>
        )}
        {plan?.kind === 'write' && plan.cleared.length > 0 && <Banner tone="info">{t('pp.methodDialog.clears', { fields: plan.cleared.map((field) => t(`pp.field.${field}`)).join(', ') })}</Banner>}
        {problem && <p className="fw-pp-problem" role="alert">{say(problem)}</p>}
      </div>
    </Modal>
  )
}

/** Where the item comes from at this site: its own sourcing, bought (with the preferred supplier) or made (at a plant). */
export function SourceDialog({ dialog, row, model, actions, onClose }: { dialog: Extract<ItemsDialog, { kind: 'source' }>; row: ItemRow; model: ItemsModel; actions?: ItemsActions; onClose: () => void }) {
  const t = useT('planning-params')
  const say = useSay()
  const current = row.row
  const [source, setSource] = useState<PlanningSource | null>(dialog.source !== undefined ? dialog.source : (current?.source ?? null))
  const [supplierId, setSupplierId] = useState<string | null>(dialog.supplierId ?? current?.supplier?.id ?? row.defaults.supplier?.id ?? null)
  const [makeSiteId, setMakeSiteId] = useState<string | null>(dialog.makeSiteId ?? current?.makeSite?.id ?? null)
  const asked = useRef(false)
  useEffect(() => {
    if (source === 'BUY' && model.can.suppliers && !asked.current) {
      asked.current = true
      actions?.onSuppliers?.(row)
    }
  }, [source, model.can.suppliers, actions, row])
  const choices = model.suppliers && model.suppliers.itemId === row.item.id ? model.suppliers : null
  const suppliers: Named[] = [...(row.defaults.supplier ? [row.defaults.supplier] : []), ...(choices?.items ?? [])].filter((entry, index, all) => all.findIndex((other) => other.id === entry.id) === index)
  if (current?.supplier && !suppliers.some((entry) => entry.id === current.supplier!.id)) suppliers.push(current.supplier)
  const plants = makeSitesOf(model.sites, model.site.companyId)
  const patch = sourcePatch(source, source === 'BUY' ? supplierId : null, source === 'MAKE' ? makeSiteId : null)
  const plan = planPatch(current, patch)
  const heldReason = plan.kind === 'refused' ? say(plan.words) : plan.kind === 'none' ? t('pp.held.same') : null
  return (
    <Modal
      open
      onClose={onClose}
      title={t('pp.sourceDialog.title', { item: rowName(row) })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('pp.cancel')}</Button>
          <Button
            variant="primary"
            heldReason={heldReason}
            onClick={() => {
              if (plan.kind !== 'write') return
              actions?.onPatch?.(row, 'source', patch as Record<string, unknown>)
              onClose()
            }}
          >
            {t('pp.sourceDialog.apply')}
          </Button>
        </>
      }
    >
      <div className="fw-pp-dialog">
        <SegmentedControl
          ariaLabel={t('pp.field.source')}
          wrap
          value={source ?? 'OWN'}
          options={[
            { value: 'OWN', label: t('pp.source.own', { sourcing: t(`pp.sourcing.${row.defaults.sourcing}`) }) },
            { value: 'BUY', label: t('pp.source.BUY') },
            { value: 'MAKE', label: t('pp.source.MAKE') },
          ]}
          onChange={(value) => setSource(value === 'OWN' ? null : (value as PlanningSource))}
        />
        {source === 'BUY' &&
          (model.can.suppliers ? (
            <Field label={t('pp.field.supplierId')} hint={choices?.status === 'error' ? t('pp.sourceDialog.suppliersFailed') : t('pp.sourceDialog.suppliersHint')}>
              <span className="fw-pp-row">
                <Select value={supplierId ?? ''} onChange={(event) => setSupplierId(event.target.value || null)}>
                  <option value="">{t('pp.sourceDialog.noSupplier')}</option>
                  {suppliers.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {t('pp.siteOption', { code: entry.code, name: entry.name })}
                    </option>
                  ))}
                </Select>
                {choices?.status === 'loading' && <Spinner size={14} />}
              </span>
            </Field>
          ) : (
            <p className="fw-ps-hint">{t('pp.sourceDialog.suppliersHeld')}</p>
          ))}
        {source === 'MAKE' && (
          <Field label={t('pp.field.makeSiteId')} hint={plants.length === 0 ? t('pp.sourceDialog.noPlants') : undefined}>
            <Select value={makeSiteId ?? ''} onChange={(event) => setMakeSiteId(event.target.value || null)}>
              <option value="">{t('pp.sourceDialog.noMakeSite')}</option>
              {plants.map((site) => (
                <option key={site.id} value={site.id}>
                  {t('pp.siteOption', { code: site.code, name: site.name })}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {plan.kind === 'write' && plan.cleared.length > 0 && <Banner tone="info">{t('pp.methodDialog.clears', { fields: plan.cleared.map((field) => t(`pp.field.${field}`)).join(', ') })}</Banner>}
      </div>
    </Modal>
  )
}

/** Edit N: the fields to change → the review (old → new per row; refused rows held with the reason) → Apply. */
function BulkDialog({ dialog, rows, busy, onDraft, actions, onClose, onDone }: { dialog: Extract<ItemsDialog, { kind: 'bulk' }>; rows: readonly ItemRow[]; busy: boolean; onDraft: (dialog: ItemsDialog) => void; actions?: ItemsActions; onClose: () => void; onDone: () => void }) {
  const t = useT('planning-params')
  const say = useSay()
  const draft = dialog.draft
  const typed = bulkPatch(draft)
  const named = Object.keys(draft.fields).length + (draft.method ? 1 : 0)
  const lines = 'patch' in typed ? bulkLines(rows, typed.patch) : []
  const counts = bulkCounts(lines)
  const setField = (field: BulkField, on: boolean, value = '') => {
    const fields = { ...draft.fields }
    if (on) fields[field] = value
    else delete fields[field]
    onDraft({ ...dialog, draft: { ...draft, fields } })
  }
  const valueText = (field: string, value: string | null) => (value === null ? t('pp.bulk.empty') : field === 'method' ? t(`pp.method.${value}`) : value)
  if (dialog.step === 'review') {
    return (
      <Modal
        open
        onClose={onClose}
        title={t('pp.bulk.reviewTitle', { count: rows.length })}
        size="xl"
        footer={
          <>
            <Button onClick={() => onDraft({ ...dialog, step: 'fields' })}>{t('pp.bulk.back')}</Button>
            <span className="grow" />
            <Button
              variant="primary"
              heldReason={busy ? t('pp.held.busy') : counts.write === 0 ? t('pp.bulk.nothing') : null}
              onClick={async () => {
                const ok = await (actions?.onBulk?.(lines) ?? Promise.resolve(true))
                if (ok) {
                  onDone()
                  onClose()
                }
              }}
            >
              {busy ? <Spinner size={12} /> : null} {t('pp.bulk.apply', { count: counts.write })}
            </Button>
          </>
        }
      >
        <div className="fw-pp-dialog">
          <p className="fw-ps-hint">{t('pp.bulk.counts', { write: counts.write, refused: counts.refused, same: counts.same })}</p>
          <table className="fw-pp-review">
            <thead>
              <tr>
                <th scope="col">{t('pp.col.item')}</th>
                <th scope="col">{t('pp.bulk.change')}</th>
                <th scope="col">{t('pp.bulk.result')}</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.row.key}>
                  <th scope="row">{rowName(line.row)}</th>
                  <td>
                    {line.changes.map((change) => (
                      <span key={change.field} className="fw-pp-change">
                        {t(`pp.field.${change.field}`)}: {valueText(change.field, change.before)} → <b>{valueText(change.field, change.after)}</b>
                      </span>
                    ))}
                  </td>
                  <td className={line.plan.kind === 'refused' ? 'fw-pp-problem' : 'fw-pp-sub'}>
                    {line.plan.kind === 'write' ? t('pp.bulk.willSave') : line.plan.kind === 'none' ? t('pp.bulk.same') : say(line.plan.words)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Modal>
    )
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('pp.bulk.title', { count: rows.length })}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>{t('pp.cancel')}</Button>
          <Button variant="primary" heldReason={named === 0 ? t('pp.bulk.pickField') : 'words' in typed ? say(typed.words) : null} onClick={() => onDraft({ ...dialog, step: 'review' })}>
            {t('pp.bulk.review')}
          </Button>
        </>
      }
    >
      <div className="fw-pp-dialog">
        <p className="fw-ps-hint">{t('pp.bulk.hint')}</p>
        <div className="fw-pp-bulk">
          {BULK_FIELDS.map((field) => {
            const on = field in draft.fields
            const error = on && 'field' in typed && typed.field === field ? say(typed.words) : undefined
            return (
              <div key={field} className="fw-pp-bulk-row">
                <Checkbox checked={on} onChange={(event) => setField(field, event.target.checked)} label={t(`pp.field.${field}`)} />
                {on && (
                  <Field label={t('pp.bulk.newValue')} hint={t(DAY_FIELDS.includes(field as never) ? 'pp.bulk.daysHint' : 'pp.bulk.qtyHint')} error={error}>
                    <Input size="sm" inputMode="decimal" value={draft.fields[field] ?? ''} onChange={(event) => setField(field, true, event.target.value)} />
                  </Field>
                )}
              </div>
            )
          })}
          <div className="fw-pp-bulk-row">
            <Field label={t('pp.field.method')} hint={t('pp.bulk.methodHint')}>
              <Select size="sm" value={draft.method ?? ''} onChange={(event) => onDraft({ ...dialog, draft: { ...draft, method: (event.target.value || null) as BulkDraft['method'] } })}>
                <option value="">{t('pp.bulk.keepMethod')}</option>
                <option value="ORDERS">{t('pp.method.ORDERS')}</option>
                <option value="MANUAL">{t('pp.method.MANUAL')}</option>
              </Select>
            </Field>
          </div>
        </div>
      </div>
    </Modal>
  )
}

/** "Plan N by defaults": the site's parameters of those rows are removed (the items plan by their own defaults again). */
function DefaultsDialog({ rows, busy, actions, onClose, onDone }: { rows: readonly ItemRow[]; busy: boolean; actions?: ItemsActions; onClose: () => void; onDone: () => void }) {
  const t = useT('planning-params')
  return (
    <Modal
      open
      onClose={onClose}
      title={t('pp.defaults.title', { count: rows.length })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('pp.cancel')}</Button>
          <Button
            variant="danger"
            heldReason={busy ? t('pp.held.busy') : null}
            onClick={async () => {
              const ok = await (actions?.onDefaults?.(rows) ?? Promise.resolve(true))
              if (ok) {
                onDone()
                onClose()
              }
            }}
          >
            <XCircle size={14} aria-hidden /> {t('pp.defaults.apply', { count: rows.length })}
          </Button>
        </>
      }
    >
      <div className="fw-pp-dialog">
        <p>{t('pp.defaults.body')}</p>
        <ul className="fw-pp-names">
          {rows.map((row) => (
            <li key={row.key}>{rowName(row)}</li>
          ))}
        </ul>
      </div>
    </Modal>
  )
}

