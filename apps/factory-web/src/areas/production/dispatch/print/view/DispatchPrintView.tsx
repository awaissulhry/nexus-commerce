'use client'

import { Printer } from 'lucide-react'
import { Banner, SummaryTable } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { DispatchPaper } from '../../api'
import { DISPATCH_NAMESPACE } from '../../model'
import '../../dispatch.css'

/** SCR-138-print — the dispatch list on paper: one view model, nothing fetched. */
export interface DispatchPrintModel {
  readonly papers: readonly DispatchPaper[] | null
  readonly problem: string | null
}

/**
 * Production › Dispatch › the printed list (design production.dispatch tab:dp-tab-list; MES-032): per line or station, the day,
 * the shift, the plan and when it was printed, a table per station with an empty column to tick by hand. The words come
 * from the API in the page's language (factory-domain production/dispatch/paper: the same paper as its PDF). A name beside a
 * station only where the site's floor records name workers; no figure per person, no customer, no money.
 */
export function DispatchPrintView({ model }: { model: DispatchPrintModel }) {
  return (
    <WithMessages namespaces={[DISPATCH_NAMESPACE]}>
      <Print model={model} />
    </WithMessages>
  )
}

function Print({ model }: { model: DispatchPrintModel }) {
  const t = useT(DISPATCH_NAMESPACE)
  return (
    <article className="fw-dp-print">
      <Button className="fw-dp-print-button" variant="secondary" heldReason={model.papers ? undefined : t('print.held')} onClick={() => window.print()}>
        <Printer size={14} aria-hidden /> {t('print.button')}
      </Button>
      {model.problem ? (
        <Banner tone="danger" title={t('error.title')}>
          {t(model.problem)}
        </Banner>
      ) : !model.papers ? (
        <p className="fw-dp-muted" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
      ) : (
        model.papers.map((paper) => <Paper key={paper.heading} paper={paper} />)
      )}
    </article>
  )
}

function Paper({ paper }: { paper: DispatchPaper }) {
  return (
    <section className="fw-dp-paper" aria-label={paper.heading}>
      <p className="fw-dp-muted">{paper.title}</p>
      <h1 className="fw-dp-paper-title">{paper.heading}</h1>
      <p className="fw-dp-muted">{paper.facts.map((fact) => `${fact.label}: ${fact.value}`).join(' · ')}</p>
      {paper.empty && <p className="fw-dp-text">{paper.empty}</p>}
      {paper.sections.map((section) => (
        <div className="fw-dp-paper-section" key={section.title}>
          <h2 className="fw-dp-h2">{section.title}</h2>
          {section.operators && <p className="fw-dp-text">{section.operators}</p>}
          <SummaryTable label={section.title} columns={paper.columns} rows={section.rows.map((row, index) => ({ id: String(index), cells: row.cells }))} />
          <p className="fw-dp-muted">{section.footer}</p>
        </div>
      ))}
      <p className="fw-dp-muted">{paper.foot}</p>
    </section>
  )
}
