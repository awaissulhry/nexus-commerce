'use client'

import { Banner, EmptyState, SummaryTable } from '@nexus/ui/components'
import { PrintView } from '@nexus/ui/patterns/print-view/index'
import { Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { IncidentRow } from '../../api'
import { whereText, type IncidentsAddress } from '../../model'
import '../../incidents.css'
import { INCIDENT_NAMESPACES, useWhen, useWords } from '../../view/parts'

/** SCR-210-print — the incident list for the safety meeting, ANONYMISED: one view model, nothing fetched. */
export interface IncidentsPrintModel {
  person: string
  at: string
  company: string
  site: string | null
  allSites: boolean
  address: IncidentsAddress
  canView: boolean
  list: { rows: readonly IncidentRow[] | null; problem: string | null; more: boolean }
}

/**
 * design tab:print "Incident list (anonymised print)", for the safety meeting: the list's filters, then number, kind, when, site
 * (with "All sites"), where, machine, severity, INAIL state, status, open actions. Never a person, an injury or a filing's type
 * (GDPR art. 9): the paper is as anonymised as the list. The browser saves it as a PDF.
 */
export function IncidentsPrintView({ model }: { model: IncidentsPrintModel }) {
  return (
    <WithMessages namespaces={INCIDENT_NAMESPACES}>
      <Print model={model} />
    </WithMessages>
  )
}

function Print({ model }: { model: IncidentsPrintModel }) {
  const t = useWords()
  const ds = useDsWords()
  const locale = useLocale()
  const when = useWhen()
  const rows = model.list.rows
  const waiting = model.canView && !rows && !model.list.problem
  const filters = [
    ...(model.address.rows ? [{ label: t('list.rows'), value: t(`rows.${model.address.rows}`) }] : []),
    { label: t('list.status'), value: t(model.address.status ? `statusFilter.${model.address.status}` : 'statusFilter.default') },
    ...(model.address.from || model.address.to ? [{ label: t('print.window'), value: `${when.day(model.address.from)} – ${when.day(model.address.to)}` }] : []),
    ...(model.address.q ? [{ label: t('print.number'), value: model.address.q }] : []),
  ]
  return (
    <PrintView
      title={t('print.title')}
      meta={[model.company, model.site ?? t('print.allSites')]}
      printedAt={formatDateTime(model.at, { locale })}
      printedBy={model.person}
      filters={filters}
      printHeld={waiting ? t('common.stillLoading') : null}
      labels={ds.printView}
    >
      {!model.canView ? (
        <EmptyState title={t('access.title')} description={t('access.body')} />
      ) : model.list.problem ? (
        <Banner tone="warning" title={t('list.failed')}>
          {t(model.list.problem)}
        </Banner>
      ) : !rows ? (
        <p className="fw-inc-muted" role="status">
          <Spinner size={14} /> {t('common.reading')}
        </p>
      ) : (
        <>
          <p className="fw-inc-print-note">{t('print.note')}</p>
          {model.list.more && <p className="fw-inc-warn">{t('print.more', { count: rows.length })}</p>}
          {rows.length === 0 ? (
            <p>{t('list.emptyTitle')}</p>
          ) : (
            <SummaryTable
              label={t('print.tableLabel')}
              columns={[t('col.number'), t('col.kind'), t('col.occurredAt'), ...(model.allSites ? [t('col.site')] : []), t('col.where'), t('col.machine'), t('col.severity'), t('col.inail'), t('col.status'), t('col.actions')]}
              rows={rows.map((row) => ({
                id: row.id,
                cells: [
                  row.number,
                  t(`kind.${row.kind}`),
                  when.at(row.occurredAt),
                  ...(model.allSites ? [row.site.name] : []),
                  whereText(row) || '—',
                  row.machine?.assetNumber ?? '—',
                  t(`severity.${row.severity ?? 'UNKNOWN'}`),
                  row.inail.state ? t(`filingState.${row.inail.state}`) : '—',
                  t(`status.${row.status}`),
                  String(row.actionsOpen),
                ],
              }))}
            />
          )}
        </>
      )}
    </PrintView>
  )
}
