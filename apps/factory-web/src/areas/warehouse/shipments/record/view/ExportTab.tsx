'use client'

import { Download, FilePlus2, Globe2, MoreHorizontal, ShieldCheck } from 'lucide-react'
import { isEuCountry } from '@nexus/factory-domain/shipping/evidence/evidence'
import { Card, EmptyState, KeyValue, Menu } from '@nexus/ui/components'
import { Button, Pill } from '@nexus/ui/primitives'
import { FileRow } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { EvidenceStatus, Shipment } from '../../api'
import { evidenceHelds, evidenceMissing, evidenceNeed } from '../../daily-model'
import type { ShipmentRecordActions, ShipmentRecordModel } from '../record-model'
import { PartState } from './ShipmentRecordView'

const EVIDENCE_TONE: Record<EvidenceStatus, 'neutral' | 'warning' | 'info' | 'success'> = { NOT_NEEDED: 'neutral', AWAITED: 'warning', PARTIAL: 'info', COMPLETE: 'success' }

/**
 * Export (design sh-export, W2b; its W2a part LOG-090: "intra-EU evidence files"): where the goods go (Italy, another
 * EU state, outside the EU), and for a zero-rated sale to another EU state the transport evidence (art. 41 DL 331/1993;
 * art. 45a Reg. (EU) 282/2011): the papers on file (a signed CMR, the carrier's invoice, its proof of delivery, another
 * paper), what is still missing in words, File a paper, Mark complete after the person's check (two papers from parties
 * independent of each other and of the buyer, one a transport document), Reopen, and "needs it / does not" with a reason.
 * A shipment delivered in Italy says "Not needed" (the tab shows no count).
 */
export function ExportTab({ shipment, model, actions }: { shipment: Shipment; model: ShipmentRecordModel; actions?: ShipmentRecordActions }) {
  const t = useT('shipments')
  const locale = useLocale()
  const country = typeof shipment.shipTo.country === 'string' && shipment.shipTo.country ? shipment.shipTo.country.toUpperCase() : null
  const destination = !country ? 'unknown' : country === 'IT' ? 'italy' : isEuCountry(country) ? 'eu' : 'outside'
  const evidence = model.evidence.value
  return (
    <div className="fw-sh-cards fw-sh-cards--wide">
      <Card padded>
        <div className="fw-sh-card-head">
          <h2 className="fw-sh-h2">
            <ShieldCheck size={16} aria-hidden /> {t('evidence.title')}
          </h2>
          {evidence && <Pill tone={EVIDENCE_TONE[evidence.status]}>{t(`evidence.status.${evidence.status}`)}</Pill>}
        </div>
        {!evidence ? <PartState problem={model.evidence.problem} onRetry={() => actions?.onRetryPart?.('evidence')} label={t('evidence.title')} /> : <EvidenceBody shipment={shipment} model={model} actions={actions} />}
      </Card>
      <Card padded>
        <div className="fw-sh-stack">
          <h2 className="fw-sh-h2">
            <Globe2 size={16} aria-hidden /> {t('export.title')}
          </h2>
          <KeyValue
            labelCase="sentence"
            items={[
              { label: t('export.destination'), value: t(`export.class.${destination}`, { country: country ? regionName(country, locale) : '—' }) },
              { label: t('export.shipTo'), value: [typeof shipment.shipTo.city === 'string' ? shipment.shipTo.city : null, country].filter(Boolean).join(' · ') || '—' },
            ]}
          />
          <p className="fw-sh-hint">{t(`export.what.${destination}`)}</p>
        </div>
      </Card>
    </div>
  )
}

/** A country code in the person's language ("DE" → "Germania" / "Germany"); the code itself when unknown. */
function regionName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

function EvidenceBody({ shipment, model, actions }: { shipment: Shipment; model: ShipmentRecordModel; actions?: ShipmentRecordActions }) {
  const t = useT('shipments')
  const locale = useLocale()
  const evidence = model.evidence.value!
  const need = evidenceNeed(evidence, shipment)
  const missing = evidenceMissing(evidence)
  const helds = evidenceHelds(evidence, shipment, model.can)
  const word = (held: { key: string; params?: Record<string, string | number> } | null) => (held ? t(held.key, held.params) : null)
  const relevant = evidence.status !== 'NOT_NEEDED' || evidence.papers.length > 0
  const more = [
    ...(evidence.status === 'COMPLETE' ? [{ id: 'reopen', label: t('evidence.action.reopen'), disabled: !!helds.reopen, description: word(helds.reopen) ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'evidenceReopen' }) }] : []),
    evidence.status === 'NOT_NEEDED'
      ? { id: 'needed', label: t('evidence.action.needed'), disabled: !!helds.need, description: word(helds.need) ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'evidenceNeed', needed: true }) }
      : { id: 'notNeeded', label: t('evidence.action.notNeeded'), disabled: !!helds.need, description: word(helds.need) ?? undefined, onSelect: () => actions?.onDialog?.({ kind: 'evidenceNeed', needed: false }) },
  ]
  return (
    <div className="fw-sh-stack">
      <p className="fw-sh-hint">{t(need.key, need.params)}</p>
      {relevant && (
        <>
          {evidence.papers.length === 0 ? (
            <EmptyState title={t('evidence.papers.none.title')} description={t('evidence.papers.none.body')} />
          ) : (
            <ul className="fw-sh-papers" aria-label={t('evidence.papers.label')}>
              {evidence.papers.map((paper) => (
                <li key={paper.fileId} className="fw-sh-paper">
                  {/* The DS FileRow has no slot for an action of the page (its own are English "Replace" / "Remove"). */}
                  <FileRow
                    name={paper.originalName}
                    size={paper.sizeBytes}
                    status={`${t(`evidence.kind.${paper.kind}`)} · ${paper.status === 'AVAILABLE' ? t('evidence.papers.filed', { when: formatDateTime(paper.createdAt, { locale }) }) : t('evidence.papers.notAvailable')}`}
                    tone={paper.status === 'AVAILABLE' ? 'neutral' : 'danger'}
                  />
                  {model.can.readFiles && paper.status === 'AVAILABLE' && (
                    <Button size="sm" variant="quiet" onClick={() => actions?.onOpenFile?.(paper.fileId)} aria-label={t('evidence.papers.download', { name: paper.originalName })}>
                      <Download size={14} aria-hidden />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {missing && <p className="fw-sh-hint">{t(missing.key, missing.params)}</p>}
          {evidence.status === 'COMPLETE' && evidence.completedAt && (
            <p className="fw-sh-ready-all">{t('evidence.completeSince', { date: formatDate(evidence.completedAt, { locale }) })}</p>
          )}
          {evidence.note && (
            <KeyValue labelCase="sentence" items={[{ label: t('evidence.note'), value: evidence.note }]} />
          )}
        </>
      )}
      <p className="fw-sh-hint">{t('evidence.law')}</p>
      <div className="fw-sh-card-foot">
        <span className="fw-sh-inline">
          {evidence.status !== 'COMPLETE' && relevant && (
            <Button size="sm" variant="primary" heldReason={word(helds.file)} onClick={() => actions?.onDialog?.({ kind: 'evidenceFile' })}>
              <FilePlus2 size={14} aria-hidden /> {t('evidence.action.file')}
            </Button>
          )}
          {evidence.status !== 'COMPLETE' && evidence.status !== 'NOT_NEEDED' && (
            <Button size="sm" heldReason={word(helds.complete)} onClick={() => actions?.onDialog?.({ kind: 'evidenceComplete' })}>
              {t('evidence.action.complete')}
            </Button>
          )}
        </span>
        {model.can.evidence && <Menu label={<MoreHorizontal size={16} aria-label={t('evidence.more')} />} items={more} align="right" triggerProps={{ 'aria-label': t('evidence.more') }} />}
      </div>
    </div>
  )
}
