import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_USER, rolePermissions } from '../../../../shell/design-data'
import { inShell } from '../../../quality/_shared/fixtures'
import { ADHERENCE, COVER, NOW, PLANNER, UTILISATION } from '../fixtures'
import { reportsCan } from '../model'
import { ReportsPrintView, type ReportsPrintModel } from './view/ReportsPrintView'

/**
 * SCR-409 — Planning reports on paper or as a PDF (design planning.reports tab:print, "Print stylesheet with scope and period
 * written at the top": the monthly planning review), made-up data only: November so far, no load ahead, loading (Print held), a
 * failed read, planning not in the role, no right.
 */

const model = (over: Partial<ReportsPrintModel> = {}): ReportsPrintModel => ({
  person: DEMO_USER.displayName,
  at: NOW,
  company: 'Officina Demo',
  site: 'Stabilimento Demo Nord',
  can: reportsCan(PLANNER),
  range: { from: '2026-11-01', to: '2026-11-12' },
  ahead: 4,
  back: '/w/DEMO/planning/reports',
  adherence: ADHERENCE,
  utilisation: UTILISATION,
  cover: COVER,
  problem: null,
  ...over,
})

function PrintDesign({ model: value }: { model: ReportsPrintModel }) {
  return inShell('/planning/reports/print', createElement(ReportsPrintView, { model: value }), 'owner')
}

export const designScreen = defineDesignScreen<ReportsPrintModel>({
  screen: 'SCR-409',
  title: 'Planning reports print view (Planning)',
  view: PrintDesign,
  cases: [
    { id: 'review', label: 'November so far', model: model(), note: 'Adherence per line and week, the utilisation trend per lane, the materials by how soon they run out.' },
    { id: 'no-ahead', label: 'No load ahead', model: model({ ahead: 0 }) },
    { id: 'loading', label: 'Loading (Print held)', model: model({ adherence: null, utilisation: null, cover: null }) },
    { id: 'error', label: 'A part failed', model: model({ adherence: null, utilisation: null, cover: null, problem: 'problem.read' }) },
    { id: 'no-site', label: 'Planning not in the role', model: model({ can: reportsCan(['planning.reports.view']), adherence: null, utilisation: null, cover: null }) },
    { id: 'no-permission', label: 'No right', model: model({ can: reportsCan(rolePermissions('sales')), adherence: null, utilisation: null, cover: null }) },
  ],
})
