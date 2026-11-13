'use client'

import Link from 'next/link'
import { FilePlus2, Repeat } from 'lucide-react'
import { Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { Section } from '../../../../quality/_shared/parts'
import type { ProfileRecord } from '../../api'
import { latestRevisionOf, orderHref, quoteHref, rightHeld, type Phrase } from '../../model'
import { useWords } from '../../parts'
import type { ProfileRecordActions, ProfileRecordModel } from '../view-model'

/**
 * The rider profile's Orders tab (design rider.orders): every made-to-measure quote and order line made to the rider's garment
 * type, with the revision it was made to (a newer revision exists: said) and its state; "Repeat order from the latest profile"
 * (SAL-300: on the newest revision, asking a new measure first when the measures are older than 12 months) and "Use in a new
 * quote", each held with why.
 */
export function OrdersTab({ model, record, actions }: { model: ProfileRecordModel; record: ProfileRecord; actions?: ProfileRecordActions }) {
  const { t, say, day } = useWords()
  const offline = model.live === 'offline'
  const latest = latestRevisionOf(record)
  const held: Phrase | null = !model.can.quotes ? rightHeld('quotes') : offline ? { key: 'held.offline' } : null
  const repeatHeld: Phrase | null = held ?? (record.units.length === 0 ? { key: 'repeat.held.noEarlier' } : null)
  const actionsRow = (
    <>
      <Button size="sm" variant="secondary" heldReason={say(held)} onClick={() => actions?.onOpenQuote?.()}>
        <FilePlus2 size={14} aria-hidden /> {t('band.quote')}
      </Button>
      <Button size="sm" variant="primary" heldReason={say(repeatHeld)} onClick={() => actions?.onOpenRepeat?.()}>
        <Repeat size={14} aria-hidden /> {t('band.repeat')}
      </Button>
    </>
  )
  return (
    <Section id="mtm-orders" title={t('orders.title')} sub={t('orders.sub')} actions={actionsRow}>
      {record.units.length === 0 ? (
        <Card padded>
          <EmptyState title={t('orders.none')} description={t('orders.noneBody')} />
        </Card>
      ) : (
        <SummaryTable
          label={t('orders.title')}
          stackOnPhone
          columns={[t('orders.col.document'), t('orders.col.style'), t('orders.col.baseSize'), t('orders.col.revision'), t('orders.col.status'), t('orders.col.at')]}
          widths={['20%', '24%', '10%', '18%', '14%', undefined]}
          rows={record.units.map((unit) => ({
            id: unit.lineId,
            cells: [
              <span key="d" className="fw-mtm-cell">
                {(unit.kind === 'QUOTE' ? model.can.quotesView : model.can.ordersView) ? (
                  <Link className="fw-mtm-link" href={unit.kind === 'QUOTE' ? quoteHref(model.prefix, unit.documentId) : orderHref(model.prefix, unit.documentId)}>
                    {unit.number}
                  </Link>
                ) : (
                  <span>{unit.number}</span>
                )}
                <span className="fw-mtm-hint">{t(unit.kind === 'QUOTE' ? 'orders.quote' : 'orders.order')}</span>
              </span>,
              `${unit.style.code} · ${unit.colourway.code}`,
              unit.baseSize ?? '—',
              <span key="r" className="fw-mtm-row">
                <span>{t('row.revisionValue', { revision: unit.revision })}</span>
                {unit.revision < latest && <Tag tone="warning">{t('orders.newer', { revision: latest })}</Tag>}
              </span>,
              t(`orders.status.${unit.kind}.${unit.status}`),
              day(unit.at),
            ],
          }))}
        />
      )}
    </Section>
  )
}
