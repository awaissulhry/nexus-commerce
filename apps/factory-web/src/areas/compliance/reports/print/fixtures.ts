import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_USER } from '../../../../shell/design-data'
import { inShell } from '../../../quality/_shared/fixtures'
import { CR6, EXPIRIES, GAPS, KPIS, REGISTER } from '../fixtures'
import { ReportsPrintView, type ReportsPrintModel } from './view/ReportsPrintView'

/**
 * SCR-307 — the annual compliance review on paper or as a PDF (design compliance.reports tab:cr-pdf, "for management review and
 * auditors"), made-up data only: this year so far, a past year, loading (Print held), a failed read, no right.
 */

const model = (over: Partial<ReportsPrintModel> = {}): ReportsPrintModel => ({
  person: DEMO_USER.displayName,
  at: '2026-11-10T09:42:00.000Z',
  company: 'Officina Demo',
  can: true,
  year: 2026,
  today: '2026-11-10',
  range: { from: '2026-01-01', to: '2026-11-10' },
  back: '/w/DEMO/compliance/reports',
  kpis: KPIS,
  gaps: GAPS,
  expiries: EXPIRIES,
  cr6: CR6,
  register: REGISTER,
  problem: null,
  ...over,
})

function PrintDesign({ model: value }: { model: ReportsPrintModel }) {
  return inShell('/compliance/reports/print', createElement(ReportsPrintView, { model: value }))
}

export const designScreen = defineDesignScreen<ReportsPrintModel>({
  screen: 'SCR-307',
  title: 'Annual compliance review (PDF) (Compliance)',
  view: PrintDesign,
  cases: [
    { id: 'review', label: 'This year so far', model: model(), note: 'Coverage, gaps and expiries as of today, said in words; the rest is the year\'s.' },
    { id: 'past-year', label: 'A past year (2025)', model: model({ year: 2025, range: { from: '2025-01-01', to: '2025-12-31' }, kpis: { ...KPIS, from: '2025-01-01', to: '2025-12-31' } }) },
    { id: 'brand', label: 'One brand', model: model({ kpis: { ...KPIS, brand: { id: '0190f0e2-7202-7000-8000-000000000001', code: 'DEMO-B1', name: 'Marchio Demo Uno' } } }) },
    { id: 'loading', label: 'Loading (Print held)', model: model({ kpis: null, gaps: null, expiries: null, cr6: null, register: null }) },
    { id: 'error', label: 'A part failed', model: model({ kpis: null, gaps: null, expiries: null, cr6: null, register: null, problem: 'problem.unavailable' }) },
    { id: 'no-permission', label: 'No right', model: model({ can: false, kpis: null, gaps: null, expiries: null, cr6: null, register: null }) },
  ],
})
