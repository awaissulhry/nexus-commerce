'use client'

import { useMemo, type ReactNode } from 'react'
import { EmptyState } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { Countdown } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import type { ProtectorRow } from '../api'
import { area, protectorTone, visibleProtectors, type Words } from '../model'
import type { LeatherActions, LeatherModel } from '../view-model'

/**
 * Certified protectors (design planning.leather sec:protectors; PLN-114): per open order line, the armour its style's BOM names
 * (the certified part number), its EN 1621 certificate in the register with the time left, the released lots at the site
 * (and how many carry a lot certificate), the state. Another protector in stock is held in words: it is not certified for the
 * style, the DoC would be wrong. Read only: no work applies to many rows, so the rows have no tick boxes.
 */
export function ProtectorsSection({ model, actions, words }: { model: LeatherModel; actions?: LeatherActions; words: Words }) {
  const { t, locale } = words
  const answer = model.protectors.status === 'ready' ? model.protectors.value : null
  const rows = useMemo(() => (answer ? visibleProtectors(answer.rows, model.controls) : null), [answer, model.controls])
  const place = { locale, timeZone: model.timeZone }

  const OrderCell = ({ data }: ICellRendererParams<ProtectorRow>) =>
    data ? (
      <span className="fw-lp-cell">
        <span className="fw-lp-ellipsis">
          {data.order.number} · {t('row.line', { seq: data.orderLine.seq })}
        </span>
        <span className="fw-lp-sub">{data.orderLine.dueDate ? t('row.due', { date: formatDate(data.orderLine.dueDate, place) }) : t('row.noDue')}</span>
      </span>
    ) : null
  const StyleCell = ({ data }: ICellRendererParams<ProtectorRow>) =>
    data ? (
      <span className="fw-lp-cell">
        <span className="fw-lp-ellipsis">
          {data.style.code} · {data.colourway?.name ?? '—'}
        </span>
        <span className="fw-lp-sub fw-lp-ellipsis">{data.sizes.map((size) => `${size.size} × ${size.pieces}`).join(' · ')}</span>
      </span>
    ) : null
  const PartCell = ({ data }: ICellRendererParams<ProtectorRow>) =>
    data ? (
      <span className="fw-lp-cell">
        <span className="fw-lp-ellipsis">{data.placement ?? t('protectors.noPlacement')}</span>
        <span className="fw-lp-sub fw-lp-ellipsis">
          {data.item.code} · {data.item.name}
        </span>
      </span>
    ) : null
  const NeedCell = ({ data }: ICellRendererParams<ProtectorRow>) => (data ? <span>{area(data.needed, data.item.baseUom, words)}</span> : null)
  const CertificateCell = ({ data }: ICellRendererParams<ProtectorRow>) =>
    data ? (
      data.certificate ? (
        <span className="fw-lp-cell">
          <span className="fw-lp-ellipsis">
            {data.certificate.number} · {data.certificate.standard}
          </span>
          <span className="fw-lp-sub">
            {t('protectors.validUntil', { date: formatDate(data.certificate.validTo, place) })} · <Countdown to={`${data.certificate.validTo}T23:59:59.000Z`} announce={false} />
          </span>
        </span>
      ) : (
        <span className="fw-lp-danger">{t('protectors.noCertificate')}</span>
      )
    ) : null
  const LotsCell = ({ data }: ICellRendererParams<ProtectorRow>) =>
    data ? (
      <span className="fw-lp-cell">
        <span>{t('protectors.lots', { count: data.lots.count, available: area(data.lots.available, data.item.baseUom, words) })}</span>
        <span className="fw-lp-sub">{t('protectors.lotCertificates', { count: data.lots.withCertificate })}</span>
      </span>
    ) : null
  const StateCell = ({ data }: ICellRendererParams<ProtectorRow>) => (data ? <Pill tone={protectorTone(data)}>{t(`protector.${data.state}`)}</Pill> : null)
  const SubstituteCell = ({ data }: ICellRendererParams<ProtectorRow>) =>
    data ? (
      data.substitutes.length === 0 ? (
        <span className="fw-lp-sub">{t('protectors.noSubstitutes')}</span>
      ) : (
        <span className="fw-lp-inline">
          <Button size="sm" variant="quiet" heldReason={t('protectors.substituteHeld', { style: data.style.code })}>
            {t('protectors.substitute', { count: data.substitutes.length })}
          </Button>
        </span>
      )
    ) : null

  const columns: ColDef<ProtectorRow>[] = [
    { colId: 'order', headerName: t('col.order'), minWidth: 170, flex: 1, cellRenderer: OrderCell },
    { colId: 'style', headerName: t('col.style'), minWidth: 180, flex: 1.1, cellRenderer: StyleCell },
    { colId: 'part', headerName: t('col.protector'), minWidth: 200, flex: 1.2, cellRenderer: PartCell },
    { colId: 'need', headerName: t('col.needed'), minWidth: 110, flex: 0.6, cellRenderer: NeedCell },
    { colId: 'certificate', headerName: t('col.certificate'), minWidth: 230, flex: 1.3, cellRenderer: CertificateCell },
    { colId: 'lots', headerName: t('col.lots'), minWidth: 170, flex: 1, cellRenderer: LotsCell },
    { colId: 'state', headerName: t('col.state'), minWidth: 170, flex: 0.9, cellRenderer: StateCell },
    { colId: 'substitute', headerName: t('col.substitute'), minWidth: 170, flex: 0.9, cellRenderer: SubstituteCell },
  ]

  let state: ReactNode = undefined
  if (model.protectors.status === 'error') {
    state = <EmptyState title={t('protectors.error')} description={t(model.protectors.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.('protectors')}>{t('common.retry')}</Button>} />
  } else if (answer && !answer.run) {
    state = <EmptyState title={t('need.noRun.title')} description={t('need.noRun.body')} />
  } else if (rows && rows.length === 0) {
    state = model.controls.q.trim() !== '' || model.controls.tile === 'protectors' ? <EmptyState title={t('empty.noMatch.title')} description={t('empty.noMatch.body')} /> : <EmptyState title={t('protectors.empty')} />
  }

  return (
    <>
      <div className="fw-lp-section-head">
        <h2 className="fw-lp-h2" id="fw-lp-protectors">
          {t('protectors.title')}
        </h2>
        <p className="fw-lp-hint">{t('protectors.purpose')}</p>
      </div>
      <ListFrame<ProtectorRow>
        label={t('protectors.title')}
        listKey="planning.leather.2"
        rows={state ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        count={rows ? t('protectors.count', { count: rows.length }) : '—'}
        keys={[]}
        onHelp={() => actions?.onKeys?.()}
        state={state}
      />
    </>
  )
}
