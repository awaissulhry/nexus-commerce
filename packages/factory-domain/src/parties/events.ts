import { z } from 'zod'
import { defineEvent } from '../events/define'
import { COMPANY_TERMS_CHANGES } from './company-terms/terms'
import { CONTACT_PRIVACY_CHANGES } from './contact-privacy/privacy'
import { HOLD_REASONS } from './holds/holds'
import { REQUIREMENT_CHANGES } from './requirements/requirements'
import { PARTY_STATUSES } from './rules'
import { VIES_RESULTS } from './vies'

/**
 * The parties module's events (plan A1 §3.4, §3.5; B-W1-07). apps/factory-api's modules/parties emits them in the
 * transaction that changes the party; they refresh the customer and supplier lists and records on the office screens
 * that may see the party (parties.view). Payloads carry ids, codes and states only: never a name, an address, an email
 * or a tax number (contacts and private customers are personal data; a screen refetches what it shows).
 */

const live = { permission: 'parties.view', fields: ['partyId', 'code'] } as const

export const events = [
  defineEvent({
    type: 'party.created',
    context: 'parties',
    description: 'A customer or supplier was added (by hand or by an import), with its first tax identity, addresses and contacts.',
    payload: z.strictObject({ partyId: z.uuid(), code: z.string() }),
    live,
  }),
  defineEvent({
    type: 'party.updated',
    context: 'parties',
    description: 'A party changed: its code, names, roles, country, currency, language, payment terms, note or website.',
    payload: z.strictObject({ partyId: z.uuid(), code: z.string(), fields: z.array(z.string()) }),
    live,
  }),
  defineEvent({
    type: 'party.status_changed',
    context: 'parties',
    description: 'A party was activated, blocked, unblocked, archived or reactivated.',
    payload: z.strictObject({ partyId: z.uuid(), code: z.string(), from: z.enum(PARTY_STATUSES), status: z.enum(PARTY_STATUSES) }),
    live: { ...live, fields: ['partyId', 'code', 'status'] },
  }),
  defineEvent({
    type: 'party.addresses_changed',
    context: 'parties',
    description: 'An address of a party was added, changed, removed or restored, or its default invoice or delivery address moved.',
    payload: z.strictObject({ partyId: z.uuid(), code: z.string(), addressIds: z.array(z.uuid()) }),
    live,
  }),
  defineEvent({
    type: 'party.contacts_changed',
    context: 'parties',
    description: 'A contact of a party was added, changed, removed or restored.',
    payload: z.strictObject({ partyId: z.uuid(), code: z.string(), contactIds: z.array(z.uuid()) }),
    live,
  }),
  defineEvent({
    type: 'party.tax_identity_changed',
    context: 'parties',
    description: 'A tax identity of a party was added (from a date) or corrected.',
    payload: z.strictObject({ partyId: z.uuid(), code: z.string(), taxIdentityId: z.uuid() }),
    live,
  }),
  defineEvent({
    type: 'party.vies_checked',
    context: 'parties',
    description: "A party's VAT number was checked with VIES: valid, not valid, or no answer (held).",
    payload: z.strictObject({ partyId: z.uuid(), code: z.string(), viesCheckId: z.uuid(), taxIdentityId: z.uuid(), result: z.enum(VIES_RESULTS) }),
    live: { ...live, fields: ['partyId', 'code', 'result'] },
  }),
  // ---- B-W2b-290: customers in depth (SAL-013, SAL-014, SAL-021, SAL-022, SAL-023, SAL-028; modules/parties/{requirements,holds,
  // company-terms,contact-privacy,riders}). Ids, codes and states only: never a name, an e-mail, the words of a rule or a hold,
  // a price list, a deposit or a limit.
  defineEvent({
    type: 'party.requirement_changed',
    context: 'parties',
    description: "A customer's requirement was added, replaced by a new one (the old one ended in the same change), or ended (packing, labels, documents, shipping, invoicing).",
    payload: z.strictObject({ partyId: z.uuid(), code: z.string(), requirementId: z.uuid(), change: z.enum(REQUIREMENT_CHANGES) }),
    live: { ...live, fields: ['partyId', 'code', 'change'] },
  }),
  defineEvent({
    type: 'party.hold_placed',
    context: 'parties',
    description: "A customer's account was put on hold for one company or every company, with a reason: new orders and shipments wait, quotes warn.",
    payload: z.strictObject({ partyId: z.uuid(), code: z.string(), holdId: z.uuid(), companyId: z.uuid().nullable(), reason: z.enum(HOLD_REASONS) }),
    live: { ...live, fields: ['partyId', 'code', 'holdId'] },
  }),
  defineEvent({
    type: 'party.hold_released',
    context: 'parties',
    description: "A customer's account hold was released with words: its orders and shipments go on (another hold may still be in force).",
    payload: z.strictObject({ partyId: z.uuid(), code: z.string(), holdId: z.uuid(), companyId: z.uuid().nullable(), reason: z.enum(HOLD_REASONS), stillOnHold: z.boolean() }),
    live: { ...live, fields: ['partyId', 'code', 'holdId'] },
  }),
  defineEvent({
    type: 'party.company_terms_changed',
    context: 'parties',
    description: "A customer's terms with one of our companies were set or changed (payment terms, price list, deposit, PO number required), or ended (back to the party's own).",
    payload: z.strictObject({ partyId: z.uuid(), code: z.string(), companyId: z.uuid(), termsId: z.uuid(), change: z.enum(COMPANY_TERMS_CHANGES), fields: z.array(z.string()) }),
    live: { ...live, fields: ['partyId', 'code', 'companyId', 'change'] },
  }),
  defineEvent({
    type: 'party.contact_privacy_changed',
    context: 'parties',
    description: "A contact's lawful basis and consent were recorded, or the person objected or withdrew their consent.",
    payload: z.strictObject({ partyId: z.uuid(), code: z.string(), contactId: z.uuid(), change: z.enum(CONTACT_PRIVACY_CHANGES) }),
    live: { ...live, fields: ['partyId', 'code', 'contactId'] },
  }),
  defineEvent({
    type: 'party.contact_erased',
    context: 'parties',
    description: 'A contact was erased on request: their name, e-mail and phone are blank for good; the row stays for the documents that name it.',
    payload: z.strictObject({ partyId: z.uuid(), code: z.string(), contactId: z.uuid() }),
    live: { ...live, fields: ['partyId', 'code', 'contactId'] },
  }),
  defineEvent({
    type: 'party.team_changed',
    context: 'parties',
    description: 'A rider (a person) was put under a team or dealer, moved to another, or taken off its team.',
    payload: z.strictObject({ partyId: z.uuid(), code: z.string(), teamPartyId: z.uuid().nullable(), previousTeamPartyId: z.uuid().nullable() }),
    live: { ...live, fields: ['partyId', 'code', 'teamPartyId', 'previousTeamPartyId'] },
  }),
] as const
