'use client'

import { createContext, useContext, useMemo, useState } from 'react'
import Link from 'next/link'
import { Download, MoreHorizontal, Search } from 'lucide-react'
import { Banner, Card, DetailPopover, EmptyState, Menu, SummaryTable } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Checkbox, Input, Pill, Select, Tag } from '@nexus/ui/primitives'
import { DateField, Modal } from '../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { formatDate, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { VALUATION_CATEGORIES, type Layers, type Valuation, type ValuationCategory, type ValuationRow } from '../api'
import {
  basisPhrase,
  decimalText,
  layerKeyOf,
  lotHref,
  methodPhrase,
  moneyText,
  orderedRows,
  printHref,
  reportNotes,
  rowId,
  unitCostText,
  workOrderHref,
  type CsvWords,
  type ReportsCan,
  type ValuationAddress,
} from '../model'
import { HowValued } from './HowValued'
import '../reports.css'

export type LiveState = 'connecting' | 'live' | 'offline'

export interface HowValuedState {
  /** The row's id (rowId) the panel is open on. */
  readonly key: string
  readonly value: Layers | null
  readonly problem: string | null
}

/** SCR-239 — Stock valuation's view model (the view draws it and fetches nothing). */
export interface ValuationModel {
  readonly prefix: string
  readonly can: ReportsCan
  /** Today in Rome (the date field's latest day). */
  readonly today: string
  readonly address: ValuationAddress
  /** The sites the person's stock is at (from a read of every site). */
  readonly sites: ReadonlyArray<{ readonly id: string; readonly code: string }>
  readonly valuation: { readonly value: Valuation | null; readonly problem: string | null; readonly slow: boolean }
  /** When the shown answer was read (ms; said as "Read at 09:40": the DS AsOf speaks English only). */
  readonly readAt: number | null
  readonly now: number
  readonly live: LiveState
  /** Live changes since the read ("N updates · Show"). */
  readonly updates: number
  readonly howValued: HowValuedState | null
  /** Design cases: the selected rows, the focused row, the keys panel open. */
  readonly selected?: readonly string[]
  readonly focusRow?: number
  readonly keysOpen?: boolean
}

export interface ValuationActions {
  onAsOf?: (day: string | null) => void
  onSite?: (siteId: string | null) => void
  onCategory?: (category: ValuationCategory | null) => void
  onGroup?: (grouped: boolean) => void
  onSearch?: (text: string) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  /** The CSV of these rows (the view, or the rows chosen), with the words of its headings and cells and its file name. */
  onExport?: (rows: readonly ValuationRow[], words: CsvWords, fileName: string) => void
  /** Open (a row) or close (null) "How this lot is valued". */
  onHowValued?: (row: ValuationRow | null) => void
}

/** What the value cells need from the page (AG draws cells in its own tree; a context reaches them). */
interface CellContext {
  readonly howValued: HowValuedState | null
  readonly asOfDay: string | null
  readonly can: ReportsCan
  readonly onHowValued?: (row: ValuationRow | null) => void
}
const ValueCellContext = createContext<CellContext>({ howValued: null, asOfDay: null, can: { view: false, cost: false, lots: false, workOrders: false } })

/**
 * SCR-239 — Finance › Reports › Finance reports (design finance.reports; FIN-039): stock valuation at any date — the
 * band (As at with the date field, as of, live, ⋯ Export this view / Print in a new tab), the scope (site, category,
 * grouped by category, search an item or lot with `/`), how the values are made (the stock ledger's bases; the
 * company's costing method is the accountant's and still to confirm with the accountant while UNDECIDED), the totals by
 * category, and the list: category, item, colour, lot (a link), site, quantity (and area, hides), value with "How this
 * lot is valued" on the value cell, unit cost, and what each value rests on. Values only with the cost grain: without
 * it the value columns are not drawn (never a '—'). Rows can be chosen for an Export N (CSV). Never a person.
 */
export function ValuationView({ model, actions }: { model: ValuationModel; actions?: ValuationActions }) {
  return (
    <WithMessages namespaces={['finance-reports', 'lists']}>
      <Valuation model={model} actions={actions} />
    </WithMessages>
  )
}

function Valuation({ model, actions }: { model: ValuationModel; actions?: ValuationActions }) {
  const t = useT('finance-reports')
  const lists = useT('lists')
  const locale = useLocale()
  const [selectedOwn, setSelected] = useState<string[]>([])
  const [help, setHelp] = useState(false)
  const [typed, setTyped] = useState<string | null>(null)
  const selected = model.selected ? [...model.selected] : selectedOwn
  const valuation = model.valuation.value
  const rows = useMemo(() => (valuation ? orderedRows(valuation.rows, model.address.group) : null), [valuation, model.address.group])
  const asOfDay = model.address.asOf
  const dayText = (day: string) => formatDate(`${day}T12:00:00Z`, { locale })

  const columns = useMemo<ColDef<ValuationRow>[]>(() => {
    const CategoryCell = ({ data }: ICellRendererParams<ValuationRow>) => (data ? <span>{t(`category.${data.category}`)}</span> : null)
    const ItemCell = ({ data }: ICellRendererParams<ValuationRow>) => {
      if (!data) return null
      if (data.workOrder) {
        const number = data.workOrder.number
        return (
          <span className="fw-frv-cell">
            {model.can.workOrders ? (
              <Link className="fw-frv-link" href={workOrderHref(model.prefix, data.workOrder.id)}>
                {t('row.wip', { number })}
              </Link>
            ) : (
              <span>{t('row.wip', { number })}</span>
            )}
            <span className="fw-frv-cell-sub">{data.workOrder.done ? t('row.wipDone') : t('row.wipOpen')}</span>
          </span>
        )
      }
      return (
        <span className="fw-frv-cell">
          <span className="fw-frv-ellipsis">{data.item ? `${data.item.code} · ${data.item.name}` : '—'}</span>
          <span className="fw-frv-cell-sub">{data.colour ? `${data.colour.code} · ${data.colour.name}` : t('row.noColour')}</span>
        </span>
      )
    }
    const LotCell = ({ data }: ICellRendererParams<ValuationRow>) => {
      if (!data) return null
      if (!data.lot) return <span className="fw-frv-muted">{data.workOrder ? '—' : t('row.noLot')}</span>
      return model.can.lots ? (
        <Link className="fw-frv-link" href={lotHref(model.prefix, data.lot.id)} aria-label={t('row.lotLink', { code: data.lot.code })}>
          {data.lot.code}
        </Link>
      ) : (
        <span>{data.lot.code}</span>
      )
    }
    const SiteCell = ({ data }: ICellRendererParams<ValuationRow>) => (data ? <span>{data.site.code}</span> : null)
    const QuantityCell = ({ data }: ICellRendererParams<ValuationRow>) => {
      if (!data) return null
      if (data.quantity === null) return <span className="fw-frv-muted">—</span>
      const area = data.areaM2 && data.uom !== 'M2' ? t('row.area', { area: decimalText(data.areaM2, locale, 2) }) : null
      const hides = data.hides > 0 ? t('row.hides', { count: data.hides }) : null
      return (
        <span className="fw-frv-cell">
          <span className="fw-frv-num">{`${decimalText(data.quantity, locale)} ${data.uom ?? ''}`.trim()}</span>
          {(area || hides) && <span className="fw-frv-cell-sub">{[area, hides].filter(Boolean).join(' · ')}</span>}
        </span>
      )
    }
    const UnitCostCell = ({ data }: ICellRendererParams<ValuationRow>) => (data ? <span className="fw-frv-num">{data.workOrder ? '—' : unitCostText(data.unitCost ?? null, data.currency, locale)}</span> : null)
    const BasisCell = ({ data }: ICellRendererParams<ValuationRow>) => {
      if (!data) return null
      const basis = basisPhrase(data)
      return (
        <span className="fw-frv-cell">
          <span className="fw-frv-inline">
            {data.valued !== 'FULL' && !data.workOrder && <Pill tone={data.valued === 'NONE' ? 'danger' : 'warning'}>{t(`valued.${data.valued}`)}</Pill>}
            <span className="fw-frv-ellipsis">{data.methods.length > 0 ? data.methods.map((method) => t(`basis.method.${method}`)).join(' · ') : t(basis.key, basis.params)}</span>
          </span>
          <span className="fw-frv-cell-sub">{data.dependsOnMethod ? t('row.dependsOnMethod') : t('row.sameUnderMethod')}</span>
        </span>
      )
    }
    return [
      ...(model.address.group ? [{ colId: 'category', headerName: t('col.category'), minWidth: 130, flex: 0.8, cellRenderer: CategoryCell } satisfies ColDef<ValuationRow>] : []),
      { colId: 'item', headerName: t('col.item'), minWidth: 200, flex: 1.6, cellRenderer: ItemCell },
      { colId: 'lot', headerName: t('col.lot'), minWidth: 110, flex: 0.8, cellRenderer: LotCell },
      { colId: 'site', headerName: t('col.site'), minWidth: 80, flex: 0.5, cellRenderer: SiteCell },
      { colId: 'quantity', headerName: t('col.quantity'), minWidth: 130, flex: 0.9, type: 'rightAligned', cellRenderer: QuantityCell },
      ...(model.can.cost
        ? [
            { colId: 'value', headerName: t('col.value'), minWidth: 120, flex: 0.8, type: 'rightAligned', cellRenderer: ValueCell } satisfies ColDef<ValuationRow>,
            { colId: 'unitCost', headerName: t('col.unitCost'), minWidth: 110, flex: 0.7, type: 'rightAligned', cellRenderer: UnitCostCell } satisfies ColDef<ValuationRow>,
          ]
        : []),
      { colId: 'basis', headerName: t('col.basis'), minWidth: 200, flex: 1.4, cellRenderer: BasisCell },
    ]
  }, [t, locale, model.prefix, model.can, model.address.group])

  if (!model.can.view) {
    return (
      <div className="fw-frv">
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
      </div>
    )
  }

  const picked = (rows ?? []).filter((row) => selected.includes(rowId(row)))
  const filtered = model.address.site !== null || model.address.category !== null || model.address.q !== null
  const search = (
    <Input
      size="sm"
      type="search"
      leadingIcon={<Search size={13} aria-hidden />}
      aria-label={t('scope.search')}
      placeholder={t('scope.search')}
      value={typed ?? model.address.q ?? ''}
      onChange={(event) => {
        setTyped(event.target.value)
        actions?.onSearch?.(event.target.value)
      }}
    />
  )
  const clear = (
    <Button
      size="sm"
      onClick={() => {
        setTyped(null)
        actions?.onSite?.(null)
        actions?.onCategory?.(null)
        actions?.onSearch?.('')
      }}
    >
      {t('list.clearFilters')}
    </Button>
  )
  const state = model.valuation.problem ? (
    <EmptyState title={t('list.failed')} description={t(model.valuation.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
  ) : rows && rows.length === 0 ? (
    filtered ? <EmptyState title={t('list.noMatch.title')} description={t('list.noMatch.body')} action={clear} /> : <EmptyState title={t('list.empty.title')} description={t('list.empty.body', { day: dayText(asOfDay ?? model.today) })} />
  ) : undefined
  const ownKeys: ListKey[] = [{ keys: ['/'], does: t('keys.search') }]
  const csvWords: CsvWords = {
    header: (column) => t(`csv.${column}`),
    category: (category) => t(`category.${category}`),
    basis: (row) => {
      const basis = basisPhrase(row)
      return row.methods.length > 0 ? row.methods.map((entry) => t(`basis.method.${entry}`)).join(' · ') : t(basis.key, basis.params)
    },
  }
  const fileName = `${t('csv.file', { day: valuation?.asOfDay ?? asOfDay ?? model.today })}.csv`
  const method = valuation ? methodPhrase(valuation.methods) : null
  const notes = valuation ? reportNotes(valuation, model.can) : []

  return (
    <div className="fw-frv">
      <div className="fw-frv-band" role="group" aria-label={t('band.label')}>
        <span className="fw-frv-inline">
          <span className="fw-frv-muted">{t('band.asAt')}</span>
          <span className="fw-frv-date">
            <DateField value={asOfDay ?? model.today} max={model.today} locale={locale === 'it' ? 'it-IT' : 'en-GB'} ariaLabel={t('band.asAtLabel')} onChange={(value) => value && actions?.onAsOf?.(value === model.today ? null : value)} />
          </span>
          {asOfDay && (
            <Button size="sm" onClick={() => actions?.onAsOf?.(null)}>
              {t('band.today')}
            </Button>
          )}
          {model.readAt !== null ? <span className="fw-frv-muted">{t('band.readAt', { time: formatTime(model.readAt, { locale }) })}</span> : <span className="fw-frv-muted">{t('band.reading')}</span>}
          <Tag tone={model.live === 'live' ? 'success' : model.live === 'offline' ? 'warning' : 'neutral'}>{t(`live.${model.live}`)}</Tag>
        </span>
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('band.more') }}
          items={[
            { id: 'export', label: t('band.export'), onSelect: () => rows && actions?.onExport?.(rows, csvWords, fileName), ...(rows && rows.length > 0 ? {} : { disabled: true, description: t('band.exportHeld') }) },
            { id: 'print', label: t('band.print'), href: printHref(model.prefix, model.address), target: '_blank' },
          ]}
        />
      </div>

      <div className="fw-frv-scope" role="group" aria-label={t('scope.label')}>
        <label className="fw-frv-inline">
          <span className="fw-frv-muted">{t('scope.site')}</span>
          <Select size="sm" value={model.address.site ?? ''} onChange={(event) => actions?.onSite?.(event.target.value || null)}>
            <option value="">{t('scope.allSites')}</option>
            {model.sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.code}
              </option>
            ))}
          </Select>
        </label>
        <label className="fw-frv-inline">
          <span className="fw-frv-muted">{t('scope.category')}</span>
          <Select size="sm" value={model.address.category ?? ''} onChange={(event) => actions?.onCategory?.((event.target.value || null) as ValuationCategory | null)}>
            <option value="">{t('scope.allCategories')}</option>
            {VALUATION_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {t(`category.${category}`)}
              </option>
            ))}
          </Select>
        </label>
        <Checkbox checked={model.address.group} onChange={(event) => actions?.onGroup?.(event.target.checked)} label={t('scope.group')} />
        <span className="fw-frv-muted">{t('scope.privacy')}</span>
      </div>

      <div className="fw-frv-top">
        <Card padded className="fw-frv-card">
          <h2 className="fw-frv-h2">{t('method.title')}</h2>
          {method ? <p className="fw-frv-muted">{t(method.key)}</p> : <p className="fw-frv-muted">{t('band.reading')}</p>}
          <p className="fw-frv-muted">{t('method.ledger')}</p>
          <Banner tone="warning" title={t('method.accountant')} />
          {!model.can.cost && <p className="fw-frv-muted">{t('method.noCost')}</p>}
        </Card>
        <Card padded className="fw-frv-card">
          <div className="fw-frv-card-head">
            <h2 className="fw-frv-h2">{t('totals.title')}</h2>
            <span className="fw-frv-muted">{t('totals.asAt', { day: dayText(valuation?.asOfDay ?? asOfDay ?? model.today) })}</span>
          </div>
          {valuation ? (
            <>
              <SummaryTable
                label={t('totals.title')}
                stackOnPhone
                columns={model.can.cost ? [t('col.category'), t('totals.rows'), t('col.value')] : [t('col.category'), t('totals.rows')]}
                align={model.can.cost ? [undefined, 'right', 'right'] : [undefined, 'right']}
                rows={[
                  ...valuation.categories.map((entry) => ({
                    id: entry.category,
                    cells: model.can.cost ? [t(`category.${entry.category}`), String(entry.rows), moneyText(entry.value ?? null, entry.currency, locale)] : [t(`category.${entry.category}`), String(entry.rows)],
                  })),
                  {
                    id: 'total',
                    cells: model.can.cost
                      ? [<b key="l">{t('totals.total')}</b>, <b key="r">{String(valuation.rows.length)}</b>, <b key="v">{moneyText(valuation.value ?? null, valuation.currency, locale)}</b>]
                      : [<b key="l">{t('totals.total')}</b>, <b key="r">{String(valuation.rows.length)}</b>],
                  },
                ]}
              />
              {notes.length > 0 && (
                <ul className="fw-frv-notes">
                  {notes.map((note) => (
                    <li key={note.key}>{t(note.key, { ...note.params, residue: moneyText(valuation.residue ?? null, valuation.currency, locale) })}</li>
                  ))}
                </ul>
              )}
            </>
          ) : model.valuation.problem ? (
            <p className="fw-frv-muted">{t('totals.failed')}</p>
          ) : (
            <p className="fw-frv-muted" role="status">
              {t('common.loading')}
            </p>
          )}
        </Card>
      </div>

      {model.valuation.slow && !valuation && !model.valuation.problem && (
        <p className="fw-frv-muted" role="status">
          {t('list.slow')}
        </p>
      )}
      <ValueCellContext.Provider value={{ howValued: model.howValued, asOfDay, can: model.can, onHowValued: actions?.onHowValued }}>
        <ListFrame<ValuationRow>
          label={t('list.title')}
          rows={state ? [] : rows}
          rowId={rowId}
          columns={columns}
          count={rows ? t('list.count', { count: rows.length }) : '—'}
          search={search}
          selection={{
            selected,
            onChange: setSelected,
            actions: (
              <Button size="sm" variant="primary" aria-label={t('bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked, csvWords, fileName)}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: picked.length })}</SelectionLabel>
              </Button>
            ),
          }}
          updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
          keys={ownKeys}
          onHelp={() => setHelp(true)}
          state={state}
          focusRow={model.focusRow}
          keysOpen={model.keysOpen}
          title={t('list.fileTitle')}
        />
      </ValueCellContext.Provider>

      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('keys.title')} size="sm">
          <ul className="fw-frv-notes">
            {listKeys(ownKeys, true).map((entry) => (
              <li key={`${entry.keys.join('+')}-${entry.does}`}>
                <b>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  )
}

/** The value; on a stock row (with the cost grain) it opens "How this lot is valued" (design pop:how-valued). */
function ValueCell({ data }: ICellRendererParams<ValuationRow>) {
  const t = useT('finance-reports')
  const locale = useLocale()
  const context = useContext(ValueCellContext)
  if (!data) return null
  const text = moneyText(data.value ?? null, data.currency, locale)
  const key = layerKeyOf(data, context.asOfDay, context.can)
  if (!key) return <span className="fw-frv-num">{text}</span>
  const id = rowId(data)
  const open = context.howValued?.key === id
  const label = data.lot ? t('how.openLot', { code: data.lot.code }) : t('how.openItem', { code: data.item?.code ?? '' })
  return (
    <DetailPopover
      trigger={<span className="fw-frv-value-trigger">{text}</span>}
      triggerLabel={`${text} · ${label}`}
      label={t('how.title')}
      hoverDelay={0}
      panelClassName="nds-detailpop-scroll"
      open={open}
      onOpenChange={(next) => context.onHowValued?.(next ? data : null)}
    >
      {open ? <HowValued row={data} state={context.howValued!} /> : null}
    </DetailPopover>
  )
}
