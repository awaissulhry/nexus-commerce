import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_COMPANIES } from '../../../../shell/design-data'
import { CURVES } from '../../quotes/record/lines-depth/fixtures'
import type { CurveDialogModel } from './view/CurveDialog'
import { CurvesView, type CurvesModel } from './view/CurvesView'

/**
 * SCR-235-curves — Sales settings › Size curves (design sales.settings sec:ssettings.curves, SAL-269; B-W2b-316 on B-W2b-302's
 * API), made-up data only: invented curves of an invented EU scale. Each case is one state: the curves of a scale as SizeColumns,
 * two selected, a role without the right, empty, an error, the curve's dialog with the total live (at 100 %, under it, a share
 * that is not a number), archived read only.
 */

const SCALE = CURVES[0]!.sizeScale
const ARCHIVED = { ...CURVES[0]!, id: '0190f0e2-7100-7000-8000-000000000003', name: 'Curva 2025', status: 'ARCHIVED' as const }
const ALL = [...CURVES, ARCHIVED]
const COMPANIES = DEMO_COMPANIES.map((company) => ({ id: company.id, code: company.code, name: company.name }))
const SCALES = { status: 'ready' as const, items: [{ id: SCALE.id, code: SCALE.code, name: SCALE.name, codes: SCALE.sizes }] }
const dialog = (extra: Partial<CurveDialogModel>): CurveDialogModel => ({ mode: 'edit', draft: { name: 'Curva moto uomo', scaleId: SCALE.id, companyId: '', shares: { '50': '25', '52': '45', '54': '30' } }, scales: SCALES, companies: COMPANIES, archived: false, mayKeep: true, saving: false, problem: null, ...extra })
const model = (extra: Partial<CurvesModel> = {}): CurvesModel => ({ curves: { status: 'ready', value: ALL }, scaleId: SCALE.id, status: 'ACTIVE', selected: [], mayKeep: true, busy: false, notice: null, dialog: null, ...extra })

export const designScreen = defineDesignScreen<CurvesModel>({
  screen: 'SCR-235-curves',
  title: 'Sales settings › Size curves (B-W2b-316)',
  view: CurvesView,
  cases: [
    { id: 'list', label: 'Sales · Size curves of a scale (% per size)', model: model(), note: 'One scale at a time; the % per size as DS SizeColumns; the total.' },
    { id: 'all', label: 'All, the archived one included', model: model({ status: 'ALL' }) },
    { id: 'selected', label: 'Two selected: Archive 2', model: model({ selected: CURVES.map((curve) => curve.id) }) },
    { id: 'no-right', label: 'A role without the right: New and Archive held', model: model({ mayKeep: false, selected: [CURVES[0]!.id] }) },
    { id: 'empty', label: 'No size curve yet', model: model({ curves: { status: 'ready', value: [] } }) },
    { id: 'loading', label: 'Loading', model: model({ curves: { status: 'loading' } }) },
    { id: 'error', label: 'The curves could not be read', model: model({ curves: { status: 'error', problem: 'problem.read.unavailable' } }) },
    { id: 'dialog-100', label: 'A curve at exactly 100 %: Save ready', model: model({ dialog: dialog({}) }) },
    { id: 'dialog-under', label: 'A new curve at 90 %: Save held', model: model({ dialog: dialog({ mode: 'new', draft: { name: 'Curva donna', scaleId: SCALE.id, companyId: DEMO_COMPANIES[0].id, shares: { '48': '30', '50': '40', '52': '20' } } }) }), note: 'The total is shown live; Save waits until it is exactly 100 %, with the reason.' },
    { id: 'dialog-bad', label: 'A share that is not a number', model: model({ dialog: dialog({ draft: { name: 'Curva moto uomo', scaleId: SCALE.id, companyId: '', shares: { '50': '25', '52': '4x', '54': '30' } } }) }) },
    { id: 'dialog-archived', label: 'An archived curve: read only', model: model({ status: 'ALL', dialog: dialog({ archived: true }) }) },
    { id: 'done', label: 'Saved (receipt)', model: model({ notice: { words: { key: 'curve.done.saved', params: { name: 'Curva moto uomo' } }, tone: 'success' } }) },
  ],
})
