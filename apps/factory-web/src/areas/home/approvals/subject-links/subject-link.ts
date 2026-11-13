import { recordAddress } from '../../../../lib/records/record-links'
import type { TaskRow } from '../api'

/**
 * Where a request of the approval engine opens (B-W2b-382; follow-up XF7:02, on B-W2b-377's `record.parent`): the page of its
 * record, and for a subject with no page of its own the page of the record that shows it — a credit check (CREDIT_OVERRIDE)
 * opens its held order, quote, work order or shipment; a supplier's bank account (SUPPLIER_BANK_CHANGE) the supplier's Bank
 * details tab; a return line (CREDIT_WITHOUT_RETURN) its return; a receipt line (RECEIPT_OVER_TOLERANCE) its receipt — never
 * only the record panels. The inbox's rows and the review's "Open full page" use it, also when the review is opened alone
 * (`?open=<id>` from the bell or Today, its row not in the list). PURE.
 */
export function subjectAddress(task: Pick<TaskRow, 'record' | 'companyId' | 'siteId'>, prefix: string, built: ReadonlySet<string>): string {
  const subject = task.record.parent ?? task.record
  return `${prefix}${recordAddress({ type: subject.type, id: subject.id, companyId: task.companyId, siteId: task.siteId }, built)}`
}
