import { createElement } from 'react'
import { DEMO_COMPANIES } from '../../../../shell/design-data'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { base, inShell, WORKER_SITE, type Role } from '../fixtures'
import type { FloorRulesModel } from '../view/FloorRulesView'
import { FloorRulesView } from '../view/FloorRulesView'
import { OffStandardView, type OffStandardModel } from '../view/OffStandardView'
import type { OffCode } from '../w2b-api'
import { markKey } from '../w2b-model'

/**
 * Design cases of Floor rules & codes › Off-standard codes (B-W2b-58; design production.settings fr-offstd, MES-155; a
 * section of SCR-074, reviewed as SCR-074-offstd): the company's codes for time not on standard work with their pay rule
 * (the CCNL reading said on the page as NOT verified), saved per cell. Made-up codes and words only. Roles from
 * factory-domain's templates: the production manager keeps them (production.offstandard.codes), the floor supervisor
 * looks (production.offstandard.view).
 */

const uid = (n: number) => `0190f0e2-4242-7000-8000-${String(n).padStart(12, '0')}`
const code = (n: number, over: Partial<OffCode> & Pick<OffCode, 'code' | 'labelIt' | 'labelEn'>): OffCode => ({
  id: uid(n),
  companyId: DEMO_COMPANIES[0].id,
  kind: 'OFF_STANDARD',
  payRule: 'AVERAGE',
  needsApproval: false,
  labelI18n: {},
  icon: null,
  colour: null,
  sortOrder: n * 10,
  active: true,
  usedCount: 0,
  callTypes: [],
  version: 1,
  ...over,
})
export const CODES: OffCode[] = [
  code(1, { code: 'WAIT_HELP', labelIt: 'Attesa aiuto', labelEn: 'Waiting for help', labelI18n: { ro: 'Așteptare ajutor' }, usedCount: 41, callTypes: ['MATERIAL_SHORT', 'MACHINE_STOP'] }),
  code(2, { code: 'WAIT_MATERIAL', labelIt: 'Attesa materiale', labelEn: 'Waiting for material', needsApproval: true, usedCount: 18 }),
  code(3, { code: 'CLEANING', labelIt: 'Pulizia', labelEn: 'Cleaning', kind: 'INDIRECT', payRule: 'BASE', usedCount: 9 }),
  code(4, { code: 'TRAINING', labelIt: 'Formazione', labelEn: 'Training', kind: 'INDIRECT', payRule: 'BASE', needsApproval: true, usedCount: 3 }),
  code(5, { code: 'PERSONAL', labelIt: 'Motivi personali', labelEn: 'Personal time', payRule: 'UNPAID', needsApproval: true, active: false, usedCount: 2 }),
]

interface OffCase {
  role: Role
  page: FloorRulesModel
  editor: OffStandardModel
}

function editor(over: Partial<OffStandardModel> = {}): OffStandardModel {
  return { load: { status: 'ready' }, codes: CODES, languages: ['ro'], canManage: true, marks: {}, notice: null, busy: false, dialog: null, changedElsewhere: false, ...over }
}
const offCase = (role: Role, over: Partial<OffStandardModel> = {}, page: Partial<FloorRulesModel> = {}): OffCase => ({ role, page: base(role, WORKER_SITE, page, 'offstd').model, editor: editor(over) })

function OffDesign({ model }: { model: OffCase }) {
  return inShell(createElement(FloorRulesView, { model: model.page, offstd: createElement(OffStandardView, { model: model.editor }) }), model.role)
}

export const designScreen = defineDesignScreen<OffCase>({
  screen: 'SCR-074-offstd',
  title: 'Off-standard codes (Production › Settings › Floor rules & codes)',
  view: OffDesign,
  cases: [
    { id: 'codes', label: 'Production manager: codes with words per language, pay rule, team leader approves, active, used', model: offCase('production'), note: 'PERSONAL is inactive (never deleted); WAIT_HELP is where two help-call types book their waiting.' },
    { id: 'saving', label: 'Saved per cell: saving, saved, refused with its reason (a code a help-call type books to)', model: offCase('production', { marks: { [markKey(uid(2), 'payRule')]: { state: 'saving' }, [markKey(uid(1), 'active')]: { state: 'refused', problem: 'fr.refusal.BOOKED_BY_CALLS' }, [markKey(uid(3), 'labelEn')]: { state: 'unknown', problem: 'fr.problem.offline' } } }) },
    { id: 'selected', label: 'Rows selected: Set 2 inactive · Set 2 active', model: offCase('production', { selected: [uid(3), uid(5)] }) },
    { id: 'new', label: 'New code: code, kind, words, pay rule, team leader approves', model: offCase('production', { dialog: { kind: 'new', draft: { code: 'MEETING', kind: 'INDIRECT', payRule: 'BASE', needsApproval: true, labelIt: 'Riunione', labelEn: 'Meeting' }, problem: null } }) },
    { id: 'new-taken', label: 'New code: a code taken already (held, in words)', model: offCase('production', { dialog: { kind: 'new', draft: { code: 'CLEANING', kind: 'INDIRECT', payRule: 'BASE', needsApproval: false, labelIt: 'Pulizia', labelEn: 'Cleaning' }, problem: null } }) },
    { id: 'added', label: 'Added: MEETING', model: offCase('production', { notice: { tone: 'success', key: 'fr.off.new.done', params: { code: 'MEETING' } } }) },
    { id: 'changed-elsewhere', label: 'Changed by someone else: Reload', model: offCase('production', { changedElsewhere: true }) },
    { id: 'supervisor', label: 'Floor supervisor: looks, changes nothing (held with why)', model: offCase('supervisor', { canManage: false }) },
    { id: 'empty', label: 'No code yet: Add the first code', model: offCase('production', { codes: [] }) },
    { id: 'keys', label: 'The keys (the footer’s information icon)', model: offCase('production', { dialog: { kind: 'keys' } }) },
    { id: 'loading', label: 'Loading', model: offCase('production', { load: { status: 'loading' }, codes: null }) },
    { id: 'error', label: 'The read failed: in words, Try again', model: offCase('production', { load: { status: 'error', problem: 'fr.problem.offline' }, codes: null }) },
    { id: 'no-access', label: 'A role without production.offstandard.view: the tab says so', model: offCase('supervisor', {}, { can: { view: true, manage: false, reasons: true, privacy: false, offstd: false, offstdManage: false, calls: true, callsManage: false, people: false, cost: false } }) },
  ],
})
