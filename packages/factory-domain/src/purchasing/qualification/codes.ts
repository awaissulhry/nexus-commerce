/**
 * B-W2b-315 (the compliance gate on a PO, SCM-022): the send checks this step adds to W1's (purchasing/orders
 * SEND_CHECK_CODES lists them after its own, so the contracts' enum knows them). No import: purchasing/orders.ts reads this
 * file.
 *
 *   COMPLIANCE_DOCUMENT_MISSING     a line's material needs a supplier document none of the supplier's is in force for
 *                                   (a leather's chromium VI test report): held at Send
 *   COMPLIANCE_CERTIFICATE_MISSING  a PPE component (a protector) no valid certificate of the register covers today: held
 *   COMPLIANCE_RULE_MISSING         a company rule asks a document before a purchase order is sent (Admin › Documents ›
 *                                   Required documents, level Blocks) and none is in force: held
 *   COMPLIANCE_EXPIRES_BEFORE_NEED  a warning: what it rests on lapses before the line's need date (ask for the renewal)
 *   COMPLIANCE_RULE_WARNING         a warning: a company rule of level Warns is not met
 *   COMPLIANCE_OVERRIDDEN           a warning: sent without a valid document on a second person's yes (its reason)
 *   COMPLIANCE_OVERRIDE_WAITING     held: a request to send without the document waits for its yes
 */
export const COMPLIANCE_SEND_CHECK_CODES = [
  'COMPLIANCE_DOCUMENT_MISSING',
  'COMPLIANCE_CERTIFICATE_MISSING',
  'COMPLIANCE_RULE_MISSING',
  'COMPLIANCE_EXPIRES_BEFORE_NEED',
  'COMPLIANCE_RULE_WARNING',
  'COMPLIANCE_OVERRIDDEN',
  'COMPLIANCE_OVERRIDE_WAITING',
] as const
export type ComplianceSendCheckCode = (typeof COMPLIANCE_SEND_CHECK_CODES)[number]
