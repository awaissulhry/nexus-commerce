'use client'

import Link from 'next/link'
import { Card, ChangeReview, SummaryTable } from '@nexus/ui/components'
import { Pill } from '@nexus/ui/primitives'
import { formatDate, formatDateTime, formatNumber } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { ReadState } from '../../../_shared/parts'
import type { PlanRecord, VersionRecord } from '../../api'
import { recordQuery } from '../../model'
import { SectionHead } from '../../view/parts'
import { useReviewItems } from './dialogs'
import type { PlanRecordModel } from './PlanRecordView'

export interface VersionsActions {
  onRetryVersion?: () => void
}

const TONE = { APPROVED: 'success', DRAFT: 'info', RETIRED: 'neutral' } as const
/** The states a record on a version may be in (Inspection, IncomingInspection, InProcessCheck). */
const RECORD_STATUSES = ['OPEN', 'PASSED', 'FAILED', 'DECIDED', 'CANCELLED']

/**
 * Versions (design rec tab "versions", read-only; QHS-016): every version — its state, who wrote it, who approved it and
 * when, how many checks, how many records ran on it (frozen on each) — and, for the one picked (`?version=`), what changed
 * against the version in force (ChangeReview) and the newest records that ran on it.
 */
export function VersionsTab({ model, record, actions }: { model: PlanRecordModel; record: PlanRecord; actions?: VersionsActions }) {
  const t = useT('quality-plans')
  const locale = useLocale()
  const chosenId = model.address.version ?? record.current.id
  const base = `${model.prefix}/quality/plans/${encodeURIComponent(record.plan.id)}`
  return (
    <section className="fw-qp-tab" aria-labelledby="fw-qp-versions">
      <Card padded>
        <SectionHead id="fw-qp-versions" title={t('versions.title')} sub={t('versions.sub')} />
        <SummaryTable
          label={t('versions.table')}
          density="roomy"
          stackOnPhone
          columns={[t('versions.col.version'), t('versions.col.status'), t('versions.col.author'), t('versions.col.approved'), t('versions.col.checks'), t('versions.col.records'), t('versions.col.compare')]}
          align={['left', 'left', 'left', 'left', 'right', 'right', 'right']}
          rows={record.versions.map((version) => ({
            id: version.id,
            cells: [
              <span key="n" className="fw-q-code">
                {t('versions.number', { number: version.number })}
              </span>,
              <Pill key="s" tone={TONE[version.status]}>
                {t(`status.${version.status}`)}
              </Pill>,
              version.author?.name ?? '—',
              version.approvedBy && version.approvedAt ? t('versions.approvedBy', { name: version.approvedBy.name, when: formatDate(version.approvedAt, { locale }) }) : version.retiredAt ? t('versions.retiredAt', { when: formatDate(version.retiredAt, { locale }) }) : '—',
              formatNumber(version.checks, locale),
              formatNumber(version.usedBy.records, locale),
              version.id === chosenId ? (
                <span key="c" className="fw-qp-muted">
                  {t('versions.shown')}
                </span>
              ) : (
                <Link key="c" className="fw-q-link" href={`${base}${recordQuery({ tab: 'versions', version: version.id, approve: false })}`}>
                  {t('versions.compare')}
                </Link>
              ),
            ],
          }))}
        />
      </Card>
      <VersionDetail model={model} record={record} onRetry={() => actions?.onRetryVersion?.()} />
    </section>
  )
}

function VersionDetail({ model, record, onRetry }: { model: PlanRecordModel; record: PlanRecord; onRetry: () => void }) {
  const t = useT('quality-plans')
  const locale = useLocale()
  const read = model.version
  const value: VersionRecord | null = read?.value ?? null
  const items = useReviewItems(value?.comparison ?? record.comparison, value?.version ?? null, model.profiles?.value?.profiles ?? [])
  if (!read || !value) return <ReadState loading={!read?.problem} problem={read?.problem ?? null} onRetry={onRetry} rows={3} />
  const version = value.version
  const comparison = value.comparison
  return (
    <Card padded>
      <SectionHead
        title={t('versions.detail', { number: version.number, status: t(`status.${version.status}`) })}
        sub={comparison.fromNumber === null ? t('versions.againstNothing') : comparison.fromNumber === version.number ? t('versions.itself') : t('versions.against', { from: comparison.fromNumber })}
      />
      {version.approvedBy && version.approvedAt && (
        <p className="fw-qp-muted">
          {t('versions.signed', { name: version.approvedBy.name, when: formatDateTime(version.approvedAt, { locale }) })}
          {version.approvalSha256 && <span className="fw-q-code" title={version.approvalSha256}> · {version.approvalSha256.slice(0, 12)}…</span>}
        </p>
      )}
      {version.changeNote && <p className="fw-qp-note">{version.changeNote}</p>}
      {comparison.same || comparison.fromNumber === version.number ? <p className="fw-qp-muted">{t('versions.noChanges')}</p> : <ChangeReview label={t('versions.changes')} items={items} selectedIds={[]} onSelectionChange={() => undefined} tick={false} />}
      <h3 className="fw-qp-h3">{t('versions.records', { count: version.usedBy.records })}</h3>
      {value.records.length === 0 ? (
        <p className="fw-qp-muted">{t('versions.noRecords')}</p>
      ) : (
        <SummaryTable
          label={t('versions.recordsTable')}
          stackOnPhone
          columns={[t('versions.col.kind'), t('versions.col.number'), t('versions.col.state'), t('versions.col.when')]}
          rows={value.records.map((entry) => ({
            id: entry.id,
            cells: [
              t(`recordKindOf.${entry.kind}`),
              entry.kind === 'FINAL' ? (
                <Link key="n" className="fw-q-link fw-q-code" href={`${model.prefix}/quality/inspections/${encodeURIComponent(entry.id)}`}>
                  {entry.number ?? '—'}
                </Link>
              ) : (
                <span key="n" className="fw-q-code">
                  {entry.number ?? t('versions.noNumber')}
                </span>
              ),
              RECORD_STATUSES.includes(entry.status) ? t(`recordStatus.${entry.status}`) : '—',
              formatDate(entry.at, { locale }),
            ],
          }))}
        />
      )}
    </Card>
  )
}
