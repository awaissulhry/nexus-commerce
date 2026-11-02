'use client'

import { Fragment } from 'react'
import { Printer } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { useWords } from '../../../_shared/parts'
import type { Matrix } from '../../api'
import { authorisationOf, className, groupOf, levelOf, matrixColumns, SKILLS_NAMESPACES, skillName, TIME_ZONE, type SkillsAddress } from '../../model'
import '../../skills.css'

/** SCR-160-print — the matrix on paper: one view model, nothing fetched. */
export interface MatrixPrintModel {
  readonly person: string
  readonly at: string
  readonly company: string
  /** The top bar's site; null = all sites. */
  readonly site: string | null
  readonly address: SkillsAddress
  /** How many rows were chosen; 0 = the whole view. */
  readonly picked: number
  readonly matrix: { readonly value: Matrix | null; readonly problem: string | null }
}

export function MatrixPrintView({ model }: { model: MatrixPrintModel }) {
  return (
    <WithMessages namespaces={SKILLS_NAMESPACES}>
      <Sheet model={model} />
    </WithMessages>
  )
}

/** One A3 landscape sheet: the size is this page's alone (a `<style>` while it is drawn). */
const A3 = '@page { size: A3 landscape; margin: 10mm; }'

function Sheet({ model }: { model: MatrixPrintModel }) {
  const t = useT('people-skills')
  const people = useWords()
  const locale = useLocale()
  const value = model.matrix.value
  const columns = value ? matrixColumns(value, model.address.show) : []
  const filters = [
    t('print.company', { name: model.company }),
    model.site ? t('print.site', { name: model.site }) : t('print.allSites'),
    t('print.show', { show: t(`show.${model.address.show}`) }),
    ...(model.address.tile ? [t('print.tile', { tile: t(`tile.${model.address.tile}`) })] : []),
    ...(model.address.q.trim() ? [t('print.search', { q: model.address.q.trim() })] : []),
    ...(model.picked > 0 ? [t('print.picked', { count: model.picked })] : []),
  ]
  let group: string | null = null
  return (
    <div className="fw-sk-print">
      <style>{A3}</style>
      <header className="fw-sk-print-head">
        <div>
          <h1>{t('print.title')}</h1>
          <p>{filters.join(' · ')}</p>
          <p>{t('print.by', { name: model.person, at: formatDateTime(model.at, { locale, timeZone: TIME_ZONE }) })}</p>
        </div>
        <Button size="sm" className="fw-sk-noprint" onClick={() => window.print()}>
          <Printer size={14} aria-hidden /> {t('print.print')}
        </Button>
      </header>
      {model.matrix.problem ? (
        <Banner tone="danger" title={people(model.matrix.problem)} />
      ) : !value ? (
        <p role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
      ) : value.rows.length === 0 ? (
        <p>{t('print.empty')}</p>
      ) : (
        <div className="fw-sk-print-frame">
          <table className="fw-sk-print-table">
            <thead>
              <tr>
                <th scope="col">{t('list.person')}</th>
                {columns.map((column) => (
                  <th key={column.id} scope="col" data-kind={column.kind}>
                    {column.kind === 'skill' ? skillName(column.skill, locale) : className(column.entry, locale)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {value.rows.map((row) => {
                const here = groupOf(row)
                const opens = model.address.sort === 'TEAM' && here !== group
                group = here
                return (
                  <Fragment key={row.employeeId}>
                    {opens && (
                      <tr className="fw-sk-print-group">
                        <th scope="rowgroup" colSpan={columns.length + 1}>
                          {here || t('list.noGroup')}
                        </th>
                      </tr>
                    )}
                    <tr>
                      <th scope="row">{row.name}</th>
                      {columns.map((column) => {
                        if (column.kind === 'skill') {
                          const cell = levelOf(row, column.id)
                          return <td key={column.id}>{cell ? `${t(`level.${cell.level}`)}${cell.trainee === 'TRAINEE' || cell.trainee === 'OVERDUE' ? ` (${t('cell.traineeShort')})` : ''}` : '—'}</td>
                        }
                        const cell = authorisationOf(row, column.id)
                        return <td key={column.id}>{cell ? t(`machine.${cell.state}`) : '—'}</td>
                      })}
                    </tr>
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="fw-sk-print-foot">{t('print.foot')}</p>
    </div>
  )
}
