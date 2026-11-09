/**
 * The record conversation's rules the frame says in its own words (B-W2b-168's composer reasons; pure, held by
 * model.vitest.test.ts against factory-domain's constants: the domain's thread rules reach `node:crypto`, so a browser module
 * never imports them).
 */

/** The longest message (factory-domain threads/rules MAX_BODY_LENGTH): the Textarea counts toward it, never blocks. */
export const THREAD_BODY_LIMIT = 20_000

/** Why the person may not write here, as the words' key (factory-domain threads/partner COMPOSER_REASONS). */
export function threadHeldKey(reason: string | null): string {
  if (reason === 'PREVIEW' || reason === 'NO_COMMENT' || reason === 'CLOSED') return `thread.held.${reason}`
  return 'thread.held.other'
}

/** The record types a portal person can open (factory-domain search/partner views, THREAD_RECORDS), by their words' key. */
// B-W2b-197: a customer's return and complaint (their own partner views: Messages, search).
export const RECORD_TYPE_WORDS: readonly string[] = ['SalesOrder', 'Quote', 'Shipment', 'Invoice', 'Ddt', 'PurchaseOrder', 'SubcontractOrder', 'ShipNotice', 'Party', 'ReturnAuthorisation', 'Complaint']

/** The words' key of a record type ("Order", "Purchase order"); an unknown type is "Record". */
export const recordTypeKey = (type: string): string => (RECORD_TYPE_WORDS.includes(type) ? `record.type.${type}` : 'record.type.other')
