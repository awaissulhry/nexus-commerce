import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_PDF, inRiskShell, NORTH, RISK_ROLES_DEMO, V2, V3, type RiskRoleDemo } from '../_demo/fixtures'
import { riskCan } from '../model'
import { DvrTabView, type DvrTabModel } from './view/DvrTabView'

/** SCR-209-dvr — "DVR (frozen PDF)" in its own tab (design plant.risk/tab:dvr-pdf). Made-up data and a made-up one-page PDF. */

interface DvrCase {
  role: RiskRoleDemo
  model: DvrTabModel
}

const model = (role: RiskRoleDemo, over: Partial<DvrTabModel> = {}): DvrCase => {
  const can = riskCan(RISK_ROLES_DEMO[role])
  return { role, model: { canView: can.view, canReadFiles: can.readFiles, canKeep: can.manage, assessment: NORTH, version: V2, show: 'pdf', bytes: DEMO_PDF, problem: null, keeping: false, keepProblem: null, ...over } }
}

function DvrDesign({ model: value }: { model: DvrCase }) {
  return inRiskShell('/plant/risk/dvr', createElement(DvrTabView, { model: value.model }), value.role)
}

export const designScreen = defineDesignScreen<DvrCase>({
  screen: 'SCR-209-dvr',
  title: 'Risk assessment › DVR (frozen PDF), new tab',
  view: DvrDesign,
  cases: [
    { id: 'pdf', label: 'The frozen PDF of the version in force, with its seal', model: model('safety'), note: 'Verify a file computes the fingerprint on this device.' },
    { id: 'seal', label: 'The kept seal', model: model('safety', { show: 'seal' }) },
    { id: 'waiting', label: 'A version waiting: the seal is a preview', model: model('safety', { version: V3(), show: 'seal' }) },
    { id: 'unsealed', label: 'Signed, seal not kept: Keep the seal', model: model('safety', { version: { ...V2, sealed: null }, show: 'seal' }) },
    { id: 'loading', label: 'Reading', model: model('safety', { bytes: null }) },
    { id: 'error', label: 'Failed: said in words', model: model('safety', { bytes: null, problem: 'problem.notFound' }) },
    { id: 'no-permission', label: 'Sales: no safety.view', model: model('sales', { assessment: null, version: null, bytes: null }) },
  ],
})
