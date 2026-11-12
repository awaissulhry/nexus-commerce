import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_USER, rolePermissions } from '../../../../shell/design-data'
import { inShell } from '../../../quality/_shared/fixtures'
import { BUYER, LATE, NOW, PLANNER, SPEND } from '../fixtures'
import { reportsCan } from '../model'
import { ReportsPrintView, type ReportsPrintModel } from './view/ReportsPrintView'

/**
 * SCR-372 — Purchasing reports on paper or as a PDF (design purchasing.reports tab:print, "Print stylesheet with the filters at
 * the top": the monthly buying review), made-up data only: the month with amounts, the planner without, all sites, loading (Print
 * held), a failed read, no right.
 */

const model = (over: Partial<ReportsPrintModel> = {}): ReportsPrintModel => ({
  person: DEMO_USER.displayName,
  at: NOW,
  company: 'Officina Demo',
  site: 'Stabilimento Demo Nord',
  can: reportsCan(BUYER),
  range: { from: '2026-11-01', to: '2026-11-12' },
  back: '/w/DEMO/purchasing/reports',
  spend: SPEND,
  late: LATE.rows,
  lateMore: false,
  problem: null,
  ...over,
})

function PrintDesign({ model: value }: { model: ReportsPrintModel }) {
  return inShell('/purchasing/reports/print', createElement(ReportsPrintView, { model: value }), 'owner')
}

const noAmounts = { ...SPEND, sight: { orders: true, values: false }, all: { ...SPEND.all, production: undefined, samples: undefined }, groups: SPEND.groups.map((group) => ({ ...group, production: undefined, samples: undefined, share: null })) }

export const designScreen = defineDesignScreen<ReportsPrintModel>({
  screen: 'SCR-372',
  title: 'Purchasing reports print view (Purchasing)',
  view: PrintDesign,
  cases: [
    { id: 'review', label: 'The month with amounts', model: model(), note: 'Spend by supplier with sample orders apart, then the late lines with what they hold up.' },
    { id: 'planner', label: 'Planner (no cost grain)', model: model({ can: reportsCan(PLANNER), spend: noAmounts }) },
    { id: 'all-sites', label: 'All sites, more late lines than printed', model: model({ site: null, lateMore: true }) },
    { id: 'loading', label: 'Loading (Print held)', model: model({ spend: null, late: null }) },
    { id: 'error', label: 'A part failed', model: model({ spend: null, late: null, problem: 'problem.read' }) },
    { id: 'no-permission', label: 'No right', model: model({ can: reportsCan(rolePermissions('sales')), spend: null, late: null }) },
  ],
})
