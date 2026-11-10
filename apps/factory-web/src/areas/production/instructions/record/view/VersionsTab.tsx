'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { Banner, Card, EmptyState, Field, SummaryTable } from '@nexus/ui/components'
import { VersionCompare, type VersionLine } from '@nexus/ui/patterns/VersionCompare/index'
import { Button, Select, Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { INTL_LOCALE, type Locale } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { InstructionRecord } from '../../api'
import { compareLines, NS, recordQuery, valueOf, type CompareSide } from '../../model'
import { VersionPill } from '../../view/parts'
import type { RecordModel } from './InstructionRecordView'

export interface VersionsActions {
  onCompare?: (beforeId: string | null, afterId: string | null) => void
  onRetryCompare?: () => void
}

const FIELDS = ['text', 'safety', 'critical', 'icon', 'tick', 'media'] as const

/**
 * Work instruction › Versions (design rec tab `versions`, sec wi-versions: each version, the routing revision it belongs to,
 * what changed; Compare two versions): every version with its state, change note, who wrote it and who approved it (office
 * users, named), when it went to the floor and when a newer one replaced it, how many saw it (a count), each opening on
 * Steps; then the two compared side by side with the DS VersionCompare (the steps by code: added, removed, changed, each
 * field before → after). Fetches nothing.
 */
export function VersionsTab({ model, record, actions }: { model: RecordModel; record: InstructionRecord; actions?: VersionsActions }) {
  const t = useT(NS)
  const ds = useDsWords()
  const locale = useLocale() as Locale
  const versions = [...record.versions].sort((a, b) => b.number - a.number)
  const base = `${model.prefix}/production/instructions/${encodeURIComponent(record.instruction.id)}`
  const before = valueOf(model.compare.before)
  const after = valueOf(model.compare.after)
  const lines = useMemo<VersionLine[]>(() => {
    if (!before || !after) return []
    const yes = t('common.yes')
    const no = t('common.no')
    const side = (value: CompareSide | null) =>
      value
        ? {
            fields: {
              text: value.text ?? '—',
              safety: value.safety ?? '—',
              critical: value.critical ? yes : no,
              icon: value.icon ? t(`icon.${value.icon}`) : t('icon.none'),
              tick: value.requiredTick ? t('steps.tickRequired') : t('steps.tickOptional'),
              media: String(value.media),
            },
          }
        : null
    return compareLines(before, after, model.language).map((line) => ({ id: line.code, label: line.code, detail: line.after?.text ?? line.before?.text ?? null, before: side(line.before), after: side(line.after) }))
  }, [before, after, model.language, t])
  const usable = versions.filter((version) => version.status !== 'DISCARDED' || version.id === model.compare.beforeId || version.id === model.compare.afterId)
  return (
    <div className="fw-wi-stack">
      <Card padded>
        <div className="fw-wi-stack">
          <h3 className="fw-wi-h3">{t('versions.revision')}</h3>
          <p>{record.instruction.style ? t('versions.forRevision', { code: record.instruction.style.code, name: record.instruction.style.name, revision: record.instruction.style.revision, status: t(`revisionStatus.${record.instruction.style.revisionStatus}`) }) : t('versions.everyStyle')}</p>
          {record.usedIn.length > 0 ? (
            <SummaryTable
              label={t('versions.usedInLabel')}
              columns={[t('versions.col.style'), t('versions.col.revision'), t('versions.col.revisionStatus')]}
              rows={record.usedIn.map((use) => ({
                id: use.revisionId,
                cells: [
                  <Link key="style" className="fw-wi-rowlink" href={`${model.prefix}/products/styles/${encodeURIComponent(use.styleId)}`}>
                    {use.styleCode} · {use.styleName}
                  </Link>,
                  t('versions.revisionN', { revision: use.revision }),
                  t(`revisionStatus.${use.status}`),
                ],
              }))}
              stackOnPhone
            />
          ) : (
            <p className="fw-wi-hint">{t('versions.usedInNone')}</p>
          )}
        </div>
      </Card>
      <SummaryTable
        label={t('versions.tableLabel')}
        density="roomy"
        columns={[t('versions.col.version'), t('versions.col.note'), t('versions.col.people'), t('versions.col.dates'), t('versions.col.content'), t('versions.col.seen'), '']}
        rows={versions.map((version) => ({
          id: version.id,
          cells: [
            <VersionPill key="pill" status={version.status} number={version.number} />,
            version.changeNote || <span className="fw-wi-sub">{version.number === 1 ? t('versions.first') : '—'}</span>,
            <span key="people" className="fw-wi-cell">
              <span>{t('versions.writtenBy', { name: version.author.name || '—' })}</span>
              <span className="fw-wi-sub">{version.approvedBy ? t('versions.approvedBy', { name: version.approvedBy.name }) : t('versions.notApproved')}</span>
            </span>,
            <span key="dates" className="fw-wi-cell">
              <span>{version.publishedAt ? t('versions.publishedOn', { date: formatDateTime(version.publishedAt, { locale }) }) : t('versions.createdOn', { date: formatDate(version.createdAt, { locale }) })}</span>
              {version.supersededAt && <span className="fw-wi-sub">{t('versions.supersededOn', { date: formatDate(version.supersededAt, { locale }) })}</span>}
            </span>,
            t('versions.content', { steps: version.steps, media: version.media }),
            version.status === 'DRAFT' || version.status === 'DISCARDED' ? '—' : t('version.seenCount', { count: version.seen }),
            <span key="open" className="fw-wi-actions">
              <Button size="sm" variant="quiet" asChild>
                <Link href={`${base}${recordQuery({ tab: 'steps', version: version.id, compare: null, approve: false })}`}>{t('versions.open', { number: version.number })}</Link>
              </Button>
            </span>,
          ],
        }))}
        stackOnPhone
        widths={['14%', '24%', '18%', '18%', '10%', '8%', '8%']}
      />
      <Card padded>
        <section className="fw-wi-stack" aria-labelledby="fw-wi-compare">
          <h3 id="fw-wi-compare" className="fw-wi-h3">
            {t('compare.title')}
          </h3>
          <div className="fw-wi-form-grid">
            <Field label={t('compare.before')}>
              <Select value={model.compare.beforeId ?? ''} onChange={(event) => actions?.onCompare?.(event.target.value || null, model.compare.afterId)}>
                <option value="">{t('compare.pick')}</option>
                {usable.map((version) => (
                  <option key={version.id} value={version.id} disabled={version.id === model.compare.afterId}>
                    {t('version.pill', { number: version.number, status: t(`status.${version.status}`) })}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('compare.after')}>
              <Select value={model.compare.afterId ?? ''} onChange={(event) => actions?.onCompare?.(model.compare.beforeId, event.target.value || null)}>
                <option value="">{t('compare.pick')}</option>
                {usable.map((version) => (
                  <option key={version.id} value={version.id} disabled={version.id === model.compare.beforeId}>
                    {t('version.pill', { number: version.number, status: t(`status.${version.status}`) })}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {versions.length < 2 ? (
            <EmptyState title={t('compare.oneVersion.title')} description={t('compare.oneVersion.body')} />
          ) : !model.compare.beforeId || !model.compare.afterId ? (
            <p className="fw-wi-hint">{t('compare.pickBoth')}</p>
          ) : model.compare.before?.status === 'error' || model.compare.after?.status === 'error' ? (
            <Banner
              tone="danger"
              title={t('compare.failed')}
              action={
                <Button size="sm" onClick={() => actions?.onRetryCompare?.()}>
                  {t('common.retry')}
                </Button>
              }
            />
          ) : !before || !after ? (
            <p className="fw-wi-hint fw-wi-inline" role="status">
              <Spinner size={14} /> {t('common.loading')}
            </p>
          ) : (
            <VersionCompare
              before={{ label: t('compare.head', { number: before.version.number }), note: t(`status.${before.version.status}`) }}
              after={{ label: t('compare.head', { number: after.version.number }), note: t(`status.${after.version.status}`) }}
              lines={lines}
              fields={FIELDS.map((id) => ({ id, label: t(`compare.field.${id}`) }))}
              locale={INTL_LOCALE[locale]}
              labels={ds.versionCompare}
            />
          )}
        </section>
      </Card>
    </div>
  )
}
