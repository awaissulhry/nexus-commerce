'use client'

import { Pill } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { Quiet, Section } from '../../../../../lib/record-sections/Kit'
import type { StyleView } from '../../api'
import { REVISION_TONE } from '../../model'
import { useProductWords } from '../product-words'

/**
 * owb-pd4 step 4.2 (design § 5q "Who": sales reads Overview, Sizes, Compliance, Versions & changes; the designer Compliance too) — the
 * two tabs a reader gets without their usual right, in the section kit:
 *   HeldCompliance   the certificates' right (compliance.certificates.view) waits for the Owner's rights batch (base answer 22:50): the
 *                    tab says so, in words, instead of an empty page or an error.
 *   RevisionsOnly    Versions & changes without the BOM's right: the revisions from the product's own read (number, state, date);
 *                    comparing revisions and their changes stay with the BOM's right.
 */
export function HeldCompliance() {
  const { t } = useProductWords()
  return (
    <div className="fw-pt">
      <Section id="compliance-held" title={t('held.compliance.title')} answer={t('held.compliance.answer')} info={<p>{t('held.compliance.info')}</p>}>
        <Quiet>{t('held.compliance.body')}</Quiet>
      </Section>
    </div>
  )
}

export function RevisionsOnly({ style }: { style: StyleView }) {
  const { t, tp } = useProductWords()
  const locale = useLocale()
  const rows = [...style.revisions].sort((a, b) => b.revision - a.revision)
  return (
    <div className="fw-pt">
      <Section id="revisions" title={t('revisions.title')} answer={rows.length ? t('revisions.answer', { count: rows.length }) : t('revisions.none')} info={<p>{t('revisions.info')}</p>}>
        {rows.length > 0 ? (
          <table className="fw-pt-table">
            <thead>
              <tr>
                <th>{t('revisions.col.revision')}</th>
                <th>{t('revisions.col.state')}</th>
                <th>{t('revisions.col.when')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((revision) => (
                <tr key={revision.id}>
                  <td className="fw-pt-first">{t('revisions.rev', { revision: revision.revision })}</td>
                  <td data-label={t('revisions.col.state')}>
                    <Pill tone={REVISION_TONE[revision.status]}>{tp(`revisionStatus.${revision.status}`)}</Pill>
                  </td>
                  <td data-label={t('revisions.col.when')}>{formatDate(revision.releasedAt ?? revision.createdAt, { locale })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <Quiet>{t('revisions.held')}</Quiet>
      </Section>
    </div>
  )
}
