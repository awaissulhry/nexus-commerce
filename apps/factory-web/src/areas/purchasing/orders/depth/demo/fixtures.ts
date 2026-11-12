import { at, MATERIALS, uid } from '../../../../_shared/buying/fixtures'
import { part, PART_LOADING, type Part } from '../../../../_shared/buying/model'
import type { PoLine, PurchaseOrder } from '../../api'
import { leatherLine, ORDER_ROWS, protectorLine } from '../../demo/fixtures'
import type { ChasePreview, Compliance, DepthLine, KindLine, LineKinds, OrderApproval, OrderDemand, OrderDepth, SupplierClosures, WorklistRow } from '../api'
import { depthCanOf, type ChaseModel, type OrderDepthModel } from '../model'

/**
 * Made-up depth data for the B-W2b-333 design cases (SCR-058, SCR-059): the invented order PO-2026-0003 of "Officina Demo"
 * to Conceria Demo — the leather line split in two deliveries (the second confirmed a week later than asked), a lining line
 * bought by rolls, the protector line with its certificate; the tannery's chromium VI test report expired; the work and
 * customer orders the lines supply (WO-DEMO / SO-DEMO numbers); Finance's yes on the send; the chase mail. Every figure is
 * invented and worked out by hand. Design-only; it exports no `designScreen`.
 */

export const TODAY = '2026-10-29'

const tolerance = (over: Partial<DepthLine['tolerance']> = {}): DepthLine['tolerance'] => ({ overPct: '5', underPct: '5', whenBeyond: 'REASON', source: 'LINE', toleranceId: null, ...over })

/** A lining line by rolls (3 rolls × 50 m × 150 cm = 150 m). */
export const liningLine = (over: Partial<PoLine> = {}): PoLine => ({
  ...protectorLine(),
  id: uid('5803', 33),
  seq: 30,
  itemId: MATERIALS.lining.id,
  item: { code: MATERIALS.lining.code, name: MATERIALS.lining.name, kind: 'LINING', baseUom: 'M', purchaseUom: 'M' },
  quantity: '150.0000',
  uom: 'M',
  baseQuantity: '150.0000',
  baseUom: 'M',
  unitPrice: '3.100000',
  netAmount: 46_500,
  ...over,
})

/** The order of the design cases with its lining line (net 1 764,00 + 156,00 + 465,00 = 2 385,00). */
export function depthOrder(base: PurchaseOrder, lines: PoLine[] = [...base.lines, liningLine()]): PurchaseOrder {
  return { ...base, lines, lineCount: lines.length, netAmount: base.netAmount === undefined ? undefined : 238_500 } as PurchaseOrder
}

/** The order in depth: draft (the leather split, not sent), sent (the second delivery confirmed 7 days later), USD with a rate. */
export function depthOf(order: PurchaseOrder, mode: 'one' | 'split' | 'later' = 'split', currency: Partial<OrderDepth['currency']> = {}): OrderDepth {
  const sent = order.status !== 'DRAFT' && order.status !== 'PENDING_APPROVAL'
  return {
    orderId: order.id,
    number: order.number,
    status: order.status,
    version: order.version,
    currency: { order: order.currency, company: 'EUR', takesRate: order.currency !== 'EUR', rateAtOrder: null, companyNetAmount: order.currency !== 'EUR' ? null : undefined, ...currency },
    shipTo: null,
    lines: order.lines.map((line): DepthLine => {
      const leather = line.item.kind === 'LEATHER'
      const deliveries =
        leather && mode !== 'one'
          ? [
              { id: uid('5804', 1), seq: 1, quantity: '220.0000', baseQuantity: '220.0000', needDate: '2026-11-20', confirmedDate: sent ? '2026-11-20' : null, confirmedLaterBy: 0, note: null, version: 2 },
              { id: uid('5804', 2), seq: 2, quantity: '200.0000', baseQuantity: '200.0000', needDate: '2026-11-27', confirmedDate: sent && mode === 'later' ? '2026-12-04' : sent ? '2026-11-27' : null, confirmedLaterBy: sent && mode === 'later' ? 7 : 0, note: 'Seconda tintura (demo)', version: 2 },
            ]
          : []
      return {
        id: line.id,
        seq: line.seq,
        itemId: line.itemId,
        itemCode: line.item.code,
        quantity: line.quantity,
        uom: line.uom,
        baseQuantity: line.baseQuantity,
        needDate: line.needDate,
        confirmedDate: deliveries.length > 0 ? (deliveries[0]!.confirmedDate ?? null) : line.confirmedDate,
        confirmedLaterBy: 0,
        ended: !!line.ended,
        deliveries,
        tolerance: leather ? tolerance() : line.item.kind === 'PROTECTOR' ? tolerance({ overPct: '0', underPct: '0', whenBeyond: 'BLOCK', source: 'RULE', toleranceId: uid('5805', 1) }) : tolerance({ overPct: '0', underPct: '0', source: 'NONE' }),
      }
    }),
    dateChanges:
      sent && mode === 'later'
        ? [
            { id: uid('5806', 1), lineId: leatherLine().id, lineSeq: 10, deliveryId: uid('5804', 2), deliverySeq: 2, seq: 1, fromDate: '2026-11-27', toDate: '2026-12-04', source: 'SUPPLIER', changedAt: at(28, 16, 20), supplierContactName: 'Marta Demo', reason: 'La seconda tintura esce una settimana dopo (demo).', createdAt: at(28, 16, 25) },
          ]
        : [],
  }
}

const certificate = { id: uid('5807', 2), number: 'CERT-DEMO-0002', standard: 'EN 1621-1:2012', status: 'VALID', validFrom: '2025-02-01', validTo: '2027-01-31' }

export function kindsOf(order: PurchaseOrder, over: { certificate?: KindLine['certificate']; rolls?: KindLine['rolls'] } = {}): LineKinds {
  return {
    orderId: order.id,
    status: order.status,
    version: order.version,
    kind: 'STANDARD',
    mayChange: order.status === 'DRAFT',
    lines: order.lines.map((line): KindLine => {
      const base: KindLine = { id: line.id, seq: line.seq, itemId: line.itemId, itemCode: line.item.code, itemKind: line.item.kind, itemColourId: line.itemColourId, quantity: line.quantity, uom: line.uom, ended: !!line.ended, buysAs: 'OTHER', rolls: null, materialWidthCm: null, widthNote: null, ppe: false, certificate: null, certificateChoices: [], variant: null, variantChoices: [], keepsVariantsApart: true }
      if (line.item.kind === 'LINING') return { ...base, buysAs: 'FABRIC', rolls: over.rolls === undefined ? { count: 3, lengthM: '50.00', widthCm: '150.00', makes: '150.0000', matches: true } : over.rolls, materialWidthCm: '150.00', variantChoices: [{ code: 'DEMO-FOD-02-GRY', itemColourId: null, colourCode: 'GRY', size: null, supplierCode: 'F-G', status: 'ACTIVE' }] }
      if (line.item.kind === 'PROTECTOR')
        return {
          ...base,
          buysAs: 'PROTECTOR',
          ppe: true,
          certificate: over.certificate === undefined ? { ...certificate, state: 'HOLDS', endsBeforeNeed: false } : over.certificate,
          certificateChoices: [{ ...certificate, coverage: 'THIS_SUPPLIER' }],
          variantChoices: [
            { code: 'DEMO-PRT-03-M', itemColourId: null, colourCode: null, size: 'M', supplierCode: null, status: 'ACTIVE' },
            { code: 'DEMO-PRT-03-L', itemColourId: null, colourCode: null, size: 'L', supplierCode: null, status: 'ACTIVE' },
          ],
        }
      return base
    }),
  }
}

/** The compliance gate: nothing holds (`met`), the tannery's chromium VI test report expired (`held`), with a request. */
export function complianceOf(order: PurchaseOrder, mode: 'met' | 'held' = 'held', request: Compliance['request'] = null, may: Partial<Compliance['may']> = {}): Compliance {
  const leather = order.lines.find((line) => line.item.kind === 'LEATHER')
  const held = mode === 'held' && !!leather
  return {
    order: { id: order.id, number: order.number, status: order.status, version: order.version },
    requirements: leather
      ? [{ kind: 'CR_VI_TEST_REPORT', state: held ? 'EXPIRED' : 'MET', severity: held ? 'BLOCKS' : null, lineIds: [leather.id], seqs: [leather.seq], itemCodes: [leather.item.code], expiresOn: held ? '2026-10-02' : '2027-12-31', law: 'REACH Annex XVII entry 47' }]
      : [],
    lines: order.lines.map((line) => ({ lineId: line.id, seq: line.seq, held: held && line.id === leather?.id, kinds: line.id === leather?.id ? ['CR_VI_TEST_REPORT'] : [] })),
    checks: held ? [{ code: request?.state === 'WAITING' ? 'COMPLIANCE_OVERRIDE_WAITING' : 'COMPLIANCE_DOCUMENT_MISSING', severity: 'BLOCKS', path: 'lines/0' }] : [],
    ready: !held,
    overridden: request?.state === 'APPROVED',
    notChecked: [],
    request,
    may: { ask: held && order.status === 'DRAFT' && !request, decide: false, withdraw: false, ...may },
  }
}

export const REQUEST = (over: Partial<NonNullable<Compliance['request']>> = {}): NonNullable<Compliance['request']> => ({
  state: 'WAITING',
  reason: 'Il nuovo rapporto è in arrivo dal laboratorio; il lotto resta in quarantena fino al test (demo).',
  askedBy: { id: uid('3333', 1), name: 'Anna Demo', me: true },
  askedAt: at(29, 9, 10),
  decidedBy: null,
  decidedAt: null,
  words: null,
  current: true,
  ...over,
})

export function demandOf(order: PurchaseOrder): OrderDemand {
  return {
    orderId: order.id,
    plan: { runId: uid('5501', 14), finishedAt: at(28, 22, 0) },
    lines: order.lines.map((line) => ({
      lineId: line.id,
      seq: line.seq,
      ended: line.ended?.kind ?? null,
      expectedDate: line.needDate,
      outstandingBase: line.baseQuantity,
      demands:
        line.item.kind === 'LEATHER'
          ? [
              { kind: 'WORK_ORDER', workOrder: { id: uid('7001', 221), number: 'WO-DEMO-0221', status: 'RELEASED', dueDate: '2026-11-30' }, salesOrder: { id: uid('7101', 43), number: 'SO-DEMO-1043', promiseDate: '2026-12-05' }, size: '50', demandDate: '2026-11-28', quantity: '200.0000', lateBy: 3 },
              { kind: 'WORK_ORDER', workOrder: { id: uid('7001', 225), number: 'WO-DEMO-0225', status: 'PLANNED', dueDate: '2026-12-10' }, salesOrder: null, size: null, demandDate: '2026-12-08', quantity: '220.0000', lateBy: 0 },
            ]
          : line.item.kind === 'PROTECTOR'
            ? [{ kind: 'WORK_ORDER', workOrder: { id: uid('7001', 221), number: 'WO-DEMO-0221', status: 'RELEASED', dueDate: '2026-11-30' }, salesOrder: null, size: null, demandDate: '2026-11-28', quantity: '24.0000', lateBy: 0 }]
            : [{ kind: 'SAFETY_STOCK', workOrder: null, salesOrder: null, size: null, demandDate: '2026-12-01', quantity: '150.0000', lateBy: 0 }],
      salesOrdersAtRisk: line.item.kind === 'LEATHER' ? 1 : 0,
      workOrdersAtRisk: line.item.kind === 'LEATHER' ? 1 : 0,
    })),
  }
}

export function approvalOf(order: PurchaseOrder, state: OrderApproval['state'] = 'NONE', over: Partial<OrderApproval> = {}): OrderApproval {
  const task =
    state === 'NONE'
      ? null
      : {
          id: uid('7201', 1),
          status: state === 'WAITING' ? ('PENDING' as const) : state === 'REJECTED' ? ('REJECTED' as const) : state === 'WITHDRAWN' ? ('WITHDRAWN' as const) : state === 'STALE' ? ('STALE' as const) : ('APPROVED' as const),
          requestedAt: at(29, 9, 30),
          requestedBy: { id: uid('3333', 1), name: 'Anna Demo' },
          approver: { kind: 'ROLE' as const, id: uid('3434', 2), name: 'Finance' },
          dueAt: state === 'WAITING' ? at(30, 17, 0) : null,
          decidedAt: state === 'WAITING' ? null : at(29, 11, 5),
          decidedBy: state === 'WAITING' ? null : { id: uid('3333', 4), name: 'Paolo Demo' },
          comment: state === 'REJECTED' ? 'Prima chiudiamo il budget di novembre (demo).' : null,
          rejectReason: state === 'REJECTED' ? 'Oltre il budget del mese' : null,
        }
  return { orderId: order.id, status: order.status, version: order.version, state, task, approvedAsItIs: false, wouldAsk: null, ...over }
}

export const CLOSURES: SupplierClosures = { weeklyDaysOff: [6, 7], ahead: [{ from: '2026-12-24', to: '2027-01-06', kind: 'CLOSURE', name: 'Chiusura natalizia (demo)', days: 14 }] }

export function chaseOf(order: PurchaseOrder, over: Partial<ChasePreview> = {}): ChasePreview {
  return {
    orderId: order.id,
    version: order.version,
    allowed: true,
    lines: [
      { lineId: leatherLine().id, seq: 10, label: 'NAP-12 Nappa 1,2 mm N01', needDate: '2026-11-27', confirmedDate: '2026-12-04', expectedDate: '2026-12-04', daysLate: 0, confirmedLaterBy: 7, reasons: ['CONFIRMED_LATE'] },
      { lineId: protectorLine().id, seq: 20, label: 'Protezione spalla livello 2', needDate: '2026-11-20', confirmedDate: null, expectedDate: '2026-11-20', daysLate: 0, confirmedLaterBy: 0, reasons: ['NOT_CONFIRMED'] },
    ],
    recipient: { contactId: uid('6161', 1), name: 'Ufficio ordini Demo', email: 'ordini@conceria-demo.example.com' },
    language: 'it',
    subject: 'Sollecito ordine PO-2026-0003',
    body: 'Buongiorno,\n\nvi chiediamo notizie su queste righe dell’ordine PO-2026-0003:\n- riga 10 NAP-12 Nappa 1,2 mm N01: chiesta per il 27/11/2026, confermata per il 04/12/2026\n- riga 20 Protezione spalla livello 2: chiesta per il 20/11/2026, non ancora confermata\n\nGrazie,\nOfficina Demo (esempio)',
    ...over,
  }
}

export function chaseModel(order: PurchaseOrder, over: Partial<ChaseModel> = {}): ChaseModel {
  return { orderId: order.id, number: order.number, supplier: order.supplier.name, preview: { status: 'ready', value: chaseOf(order) }, lineIds: null, message: '', busy: false, problem: null, done: null, ...over }
}

/** The record's depth model of a design case (made-up data, the role's rights). */
export function depthModel(order: PurchaseOrder, permissions: readonly string[], over: Partial<OrderDepthModel> = {}, parts: { depth?: Part<OrderDepth>; kinds?: Part<LineKinds>; compliance?: Part<Compliance>; demand?: Part<OrderDemand>; approval?: Part<OrderApproval> } = {}): OrderDepthModel {
  const can = depthCanOf(permissions)
  return {
    can,
    depth: parts.depth ?? part(depthOf(order, order.status === 'DRAFT' ? 'split' : 'later')),
    kinds: parts.kinds ?? part(kindsOf(order)),
    compliance: parts.compliance ?? part(complianceOf(order, 'met')),
    demand: parts.demand ?? part(demandOf(order)),
    approval: parts.approval ?? part(approvalOf(order)),
    closures: can.parties ? part(CLOSURES) : null,
    dialog: null,
    problem: null,
    busy: false,
    chase: null,
    today: TODAY,
    month: '2026-11',
    ...over,
  }
}

export const DEPTH_LOADING = PART_LOADING

// ---- the list (SCR-058) ---------------------------------------------------------------------------------------------------

const worklistRow = (orderNumber: string, over: Partial<WorklistRow> = {}): WorklistRow => {
  const order = ORDER_ROWS.find((row) => row.number === orderNumber)!
  return {
    lineId: uid('5803', 90 + Number(orderNumber.slice(-1))),
    seq: 10,
    purchaseOrderId: order.id,
    number: order.number,
    status: order.status,
    version: order.version,
    siteId: order.siteId,
    partyId: order.partyId,
    supplierName: order.supplierName,
    item: { code: MATERIALS.leather.code, name: MATERIALS.leather.name },
    colour: { code: 'BLK', name: 'Nero' },
    baseUom: 'FT2',
    outstandingBase: '200.0000',
    needDate: '2026-11-20',
    confirmedDate: '2026-11-20',
    expectedDate: '2026-12-04',
    nextDelivery: { seq: 2, needDate: '2026-11-27', confirmedDate: '2026-12-04' },
    daysLate: 0,
    confirmedLaterBy: 7,
    reasons: ['CONFIRMED_LATE'],
    blocks: {
      entries: [
        { kind: 'WORK_ORDER', workOrder: { id: uid('7001', 221), number: 'WO-DEMO-0221', status: 'RELEASED', dueDate: '2026-11-30' }, salesOrder: { id: uid('7101', 43), number: 'SO-DEMO-1043', promiseDate: '2026-12-05' }, size: '50', demandDate: '2026-11-28', quantity: '200.0000', lateBy: 3 },
      ],
      salesOrdersAtRisk: 1,
      workOrdersAtRisk: 1,
      earliestPromise: '2026-12-05',
    },
    ...over,
  }
}

/** Two orders with lines at risk: PO-2026-0005 (confirmed later) and PO-2026-0003 (late, received in part). */
export const WORKLIST_ROWS: WorklistRow[] = [
  worklistRow('PO-2026-0005'),
  worklistRow('PO-2026-0003', {
    seq: 20,
    item: { code: MATERIALS.protector.code, name: MATERIALS.protector.name },
    colour: null,
    baseUom: 'PCS',
    outstandingBase: '12.0000',
    confirmedDate: '2026-10-27',
    expectedDate: '2026-10-27',
    nextDelivery: null,
    daysLate: 2,
    confirmedLaterBy: 0,
    reasons: ['LATE'],
    blocks: { entries: [{ kind: 'WORK_ORDER', workOrder: { id: uid('7001', 230), number: 'WO-DEMO-0230', status: 'RELEASED', dueDate: '2026-10-30' }, salesOrder: null, size: null, demandDate: '2026-10-30', quantity: '12.0000', lateBy: 2 }], salesOrdersAtRisk: 0, workOrdersAtRisk: 1, earliestPromise: null },
  }),
]
export const CONFIRMED_LATE_ROWS: WorklistRow[] = [WORKLIST_ROWS[0]!, worklistRow('PO-2026-0004', { seq: 10, item: { code: MATERIALS.protector.code, name: MATERIALS.protector.name }, colour: null, baseUom: 'PCS', outstandingBase: '24.0000', nextDelivery: null, confirmedDate: '2026-11-06', needDate: '2026-11-02', expectedDate: '2026-11-06', confirmedLaterBy: 4, blocks: { entries: [], salesOrdersAtRisk: 0, workOrdersAtRisk: 0, earliestPromise: null } })]
