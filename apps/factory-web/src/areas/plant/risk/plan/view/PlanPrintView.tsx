'use client'

import { Banner, EmptyState, SummaryTable } from '@nexus/ui/components'
import { PrintSection, PrintView } from '@nexus/ui/patterns/print-view/index'
import { Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Measure, MeasureView } from '../../api'
import { LAW, sourceWords } from '../../model'
import { RISK_NAMESPACES, useCost, useDay, useWords } from '../../view/parts'
import '../../risk.css'

/** SCR-209-plan-print — "Improvement plan (print)": one view model, nothing fetched. */
export interface PlanPrintModel {
  person: string
  at: string
  company: string
  /** The top bar's site, or null with "All sites" / several assessments. */
  site: string | null
  canView: boolean
  /** money.cost: the cost column. */
  seesCost: boolean
  view: MeasureView
  measures: Measure[] | null
  problem: string | null
}

/**
 * tab:plan-print — "Improvement plan (print)" (design plant.risk new tab: "For the periodic safety meeting"): the measures
 * grouped by assessment — measure, risk or area, roles, owner, due, status, source, and the cost only with the cost grain —
 * with the view printed in the filter line and the law.
 */
export function PlanPrintView({ model }: { model: PlanPrintModel }) {
  return (
    <WithMessages namespaces={RISK_NAMESPACES}>
      <Print model={model} />
    </WithMessages>
  )
}

function Print({ model }: { model: PlanPrintModel }) {
  const t = useWords()
  const locale = useLocale()
  const ds = useDsWords()
  const day = useDay()
  const cost = useCost()
  const waiting = model.canView && !model.measures && !model.problem
  const groups = new Map<string, { title: string; rows: Measure[] }>()
  for (const measure of model.measures ?? []) {
    const group = groups.get(measure.assessmentId) ?? { title: `${measure.assessment} · ${measure.site.name}`, rows: [] }
    group.rows.push(measure)
    groups.set(measure.assessmentId, group)
  }
  const columns = [t('measures.col.title'), t('measures.col.risk'), t('planPrint.roles'), t('measures.col.owner'), t('measures.col.due'), ...(model.seesCost ? [t('measures.col.cost')] : []), t('measures.col.status'), t('measures.col.source')]
  return (
    <PrintView
      title={t('planPrint.title')}
      meta={[model.company, model.site ?? t('planPrint.allSites')]}
      printedAt={formatDateTime(model.at, { locale })}
      printedBy={model.person}
      filters={[{ label: t('measures.viewLabel'), value: t(`view.${model.view}`) }]}
      printHeld={waiting ? t('common.stillLoading') : null}
      labels={ds.printView}
    >
      {!model.canView ? (
        <EmptyState title={t('access.title')} description={t('access.body')} />
      ) : model.problem ? (
        <Banner tone="warning" title={t('measures.failed')}>
          {t(model.problem)}
        </Banner>
      ) : !model.measures ? (
        <p className="fw-rk-muted" role="status">
          <Spinner size={14} /> {t('common.reading')}
        </p>
      ) : groups.size === 0 ? (
        <p>{t('measures.noneInView')}</p>
      ) : (
        <>
          <p className="fw-rk-print-note">{t('planPrint.note', { law: LAW.plan })}</p>
          {[...groups.entries()].map(([id, group]) => (
            <PrintSection key={id} title={group.title}>
              <SummaryTable
                label={group.title}
                columns={columns}
                rows={group.rows.map((measure) => ({
                  id: measure.id,
                  cells: [
                    measure.title,
                    measure.risk ?? '—',
                    measure.roleSheets.map((sheet) => sheet.name).join(', ') || '—',
                    measure.owner ?? t('owner.none'),
                    measure.dueOn ? day(measure.dueOn) : t('due.none'),
                    ...(model.seesCost ? [cost(measure.cost, measure.currency)] : []),
                    t(`status.${measure.status}`),
                    t(sourceWords(measure).key, sourceWords(measure).params),
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
