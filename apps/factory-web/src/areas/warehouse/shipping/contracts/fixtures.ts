import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { STEP_UP_SHUT } from '../test-mode/settings-card'
import type { Contract } from './api'
import type { ContractsModel } from './model'
import { ContractsView } from './view/ContractsView'

/**
 * SCR-659 — Carriers & shipping › Our own carrier contracts (B-W2b-412 on B-W2b-400; design warehouse.shipping sec sp-carrier
 * "W2b own carrier contracts (LOG-033)"). Made-up data only (carriers "Demo Express", "Corriere Esempio"; numbers never shown).
 */

const uid = (n: number) => `0190f0e2-7422-7000-8000-${String(n).padStart(12, '0')}`

const contract = (n: number, over: Partial<Contract> = {}): Contract => ({ id: uid(n), companyId: uid(9), siteId: null, siteCode: null, carrierCode: 'demo-express', carrierName: 'Demo Express', ownRatesOnly: true, active: true, numberOnFile: true, usedForSite: true, version: 2, createdAt: '2026-11-10T09:00:00.000Z', updatedAt: '2026-11-12T09:00:00.000Z', ...over })

const ROWS = [contract(1), contract(2, { siteId: uid(1), siteCode: 'A1', carrierCode: 'esempio', carrierName: 'Corriere Esempio', ownRatesOnly: false }), contract(3, { carrierCode: 'old-carrier', carrierName: 'Corriere Demo Vecchio', active: false, numberOnFile: false, usedForSite: false })]

const model = (rows: readonly Contract[] | null, over: Partial<ContractsModel> = {}): ContractsModel => ({ contracts: rows ? { state: 'ready', value: rows } : { state: 'loading' }, siteId: uid(1), siteCode: 'A1', can: { settingsManage: true }, dialog: null, busy: false, problem: null, done: null, stepUp: STEP_UP_SHUT, ...over })

export const designScreen = defineDesignScreen<ContractsModel>({
  screen: 'SCR-659',
  title: 'Carriers & shipping › Our own carrier contracts: add, use only our rates, replace the number, switch off',
  view: ContractsView,
  cases: [
    { id: 'list', label: 'The company\'s contracts: every site, A1 only, one switched off; which one A1 buys on', model: model(ROWS) },
    { id: 'add', label: 'Add a contract: carrier, number (sealed, never shown), this site or every site, use only our rates', model: model(ROWS, { dialog: { kind: 'add', carrierCode: 'demo-express', everySite: false, accountNumber: 'DEMO-4321', ownRatesOnly: true } }) },
    { id: 'step-up', label: 'The fresh code asked before the number is sealed', model: model(ROWS, { dialog: { kind: 'add', carrierCode: 'demo-express', everySite: false, accountNumber: 'DEMO-4321', ownRatesOnly: true }, busy: true, stepUp: { open: true, busy: false, sentence: 'contracts.stepUp', problem: null } }) },
    { id: 'added', label: 'Saved: ends in 4321', model: model(ROWS, { done: { key: 'contracts.done.added', params: { carrier: 'Demo Express', end: '4321' } } }) },
    { id: 'live-exists', label: 'Refused: a live contract covers the same scope', model: model(ROWS, { dialog: { kind: 'add', carrierCode: 'demo-express', everySite: true, accountNumber: 'DEMO-9999', ownRatesOnly: false }, problem: { key: 'contracts.refusal.LIVE_EXISTS' } }) },
    { id: 'replace', label: 'Replace the number', model: model(ROWS, { dialog: { kind: 'number', contractId: uid(1), accountNumber: '' } }) },
    { id: 'off', label: 'Switch off: the number removed, the row kept', model: model(ROWS, { dialog: { kind: 'off', contractId: uid(2) } }) },
    { id: 'none', label: 'No contract: labels go at the aggregator\'s rates', model: model([]) },
    { id: 'read-only', label: 'Without shipping.settings.manage: Add held with why', model: model(ROWS, { can: { settingsManage: false } }) },
    { id: 'loading', label: 'Reading', model: model(null) },
    { id: 'error', label: 'Could not be read: Try again', model: model(null, { contracts: { state: 'error', problem: { key: 'problem.read.unavailable' } } }) },
  ],
})
