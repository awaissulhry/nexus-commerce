import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import {
  addressBody,
  blockBody,
  contactBody,
  createPartyBody,
  defaultAddressesBody,
  listPartiesQuery,
  partyRow,
  partyView,
  statusBody,
  taxIdentityBody,
  updateAddressBody,
  updateContactBody,
  updatePartyBody,
  updateTaxIdentityBody,
  viesCheckBody,
  viesCheckView,
  viesHistoryQuery,
  viesStandingView,
} from '@nexus/factory-domain/parties/contracts'

/** The party routes' contracts (A2 SCR-032, 033, 056, 057): the bodies and answers are factory-domain's parties/contracts. */

const one = { 200: output({ party: partyView }) }
const created = { 201: output({ party: partyView }) }
const party = input({ partyId: id() })

export const listPartiesContract = defineContract({
  querystring: listPartiesQuery,
  response: { 200: output({ parties: z.array(partyRow), nextCursor: z.string().nullable(), count: z.number().int() }) },
})
export const getPartyContract = defineContract({ params: party, response: one })
export const createPartyContract = defineContract({ body: createPartyBody, response: created })
export const updatePartyContract = defineContract({ params: party, body: updatePartyBody, response: one })
export const statusContract = defineContract({ params: party, body: statusBody, response: one })
export const blockContract = defineContract({ params: party, body: blockBody, response: one })
export const addAddressContract = defineContract({ params: party, body: addressBody, response: created })
export const updateAddressContract = defineContract({ params: input({ partyId: id(), addressId: id() }), body: updateAddressBody, response: one })
export const defaultAddressesContract = defineContract({ params: party, body: defaultAddressesBody, response: one })
export const addContactContract = defineContract({ params: party, body: contactBody, response: created })
export const updateContactContract = defineContract({ params: input({ partyId: id(), contactId: id() }), body: updateContactBody, response: one })
export const addTaxIdentityContract = defineContract({ params: party, body: taxIdentityBody, response: created })
export const updateTaxIdentityContract = defineContract({ params: input({ partyId: id(), taxIdentityId: id() }), body: updateTaxIdentityBody, response: one })
export const viesHistoryContract = defineContract({ params: party, querystring: viesHistoryQuery, response: { 200: output({ checks: z.array(viesCheckView), nextCursor: z.string().nullable() }) } })
export const checkViesContract = defineContract({ params: party, body: viesCheckBody, response: { 201: output({ check: viesCheckView, vies: viesStandingView, party: partyView }) } })
