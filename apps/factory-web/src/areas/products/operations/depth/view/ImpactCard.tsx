'use client'

import { Card, SummaryTable } from '@nexus/ui/components'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { minutesText } from '../../../styles/model'
import type { OperationMinutesView } from '../api'
import { impactCounts } from '../model'
import '../depth.css'

/** "Routings and piece rates affected": the routing steps made from it (draft and released) and the piece rates on its SMV. */
export function ImpactCard({ view, compact }: { view: OperationMinutesView; compact?: boolean }) {
  const t = useT('products-operations-depth')
  const locale = useLocale()
  const counts = impactCounts(view)
  const routings = view.impact.routings
  const rates = view.impact.pieceRates
  const shown = compact ? routings.slice(0, 6) : routings
  return (
    <Card header={t('impact.title')} description={t('impact.intro')}>
      <div className="fw-opd-stack">
        <ul className="fw-opd-list">
          <li>{t('impact.routings', { count: routings.length, drafts: counts.drafts, released: counts.released })}</li>
          <li>{counts.following > 0 ? t('impact.following', { count: counts.following }) : t('impact.noneFollowing')}</li>
          <li>{t('impact.rates', { count: rates.count })}</li>
        </ul>
        {routings.length > 0 && (
          <SummaryTable
            label={t('impact.routingsLabel')}
            columns={[t('impact.col.style'), t('impact.col.revision'), t('impact.col.step'), t('impact.col.smv'), t('impact.col.from')]}
            rows={shown.map((use) => ({
              id: use.stepId,
              cells: [
                `${use.style.code} · ${use.style.name}`,
                t('impact.revision', { revision: use.revision.revision, status: t(`revisionStatus.${use.revision.status}`) }),
                String(use.seq),
                t('min', { minutes: minutesText(use.standardMinutes, locale) }),
                use.runFrom === 'VERSION' ? t('run.VERSION', { number: use.timeVersionNumber ?? '—' }) : t(`run.${use.runFrom}`),
              ],
            }))}
            stackOnPhone
          />
        )}
        {compact && routings.length > shown.length && <p className="fw-opd-hint">{t('impact.more', { count: routings.length - shown.length })}</p>}
        {rates.rows === null ? (
          rates.count > 0 && <p className="fw-opd-hint">{t('impact.ratesHidden')}</p>
        ) : (
          rates.rows.length > 0 && (
            <SummaryTable
              label={t('impact.ratesLabel')}
              columns={[t('impact.col.table'), t('impact.col.version'), t('impact.col.band'), t('impact.col.smv')]}
              rows={rates.rows.map((row) => ({
                id: `${row.versionId}-${row.sizeBand}`,
                cells: [`${row.table.code} · ${row.table.name}`, t('impact.rateVersion', { number: row.versionNo, status: t(`rateStatus.${row.status}`), day: formatDate(row.effectiveFrom, { locale }) }), row.sizeBand, row.standardMinutes ? t('min', { minutes: minutesText(row.standardMinutes, locale) }) : '—'],
              }))}
              stackOnPhone
            />
          )
        )}
        <p className="fw-opd-hint">{t('impact.ratesRule')}</p>
      </div>
    </Card>
  )
}
