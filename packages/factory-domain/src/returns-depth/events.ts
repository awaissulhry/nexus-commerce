import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * Returns in depth (B-W2b-341; SAL-336, SAL-337, SAL-338, SAL-342, SAL-343, SAL-346). apps/factory-api's
 * modules/sales/returns-depth emits them in the command that makes the change. Their own module folder (as
 * portal-returns/events.ts; check-event-contract wants src/<module>/events.ts): the rules are factory-domain
 * sales/returns-depth. The decision with its fee is W2a's `return.decided`; a credit without the goods also emits W2a's
 * `return.credit_due` (the credit note's worker listens to it); the yes it may wait for is the approval engine's
 * `approval.requested` / `approval.decided` (kind CREDIT_WITHOUT_RETURN, record ReturnLine).
 *
 *   return_policy.saved            a company's return policy for one channel was made (retiring the live one), changed
 *                                  or retired
 *   return_fee_rule.changed        a restocking or handling fee rule was made, changed, switched on or off
 *   return.policy_checked          an RMA was checked against its company's policy for its channel: the policy it names,
 *                                  whether it is a consumer's withdrawal, the deadline that follows, whether a line was
 *                                  outside the window (taken back anyway, with the reason on the audit row)
 *   return.garment_named           the serial and lot of ours were named on return lines: from the shipment by the office,
 *                                  or scanned at the dock
 *   return.credited_without_return lines were credited without the goods coming back (at once, or on the approver's yes)
 *   return.scan_code_set           the RMA got the scan code its papers print (the dock's "Scan the return" reads it)
 *
 * Reach the office's returns screens (sales.returns.view over the RMA's company and site): ids, numbers, codes and flags
 * only; never an amount or a name.
 */

const live = { permission: 'sales.returns.view' } as const
const channel = z.enum(['B2B', 'CONSUMER_DISTANCE'])

export const events = [
  defineEvent({
    type: 'return_policy.saved',
    context: 'returns-depth',
    description: "A company's return policy for one channel (business customers, or consumers who bought at a distance) was made (retiring the live one), changed or retired.",
    payload: z.strictObject({ policyId: z.uuid(), companyId: z.uuid(), channel, change: z.enum(['CREATED', 'CHANGED', 'RETIRED']), replacedId: z.uuid().nullable(), fields: z.array(z.string()) }),
    live: { ...live, fields: ['policyId', 'companyId', 'channel', 'change'] },
  }),
  defineEvent({
    type: 'return_fee_rule.changed',
    context: 'returns-depth',
    description: 'A restocking or handling fee rule of a company was made, changed, switched on or switched off.',
    payload: z.strictObject({ ruleId: z.uuid(), companyId: z.uuid(), change: z.enum(['CREATED', 'CHANGED', 'SWITCHED_ON', 'SWITCHED_OFF']), active: z.boolean(), fields: z.array(z.string()) }),
    live: { ...live, fields: ['ruleId', 'companyId', 'change', 'active'] },
  }),
  defineEvent({
    type: 'return.policy_checked',
    context: 'returns-depth',
    description: "A customer return was checked against its company's return policy for its channel: the policy it names, whether it is a consumer's withdrawal, the deadline for the goods that follows, and whether a line was outside the window.",
    payload: z.strictObject({ returnId: z.uuid(), number: z.string(), policyId: z.uuid(), channel, withdrawal: z.boolean(), goodsDueBy: z.iso.date().nullable(), outsideWindow: z.boolean() }),
    live: { ...live, fields: ['returnId', 'number', 'policyId', 'withdrawal', 'goodsDueBy'] },
  }),
  defineEvent({
    type: 'return.garment_named',
    context: 'returns-depth',
    description: 'The serial and the lot of ours were named on lines of a customer return: from the shipment by the office, or scanned at the dock.',
    payload: z.strictObject({ returnId: z.uuid(), number: z.string(), lineIds: z.array(z.uuid()), via: z.enum(['OFFICE', 'DOCK']) }),
    live: { ...live, floor: 'sales.returns.receive', fields: ['returnId', 'number', 'lineIds', 'via'] },
  }),
  defineEvent({
    type: 'return.credited_without_return',
    context: 'returns-depth',
    description: "Lines of a customer return were credited without the goods coming back (CREDIT_ONLY), at once or on the approver's yes: the credit note can be made.",
    payload: z.strictObject({ returnId: z.uuid(), number: z.string(), partyId: z.uuid(), lineIds: z.array(z.uuid()), approvalTaskId: z.uuid().nullable() }),
    live: { ...live, fields: ['returnId', 'number', 'lineIds'] },
  }),
  defineEvent({
    type: 'return.scan_code_set',
    context: 'returns-depth',
    description: 'A customer return got the scan code printed as a barcode on its RMA sheet and box label (the dock scans it to open the return).',
    payload: z.strictObject({ returnId: z.uuid(), number: z.string(), scanCode: z.string() }),
    live: { ...live, fields: ['returnId', 'number', 'scanCode'] },
  }),
] as const
