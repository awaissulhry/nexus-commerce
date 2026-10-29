'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Undo2 } from 'lucide-react'
import { Banner, EmptyState, SummaryTable } from '@nexus/ui/components'
import { DetailModal } from '@nexus/ui/patterns'
import { Button, Pill, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { Facts } from '../../_shared/parts'
import type { Read } from '../../_shared/model'
import type { ReleaseDetail } from '../api'
import type { QualityCan } from '../../_shared/model'
import { impactLines, releaseLabel, reverseHeld, secondPersonKeys, whoKey } from '../model'

export type DetailTab = 'release' | 'gate' | 'reversal'

/**
 * A release (design quality.inspections "Release" record, §2.3: reviewed in sequence, so a DetailModal at
 * `/quality/inspections?open=<release id>`): what was released and by whom with the second person's reason, the gate at
 * the moment of release (certificates then, and their status today), and its reversals with the PPE register entries
 * they opened. "Reverse…" is held before the click when the person may not take garments back or nothing of the
 * release can be taken back now (said with the impact). J / K walk the list's releases.
 */
export function ReleaseDetailModal({
  open,
  detail,
  prefix,
  me,
  can,
  nav,
  onClose,
  onReverse,
  onRetry,
  initialTab = 'release',
}: {
  open: boolean
  detail: Read<ReleaseDetail>
  prefix: string
  me: string
  can: QualityCan
  nav?: { ids: readonly string[]; current: string; onGo: (id: string) => void } | null
  onClose: () => void
  onReverse: () => void
  onRetry?: () => void
  /** Design cases: the tab shown first. */
  initialTab?: DetailTab
}) {
  const t = useT('quality')
  const locale = useLocale()
  const [tab, setTab] = useState<DetailTab>(initialTab)
  const value = detail.value
  const release = value?.release ?? null
  const label = release ? releaseLabel(release) : null
  const held = reverseHeld(value, can)
  const by = release ? whoKey(release.releasedBy, me) : null
  const tabs = [
    { id: 'release', label: t('releaseDetail.tab.release') },
    { id: 'gate', label: t('releaseDetail.tab.gate'), count: release?.certificates.length ?? null },
    { id: 'reversal', label: t('releaseDetail.tab.reversal'), count: release?.reversals.length ?? null },
  ]
  return (
    <DetailModal
      open={open}
      onClose={onClose}
      title={label ? t(label.key, label.params) : t('releaseDetail.title')}
      subtitle={release ? t('releaseDetail.subtitle', { count: release.quantity, workOrder: release.number, date: formatDateTime(release.releasedAt, { locale }) }) : undefined}
      meta={
        release ? (
          <span className="fw-q-tags">
            <Pill tone={release.reversed > 0 ? 'warning' : 'success'} dot>
              {release.reversed > 0 ? t('releaseDetail.partReversed', { count: release.reversed }) : t('releaseDetail.released')}
            </Pill>
            {release.onHold > 0 && <Tag tone="warning">{t('releaseDetail.holdTag', { count: release.onHold })}</Tag>}
          </span>
        ) : undefined
      }
      actions={
        release ? (
          <Button size="sm" variant="danger-outline" onClick={onReverse} heldReason={held ? t(held) : null}>
            <Undo2 size={14} aria-hidden /> {t('releaseDetail.reverse')}
          </Button>
        ) : undefined
      }
      tabs={tabs}
      activeTab={tab}
      onTabChange={(id) => setTab(id as DetailTab)}
      tabsLabel={t('releaseDetail.tabsLabel')}
      nav={nav ? { ...nav, noun: t('releaseDetail.noun') } : undefined}
      loading={detail.value === null && !detail.problem}
      error={detail.problem ? t(detail.problem) : undefined}
      onRetry={onRetry}
    >
      {value && release && by && (
        <div className="fw-q-stack">
          {tab === 'release' && (
            <>
              <Facts
                items={[
                  { label: t('releaseDetail.garments'), value: release.quantity },
                  { label: t('releaseDetail.takenBack'), value: release.reversed },
                  { label: t('releaseDetail.onHold'), value: release.onHold },
                  { label: t('releaseDetail.workOrder'), value: <span className="fw-q-code">{release.number}</span> },
                  {
                    label: t('releaseDetail.inspection'),
                    value: (
                      <Link className="fw-q-link" href={`${prefix}/quality/inspections/${encodeURIComponent(release.inspectionId)}`}>
                        {t('releaseDetail.openInspection')}
                      </Link>
                    ),
                  },
                  { label: t('releaseDetail.releasedBy'), value: t(by.key) },
                  { label: t('releaseDetail.method'), value: t(release.releasedBy.kind === 'FLOOR' ? 'releaseDetail.methodPin' : 'releaseDetail.methodCode') },
                  { label: t('releaseDetail.at'), value: formatDateTime(release.releasedAt, { locale }) },
                ]}
              />
              <div className="fw-q-section">
                <div className="fw-q-section-title">
                  <strong>{t('releaseDetail.secondPerson')}</strong>
                </div>
                {release.secondPerson.reasons.length === 0 ? (
                  <p className="fw-q-hint">{t('releaseDetail.alone')}</p>
                ) : (
                  <ul className="fw-q-lines">
                    {secondPersonKeys(release.secondPerson.reasons).map((key) => (
                      <li key={key}>{t(key)}</li>
                    ))}
                  </ul>
                )}
              </div>
              {release.serials.length > 0 && (
                <SummaryTable
                  label={t('releaseDetail.serials')}
                  columns={[t('releaseDetail.serial'), t('releaseDetail.serialStatus'), t('releaseDetail.packed')]}
                  rows={release.serials.map((serial) => ({
                    id: serial.id,
                    cells: [<span key="s" className="fw-q-code">{serial.serial}</span>, t(`serialStatus.${serial.status}`), serial.packed ? t('csv.yes') : t('csv.no')],
                  }))}
                  stackOnPhone
                />
              )}
              <p className="fw-q-hint">
                {t('releaseDetail.signatureWords')} <span className="fw-q-code">{release.signatureSha256}</span>
              </p>
            </>
          )}
          {tab === 'gate' && (
            <>
              <p className="fw-q-hint">{t('releaseDetail.gateIntro')}</p>
              {release.certificates.length === 0 ? (
                <EmptyState title={t('releaseDetail.noCertificate')} description={t('releaseDetail.noCertificateBody')} />
              ) : (
                <SummaryTable
                  label={t('releaseDetail.certificates')}
                  columns={[t('releaseDetail.certificate'), t('releaseDetail.standard'), t('releaseDetail.validTo'), t('releaseDetail.today')]}
                  rows={release.certificates.map((certificate) => ({
                    id: certificate.id,
                    cells: [
                      <span key="n" className="fw-q-code">
                        {certificate.number}
                      </span>,
                      `${certificate.standard}${certificate.ppeClass ? ` · ${certificate.ppeClass}` : ''}`,
                      formatDate(certificate.validTo, { locale }),
                      <Tag key="s" tone={certificate.statusNow === 'VALID' ? 'success' : 'danger'}>
                        {t(`certificateStatus.${certificate.statusNow}`)}
                      </Tag>,
                    ],
                  }))}
                  stackOnPhone
                />
              )}
            </>
          )}
          {tab === 'reversal' && (
            <>
              {release.reversals.length === 0 ? (
                <EmptyState title={t('releaseDetail.notReversed')} description={t('releaseDetail.notReversedBody')} />
              ) : (
                <SummaryTable
                  label={t('releaseDetail.reversals')}
                  columns={[t('releaseDetail.when'), t('releaseDetail.garments'), t('releaseDetail.why'), t('releaseDetail.by'), t('releaseDetail.holdNow')]}
                  rows={release.reversals.map((reversal) => ({
                    id: reversal.id,
                    cells: [
                      formatDateTime(reversal.reversedAt, { locale }),
                      reversal.quantity,
                      <span key="w" className="fw-q-cell">
                        <span>{reversal.reasonCode ? t(`reason.${reversal.reasonCode}`) : t('reason.none')}</span>
                        <span className="fw-q-hint">{reversal.reason}</span>
                        {reversal.serialsTo && <span className="fw-q-hint">{t(`reverse.serialsWent.${reversal.serialsTo}`)}</span>}
                      </span>,
                      reversal.reversedById === me ? t('who.you') : t('who.office'),
                      reversal.onHold ? t('releaseDetail.stillHeld') : t('releaseDetail.heldCleared'),
                    ],
                  }))}
                  stackOnPhone
                />
              )}
              <div className="fw-q-section">
                <div className="fw-q-section-title">
                  <strong>{t('releaseDetail.register')}</strong>
                </div>
                {value.registerEntries.length === 0 ? (
                  <p className="fw-q-hint">{t('releaseDetail.noRegister')}</p>
                ) : (
                  <ul className="fw-q-lines">
                    {value.registerEntries.map((entry) => (
                      <li key={entry.id}>
                        <Link className="fw-q-link" href={`${prefix}/compliance/register/${encodeURIComponent(entry.id)}`}>
                          {entry.reference}
                        </Link>{' '}
                        <span className="fw-q-hint">· {t(`registerStatus.${entry.status}`)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <Banner tone="info" title={t('releaseDetail.nowTitle')}>
                <ul className="fw-q-lines">
                  {impactLines(value.reverseImpact).map((line) => (
                    <li key={line.key}>{t(line.key, line.params)}</li>
                  ))}
                </ul>
              </Banner>
            </>
          )}
        </div>
      )}
    </DetailModal>
  )
}
