import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { base, inShell, WORKER_SITE, type Role } from '../fixtures'
import { FloorRulesView } from '../view/FloorRulesView'
import type { CuttingRules, LeatherTolerance } from './api'
import { CuttingRulesView, type CuttingModel } from './CuttingRulesView'

/**
 * Design cases of SCR-275, the Cutting card of Production › Settings › Floor rules & codes (B-W2b-219): the site's shade rule,
 * the photo of the hide before cutting, the smallest remnant kept, and beside it the leather area tolerance of the site's
 * company. Made-up data: the invented company and site "STAB-N" of SCR-074's cases (../fixtures.ts), invented percents. Roles
 * from factory-domain's templates through SCR-074's: the owner and the production manager (change the rules), the floor
 * supervisor (reads them), the warehouse (no production.settings.view: the page's no-access state). No person is named.
 */

const at = (day: number, hour = 9, minute = 0) => new Date(Date.UTC(2026, 10, day, hour, minute)).toISOString()
const SITE = { id: WORKER_SITE.site.id, companyId: WORKER_SITE.site.companyId, code: WORKER_SITE.site.code, name: WORKER_SITE.site.name }

const rules = (over: Partial<CuttingRules['rules']> = {}, row: Partial<Omit<CuttingRules, 'rules'>> = {}): CuttingRules => ({
  site: SITE,
  rules: { shadeRule: 'ORDER', hidePhotoRequired: false, minimumRemnant: { area: '10.0000', uom: 'DM2' }, ...over },
  isDefault: false,
  version: 3,
  updatedAt: at(5, 10, 12),
  canManage: true,
  ...row,
})
const DEFAULTS = rules({}, { isDefault: true, version: null, updatedAt: null })
const SET = rules({ shadeRule: 'GARMENT', hidePhotoRequired: true, minimumRemnant: { area: '0.2500', uom: 'M2' } })

const tolerance = (over: Partial<LeatherTolerance> = {}): LeatherTolerance => ({ companyId: SITE.companyId, percent: '2.00', from: 'DEFAULT', company: null, tenant: null, mayChange: true, ...over })
const TENANT = tolerance({ percent: '2.50', from: 'TENANT', tenant: { id: '0190f0e2-3333-7000-8000-000000000001', percent: '2.50', version: 2, updatedAt: at(3) } })
const OWN = tolerance({ percent: '3.50', from: 'COMPANY', company: { id: SITE.companyId, percent: '3.50', version: 4, updatedAt: at(4) }, tenant: TENANT.tenant })

const model = (over: Partial<CuttingModel> = {}): CuttingModel => ({
  rules: { value: SET, problem: null },
  tolerance: { value: OWN, problem: null },
  canManage: true,
  version: 3,
  busy: null,
  notice: null,
  timeZone: 'Europe/Rome',
  ...over,
})

interface Case {
  readonly role: Role
  readonly cutting: CuttingModel
}

function CuttingDesign({ model: { role, cutting } }: { model: Case }) {
  const page = base(role).model
  return inShell(createElement(FloorRulesView, { model: page, cutting: page.can.view ? createElement(CuttingRulesView, { model: cutting }) : null }), role)
}

const draft = (over: Partial<NonNullable<CuttingModel['draft']>> = {}): NonNullable<CuttingModel['draft']> => ({ shadeRule: 'GARMENT', hidePhotoRequired: true, minimumArea: '0.25', minimumUom: 'M2', reason: '', ...over })

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-275',
  title: 'Floor rules & codes › Cutting (shade rule, photo, smallest remnant, leather area tolerance)',
  view: CuttingDesign,
  cases: [
    { id: 'owner-set', label: 'Owner: one shade lot per garment, photo asked, 0.25 m²; the company keeps 3.5 %', model: { role: 'owner', cutting: model() }, note: 'Change a value: the EditModeBar appears; ⌘S applies.' },
    { id: 'defaults', label: 'A site without floor rules: the defaults (one shade lot per order, photo optional, 10 dm²); 2 % default', model: { role: 'owner', cutting: model({ rules: { value: DEFAULTS, problem: null }, tolerance: { value: tolerance(), problem: null }, version: null }) } },
    { id: 'editing', label: 'Editing: shade rule OFF, photo off, a reason typed — Apply (2 changes)', model: { role: 'production', cutting: model({ tolerance: null, draft: draft({ shadeRule: 'OFF', hidePhotoRequired: false, reason: 'Collezione monocolore: nessun controllo di tonalità.' }) }) } },
    { id: 'held-too-large', label: 'Held: the smallest remnant 20 m² is above 10 m² (in words)', model: { role: 'production', cutting: model({ tolerance: null, draft: draft({ minimumArea: '20' }) }) } },
    { id: 'held-empty', label: 'Held: the smallest remnant left empty', model: { role: 'production', cutting: model({ tolerance: null, draft: draft({ minimumArea: '' }) }) } },
    { id: 'saving', label: 'Saving: Apply held while the change is sent', model: { role: 'production', cutting: model({ tolerance: null, busy: 'rules', draft: draft({ shadeRule: 'ORDER' }) }) } },
    { id: 'saved', label: 'Saved: "the cutting rules apply from now on"', model: { role: 'production', cutting: model({ tolerance: null, notice: { tone: 'success', key: 'cr.done' } }) } },
    { id: 'conflict', label: 'Refused: changed by someone else meanwhile (the page says Reload)', model: { role: 'production', cutting: model({ tolerance: null, notice: { tone: 'danger', key: 'cr.problem.changed' } }) } },
    { id: 'tolerance-follows', label: 'Leather area tolerance: the company follows every company’s 2.5 %', model: { role: 'owner', cutting: model({ tolerance: { value: TENANT, problem: null } }) } },
    { id: 'tolerance-edit', label: 'Leather area tolerance: 3.5 % → 4 % (Save)', model: { role: 'owner', cutting: model({ toleranceDraft: { own: true, percent: '4' } }) } },
    { id: 'tolerance-held', label: 'Leather area tolerance held: 120 % is not a percent of 0–100', model: { role: 'owner', cutting: model({ toleranceDraft: { own: true, percent: '120' } }) } },
    { id: 'supervisor', label: 'Floor supervisor: reads the rules, changes nothing; no purchasing settings', model: { role: 'supervisor', cutting: model({ canManage: false, rules: { value: { ...SET, canManage: false }, problem: null }, tolerance: null }) } },
    { id: 'tolerance-view-only', label: 'Purchasing read-only: the tolerance as text', model: { role: 'owner', cutting: model({ tolerance: { value: { ...OWN, mayChange: false }, problem: null } }) } },
    { id: 'loading', label: 'Loading', model: { role: 'owner', cutting: model({ rules: { value: null, problem: null }, tolerance: { value: null, problem: null } }) } },
    { id: 'error', label: 'Error: the rules could not be read; offline for the tolerance (Try again)', model: { role: 'owner', cutting: model({ rules: { value: null, problem: 'cr.problem.read' }, tolerance: { value: null, problem: 'cr.problem.offline' } }) } },
    { id: 'no-permission', label: 'Warehouse: no production.settings.view — the page says so, no card', model: { role: 'warehouse', cutting: model() } },
  ],
})
