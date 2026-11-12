import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_USER, rolePermissions } from '../../../../shell/design-data'
import { inShell } from '../../../quality/_shared/fixtures'
import { AGEING, LEATHER, leatherNoValues, noValues, NOW, OWNER, WAREHOUSE } from '../fixtures'
import { reportsCan } from '../model'
import { ReportsPrintView, type ReportsPrintModel } from './view/ReportsPrintView'

/**
 * SCR-353 — Warehouse reports on paper or as a PDF (design warehouse.reports tab:wr-tab-print, "paper or PDF for a meeting":
 * the monthly stock review), made-up data only: the month with values, the warehouse without, all sites, loading (Print held),
 * a failed read, no right.
 */

const model = (over: Partial<ReportsPrintModel> = {}): ReportsPrintModel => ({
  person: DEMO_USER.displayName,
  at: NOW,
  company: 'Officina Demo',
  site: 'Stabilimento Demo Nord',
  can: reportsCan(OWNER),
  range: { from: '2026-11-01', to: '2026-11-12' },
  back: '/w/DEMO/warehouse/reports',
  ageing: AGEING,
  leather: LEATHER,
  problem: null,
  ...over,
})

function PrintDesign({ model: value }: { model: ReportsPrintModel }) {
  return inShell('/warehouse/reports/print', createElement(ReportsPrintView, { model: value }), 'warehouse')
}

export const designScreen = defineDesignScreen<ReportsPrintModel>({
  screen: 'SCR-353',
  title: 'Warehouse reports print view (Warehouse)',
  view: PrintDesign,
  cases: [
    { id: 'review', label: 'The month with values', model: model(), note: 'Stock ageing as at the period\'s last day with each type\'s articles, then leather use by article and supplier lot.' },
    { id: 'warehouse', label: 'Warehouse (no cost grain)', model: model({ can: reportsCan(WAREHOUSE), ageing: noValues(AGEING), leather: leatherNoValues(LEATHER) }) },
    { id: 'all-sites', label: 'All sites', model: model({ site: null }) },
    { id: 'loading', label: 'Loading (Print held)', model: model({ ageing: null, leather: null }) },
    { id: 'error', label: 'A part failed', model: model({ ageing: null, leather: null, problem: 'problem.read' }) },
    { id: 'no-permission', label: 'No right', model: model({ can: reportsCan(rolePermissions('sales')), ageing: null, leather: null }) },
  ],
})
