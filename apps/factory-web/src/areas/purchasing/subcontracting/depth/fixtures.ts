import { at, canFor, kitLine, LOCATIONS, MATERIALS, orderNumber, ROLE_PERMISSIONS, uid, WORK_ORDERS, WORKSHOPS, type RoleCase } from '../demo/fixtures'
import type { Ageing, Agreement, BalanceLine, CostEntry, OpenBalances, OrderBalance, OrderCost, OrderTerms } from './api'
import { depthCan, type DepthCan } from './model'

/**
 * Made-up data for subcontracting in depth's design cases (B-W2b-344; SCR-128 the Balance open tile and its saved view,
 * SCR-128-record the written terms link, Material balance and Cost tabs, SCR-129 days out): the demo order SC-2026-0008 of
 * "Laboratorio Cuciture Demo" for WO-DEMO-0101, its lining and protectors, made-up agreements, declarations, charges, an
 * invoice and dates. Nothing here is a real company, person, document or number. Design-only (the fixtures import it);
 * it exports no `designScreen`.
 */

export const depthFor = (role: RoleCase): DepthCan => depthCan(ROLE_PERMISSIONS[role], canFor(role))

const ORDER_ID = uid('8181', 50)
const ORDER_NUMBER = orderNumber(8)
const LAW = 'L. 192/1998 art. 2'

// ---- the written terms ---------------------------------------------------------------------------------------------------

const agreement = (revision: number, over: Partial<Agreement>): Agreement => ({
  id: uid('9494', revision),
  revision,
  title: `Accordo quadro cuciture ${2024 + revision}`,
  status: 'SIGNED',
  workshop: WORKSHOPS.sewing,
  validFrom: `${2024 + revision}-01-01`,
  validUntil: `${2024 + revision}-12-31`,
  signedAt: `${2023 + revision}-12-18T10:00:00.000Z`,
  endedAt: null,
  file: { id: uid('9595', revision), originalName: `accordo-quadro-${2024 + revision}-firmato.pdf`, contentType: 'application/pdf', status: 'AVAILABLE' },
  inForceToday: false,
  expiresInDays: null,
  ...over,
})

const REV1 = agreement(1, { status: 'SUPERSEDED', endedAt: '2025-12-18T10:00:00.000Z' })
const REV2 = agreement(2, { inForceToday: true })
const REV3 = agreement(3, { status: 'DRAFT', signedAt: null, file: null })

export function termsOf(kind: 'covered' | 'ending' | 'superseded' | 'noFile' | 'draft' | 'none' | 'otherDays'): OrderTerms {
  const order = { id: ORDER_ID, number: ORDER_NUMBER, orderDate: '2026-11-05', workshop: { id: WORKSHOPS.sewing.id, name: WORKSHOPS.sewing.name } }
  switch (kind) {
    case 'covered':
      return { order, covering: REV2, words: null, law: LAW, revisions: [REV3, REV2, REV1] }
    case 'ending':
      return { order, covering: { ...REV2, validUntil: '2026-12-10', expiresInDays: 22 }, words: null, law: LAW, revisions: [REV2, REV1] }
    case 'superseded':
      return { order: { ...order, orderDate: '2025-06-12' }, covering: REV1, words: null, law: LAW, revisions: [REV2, REV1] }
    case 'noFile':
      return { order, covering: { ...REV2, file: null }, words: null, law: LAW, revisions: [REV2] }
    case 'draft':
      return { order, covering: null, words: 'none', law: LAW, revisions: [{ ...REV3, revision: 1, validFrom: '2026-11-01' }] }
    case 'none':
      return { order, covering: null, words: 'none', law: LAW, revisions: [] }
    case 'otherDays':
      return { order, covering: null, words: 'none', law: LAW, revisions: [agreement(3, { validFrom: '2027-01-01', validUntil: null })] }
  }
}

// ---- the material balance ------------------------------------------------------------------------------------------------

const LINING = kitLine(1)
const PROTECTOR = kitLine(2)
const RECEIPT_1 = { id: uid('8585', 1), seq: 1, receivedAt: at(16, 10, 15) }
const RECEIPT_2 = { id: uid('8585', 2), seq: 2, receivedAt: at(17, 15) }
const NONE = { declare: null, adjust: null }

function line(kit: typeof LINING, over: Partial<BalanceLine>): BalanceLine {
  return {
    kitLineId: kit.id,
    seq: kit.seq,
    item: { id: kit.item.id, code: kit.item.code, name: kit.item.name },
    colour: kit.colour,
    lot: kit.lot ? { id: kit.lot.id, code: kit.lot.code } : null,
    hide: null,
    uom: kit.uom,
    sentAt: at(10, 8),
    sent: kit.quantity,
    used: '0.0000',
    returned: '0.0000',
    scrapped: '0.0000',
    open: kit.quantity,
    short: null,
    flags: [],
    checkedByWorkshop: null,
    announcedBack: '0.0000',
    backInOurPlaces: '0.0000',
    daysOut: 8,
    rows: [],
    suggestion: { used: '0.0000', returned: '0.0000', scrapped: '0.0000' },
    actions: { ...NONE },
    ...over,
  }
}

const declared = (n: number, used: string, returned: string, scrapped: string, receipt: typeof RECEIPT_1 | null, reason: string | null = null) => ({
  id: uid('9696', n),
  seq: n,
  kind: 'DECLARED' as const,
  used,
  returned,
  scrapped,
  receipt: receipt ? { id: receipt.id, seq: receipt.seq } : null,
  reportedAt: receipt?.receivedAt ?? at(16, 11),
  reasonCode: null,
  reason,
  bookedAt: at(16, 11, 5),
  bookedBy: 'Marta Esempio',
})

/** Partly back: the lining counted short and not declared yet, 3.4 m of it back unused; the protectors declared with the first receipt. */
export const BALANCE_PARTLY: OrderBalance = {
  order: { id: ORDER_ID, number: ORDER_NUMBER, status: 'PARTLY_RECEIVED', version: 6, allBack: false, someBack: true },
  balanceOpen: false,
  lines: [
    line(LINING, {
      short: '-2.6000',
      checkedByWorkshop: { quantity: '40.0000', at: at(11, 9, 40), note: 'Un rotolo bagnato in fondo alla scatola.' },
      announcedBack: '3.4000',
      backInOurPlaces: '3.4000',
      flags: [{ flag: 'SHORT_AT_WORKSHOP' }, { flag: 'NOT_DECLARED' }, { flag: 'BACK_NOT_DECLARED' }],
      suggestion: { used: '15.1500', returned: '3.4000', scrapped: '0.0000' },
      actions: { declare: null, adjust: 'not declared' },
    }),
    line(PROTECTOR, {
      used: '32.0000',
      open: '28.0000',
      checkedByWorkshop: { quantity: '60.0000', at: at(11, 9, 40), note: null },
      rows: [declared(1, '32.0000', '0.0000', '0.0000', RECEIPT_1)],
      suggestion: { used: '0.0000', returned: '0.0000', scrapped: '0.0000' },
    }),
  ],
  receipts: [RECEIPT_1],
  actions: { ...NONE },
}

/** Every piece back: 2.7 m of lining still out (a loss until it is booked), one adjustment after the receipt. */
export const BALANCE_BACK: OrderBalance = {
  order: { id: ORDER_ID, number: ORDER_NUMBER, status: 'RECEIVED', version: 9, allBack: true, someBack: true },
  balanceOpen: true,
  lines: [
    line(LINING, {
      used: '35.9000',
      returned: '3.4000',
      scrapped: '0.6000',
      open: '2.7000',
      short: '-2.6000',
      checkedByWorkshop: { quantity: '40.0000', at: at(11, 9, 40), note: 'Un rotolo bagnato in fondo alla scatola.' },
      announcedBack: '3.4000',
      backInOurPlaces: '3.4000',
      daysOut: 8,
      flags: [{ flag: 'SHORT_AT_WORKSHOP' }, { flag: 'OPEN_AFTER_BACK' }],
      rows: [
        declared(2, '36.0000', '3.4000', '0.5000', RECEIPT_2, 'Dichiarazione sul DDT LCD-91/26.'),
        { ...declared(3, '-0.1000', '0.0000', '0.1000', null, 'Il terzista ha ricontato gli scarti: una manica tagliata male.'), kind: 'ADJUSTMENT' as const, reportedAt: at(17, 16), bookedAt: at(17, 16, 10) },
      ],
      suggestion: { used: '2.7000', returned: '0.0000', scrapped: '0.0000' },
    }),
    line(PROTECTOR, { used: '60.0000', open: '0.0000', daysOut: null, checkedByWorkshop: { quantity: '60.0000', at: at(11, 9, 40), note: null }, rows: [declared(1, '32.0000', '0.0000', '0.0000', RECEIPT_1), declared(4, '28.0000', '0.0000', '0.0000', RECEIPT_2)], actions: { declare: 'nothing open', adjust: null } }),
  ],
  receipts: [RECEIPT_1, RECEIPT_2],
  actions: { ...NONE },
}

export const BALANCE_NOTHING_SENT: OrderBalance = { ...BALANCE_PARTLY, order: { ...BALANCE_PARTLY.order, status: 'ISSUED', someBack: false }, lines: [], receipts: [], actions: { declare: 'nothing sent', adjust: 'nothing sent' } }

// ---- the cost on the work order ------------------------------------------------------------------------------------------

const entry = (n: number, over: Partial<CostEntry>): CostEntry => ({
  id: uid('9797', n),
  kind: 'TRANSPORT',
  operation: null,
  receipt: null,
  quantity: '1.0000',
  unitPrice: '35.000000',
  amount: 3500,
  currency: 'EUR',
  occurredAt: at(17, 15, 30),
  reason: null,
  reversalOfId: null,
  reversedById: null,
  onWorkOrder: true,
  createdAt: at(17, 15, 30),
  ...over,
})

export const COST: OrderCost = {
  order: { id: ORDER_ID, number: ORDER_NUMBER, status: 'RECEIVED', currency: 'EUR', workOrder: { id: WORK_ORDERS.jacket.id, number: WORK_ORDERS.jacket.number, currency: 'EUR' } },
  operations: [
    { id: uid('8282', 30), seq: 10, code: 'CUC', name: 'Cucitura completa (CMT)', pricePerPiece: '7.000000', piecesBackGood: 30, waitingForInspection: 0, bookedByFee: 2, bookable: 28, earnedFee: 19600 },
    { id: uid('8282', 50), seq: 20, code: 'TAS', name: 'Tasche per protezioni', pricePerPiece: '1.200000', piecesBackGood: 30, waitingForInspection: 4, bookedByFee: 0, bookable: 26, earnedFee: 3120 },
  ],
  entries: [
    entry(1, { kind: 'FEE', operation: { id: uid('8282', 30), seq: 10 }, receipt: { id: RECEIPT_2.id, seq: 2 }, quantity: '2.0000', unitPrice: '6.500000', amount: 1300, reason: 'Prezzo concordato per le due giacche rifatte.', occurredAt: at(17, 15, 20), createdAt: at(17, 15, 20) }),
    entry(2, { receipt: { id: RECEIPT_2.id, seq: 2 } }),
    entry(3, { unitPrice: '15.000000', amount: 1500, reversedById: uid('9797', 4), occurredAt: at(12, 9), createdAt: at(12, 9) }),
    entry(4, { unitPrice: '15.000000', amount: -1500, reversalOfId: uid('9797', 3), reason: 'Registrato due volte: il trasporto è uno solo.', occurredAt: at(17, 15, 40), createdAt: at(17, 15, 40) }),
  ],
  bridge: { earnedFee: 22720, feeAtWorkshopPrice: 1300, transport: 3500, material: 0, other: 0, orderCost: 27520, currency: 'EUR' },
  workOrder: { onLedger: 27520, entries: 6, waiting: [] },
  invoices: null,
  actions: { book: null, reverse: null },
}

/** The same with the workshop's invoice lines (a role with payables.view). */
export const COST_WITH_INVOICES: OrderCost = {
  ...COST,
  invoices: [{ invoiceId: uid('9898', 1), number: 'FT-DEMO-0042', status: 'RECEIVED', matchStatus: 'PENDING', currency: 'EUR', seq: 1, description: `Cucitura giacche ${ORDER_NUMBER}`, netAmount: 26000 }],
}

/** The cost as a role without the cost grain receives it (no price, no amount anywhere). */
export function costWithoutMoney(value: OrderCost): OrderCost {
  return {
    ...value,
    operations: value.operations.map(({ pricePerPiece: _price, earnedFee: _fee, ...operation }) => operation),
    entries: value.entries.map(({ unitPrice: _price, amount: _amount, ...row }) => row),
    bridge: { currency: value.bridge.currency },
    workOrder: { entries: value.workOrder.entries, waiting: value.workOrder.waiting },
    invoices: value.invoices?.map(({ netAmount: _net, ...line }) => line) ?? null,
    actions: { book: 'cost grain', reverse: 'cost grain' },
  }
}

export const COST_NONE: OrderCost = {
  ...COST,
  order: { ...COST.order, status: 'AT_WORKSHOP' },
  operations: COST.operations.map((operation) => ({ ...operation, piecesBackGood: 0, waitingForInspection: 0, bookedByFee: 0, bookable: 0, earnedFee: 0 })),
  entries: [],
  bridge: { earnedFee: 0, feeAtWorkshopPrice: 0, transport: 0, material: 0, other: 0, orderCost: 0, currency: 'EUR' },
  workOrder: { onLedger: 0, entries: 0, waiting: [] },
}

export const COST_OTHER_CURRENCY: OrderCost = {
  ...COST,
  order: { ...COST.order, currency: 'CHF' },
  entries: COST.entries.map((row) => ({ ...row, currency: 'CHF', onWorkOrder: false })),
  bridge: { ...COST.bridge, currency: 'CHF' },
  workOrder: { onLedger: 0, entries: 0, waiting: ['Subcontract order is in CHF; the work order is kept in EUR.'] },
}

export const COST_DRAFT: OrderCost = { ...COST_NONE, order: { ...COST.order, status: 'DRAFT' }, actions: { book: 'draft', reverse: 'draft' } }

// ---- days out and the open balances --------------------------------------------------------------------------------------

const zero = { upTo30: '0.0000', upTo60: '0.0000', upTo90: '0.0000', over90: '0.0000' }

export const AGEING: Ageing = {
  asOf: '2026-11-18',
  longOutDays: 60,
  rows: [
    { location: LOCATIONS.sewing, item: { id: MATERIALS.lining.id, code: MATERIALS.lining.code }, colour: { id: uid('7272', 1), code: 'BLK', name: 'Nero' }, lot: { id: LINING.lot!.id, code: LINING.lot!.code }, hide: null, onHand: '39.2000', since: '2026-11-10', daysOut: 8, buckets: { ...zero, upTo30: '39.2000' }, longOut: false },
    { location: LOCATIONS.sewing, item: { id: MATERIALS.protector.id, code: MATERIALS.protector.code }, colour: null, lot: null, hide: null, onHand: '60.0000', since: '2026-11-10', daysOut: 8, buckets: { ...zero, upTo30: '60.0000' }, longOut: false },
    { location: LOCATIONS.embroidery, item: { id: MATERIALS.thread.id, code: MATERIALS.thread.code }, colour: { id: uid('7272', 2), code: 'RED', name: 'Rosso' }, lot: null, hide: null, onHand: '4.0000', since: '2026-09-03', daysOut: 76, buckets: { ...zero, upTo90: '4.0000' }, longOut: true },
  ],
  workshops: [
    { workshop: WORKSHOPS.sewing, location: LOCATIONS.sewing, lines: 2, oldestDaysOut: 8, longOut: 0 },
    { workshop: WORKSHOPS.embroidery, location: LOCATIONS.embroidery, lines: 1, oldestDaysOut: 76, longOut: 1 },
  ],
  truncated: false,
}

const job = (n: number, status: OpenBalances['items'][number]['order']['status'], workshop: keyof typeof WORKSHOPS, open: { uom: string; quantity: string }[], sentAt: string, daysOut: number, kitLines = 2) => ({
  order: { id: uid('8181', n), number: orderNumber(n), status, version: 4, workshop: WORKSHOPS[workshop], workOrder: { id: WORK_ORDERS.jacket.id, number: WORK_ORDERS.jacket.number } },
  kitLines,
  openLines: open.length,
  open,
  oldestSentAt: sentAt,
  daysOut,
  balanceOpen: status === 'RECEIVED' || status === 'CLOSED',
})

/** Every job with kit material open (the tile counts the ones back; the grid shows each one's rest). */
export const BALANCES: OpenBalances = {
  asOf: '2026-11-18',
  items: [
    job(2, 'CLOSED', 'sewing', [{ uom: 'M', quantity: '0.5000' }, { uom: 'PCS', quantity: '2.0000' }], '2026-09-05T08:00:00.000Z', 74),
    job(3, 'RECEIVED', 'finishing', [{ uom: 'M', quantity: '2.7000' }], '2026-10-16T08:00:00.000Z', 33, 1),
    job(4, 'PARTLY_RECEIVED', 'embroidery', [{ uom: 'PCS', quantity: '4.0000' }], '2026-09-03T08:00:00.000Z', 76, 1),
    job(5, 'AT_WORKSHOP', 'sewing', [{ uom: 'M', quantity: '39.2000' }, { uom: 'PCS', quantity: '60.0000' }], '2026-11-10T08:00:00.000Z', 8),
  ],
  counts: { balanceOpen: 2, open: 4, longOut: 2 },
}

/** The tile's saved view (open=true): the jobs back with material still open. */
export const BALANCES_BACK: OpenBalances = { ...BALANCES, items: BALANCES.items.filter((item) => item.balanceOpen), counts: BALANCES.counts }

