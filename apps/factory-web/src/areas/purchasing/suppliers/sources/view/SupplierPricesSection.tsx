'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { Banner, Card, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayAt, quantity, unitPrice } from '../../../../_shared/buying/model'
import { leadTimeSay, materialSources, PREFERENCE_TONE, type SupplierPricesModel } from '../model'
import '../sources.css'

export type { SupplierPricesModel } from '../model'

/**
 * Material › Suppliers & prices › Supplier prices (SCR-048; design products.materials "material.sup.list", SCM-005): the
 * approved sources Purchasing keeps for this material, read only — supplier (Open the supplier → its Items & prices tab),
 * their code, the price and the last purchase price with the cost grain only (the columns are not drawn without it), MOQ,
 * pack size, lead time, primary / backup. A small read-only table inside a record: the DS SummaryTable (Owner rule
 * 2026-10-29: no selection here). A failed read says so with Try again; the rest of the record stays usable. Fetches
 * nothing: the material record's container reads it.
 */
export function SupplierPricesSection({ model, onRetry }: { model: SupplierPricesModel; onRetry?: () => void }) {
  return (
    <WithMessages namespaces={['purchasing-sources']}>
      <Section model={model} onRetry={onRetry} />
    </WithMessages>
  )
}

function Section({ model, onRetry }: { model: SupplierPricesModel; onRetry?: () => void }) {
  const t = useT('purchasing-sources')
  const locale = useLocale()
  const header = t('prices.title')
  if (!model.can.view)
    return (
      <Card header={header}>
        <p className="fw-src-hint">{t('prices.noAccess')}</p>
      </Card>
    )
  if (model.read.status === 'error')
    return (
      <Card header={header}>
        <Banner
          tone="danger"
          title={t('prices.failed')}
          action={
            <Button size="sm" onClick={() => onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t(model.read.problem)}
        </Banner>
      </Card>
    )
  if (model.read.status === 'loading')
    return (
      <Card header={header}>
        <div className="fw-src" role="status" aria-label={t('common.loading')}>
          <Skeleton height={18} />
          <Skeleton height={18} />
          <Skeleton height={18} />
        </div>
      </Card>
    )
  const rows = materialSources(model.read.rows)
  const supplierHref = (partyId: string) => `${model.prefix}/purchasing/suppliers/${encodeURIComponent(partyId)}?tab=items`
  if (rows.length === 0)
    return (
      <Card header={header} description={t('prices.intro')}>
        <p className="fw-src-hint">
          {model.defaultSupplier ? (
            <>
              {t('prices.onlyDefault', { supplier: model.defaultSupplier.name })}{' '}
              <Link className="fw-src-link" href={supplierHref(model.defaultSupplier.id)}>
                {t('prices.openSupplier')}
              </Link>
            </>
          ) : (
            t('prices.none')
          )}
        </p>
      </Card>
    )
  const columns: { header: string; align: 'left' | 'right'; cell: (row: (typeof rows)[number]) => ReactNode }[] = [
    {
      header: t('col.supplier'),
      align: 'left',
      cell: (row) => (
        <span className="fw-src-cell">
          <Link className="fw-src-link" href={supplierHref(row.partyId)}>
            {row.supplier.name}
          </Link>
          <span className="fw-src-sub">{row.company ? row.company.code : t('everyCompany')}</span>
        </span>
      ),
    },
    { header: t('col.colour'), align: 'left', cell: (row) => (row.colour ? `${row.colour.code} · ${row.colour.name}` : t('everyColour')) },
    { header: t('col.article'), align: 'left', cell: (row) => row.supplierArticleCode ?? '—' },
    // Money by grain: without the cost grain the price column is not drawn (the API sends no price either).
    ...(model.can.cost ? [{ header: t('col.price'), align: 'right' as const, cell: (row: (typeof rows)[number]) => (row.unitPrice ? `${unitPrice(row.unitPrice, row.currency, locale)} / ${t(`uom.${row.purchaseUom}`)}` : t('price.none')) }] : []),
    { header: t('col.moq'), align: 'right', cell: (row) => (row.minOrderQty ? `${quantity(row.minOrderQty, locale, 4)} ${t(`uom.${row.purchaseUom}`)}` : '—') },
    { header: t('col.pack'), align: 'right', cell: (row) => (row.orderMultiple ? `${quantity(row.orderMultiple, locale, 4)} ${t(`uom.${row.purchaseUom}`)}` : '—') },
    {
      header: t('col.lead'),
      align: 'right',
      cell: (row) => {
        const lead = leadTimeSay(row)
        return t(lead.key, lead.params)
      },
    },
    {
      header: t('col.last'),
      align: 'left',
      cell: (row) =>
        row.lastPurchase ? (
          <span className="fw-src-cell">
            <Link className="fw-src-link" href={`${model.prefix}/purchasing/orders/${encodeURIComponent(row.lastPurchase.purchaseOrderId)}`}>
              {row.lastPurchase.number}
            </Link>
            <span className="fw-src-sub">
              {formatDate(dayAt(row.lastPurchase.orderDate), { locale })}
              {model.can.cost && row.lastPurchase.unitPrice !== undefined ? ` · ${unitPrice(row.lastPurchase.unitPrice, row.lastPurchase.currency, locale)} / ${t(`uom.${row.lastPurchase.uom}`)}` : ''}
            </span>
          </span>
        ) : (
          t('last.none')
        ),
    },
    { header: t('col.preference'), align: 'left', cell: (row) => <Pill tone={PREFERENCE_TONE[row.preference]}>{t(`preference.${row.preference}`)}</Pill> },
  ]
  return (
    <Card header={header} description={t('prices.intro')}>
      <SummaryTable label={header} columns={columns.map((column) => column.header)} align={columns.map((column) => column.align)} stackOnPhone rows={rows.map((row) => ({ id: row.id, cells: columns.map((column) => column.cell(row)) }))} />
      {rows.some((row) => !row.unitUsable) && <p className="fw-src-hint">{t('unit.notUsableNote')}</p>}
    </Card>
  )
}
