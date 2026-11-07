/**
 * The office's check of a delivery address a customer added in the portal (B-W2b-F13b on the wave-23 schema; design
 * portal.customer.neworder "Add a new address (waits for our approval)", portal.customer.account › Delivery addresses),
 * pure. factory-db's PartyAddress.approvalStatus: null = an address of the office's own, never checked; WAITING → APPROVED
 * | REFUSED once, by an office person (a refusal with the reason the customer reads, the address archived for good). A
 * WAITING address is never a default; neither a WAITING nor a REFUSED one is used for an order: a quote's bill-to or
 * ship-to, a shipment's or a sales order's delivery address (the database refuses the first two; the API words all).
 * A customer's order request or change request may name a WAITING one: accepting it approves the address first.
 */

export const ADDRESS_APPROVALS = ['WAITING', 'APPROVED', 'REFUSED'] as const
export type AddressApproval = (typeof ADDRESS_APPROVALS)[number]

export interface ApprovalWords {
  readonly it: string
  readonly en: string
}

/** The check in the customer's words (the portal's address list). */
export const ADDRESS_APPROVAL_WORDS: Readonly<Record<AddressApproval, ApprovalWords>> = Object.freeze({
  WAITING: { en: 'Waits for our check before the first delivery', it: 'In attesa della nostra verifica prima della prima consegna' },
  APPROVED: { en: 'Checked by us', it: 'Verificato da noi' },
  REFUSED: { en: 'Not accepted', it: 'Non accettato' },
})

/** The reason of a refusal: 3 to 500 characters (factory-db's guard). */
export const REFUSE_REASON_LIMITS = Object.freeze({ min: 3, max: 500 })

const isApproval = (value: string | null | undefined): value is AddressApproval => value === 'WAITING' || value === 'APPROVED' || value === 'REFUSED'

/** An address an order may use: the office's own (never checked) or one the office approved. */
export const usableForOrders = (approval: string | null | undefined): boolean => approval === null || approval === undefined || approval === 'APPROVED'

/** Why an order, a quote or a shipment cannot use this address (office words), or null when it can. */
export function addressUseProblem(approval: string | null | undefined): string | null {
  if (!isApproval(approval) || approval === 'APPROVED') return null
  return approval === 'WAITING'
    ? 'The customer added this delivery address in the portal and it waits for our check: approve it first (Sales › Delivery addresses to check), or choose another.'
    : 'This delivery address was refused after our check: it is not used for orders. Choose another.'
}

/** Why a customer's address cannot be the default (portal words), or null when it can. */
export function defaultProblem(approval: string | null | undefined): string | null {
  return approval === 'WAITING' ? 'This address waits for our check: it can be your default once we approved it.' : null
}

/** Why the office cannot decide this address now, or null when it can. */
export function checkProblem(row: { readonly approvalStatus: string | null; readonly status: string }): string | null {
  if (row.approvalStatus === null) return 'This address is one of ours: it is never checked.'
  if (row.approvalStatus === 'APPROVED') return 'This address was approved already.'
  if (row.approvalStatus === 'REFUSED') return 'This address was refused already.'
  if (row.status !== 'ACTIVE') return 'The customer took this address back: there is nothing to check.'
  return null
}

/** Why a refusal's reason is not good (the customer reads it), or null. */
export function refuseReasonProblem(reason: string): string | null {
  const text = reason.trim()
  if (text.length < REFUSE_REASON_LIMITS.min) return 'Say why the address is not accepted: the customer reads it.'
  if (text.length > REFUSE_REASON_LIMITS.max) return `At most ${REFUSE_REASON_LIMITS.max} characters.`
  return null
}

/** The longest address in short (a notification's record label: Notification.recordLabel). */
export const ADDRESS_SHORT_MAX = 120

/**
 * The address in short, as the customer's news names it (B-W2b-F15): its name, the street and the place, e.g. "Seed
 * warehouse two, Via Esempio 12, 40100 Bologna"; at most ADDRESS_SHORT_MAX characters.
 */
export function addressInShort(fields: { readonly name: string | null; readonly line1: string; readonly postalCode: string; readonly city: string }): string {
  const parts = [fields.name, fields.line1, [fields.postalCode, fields.city].filter((part) => part.trim() !== '').join(' ')].map((part) => (part ?? '').trim()).filter((part) => part !== '')
  const text = parts.join(', ')
  return text.length <= ADDRESS_SHORT_MAX ? text : `${text.slice(0, ADDRESS_SHORT_MAX - 1).trimEnd()}…`
}

/** The check as the portal shows it on an address, or null for an address of the office's own. */
export function approvalView(row: { readonly approvalStatus: string | null; readonly refuseReason: string | null }): { status: AddressApproval; words: ApprovalWords; refuseReason: string | null } | null {
  if (!isApproval(row.approvalStatus)) return null
  return { status: row.approvalStatus, words: ADDRESS_APPROVAL_WORDS[row.approvalStatus], refuseReason: row.approvalStatus === 'REFUSED' ? row.refuseReason : null }
}
