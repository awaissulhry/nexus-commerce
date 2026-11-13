import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { MarginFloors } from './api'
import { FloorsView, type FloorsModel } from './view/FloorsView'

/**
 * SCR-235-floors — Sales settings › Quote approval rules › Margin floor % per role (design sales.settings, SAL-189;
 * B-W2b-343 on B-W2b-330's API), made-up data only: invented office roles of an invented company. Each case is one state:
 * the floors in force (the company's, the group's, none), the edit with a floor lowered (it asks a fresh code), the
 * step-up, a scope without its own settings, a role without the right or the margin grain, loading and an error.
 */

const ROLES = [
  { key: 'owner', name: 'Titolare' },
  { key: 'sales', name: 'Vendite' },
  { key: 'sales_lead', name: 'Responsabile vendite' },
  { key: 'finance', name: 'Amministrazione' },
]
const row = (companyId: string | null, floors: Record<string, string> | null) => ({ id: companyId ? '0190f0e2-2350-7000-8000-000000000002' : '0190f0e2-2350-7000-8000-000000000001', companyId, floors, version: 3, updatedAt: '2026-11-10T09:00:00.000Z' })
const COMPANY_ID = '0190f0e2-1111-7000-8000-000000000001'
const FLOORS: MarginFloors = {
  tenant: row(null, { sales: '25', owner: '10' }),
  company: row(COMPANY_ID, { sales: '25', sales_lead: '18', owner: '10' }),
  inForce: { floors: { sales: '25', sales_lead: '18', owner: '10' }, from: 'COMPANY', companyFloorPct: '20' },
  roles: ROLES,
}

const model = (extra: Partial<FloorsModel> = {}): FloorsModel => ({
  scope: 'company',
  companyCode: 'DEMO',
  floors: { status: 'ready', value: FLOORS },
  margin: true,
  manage: true,
  edit: null,
  saving: false,
  problem: null,
  notice: null,
  stepUp: { open: false, busy: false, problem: null },
  ...extra,
})

export const designScreen = defineDesignScreen<FloorsModel>({
  screen: 'SCR-235-floors',
  title: 'Sales settings › Margin floor % per role (B-W2b-343)',
  view: FloorsView,
  cases: [
    { id: 'company', label: 'Owner · this company\'s floors per role', model: model(), note: 'A version is held to the lowest floor of its maker\'s roles; a role without one keeps the company floor.' },
    { id: 'group', label: 'The group\'s floors (scope: group)', model: model({ scope: 'group', floors: { status: 'ready', value: { ...FLOORS, company: null, inForce: { floors: FLOORS.tenant!.floors, from: 'TENANT', companyFloorPct: '20' } } } }) },
    { id: 'none', label: 'No role has its own floor: every role keeps the company floor', model: model({ floors: { status: 'ready', value: { ...FLOORS, tenant: row(null, null), company: row(COMPANY_ID, null), inForce: { floors: null, from: null, companyFloorPct: '20' } } } }) },
    { id: 'edit', label: 'Editing: Vendite raised to 28 %', model: model({ edit: { owner: '10', sales: '28', sales_lead: '18', finance: '' } }) },
    { id: 'edit-lower', label: 'Editing: a floor lowered (saving asks a fresh code)', model: model({ edit: { owner: '10', sales: '22', sales_lead: '18', finance: '' } }) },
    { id: 'edit-bad', label: 'Editing: a floor that is not a percent (Save held)', model: model({ edit: { owner: '10', sales: '120', sales_lead: '18', finance: '' } }) },
    { id: 'step-up', label: 'The step-up: confirm it\'s you', model: model({ edit: { owner: '10', sales: '22', sales_lead: '18', finance: '' }, saving: true, stepUp: { open: true, busy: false, problem: null } }) },
    { id: 'step-up-wrong', label: 'The step-up: a wrong code', model: model({ edit: { owner: '10', sales: '22', sales_lead: '18', finance: '' }, saving: true, stepUp: { open: true, busy: false, problem: 'stepUp.problem.wrong' } }) },
    { id: 'done', label: 'Saved (receipt)', model: model({ notice: { tone: 'success', words: { key: 'floors.done' } } }) },
    { id: 'no-row', label: 'A company that follows the group: Change held with the reason', model: model({ floors: { status: 'ready', value: { ...FLOORS, company: null, inForce: { floors: FLOORS.tenant!.floors, from: 'TENANT', companyFloorPct: '20' } } } }) },
    { id: 'no-right', label: 'A role without sales.settings.manage: read only', model: model({ manage: false }) },
    { id: 'no-margin', label: 'A role without the margin grain: the reason only', model: model({ margin: false }) },
    { id: 'loading', label: 'Loading', model: model({ floors: { status: 'loading' } }) },
    { id: 'error', label: "The floors couldn't be read", model: model({ floors: { status: 'error', problem: { key: 'problem.read.unavailable' } } }) },
  ],
})
