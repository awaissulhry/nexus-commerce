'use client'

import { useEffect, useState } from 'react'
import { ExternalLink, FileText, Printer } from 'lucide-react'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, Pill } from '@nexus/ui/primitives'
import { DateField } from '../../../../../lib/i18n/ds-parts'
import { Qty } from '../../../../_shared/stock/parts'
import { actionHeld, quantityWords, type TransferView } from '../../model'
import { useWords } from '../../parts'
import type { TransferRecordActions, TransferRecordModel } from '../view-model'

/**
 * Transfer › In transit (design warehouse.transfers/rec:Transfer/transit, tr-transit "Transport"): the DDT between sites
 * (DPR 472/1996) — the design's IssuedDocumentCard, composed here from Card + KeyValue + Pill (the DS has no
 * IssuedDocumentCard yet: named in the step's notes) — draft (issued when it ships) → issued (number, date, frozen), with
 * Print DDT (the stored PDF in a new tab) and, when its PDF was not stored, Print again; then the transport: own van or
 * carrier, tracking and its link, the expected arrival, the in-transit place, and what lies on it now.
 */
export function TransitTab({ transfer, model, actions }: { transfer: TransferView; model: TransferRecordModel; actions?: TransferRecordActions }) {
  const { t, say, day, locale } = useWords()
  const offline = model.live === 'offline'
  const ddt = transfer.ddt
  const trackHeld = say(actionHeld(transfer.actions.track, offline))
  const [tracking, setTracking] = useState({ ref: transfer.trackingRef ?? '', url: transfer.trackingUrl ?? '' })
  useEffect(() => setTracking({ ref: transfer.trackingRef ?? '', url: transfer.trackingUrl ?? '' }), [transfer.trackingRef, transfer.trackingUrl])
  const urlOk = tracking.url.trim() === '' || /^https:\/\/\S+$/.test(tracking.url.trim())
  const changed = tracking.ref.trim() !== (transfer.trackingRef ?? '') || tracking.url.trim() !== (transfer.trackingUrl ?? '')
  const inTransit = transfer.lines.filter((line) => line.inTransit !== '0')
  const time = (at: string | null) => (at ? new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Rome' }).format(new Date(at)) : '—')

  return (
    <div className="fw-trf-two">
      <Card padded>
        <div className="fw-trf-cardhead">
          <h3 className="fw-trf-h3">{t('transit.ddtTitle')}</h3>
          <Pill tone={ddt ? 'success' : 'neutral'} dot>
            {ddt ? t('transit.issued') : t('transit.notIssued')}
          </Pill>
        </div>
        {ddt ? (
          <div className="fw-trf-stack">
            <KeyValue
              columns={2}
              labelCase="sentence"
              items={[
                { label: t('transit.number'), value: <span className="fw-trf-code">{ddt.number}</span> },
                { label: t('transit.date'), value: day(ddt.date) },
                { label: t('transit.reason'), value: ddt.reason === 'OTHER' && ddt.reasonText ? ddt.reasonText : t(`reason.${ddt.reason}`) },
                { label: t('transit.leftAt'), value: time(transfer.shippedAt) },
                { label: t('transit.packages'), value: String(ddt.packages) },
                { label: t('transit.weight'), value: t('transit.kg', { weight: quantityWords(ddt.grossWeightKg, locale) }) },
                { label: t('transit.appearance'), value: ddt.appearance },
                { label: t('transit.by'), value: ddt.transportBy === 'CARRIER' && ddt.carrier ? `${t('transport.CARRIER')} · ${ddt.carrier.name}` : t(`transport.${ddt.transportBy}`) },
              ]}
            />
            <p className="fw-trf-hint">{t('transit.frozen')}</p>
            <div className="fw-trf-actions">
              <Button size="sm" variant="secondary" heldReason={ddt.fileId ? (offline ? t('held.offline') : null) : t('held.pdfMissing')} onClick={() => actions?.onOpenDdt?.()} aria-keyshortcuts="p">
                <FileText size={14} aria-hidden /> {t('transit.print')}
              </Button>
              {!ddt.fileId && (
                <Button size="sm" variant="quiet" heldReason={offline ? t('held.offline') : model.busy ? t('common.working') : null} onClick={() => actions?.onPrintDdtAgain?.()}>
                  <Printer size={14} aria-hidden /> {t('transit.printAgain')}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="fw-trf-stack">
            <p className="fw-trf-text">{transfer.status === 'CANCELLED' ? t('transit.cancelled') : t('transit.draftBody', { reason: t(transfer.interCompany ? 'transit.reasonInter' : 'reason.TRANSFER') })}</p>
            <p className="fw-trf-hint">{t('transit.numberOnShip')}</p>
          </div>
        )}
      </Card>
      <Card padded>
        <div className="fw-trf-cardhead">
          <h3 className="fw-trf-h3">{t('transit.transportTitle')}</h3>
        </div>
        <div className="fw-trf-stack">
          <KeyValue
            columns={2}
            labelCase="sentence"
            items={[
              { label: t('transit.place'), value: `${transfer.transit.code} · ${transfer.transit.name}`, hint: t('transit.placeHint') },
              { label: t('transit.onIt'), value: inTransit.length === 0 ? t('transit.nothing') : t('transit.lines', { count: inTransit.length }) },
              { label: t('transit.shipOn'), value: day(transfer.shipOn) },
              { label: t('transit.expected'), value: transfer.late ? <Pill tone="danger">{t('row.late', { day: day(transfer.expectedOn) })}</Pill> : day(transfer.expectedOn) },
            ]}
          />
          {inTransit.length > 0 && (
            <ul className="fw-trf-lines">
              {inTransit.map((line) => (
                <li key={line.id}>
                  {t('transit.lineOnIt', { seq: line.seq, item: line.item.code })} <Qty value={line.inTransit} uom={line.uom} decimals={4} />
                </li>
              ))}
            </ul>
          )}
          {transfer.actions.track.allowed ? (
            <div className="fw-trf-form-grid">
              <Field label={t('transit.expected')}>
                <DateField value={transfer.expectedOn} clearable onChange={(value) => actions?.onSaveTracking?.({ expectedOn: value })} />
              </Field>
              <Field label={t('transit.trackingRef')}>
                <Input size="sm" value={tracking.ref} maxLength={100} disabled={!!trackHeld} onChange={(event) => setTracking((now) => ({ ...now, ref: event.target.value }))} />
              </Field>
              <Field label={t('transit.trackingUrl')} hint={urlOk ? t('transit.trackingUrlHint') : t('held.trackingUrl')}>
                <Input size="sm" type="url" value={tracking.url} maxLength={500} disabled={!!trackHeld} onChange={(event) => setTracking((now) => ({ ...now, url: event.target.value }))} />
              </Field>
            </div>
          ) : (
            <KeyValue labelCase="sentence" items={[{ label: t('transit.trackingRef'), value: transfer.trackingRef ?? '—' }]} />
          )}
          <div className="fw-trf-actions">
            {transfer.actions.track.allowed && (
              <Button size="sm" variant="secondary" heldReason={!changed ? t('held.nothingChanged') : !urlOk ? t('held.trackingUrl') : trackHeld ?? (model.busy ? t('common.working') : null)} onClick={() => actions?.onSaveTracking?.({ trackingRef: tracking.ref.trim() || null, trackingUrl: tracking.url.trim() || null })}>
                {t('transit.saveTracking')}
              </Button>
            )}
            {transfer.trackingUrl && (
              <Button size="sm" variant="quiet" asChild>
                <a href={transfer.trackingUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink size={14} aria-hidden /> {t('transit.openTracking')}
                </a>
              </Button>
            )}
          </div>
          {transfer.status === 'DRAFT' && <Banner tone="info" title={t('transit.draftTracking')} />}
        </div>
      </Card>
    </div>
  )
}
