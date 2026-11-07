'use client'

import { Banner, EmptyState, SummaryTable } from '@nexus/ui/components'
import { PrintView } from '@nexus/ui/patterns/print-view/index'
import { Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { VisitListPrintModel } from '../../view-model'
import '../../health.css'
import { HEALTH_NAMESPACES, NoHealthAccess, personText, useWhen, useWords } from '../../view/parts'

export type { VisitListPrintModel } from '../../view-model'

/**
 * SCR-212-visits — the visit list for the occupational doctor (design tab:visit-list): who, their role and its risks (from the
 * role sheet), the visit's type, the day it is due and the booking. Never a judgement, an outcome, a limit or an absence's
 * reason. Its opening was recorded (a PRINT view), said on the paper. One view model, nothing fetched.
 */
export function VisitListPrintView({ model }: { model: VisitListPrintModel }) {
  return (
    <WithMessages namespaces={HEALTH_NAMESPACES}>
      <Print model={model} />
    </WithMessages>
  )
}

function Print({ model }: { model: VisitListPrintModel }) {
  const t = useWords()
  const ds = useDsWords()
  const locale = useLocale()
  const when = useWhen()
  const rows = model.list.rows
  const waiting = model.canView && !rows && !model.list.problem
  if (!model.canView) return <NoHealthAccess />
  return (
    <PrintView
      title={t('print.title')}
      meta={[model.company, model.site ?? t('print.allSites')]}
      printedAt={formatDateTime(model.at, { locale })}
      printedBy={model.person}
      filters={[{ label: t('print.which'), value: model.chosen > 0 ? t('print.chosen', { count: model.chosen }) : t('print.allOpen') }]}
      printHeld={waiting ? t('common.stillLoading') : null}
      labels={ds.printView}
    >
      {model.list.problem ? (
        <Banner tone="warning" title={t('print.failed')}>
          {t(model.list.problem)}
        </Banner>
      ) : !rows ? (
        <p className="fw-hv-muted" role="status">
          <Spinner size={14} /> {t('common.reading')}
        </p>
      ) : (
        <>
          <p className="fw-hv-print-note">{t('print.note', { law: model.list.law ?? '' })}</p>
          {rows.length === 0 ? (
            <EmptyState title={t('due.emptyTitle')} description={t('print.empty')} />
          ) : (
            <SummaryTable
              label={t('print.title')}
              columns={[t('col.person'), ...(model.allSites ? [t('col.site')] : []), t('col.role'), t('col.type'), t('col.due'), t('col.booked'), t('col.risks')]}
              rows={rows.map((row) => ({
                id: row.id,
                cells: [
                  personText(row.employee),
                  ...(model.allSites ? [row.employee.site.name] : []),
                  row.role ? `${row.role.code} · ${row.role.name}` : '—',
                  t(`visitType.${row.type}`),
                  when.day(row.dueOn),
                  row.booked ? [when.day(row.booked.on), row.booked.place].filter(Boolean).join(' · ') : '—',
                  row.risks.length > 0 ? row.risks.join(', ') : '—',
                ],
              }))}
              stackOnPhone
            />
          )}
        </>
      )}
    </PrintView>
  )
}
