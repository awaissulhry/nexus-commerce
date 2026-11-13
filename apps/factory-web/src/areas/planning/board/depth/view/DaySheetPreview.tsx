'use client'

import { Banner, Disclosure, KeyValue, SummaryTable } from '@nexus/ui/components'
import type { DaySheetPaper } from '../api'
import type { DepthWords } from '../model'

/**
 * A day sheet per line (design tab:day-sheets, SCR-407; B-W2b-337 on B-W2b-329's paper): what the PDF says, sheet by sheet —
 * its heading, the facts (site, day, which plan), the working-plan banner, the rows in start order with an empty Done column
 * to tick by hand, the footer with the lane's load. The paper is a document for a line leader: it carries its own words in
 * the language picked for it (Italian or English), not the page's. The PDF itself opens in a new tab.
 */
export function DaySheetPreview({ paper, words, open = false }: { paper: DaySheetPaper; words: DepthWords; open?: boolean }) {
  const { t } = words
  return (
    <div className="fw-pbd-sheets" lang={paper.language}>
      <p className="fw-pb-hint">{t('sheet.lead', { count: paper.sheets.length, sheets: String(paper.sheets.length), language: t(`print.languages.${paper.language}`) })}</p>
      {paper.sheets.map((sheet, index) => (
        <Disclosure key={`${index}-${sheet.heading}`} open={open || index === 0} summary={`${sheet.heading} · ${sheet.rows.length === 0 ? t('print.noRows') : t('print.rows', { count: sheet.rows.length, rows: String(sheet.rows.length) })}`}>
          <div className="fw-pbd-stack">
            <KeyValue columns={2} labelCase="sentence" items={sheet.facts.map((fact) => ({ label: fact.label, value: fact.value }))} />
            {sheet.banner ? <Banner tone="warning" title={sheet.banner} /> : null}
            {sheet.rows.length === 0 ? (
              <p className="fw-pb-hint">{sheet.empty ?? t('print.noRows')}</p>
            ) : (
              <SummaryTable
                label={sheet.heading}
                density="compact"
                stackOnPhone
                columns={paper.columns}
                rows={sheet.rows.map((row, at) => ({ id: `${index}-${at}`, cells: row.cells }))}
              />
            )}
            <p className="fw-pb-hint">{sheet.footer}</p>
          </div>
        </Disclosure>
      ))}
      <p className="fw-pb-hint">{paper.foot}</p>
    </div>
  )
}
