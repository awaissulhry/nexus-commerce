'use client'

import Link from 'next/link'
import { ChevronRight, Link2, Unlink } from 'lucide-react'
import { Card, EmptyState } from '@nexus/ui/components'
import { Button, Pill } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { statusKey } from '../../../../search/model'
import type { CaseRecord } from '../../api'
import { actionHeld, linkNoteOf, linkTypeKey } from '../../model'
import { useWords } from '../../parts'
import type { ServiceRecordActions, ServiceRecordModel } from '../view-model'

/**
 * Linked records (design case.linked "Order, garment serial, dealer, RMA, repair": a RecordChain of every linked record —
 * composed here, the DS has none): first the garment's own chain (the serial, the work order it was made in, the batch,
 * the order and the shipment it left on), then every record the case names — by hand (Link…) or opened from the case (a
 * repair, a return, a remake, a credit) — with its number and status for a reader of it; "a <type> you may not open" when
 * the reader may not. Unlink with the case's version; both held while the case is closed or for a reader.
 */
export function LinkedTab({ model, record, actions }: { model: ServiceRecordModel; record: CaseRecord; actions?: ServiceRecordActions }) {
  const { t, say, day, when } = useWords()
  const search = useT('search')
  const offline = model.live === 'offline'
  const held = say(actionHeld(record, 'link', offline, model.can))
  const serial = record.garment.serial
  const href = (type: string, id: string, label?: string) => `${model.prefix}${recordAddress({ type, id, label, companyId: record.companyId }, OFFICE_PAGES)}`
  const noteWords = (note: string | null, at: string) => {
    const said = linkNoteOf(note)
    const words = said.via ? say(said.via) : said.words
    return words ? t('linked.noteWhen', { note: words, when: when(at) }) : t('linked.when', { when: when(at) })
  }
  const openLink = () => actions?.onDialog?.({ kind: 'link', recordType: 'SalesOrder', q: '', found: { items: null, reading: false, problem: null }, picked: null, note: '', busy: false, notice: null })

  return (
    <div className="fw-svc-stack">
      <Card padded>
        <section className="fw-svc-stack" aria-labelledby="svc-chain">
          <h2 id="svc-chain" className="fw-svc-h2">
            {t('linked.chain')}
          </h2>
          {serial ? (
            <ol className="fw-svc-chain" aria-label={t('linked.chain')}>
              <li>
                <span className="fw-svc-hint">{t('linked.garment')}</span> <span className="fw-svc-code">{serial.serial}</span>
              </li>
              <li>
                <ChevronRight size={14} aria-hidden /> <span className="fw-svc-hint">{t('linked.madeIn')}</span> <span className="fw-svc-code">{serial.workOrderNumber}</span>
                {serial.batchNumber && <span className="fw-svc-hint">{t('linked.batch', { batch: serial.batchNumber })}</span>}
              </li>
              {serial.salesOrderId && (
                <li>
                  <ChevronRight size={14} aria-hidden />
                  <Link className="fw-svc-link" href={href('SalesOrder', serial.salesOrderId)}>
                    {t('linked.order')}
                  </Link>
                </li>
              )}
              {serial.shipment && (
                <li>
                  <ChevronRight size={14} aria-hidden />
                  <Link className="fw-svc-link" href={href('Shipment', serial.shipment.id, serial.shipment.number)}>
                    {t('garment.shippedOn', { number: serial.shipment.number, date: day(serial.shipment.day) })}
                  </Link>
                </li>
              )}
              {record.party && (
                <li>
                  <ChevronRight size={14} aria-hidden />
                  <Link className="fw-svc-link" href={href('Party', record.party.id, record.party.code)}>
                    {`${record.party.code} · ${record.party.legalName}`}
                  </Link>
                </li>
              )}
            </ol>
          ) : (
            <p className="fw-svc-hint">{record.garment.batch ? t('linked.batchOnly', { batch: record.garment.batch.batchNumber, workOrder: record.garment.batch.workOrderNumber }) : t('linked.noGarment')}</p>
          )}
        </section>
      </Card>
      <Card padded>
        <section className="fw-svc-stack" aria-labelledby="svc-links">
          <span className="fw-svc-head">
            <h2 id="svc-links" className="fw-svc-h2">
              {t('linked.title', { count: record.links.length })}
            </h2>
            <Button size="sm" variant="secondary" heldReason={held} onClick={openLink}>
              <Link2 size={14} aria-hidden /> {t('linked.link')}
            </Button>
          </span>
          {record.links.length === 0 ? (
            <EmptyState title={t('linked.empty')} description={t('linked.emptyBody')} />
          ) : (
            <ul className="fw-svc-list">
              {record.links.map((link) => {
                const status = link.record ? statusKey(link.record.status) : null
                return (
                  <li key={link.id}>
                    <span className="fw-svc-cell">
                      <span className="fw-svc-row">
                        <span className="fw-svc-hint">{t(linkTypeKey(link.recordType))}</span>
                        {link.record ? (
                          <Link className="fw-svc-link fw-svc-code" href={href(link.recordType, link.recordId, link.record.label)}>
                            {link.record.label}
                          </Link>
                        ) : (
                          <span>{t('linked.hidden', { type: t(linkTypeKey(link.recordType)) })}</span>
                        )}
                        {status && <Pill tone="neutral">{search(status)}</Pill>}
                      </span>
                      <span className="fw-svc-hint">{noteWords(link.note, link.createdAt)}</span>
                    </span>
                    <Button size="sm" variant="quiet" heldReason={held} aria-label={t('linked.unlinkOne', { what: link.record?.label ?? t(linkTypeKey(link.recordType)) })} onClick={() => actions?.onDialog?.({ kind: 'unlink', linkId: link.id, busy: false, notice: null })}>
                      <Unlink size={14} aria-hidden /> {t('linked.unlink')}
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </Card>
    </div>
  )
}
