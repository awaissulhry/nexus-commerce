import { LINK_PURPOSES, PURPOSE_RULES, type LinkPurpose } from '@nexus/factory-domain/links/purposes'

/**
 * The link-type registry (PLAN §2.1 navigation files; design 01 view "links": no navigation, one task per page). A valid
 * one-off link opens its module's task page; this says which, by the link's purpose and the type of the record it opens
 * (factory-domain links/purposes: PURPOSE_RULES). Every other valid link — a purpose or a record type no page takes yet —
 * stays on the shared link frame (SCR-028), which says what the link opens and when it expires. Pure, so the navigation
 * test holds it; `shell/links/LinkLanding.tsx` mounts the task.
 *
 *   purpose         record           task                    page
 *   QUOTE_ACCEPT    Quote            quote-accept            links/quote-accept (SCR-099)
 *   DEPOSIT_INFO    DepositRequest   deposit-pay             links/deposit-pay (SCR-199)
 *   PO_CONFIRM      PurchaseOrder    po-confirm              links/po-confirm (SCR-100)
 *   DOCUMENT_VIEW   Shipment         shipment-documents      links/document (SCR-101)
 *   DOCUMENT_VIEW   StoredFile       — the frame (one file; the public DoC and secure-file pages are W2b)
 *   DOCUMENT_VIEW   PayrollExport    — the frame until the secure-file page (SCR-200, W2b-3); its API routes are B-W2b-54's
 *   APPROVAL        ApprovalRequest  approve                 links/approve (SCR-198; B-W2b-188)
 *   JOB_ACCEPT      SubcontractOrder job                     links/job (SCR-196; B-W2b-181)
 *   CLAIM           Shipment         report-problem          links/claim (SCR-197; B-W2b-198)
 *   CLAIM           SalesOrder       report-problem          links/claim (SCR-197; B-W2b-198)
 *   RECORD_INVITE   a shared record  invite                  links/invite (SCR-270; B-W2b-200): Style, Quote, SalesOrder, PurchaseOrder,
 *                                                            SubcontractOrder, Shipment, Complaint, ReturnAuthorisation, SupplierClaim
 *
 * A step that builds a link page adds ONE row here and its component to LinkLanding.
 */

export const LINK_TASKS = [
  'quote-accept',
  'deposit-pay',
  'po-confirm',
  'shipment-documents',
  // B-W2b-188: an approval request (SCR-198).
  'approve',
  // B-W2b-181: a subcontract job to accept (SCR-196).
  'job',
  // B-W2b-198: report a problem with a shipment or an order (SCR-197).
  'report-problem',
  // B-W2b-200: a record a partner is invited to (SCR-270).
  'invite',
] as const
export type LinkTask = (typeof LINK_TASKS)[number]

export interface LinkTaskRule {
  readonly purpose: LinkPurpose
  /** The record type the link opens (one of the purpose's `recordTypes`). */
  readonly recordType: string
  readonly task: LinkTask
}

export const LINK_TASK_RULES: readonly LinkTaskRule[] = Object.freeze([
  { purpose: 'QUOTE_ACCEPT', recordType: 'Quote', task: 'quote-accept' },
  { purpose: 'DEPOSIT_INFO', recordType: 'DepositRequest', task: 'deposit-pay' },
  { purpose: 'PO_CONFIRM', recordType: 'PurchaseOrder', task: 'po-confirm' },
  { purpose: 'DOCUMENT_VIEW', recordType: 'Shipment', task: 'shipment-documents' },
  // B-W2b-188: what we ask a partner to approve (SCR-198).
  { purpose: 'APPROVAL', recordType: 'ApprovalRequest', task: 'approve' },
  // B-W2b-181: a job we offer a workshop (SCR-196).
  { purpose: 'JOB_ACCEPT', recordType: 'SubcontractOrder', task: 'job' },
  // B-W2b-198: a claim link of a shipment that left us, or of an order (SCR-197).
  { purpose: 'CLAIM', recordType: 'Shipment', task: 'report-problem' },
  { purpose: 'CLAIM', recordType: 'SalesOrder', task: 'report-problem' },
  // B-W2b-200: a partner invited to one record (SCR-270): every record type a RECORD_INVITE link opens.
  ...PURPOSE_RULES.RECORD_INVITE.recordTypes.map((recordType) => ({ purpose: 'RECORD_INVITE' as const, recordType, task: 'invite' as const })),
])

/** Every purpose × record type a link can have (the domain's own list): what the registry must decide for. */
export function linkKinds(): Array<{ purpose: LinkPurpose; recordType: string }> {
  return LINK_PURPOSES.flatMap((purpose) => PURPOSE_RULES[purpose].recordTypes.map((recordType) => ({ purpose, recordType })))
}

/** The task page a valid link opens, or null: the link frame shows it. */
export function linkTaskOf(link: { readonly purpose: string; readonly record: { readonly type: string } }): LinkTask | null {
  return LINK_TASK_RULES.find((rule) => rule.purpose === link.purpose && rule.recordType === link.record.type)?.task ?? null
}
