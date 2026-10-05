/**
 * Approvals grid (docs/approvals-grid/PLAN.md §5; Owner decision 1 = A, 2026-10-05) — which kinds of change may be
 * approved together in one bulk approve.
 *
 * The bulk rule as a whole lives in approval-inbox.service.ts (previewBulk / bulkDecide): one kind and one worker per
 * bulk approve, at most BULK_MAX_IDS rows, each row approved through exactly the same path as a single approve (the stop
 * window, then the commit's re-checks of staleness, the approver's permission and the rule). This file answers only
 * "may requests of this kind be in a bulk approve at all?", for the inbox and for the queue rows (`bulkApprovable`).
 *
 * Never in a bulk approve:
 *   - a change plan: each plan is approved on its own (it already bundles many changes behind one approve);
 *   - a kind the registry says cannot be undone (`reversibility: 'none'`), or one it does not know;
 *   - NEVER_IN_BULK below: kinds that reach a buyer or a supplier, spend money, or remove something, even when the
 *     registry says they can be partly or fully put back. Each has its one-line why.
 * Bulk REJECT is never limited by kind: saying no to many things at once changes nothing.
 */
import { getTool } from '../agents/tool-registry.js'
import { PLAN_TOOL } from '../agents/tool-types.js'

/** The most requests one bulk call (approve or reject) decides. UiPath caps its bulk actions at 100; plans hold 200. */
export const BULK_MAX_IDS = 200

/**
 * Kinds that are never approved together, whatever their registry reversibility, each with the sentence a person
 * reads. Every name is a registered tool (bulk-approve-policy.vitest.test.ts holds that).
 */
export const NEVER_IN_BULK: Readonly<Record<string, string>> = {
  // Money to a buyer.
  'issue-refund': 'A refund sends the buyer money and cannot be taken back, so each one is approved on its own.',
  // Words that reach a buyer, a supplier or the public: they cannot be recalled.
  'send-customer-message': 'A message to a buyer cannot be recalled once it is sent, so each one is approved on its own.',
  'email-supplier': 'An e-mail to a supplier cannot be recalled once it is sent, so each one is approved on its own.',
  'reply-to-review': 'A public reply to a review cannot be recalled once it is posted, so each one is approved on its own.',
  'request-review': 'A review request reaches the buyer and cannot be recalled, so each one is approved on its own.',
  // Cancels.
  'cancel-order': 'Cancelling an order reaches the buyer and cannot be undone, so each one is approved on its own.',
  'cancel-purchase-order': 'Cancelling a purchase order cannot be undone, so each one is approved on its own.',
  // Taking something off sale, or removing it.
  'close-listing': 'Closing an offer takes it off sale on the marketplace, so each one is approved on its own.',
  'end-listing': 'Ending a listing takes it off sale on the marketplace, and on eBay its relist gets a new item number, so each one is approved on its own.',
  'relist-listing': 'Relisting puts a listing on sale again, on eBay under a new item number that may cost a fee, so each one is approved on its own.',
  'unlink-channel-id': 'Unlinking a channel id cuts the product off from its live listing, so each one is approved on its own.',
  'remove-draft-listings': 'Removing draft listings deletes them, so each request is approved on its own.',
  'discard-new-products': 'Discarding new products removes them from the catalog, so each request is approved on its own.',
  'remove-unused-photo': 'Removing a photo deletes it and can only be partly undone, so each one is approved on its own.',
  'merge-duplicate-products': 'Merging folds one product into another and can only be partly undone, so each one is approved on its own.',
  'dispose-return-items': 'Restocking or scrapping returned items cannot be undone, so each one is approved on its own.',
  // Money spent with, or cancelled at, a carrier.
  'buy-shipping-label': 'Buying a shipping label spends money with the carrier, so each one is approved on its own.',
  'void-shipping-label': 'Voiding a shipping label cancels it at the carrier, so each one is approved on its own.',
}

/** Null when requests of this tool may be approved in a bulk approve; otherwise one plain sentence why not. */
export function bulkApproveRefusal(toolName: string): string | null {
  if (toolName === PLAN_TOOL) return 'A change plan is approved on its own: open it to see its steps, then approve it there.'
  const tool = getTool(toolName)
  if (!tool) return 'Nexus does not know this kind of change, so it cannot be approved together with others.'
  if (tool.control || tool.readOnly) return 'This is not a change request, so it cannot be approved together with others.'
  const never = NEVER_IN_BULK[toolName]
  if (never) return never
  // A change tool that states no reversibility is treated as irreversible, the safe direction (reversibilityOf).
  if ((tool.reversibility ?? 'none') === 'none') return `${tool.title} cannot be undone once it runs, so each one is approved on its own.`
  return null
}
