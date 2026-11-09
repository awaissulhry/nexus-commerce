'use client'

import { Copy, Download, ExternalLink, Eye, PackageCheck } from 'lucide-react'
import { Card, Disclosure, EmptyState, KeyValue, SummaryTable, type KeyValueItem } from '@nexus/ui/components'
import { MilestoneTracker } from '@nexus/ui/components/MilestoneTracker/index'
import { Button, Pill } from '@nexus/ui/primitives'
import { FileRow, useDsWords } from '../../../../lib/i18n/ds-parts'
import type { ShipmentRead, ShipmentsRead } from '../api'
import { eventLine, shipmentSteps, shipmentTone } from '../model'
import { useOrderWords } from '../words'
import { Loading, ReadFailed } from './parts'
import type { OrderRecordActions, OrderRecordViewModel } from './OrderRecordView'

/**
 * Order › Shipments & tracking (design rec "Order" tab shipments: "Shipments", "Still to ship"; SAL-080, SAL-081): each
 * shipment with its DDT, carrier, parcels and tracking numbers (Copy; "Track on the carrier's site" in a new tab when the
 * carrier gave its page), its four steps, the expected delivery, what it carries and its papers (preview and download,
 * logged); then what is still to ship with its expected day. No money on this tab.
 */
export function ShipmentsTab({ model, actions }: { model: OrderRecordViewModel; actions?: OrderRecordActions }) {
  const { t, day } = useOrderWords()
  const shipments = model.shipments
  if (shipments.state === 'loading' || (shipments.state === 'ready' && !shipments.read)) return <Loading rows={2} height={120} />
  if (shipments.state === 'error' || !shipments.read) return <ReadFailed title={t('shipments.failed')} onRetry={actions?.onRetryShipments} />
  const read = shipments.read
  return (
    <div className="fw-pord-tab">
      {read.shipments.length === 0 ? (
        <EmptyState icon={<PackageCheck size={24} aria-hidden />} title={t('shipments.none')} description={read.firstExpected ? t('shipments.firstExpected', { date: day(read.firstExpected) }) : t('shipments.noneYet')} />
      ) : (
        read.shipments.map((shipment) => <ShipmentCard key={shipment.id} shipment={shipment} model={model} actions={actions} />)
      )}
      <StillToShip read={read} />
    </div>
  )
}

function ShipmentCard({ shipment, model, actions }: { shipment: ShipmentRead; model: OrderRecordViewModel; actions?: OrderRecordActions }) {
  const words = useOrderWords()
  const { t, locale, day, at } = words
  const ds = useDsWords()
  const facts: KeyValueItem[] = [
    { label: t('shipments.ddt'), value: shipment.ddt ? t('shipments.ddtOf', { number: shipment.ddt.number, date: day(shipment.ddt.date) }) : '—' },
    { label: t('shipments.carrier'), value: shipment.carrierName ?? t(`shipments.by.${shipment.transportBy === 'SENDER' || shipment.transportBy === 'RECIPIENT' ? shipment.transportBy : 'CARRIER'}`) },
    { label: t('shipments.parcels'), value: String(shipment.parcels.length) },
    shipment.deliveredAt
      ? { label: t('shipments.delivered'), value: at(shipment.deliveredAt) }
      : shipment.expectedDeliveryAt
        ? { label: t('shipments.eta'), value: day(shipment.expectedDeliveryAt) }
        : { label: t('shipments.shipped'), value: shipment.shippedAt ? at(shipment.shippedAt) : '—' },
  ]
  const pieces = shipment.lines.reduce((sum, line) => sum + line.quantity, 0)
  return (
    <Card header={t('shipments.title', { number: shipment.number })} headingLevel={2} headerAction={<Pill tone={shipmentTone(shipment.status)}>{shipment.words[locale]}</Pill>} id={`shipment-${shipment.id}`}>
      <div className="fw-pord-stack">
        <KeyValue columns={3} phoneColumns={2} labelCase="sentence" items={facts} />
        <MilestoneTracker steps={shipmentSteps(shipment, locale, at)} label={t('shipments.steps', { number: shipment.number })} labels={ds.milestoneTracker} />
        {shipment.parcels.length > 0 ? (
          <ul className="fw-pord-parcels" aria-label={t('shipments.parcelsOf', { number: shipment.number })}>
            {shipment.parcels.map((parcel) => (
              <li key={parcel.seq} className="fw-pord-parcel">
                <span className="fw-pord-strong">{t('shipments.parcel', { seq: parcel.seq })}</span>
                {parcel.trackingNumber ? (
                  <span className="fw-pord-tracking">
                    <code>{parcel.trackingNumber}</code>
                    <Button size="sm" variant="quiet" onClick={() => actions?.onCopy?.(parcel.trackingNumber!)} aria-label={t('shipments.copyOf', { number: parcel.trackingNumber })}>
                      <Copy size={13} aria-hidden /> {model.copied === parcel.trackingNumber ? t('shipments.copied') : t('shipments.copy')}
                    </Button>
                  </span>
                ) : (
                  <span className="fw-pord-sub">{t('shipments.noTracking')}</span>
                )}
                {parcel.words ? <span>{parcel.words[locale]}</span> : null}
                {parcel.lastEvent ? <span className="fw-pord-sub">{t('shipments.lastEvent', { what: eventLine(parcel.lastEvent, locale), when: at(parcel.lastEvent.at) })}</span> : null}
                {parcel.trackingLink ? (
                  <Button asChild size="sm" variant="quiet" className="fw-pord-push">
                    <a href={parcel.trackingLink.url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink size={13} aria-hidden /> {t('shipments.track')}
                    </a>
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {shipment.lines.length > 0 ? (
          <Disclosure summary={t('shipments.contents', { count: pieces })}>
            <SummaryTable
              label={t('shipments.contentsOf', { number: shipment.number })}
              columns={[t('shipments.col.line'), t('shipments.col.style'), t('shipments.col.colour'), t('sizes.size'), t('shipments.col.pieces')]}
              rows={shipment.lines.map((line, index) => ({ id: `${line.lineSeq}-${line.size ?? ''}-${index}`, cells: [String(line.lineSeq), line.style ? `${line.style.code} · ${line.style.name}` : '—', line.colourway?.name ?? '—', line.size ?? '—', String(line.quantity)] }))}
              stackOnPhone
            />
          </Disclosure>
        ) : null}
        {shipment.events.length > 0 ? (
          <Disclosure summary={t('shipments.events', { count: shipment.events.length })}>
            <ol className="fw-pord-events">
              {shipment.events.map((event, index) => (
                <li key={index}>
                  <span className="fw-pord-sub">{at(event.at)}</span>
                  <span>{eventLine(event, locale)}</span>
                  {event.description ? <span className="fw-pord-sub">{event.description}</span> : null}
                </li>
              ))}
            </ol>
          </Disclosure>
        ) : null}
        <div className="fw-pord-stack">
          <h3 className="fw-pord-h3">{t('shipments.papers')}</h3>
          {shipment.papers.length === 0 ? (
            <p className="fw-pord-hint">{t('shipments.noPapers')}</p>
          ) : (
            shipment.papers.map((paper) => (
              <FileRow
                key={paper.fileId}
                name={paper.name}
                size={paper.sizeBytes}
                status={t('docs.version', { version: paper.versionNo })}
                actions={
                  <>
                    {paper.contentType === 'application/pdf' ? (
                      <Button size="sm" variant="quiet" heldReason={model.fileHeld} onClick={() => actions?.onPreview?.({ fileId: paper.fileId, title: paper.name })}>
                        <Eye size={13} aria-hidden /> {t('docs.preview')}
                      </Button>
                    ) : null}
                    <Button size="sm" variant="quiet" heldReason={model.fileHeld} onClick={() => actions?.onDownload?.({ fileId: paper.fileId, name: paper.name })}>
                      <Download size={13} aria-hidden /> {t('docs.download')}
                    </Button>
                  </>
                }
              />
            ))
          )}
        </div>
      </div>
    </Card>
  )
}

function StillToShip({ read }: { read: ShipmentsRead }) {
  const { t, day } = useOrderWords()
  return (
    <Card header={t('toShip.title')} headingLevel={2}>
      {read.stillToShip.length === 0 ? (
        <p className="fw-pord-hint">{t('toShip.none')}</p>
      ) : (
        <SummaryTable
          label={t('toShip.title')}
          columns={[t('shipments.col.line'), t('shipments.col.style'), t('shipments.col.colour'), t('sizes.size'), t('toShip.open'), t('toShip.expected')]}
          rows={read.stillToShip.map((row, index) => ({ id: `${row.lineId}-${row.size ?? ''}-${index}`, cells: [String(row.seq), row.style ? `${row.style.code} · ${row.style.name}` : '—', row.colourway?.name ?? '—', row.size ?? '—', String(row.open), row.expected ? day(row.expected) : '—'] }))}
          stackOnPhone
        />
      )}
    </Card>
  )
}
