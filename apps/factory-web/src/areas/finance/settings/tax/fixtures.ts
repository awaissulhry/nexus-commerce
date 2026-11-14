import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, type Role } from '../../_demo/fixtures'
import { DEMO, NOW_DAY, permissionsOf } from '../../invoices/test-mode/demo/fixtures'
import { designScreen as settingsScreen } from '../fixtures'
import { FinanceSettingsView } from '../view/FinanceSettingsView'
import type { CompanyTax, TaxCode, TaxCodes } from './api'
import { codeDraftOf, taxSetUpAbilitiesOf, type CodeDraft } from './model'
import { TaxSetUpCard, type TaxSetUpModel } from './view/TaxSetUpCard'

/**
 * SCR-446 — Finance settings › Tax set-up (design finance.settings sec:company "Per company (W2b tax configuration: rates,
 * reason codes, effective dates)"; B-W2b-417 on B-W2b-392's and B-W2b-401's API; FIN-107; GATE-ACCOUNTANT), made-up data
 * only: the accountant's four switches (stamp duty on, the rest waiting), the codes — 22 % in force and confirmed, 10 %
 * planned, N3.5 in force waiting for the accountant, an ended 22 % —, a new code, the next version from a later day, a form
 * with problems, the label and the end, the accountant's confirmation (held until ticked), archive, a switch turned on (the
 * accountant's word), a refusal, the states and the roles: Finance (everything), Sales (read only, every verb held with
 * why). Every code, law and account key is an example.
 */

const uid = (n: number) => `0190f0e2-7474-7000-8000-${String(n).padStart(12, '0')}`
const ALL = { edit: false, relabel: true, end: true, newVersion: true, archive: true, delete: false, confirm: false }

const code = (n: number, over: Partial<TaxCode>): TaxCode => ({ id: uid(n), version: 1, companyId: DEMO.id, country: 'IT', code: '22', label: 'Aliquota ordinaria', ratePct: '22.00', natura: null, legalRef: null, accountCodeKey: 'IVA22', ruleId: null, verification: 'VERIFIED', confirmedAt: '2026-01-10T09:00:00.000Z', validFrom: '2026-01-01', validTo: null, status: 'ACTIVE', state: 'IN_FORCE', can: ALL, ...over })

const CODES: TaxCode[] = [
  code(1, { ruleId: 'IT_DOMESTIC_SUPPLY' }),
  code(2, { code: 'N3.5', label: "Non imponibile con dichiarazione d'intento", ratePct: '0.00', natura: 'N3.5', legalRef: 'Art. 8 c.1 lett. c) DPR 633/1972', accountCodeKey: 'IVA-NI8C', ruleId: null, verification: 'UNVERIFIED', confirmedAt: null, can: { ...ALL, confirm: true } }),
  code(3, { code: '10', label: 'Aliquota ridotta', ratePct: '10.00', accountCodeKey: 'IVA10', verification: 'UNVERIFIED', confirmedAt: null, validFrom: '2027-01-01', state: 'PLANNED', can: { edit: true, relabel: true, end: false, newVersion: true, archive: true, delete: true, confirm: true } }),
  code(4, { code: '22', label: 'Aliquota ordinaria (fino al 2025)', validFrom: '2020-01-01', validTo: '2025-12-31', state: 'ENDED', can: { edit: false, relabel: false, end: false, newVersion: false, archive: true, delete: false, confirm: false } }),
]

const COMPANY: CompanyTax = { companyId: DEMO.id, code: DEMO.code, legalName: DEMO.name, version: 4, switches: { taxCodesOn: false, stampDutyOn: true, declarationsOfIntentOn: false }, selfInvoicesOn: false }
const LIST: TaxCodes = { companyId: DEMO.id, today: NOW_DAY, switches: COMPANY.switches, codes: CODES, rules: [
    { id: 'IT_DOMESTIC_SUPPLY', law: 'Art. 16 DPR 633/1972', catalogueStatus: 'VERIFIED', status: 'VERIFIED', taxCodeIds: [uid(1)] },
    { id: 'STAMP_DUTY', law: 'Art. 15 DPR 633/1972', catalogueStatus: 'UNVERIFIED', status: 'UNVERIFIED', taxCodeIds: [] },
  ] }

interface TaxCase {
  role: Role
  card: TaxSetUpModel
  inPage?: boolean
}

const base = (role: Role, over: Partial<TaxSetUpModel> = {}, inPage = false): TaxCase => ({
  role,
  inPage,
  card: { can: taxSetUpAbilitiesOf(permissionsOf(role)), today: NOW_DAY, company: { value: COMPANY, problem: null }, codes: { value: LIST, problem: null }, rows: 'current', dialog: null, draft: codeDraftOf('new', null, NOW_DAY), ticked: false, busy: false, problem: null, notice: null, ...over },
})

const draft = (over: Partial<CodeDraft>): CodeDraft => ({ ...codeDraftOf('new', null, NOW_DAY), ...over })

function TaxDesign({ model }: { model: TaxCase }) {
  const card = createElement(TaxSetUpCard, { model: model.card })
  if (!model.inPage) return inShell('/finance/settings', card, model.role)
  const page = settingsScreen.cases.find((item) => item.id === 'finance')!.model.settings
  return inShell('/finance/settings', createElement(FinanceSettingsView, { model: page, depth: { tax: card } }), model.role)
}

export const designScreen = defineDesignScreen<TaxCase>({
  screen: 'SCR-446',
  title: 'Finance settings › Tax set-up: the accountant’s switches, tax codes as data with the days in force, versions and confirmations',
  view: TaxDesign,
  cases: [
    { id: 'finance', label: 'Finance · Stamp duty on, three switches waiting; codes in force and planned', model: base('finance') },
    { id: 'in-page', label: 'Finance · The card in its place on Finance settings', model: base('finance', {}, true) },
    { id: 'all-rows', label: 'Finance · Every version, the ended one too', model: base('finance', { rows: 'all' }) },
    { id: 'selected', label: 'Finance · Two codes chosen: Confirm 2 and Archive 2', model: base('finance', { selected: [uid(2), uid(3)] }) },
    { id: 'new', label: 'Finance · New code: N3.1 export, its law', model: base('finance', { dialog: { kind: 'form', mode: 'new', code: null }, draft: draft({ code: 'N3.1', label: 'Esportazione', ratePct: '0', natura: 'N3.1', legalRef: 'Art. 8 c.1 lett. a) DPR 633/1972', accountCodeKey: 'IVA-NI8A' }) }) },
    { id: 'new-problems', label: 'Finance · New code: a rate of 0 without its reason and law (held with why)', model: base('finance', { dialog: { kind: 'form', mode: 'new', code: null }, draft: draft({ code: 'ESE', label: 'Esente', ratePct: '0' }) }) },
    { id: 'version', label: 'Finance · New version of 22 % from a later day (a code in force is never edited)', model: base('finance', { dialog: { kind: 'form', mode: 'version', code: CODES[0]! }, draft: codeDraftOf('version', CODES[0]!, NOW_DAY) }) },
    { id: 'relabel', label: 'Finance · Change the label of a code in force', model: base('finance', { dialog: { kind: 'form', mode: 'relabel', code: CODES[0]! }, draft: codeDraftOf('relabel', CODES[0]!, NOW_DAY) }) },
    { id: 'end', label: 'Finance · End N3.5: the last day', model: base('finance', { dialog: { kind: 'form', mode: 'end', code: CODES[1]! }, draft: { ...codeDraftOf('end', CODES[1]!, NOW_DAY), validTo: '2026-12-31' } }) },
    { id: 'confirm', label: 'Finance · The accountant’s confirmation of N3.5: held until ticked (a fresh code next)', model: base('finance', { dialog: { kind: 'verb', verb: 'confirm', codes: [CODES[1]!] } }) },
    { id: 'archive', label: 'Finance · Archive the ended 22 %', model: base('finance', { dialog: { kind: 'verb', verb: 'archive', codes: [CODES[3]!] } }) },
    { id: 'switch-on', label: 'Finance · Switch on the tax codes: the accountant’s word ticked', model: base('finance', { dialog: { kind: 'switch', name: 'taxCodesOn', on: true }, ticked: true }) },
    { id: 'switch-off', label: 'Finance · Switch off stamp duty', model: base('finance', { dialog: { kind: 'switch', name: 'stampDutyOn', on: false } }) },
    { id: 'refused', label: 'Finance · Refused: a code in force is never edited (said in the dialog)', model: base('finance', { dialog: { kind: 'form', mode: 'edit', code: CODES[2]! }, draft: codeDraftOf('edit', CODES[2]!, NOW_DAY), problem: { key: 'finance-invoices-depth:refusal.IN_FORCE', reload: false } }) },
    { id: 'saved', label: 'Finance · Saved (notice)', model: base('finance', { notice: { tone: 'success', words: { key: 'tax.switched.stampDutyOn.on' } } }) },
    { id: 'sales', label: 'Sales · Read only: New code, the switches and every verb held with why', model: base('sales') },
    { id: 'empty', label: 'No tax codes yet', model: base('finance', { codes: { value: { ...LIST, codes: [], rules: [] }, problem: null } }) },
    { id: 'loading', label: 'Loading', model: base('finance', { company: { value: null, problem: null }, codes: { value: null, problem: null } }) },
    { id: 'error', label: 'The read failed (in words, Try again)', model: base('finance', { company: { value: null, problem: 'problem.read.unavailable' }, codes: { value: null, problem: 'problem.read.unavailable' } }) },
  ],
})
