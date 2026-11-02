'use client'

import Link from 'next/link'
import { ExternalLink, FileQuestion } from 'lucide-react'
import { Banner, Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { AsOf } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { timeOf, whoRows } from '../model'
import type { AttendanceActions, AttendanceModel } from '../view-model'
import { useAttendanceWords } from './parts'

/**
 * Who is in now (design people.attendance sec:who-in, MES-233): counts per area and line, a group under the company's minimum
 * shows no count (ANA-075). The names are the roll call's: a new tab, with its own permission, each opening recorded. Offline
 * the last read stays with its time.
 */
export function WhoPanel({ model, actions }: { model: AttendanceModel; actions?: AttendanceActions | undefined }) {
  const t = useAttendanceWords()
  const locale = useLocale()
  const { value, problem, stale } = model.who
  const rollCall = model.can.rollCall ? (
    <Button size="sm" asChild>
      <Link href={`${model.prefix}/people/attendance/roll-call`} target="_blank">
        {t('who.rollCall')} <ExternalLink size={13} aria-hidden />
      </Link>
    </Button>
  ) : null
  const rows = value ? whoRows(value) : []
  return (
    <section id="fw-at-who" className="fw-at-section" aria-label={t('who.title')}>
      <h2 className="fw-at-title">{t('who.title')}</h2>
      <Card padded>
        {problem ? (
          <EmptyState
            icon={<FileQuestion size={22} aria-hidden />}
            title={t('who.failed')}
            description={t(problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetryWho()}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : !value ? (
          <div className="fw-pp-stack tight" aria-busy="true">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} height={22} />
            ))}
          </div>
        ) : (
          <div className="fw-pp-stack tight">
            <div className="fw-pp-head">
              <span className="fw-pp-row">
                <b>{value.tooFew ? t('who.tooFewTotal') : t('who.total', { count: value.people ?? 0 })}</b>
                <AsOf at={value.asOf} kind="event" />
              </span>
              {rollCall}
            </div>
            {stale && <Banner tone="warning" title={t('who.stale', { time: timeOf(value.asOf, locale) })} />}
            {rows.length === 0 ? (
              <p className="fw-pp-hint">{t('who.nobody')}</p>
            ) : (
              <SummaryTable
                label={t('who.title')}
                columns={[t('who.area'), t('who.line'), t('who.people')]}
                rows={rows.map((row) => ({ id: row.id, cells: [row.area ?? '—', row.line ?? t('who.noLine'), row.tooFew ? t('who.tooFew') : String(row.people ?? 0)] }))}
              />
            )}
          </div>
        )}
      </Card>
    </section>
  )
}
