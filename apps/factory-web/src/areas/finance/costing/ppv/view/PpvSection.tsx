'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Download } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { WithMessages } from '../../../../../record-panels/i18n'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import { CLOSE_NS } from '../../../../production/work-orders/close/model'
import type { PpvRow } from '../api'
import { COSTING_NAMESPACE, quantityText, signedMoney, unitCostText } from '../../model'
import { differenceTone, documentRef, ppvStateOf, type PpvCsvWords, type PpvSectionActions, type PpvSectionModel } from '../model'

const BUILT = new Set(OFFICE_PAGES)

/**
 * SCR-462 — Finance › Costing › Purchase price variance (design finance.costing sec:ppv: "Purchase price vs standard at
 * receipt or invoice"; columns material, supplier, standard, paid, difference; FIN-031): the period's variances on the shared
 * list frame (the document each comes from opens its record; a reversal and a reversed one say so), the total difference per
 * currency, multi-select with Export N (CSV), "Waits for the accountant…" while the company's figures are off. Unit costs and
 * differences only with the cost grain: without it those columns are not drawn (never '—'). The states: loading with "Still
 * loading…", failed with Try again (never drawn as empty), empty. No person is named.
 */
export function PpvSection({ model, prefix, actions }: { model: PpvSectionModel; prefix: string; actions?: PpvSectionActions }) {
  return (
    <WithMessages namespaces={[CLOSE_NS, COSTING_NAMESPACE, 'lists']}>
      <Ppv model={model} prefix={prefix} actions={actions} />
    </WithMessages>
  )
}

function Ppv({ model, prefix, actions }: { model: PpvSectionModel; prefix: string; actions?: PpvSectionActions }) {
  const t = useT(CLOSE_NS)
  const lists = useT('lists')
  const locale = useLocale()
  const [selectedOwn, setSelected] = useState<string[]>([])
  const [help, setHelp] = useState(false)
  const selected = model.selected ? [...model.selected] : selectedOwn
  const rows = model.rows
  const dayText = (day: string) => formatDate(`${day}T12:00:00Z`, { locale })
  const monthText = (month: string) => new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-15T12:00:00Z`))

  const columns = useMemo<ColDef<PpvRow>[]>(() => {
    const MaterialCell = ({ data }: ICellRendererParams<PpvRow>) =>
      data ? (
        <span className="fw-fco-cell">
          <Link className="fw-fco-link" href={`${prefix}${recordAddress({ type: 'Item', id: data.item.id, label: data.item.code }, BUILT)}`}>
            {data.item.code}
          </Link>
          <span className="fw-fco-cell-sub">{data.item.name}</span>
        </span>
      ) : null
    const DocumentCell = ({ data }: ICellRendererParams<PpvRow>) => {
      if (!data) return null
      const ref = documentRef(data)
      return (
        <span className="fw-fco-cell">
          <Link className="fw-fco-link" href={`${prefix}${recordAddress(ref, BUILT)}`}>
            {t('ppv.line', { number: data.source.number, seq: data.source.seq })}
          </Link>
          <span className="fw-fco-cell-sub">{`${t(`ppv.at.${data.source.at}`)} · ${dayText(data.day)}`}</span>
        </span>
      )
    }
    const QuantityCell = ({ data }: ICellRendererParams<PpvRow>) => (data ? <span className="fw-fco-num">{quantityText(data.quantity, data.item.baseUom, locale)}</span> : null)
    const unit = (pick: (row: PpvRow) => string | undefined) =>
      function UnitCell({ data }: ICellRendererParams<PpvRow>) {
        return data ? <span className="fw-fco-num">{unitCostText(pick(data) ?? null, data.currency, locale)}</span> : null
      }
    const DifferenceCell = ({ data }: ICellRendererParams<PpvRow>) =>
      data ? (
        <span className="fw-fco-inline">
          <span className="fw-fco-num">{signedMoney(data.differenceAmount ?? null, data.currency, locale)}</span>
          {differenceTone(data) !== 'neutral' && <Pill tone={differenceTone(data)}>{t(differenceTone(data) === 'warning' ? 'ppv.above' : 'ppv.below')}</Pill>}
        </span>
      ) : null
    const StateCell = ({ data }: ICellRendererParams<PpvRow>) => {
      if (!data) return null
      const state = ppvStateOf(data)
      if (state === 'reversal') return <Tag tone="neutral">{t('ppv.state.reversal')}</Tag>
      if (state === 'reversed')
        return (
          <span className="fw-fco-cell">
            <Tag tone="warning">{t('ppv.state.reversed', { day: formatDate(data.reversedBy!.postedAt, { locale }) })}</Tag>
            {data.reversedBy!.reason && <span className="fw-fco-cell-sub">{data.reversedBy!.reason}</span>}
          </span>
        )
      return <Tag tone="success">{t('ppv.state.standing')}</Tag>
    }
    return [
      { colId: 'material', headerName: t('ppv.col.material'), minWidth: 190, flex: 1.3, cellRenderer: MaterialCell },
      { colId: 'supplier', headerName: t('ppv.col.supplier'), minWidth: 170, flex: 1.1, valueGetter: (params) => params.data?.supplier.name },
      { colId: 'document', headerName: t('ppv.col.document'), minWidth: 190, flex: 1.1, cellRenderer: DocumentCell },
      { colId: 'quantity', headerName: t('ppv.col.quantity'), minWidth: 120, flex: 0.7, type: 'rightAligned', cellRenderer: QuantityCell },
      ...(model.cost
        ? [
            { colId: 'standard', headerName: t('ppv.col.standard'), minWidth: 120, flex: 0.7, type: 'rightAligned', cellRenderer: unit((row) => row.standardUnitCost) } satisfies ColDef<PpvRow>,
            { colId: 'paid', headerName: t('ppv.col.paid'), minWidth: 120, flex: 0.7, type: 'rightAligned', cellRenderer: unit((row) => row.paidUnitCost) } satisfies ColDef<PpvRow>,
            { colId: 'difference', headerName: t('ppv.col.difference'), minWidth: 190, flex: 1, cellRenderer: DifferenceCell } satisfies ColDef<PpvRow>,
          ]
        : []),
      { colId: 'state', headerName: t('ppv.col.state'), minWidth: 150, flex: 0.8, cellRenderer: StateCell },
    ]
  }, [t, locale, prefix, model.cost])

  const picked = (rows ?? []).filter((row) => selected.includes(row.id))
  const csvWords: PpvCsvWords = {
    header: (column) => t(`ppv.csv.${column}`),
    at: (row) => t(`ppv.at.${row.source.at}`),
    state: (row) => {
      const state = ppvStateOf(row)
      return state === 'reversed' ? t('ppv.state.reversed', { day: row.reversedBy?.postedAt.slice(0, 10) ?? '' }) : t(`ppv.state.${state}`)
    },
  }
  const fileName = `${t('ppv.csv.file', { month: model.period.month })}.csv`
  const ownKeys: ListKey[] = [{ keys: ['Enter'], does: t('ppv.keys.open') }]
  const totals = model.cost && model.totals && model.totals.length > 0 ? model.totals.map((total) => t('ppv.total', { amount: signedMoney(total.differenceAmount ?? null, total.currency, locale), count: total.rows })).join(' · ') : null

  const state = model.problem ? (
    <EmptyState
      title={t('ppv.failed')}
      description={t(model.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : rows && rows.length === 0 ? (
    <EmptyState title={t('ppv.empty.title')} description={t('ppv.empty.body', { month: monthText(model.period.month) })} />
  ) : undefined

  return (
    <section className="fw-fco-section" aria-labelledby="fw-fco-ppv">
      <div className="fw-fco-section-head">
        <h2 id="fw-fco-ppv" className="fw-fco-h2">
          {t('ppv.title')}
        </h2>
        <span className="fw-fco-inline">
          <span className="fw-fco-muted">{t('ppv.hint', { from: dayText(model.period.from), to: dayText(model.period.to) })}</span>
          {totals && <span className="fw-fco-num">{totals}</span>}
        </span>
      </div>
      {model.waits && (
        <Banner tone="warning" title={t('waits.title')}>
          {t('waits.ppv')}
        </Banner>
      )}
      {model.slow && !rows && !model.problem && (
        <p className="fw-fco-muted" role="status">
          {t('ppv.slow')}
        </p>
      )}
      <ListFrame<PpvRow>
        label={t('ppv.title')}
        title={t('ppv.title')}
        listKey="finance.costing.4"
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t('ppv.count', { count: rows.length }) : '—'}
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" variant="primary" aria-label={t('ppv.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked, csvWords, fileName)}>
              <Download size={13} aria-hidden /> <SelectionLabel>{t('ppv.export', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        more={model.more ? { label: t('ppv.more'), onMore: () => actions?.onMore?.() } : null}
        keys={ownKeys}
        onHelp={() => setHelp(true)}
        onOpen={(row) => actions?.onOpen?.(row)}
        state={state}
        focusRow={model.focusRow}
        keysOpen={model.keysOpen}
      />
      {!model.cost && <p className="fw-fco-muted">{t('ppv.noCost')}</p>}
      {help && (
        <Modal open onClose={() => setHelp(false)} title={t('ppv.keys.title')} size="sm">
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
