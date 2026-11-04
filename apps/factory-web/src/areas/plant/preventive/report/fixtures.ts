import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_SHA, demoPdf, inPreventiveShell, NOW, RESULTS, type PreventiveRoleDemo } from '../_demo/fixtures'
import { CheckReportView, type CheckReportModel } from './view/CheckReportView'

/**
 * SCR-266-report — the check report window (design new tab "Check report (PDF)", from a result), made-up data: the
 * preview in Italian or English, kept in the register with its seal, being made, a failed read, no right.
 */

interface ReportCase {
  role: PreventiveRoleDemo
  model: CheckReportModel
}

const kept = (made = true) => ({ document: { id: 'd0190f0e-0000-7000-8000-000000000001', version: made ? 2 : 1, language: 'it', fileId: 'f0190f0e-0000-7000-8000-000000000001', createdAt: NOW }, made, replayed: false })

const model = (over: Partial<CheckReportModel> = {}, role: PreventiveRoleDemo = 'maintenance'): ReportCase => ({
  role,
  model: { allowed: true, canKeep: true, language: 'it', result: RESULTS[0]!, pdf: demoPdf('Verbale di verifica DEMO-FLT-01'), problem: null, keeping: false, kept: null, keepProblem: null, seal: null, sealHeld: null, ...over },
})

function ReportDesign({ model: value }: { model: ReportCase }) {
  return inPreventiveShell('/plant/preventive/report', createElement(CheckReportView, { model: value.model }), value.role)
}

export const designScreen = defineDesignScreen<ReportCase>({
  screen: 'SCR-266-report',
  title: 'Preventive & statutory checks: check report (PDF)',
  view: ReportDesign,
  cases: [
    { id: 'preview', label: 'The preview, in Italian', model: model(), note: 'Made now, stored nowhere (the PDF says so); Italiano | English; Keep in the register; Print.' },
    { id: 'english', label: 'In English', model: model({ language: 'en', pdf: demoPdf('Check report DEMO-FLT-01') }) },
    { id: 'kept', label: 'Kept: version 2 with its seal', model: model({ kept: kept(), seal: { sha256: DEMO_SHA } }), note: 'The DS DocumentSeal: version, fingerprint, when, the server clock; Verify a file. Download the kept copy.' },
    { id: 'kept-same', label: 'Kept already: the same contents', model: model({ kept: kept(false), seal: { sha256: DEMO_SHA } }) },
    { id: 'seal-no-right', label: 'Kept, no files.read for the seal', model: model({ kept: kept(), sealHeld: 'report.sealNoRight' }) },
    { id: 'keep-refused', label: 'Keep refused', model: model({ keepProblem: { key: 'problem.forbidden', field: null } }) },
    { id: 'read-only', label: 'Read-only: Keep held', model: model({ canKeep: false }, 'readOnly') },
    { id: 'loading', label: 'Being made', model: model({ pdf: null }) },
    { id: 'error', label: 'The report could not be made', model: model({ pdf: null, problem: 'problem.read' }) },
    { id: 'no-permission', label: 'Sales: no plant.view', model: model({ allowed: false, result: null, pdf: null }, 'sales') },
  ],
})
