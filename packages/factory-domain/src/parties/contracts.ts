import { z } from 'zod'
import { businessDate, currency, id, input, instant, output } from '../core/contracts'
import { ADDRESS_APPROVALS } from './address-approval'
import { ADDRESS_KINDS, MASTER_STATUSES } from './addresses'
import { CONTACT_ROLES } from './contacts'
import { NEW_PARTY_STATUSES, PARTY_CODE, PARTY_CODE_RULE, PARTY_KINDS, PARTY_ROLES, PARTY_STATUSES } from './rules'
import { PARTY_TAX_MODES } from './tax'
import { VIES_RESULTS, VIES_STATES } from './vies'
import { PARTY_WARNINGS } from './warnings'

/**
 * The parties module's contracts (plan A1 D2; A2 SCR-032 "Customers", SCR-033 "Customer record", SCR-056 "Suppliers",
 * SCR-057 "Supplier record"): what apps/factory-api's modules/parties accepts and answers, and what the web's typed
 * client reads. The shapes are checked here; the rules (./rules, ./tax, ./addresses, ./contacts) run in the API with
 * the field names as issue paths. No money field: a party carries none.
 */

const text = (max: number) => z.string().trim().min(1).max(max)
const optionalText = (max: number) => z.string().trim().max(max).nullish()
const code = () => z.string().trim().toUpperCase().regex(PARTY_CODE, { message: `Expected ${PARTY_CODE_RULE}.` })
const version = () => z.number().int().min(1)
const country = () => z.string().trim().toUpperCase().length(2, { message: 'Expected an ISO 3166-1 country code (IT, DE, FR…).' })
const language = () => z.string().trim().toLowerCase().length(2, { message: 'Expected an ISO 639-1 language code (it, en, de…).' })

/** A comma list in a query string (`CUSTOMER,BRAND`) as a list of known values. */
const commaList = <const V extends string>(values: readonly V[], what: string) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.trim() === '') return undefined
      const list = [...new Set(value.split(',').map((part) => part.trim().toUpperCase()))]
      if (list.some((entry) => !(values as readonly string[]).includes(entry))) {
        ctx.addIssue({ code: 'custom', message: `Expected ${what} from ${values.join(', ')}.` })
        return z.NEVER
      }
      return list as V[]
    })

// ---- bodies -------------------------------------------------------------------------------------------------------------

export const taxIdentityBody = input({
  country: country(),
  taxMode: z.enum(PARTY_TAX_MODES),
  /** With or without its prefix (IT…, DE…); kept with it. */
  vatNumber: optionalText(40),
  fiscalCode: optionalText(40),
  sdiRecipientCode: optionalText(10),
  pec: optionalText(254),
  /** The first day it applies; left out: today (Europe/Rome). */
  validFrom: businessDate().optional(),
})
export type TaxIdentityBody = z.output<typeof taxIdentityBody>

export const updateTaxIdentityBody = taxIdentityBody.partial().extend({ version: version() })
export type UpdateTaxIdentityBody = z.output<typeof updateTaxIdentityBody>

const addressShape = {
  kinds: z.array(z.enum(ADDRESS_KINDS)).min(1).max(ADDRESS_KINDS.length),
  name: optionalText(80),
  line1: text(60),
  line2: optionalText(60),
  postalCode: text(12),
  city: text(60),
  province: optionalText(40),
  country: country(),
  contactName: optionalText(100),
  phone: optionalText(30),
  deliveryNotes: optionalText(500),
}
export const addressBody = input({
  ...addressShape,
  /** Make it the party's default invoice (delivery) address; the old default stops being one. */
  isDefaultBillTo: z.boolean().optional(),
  isDefaultShipTo: z.boolean().optional(),
})
export type AddressBody = z.output<typeof addressBody>

export const updateAddressBody = input(addressShape)
  .partial()
  .extend({
    version: version(),
    /** ARCHIVED removes the address from use (it stops being a default); ACTIVE restores it. */
    status: z.enum(MASTER_STATUSES).optional(),
  })
export type UpdateAddressBody = z.output<typeof updateAddressBody>

/** The defaults move on the party (its version: two changes of a default cannot both win). null: no default. */
export const defaultAddressesBody = input({ version: version(), billToAddressId: id().nullish(), shipToAddressId: id().nullish() })
export type DefaultAddressesBody = z.output<typeof defaultAddressesBody>

const contactShape = {
  name: text(120),
  email: optionalText(254),
  phone: optionalText(30),
  roles: z.array(z.enum(CONTACT_ROLES)).max(CONTACT_ROLES.length),
  language: language().nullish(),
}
export const contactBody = input({ ...contactShape, roles: contactShape.roles.optional() })
export type ContactBody = z.output<typeof contactBody>

export const updateContactBody = input(contactShape)
  .partial()
  .extend({
    version: version(),
    /** ARCHIVED removes the contact; ACTIVE restores it. */
    status: z.enum(MASTER_STATUSES).optional(),
  })
export type UpdateContactBody = z.output<typeof updateContactBody>

const partyShape = {
  code: code(),
  kind: z.enum(PARTY_KINDS),
  legalName: text(200),
  tradeName: optionalText(200),
  roles: z.array(z.enum(PARTY_ROLES)).min(1).max(PARTY_ROLES.length),
  country: country(),
  currency: currency(),
  language: language(),
  paymentTerms: optionalText(500),
  internalNote: optionalText(4000),
  /** W2b schema wave 23: an http or https address (./rules.ts websiteProblem). */
  website: optionalText(200),
}

export const createPartyBody = input({
  /** The company it belongs to; left out or null: tenant-wide (every company of the tenant). */
  companyId: id().nullish(),
  ...partyShape,
  kind: partyShape.kind.optional(),
  country: partyShape.country.optional(),
  currency: partyShape.currency.optional(),
  language: partyShape.language.optional(),
  /** PROSPECT or ACTIVE (the default). */
  status: z.enum(NEW_PARTY_STATUSES).optional(),
  taxIdentity: taxIdentityBody.optional(),
  addresses: z.array(addressBody).max(20).optional(),
  contacts: z.array(contactBody).max(50).optional(),
})
export type CreatePartyBody = z.output<typeof createPartyBody>

/** A change: only the fields sent change (null clears an optional one). Status, company and children have their own routes. */
export const updatePartyBody = input(partyShape).partial().extend({ version: version() })
export type UpdatePartyBody = z.output<typeof updatePartyBody>

export const statusBody = input({ version: version(), reason: z.string().trim().max(500).optional() })
export type StatusBody = z.output<typeof statusBody>
export const blockBody = input({ version: version(), reason: text(500) })

export const viesCheckBody = input({
  /** The identity to check; left out: the one in force today. */
  taxIdentityId: id().optional(),
  /** The company that asks (its VAT number identifies the request); left out: the party's company, or the tenant's only company. */
  companyId: id().optional(),
})
export type ViesCheckBody = z.output<typeof viesCheckBody>

/**
 * What a list row may be asked to need (SCR-032's tiles "EU businesses without a valid VIES check" and "Can't be invoiced
 * yet"): VIES = the VIES_NOT_PROVEN warning (an EU business customer without a current proof); INVOICE = a warning the
 * invoicing steps refuse to issue without (`blocksInvoice`).
 */
export const PARTY_ATTENTION = ['VIES', 'INVOICE'] as const
export type PartyAttention = (typeof PARTY_ATTENTION)[number]

// ── B-CL-002 (customers list): where each customer's work stands — the band's groups, the `work` term, the list's order ──
/**
 * The band's groups and the `work` term: NEEDS_US (a request to answer, a reply waiting or a late order: something waits on us),
 * then the order phases except CANCELLED (production-brand/stages ORDER_PHASES, written out here: no import edge from parties to
 * production-brand; a unit test pins them equal).
 */
export const PARTY_WORK_GROUPS = ['NEEDS_US', 'NOT_SENT', 'NOT_STARTED', 'IN_PRODUCTION', 'READY', 'SHIPPED', 'DONE'] as const
export type PartyWorkGroup = (typeof PARTY_WORK_GROUPS)[number]
/** needs = most urgent first (needs orders.view) · code = today's order · name = A–Z (trade name, else legal name). */
export const PARTY_SORTS = ['needs', 'code', 'name'] as const
export type PartySort = (typeof PARTY_SORTS)[number]
/** The band (`band=true`): where the work of the view's customers stands — counts only, never an amount. */
export const partyWorkBand = output({
  /** The 7 groups in order, 0 as 0: customers with ≥ 1 order in it (NEEDS_US: something waits on us); orders = that phase's orders (NEEDS_US: null). */
  groups: z.array(output({ group: z.enum(PARTY_WORK_GROUPS), customers: z.number().int(), orders: z.number().int().nullable() })),
  needsUs: output({ requests: z.number().int(), replies: z.number().int(), late: z.number().int(), repliesComplete: z.boolean() }),
  notSent: output({ waitsForYes: z.number().int(), waitsForDeposit: z.number().int() }),
  /** Every grant of the reader's orders.view names its customers: the band reads "Your customers". */
  limited: z.boolean(),
})
export type PartyWorkBand = z.infer<typeof partyWorkBand>
// ── end B-CL-002 ──

/** The list's filters (SCR-032, SCR-056): Customers is `role=CUSTOMER,BRAND`, Suppliers `role=SUPPLIER,SUBCONTRACTOR,CARRIER`. */
export const listPartiesQuery = input({
  /** Code, legal or trade name, VAT number or codice fiscale. */
  q: z.string().trim().max(100).optional(),
  role: commaList(PARTY_ROLES, 'roles'),
  /** Default: every status but ARCHIVED. */
  status: commaList([...PARTY_STATUSES, 'ALL'], 'statuses'),
  country: country().optional(),
  kind: z.enum(PARTY_KINDS).optional(),
  taxMode: z.enum(PARTY_TAX_MODES).optional(),
  /** Exactly this company's parties and the tenant-wide ones. */
  companyId: id().optional(),
  /** Only the parties that need this (PARTY_ATTENTION); `count` counts them. */
  attention: z.enum(PARTY_ATTENTION).optional(),
  // ── B-CL-002: the band's door, the order, the band itself (each of the three needs orders.view: 403 in words otherwise) ──
  /** Only the customers in this group of the band (PARTY_WORK_GROUPS); `count` counts them. */
  work: z.enum(PARTY_WORK_GROUPS).optional(),
  /** The rows' order (PARTY_SORTS); left out: by code. */
  sort: z.enum(PARTY_SORTS).optional(),
  /** `true`: the answer carries the band over every row the other terms keep (`work` aside). */
  band: z.enum(['true', 'false']).optional(),
  // ── end B-CL-002 ──
  limit: z.coerce.number().int().min(1).max(200).default(50),
  // B-CL-002: a cursor of the name order carries the last row's name (up to 200 characters): room for it.
  cursor: z.string().max(1000).optional(),
})
export type ListPartiesQuery = z.output<typeof listPartiesQuery>

export const viesHistoryQuery = input({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** `nextCursor` of the previous page. */
  cursor: z.string().max(200).optional(),
})
export type ViesHistoryQuery = z.output<typeof viesHistoryQuery>

// ---- answers ------------------------------------------------------------------------------------------------------------

export const viesStandingView = output({
  state: z.enum(VIES_STATES),
  message: z.string(),
  /** The check that proves the number (VALID), or the last one that did (EXPIRED, HELD). */
  proofCheckId: id().nullable(),
  /** The newest check of the number. */
  checkedAt: instant().nullable(),
  /** VALID: when the proof stops counting. */
  validUntil: instant().nullable(),
  maxAgeDays: z.number().int(),
})
export type ViesStandingView = z.infer<typeof viesStandingView>

export const partyRow = output({
  id: id(),
  companyId: id().nullable(),
  code: z.string(),
  kind: z.enum(PARTY_KINDS),
  legalName: z.string(),
  tradeName: z.string().nullable(),
  roles: z.array(z.enum(PARTY_ROLES)),
  status: z.enum(PARTY_STATUSES),
  country: z.string(),
  currency: z.string(),
  language: z.string(),
  /** From the tax identity in force today; null without one. */
  taxMode: z.enum(PARTY_TAX_MODES).nullable(),
  vatNumber: z.string().nullable(),
  fiscalCode: z.string().nullable(),
  /** The default invoice address's city and country, else the registered office's. */
  city: z.string().nullable(),
  vies: viesStandingView,
  /** The codes of what the record still lacks for its work (./warnings.ts); the record names each with its words. */
  attention: z.array(z.enum(PARTY_WARNINGS)),
  /** One of them stops an invoice to the party (`blocksInvoice`). */
  invoiceBlocked: z.boolean(),
  version: z.number().int(),
  updatedAt: instant(),
})
export type PartyRow = z.infer<typeof partyRow>

export const addressView = output({
  id: id(),
  kinds: z.array(z.enum(ADDRESS_KINDS)),
  name: z.string().nullable(),
  line1: z.string(),
  line2: z.string().nullable(),
  postalCode: z.string(),
  city: z.string(),
  province: z.string().nullable(),
  country: z.string(),
  contactName: z.string().nullable(),
  phone: z.string().nullable(),
  deliveryNotes: z.string().nullable(),
  isDefaultBillTo: z.boolean(),
  isDefaultShipTo: z.boolean(),
  status: z.enum(MASTER_STATUSES),
  /**
   * B-W2b-F15: our check of a delivery address a customer added in the portal (./address-approval), as the office reads it
   * (the decider is named here, never in the portal); null: an address of the office's own, never checked.
   */
  approval: output({
    status: z.enum(ADDRESS_APPROVALS),
    requestedAt: instant().nullable(),
    /** The customer's person who added it. */
    requestedBy: z.string().nullable(),
    decidedAt: instant().nullable(),
    /** The office person who approved or refused it. */
    decidedBy: z.string().nullable(),
    refuseReason: z.string().nullable(),
  }).nullable(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type AddressView = z.infer<typeof addressView>

export const contactView = output({
  id: id(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  roles: z.array(z.enum(CONTACT_ROLES)),
  language: z.string().nullable(),
  status: z.enum(MASTER_STATUSES),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type ContactView = z.infer<typeof contactView>

export const taxIdentityView = output({
  id: id(),
  country: z.string(),
  taxMode: z.enum(PARTY_TAX_MODES),
  vatNumber: z.string().nullable(),
  fiscalCode: z.string().nullable(),
  sdiRecipientCode: z.string().nullable(),
  pec: z.string().nullable(),
  validFrom: z.string(),
  /** In force today. */
  current: z.boolean(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type TaxIdentityView = z.infer<typeof taxIdentityView>

export const viesCheckView = output({
  id: id(),
  taxIdentityId: id(),
  companyId: id().nullable(),
  countryCode: z.string(),
  vatNumber: z.string(),
  requesterVatNumber: z.string().nullable(),
  requestedAt: instant(),
  result: z.enum(VIES_RESULTS),
  consultationNumber: z.string().nullable(),
  traderName: z.string().nullable(),
  traderAddress: z.string().nullable(),
  errorCode: z.string().nullable(),
  /** ERROR: what the error code means, in words. */
  errorMeaning: z.string().nullable(),
  requestId: z.string(),
  createdById: id().nullable(),
})
export type ViesCheckView = z.infer<typeof viesCheckView>

export const partyView = output({
  ...partyRow.shape,
  paymentTerms: z.string().nullable(),
  internalNote: z.string().nullable(),
  website: z.string().nullable(),
  /** BLOCKED: why and since when (from the block's audit row). */
  blocked: output({ reason: z.string().nullable(), at: instant() }).nullable(),
  /** Active addresses first. */
  addresses: z.array(addressView),
  contacts: z.array(contactView),
  /** Newest validFrom first; `current` marks the one in force today. */
  taxIdentities: z.array(taxIdentityView),
  /** The checks of the identity in force today, newest first (at most 20; the history route pages the rest). */
  viesChecks: z.array(viesCheckView),
  warnings: z.array(output({ code: z.enum(PARTY_WARNINGS), message: z.string(), blocksInvoice: z.boolean() })),
  createdAt: instant(),
  createdById: id().nullable(),
})
export type PartyView = z.infer<typeof partyView>
