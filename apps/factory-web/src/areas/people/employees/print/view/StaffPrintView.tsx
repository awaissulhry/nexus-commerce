'use client'

import { Printer } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { Employee } from '../../../_shared/api'
import { hoursText, TIME_ZONE, type EmployeesAddress } from '../../../_shared/model'
import { PeopleMessages, useWords } from '../../../_shared/parts'

/** SCR-084-print — the staff list on paper: one view model, nothing fetched. */
export interface StaffPrintModel {
  readonly person: string
  readonly at: string
  readonly company: string
  /** The top bar's site; null = all sites. */
  readonly site: string | null
  readonly address: EmployeesAddress
  readonly rows: { readonly value: readonly Employee[] | null; readonly problem: string | null; readonly cut: boolean }
}

/**
 * People › Employees › Staff list (design people.employees tab:staff-print): the view the list shows, with its filters
 * written on top (company, site, the tile or rows, the search), who printed it and when; the register's columns — name,
 * name on the floor, code, type, site, department, home line, team, lead, role, contract, start, end, status. Never pay,
 * attendance, health or a per-person work figure.
 */
export function StaffPrintView({ model }: { model: StaffPrintModel }) {
  return (
    <PeopleMessages>
      <StaffList model={model} />
    </PeopleMessages>
  )
}

function StaffList({ model }: { model: StaffPrintModel }) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: TIME_ZONE }
  const rows = model.rows.value
  const day = (value: string | null) => (value ? formatDate(`${value}T12:00:00Z`, place) : '—')
  const filters = [
    t('print.company', { name: model.company }),
    model.site ? t('print.site', { name: model.site }) : t('print.allSites'),
    model.address.tile ? t('print.tile', { tile: t(`tile.${model.address.tile}`) }) : t('print.rows', { rows: t(`rows.${model.address.rows}`) }),
    ...(model.address.q.trim() ? [t('print.search', { q: model.address.q.trim() })] : []),
  ]
  const columns = ['name', 'floorName', 'code', 'kind', 'site', 'department', 'homeLine', 'team', 'lead', 'role', 'contract', 'start', 'end', 'status'] as const
  return (
    <article className="fw-pp-print">
      <header className="fw-pp-print-head">
        <h1 className="fw-pp-print-title">{t('staff.title', { count: rows?.length ?? 0 })}</h1>
        <p className="fw-pp-hint">{t('print.meta', { at: formatDateTime(model.at, place), person: model.person })}</p>
        <Button className="fw-pp-print-button" variant="secondary" onClick={() => window.print()} heldReason={rows && rows.length > 0 ? null : t('print.held')}>
          <Printer size={14} aria-hidden /> {t('print.button')}
        </Button>
      </header>
      <p className="fw-pp-text">{filters.join(' · ')}</p>
      {model.rows.problem ? (
        <Banner tone="danger" title={t('list.failed')}>
          {t(model.rows.problem)}
        </Banner>
      ) : !rows ? (
        <p className="fw-pp-hint" role="status">
          <Spinner size={14} /> {t('record.loading')}
        </p>
      ) : rows.length === 0 ? (
        <p className="fw-pp-text">{t('staff.none')}</p>
      ) : (
        <>
          {model.rows.cut && <Banner tone="warning" title={t('staff.cut', { count: rows.length })} />}
          <div className="fw-pp-table-wrap">
            <table className="fw-pp-table">
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={column} scope="col">
                      {t(`csv.${column}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const hours = hoursText(row.weeklyMinutes, locale)
                  return (
                    <tr key={row.id}>
                      <td>{row.name}</td>
                      <td>{row.displayName}</td>
                      <td>{row.employeeCode ?? '—'}</td>
                      <td>{t(`kind.${row.kind}`)}</td>
                      <td>{row.site.code}</td>
                      <td>{row.department ?? '—'}</td>
                      <td>{row.homeLine?.code ?? '—'}</td>
                      <td>{row.team ? `${row.team.code} · ${row.team.name}` : '—'}</td>
                      <td>{row.isLead ? t('team.isLead') : (row.lead?.name ?? '—')}</td>
                      <td>{row.jobRole ?? '—'}</td>
                      <td>{row.contract ? `${t(`contract.${row.contract}`)}${hours ? ` · ${t('contract.hours', { hours })}` : ''}` : '—'}</td>
                      <td>{day(row.startDate)}</td>
                      <td>{day(row.endDate)}</td>
                      <td>{t(`lifecycle.${row.lifecycle}`)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className="fw-pp-hint">{t('staff.foot')}</p>
    </article>
  )
}
