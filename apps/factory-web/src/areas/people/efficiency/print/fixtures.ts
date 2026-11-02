import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_USER } from '../../../../shell/design-data'
import { inShell, NOW } from '../../_shared/fixtures'
import { OVERVIEW } from '../fixtures'
import { EfficiencyPrintView, type EfficiencyPrintModel } from './view/EfficiencyPrintView'

/** SCR-161-print — the line report on paper (design tab:print), made-up data: line level only, never a person. */

const model = (over: Partial<EfficiencyPrintModel> = {}): EfficiencyPrintModel => ({ person: DEMO_USER.displayName, at: NOW, company: 'Officina Demo', site: 'Stabilimento Nord', noSite: false, can: true, read: { value: OVERVIEW, problem: null }, ...over })

function PrintDesign({ model: value }: { model: EfficiencyPrintModel }) {
  return inShell('/people/efficiency/print', createElement(EfficiencyPrintView, { model: value }), 'production')
}

export const designScreen = defineDesignScreen<EfficiencyPrintModel>({
  screen: 'SCR-161-print',
  title: 'Efficiency: line report print (People)',
  view: PrintDesign,
  cases: [
    { id: 'report', label: 'The line report', model: model(), note: 'A hidden line prints empty, with no figure to subtract.' },
    { id: 'empty', label: 'Nothing in the period', model: model({ read: { value: { ...OVERVIEW, tiles: null, lines: [], hiddenGroups: 0, traineeDaysLeftOut: 0 }, problem: null } }) },
    { id: 'loading', label: 'Loading (Print held)', model: model({ read: { value: null, problem: null } }) },
    { id: 'error', label: 'The read failed', model: model({ read: { value: null, problem: { ns: 'people', words: { key: 'problem.unavailable' } } } }) },
    { id: 'all-sites', label: 'All sites: choose one', model: model({ noSite: true, site: null, read: { value: null, problem: null } }) },
    { id: 'no-permission', label: 'No right', model: model({ can: false, read: { value: null, problem: null } }) },
  ],
})
