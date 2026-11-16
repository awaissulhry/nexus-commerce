'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Download } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import { CLOSE_NS } from '../../../../production/work-orders/close/model'
import type { VarianceRow } from '../api'
import { COSTING_NAMESPACE, decimalText, labourHref, quantityText, signedMoney, unitCostText } from '../../model'
import { amountTone, totalsOf, varianceUnit, type VariancesCsvWords, type VariancesSectionActions, type VariancesSectionModel } from '../model'

/**
 * SCR-462-variances — Finance › Costing › Variances by work order (design finance.costing: the bridge's "biggest reason"
 * across work orders; FIN-030; B-W2b-GB02, B-W2b-424's gap 5): the variance lines of the closes made in the period that
 * still stand, on the shared list frame — the work order (its Labour & cost tab), the category, the material, standard
 * against actual, the amount — with the totals per currency and the categories, multi-select with Export N (CSV), "Waits
 * for the accountant…" while the company's figures are off (a close is then a status: nothing is split). Unit costs and
 * amounts only with the cost grain: without them those columns are not drawn (never '—'). The states: loading with "Still
 * loading…", failed with Try again (never drawn as empty), empty. Per work order, category and material: never per person.
 */
export function VariancesSection({ model, prefix, actions }: { model: VariancesSectionModel; prefix: string; actions?: VariancesSectionActions }) {
  return (
    <WithMessages namespaces={[CLOSE_NS, COSTING_NAMESPACE, 'lists']}>
      <VariancesList model={model} prefix={prefix} actions={actions} />
    </WithMessages>
  )
}

function VariancesList({ model, prefix, actions }: { model: VariancesSectionModel; prefix: string; actions?: VariancesSectionActions }) {
  const t = useT(CLOSE_NS)
  const lists = useT('lists')
  const locale = useLocale()
  const [selectedOwn, setSelected] = useState<string[]>([])
  const [help, setHelp] = useState(false)
  const selected = model.selected ? [...model.selected] : selectedOwn
  const rows = model.rows
  const dayText = (day: string) => formatDate(`${day}T12:00:00Z`, { locale })
  const monthText = (month: string) => new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-15T12:00:00Z`))

  const columns = useMemo<ColDef<VarianceRow>[]>(() => {
    const side = (row: VarianceRow, quantity: string | null, unitCost: string | null | undefined) => {
      const unit = varianceUnit(row)
      const amount = quantity === null ? '—' : unit === 'MIN' ? t('figure.minutes', { minutes: decimalText(quantity, locale, 1) }) : unit === 'PCS' ? t('figure.garments', { count: Math.round(Number(quantity)) }) : quantityText(quantity, unit, locale)
      return (
        <span className="fw-fco-cell">
          <span className="fw-fco-num">{amount}</span>
          {model.cost && unitCost ? <span className="fw-fco-cell-sub">{t('variance.atCost', { cost: unitCostText(unitCost, row.currency, locale) })}</span> : null}
        </span>
      )
    }
    const WorkOrderCell = ({ data }: ICellRendererParams<VarianceRow>) =>
      data ? (
        <span className="fw-fco-cell">
          <Link className="fw-fco-link" href={labourHref(prefix, data.workOrder.id)}>
            {data.workOrder.number}
          </Link>
          <span className="fw-fco-cell-sub">{t('variancesList.closedOn', { day: formatDate(data.closedAt, { locale }) })}</span>
        </span>
      ) : null
    const MaterialCell = ({ data }: ICellRendererParams<VarianceRow>) =>
      data ? (
        data.item ? (
          <span className="fw-fco-cell">
            <span>{data.item.code}</span>
            <span className="fw-fco-cell-sub">{data.item.name}</span>
          </span>
        ) : (
          <span className="fw-fco-muted">{t('variance.noMaterial')}</span>
        )
      ) : null
    const StandardCell = ({ data }: ICellRendererParams<VarianceRow>) => (data ? side(data, data.standardQuantity, data.standardUnitCost) : null)
    const ActualCell = ({ data }: ICellRendererParams<VarianceRow>) => (data ? side(data, data.actualQuantity, data.actualUnitCost) : null)
    const AmountCell = ({ data }: ICellRendererParams<VarianceRow>) =>
      data ? (
        <span className="fw-fco-inline">
          <span className="fw-fco-num">{signedMoney(data.amount ?? null, data.currency, locale)}</span>
          {amountTone(data) !== 'neutral' && <Pill tone={amountTone(data)}>{t(amountTone(data) === 'warning' ? 'variance.over' : 'variance.under')}</Pill>}
        </span>
      ) : null
    return [
      { colId: 'workOrder', headerName: t('variancesList.col.workOrder'), minWidth: 160, flex: 1, cellRenderer: WorkOrderCell },
      { colId: 'category', headerName: t('variance.col.category'), minWidth: 170, flex: 1, valueGetter: (params) => (params.data ? t(`category.${params.data.category}`) : '') },
      { colId: 'material', headerName: t('variance.col.material'), minWidth: 170, flex: 1.1, cellRenderer: MaterialCell },
      { colId: 'standard', headerName: t('variance.col.standard'), minWidth: 140, flex: 0.9, type: 'rightAligned', cellRenderer: StandardCell },
      { colId: 'actual', headerName: t('variance.col.actual'), minWidth: 140, flex: 0.9, type: 'rightAligned', cellRenderer: ActualCell },
      ...(model.cost ? [{ colId: 'amount', headerName: t('variance.col.amount'), minWidth: 170, flex: 1, cellRenderer: AmountCell } satisfies ColDef<VarianceRow>] : []),
    ]
  }, [t, locale, prefix, model.cost])

  const picked = (rows ?? []).filter((row) => selected.includes(row.id))
  const csvWords: VariancesCsvWords = { header: (column) => t(`variancesList.csv.${column}`), category: (row) => t(`category.${row.category}`) }
  const fileName = `${t('variancesList.csv.file', { month: model.period.month })}.csv`
  const ownKeys: ListKey[] = [{ keys: ['Enter'], does: t('variancesList.keys.open') }]
  const totals = model.cost && model.totals && model.totals.length > 0 ? totalsOf(model.totals) : []

  const state = model.problem ? (
    <EmptyState
      title={t('variancesList.failed')}
      description={t(model.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : rows && rows.length === 0 ? (
    <EmptyState title={t('variancesList.empty.title')} description={t('variancesList.empty.body', { month: monthText(model.period.month) })} />
  ) : undefined

  return (
    <section className="fw-fco-section" aria-labelledby="fw-fco-wo-variances">
      <div className="fw-fco-section-head">
        <h2 id="fw-fco-wo-variances" className="fw-fco-h2">
          {t('variancesList.title')}
        </h2>
        <span className="fw-fco-inline">
          <span className="fw-fco-muted">{t('variancesList.hint', { from: dayText(model.period.from), to: dayText(model.period.to) })}</span>
          {totals.map((total) => (
            <span key={total.currency} className="fw-fco-num">
              {t('variancesList.total', { amount: signedMoney(total.amount, total.currency, locale), count: total.lines })}
            </span>
          ))}
        </span>
      </div>
      {totals.length > 0 && (
        <p className="fw-fco-muted">
          {totals
            .flatMap((total) => total.categories.map((entry) => t('variancesList.byCategory', { category: t(`category.${entry.category}`), amount: signedMoney(entry.amount, total.currency, locale) })))
            .join(' · ')}
        </p>
      )}
      {model.waits && (
        <Banner tone="warning" title={t('waits.title')}>
          {t('variancesList.waits')}
        </Banner>
      )}
      {model.slow && !rows && !model.problem && (
        <p className="fw-fco-muted" role="status">
          {t('variancesList.slow')}
        </p>
      )}
      <ListFrame<VarianceRow>
        label={t('variancesList.title')}
        title={t('variancesList.title')}
        listKey="finance.costing.5"
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t('variancesList.count', { count: rows.length }) : '—'}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" variant="primary" aria-label={t('variancesList.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked, csvWords, fileName)}>
              <Download size={13} aria-hidden /> <SelectionLabel>{t('variancesList.export', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        more={model.more ? { label: t('variancesList.more'), onMore: () => actions?.onMore?.() } : null}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        onOpen={(row) => actions?.onOpen?.(row)}
        state={state}
        focusRow={model.focusRow}
        keysOpen={model.keysOpen}
      />
      {!model.cost && <p className="fw-fco-muted">{t('variancesList.noCost')}</p>}
      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('variancesList.keys.title')} size="sm">
          <ul className="fw-fco-notes">
            {listKeys(ownKeys, true).map((entry) => (
              <li key={`${entry.keys.join('+')}-${entry.does}`}>
                <b>{entry.keys.map((key) => (key === 'click' ? lists('keys.click') : key)).join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </section>
  )
}
