import { z } from 'zod'
import { defineEvent } from '../events/define'
import { PURCHASE_ORDER_STATUSES } from './orders'
import { SOURCE_PREFERENCES } from './sources/sources'
import { SUBCONTRACT_ORDER_STATUSES } from './subcontracting/rules'
import { CLAIM_KINDS, CLAIM_STATUSES } from './claims/rules'

/**
 * The purchasing module's events (plan A1 §3.4, §3.5; SCM-050, SCM-053, SCM-055; design 02 "Purchase orders", Live).
 * apps/factory-api's modules/purchasing emits them in the command that makes the change; the office screens that may see
 * the order (purchasing.view over its company and site) refresh the list and the record. Ids, numbers, counts and states
 * only: no quantity, no price (a purchase price is a cost).
 *
 *   purchase_order.created         a draft was made (by hand, or by "Draft PO" from the plan)
 *   purchase_order.updated         a draft's header changed
 *   purchase_order.lines_changed   a draft's lines were added, changed or removed
 *   purchase_order.sent            the order went to the supplier: PDF stored, confirm link made, mail queued
 *   purchase_order.link_sent       a new confirm link went to the supplier (the live ones stopped working)
 *   purchase_order.cancelled       the order was cancelled (a sent one: its links stopped working, the supplier is told)
 *   purchase_order.confirmed       the supplier confirmed it (B-W1-31: through its link, every line as asked)
 *   purchase_order.declined        the supplier declined it through its link (B-W1-31)
 *   purchase_order.changes_proposed  the supplier answered its link with changes: they wait for the buyer (B-W1-31)
 *   purchase_order.proposal_refused  the buyer refused them: the order waits for the supplier again (B-W1-31)
 *   (the buyer's acceptance is purchase_order.confirmed with proposalAccepted)
 *   supplier_item.created | updated | archived   an approved source of a material was added, changed (or approved
 *                                  again), archived (B-W2a-10; modules/purchasing/supplier-items)
 *   purchase_requests.converted    requests to buy were drafted into a purchase order (B-W2a-10; one per order touched)
 *   subcontract_order.created | updated | issued | reopened | cancelled | kit_sent | kit_returned | received | closed
 *                                  work sent to a workshop (B-W2a-25; modules/purchasing/subcontracting): made, changed
 *                                  (header, operations, kit plan), issued, back to draft, cancelled, kit and pieces out,
 *                                  a kit line back unsent, goods back, closed. Ids, numbers, counts and states: no fee.
 *   purchase_order.revision_started | lines_cancelled | lines_closed_short | confirm_by_moved | reminder_sent
 *                                  B-W2a-52 (modules/purchasing revisions/, reminders/): the buyer started the next
 *                                  revision (a change, or a counter-proposal to the supplier's changes: the order is a
 *                                  draft again, its links stopped); lines cancelled (the plan lines they bought open
 *                                  again; the supplier told when it holds the order); lines of a partly received order
 *                                  closed short; the confirm-by deadline moved; a reminder to confirm sent (by the buyer,
 *                                  or by the daily run once a company switches automatic reminders on)
 *   supplier_claim.created | updated | sent | answered | goods_returned | closed | cancelled
 *                                  a claim to a supplier (B-W2a-44; modules/purchasing/claims): made (by hand, from
 *                                  discrepancies, from a lot, or as a Return to supplier), changed (header, lines), sent
 *                                  to the supplier, its answer recorded, goods of a return sent back with the return DDT,
 *                                  closed, cancelled. Ids, numbers, counts and states: no value, no credit amount.
 */
const live = { permission: 'purchasing.view', fields: ['purchaseOrderId', 'number'] } as const
const sourceLive = { permission: 'purchasing.view', fields: ['supplierItemId', 'partyId', 'itemId'] } as const
const base = { purchaseOrderId: z.uuid(), number: z.string().min(1).max(40) }
// B-W2a-25: subcontract orders (the office's list and record refresh; planning's allocation board reads them later).
const subcontractLive = { permission: 'purchasing.view', fields: ['subcontractOrderId', 'number', 'status'] } as const
const subcontract = { subcontractOrderId: z.uuid(), number: z.string().min(1).max(40) }
const subcontractStatus = z.enum(SUBCONTRACT_ORDER_STATUSES)
const pieces = z.number().int().min(0)
// B-W2a-44: supplier claims (the office's Returns & claims list and record refresh; B-W2a-62's credit note matching reads them).
const claimLive = { permission: 'purchasing.view', fields: ['supplierClaimId', 'number', 'status'] } as const
const claim = { supplierClaimId: z.uuid(), number: z.string().min(1).max(40), status: z.enum(CLAIM_STATUSES) }
// B-W2a-52: a purchase order's changes (the office's list and record refresh).
const orderStatus = z.enum(PURCHASE_ORDER_STATUSES)
const endedLineIds = z.array(z.uuid()).min(1).max(200)

export const events = [
  defineEvent({
    type: 'purchase_order.created',
    context: 'purchasing',
    description: 'A draft purchase order was made, by hand or from the lines of a plan.',
    payload: z.strictObject({ ...base, partyId: z.uuid(), siteId: z.uuid(), source: z.enum(['OFFICE', 'PLAN']) }),
    live,
  }),
  defineEvent({
    type: 'purchase_order.updated',
    context: 'purchasing',
    description: "A draft purchase order's header changed (contact, dates, terms, notes).",
    payload: z.strictObject({ ...base, fields: z.array(z.string().min(1).max(40)).max(20) }),
    live,
  }),
  defineEvent({
    type: 'purchase_order.lines_changed',
    context: 'purchasing',
    description: "A draft purchase order's lines were added, changed or removed.",
    payload: z.strictObject({ ...base, added: z.number().int().min(0), changed: z.number().int().min(0), removed: z.number().int().min(0), lines: z.number().int().min(0) }),
    live,
  }),
  defineEvent({
    type: 'purchase_order.sent',
    context: 'purchasing',
    description: 'A purchase order was sent to its supplier: its PDF stored, a one-off confirm link made and the mail queued on its thread.',
    payload: z.strictObject({ ...base, revision: z.number().int().min(1), partyId: z.uuid(), documentFileId: z.uuid(), linkId: z.uuid(), outboundId: z.uuid() }),
    live,
  }),
  defineEvent({
    type: 'purchase_order.link_sent',
    context: 'purchasing',
    description: 'A new confirm link of a sent purchase order went to the supplier; the older live ones stopped working.',
    payload: z.strictObject({ ...base, linkId: z.uuid(), revokedLinkIds: z.array(z.uuid()).max(100), outboundId: z.uuid() }),
    live,
  }),
  defineEvent({
    type: 'purchase_order.confirmed',
    context: 'purchasing',
    description: 'The supplier confirmed a purchase order: through its confirm link, or by accepting its proposed changes; the worker tells the buyer on the thread.',
    payload: z.strictObject({ ...base, partyId: z.uuid(), channel: z.enum(['LINK', 'OFFICE']), linkId: z.uuid().nullable(), lines: z.number().int().min(0), proposalAccepted: z.boolean() }),
    live,
  }),
  defineEvent({
    type: 'purchase_order.declined',
    context: 'purchasing',
    description: 'The supplier declined a purchase order through its confirm link; the worker tells the buyer on the thread.',
    payload: z.strictObject({ ...base, partyId: z.uuid(), linkId: z.uuid() }),
    live,
  }),
  defineEvent({
    type: 'purchase_order.changes_proposed',
    context: 'purchasing',
    description: 'The supplier answered its confirm link with changes (other quantities or dates, a split, a line it cannot deliver); the buyer accepts or refuses them; the worker tells the buyer on the thread.',
    payload: z.strictObject({ ...base, partyId: z.uuid(), linkId: z.uuid(), lines: z.number().int().min(0), changed: z.number().int().min(0) }),
    live,
  }),
  defineEvent({
    type: 'purchase_order.proposal_refused',
    context: 'purchasing',
    description: "The buyer refused the supplier's proposed changes: nothing is confirmed, the order waits for the supplier again (a new link) or is cancelled.",
    payload: z.strictObject({ ...base, partyId: z.uuid() }),
    live,
  }),
  defineEvent({
    type: 'purchase_order.cancelled',
    context: 'purchasing',
    description: 'A purchase order was cancelled; a sent one stopped its confirm links and the supplier is told.',
    payload: z.strictObject({ ...base, from: z.enum(PURCHASE_ORDER_STATUSES), revokedLinkIds: z.array(z.uuid()).max(100), outboundId: z.uuid().nullable() }),
    live,
  }),
  // B-W2a-10: approved sources (SCM-005) and requests to buy (SCM-034, SCM-036). Ids, codes and counts only: no price.
  defineEvent({
    type: 'supplier_item.created',
    context: 'purchasing',
    description: "A supplier's article became an approved source of a material (its unit, terms and price; a new primary source makes the old one a backup).",
    payload: z.strictObject({ supplierItemId: z.uuid(), partyId: z.uuid(), itemId: z.uuid(), preference: z.enum(SOURCE_PREFERENCES), demotedId: z.uuid().nullable() }),
    live: sourceLive,
  }),
  defineEvent({
    type: 'supplier_item.updated',
    context: 'purchasing',
    description: 'An approved source changed (codes, unit, price, minimum, steps, lead time, primary or backup), or was approved again.',
    payload: z.strictObject({ supplierItemId: z.uuid(), partyId: z.uuid(), itemId: z.uuid(), fields: z.array(z.string().min(1).max(40)).max(20), demotedId: z.uuid().nullable() }),
    live: sourceLive,
  }),
  defineEvent({
    type: 'supplier_item.archived',
    context: 'purchasing',
    description: 'An approved source was archived: no buy suggestion takes it any more (kept, as orders were made from it).',
    payload: z.strictObject({ supplierItemId: z.uuid(), partyId: z.uuid(), itemId: z.uuid() }),
    live: sourceLive,
  }),
  defineEvent({
    type: 'purchase_requests.converted',
    context: 'purchasing',
    description: 'Requests to buy (plan lines, reorder points) were drafted into this purchase order, one line each.',
    payload: z.strictObject({ ...base, created: z.boolean(), requests: z.number().int().min(1), fromPlan: z.number().int().min(0), fromReorder: z.number().int().min(0) }),
    live: { permission: 'purchasing.view', fields: ['purchaseOrderId', 'number', 'requests'] },
  }),
  // B-W2a-25: subcontracting (SCM-138, SCM-140, SCM-141, SCM-142).
  defineEvent({
    type: 'subcontract_order.created',
    context: 'purchasing',
    description: "A draft subcontract order was made for outside operations of a work order (its workshop, pieces, fee and return date).",
    payload: z.strictObject({ ...subcontract, status: subcontractStatus, workOrderId: z.uuid(), partyId: z.uuid(), siteId: z.uuid(), operations: z.number().int().min(0), kitLines: z.number().int().min(0) }),
    live: subcontractLive,
  }),
  defineEvent({
    type: 'subcontract_order.updated',
    context: 'purchasing',
    description: "A subcontract order changed: its header, its operations (pieces, sizes, fee, return date) or its kit plan.",
    payload: z.strictObject({ ...subcontract, status: subcontractStatus, fields: z.array(z.string().min(1).max(40)).max(20) }),
    live: subcontractLive,
  }),
  defineEvent({
    type: 'subcontract_order.issued',
    context: 'purchasing',
    description: 'A subcontract order went to its workshop: its operations and amount are fixed, the kit may go out.',
    payload: z.strictObject({ ...subcontract, status: subcontractStatus, partyId: z.uuid(), operations: z.number().int().min(1), pieces }),
    live: subcontractLive,
  }),
  defineEvent({
    type: 'subcontract_order.reopened',
    context: 'purchasing',
    description: 'An issued subcontract order went back to draft to be changed (nothing of it was out).',
    payload: z.strictObject({ ...subcontract, status: subcontractStatus }),
    live: subcontractLive,
  }),
  defineEvent({
    type: 'subcontract_order.cancelled',
    context: 'purchasing',
    description: 'A subcontract order was cancelled with a reason (nothing of it was out); its planned kit lines too.',
    payload: z.strictObject({ ...subcontract, status: subcontractStatus, from: subcontractStatus }),
    live: subcontractLive,
  }),
  defineEvent({
    type: 'subcontract_order.kit_sent',
    context: 'purchasing',
    description: "Kit lines and pieces of a subcontract order went out: the material moved into the workshop's stock location (still ours), with the DDT for work on our behalf when one was issued.",
    payload: z.strictObject({ ...subcontract, status: subcontractStatus, kitLineIds: z.array(z.uuid()).max(200), moveIds: z.array(z.uuid()).max(200), pieces, bundles: z.number().int().min(0), ddtId: z.uuid().nullable() }),
    live: subcontractLive,
  }),
  defineEvent({
    type: 'subcontract_order.kit_returned',
    context: 'purchasing',
    description: "A sent kit line of a subcontract order came back unsent: its transfer reversed, the line planned again.",
    payload: z.strictObject({ ...subcontract, status: subcontractStatus, kitLineId: z.uuid(), moveId: z.uuid() }),
    live: subcontractLive,
  }),
  defineEvent({
    type: 'subcontract_order.received',
    context: 'purchasing',
    description: 'Goods came back from the workshop (pieces good, defective and scrapped there, bundle by bundle) and/or unused material it returned.',
    payload: z.strictObject({ ...subcontract, status: subcontractStatus, receiptId: z.uuid(), good: pieces, defective: pieces, scrapped: pieces, bundles: z.number().int().min(0), returnedLines: z.number().int().min(0) }),
    live: subcontractLive,
  }),
  defineEvent({
    type: 'subcontract_order.closed',
    context: 'purchasing',
    description: 'A subcontract order whose goods are all back was closed.',
    payload: z.strictObject({ ...subcontract, status: subcontractStatus }),
    live: subcontractLive,
  }),
  // B-W2a-44: supplier claims and returns to the supplier.
  defineEvent({
    type: 'supplier_claim.created',
    context: 'purchasing',
    description: 'A claim to a supplier was made: typed, from the discrepancies of a receipt, from a lot, or as a Return to supplier.',
    payload: z.strictObject({ ...claim, kind: z.enum(CLAIM_KINDS), partyId: z.uuid(), siteId: z.uuid(), lines: z.number().int().min(0), source: z.enum(['OFFICE', 'DISCREPANCIES', 'LOT', 'RETURN']) }),
    live: claimLive,
  }),
  defineEvent({
    type: 'supplier_claim.updated',
    context: 'purchasing',
    description: "A supplier claim changed: its header (reason, remedy, credit asked, notes) or a draft's lines.",
    payload: z.strictObject({ ...claim, fields: z.array(z.string().min(1).max(40)).max(20) }),
    live: claimLive,
  }),
  defineEvent({
    type: 'supplier_claim.sent',
    context: 'purchasing',
    description: "A supplier claim was sent: by e-mail on the claim's thread (the mail queued), or told to the supplier another way.",
    payload: z.strictObject({ ...claim, again: z.boolean(), outboundId: z.uuid().nullable(), recipients: z.number().int().min(0) }),
    live: claimLive,
  }),
  defineEvent({
    type: 'supplier_claim.answered',
    context: 'purchasing',
    description: "The supplier's answer to a claim was recorded: accepted (a credit or a replacement comes) or rejected.",
    payload: z.strictObject({ ...claim, remedy: z.enum(['CREDIT', 'REPLACEMENT']).nullable() }),
    live: claimLive,
  }),
  defineEvent({
    type: 'supplier_claim.goods_returned',
    context: 'purchasing',
    description: 'Goods of a return claim went back to the supplier: their stock left the site, with the return DDT.',
    payload: z.strictObject({ ...claim, lineIds: z.array(z.uuid()).max(200), moveIds: z.array(z.uuid()).max(200), ddtId: z.uuid().nullable() }),
    live: claimLive,
  }),
  defineEvent({
    type: 'supplier_claim.closed',
    context: 'purchasing',
    description: 'A supplier claim was closed: settled (credit or replacement received) or given up.',
    payload: z.strictObject({ ...claim, discrepanciesClosed: z.number().int().min(0) }),
    live: claimLive,
  }),
  defineEvent({
    type: 'supplier_claim.cancelled',
    context: 'purchasing',
    description: 'A draft supplier claim was cancelled.',
    payload: z.strictObject(claim),
    live: claimLive,
  }),
  // B-W2a-52: a purchase order's changes after the send (SCM-058, SCM-059, SCM-060, SCM-087). Ids, numbers, counts and
  // states only: no quantity, no price.
  defineEvent({
    type: 'purchase_order.revision_started',
    context: 'purchasing',
    description: 'The buyer started the next revision of a sent purchase order (a change, or a counter-proposal to the supplier’s changes): it is a draft again and its confirm links stopped working.',
    payload: z.strictObject({ ...base, revision: z.number().int().min(2), from: orderStatus, counterProposal: z.boolean(), revokedLinkIds: z.array(z.uuid()).max(100) }),
    live,
  }),
  defineEvent({
    type: 'purchase_order.lines_cancelled',
    context: 'purchasing',
    description: 'Lines of a purchase order were cancelled: nothing more of them is wanted; the plan lines they bought are open again and the supplier is told when it holds the order.',
    payload: z.strictObject({ ...base, lineIds: endedLineIds, from: orderStatus, to: orderStatus, reopenedRequirementIds: z.array(z.uuid()).max(400), outboundId: z.uuid().nullable() }),
    live,
  }),
  defineEvent({
    type: 'purchase_order.lines_closed_short',
    context: 'purchasing',
    description: 'Lines of a partly received purchase order were closed short: what came is kept, the rest will not come.',
    payload: z.strictObject({ ...base, lineIds: endedLineIds, from: orderStatus, to: orderStatus, reopenedRequirementIds: z.array(z.uuid()).max(400), outboundId: z.uuid().nullable() }),
    live,
  }),
  defineEvent({
    type: 'purchase_order.confirm_by_moved',
    context: 'purchasing',
    description: 'The office moved the time by which the supplier is asked to confirm a sent purchase order.',
    payload: z.strictObject({ ...base, confirmBy: z.iso.datetime() }),
    live,
  }),
  defineEvent({
    type: 'purchase_order.reminder_sent',
    context: 'purchasing',
    description: 'A reminder to confirm a purchase order went to its supplier, by the buyer or by the daily run of the automatic reminders.',
    payload: z.strictObject({ ...base, revision: z.number().int().min(1), reminderId: z.uuid(), outboundId: z.uuid(), automatic: z.boolean() }),
    live,
  }),
] as const
