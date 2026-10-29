'use client'

import { MapPin, PackageCheck } from 'lucide-react'
import { Card, EmptyState, KeyValue } from '@nexus/ui/components'
import { Pill } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Shipment } from '../../api'
import { hasLeft, TRACKING_TONE } from '../../model'
import type { ShipmentRecordActions, ShipmentRecordModel } from '../record-model'
import { PartState } from './ShipmentRecordView'

/**
 * Tracking & delivery (design sh-track, sh-pod): the carrier's events mapped to one list (label created, in transit, out
 * for delivery, delivered, exception, returned) per parcel with time and place, newest first, and the latest of each
 * parcel; they come by Sendcloud's webhook and the hourly poll, so nothing here needs a refresh ("Last event 10:42").
 * Proof of delivery: when it was delivered (the carrier's signer and image are W2b).
 */
export function TrackingTab({ shipment, model, actions }: { shipment: Shipment; model: ShipmentRecordModel; actions?: ShipmentRecordActions }) {
  const t = useT('shipments')
  const locale = useLocale()
  if (!model.tracking) {
    return (
      <Card padded>
        <EmptyState title={t('tracking.none.title')} description={shipment.transportBy === 'CARRIER' ? t('tracking.none.body') : t(`tracking.none.${shipment.transportBy}`)} />
      </Card>
    )
  }
  if (!model.tracking.value) return <PartState problem={model.tracking.problem} onRetry={() => actions?.onRetryPart?.('tracking')} label={t('tab.tracking')} />
  const tracking = model.tracking.value
  const last = tracking.events[0]?.occurredAt ?? null
  return (
    <div className="fw-sh-cards">
      <Card padded>
        <div className="fw-sh-card-head">
          <h2 className="fw-sh-h2">
            <MapPin size={16} aria-hidden /> {t('tracking.title')}
          </h2>
          <span className="fw-sh-hint">{last ? t('tracking.last', { when: formatDateTime(last, { locale }) }) : t('tracking.noEvent')}</span>
        </div>
        <ul className="fw-sh-files">
          {tracking.parcels.map((parcel) => (
            <li key={parcel.parcelId} className="fw-sh-file">
              <span className="fw-sh-file-name">
                <strong>{t('cartons.name', { seq: parcel.seq, count: tracking.parcels.length })}</strong>
                <span className="fw-sh-cell-sub fw-sh-mono">{parcel.trackingNumber ?? '—'}</span>
              </span>
              {parcel.status ? <Pill tone={TRACKING_TONE[parcel.status] ?? 'neutral'}>{t(`trackingStatus.${parcel.status}`)}</Pill> : <span className="fw-sh-muted">{t('tracking.waiting')}</span>}
            </li>
          ))}
        </ul>
        {tracking.events.length === 0 ? (
          <p className="fw-sh-hint">{hasLeft(shipment.status) ? t('tracking.noEventYet') : t('tracking.notLeft')}</p>
        ) : (
          <ol className="fw-sh-timeline" aria-label={t('tracking.events')}>
            {tracking.events.map((event) => (
              <li key={event.id} className="fw-sh-event" data-tone={TRACKING_TONE[event.status] ?? 'neutral'}>
                <span className="fw-sh-event-dot" aria-hidden />
                <span className="fw-sh-event-text">
                  <strong>
                    {t(`trackingStatus.${event.status}`)}
                    {event.seq !== null ? ` · ${t('tracking.parcel', { seq: event.seq })}` : ''}
                  </strong>
                  <span className="fw-sh-cell-sub">
                    {formatDateTime(event.occurredAt, { locale })}
                    {event.location ? ` · ${event.location}` : ''}
                    {` · ${t(`tracking.source.${event.source}`)}`}
                  </span>
                  {event.description && <span className="fw-sh-hint">{event.description}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>
      <Card padded>
        <h2 className="fw-sh-h2">
          <PackageCheck size={16} aria-hidden /> {t('tracking.pod')}
        </h2>
        <KeyValue
          labelCase="sentence"
          items={[
            { label: t('tracking.shippedAt'), value: shipment.shippedAt ? formatDateTime(shipment.shippedAt, { locale }) : t('tracking.notYet') },
            { label: t('tracking.deliveredAt'), value: shipment.deliveredAt ? formatDateTime(shipment.deliveredAt, { locale }) : t('tracking.notDelivered') },
            ...(shipment.returnedAt ? [{ label: t('tracking.returnedAt'), value: formatDateTime(shipment.returnedAt, { locale }) }] : []),
          ]}
        />
        <p className="fw-sh-hint">{t('tracking.podLater')}</p>
      </Card>
    </div>
  )
}
