'use client'

import Link from 'next/link'
import { Download, PackageCheck } from 'lucide-react'
import { Banner, Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Skeleton, Spinner } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../../../lib/records/record-links'
import { WithMessages } from '../../../../../../../record-panels/i18n'
import { OFFICE_PAGES } from '../../../../../../../shell/nav/office-nav'
import { arrivalKey, downloadHeldKey, type DeliveriesActions, type DeliveriesModel } from '../model'
import '../delivered.css'

export type { DeliveriesActions, DeliveriesModel } from '../model'

const ARRIVAL_TONE = { 'dv.arrival.carrier': 'success', 'dv.arrival.typed': 'success', 'dv.arrival.travelling': 'info', 'dv.arrival.returned': 'warning' } as const

/**
 * The order's "Delivered (from carrier)" card on its Shipments tab (B-W2b-398; LOG-065, LOG-067; design sales.orders record ›
 * `order.ship.list` "Delivered (W2b, from carrier)"): each shipment that left — arrived when, from the carrier's tracking or
 * typed by a person, who signed and when, Download the proof (for a dispute), its open tracking problems — and, once every
 * shipment arrived, the order delivered with the payment steps that run from delivery and their due days.
 */
export function DeliveriesView({ model, actions }: { model: DeliveriesModel; actions?: DeliveriesActions }) {
  return (
    <WithMessages namespaces={['shipping-delivery']}>
      <Body model={model} actions={actions} />
    </WithMessages>
  )
}

function Body({ model, actions }: { model: DeliveriesModel; actions?: DeliveriesActions | undefined }) {
  const t = useT('shipping-delivery')
  const locale = useLocale()
  const read = model.read
  const header = (
    <span className="fw-dv-head">
      <PackageCheck size={16} aria-hidden /> {t('dv.title')}
    </span>
  )
  if (model.state === 'loading' || (model.state === 'ready' && !read)) {
    return (
      <Card header={header} headingLevel={2}>
        <div className="fw-dv" aria-busy="true">
          <Skeleton height={40} />
          <p className="fw-dv-hint" role="status">
            {t('dv.loading')}
          </p>
        </div>
      </Card>
    )
  }
  if (model.state === 'error' || !read) {
    return (
      <Card header={header} headingLevel={2}>
        <Banner tone="danger" title={t('dv.failed')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('rl.retry')}</Button>} />
      </Card>
    )
  }
  const due = read.steps.filter((step) => step.dueDate !== null && step.status === 'OPEN')
  return (
    <Card header={header} headingLevel={2} description={t('dv.what')}>
      <div className="fw-dv">
        {model.problem && <Banner tone="danger" title={t(model.problem)} onDismiss={() => actions?.onDismiss?.()} />}
        {read.order.deliveredAt ? (
          <Banner tone="success" title={t('dv.orderDelivered', { day: formatDate(read.order.deliveredAt, { locale }) })}>
            {due.length > 0 ? t('dv.stepsDue', { steps: due.map((step) => t('dv.step', { seq: step.seq, day: formatDate(step.dueDate!, { locale }) })).join(', ') }) : read.steps.length > 0 ? t('dv.stepsSettled') : t('dv.noSteps')}
          </Banner>
        ) : read.shipments.length > 0 ? (
          <p className="fw-dv-hint">{t('dv.waiting')}</p>
        ) : null}
        {read.shipments.length === 0 ? (
          <EmptyState title={t('dv.empty.title')} description={t('dv.empty.body')} />
        ) : (
          <SummaryTable
            label={t('dv.title')}
            columns={[t('dv.col.shipment'), t('dv.col.arrival'), t('dv.col.when'), t('dv.col.signed'), t('dv.col.proof')]}
            rows={read.shipments.map((row) => {
              const key = arrivalKey(row)
              const held = downloadHeldKey(model, row)
              const href = `${model.prefix}${recordAddress({ type: 'Shipment', id: row.id, label: row.number, companyId: null }, OFFICE_PAGES)}`
              return {
                id: row.id,
                cells: [
                  <span key="n" className="fw-dv-cell">
                    {row.mayOpen ? (
                      <Link className="fw-dv-link" href={href}>
                        {row.number}
                      </Link>
                    ) : (
                      row.number
                    )}
                    {row.openProblems > 0 && <Pill tone="warning">{t('dv.problems', { count: row.openProblems })}</Pill>}
                  </span>,
                  <Pill key="a" tone={ARRIVAL_TONE[key as keyof typeof ARRIVAL_TONE] ?? 'neutral'}>{t(key)}</Pill>,
                  row.deliveredAt ? formatDateTime(row.deliveredAt, { locale }) : '—',
                  row.pod?.signedBy ? (row.pod.signedAt ? t('dv.signedAt', { name: row.pod.signedBy, at: formatDateTime(row.pod.signedAt, { locale }) }) : row.pod.signedBy) : row.status === 'DELIVERED' ? t('dv.noSigner') : '—',
                  row.status === 'DELIVERED' ? (
                    <Button key="d" size="sm" heldReason={held ? t(held) : null} onClick={() => actions?.onDownload?.(row.id)}>
                      {model.downloading === row.id ? <Spinner size={12} /> : <Download size={14} aria-hidden />} {t('dv.download')}
                    </Button>
                  ) : (
                    '—'
                  ),
                ],
              }
            })}
            stackOnPhone
          />
        )}
      </div>
    </Card>
  )
}
