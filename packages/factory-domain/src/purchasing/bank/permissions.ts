import type { Permission } from '../../core/permissions'
import { definePartnerPermissions } from '../../auth/partners/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Supplier bank details with change control (B-W2b-315; SCM-007; design purchasing.suppliers › Bank details "Hidden for
 * roles without finance permissions", "Reveal full IBAN (finance, StepUpModal)"; portal.supplier.profile › Bank details).
 * Checked with can() over the supplier's company AND the supplier.
 *
 * The OFFICE's (area `purchasing`):
 *
 *   bank.view      see a supplier's accounts masked (IT** **** **** 3456), their state, the call-back and the check, and the
 *                  history of changes. Finance; read_only by its rule (every read permission: masked only).
 *   bank.propose   propose a new account from the supplier's letter (step-up); it waits for a call-back and a second check.
 *                  Finance.
 *   bank.callBack  record the call-back: who called, the number we had on file before the change, when. Finance.
 *   bank.verify    the second check of a called-back change (step-up): it becomes the account payments use and the old one
 *                  is retired; refuse a change with why; retire an account. Never on a change one proposed or wrote, the
 *                  Owner included (the database's rule). Finance.
 *   bank.reveal    read the full IBAN of one account (step-up; audited). Finance.
 *
 * The PARTNER's (area `portal`, flagged `partner`):
 *
 *   supplierBank.view     see your accounts with us masked and the change waiting for our call-back. The supplier's
 *                         Invoices role; each Admin follows (the workshop's Admin by name).
 *   supplierBank.propose  propose new bank details (step-up by an e-mail code); nothing changes until we called you back on
 *                         your registered number and a second person checked it. The supplier's and the workshop's Admin.
 *
 * The owner holds every office permission (every()); finance is the role the design names.
 */
export const BANK_DEFINITIONS = definePermissions('purchasing', {
  'bank.view': {
    risk: 'read',
    description: "See a supplier's bank accounts masked, which one payments use, the changes waiting for their call-back and second check, and the history of changes.",
  },
  'bank.propose': {
    risk: 'stepUp',
    description: "Propose a supplier's new bank account from its letter (with step-up); payments keep using the old one until a call-back and a second person's check.",
  },
  'bank.callBack': {
    risk: 'write',
    description: "Record the call-back of a supplier's bank change: who called, on a number we had on file before the change, and when.",
  },
  'bank.verify': {
    risk: 'stepUp',
    description: "Check a called-back bank change as the second person (with step-up), so payments use it; refuse a change with why; retire an account. Never one you proposed or wrote.",
  },
  'bank.reveal': {
    risk: 'stepUp',
    description: "Read the full IBAN of a supplier's bank account (with step-up; recorded).",
  },
})

export const PORTAL_BANK_DEFINITIONS = definePartnerPermissions('portal', {
  'supplierBank.view': {
    risk: 'read',
    description: "See your organisation's bank accounts with us (masked) and a change waiting for our call-back.",
  },
  'supplierBank.propose': {
    risk: 'stepUp',
    description: 'Propose new bank details for your organisation (with a code by e-mail); payments keep going to the old account until we called you back and a second person checked it.',
  },
})

export const PURCHASING_BANK_VIEW = 'purchasing.bank.view' satisfies Permission
export const PURCHASING_BANK_PROPOSE = 'purchasing.bank.propose' satisfies Permission
export const PURCHASING_BANK_CALL_BACK = 'purchasing.bank.callBack' satisfies Permission
export const PURCHASING_BANK_VERIFY = 'purchasing.bank.verify' satisfies Permission
export const PURCHASING_BANK_REVEAL = 'purchasing.bank.reveal' satisfies Permission
export const PORTAL_SUPPLIER_BANK_VIEW = 'portal.supplierBank.view' satisfies Permission
export const PORTAL_SUPPLIER_BANK_PROPOSE = 'portal.supplierBank.propose' satisfies Permission

export const BANK_PERMISSIONS: readonly Permission[] = Object.freeze([PURCHASING_BANK_VIEW, PURCHASING_BANK_PROPOSE, PURCHASING_BANK_CALL_BACK, PURCHASING_BANK_VERIFY, PURCHASING_BANK_REVEAL])
export const PORTAL_BANK_PERMISSIONS: readonly Permission[] = Object.freeze([PORTAL_SUPPLIER_BANK_VIEW, PORTAL_SUPPLIER_BANK_PROPOSE])

/** The office templates that hold them (the owner holds every office permission). */
export const BANK_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  finance: [PURCHASING_BANK_VIEW, PURCHASING_BANK_PROPOSE, PURCHASING_BANK_CALL_BACK, PURCHASING_BANK_VERIFY, PURCHASING_BANK_REVEAL],
})

/** The partner templates that hold them (each kind's Admin follows its other roles by itself; the workshop's is named). */
export const PORTAL_BANK_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  'supplier-invoices': [PORTAL_SUPPLIER_BANK_VIEW],
  'supplier-admin': [PORTAL_SUPPLIER_BANK_PROPOSE],
  'subcontractor-admin': [PORTAL_SUPPLIER_BANK_VIEW, PORTAL_SUPPLIER_BANK_PROPOSE],
})
