import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { OrderStructure, RuleRow, RulesRead, StructureRow } from './api'
import { OrderStructuresView, type OrderStructuresViewModel } from './view/OrderStructuresView'

/**
 * owb-ss8 — Production › Order structures with made-up data (design index `/design/SCR-owb-order-structures`): three structures (one
 * closed), four rules — the customer's gloves above the customer's everything, molded… — one never used, the try answer, sales's read.
 * The tests read the same data. Made-up names and codes only.
 */

const team = (id: string, name: string, icon: string | null, colour: string) => ({ id, name, picture: { kind: icon ? ('ICON' as const) : ('LETTERS' as const), icon, colour, letters: '' } })

export const STRUCTURES: readonly StructureRow[] = [
  { id: 's-race', name: 'Brand Alpha · race team', teams: [team('team-noor', 'Team Noor', 'scissors', 'orange')], people: [{ userId: 'user-sam', name: 'Sam Sales' }], note: null, closed: false, usedByRules: 1, version: 2 },
  { id: 's-gloves', name: 'Gloves · short way', teams: [team('team-kian', 'Team Kian', 'shirt', 'cyan'), team('team-lia', 'Team Lia', null, 'violet')], people: [], note: 'Two teams together for gloves.', closed: false, usedByRules: 2, version: 1 },
  { id: 's-old', name: 'Old way', teams: [], people: [], note: null, closed: true, usedByRules: 0, version: 5 },
]

const rule = (id: string, sortOrder: number, party: RuleRow['party'], category: string | null, structureId: string, over: Partial<RuleRow> = {}): RuleRow => {
  const structure = STRUCTURES.find((each) => each.id === structureId)!
  return { id, sortOrder, party, category, structure: { id: structure.id, name: structure.name, closed: structure.closed }, active: true, note: null, closed: false, dead: false, deadBecause: null, fitsNow: { count: 0, orders: [] }, version: 1, ...over }
}

const ALPHA = { id: 'party-alpha', name: 'Brand Alpha' }

export const RULES: readonly RuleRow[] = [
  rule('r-gloves', 10, ALPHA, 'GLOVES', 's-gloves', { fitsNow: { count: 1, orders: [{ id: 'order-104', number: 'SO-2026-0104' }] } }),
  rule('r-alpha', 20, ALPHA, null, 's-race', { fitsNow: { count: 2, orders: [{ id: 'order-100', number: 'SO-2026-0100' }, { id: 'order-107', number: 'SO-2026-0107' }] } }),
  rule('r-alpha-suits', 30, ALPHA, 'SUIT', 's-gloves', { dead: true, deadBecause: { ruleId: 'r-alpha' } }),
  rule('r-any-gloves', 40, null, 'GLOVES', 's-gloves', { note: 'Every customer’s gloves.' }),
  rule('r-closed', 50, null, 'VEST', 's-race', { closed: true }),
]

export const RULES_READ: RulesRead = { rules: [...RULES], neverUsed: 1, may: { write: true } }

export const ORDER_ONE: OrderStructure = {
  orderId: 'order-100',
  printed: false,
  byHand: null,
  lines: [
    { salesOrderLineId: 'line-1', label: 'Line 1 · Race suit', structure: { id: 's-race', name: 'Brand Alpha · race team' }, rule: { id: 'r-alpha' }, from: 'RULE', why: '', kept: false },
    { salesOrderLineId: 'line-2', label: 'Line 2 · Race suit, size run', structure: { id: 's-race', name: 'Brand Alpha · race team' }, rule: { id: 'r-alpha' }, from: 'RULE', why: '', kept: false },
  ],
  may: { change: true },
}

export const ORDER_MANY_PRINTED: OrderStructure = {
  orderId: 'order-104',
  printed: true,
  byHand: null,
  lines: [
    { salesOrderLineId: 'line-1', label: 'Line 1 · Suit', structure: { id: 's-race', name: 'Brand Alpha · race team' }, rule: { id: 'r-alpha' }, from: 'RULE', why: '', kept: true },
    { salesOrderLineId: 'line-2', label: 'Line 2 · Gloves', structure: { id: 's-gloves', name: 'Gloves · short way' }, rule: { id: 'r-gloves' }, from: 'RULE', why: '', kept: true },
  ],
  may: { change: true },
}

export const ORDER_BY_HAND: OrderStructure = {
  orderId: 'order-107',
  printed: false,
  byHand: { structureId: null, why: 'A show piece', by: 'Sam Sales', at: '2026-11-27T10:00:00.000Z' },
  lines: [{ salesOrderLineId: 'line-1', label: 'Line 1 · Jacket', structure: null, rule: null, from: 'ORDER', why: 'A show piece', kept: false }],
  may: { change: true },
}

const page = (over: Partial<OrderStructuresViewModel> = {}): OrderStructuresViewModel => ({
  state: 'ready',
  problem: null,
  structures: STRUCTURES,
  rules: RULES_READ,
  may: { manage: true, write: true },
  customers: [ALPHA, { id: 'party-beta', name: 'Brand Beta' }],
  tryTerms: { partyId: 'party-alpha', category: 'GLOVES' },
  tryAnswer: { value: { winner: { ruleId: 'r-gloves', structureId: 's-gloves', words: 'Brand Alpha · gloves fits first: Gloves · short way.' }, others: [{ ruleId: 'r-alpha', words: 'A rule above fits first.' }, { ruleId: 'r-any-gloves', words: 'A rule above fits first.' }] }, reading: false, problem: null },
  moving: null,
  notice: null,
  ...over,
})

export const designScreen = defineDesignScreen<OrderStructuresViewModel>({
  screen: 'SCR-owb-order-structures',
  title: 'Production › Order structures — rules read from the top, Try an order, structures (owb-ss8)',
  view: OrderStructuresView,
  cases: [
    { id: 'owner', label: 'The owner: four rules (one never used), the fixed last line, Try an order, three structures (one closed)', model: page() },
    { id: 'sales', label: 'Sales: writes rules, reads structures', model: page({ may: { manage: false, write: true } }) },
    { id: 'manager', label: 'The production manager: makes structures, reads rules', model: page({ may: { manage: true, write: false } }) },
    { id: 'failed', label: 'Not read', model: page({ state: 'failed', structures: null, rules: null, problem: 'error.offline' }) },
  ],
})
