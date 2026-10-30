'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Download, Search } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { money, quantity } from '../../../../_shared/buying/model'
import type { WorkshopStockRow } from '../../api'
import type { SubcontractingActions, SubcontractingModel } from '../list-model'

const QUALITY_TONE: Readonly<Record<string, 'neutral' | 'success' | 'warning' | 'danger'>> = { RELEASED: 'success', QUARANTINE: 'warning', BLOCKED: 'danger', REJECTED: 'danger' }

/** A stock line's key: the workshop's place, the material, its colour, lot and hide (one ledger balance). */
export const stockKey = (row: WorkshopStockRow): string => [row.location.id, row.item.id, row.colour?.id ?? '-', row.lot?.id ?? '-', row.hide?.id ?? '-'].join('|')

/** The rows the stock view shows: the workshop filter and the search (workshop, material, colour, lot, hide) on what was read. */
export function stockRowsOf(rows: readonly WorkshopStockRow[], workshop: string | null, q: string): WorkshopStockRow[] {
  const needle = q.trim().toLowerCase()
  return rows.filter((row) => {
    if (workshop && row.workshop.id !== workshop) return false
    if (!needle) return true
    return [row.workshop.code, row.workshop.name, row.location.code, row.item.code, row.item.name, row.colour?.code, row.lot?.code, row.hide?.code].some((text) => text?.toLowerCase().includes(needle))
  })
}

/**
 * SCR-129 — Stock at subcontractors (design purchasing.subcontracting sec:stock): each workshop is a stock location, our
 * material there by lot (and hide), still in our books while the workshop holds it. Per workshop its lines and value (the
 * cost grain only), then the list frame: workshop, material, lot (a link to the lot), quantity in the material's unit,
 * value (cost grain only: not drawn without it), last sent. Days out are W2b's ageing (said, not drawn). A workshop
 * filter and a search over what was read; Export N (CSV) while lines are selected.
 */
export function StockSection({ model, actions, onHelp }: { model: SubcontractingModel; actions?: SubcontractingActions; onHelp: () => void }) {
  const t = useT('subcontracting')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const stock = model.stock.value
  const [query, setQuery] = useState(model.stockQ)
  useEffect(() => setQuery(model.stockQ), [model.stockQ])
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onStockSearch?.(query), 250)
    return () => clearTimeout(timer)
  }, [query])
  const rows = useMemo(() => (stock ? stockRowsOf(stock.rows, model.stockWorkshop, model.stockQ) : null), [stock, model.stockWorkshop, model.stockQ])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  const rowsKey = rows?.map(stockKey).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => rowsKey.includes(id))), [rowsKey])

  const columns = useMemo<ColDef<WorkshopStockRow>[]>(() => {
    const WorkshopCell = ({ data }: ICellRendererParams<WorkshopStockRow>) =>
      data ? (
        <span className="fw-by-cell" title={data.workshop.name}>
          <span className="fw-by-ellipsis">{data.workshop.name}</span>
          <span className="fw-by-cell-sub">
            {data.location.code} · {data.site.code}
          </span>
        </span>
      ) : null
    const MaterialCell = ({ data }: ICellRendererParams<WorkshopStockRow>) =>
      data ? (
        <span className="fw-by-cell" title={data.item.name}>
          <span className="fw-by-ellipsis">
            <span className="fw-by-code">{data.item.code}</span> {data.item.name}
          </span>
          <span className="fw-by-cell-sub">{data.colour ? `${data.colour.code} · ${data.colour.name}` : '—'}</span>
        </span>
      ) : null
    const LotCell = ({ data }: ICellRendererParams<WorkshopStockRow>) => {
      if (!data) return null
      if (!data.lot && !data.hide) return <span className="fw-by-hint">—</span>
      return (
        <span className="fw-by-cell">
          {data.lot ? (
            model.can.stock ? (
              <Link className="fw-by-link" href={`${model.prefix}/warehouse/lots/${data.lot.id}`}>
                {data.lot.code}
              </Link>
            ) : (
              <span className="fw-by-code">{data.lot.code}</span>
            )
          ) : null}
          {data.hide ? (
            model.can.stock ? (
              <Link className="fw-by-link fw-by-cell-sub" href={`${model.prefix}/warehouse/hides/${data.hide.id}`}>
                {data.hide.code}
              </Link>
            ) : (
              <span className="fw-by-cell-sub">{data.hide.code}</span>
            )
          ) : data.lot ? (
            <span>
              <Pill tone={QUALITY_TONE[data.lot.qualityStatus] ?? 'neutral'}>{t(`stock.quality.${data.lot.qualityStatus in QUALITY_TONE ? data.lot.qualityStatus : 'QUARANTINE'}`)}</Pill>
            </span>
          ) : null}
        </span>
      )
    }
    const QuantityCell = ({ data }: ICellRendererParams<WorkshopStockRow>) =>
      data ? (
        <span className="fw-by-num">
          {quantity(data.onHand, locale, 4)} {data.item.baseUom}
        </span>
      ) : null
    const ValueCell = ({ data }: ICellRendererParams<WorkshopStockRow>) => (data ? <span className="fw-by-num">{data.value === null || data.value === undefined ? t('stock.noValue') : money(data.value, data.currency, locale)}</span> : null)
    const SentCell = ({ data }: ICellRendererParams<WorkshopStockRow>) => (data ? <span>{data.lastSentAt ? formatDate(data.lastSentAt, place) : '—'}</span> : null)
    return [
      { colId: 'workshop', headerName: t('stock.col.workshop'), minWidth: 190, flex: 1.4, valueGetter: (params) => params.data?.workshop.name ?? '', cellRenderer: WorkshopCell },
      { colId: 'material', headerName: t('stock.col.material'), minWidth: 220, flex: 1.8, valueGetter: (params) => params.data?.item.code ?? '', cellRenderer: MaterialCell },
      { colId: 'lot', headerName: t('stock.col.lot'), minWidth: 150, flex: 1, cellRenderer: LotCell },
      { colId: 'quantity', headerName: t('stock.col.quantity'), minWidth: 120, flex: 0.8, type: 'rightAligned', cellRenderer: QuantityCell },
      ...(model.can.cost ? [{ colId: 'value', headerName: t('stock.col.value'), minWidth: 120, flex: 0.8, type: 'rightAligned', cellRenderer: ValueCell } satisfies ColDef<WorkshopStockRow>] : []),
      { colId: 'lastSent', headerName: t('stock.col.lastSent'), minWidth: 120, flex: 0.8, cellRenderer: SentCell },
    ]
  }, [t, locale, model.prefix, model.can.cost, model.can.stock, model.timeZone])

  const workshops = stock?.workshops ?? []
  const state = model.stock.problem ? (
    <EmptyState title={t('stock.failed')} description={t(model.stock.problem)} action={<Button size="sm" onClick={() => actions?.onRetryStock?.()}>{t('common.retry')}</Button>} />
  ) : stock && stock.rows.length === 0 ? (
    <EmptyState title={t('stock.empty')} description={t('stock.emptyBody')} />
  ) : rows && rows.length === 0 ? (
    <EmptyState
      title={t('stock.noMatch')}
      action={
        <Button
          size="sm"
          onClick={() => {
            setQuery('')
            actions?.onStockSearch?.('')
            actions?.onStockWorkshop?.(null)
          }}
        >
          {t('common.clearFilters')}
        </Button>
      }
    />
  ) : undefined

  return (
    <section className="fw-by-stack" aria-label={t('stock.title')}>
      <div className="fw-by-stack">
        <h2 className="fw-by-h2">{t('stock.title')}</h2>
        <p className="fw-by-hint">{t('stock.intro')}</p>
        {workshops.length > 0 && (
          <ul className="fw-sc-workshops">
            {workshops.map((entry) => (
              <li key={entry.location.id}>
                {model.can.cost
                  ? t('stock.workshopValue', { workshop: entry.workshop.name, lines: t('stock.lines', { count: entry.lines }), value: entry.value === null || entry.value === undefined ? t('stock.noValue') : money(entry.value, stock?.rows.find((row) => row.location.id === entry.location.id)?.currency ?? 'EUR', locale) })
                  : t('stock.workshopLines', { workshop: entry.workshop.name, lines: t('stock.lines', { count: entry.lines }) })}
              </li>
            ))}
          </ul>
        )}
      </div>
      {stock?.truncated && <Banner tone="warning" title={t('stock.truncated')} />}
      <ListFrame<WorkshopStockRow>
        label={t('stock.tableLabel')}
        rows={state ? [] : rows}
        rowId={stockKey}
        columns={columns}
        count={rows ? t('stock.count', { count: rows.length }) : '—'}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={13} aria-hidden />}
            aria-label={t('stock.search')}
            placeholder={t('stock.search')}
            value={query}
            onChange={(event) => {
              typed.current = true
              setQuery(event.target.value)
            }}
          />
        }
        tools={
          workshops.length > 1 ? (
            <Select size="sm" aria-label={t('stock.workshopFilter')} value={model.stockWorkshop ?? ''} onChange={(event) => actions?.onStockWorkshop?.(event.target.value || null)}>
              <option value="">{t('stock.allWorkshops')}</option>
              {[...new Map(workshops.map((entry) => [entry.workshop.id, entry.workshop])).values()].map((workshop) => (
                <option key={workshop.id} value={workshop.id}>
                  {workshop.name}
                </option>
              ))}
            </Select>
          ) : undefined
        }
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" aria-label={t('stock.export', { count: selected.length })} onClick={() => actions?.onExportStock?.([...selected])}>
              <Download size={13} aria-hidden /> <SelectionLabel>{t('stock.export', { count: selected.length })}</SelectionLabel>
            </Button>
          ),
        }}
        listKey="purchasing.subcontracting.2"
        onHelp={onHelp}
        state={state}
        focusRow={model.focusRow}
      />
      {model.slow && !stock && !model.stock.problem && (
        <p className="fw-by-hint" role="status">
          {t('list.loadingSlow')}
        </p>
      )}
      <p className="fw-by-hint">
        {t('stock.ours')} {t('stock.daysOutLater')}
      </p>
    </section>
  )
}
