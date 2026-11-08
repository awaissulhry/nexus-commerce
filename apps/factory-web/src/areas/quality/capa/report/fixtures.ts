import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { REPORT_EN, REPORT_IT, ROWS } from '../demo/fixtures'
import { CapaReportView, type CapaReportModel } from './view/CapaReportView'

/**
 * SCR-146-report — the 8D report (PDF) window (design tab:capa-pdf, a new tab), made-up data only: the preview in Italian
 * and in English, being made, a version kept, a refusal, the error and the no-permission page.
 */

const CAPA = { number: ROWS[0]!.number, title: ROWS[0]!.title, type: ROWS[0]!.type }
const model = (over: Partial<CapaReportModel> = {}): CapaReportModel => ({ allowed: true, canKeep: true, language: 'it', capa: CAPA, pdf: REPORT_IT, problem: null, keeping: false, notice: null, ...over })

function ReportDesign({ model: given }: { model: CapaReportModel }) {
  const [now, setNow] = useState(given)
  useEffect(() => setNow(given), [given])
  return createElement(CapaReportView, { model: now, actions: { onLanguage: (language) => setNow((current) => ({ ...current, language, pdf: language === 'en' ? REPORT_EN : REPORT_IT })) } })
}

export const designScreen = defineDesignScreen<CapaReportModel>({
  screen: 'SCR-146-report',
  title: 'Corrective action — 8D report (PDF)',
  view: ReportDesign,
  cases: [
    { id: 'italian', label: 'The 8D in Italian (the preview banner)', model: model(), note: 'Print prints the PDF; Keep a version keeps it on the CAPA.' },
    { id: 'english', label: 'In English', model: model({ language: 'en', pdf: REPORT_EN }) },
    { id: 'kept', label: 'A version kept (the receipt)', model: model({ notice: { say: { key: 'report.kept', params: { version: 2 } }, tone: 'success' } }) },
    { id: 'same', label: 'Kept again with the same contents: the newest version back', model: model({ notice: { say: { key: 'report.same', params: { version: 1 } }, tone: 'info' } }) },
    { id: 'read-only', label: 'Sales: reads and prints; Keep held with its reason', model: model({ canKeep: false }) },
    { id: 'loading', label: 'Being made', model: model({ pdf: null }) },
    { id: 'error', label: 'The report could not be made (Try again)', model: model({ pdf: null, problem: 'problem.unavailable' }) },
    { id: 'no-permission', label: 'Warehouse: no quality.capa.view', model: model({ allowed: false, capa: null, pdf: null }) },
  ],
})
