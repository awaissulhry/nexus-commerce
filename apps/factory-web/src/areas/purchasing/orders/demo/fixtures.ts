import { at, COLOURS, MATERIALS, SITE, SUPPLIERS, uid } from '../../../_shared/buying/fixtures'
import type { OrderDocuments, OrderReceipt, OrderRow, OrderSummary, PoLine, PoStatus, PurchaseOrder, SupplierAnswer } from '../api'

/**
 * Made-up purchase orders for SCR-058 / SCR-059 (and the receipts' links): "PO-2026-00NN" of the invented company to
 * Conceria Demo, Tessitura Esempio and Protezioni Prova; a leather line by area with its specs, a protector line, a
 * lining line; every figure worked out by hand. Design-only; it exports no `designScreen`.
 */

export const ORDER_ID = uid('5801', 3)

export const leatherLine = (over: Partial<PoLine> = {}): PoLine => ({
  id: uid('5803', 31),
  seq: 10,
  itemId: MATERIALS.leather.id,
  item: { code: MATERIALS.leather.code, name: MATERIALS.leather.name, kind: 'LEATHER', baseUom: 'FT2', purchaseUom: 'FT2' },
  itemColourId: COLOURS.black.id,
  colour: { code: COLOURS.black.code, name: COLOURS.black.name },
  description: null,
  supplierArticleCode: 'NAP-12',
  supplierColourCode: 'N01',
  quantity: '420.0000',
  uom: 'FT2',
  baseQuantity: '420.0000',
  baseUom: 'FT2',
  unitPrice: '4.200000',
  netAmount: 176_400,
  needDate: '2026-11-20',
  grade: 'A',
  thicknessMinMm: '1.1',
  thicknessMaxMm: '1.3',
  oneDyeBatch: true,
  areaTolerancePct: '5',
  estimatedHides: 8,
  requiresCrViTest: true,
  note: null,
  confirmedQuantity: null,
  confirmedDate: null,
  receivedBaseQuantity: '0.0000',
  plan: [{ requirementId: uid('5502', 1), runId: uid('5501', 14), runStatus: 'DONE', decision: 'ORDERED' }],
  version: 1,
  ...over,
})

export const protectorLine = (over: Partial<PoLine> = {}): PoLine => ({
  ...leatherLine(),
  id: uid('5803', 32),
  seq: 20,
  itemId: MATERIALS.protector.id,
  item: { code: MATERIALS.protector.code, name: MATERIALS.protector.name, kind: 'PROTECTOR', baseUom: 'PCS', purchaseUom: 'PCS' },
  itemColourId: null,
  colour: null,
  supplierArticleCode: null,
  supplierColourCode: null,
  quantity: '24.0000',
  uom: 'PCS',
  baseQuantity: '24.0000',
  baseUom: 'PCS',
  unitPrice: '6.500000',
  netAmount: 15_600,
  grade: null,
  thicknessMinMm: null,
  thicknessMaxMm: null,
  oneDyeBatch: false,
  areaTolerancePct: null,
  estimatedHides: null,
  requiresCrViTest: false,
  plan: [],
  ...over,
})

const confirmed = (line: PoLine, date = '2026-11-18'): PoLine => ({ ...line, confirmedQuantity: line.quantity, confirmedDate: date })

export function order(status: PoStatus, over: Partial<PurchaseOrder> = {}): PurchaseOrder {
  const sent = status !== 'DRAFT'
  const isConfirmed = ['CONFIRMED', 'PARTLY_RECEIVED', 'RECEIVED', 'CLOSED'].includes(status)
  const lines =
    status === 'PARTLY_RECEIVED'
      ? [confirmed(leatherLine({ receivedBaseQuantity: '212.4000' })), confirmed(protectorLine({ receivedBaseQuantity: '24.0000' }))]
      : status === 'RECEIVED'
        ? [confirmed(leatherLine({ receivedBaseQuantity: '416.8000' })), confirmed(protectorLine({ receivedBaseQuantity: '24.0000' }))]
        : isConfirmed
          ? [confirmed(leatherLine()), confirmed(protectorLine())]
          : [leatherLine(), protectorLine()]
  return {
    id: ORDER_ID,
    number: 'PO-2026-0003',
    documentNumber: 'PO-2026-0003',
    companyId: SITE.companyId,
    siteId: SITE.id,
    site: { code: SITE.code, name: SITE.name },
    partyId: SUPPLIERS.tannery.id,
    supplier: { code: SUPPLIERS.tannery.code, name: SUPPLIERS.tannery.legalName, status: 'ACTIVE' },
    contactId: uid('6161', 1),
    contact: { name: 'Ufficio ordini Demo', email: 'ordini@conceria-demo.example.com', roles: ['ORDERS'] },
    status,
    revision: 1,
    currency: 'EUR',
    orderDate: '2026-10-27',
    requestedDate: '2026-11-18',
    incoterms: 'EXW Santa Croce (demo)',
    paymentTerms: 'Bonifico 60 gg fm',
    note: 'Pelli da un solo bagno; consegna al mattino.',
    internalNote: 'Second tannery quoted 4.45/ft².',
    netAmount: 192_000,
    lineCount: lines.length,
    earliestNeedDate: '2026-11-20',
    sentAt: sent ? at(27, 10, 12) : null,
    sentById: sent ? uid('3333', 1) : null,
    confirmedAt: isConfirmed ? at(28, 8, 40) : null,
    confirmedVia: isConfirmed ? 'LINK' : null,
    confirmedByName: isConfirmed ? 'Marta Demo' : null,
    supplierRef: isConfirmed ? 'CONF-DEMO-118' : null,
    confirmNote: null,
    declinedAt: status === 'DECLINED' ? at(28, 9, 5) : null,
    declineReason: status === 'DECLINED' ? 'No capacity this month' : null,
    closedAt: status === 'CLOSED' ? at(29, 9) : null,
    cancelledAt: status === 'CANCELLED' ? at(28, 11) : null,
    cancelReason: status === 'CANCELLED' ? 'Bought with the next season’s order instead' : null,
    version: 4,
    createdAt: at(27, 9, 30),
    updatedAt: at(28, 8, 40),
    lines,
    send: status === 'DRAFT' ? { ready: true, checks: [{ code: 'NOT_A_MULTIPLE', severity: 'WARNING', path: 'lines/1/quantity' }] } : null,
    confirmLinks: sent
      ? [{ id: uid('6363', 1), email: 'ordini@conceria-demo.example.com', state: isConfirmed ? 'USED_UP' : status === 'SENT' || status === 'CHANGES_PROPOSED' ? (status === 'SENT' ? 'LIVE' : 'USED_UP') : 'REVOKED', expiresAt: at(20, 22, 59, 11), uses: isConfirmed ? 1 : 0, maxUses: 1, lastUsedAt: isConfirmed ? at(28, 8, 40) : null, revokedAt: null, createdAt: at(27, 10, 12) }]
      : [],
    ...over,
  }
}

export const BLOCKED_DRAFT = (): PurchaseOrder =>
  order('DRAFT', {
    lines: [leatherLine({ unitPrice: '0.000000', netAmount: 0, needDate: '2026-10-20' }), protectorLine()],
    send: {
      ready: false,
      checks: [
        { code: 'LINE_NOT_PRICED', severity: 'BLOCKS', path: 'lines/0/unitPrice' },
        { code: 'NEED_DATE_PAST', severity: 'BLOCKS', path: 'lines/0/needDate' },
        { code: 'LATE_FOR_LEAD_TIME', severity: 'WARNING', path: 'lines/1/needDate' },
      ],
    },
  })

export function withoutPrices(value: PurchaseOrder): PurchaseOrder {
  const { netAmount: _net, ...rest } = value
  return { ...rest, lines: value.lines.map(({ unitPrice: _price, netAmount: _amount, ...line }) => line as PoLine) } as PurchaseOrder
}

export function answerOf(value: PurchaseOrder): SupplierAnswer {
  const kind = value.status === 'DRAFT' ? 'NOT_SENT' : value.status === 'SENT' ? 'WAITING' : value.status === 'DECLINED' ? 'DECLINED' : value.status === 'CHANGES_PROPOSED' ? 'CHANGES_PROPOSED' : value.status === 'CANCELLED' || value.status === 'CLOSED' ? 'CLOSED' : 'CONFIRMED'
  const proposed = kind === 'CHANGES_PROPOSED'
  return {
    purchaseOrderId: value.id,
    number: value.number,
    status: value.status,
    answer: kind,
    confirmation: value.confirmedAt ? { at: value.confirmedAt, via: 'LINK', linkId: uid('6363', 1), byName: value.confirmedByName, supplierRef: value.supplierRef, note: 'Spediamo con il nostro corriere.' } : null,
    decline: value.declinedAt ? { at: value.declinedAt, reason: value.declineReason } : null,
    proposal: proposed ? { at: at(28, 8, 40), linkId: uid('6363', 1), byName: 'Marta Demo', supplierRef: 'PROP-DEMO-7', note: 'Il nero arriva in due bagni.', decision: null, decidedAt: null, decidedById: null } : null,
    lines: value.lines.map((line, index) => ({
      id: line.id,
      seq: line.seq,
      item: { code: line.item.code, name: line.item.name },
      colour: line.colour?.name ?? null,
      asked: { quantity: line.quantity, uom: line.uom, needDate: line.needDate },
      proposed: proposed
        ? index === 0
          ? { kind: 'SPLIT', quantity: '220.0000', date: '2026-11-18', deliveries: [{ quantity: '220.0000', date: '2026-11-18' }, { quantity: '200.0000', date: '2026-11-27' }], reason: 'Seconda tintura in arrivo', changes: ['SPLIT', 'LATER'] }
          : { kind: 'AS_ASKED', quantity: line.quantity, date: line.needDate, deliveries: [], reason: null, changes: [] }
        : null,
      confirmed: line.confirmedQuantity ? { quantity: line.confirmedQuantity, date: line.confirmedDate } : null,
      changes: proposed && index === 0 ? ['SPLIT', 'LATER'] : [],
    })),
    evidence: value.sentAt ? [{ linkId: uid('6363', 1), action: 'OPENED', at: at(27, 15, 3), useNumber: null, typedName: null }, ...(value.confirmedAt || proposed ? [{ linkId: uid('6363', 1), action: 'CONFIRMED', at: at(28, 8, 40), useNumber: 1, typedName: 'Marta Demo' }] : [])] : [],
    links: value.confirmLinks,
  }
}

export const DOCUMENTS = (value: PurchaseOrder): OrderDocuments => ({
  revision: 1,
  status: value.status,
  sentAt: value.sentAt,
  documents: value.sentAt ? [{ fileId: uid('6464', 1), name: 'PO-2026-0003.pdf', sha256: 'ab12', sizeBytes: 84_220, status: 'AVAILABLE', createdAt: value.sentAt }] : [],
  links: value.confirmLinks,
  mails: value.sentAt ? [{ id: uid('6565', 1), to: ['ordini@conceria-demo.example.com'], cc: [], subject: 'Ordine PO-2026-0003', status: 'DELIVERED', queuedAt: value.sentAt, sentAt: value.sentAt, deliveredAt: value.sentAt, failedAt: null }] : [],
})

export const RECEIPTS: OrderReceipt[] = [
  { id: uid('6301', 21), number: 'GR-2026-0021', status: 'POSTED', supplierDdtNumber: 'DDT-DEMO-554', supplierDdtDate: '2026-10-29', receivedAt: at(29, 8, 15), lines: 2, lots: 2, lotsReleased: 1, hides: 9, quantities: [{ uom: 'FT2', baseQuantity: '212.4000' }, { uom: 'PCS', baseQuantity: '24.0000' }], postedAt: at(29, 8, 20) },
]

// ---- the list -----------------------------------------------------------------------------------------------------------------

const row = (n: number, status: PoStatus, supplier: keyof typeof SUPPLIERS, over: Partial<OrderRow> = {}): OrderRow => ({
  id: uid('5801', n),
  number: `PO-2026-${String(n).padStart(4, '0')}`,
  companyId: SITE.companyId,
  siteId: SITE.id,
  partyId: SUPPLIERS[supplier].id,
  supplierName: SUPPLIERS[supplier].legalName,
  status,
  revision: 1,
  currency: 'EUR',
  orderDate: '2026-10-27',
  requestedDate: '2026-11-18',
  earliestNeedDate: '2026-11-20',
  latestConfirmedDate: ['CONFIRMED', 'PARTLY_RECEIVED', 'RECEIVED'].includes(status) ? '2026-11-18' : null,
  lineCount: 2,
  netAmount: 192_000,
  sentAt: status === 'DRAFT' ? null : at(27, 10, 12),
  confirmedAt: ['CONFIRMED', 'PARTLY_RECEIVED', 'RECEIVED'].includes(status) ? at(28, 8, 40) : null,
  confirmedVia: ['CONFIRMED', 'PARTLY_RECEIVED', 'RECEIVED'].includes(status) ? 'LINK' : null,
  confirmedByName: ['CONFIRMED', 'PARTLY_RECEIVED', 'RECEIVED'].includes(status) ? 'Marta Demo' : null,
  declinedAt: status === 'DECLINED' ? at(28, 9, 5) : null,
  updatedAt: at(28, 9),
  version: 3,
  ...over,
})

export const ORDER_ROWS: OrderRow[] = [
  row(9, 'DRAFT', 'tannery', { lineCount: 3, netAmount: 104_120, earliestNeedDate: '2026-11-10' }),
  row(8, 'DRAFT', 'protector', { lineCount: 1, netAmount: 23_400 }),
  row(7, 'SENT', 'fabric', { sentAt: at(29, 8, 10), netAmount: 11_850 }),
  row(6, 'SENT', 'tannery', { sentAt: at(25, 14, 0), netAmount: 16_800, earliestNeedDate: '2026-12-03' }),
  row(5, 'CHANGES_PROPOSED', 'tannery', { netAmount: 88_200 }),
  row(4, 'CONFIRMED', 'protector', { netAmount: 31_200, revision: 2 }),
  row(3, 'PARTLY_RECEIVED', 'tannery'),
  row(2, 'RECEIVED', 'fabric', { netAmount: 9_480 }),
  row(1, 'DECLINED', 'prospect', { netAmount: 44_100 }),
]

export const ORDER_SUMMARY: OrderSummary = { drafts: 2, waiting: 2, notConfirmedAfter48h: 1, changesProposed: 1, declined: 1 }
