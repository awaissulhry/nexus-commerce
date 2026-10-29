import { z } from 'zod'
import { defineEvent } from '../events/define'
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
    description: 'A party changed: its code, names, roles, country, currency, language, payment terms or note.',
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
] as const
