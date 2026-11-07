import type { Permission } from '../core/permissions'

/**
 * The one-off links' permissions (plan A1 §3.10 "Links", §3.11; features SAL-099, PLT-007). Declared in
 * `auth/permissions/catalogue.ts` (LINKS_PERMISSIONS for the office, LINK_SESSION_PERMISSIONS for link sessions).
 *
 *   office (role assignments)   links.view, links.manage
 *   link sessions (the purpose) links.open and one permission per action the purpose allows (W2b-3: download, receive,
 *                               submit, approve, refuse, pay, moveDate, post, upload); never in a role
 */

/** See the links of a record: who they were made for, their state, their uses and the evidence of each answer. */
export const LINKS_VIEW = 'links.view' satisfies Permission
/** Make a link for a record (to send to its customer or supplier) and revoke one. */
export const LINKS_MANAGE = 'links.manage' satisfies Permission

/** A link session opens its one record. Every purpose holds it. */
export const LINK_OPEN = 'links.open' satisfies Permission
/** A link session accepts the quote it opens (QUOTE_ACCEPT). */
export const LINK_ACCEPT = 'links.accept' satisfies Permission
/** A link session declines the quote or purchase order it opens. */
export const LINK_DECLINE = 'links.decline' satisfies Permission
/** A link session confirms the purchase order it opens (PO_CONFIRM). */
export const LINK_CONFIRM = 'links.confirm' satisfies Permission
// W2b-3 (B-W2b-163): the actions of the nine new purposes (links/purposes ACTION_PERMISSIONS).
/** A link session downloads one of its files (DOCUMENT_VIEW, SECURE_FILE). */
export const LINK_DOWNLOAD = 'links.download' satisfies Permission
/** A link session confirms "I received these files" (SECURE_FILE). */
export const LINK_RECEIVE = 'links.receive' satisfies Permission
/** A link session sends its form (MEASUREMENTS, CLAIM, SUPPLIER_ONBOARD). */
export const LINK_SUBMIT = 'links.submit' satisfies Permission
/** A link session approves the request it opens, with or without changes (APPROVAL). */
export const LINK_APPROVE = 'links.approve' satisfies Permission
/** A link session refuses the request it opens (APPROVAL). */
export const LINK_REFUSE = 'links.refuse' satisfies Permission
/** A link session pays its own deposit request or invoice (PAYMENT). */
export const LINK_PAY = 'links.pay' satisfies Permission
/** A link session proposes another date for the job it opens (JOB_ACCEPT). */
export const LINK_MOVE_DATE = 'links.moveDate' satisfies Permission
/** A link session posts on the record shared with it (RECORD_INVITE, when the share allows comments). */
export const LINK_POST = 'links.post' satisfies Permission
/** A link session uploads a file to the record shared with it (RECORD_INVITE, when the share allows uploads). */
export const LINK_UPLOAD = 'links.upload' satisfies Permission

export const LINKS_OFFICE_PERMISSIONS = [LINKS_VIEW, LINKS_MANAGE] as const
export const LINK_SESSION_PERMISSIONS = [
  LINK_OPEN,
  LINK_ACCEPT,
  LINK_DECLINE,
  LINK_CONFIRM,
  LINK_DOWNLOAD,
  LINK_RECEIVE,
  LINK_SUBMIT,
  LINK_APPROVE,
  LINK_REFUSE,
  LINK_PAY,
  LINK_MOVE_DATE,
  LINK_POST,
  LINK_UPLOAD,
] as const
