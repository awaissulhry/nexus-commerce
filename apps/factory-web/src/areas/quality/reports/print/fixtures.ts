import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_USER } from '../../../../shell/design-data'
import { inShell, NOW } from '../../_shared/fixtures'
import { COMPARE, INCOMING, KPIS, TREND } from '../fixtures'
import { reportsAddressOf } from '../model'
import { ReportsPrintView, type ReportsPrintModel } from './view/ReportsPrintView'

/** SCR-147-print — the quality report on paper or as a PDF (design tab:qr-pdf), made-up data: groups only, never a person. */

const model = (over: Partial<ReportsPrintModel> = {}): ReportsPrintModel => ({
  person: DEMO_USER.displayName,
  at: NOW,
  company: 'Officina Demo',
  site: 'Stabilimento Nord',
  noSite: false,
  can: true,
  address: reportsAddressOf(new URLSearchParams('')),
  lineName: null,
  kpis: KPIS,
  trend: TREND,
  compare: COMPARE.line,
  incoming: INCOMING,
  problem: null,
  ...over,
})

function PrintDesign({ model: value }: { model: ReportsPrintModel }) {
  return inShell('/quality/reports/print', createElement(ReportsPrintView, { model: value }))
}

export const designScreen = defineDesignScreen<ReportsPrintModel>({
  screen: 'SCR-147-print',
  title: 'Quality report (PDF) (Quality)',
  view: PrintDesign,
  cases: [
    { id: 'report', label: 'The report, filters on top', model: model(), note: 'A hidden group prints "too few people", with no figure to subtract.' },
    { id: 'by-supplier', label: 'Compared by supplier, one line\'s trend', model: model({ address: reportsAddressOf(new URLSearchParams('by=supplier')), compare: COMPARE.supplier, lineName: 'L-A · Linea giacche' }) },
    { id: 'loading', label: 'Loading (Print held)', model: model({ kpis: null, trend: null, compare: null, incoming: null }) },
    { id: 'error', label: 'A part failed', model: model({ kpis: null, trend: null, compare: null, incoming: null, problem: 'problem.unavailable' }) },
    { id: 'all-sites', label: 'All sites: choose one', model: model({ noSite: true, site: null, kpis: null, trend: null, compare: null, incoming: null }) },
    { id: 'no-permission', label: 'No right', model: model({ can: false, kpis: null, trend: null, compare: null, incoming: null }) },
  ],
})
