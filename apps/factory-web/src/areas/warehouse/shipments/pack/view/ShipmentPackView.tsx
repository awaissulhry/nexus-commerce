'use client'

import Link from 'next/link'
import { FileX, Printer, ShieldOff } from 'lucide-react'
import { Banner, EmptyState, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Skeleton, Spinner } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Shipment } from '../../api'
import type { PackDocument } from '../../daily-model'
import { addressLines, carrierWords, kilos } from '../../model'
import type { PackActions, PackModel } from '../pack-model'
import { PdfPages } from './PdfPages'
import '../../shipments.css'

/**
 * SCR-067-pack — the driver's pack (design warehouse.shipments tab:sh-tab-pack "All documents (one merged PDF)": "one
 * print job for the driver's pack"), opened in a new tab from the shipment: the driver's sheet (who sends, to whom and
 * where, the carrier, the parcels with their tracking numbers, the DDT and the start of the transport, the documents in
 * the pack, boxes to sign at collection), then every page of each ticked document — the DDT, the packing list, each
 * style's Declaration of Conformity and user information — so the browser prints the whole pack at once. A single merged
 * PDF FILE is not made (it needs a PDF library in the API): the page says what it does instead. One view model, nothing
 * fetched; the print stylesheet hides the Office frame and the screen-only controls.
 */
export function ShipmentPackView({ model, actions }: { model: PackModel; actions?: PackActions }) {
  return (
    <WithMessages namespaces={['shipments']}>
      <Pack model={model} actions={actions} />
    </WithMessages>
  )
}

function Pack({ model, actions }: { model: PackModel; actions?: PackActions }) {
  const t = useT('shipments')
  if (!model.allowed) {
    return (
      <article className="fw-sh-pack">
        <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('record.state.forbidden.title')} description={t('pack.noAccess')} />
      </article>
    )
  }
  const loaded = model.shipment
  if (loaded.status === 'loading') {
    return (
      <article className="fw-sh-pack" aria-busy="true">
        <p className="fw-sh-hint" role="status">
          <Spinner size={14} /> {t('pack.reading')}
        </p>
        <Skeleton height={220} />
      </article>
    )
  }
  if (loaded.status !== 'ready') {
    return (
      <article className="fw-sh-pack">
        <EmptyState
          icon={loaded.status === 'forbidden' ? <ShieldOff size={24} aria-hidden /> : <FileX size={24} aria-hidden />}
          title={t(`record.state.${loaded.status}.title`)}
          description={loaded.status === 'error' ? t(loaded.problem) : t(`record.state.${loaded.status}.body`)}
          action={
            loaded.status === 'error' ? (
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('common.retry')}
              </Button>
            ) : undefined
          }
        />
      </article>
    )
  }
  return <ReadyPack shipment={loaded.value} model={model} actions={actions} />
}

function ReadyPack({ shipment, model, actions }: { shipment: Shipment; model: PackModel; actions?: PackActions }) {
  const t = useT('shipments')
  const locale = useLocale()
  const carrier = carrierWords(shipment)
  const documents = model.documents
  const included = (documents ?? []).filter((entry) => model.included.includes(entry.key))
  const weight = shipment.parcels.every((parcel) => parcel.grossWeightKg !== null) ? kilos(String(shipment.parcels.reduce((sum, parcel) => sum + Number(parcel.grossWeightKg), 0)), locale) : null
  const docName = (entry: PackDocument) => `${t(`docKind.${entry.kind}`)}${entry.label ? ` ${entry.label}` : ''}`
  const printHeld = !documents ? t('pack.held.reading') : included.some((entry) => entry.fileId && model.readFiles && !model.files[entry.key]) ? t('pack.held.files') : null
  return (
    <article className="fw-sh-pack">
      <header className="fw-sh-pack-head fw-sh-pack-screen">
        <span className="fw-sh-inline">
          <Link className="fw-sh-link" href={`${model.prefix}/warehouse/shipments/${shipment.id}?tab=documents`}>
            {t('pack.back', { number: shipment.number })}
          </Link>
        </span>
        <h1 className="fw-sh-pack-title">{t('pack.title', { number: shipment.number })}</h1>
        <p className="fw-sh-hint">{model.readAt ? t('pack.meta', { company: model.company, at: formatDateTime(model.readAt, { locale }) }) : model.company}</p>
        <p className="fw-sh-hint">{t('pack.how')}</p>
        <span className="fw-sh-inline">
          <Button variant="primary" onClick={() => window.print()} heldReason={printHeld}>
            <Printer size={14} aria-hidden /> {t('pack.print', { count: included.length })}
          </Button>
        </span>
        {!model.readFiles && <Banner tone="info" title={t('pack.noFiles')} />}
        {shipment.status === 'CANCELLED' && <Banner tone="danger" title={t('pack.cancelled')} />}
      </header>

      <section className="fw-sh-pack-sheet" aria-label={t('pack.sheet')}>
        <h2 className="fw-sh-pack-title">{t('pack.sheetTitle', { number: shipment.number })}</h2>
        <KeyValue
          labelCase="sentence"
          columns={3}
          items={[
            { label: t('pack.field.sender'), value: model.sender || model.company || '—' },
            { label: t('pack.field.recipient'), value: shipment.party.legalName },
            { label: t('pack.field.destination'), value: addressLines(shipment.shipTo).join(', ') || '—' },
            { label: t('pack.field.carrier'), value: `${t(carrier.key, carrier.params)}${shipment.serviceCode ? ` · ${shipment.serviceCode}` : ''}` },
            { label: t('pack.field.ddt'), value: model.ddt ? t('pack.ddtOf', { number: model.ddt.number, date: formatDate(`${model.ddt.documentDate}T12:00:00Z`, { locale }) }) : shipment.ddtRequired ? t('pack.noDdt') : t('pack.ddtNotNeeded') },
            ...(model.ddt ? [{ label: t('pack.field.start'), value: formatDateTime(model.ddt.startAt, { locale }) }] : []),
            { label: t('pack.field.parcels'), value: `${t('list.parcels', { count: shipment.parcels.length })} · ${weight === null ? t('pack.notWeighed') : t('list.kg', { value: weight })}` },
            { label: t('pack.field.order'), value: `${shipment.salesOrder.number}${shipment.salesOrder.customerRef ? ` · ${t('record.customerRef', { ref: shipment.salesOrder.customerRef })}` : ''}` },
          ]}
        />
        {shipment.parcels.length > 0 && (
          <SummaryTable
            label={t('pack.parcelsLabel')}
            columns={[t('carrier.col.parcel'), t('carrier.col.weight'), t('carrier.col.tracking')]}
            align={['left', 'right', 'left']}
            rows={[...shipment.parcels]
              .sort((a, b) => a.seq - b.seq)
              .map((parcel) => ({
                id: parcel.id,
                cells: [t('cartons.name', { seq: parcel.seq, count: shipment.parcels.length }), parcel.grossWeightKg ? t('list.kg', { value: kilos(parcel.grossWeightKg, locale) ?? '—' }) : '—', parcel.trackingNumber ?? t('carrier.noLabelYet')],
              }))}
            stackOnPhone
          />
        )}
        <h3 className="fw-sh-h3">{t('pack.inThePack')}</h3>
        {!documents ? (
          <p className="fw-sh-hint" role="status">
            <Spinner size={14} /> {t('pack.readingDocuments')}
          </p>
        ) : (
          <ul className="fw-sh-pack-docs">
            {documents.map((entry) => {
              const file = model.files[entry.key]
              const why = entry.missing ? t(entry.missing.key, entry.missing.params) : !model.readFiles ? t('pack.missing.noFiles') : file?.problem ? t(file.problem) : null
              return (
                <li key={entry.key} className={model.included.includes(entry.key) ? 'fw-sh-pack-doc' : 'fw-sh-pack-doc fw-sh-pack-screen'}>
                  <Checkbox className="fw-sh-pack-screen" checked={model.included.includes(entry.key)} onChange={() => actions?.onToggle?.(entry.key)} label={docName(entry)} />
                  <span className="fw-sh-pack-print">{docName(entry)}</span>
                  {why && <span className="fw-sh-cell-sub">{why}</span>}
                </li>
              )
            })}
          </ul>
        )}
        <div className="fw-sh-pack-signs">
          {(['driver', 'collected', 'warehouse'] as const).map((box) => (
            <div key={box} className="fw-sh-pack-sign">
              <span className="fw-sh-hint">{t(`pack.sign.${box}`)}</span>
            </div>
          ))}
        </div>
      </section>

      {included.map((entry) => {
        const file = model.files[entry.key]
        if (!entry.fileId || !model.readFiles || !file?.data) return null
        return (
          <section key={entry.key} className="fw-sh-pack-document" aria-label={docName(entry)}>
            <h2 className="fw-sh-h3 fw-sh-pack-screen">{docName(entry)}</h2>
            <PdfPages data={file.data} title={docName(entry)} loading={t('pack.drawing')} failed={t('pack.drawFailed')} pageLabel={(page, pages) => t('pack.page', { document: docName(entry), page, pages })} />
          </section>
        )
      })}
    </article>
  )
}
