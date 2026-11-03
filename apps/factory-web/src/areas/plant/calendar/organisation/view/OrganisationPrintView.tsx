'use client'

import { Banner, EmptyState, SummaryTable } from '@nexus/ui/components'
import { PrintSection, PrintView } from '@nexus/ui/patterns/print-view/index'
import { Spinner } from '@nexus/ui/primitives'
import { ROLE_LAW } from '@nexus/factory-domain/safety/organisation/rules'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Organisation } from '../../api'
import { chartGroups, missingPlaces } from '../../model'
import { SAFETY_NAMESPACES, useDay, useWords } from '../../view/parts'
import '../../calendar.css'

/** SCR-267-org-print — the organisation chart for the notice board: one view model, nothing fetched. */
export interface OrganisationPrintModel {
  person: string
  at: string
  company: string
  site: string | null
  today: string
  canView: boolean
  organisation: { value: Organisation | null; problem: string | null }
}

/**
 * Design new tab "Organisation chart (print)": names and contacts for the notice board, per company and site (the whole
 * company first), each role with its holder (an outside contact with its organisation, e-mail and phone; never an
 * employee's private contact), from when, and the role's law; then the roles nobody holds. The browser prints or saves a PDF.
 */
export function OrganisationPrintView({ model }: { model: OrganisationPrintModel }) {
  return (
    <WithMessages namespaces={SAFETY_NAMESPACES}>
      <Print model={model} />
    </WithMessages>
  )
}

function Print({ model }: { model: OrganisationPrintModel }) {
  const t = useWords()
  const locale = useLocale()
  const ds = useDsWords()
  const day = useDay()
  const answer = model.organisation.value
  const waiting = model.canView && !answer && !model.organisation.problem
  const groups = answer ? chartGroups(answer.appointments, model.today) : []
  const missing = answer ? missingPlaces(answer.missing, answer.companies) : []
  return (
    <PrintView
      title={t('orgPrint.title')}
      meta={[model.company, model.site ?? t('orgPrint.allSites')]}
      printedAt={formatDateTime(model.at, { locale })}
      printedBy={model.person}
      filters={[{ label: t('orgPrint.asOf'), value: day(model.today) }]}
      printHeld={waiting ? t('common.stillLoading') : null}
      labels={ds.printView}
    >
      {!model.canView ? (
        <EmptyState title={t('access.title')} description={t('access.body')} />
      ) : model.organisation.problem ? (
        <Banner tone="warning" title={t('org.failed')}>
          {t(model.organisation.problem)}
        </Banner>
      ) : !answer ? (
        <p className="fw-hs-muted" role="status">
          <Spinner size={14} /> {t('common.reading')}
        </p>
      ) : (
        <>
          <p className="fw-hs-print-note">{t('orgPrint.note', { law: answer.law })}</p>
          {groups.length === 0 && <p>{t('org.empty')}</p>}
          {groups.map((group) => (
            <PrintSection key={group.key} title={`${group.company} · ${group.site ?? t('site.whole')}`} className="fw-hs-print-group">
              <SummaryTable
                label={t('orgPrint.tableLabel', { place: group.site ?? group.company })}
                columns={[t('org.col.role'), t('org.col.person'), t('orgPrint.contact'), t('org.col.from'), t('orgPrint.law')]}
                widths={['22%', '22%', '26%', '12%', undefined]}
                align={[undefined, undefined, undefined, undefined, 'left']}
                rows={group.rows.map((row) => ({
                  id: row.id,
                  cells: [
                    `${t(`role.${row.role}`)}${row.shift ? ` · ${row.shift.name}` : ''}`,
                    row.appointee.name,
                    row.appointee.kind === 'OUTSIDE' ? [row.appointee.partyName, row.appointee.email, row.appointee.phone].filter(Boolean).join(' · ') || '—' : t('orgPrint.ofCompany'),
                    day(row.fromDate),
                    ROLE_LAW[row.role],
                  ],
                }))}
              />
            </PrintSection>
          ))}
          {missing.length > 0 && (
            <PrintSection title={t('org.missing', { count: missing.length })}>
              <ul className="fw-hs-list">
                {missing.map((slot) => (
                  <li key={slot.key}>{t('org.missingSlot', { role: t(`role.${slot.role}`), place: slot.place })}</li>
                ))}
              </ul>
            </PrintSection>
          )}
        </>
      )}
    </PrintView>
  )
}
