import { at, SUPPLIERS, uid } from '../../../../_shared/buying/fixtures'
import type { OrderReach, OrderReminders, OrderRevisions, PurchaseOrder, ReachAction, SendCard, SendOutcome } from '../../api'
import { leatherLine, order, ORDER_ID, protectorLine } from '../fixtures'

/**
 * Made-up data for B-W2a-69's parts of SCR-058 / SCR-059 (purchasing every day): the revisions of PO-2026-0003 (sent,
 * changed to revision 2, sent again), the reminders, the reach of a cancel and a close short, and Send n's cards and
 * outcomes. Every number is invented and worked out by hand. Design-only; it exports no `designScreen`.
 */

const WORK_ORDER = { id: uid('7001', 221), number: 'WO-2026-0221' }
const WORK_ORDER_2 = { id: uid('7001', 225), number: 'WO-2026-0225' }
const SALES_ORDER = { id: uid('3801', 43), number: 'SO-2026-1043' }

/** Revision 1 sent and confirmed; nothing else yet. */
export function revisionsOne(value: PurchaseOrder = order('CONFIRMED')): OrderRevisions {
  return {
    purchaseOrderId: value.id,
    number: value.number,
    revision: 1,
    status: value.status,
    draft: null,
    revisions: [
      {
        id: uid('6801', 1),
        revision: 1,
        documentNumber: 'PO-2026-0003',
        sentAt: at(27, 10, 12),
        sentById: uid('3333', 1),
        sentByName: 'Giulia Demo',
        changeNote: null,
        documentFileId: uid('6464', 1),
        changes: { header: [], lines: [], count: 0 },
        words: [],
        answer: value.status === 'SENT' ? 'WAITING' : 'CONFIRMED',
        confirmation: value.status === 'SENT' ? null : { at: at(28, 8, 40), via: 'LINK', byName: 'Marta Demo', supplierRef: 'CONF-DEMO-118' },
        lines: 2,
        prices: { before: null, after: { currency: 'EUR', netAmount: 192_000, lines: [] }, changed: { netAmount: null, lines: [] } },
      },
    ],
  }
}

/** Changed after the confirmation: the draft of revision 2 raises the leather to 560 ft² and cancels the protectors. */
export function revisionsDraftTwo(): OrderRevisions {
  const one = revisionsOne(order('CONFIRMED')).revisions[0]!
  return {
    purchaseOrderId: ORDER_ID,
    number: 'PO-2026-0003',
    revision: 2,
    status: 'DRAFT',
    draft: {
      revision: 2,
      documentNumber: 'PO-2026-0003/2',
      changes: {
        header: [{ field: 'requestedDate', before: '2026-11-18', after: '2026-11-25' }],
        lines: [
          { lineId: leatherLine().id, seq: 10, itemId: leatherLine().itemId, kind: 'CHANGED', changes: [{ field: 'quantity', before: '420.0000 FT2', after: '560.0000 FT2' }] },
          { lineId: protectorLine().id, seq: 20, itemId: protectorLine().itemId, kind: 'CANCELLED', changes: [] },
        ],
        count: 3,
      },
      words: [],
    },
    revisions: [{ ...one, answer: 'CONFIRMED' }],
  }
}

/** Revision 2 sent with its note and confirmed again: two versions, the diff and its price change. */
export function revisionsTwo(): OrderRevisions {
  const draft = revisionsDraftTwo()
  const one = draft.revisions[0]!
  return {
    ...draft,
    status: 'CONFIRMED',
    draft: null,
    revisions: [
      one,
      {
        id: uid('6801', 2),
        revision: 2,
        documentNumber: 'PO-2026-0003/2',
        sentAt: at(29, 11, 5),
        sentById: uid('3333', 1),
        sentByName: 'Giulia Demo',
        changeNote: 'Più pelli per l’ordine del cliente; le protezioni arrivano da un altro fornitore.',
        documentFileId: uid('6464', 2),
        changes: draft.draft!.changes,
        words: [],
        answer: 'CONFIRMED',
        confirmation: { at: at(29, 15, 20), via: 'LINK', byName: 'Marta Demo', supplierRef: 'CONF-DEMO-131' },
        lines: 2,
        prices: {
          before: { currency: 'EUR', netAmount: 192_000, lines: [] },
          after: { currency: 'EUR', netAmount: 235_200, lines: [] },
          changed: { netAmount: { before: 192_000, after: 235_200 }, lines: [{ lineId: leatherLine().id, seq: 10, unitPrice: null, netAmount: { before: 176_400, after: 235_200 } }] },
        },
      },
    ],
  }
}

/** The reminders of a sent order: the confirm-by passed, one reminder by hand, the Owner's switch off. */
export function remindersOf(value: PurchaseOrder, over: Partial<OrderReminders> = {}): OrderReminders {
  const sent = value.status === 'SENT'
  return {
    purchaseOrderId: value.id,
    number: value.number,
    status: value.status,
    revision: value.revision,
    automatic: false,
    confirmBy: value.confirmBy ?? null,
    overdue: sent && !!value.confirmBy && Date.parse(value.confirmBy) < Date.parse(at(30, 9, 0)),
    sentForRevision: sent ? 1 : 0,
    nextAutomaticAt: null,
    reminders: sent
      ? [{ id: uid('6901', 1), revision: value.revision, kind: 'CONFIRMATION', sentAt: at(29, 16, 2), automatic: false, sentById: uid('3333', 1), sentByName: 'Giulia Demo', to: 'ordini@conceria-demo.example.com', emailId: uid('6565', 9), mailStatus: 'SENT', note: null }]
      : [],
    ...over,
  }
}

/** A sent order past its confirm-by (asked for 29 Oct 10:12, now 30 Oct). */
export const SENT_PAST: () => PurchaseOrder = () => order('SENT', { confirmBy: at(29, 10, 12), version: 5 })

/** What a cancel or a close short reaches: the leather pegged by two work orders and a customer order, its plan line. */
export function reachOf(action: ReachAction, value: PurchaseOrder, over: Partial<OrderReach> = {}): OrderReach {
  const lines = action === 'CLOSE_SHORT' ? value.lines.filter((line) => line.seq === 10) : value.lines
  return {
    action,
    status: value.status,
    allowed: true,
    problems: [],
    mayDo: true,
    supplierTold: value.status !== 'DRAFT' || value.revision > 1,
    confirmed: value.status === 'CONFIRMED',
    runId: uid('5501', 14),
    lines: lines.map((line) => {
      const ordered = Number(line.baseQuantity)
      const received = Number(line.receivedBaseQuantity)
      return {
        lineId: line.id,
        seq: line.seq,
        baseUom: line.baseUom,
        orderedBase: line.baseQuantity,
        receivedBase: line.receivedBaseQuantity,
        outstandingBase: Math.max(0, ordered - received).toFixed(4),
        planLineIds: line.plan.map((plan) => plan.requirementId),
        pegged:
          line.seq === 10
            ? [
                { kind: 'WORK_ORDER', workOrder: WORK_ORDER, salesOrder: SALES_ORDER, size: null, demandDate: '2026-11-24', quantity: '210.0000' },
                { kind: 'WORK_ORDER', workOrder: WORK_ORDER_2, salesOrder: null, size: null, demandDate: '2026-11-27', quantity: '140.0000' },
              ]
            : [],
      }
    }),
    workOrders: [WORK_ORDER, WORK_ORDER_2],
    salesOrders: [SALES_ORDER],
    ...over,
  }
}

const card = (n: number, supplier: keyof typeof SUPPLIERS, over: Partial<SendCard> = {}): SendCard => ({
  id: uid('5801', n),
  number: `PO-2026-${String(n).padStart(4, '0')}`,
  partyId: SUPPLIERS[supplier].id,
  status: 'DRAFT',
  version: 2,
  ready: true,
  checks: [],
  recipient: { contactId: uid('6161', n), name: 'Ufficio ordini', email: `ordini@${supplier}-demo.example.com` },
  documentNumber: `PO-2026-${String(n).padStart(4, '0')}`,
  language: supplier === 'fabric' ? 'en' : 'it',
  linkExpiresAt: at(20, 22, 59, 11),
  subject: `Ordine PO-2026-${String(n).padStart(4, '0')}`,
  message: null,
  confirmBy: at(30, 12, 0, 10),
  revision: 1,
  changes: null,
  refused: null,
  ...over,
})

/** Send n: three drafts of two suppliers, one held by a line without a price, one not a draft any more. */
export const SEND_CARDS: SendCard[] = [
  card(9, 'tannery'),
  card(10, 'tannery', { revision: 2, documentNumber: 'PO-2026-0010/2', changes: ['Riga 10: quantità 105 ft² → 140 ft²'] }),
  card(8, 'protector', { ready: false, checks: [{ code: 'LINE_NOT_PRICED', severity: 'BLOCKS', path: 'lines/0/unitPrice' }] }),
  card(7, 'fabric', { status: 'SENT', ready: false }),
]

export const SEND_OUTCOMES: SendOutcome[] = [
  { id: uid('5801', 9), number: 'PO-2026-0009', outcome: 'SENT', sent: { revision: 1, sentAt: at(30, 9, 41), documentFileId: uid('6464', 9), to: 'ordini@tannery-demo.example.com', link: { id: uid('6363', 9), expiresAt: at(20, 22, 59, 11) }, emailId: uid('6565', 19), confirmBy: at(30, 12, 0, 10) }, delivery: 'sent', refused: null },
  { id: uid('5801', 10), number: 'PO-2026-0010', outcome: 'REFUSED', sent: null, delivery: null, refused: { code: 'conflict', message: 'changed', issues: [] } },
]
