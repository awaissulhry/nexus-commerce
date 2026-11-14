import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import type { CalcView, OverheadRuleView, PrefillView } from './api'
import { cpmAbilitiesOf } from './model'
import { CalculatorCard, type CalculatorModel } from './view/CalculatorCard'

/**
 * SCR-506 — Finance › Settings › Costing: cost per minute and overhead (B-W2b-430), made-up data only: the invented sewing
 * department's October (payroll total 96,000.00 over 182,400 minutes = 0.526316 + overhead 0.05 = 0.576316 a minute) and
 * cutting's; two overhead rules. Never a headcount or one person's figure.
 */

const as = <T,>(value: unknown): T => value as T
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const owner = cpmAbilitiesOf(['costing.view', 'costing.rates.manage', 'money.cost'])
const reader = cpmAbilitiesOf(['costing.view', 'money.cost'])
const noGrain = cpmAbilitiesOf(['costing.view', 'costing.rates.manage'])
const TODAY = '2026-11-14'

const calc = (n: number, kind: string, cpm: string, minutes: string, applied: boolean, centre = false): CalcView =>
  as<CalcView>({
    id: uid('8900', n),
    companyId: uid('1111', 1),
    workCentreKind: kind,
    workCentre: centre ? { id: uid('2200', 1), siteId: uid('2100', 1), code: 'WC-CUC-A', name: 'Linea cucitura A' } : null,
    key: 'x',
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    currency: 'EUR',
    directLabourCost: '96000.000000',
    availableMinutes: minutes,
    indirectPerMinute: '0.000000',
    overheadPerMinute: '0.050000',
    costPerMinute: cpm,
    minutesBasis: null,
    note: null,
    labourRateId: applied ? uid('8910', n) : null,
    appliedAt: applied ? '2026-11-03T10:00:00.000Z' : null,
    appliedById: applied ? uid('3300', 1) : null,
    words: 'x',
    version: 1,
    createdAt: '2026-11-02T09:00:00.000Z',
    updatedAt: '2026-11-02T09:00:00.000Z',
  })
const CALCS = [calc(1, 'SEWING', '0.576316', '182400', true), calc(2, 'CUTTING', '0.612000', '57600', false), calc(3, 'SEWING', '0.598000', '91200', false, true)]
const RULES = as<OverheadRuleView[]>([
  { id: uid('8920', 1), companyId: null, key: 'x', basis: 'PERCENT_OF_LABOUR', workCentreKind: null, value: '25', currency: null, periodStart: '2026-01-01', periodEnd: null, status: 'ACTIVE', note: null, inForce: true, version: 1, createdAt: '2026-01-02T09:00:00.000Z', updatedAt: '2026-01-02T09:00:00.000Z' },
  { id: uid('8920', 2), companyId: uid('1111', 1), key: 'x', basis: 'PER_MINUTE', workCentreKind: 'SEWING', value: '0.050000', currency: 'EUR', periodStart: '2026-07-01', periodEnd: '2026-12-31', status: 'ACTIVE', note: null, inForce: true, version: 1, createdAt: '2026-06-20T09:00:00.000Z', updatedAt: '2026-06-20T09:00:00.000Z' },
])
const PREFILL = as<PrefillView>({
  companyId: uid('1111', 1),
  workCentreKind: 'SEWING',
  periodStart: '2026-10-01',
  periodEnd: '2026-10-31',
  currency: 'EUR',
  availableMinutes: '182400',
  workCentres: [
    { id: uid('2200', 1), siteId: uid('2100', 1), code: 'WC-CUC-A', name: 'Linea cucitura A', workingDays: 22, availableMinutes: '91200', seatsFrom: 'CAPACITY', calendarIds: [uid('2300', 1)] },
    { id: uid('2200', 2), siteId: uid('2100', 1), code: 'WC-CUC-B', name: 'Linea cucitura B', workingDays: 22, availableMinutes: '91200', seatsFrom: 'STATIONS', calendarIds: [] },
  ],
  minutesBasis: { from: 'calendars' },
  overheadRules: [{ id: uid('8920', 2), companyId: uid('1111', 1), basis: 'PER_MINUTE', workCentreKind: 'SEWING', value: '0.050000', currency: 'EUR' }],
  overheadPerMinuteFromRules: '0.050000',
  words: [],
})

const model = (overrides: Partial<CalculatorModel> = {}): CalculatorModel => ({
  can: owner,
  today: TODAY,
  currency: 'EUR',
  calcs: { status: 'ready', value: CALCS },
  rules: { status: 'ready', value: RULES },
  dialog: null,
  prefill: null,
  busy: false,
  problem: null,
  notice: null,
  ...overrides,
})

export const designScreen = defineDesignScreen<CalculatorModel>({
  screen: 'SCR-506',
  title: 'Finance › Settings › Costing: cost per minute and overhead',
  view: CalculatorCard,
  cases: [
    { id: 'normal', label: 'Three calculations and two overhead rules', model: model(), note: 'Apply makes the department\'s labour rate from a day; an applied one is held with why.' },
    { id: 'new', label: 'New calculation: the minutes read', model: model({ dialog: { kind: 'new' }, prefill: { status: 'ready', value: PREFILL }, draft: { fromMonth: '2026-10', toMonth: '2026-10', directLabourCost: '96000', availableMinutes: '182400' } }), note: 'Minutes from the calendars × the planned seats; the seats themselves are never shown.' },
    { id: 'new-twice', label: 'Overhead in the rate and in the rules', model: model({ dialog: { kind: 'new' }, prefill: { status: 'ready', value: PREFILL }, draft: { fromMonth: '2026-10', toMonth: '2026-10', directLabourCost: '96000', availableMinutes: '182400', overheadPerMinute: '0,05' } }) },
    { id: 'new-one-seat', label: 'Refused: a department of one seat', model: model({ dialog: { kind: 'new' }, prefill: { status: 'ready', value: PREFILL }, draft: { workCentreKind: 'INSPECTION', fromMonth: '2026-10', toMonth: '2026-10', directLabourCost: '3100', availableMinutes: '9600' }, problem: 'cpmRefusal.ONE_SEAT' }), note: 'Its cost per minute would be one person\'s pay (Owner rule): refused in words.' },
    { id: 'apply', label: 'Apply the cutting calculation', model: model({ dialog: { kind: 'apply', calc: CALCS[1]! } }) },
    { id: 'remove', label: 'Delete a calculation', model: model({ dialog: { kind: 'remove', calc: CALCS[2]! } }) },
    { id: 'applied-notice', label: 'Done: applied', model: model({ notice: { key: 'cpm.notice.applied', params: { from: '14/11/2026' } } }) },
    { id: 'reader', label: 'Read only (no costing.rates.manage)', model: model({ can: reader }) },
    { id: 'no-grain', label: 'Without the cost grain', model: model({ can: noGrain }), note: 'No figure; New calculation held: a labour total is a cost.' },
    { id: 'empty', label: 'Nothing yet', model: model({ calcs: { status: 'ready', value: [] }, rules: { status: 'ready', value: [] } }) },
    { id: 'loading', label: 'Loading', model: model({ calcs: { status: 'loading' }, rules: { status: 'loading' } }) },
    { id: 'error', label: 'Could not read', model: model({ calcs: { status: 'error', problem: 'cpm.problem.read' }, rules: { status: 'error', problem: 'cpm.problem.read' } }) },
  ],
})
