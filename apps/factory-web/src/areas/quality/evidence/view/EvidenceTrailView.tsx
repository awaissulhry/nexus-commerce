'use client'

import Link from 'next/link'
import { Printer } from 'lucide-react'
import { Banner, Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Pill, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { CheckList, dash, Facts, NoAccess, QualityMessages, Section } from '../../_shared/parts'
import type { Evidence } from '../api'
import { chainOf, scansByOperation, verdictOf, type EvidenceModel, type LinkId } from '../model'

/**
 * The evidence trail (design compliance.techfiles#evidence-trail; Owner answer Q2 (a): read only in W1 — the PDF pack and
 * the link for authorities are W2b): opened in a new tab beside the work, shown to an inspector or an auditor. The
 * subject and the verdict ("everything required is present" or the gaps), then the chain of proof in order, each link
 * with its state in a word and its facts: style revision, certificates, DoC and user information, label, materials (Cr VI),
 * production (counted per operation, never per person), final inspection, release and reversals, shipments, PPE register.
 * Costs, prices and wages never appear here. Print prints the page alone.
 */
export function EvidenceTrailView({ model }: { model: EvidenceModel }) {
  return (
    <QualityMessages>
      <Trail model={model} />
    </QualityMessages>
  )
}

function Trail({ model }: { model: EvidenceModel }) {
  const t = useT('quality')
  const locale = useLocale()
  if (!model.can.view) return <NoAccess title={t('evidence.noAccess.title')} body={t('evidence.noAccess.body')} />
  if (!model.kind) return <NoAccess title={t('evidence.badAddress.title')} body={t('evidence.badAddress.body')} />
  const evidence = model.evidence.value
  const subjectWords = model.kind === 'serial' ? t('evidence.subjectSerial', { serial: model.subject }) : t('evidence.subjectBatch', { batch: model.subject })
  return (
    <div className="fw-q fw-q-evidence">
      <DetailHeader
        title={t('evidence.title')}
        meta={<span>{subjectWords}</span>}
        status={model.asOf ? <span className="fw-q-asof">{t('common.updated', { time: formatDateTime(model.asOf, { locale }) })}</span> : undefined}
        actions={
          <span className="fw-q-noprint">
            <Button size="sm" onClick={() => window.print()} disabled={!evidence}>
              <Printer size={14} aria-hidden /> {t('evidence.print')}
            </Button>
          </span>
        }
      />
      <p className="fw-q-hint">{t('evidence.noMoney')}</p>
      {model.evidence.problem ? (
        <Card padded>
          <EmptyState title={model.evidence.problem === 'problem.notFound' ? t('evidence.notFound.title') : t('evidence.failed')} description={model.evidence.problem === 'problem.notFound' ? t('evidence.notFound.body', { subject: model.subject }) : t(model.evidence.problem)} />
        </Card>
      ) : !evidence ? (
        <Card padded aria-busy="true">
          <p className="fw-q-loading" role="status">
            <Spinner size={14} /> {t('evidence.loading')}
          </p>
        </Card>
      ) : (
        <Chain evidence={evidence} prefix={model.prefix} />
      )}
    </div>
  )
}

function Chain({ evidence, prefix }: { evidence: Evidence; prefix: string }) {
  const t = useT('quality')
  const locale = useLocale()
  const chain = chainOf(evidence)
  const verdict = verdictOf(chain)
  const at = (id: LinkId) => chain.findIndex((entry) => entry.id === id) + 1
  const subject = evidence.subject
  const style = evidence.style
  const wanted = new Set(subject.cells.map((cell) => cell.workOrderSizeId))
  const cellName = (id: string) => {
    const cell = subject.cells.find((entry) => entry.workOrderSizeId === id)
    return cell ? `${cell.colourwayCode} ${cell.size}` : '—'
  }
  return (
    <>
      <Banner tone={verdict.gaps === 0 ? 'success' : 'warning'} title={verdict.gaps === 0 ? t('evidence.verdictAll', { present: verdict.present, required: verdict.required }) : t('evidence.verdictGaps', { count: verdict.gaps, present: verdict.present, required: verdict.required })}>
        <span>
          {style ? `${style.code} ${style.name} · ` : ''}
          {t('evidence.workOrder', { number: subject.workOrder.number })}
          {subject.batchNumber ? ` · ${t('evidence.batch', { batch: subject.batchNumber })}` : ''}
          {subject.serial ? ` · ${t('evidence.serial', { serial: subject.serial.serial, status: t(`serialStatus.${subject.serial.status}`) })}` : ''}
          {' · '}
          {subject.cells.map((cell) => `${cell.colourwayCode} ${cell.size} (${cell.pieces})`).join(', ')}
        </span>
      </Banner>
      <Section id="chain" title={t('evidence.chain')} sub={t('evidence.chainSub')}>
        <CheckList label={t('evidence.chain')} checks={chain.map((entry, index) => ({ id: entry.id, state: entry.state, word: entry.word, name: `${index + 1}. ${t(`evidence.name.${entry.id}`)}`, text: t(entry.key, entry.params) }))} />
      </Section>

      <div className="fw-q-two">
        <Section id="style" title={`${at('style')}. ${t('evidence.name.style')}`}>
          {style ? (
            <Facts
              items={[
                { label: t('evidence.style'), value: `${style.code} ${style.name}` },
                { label: t('evidence.ppe'), value: [t(`ppeCategory.${style.ppeCategory}`), style.ppeStandard, style.ppeClass].filter(Boolean).join(' · ') },
                { label: t('evidence.tracking'), value: t(`tracking.${style.tracking}`) },
                { label: t('evidence.revision'), value: evidence.revision ? t('evidence.revisionWords', { revision: evidence.revision.revision, status: t(`revisionStatus.${evidence.revision.status}`) }) : '—' },
                { label: t('evidence.releasedAt'), value: evidence.revision?.releasedAt ? formatDate(evidence.revision.releasedAt, { locale }) : '—' },
              ]}
            />
          ) : (
            <p className="fw-q-hint">{t('evidence.noStyle')}</p>
          )}
        </Section>
        <Section id="certificate" title={`${at('certificate')}. ${t('evidence.name.certificate')}`} sub={t('evidence.certificateToday', { date: formatDate(evidence.certificates.date, { locale }) })}>
          {evidence.certificates.today.length === 0 ? (
            <p className="fw-q-hint">{t('evidence.noCertificateWords')}</p>
          ) : (
            <ul className="fw-q-lines">
              {evidence.certificates.today.map((line) => (
                <li key={line.workOrderSizeId}>
                  <strong>{line.cell}</strong>: <span>{line.words}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section id="documents" title={`${at('documents')}. ${t('evidence.name.documents')}`}>
          {evidence.documents.length === 0 ? (
            <p className="fw-q-hint">{t('evidence.noDocuments')}</p>
          ) : (
            <SummaryTable
              label={t('evidence.name.documents')}
              columns={[t('evidence.docKind'), t('evidence.language'), t('evidence.revision'), t('evidence.docStatus'), t('evidence.fingerprint')]}
              rows={evidence.documents.map((document) => ({
                id: document.id,
                cells: [
                  t(`documentKind.${document.kind}`),
                  document.language.toUpperCase(),
                  document.revision,
                  t(`documentStatus.${document.status}`),
                  <span key="f" className="fw-q-code">
                    {document.file ? `${document.file.sha256.slice(0, 12)}…` : '—'}
                  </span>,
                ],
              }))}
              stackOnPhone
            />
          )}
        </Section>
        <Section id="label" title={`${at('label')}. ${t('evidence.name.label')}`}>
          {evidence.labelTemplate ? (
            <Facts
              items={[
                { label: t('evidence.template'), value: <span className="fw-q-code">{`${evidence.labelTemplate.code} r${evidence.labelTemplate.revision}`}</span> },
                { label: t('evidence.templateStatus'), value: t(`templateStatus.${evidence.labelTemplate.status}`) },
                { label: t('evidence.languages'), value: evidence.labelTemplate.languages.map((language) => language.toUpperCase()).join(', ') || '—' },
                { label: t('evidence.printed'), value: evidence.labelPrints.reduce((sum, print) => sum + print.quantity, 0) },
              ]}
            />
          ) : (
            <p className="fw-q-hint">{t('evidence.noTemplate')}</p>
          )}
        </Section>
      </div>

      <Section id="materials" title={`${at('materials')}. ${t('evidence.name.materials')}`}>
        {evidence.lots.length === 0 ? (
          <p className="fw-q-hint">{t('evidence.noLots')}</p>
        ) : (
          <SummaryTable
            label={t('evidence.name.materials')}
            columns={[t('evidence.lot'), t('evidence.material'), t('evidence.lotStatus'), t('evidence.crVi'), t('evidence.result'), t('evidence.supplierDocs')]}
            rows={evidence.lots.map((lot) => {
              const result = lot.results.find((entry) => !lot.results.some((other) => other.supersedesId === entry.id)) ?? lot.results[0] ?? null
              return {
                id: lot.id,
                cells: [
                  <Link key="l" className="fw-q-link" href={`${prefix}/compliance/tests/${encodeURIComponent(lot.id)}`} target="_blank">
                    {lot.code}
                  </Link>,
                  lot.item ? `${lot.item.code} ${lot.item.name}` : '—',
                  t(`lotStatus.${lot.qualityStatus}`),
                  <Tag key="c" tone={lot.crVi.status === 'PASS' ? 'success' : lot.crVi.status === 'FAIL' ? 'danger' : lot.crVi.status === 'PENDING' ? 'warning' : 'neutral'}>
                    {t(`crVi.${lot.crVi.status}`)}
                  </Tag>,
                  result
                    ? t(result.belowDetectionLimit ? 'evidence.resultBelow' : 'evidence.resultValue', { value: result.valueMgKg ?? '', limit: result.limitMgKg, lab: result.lab, date: formatDate(result.testedOn, { locale }) })
                    : '—',
                  lot.documents.length === 0 ? '—' : lot.documents.map((document) => t(`lotDocumentKind.${document.kind}`)).join(', '),
                ],
              }
            })}
            stackOnPhone
          />
        )}
      </Section>

      <div className="fw-q-two">
        <Section id="production" title={`${at('production')}. ${t('evidence.name.production')}`} sub={t('evidence.productionSub', { cuts: evidence.cutting.filter((cut) => !cut.reversal).length, bundles: evidence.bundles.length })}>
          {evidence.scans.length === 0 ? (
            <p className="fw-q-hint">{t('evidence.noScans')}</p>
          ) : (
            <SummaryTable
              label={t('evidence.name.production')}
              columns={[t('evidence.operation'), t('evidence.good'), t('evidence.scrap'), t('evidence.rework')]}
              rows={scansByOperation(evidence).map((row) => ({ id: row.key, cells: [`${row.seq ?? ''} ${row.name}`.trim(), row.good, row.scrap, row.rework] }))}
              align={[undefined, 'right', 'right', 'right']}
              stackOnPhone
            />
          )}
          <p className="fw-q-hint">{t('evidence.noPeople')}</p>
        </Section>
        <Section id="inspection" title={`${at('inspection')}. ${t('evidence.name.inspection')}`}>
          {evidence.inspections.length === 0 ? (
            <p className="fw-q-hint">{t('evidence.noInspections')}</p>
          ) : (
            <SummaryTable
              label={t('evidence.name.inspection')}
              columns={[t('col.inspection'), t('col.status'), t('evidence.sample'), t('evidence.found'), t('col.decided')]}
              rows={evidence.inspections.map((inspection) => ({
                id: inspection.id,
                cells: [
                  <Link key="i" className="fw-q-link" href={`${prefix}/quality/inspections/${encodeURIComponent(inspection.id)}`} target="_blank">
                    {inspection.label}
                  </Link>,
                  <Pill key="s" tone={inspection.status === 'PASSED' ? 'success' : inspection.status === 'FAILED' ? 'danger' : 'neutral'} dot>
                    {t(inspection.overridden && inspection.status === 'PASSED' ? 'status.PASSED_OVERRIDE' : `status.${inspection.status}`)}
                  </Pill>,
                  t('evidence.sampleOf', { sample: inspection.plan.sampleSize, lot: inspection.plan.lotSize, level: inspection.plan.inspectionLevel }),
                  t('evidence.foundWords', { critical: inspection.counts.critical, major: inspection.counts.major, minor: inspection.counts.minor }),
                  dash(inspection.decidedAt ? formatDateTime(inspection.decidedAt, { locale }) : null),
                ],
              }))}
              stackOnPhone
            />
          )}
        </Section>
      </div>

      <Section id="release" title={`${at('release')}. ${t('evidence.name.release')}`}>
        {evidence.releases.length === 0 ? (
          <p className="fw-q-hint">{t('evidence.noReleases')}</p>
        ) : (
          <SummaryTable
            label={t('evidence.name.release')}
            columns={[t('col.release'), t('decision.cell'), t('decision.garments'), t('col.takenBack'), t('col.secondPerson'), t('decision.at')]}
            rows={evidence.releases
              .filter((release) => wanted.size === 0 || wanted.has(release.workOrderSizeId))
              .map((release) => ({
                id: release.id,
                cells: [
                  <Link key="r" className="fw-q-link" href={`${prefix}/quality/inspections?open=${encodeURIComponent(release.id)}`} target="_blank">
                    {release.releaseNumber ?? release.number}
                  </Link>,
                  cellName(release.workOrderSizeId),
                  release.quantity,
                  release.reversed,
                  release.secondPerson.reasons.length === 0 ? t('list.alone') : release.secondPerson.reasons.map((reason) => t(`secondPersonShort.${reason}`)).join(' · '),
                  formatDateTime(release.releasedAt, { locale }),
                ],
              }))}
            stackOnPhone
          />
        )}
      </Section>

      <div className="fw-q-two">
        <Section id="shipment" title={`${at('shipment')}. ${t('evidence.name.shipment')}`}>
          {evidence.shipments.length === 0 ? (
            <p className="fw-q-hint">{t('evidence.noShipments')}</p>
          ) : (
            <SummaryTable
              label={t('evidence.name.shipment')}
              columns={[t('evidence.shipment'), t('evidence.shipmentStatus'), t('decision.garments'), t('evidence.ddt'), t('evidence.shippedAt')]}
              rows={evidence.shipments.map((shipment) => ({
                id: shipment.id,
                cells: [
                  <span key="n" className="fw-q-code">
                    {shipment.number}
                  </span>,
                  t(`shipmentStatus.${shipment.status}`),
                  shipment.garments,
                  shipment.ddtNumbers.join(', ') || '—',
                  dash(shipment.shippedAt ? formatDate(shipment.shippedAt, { locale }) : null),
                ],
              }))}
              stackOnPhone
            />
          )}
        </Section>
        <Section id="register" title={`${at('register')}. ${t('evidence.name.register')}`}>
          {evidence.registerEntries.length === 0 ? (
            <p className="fw-q-hint">{t('evidence.noRegister')}</p>
          ) : (
            <ul className="fw-q-lines">
              {evidence.registerEntries.map((entry) => (
                <li key={entry.id}>
                  <Link className="fw-q-link" href={`${prefix}/compliance/register/${encodeURIComponent(entry.id)}`} target="_blank">
                    {entry.reference}
                  </Link>{' '}
                  <span className="fw-q-hint">
                    · {t(`registerKind.${entry.kind}`)} · {t(`registerStatus.${entry.status}`)} · {t(`registerRisk.${entry.risk}`)} · {formatDate(entry.reportedAt, { locale })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
      <p className="fw-q-hint">{t('evidence.foot')}</p>
    </>
  )
}
