/**
 * Partner kinds and what one person may do (B-W2b-162; PLT-006, PLT-021; COL-062 inside the portal). Pure.
 *
 * A partner organisation is a Party; its people are User rows with audience PARTNER, ONE party and a partner kind
 * (B-W2b-152): which portal they see. The kind must fit the party's roles (the database holds the same rule):
 *   CUSTOMER        a party with the CUSTOMER or BRAND role: orders, tracking, documents, returns
 *   SUPPLIER        a party with the SUPPLIER role: purchase orders without prices (Owner answer C2), ship notices
 *   SUBCONTRACTOR   a party with the SUBCONTRACTOR role: its jobs, without prices
 *   GUEST           a party with the CONSULTANT role: an outside adviser (the accountant), always with an end of access
 *
 * What one person may also do on the records their role shows (COL-062): view only, or any of comment, upload, approve.
 * Each is a small partner role of its own (`partner-<capability>`), given beside the person's main role: the role
 * assignment is the per-person store, so no column holds it.
 */

export const PARTNER_KINDS = ['CUSTOMER', 'SUPPLIER', 'SUBCONTRACTOR', 'GUEST'] as const
export type PartnerKind = (typeof PARTNER_KINDS)[number]
export const isPartnerKind = (value: unknown): value is PartnerKind => typeof value === 'string' && (PARTNER_KINDS as readonly string[]).includes(value)

/** The party roles a partner kind needs (one of them). */
export const KIND_PARTY_ROLES: Readonly<Record<PartnerKind, readonly string[]>> = Object.freeze({
  CUSTOMER: ['CUSTOMER', 'BRAND'],
  SUPPLIER: ['SUPPLIER'],
  SUBCONTRACTOR: ['SUBCONTRACTOR'],
  GUEST: ['CONSULTANT'],
})

/** The kind fits the party's roles. */
export const kindFits = (kind: PartnerKind, partyRoles: readonly string[]): boolean => KIND_PARTY_ROLES[kind].some((role) => partyRoles.includes(role))

/** Every partner kind a party with these roles may have people of, in the order of PARTNER_KINDS. */
export const partnerKindsOf = (partyRoles: readonly string[]): PartnerKind[] => PARTNER_KINDS.filter((kind) => kindFits(kind, partyRoles))

/** The template key prefix of a kind's roles (`customer-buyer`). */
export const KIND_KEY_PREFIX: Readonly<Record<PartnerKind, string>> = Object.freeze({ CUSTOMER: 'customer', SUPPLIER: 'supplier', SUBCONTRACTOR: 'subcontractor', GUEST: 'guest' })

export const CAPABILITIES = ['comment', 'upload', 'approve'] as const
export type Capability = (typeof CAPABILITIES)[number]
export const isCapability = (value: unknown): value is Capability => typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value)

/** The partner role that gives a capability (beside a main role of any kind). */
export const CAPABILITY_ROLE_KEYS: Readonly<Record<Capability, string>> = Object.freeze({ comment: 'partner-comment', upload: 'partner-upload', approve: 'partner-approve' })

/** The capability a role key gives, or null (a main role, or not a partner key). */
export const capabilityOfKey = (key: string): Capability | null => CAPABILITIES.find((capability) => CAPABILITY_ROLE_KEYS[capability] === key) ?? null

/** The capabilities in their fixed order, once each. */
export const sortedCapabilities = (list: readonly Capability[]): Capability[] => CAPABILITIES.filter((capability) => list.includes(capability))
