'use client'

import { useEffect, useState } from 'react'
import { Banner, EmptyState, SummaryTable } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { PrintSection, PrintView } from '@nexus/ui/patterns/print-view/index'
import { Button, Spinner } from '@nexus/ui/primitives'
import { DateField, useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { CheckResult } from '../../api'
import { printWindowHeld, reportState, typeLabel } from '../../model'
import { PREVENTIVE_NAMESPACES, useDay, useWords } from '../../view/parts'
import { REGISTER_LAW } from '../../view/RegisterSection'
import '../../preventive.css'

/** SCR-266-register-print — the check register for an inspector: one view model, nothing fetched. */
export interface RegisterPrintModel {
  person: string
  at: string
  company: string
  site: string | null
  /** With "All sites" each row says its site. */
  allSites: boolean
  window: { from: string; to: string }
  /** Print N: only these results (the register's chosen rows). */
  chosen: number | null
  canView: boolean
  results: { value: readonly CheckResult[] | null; problem: string | null; truncated: boolean }
}

/** By machine, then by day (oldest first: the order an inspector reads a machine's history in). */
function groupsOf(results: readonly CheckResult[]): { key: string; title: string; rows: CheckResult[] }[] {
  const groups = new Map<string, { key: string; title: string; rows: CheckResult[] }>()
  for (const result of results) {
    const group = groups.get(result.machine.id) ?? { key: result.machine.id, title: result.machine.assetNumber, rows: [] }
    group.rows.push(result)
    groups.set(result.machine.id, group)
  }
  for (const group of groups.values()) group.rows.sort((a, b) => a.performedOn.localeCompare(b.performedOn) || a.id.localeCompare(b.id))
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title))
}

/**
 * Design new tab "Check register (print)": any period up to three years with the reports, for an inspector — per machine,
 * each check by day: the check and its law, who did it, the outcome and remarks, the report on file (its names) or
 * "missing", next due, kept until; a corrected result says which result corrects it. The period is chosen in the strip
 * (held past three years); a read that could not finish is said on the paper too.
 */
export function RegisterPrintView({ model, onPeriod }: { model: RegisterPrintModel; onPeriod?: (period: { from: string; to: string }) => void }) {
  return (
    <WithMessages namespaces={PREVENTIVE_NAMESPACES}>
      <Print model={model} onPeriod={onPeriod} />
    </WithMessages>
  )
}

function Print({ model, onPeriod }: { model: RegisterPrintModel; onPeriod?: ((period: { from: string; to: string }) => void) | undefined }) {
  const t = useWords()
  const locale = useLocale()
  const ds = useDsWords()
  const day = useDay()
  const [period, setPeriod] = useState(model.window)
  useEffect(() => setPeriod({ from: model.window.from, to: model.window.to }), [model.window.from, model.window.to])
  const answer = model.results.value
  const waiting = model.canView && !answer && !model.results.problem
  const periodHeld = printWindowHeld(period.from, period.to)
  const groups = answer ? groupsOf(answer) : []

  return (
    <PrintView
      title={t('print.title')}
      meta={[model.company, model.site ?? t('site.all')]}
      printedAt={formatDateTime(model.at, { locale })}
      printedBy={model.person}
      filters={[{ label: t('print.period'), value: `${day(model.window.from)} – ${day(model.window.to)}` }, ...(model.chosen ? [{ label: t('print.chosen'), value: String(model.chosen) }] : [])]}
      printHeld={waiting ? t('common.stillLoading') : null}
      tools={
        model.canView && !model.chosen ? (
          <span className="fw-pv-period">
            <DateField value={period.from} onChange={(from) => setPeriod((current) => ({ ...current, from }))} ariaLabel={t('print.from')} />
            <DateField value={period.to} onChange={(to) => setPeriod((current) => ({ ...current, to }))} ariaLabel={t('print.to')} />
            <Button size="sm" heldReason={periodHeld ? t(periodHeld) : null} onClick={() => onPeriod?.(period)}>
              {t('print.show')}
            </Button>
          </span>
        ) : undefined
      }
      labels={ds.printView}
    >
      {!model.canView ? (
        <EmptyState title={t('access.title')} description={t('access.body')} />
      ) : model.results.problem ? (
        <Banner tone="warning" title={t('register.failed')}>
          {t(model.results.problem)}
        </Banner>
      ) : !answer ? (
        <p className="fw-pv-muted" role="status">
          <Spinner size={14} /> {t('common.reading')}
        </p>
      ) : (
        <>
          <p className="fw-pv-print-note">
            {t('print.note')} <LawRef law={REGISTER_LAW} plain={t('register.law')} labels={ds.lawRef} />
          </p>
          {model.results.truncated && <Banner tone="warning" title={t('print.truncated')} />}
          {groups.length === 0 && <p>{t('print.none')}</p>}
          {groups.map((group) => (
            <PrintSection key={group.key} title={t('print.machine', { machine: group.title })} className="fw-pv-print-group">
              <SummaryTable
                stackOnPhone
                label={t('print.tableLabel', { machine: group.title })}
                columns={[t('col.date'), t('col.check'), t('col.by'), t('col.outcome'), t('col.report'), t('col.nextDue'), t('col.keptUntil')]}
                widths={['11%', '24%', '16%', '19%', '14%', '8%', undefined]}
                rows={group.rows.map((result) => ({
                  id: result.id,
                  cells: [
                    day(result.performedOn),
                    `${typeLabel(result.checkType, locale)} — ${result.checkType.legalBasis}${model.allSites ? ` · ${result.site.name}` : ''}`,
                    result.performedBy,
                    [t(`outcome.${result.outcome}`), result.remarks, result.correctedBy ? t('register.correctedBy', { date: day(result.correctedBy.performedOn) }) : null, result.corrects ? t('register.corrects', { date: day(result.corrects.performedOn) }) : null].filter(Boolean).join(' · '),
                    result.reports.length > 0 ? result.reports.map((file) => file.originalName).join(', ') : t(`report.${reportState(result)}`),
                    result.nextDueOn ? day(result.nextDueOn) : t('nextDue.byPlan'),
                    day(result.keptUntil),
                  ],
                }))}
              />
            </PrintSection>
          ))}
        </>
      )}
    </PrintView>
  )
}
