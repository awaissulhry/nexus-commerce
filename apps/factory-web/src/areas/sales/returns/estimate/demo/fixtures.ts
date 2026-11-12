import { ME, PEOPLE, REPAIR_RECEIVED } from '../../demo/fixtures'
import type { Estimate, EstimateLine, Estimates } from '../api'
import type { EstimateModel } from '../view-model'

/**
 * Made-up data of a repair's Estimate tab (B-W2b-352 design cases of SCR-112): "Demo" parts and work with made-up prices
 * and costs, the revisions of REP-DEMO-0001 in each state. Nothing here is a real company, person, garment or price.
 */

const uid = (n: number): string => `0190f0e2-7795-7000-8000-${String(n).padStart(12, '0')}`
const ACTIONS = (allowed: readonly string[]): Estimate['actions'] => (['edit', 'send', 'answer', 'withdraw', 'revise'] as const).map((action) => ({ action, allowed: allowed.includes(action) }))

const LINES: EstimateLine[] = [
  { id: uid(11), seq: 10, kind: 'PART', item: { id: uid(91), code: 'PRT-DEMO-07', name: 'Elbow protector level 2 (demo)' }, description: 'Elbow protector, level 2', quantity: '1', minutes: null, unitPrice: '24.00', amount: 2400, unitCost: '9.50', costAmount: 950, version: 1 },
  { id: uid(12), seq: 20, kind: 'PART', item: null, description: 'Seam thread and tape', quantity: '1', minutes: null, unitPrice: '4.50', amount: 450, unitCost: '1.20', costAmount: 120, version: 1 },
  { id: uid(13), seq: 30, kind: 'LABOUR', item: null, description: 'Re-sew the elbow seam and fit the protector', quantity: '1', minutes: 40, unitPrice: '25.00', amount: 2500, unitCost: '10.30', costAmount: 1030, version: 1 },
]

function estimate(revision: number, over: Partial<Estimate> = {}): Estimate {
  return {
    id: uid(revision),
    revision,
    status: 'DRAFT',
    currency: 'EUR',
    validUntil: '2026-11-15',
    customerNote: 'Valid for 15 days (made-up).',
    internalNote: null,
    sentAt: null,
    sentById: null,
    answeredAt: null,
    answeredVia: null,
    answeredByName: null,
    recordedById: null,
    declineReason: null,
    withdrawnAt: null,
    withdrawnById: null,
    version: 4,
    createdAt: '2026-10-30T09:15:00.000Z',
    createdById: ME,
    lines: LINES,
    summary: { amount: 5350, partsAmount: 2850, labourAmount: 2500, costAmount: 2100, labourMinutes: 40, lines: 3 },
    actions: ACTIONS(['edit', 'send', 'withdraw', 'revise']),
    ...over,
  }
}

function answer(estimates: Estimate[], over: Partial<Estimates> = {}): Estimates {
  return {
    repair: { id: REPAIR_RECEIVED.id, number: REPAIR_RECEIVED.number, stage: 'RECEIVED', version: REPAIR_RECEIVED.version, partyId: REPAIR_RECEIVED.party.id },
    estimates,
    liveId: estimates.find((entry) => entry.status === 'DRAFT' || entry.status === 'SENT')?.id ?? null,
    newEstimate: { allowed: false, replaces: null },
    workHeld: { approve: null, startRepair: null },
    seesPrices: true,
    seesCosts: true,
    people: PEOPLE,
    ...over,
  }
}

export const ESTIMATES_NONE = answer([], { newEstimate: { allowed: true, replaces: null } })
export const ESTIMATES_DRAFT = answer([estimate(1)])
const SENT = estimate(1, { status: 'SENT', sentAt: '2026-10-30T10:02:00.000Z', sentById: ME, version: 5, actions: ACTIONS(['answer', 'withdraw', 'revise']) })
export const ESTIMATES_SENT = answer([SENT], { repair: { ...ESTIMATES_DRAFT.repair, stage: 'ESTIMATED' }, newEstimate: { allowed: true, replaces: SENT.id }, workHeld: { approve: 'held', startRepair: 'held' } })
export const ESTIMATES_ACCEPTED = answer([{ ...SENT, status: 'ACCEPTED', answeredAt: '2026-10-30T15:40:00.000Z', answeredVia: 'PORTAL', answeredByName: 'Mario Esempio', version: 6, actions: ACTIONS([]) }], { repair: { ...ESTIMATES_DRAFT.repair, stage: 'APPROVED' } })
const DECLINED = { ...SENT, status: 'DECLINED' as const, answeredAt: '2026-10-30T12:00:00.000Z', answeredVia: 'OFFICE' as const, answeredByName: 'Mario Esempio', recordedById: PEOPLE[1]!.id, declineReason: 'Too expensive for an old jacket (made-up).', actions: ACTIONS([]) }
export const ESTIMATES_HISTORY = answer([estimate(2, { createdAt: '2026-10-30T13:00:00.000Z', lines: LINES.slice(0, 2).concat({ ...LINES[2]!, unitPrice: '20.00', amount: 2000 }), summary: { amount: 4850, partsAmount: 2850, labourAmount: 2000, costAmount: 2100, labourMinutes: 40, lines: 3 } }), DECLINED], { repair: { ...ESTIMATES_DRAFT.repair, stage: 'ESTIMATED' } })
export const ESTIMATES_DECLINED = answer([DECLINED], { repair: { ...ESTIMATES_DRAFT.repair, stage: 'ESTIMATED' }, newEstimate: { allowed: true, replaces: null }, workHeld: { approve: 'held', startRepair: 'held' } })
/** A production manager: repairs managed, no price grain (the lines without prices or costs; nothing to change). */
export const ESTIMATES_NO_PRICES = answer([{ ...estimate(1), lines: LINES.map(({ unitPrice: _p, amount: _a, unitCost: _c, costAmount: _ca, ...rest }) => rest), summary: { labourMinutes: 40, lines: 3 } }], { seesPrices: false, seesCosts: false })

export function estimateModel(over: Partial<EstimateModel> = {}): EstimateModel {
  return { value: ESTIMATES_DRAFT, problem: null, shownId: null, marks: {}, dialog: null, busy: false, dialogProblem: null, ...over }
}

export const DEMO_LINE_IDS = LINES.map((line) => line.id)
