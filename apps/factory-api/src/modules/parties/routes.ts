import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import { addAddress, addContact, setDefaultAddresses, updateAddress, updateContact } from './children'
import {
  addAddressContract,
  addContactContract,
  addTaxIdentityContract,
  blockContract,
  checkViesContract,
  createPartyContract,
  defaultAddressesContract,
  getPartyContract,
  listPartiesContract,
  statusContract,
  updateAddressContract,
  updateContactContract,
  updatePartyContract,
  updateTaxIdentityContract,
  viesHistoryContract,
} from './contract'
import { manifest } from './manifest'
import { createParty, getParty, listParties, moveParty, updateParty } from './parties'
import { addTaxIdentity, updateTaxIdentity } from './tax-identities'
import { checkVies, viesHistory } from './vies'

/**
 * Customers and suppliers (parties module, B-W1-07; A2 SCR-032 "Customers", SCR-033 "Customer record", SCR-056
 * "Suppliers", SCR-057 "Supplier record"): one party record with its roles, tax identities from a date, addresses with
 * the default invoice and delivery address, contacts with roles, its status, and the VIES checks that prove an EU VAT
 * number for a zero-rated sale (art. 41 DL 331/1993). Imports go through platform/imports (importer `parties.parties`,
 * ./importer.ts).
 */
export default defineRoutes('parties', manifest, async (app) => {
  app.get('/parties', { schema: listPartiesContract }, async (request) => listParties(request, request.query))

  app.get('/parties/:partyId', { schema: getPartyContract }, async (request) => ({ party: await getParty(request, request.params.partyId) }))

  app.post('/parties', { schema: createPartyContract }, async (request, reply) => reply.code(201).send({ party: await createParty(request, request.body, idempotencyKeyFrom(request)) }))

  app.patch('/parties/:partyId', { schema: updatePartyContract }, async (request) => ({ party: await updateParty(request, request.params.partyId, request.body, idempotencyKeyFrom(request)) }))

  app.post('/parties/:partyId/activate', { schema: statusContract }, async (request) => ({ party: await moveParty(request, request.params.partyId, 'activate', request.body, idempotencyKeyFrom(request)) }))
  app.post('/parties/:partyId/archive', { schema: statusContract }, async (request) => ({ party: await moveParty(request, request.params.partyId, 'archive', request.body, idempotencyKeyFrom(request)) }))
  app.post('/parties/:partyId/reactivate', { schema: statusContract }, async (request) => ({ party: await moveParty(request, request.params.partyId, 'reactivate', request.body, idempotencyKeyFrom(request)) }))
  app.post('/parties/:partyId/unblock', { schema: statusContract }, async (request) => ({ party: await moveParty(request, request.params.partyId, 'unblock', request.body, idempotencyKeyFrom(request)) }))
  app.post('/parties/:partyId/block', { schema: blockContract }, async (request) => ({ party: await moveParty(request, request.params.partyId, 'block', request.body, idempotencyKeyFrom(request)) }))

  app.post('/parties/:partyId/addresses', { schema: addAddressContract }, async (request, reply) =>
    reply.code(201).send({ party: await addAddress(request, request.params.partyId, request.body, idempotencyKeyFrom(request)) }),
  )
  app.patch('/parties/:partyId/addresses/:addressId', { schema: updateAddressContract }, async (request) => ({
    party: await updateAddress(request, request.params.partyId, request.params.addressId, request.body, idempotencyKeyFrom(request)),
  }))
  app.put('/parties/:partyId/default-addresses', { schema: defaultAddressesContract }, async (request) => ({
    party: await setDefaultAddresses(request, request.params.partyId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/parties/:partyId/contacts', { schema: addContactContract }, async (request, reply) =>
    reply.code(201).send({ party: await addContact(request, request.params.partyId, request.body, idempotencyKeyFrom(request)) }),
  )
  app.patch('/parties/:partyId/contacts/:contactId', { schema: updateContactContract }, async (request) => ({
    party: await updateContact(request, request.params.partyId, request.params.contactId, request.body, idempotencyKeyFrom(request)),
  }))

  app.post('/parties/:partyId/tax-identities', { schema: addTaxIdentityContract }, async (request, reply) =>
    reply.code(201).send({ party: await addTaxIdentity(request, request.params.partyId, request.body, idempotencyKeyFrom(request)) }),
  )
  app.patch('/parties/:partyId/tax-identities/:taxIdentityId', { schema: updateTaxIdentityContract }, async (request) => ({
    party: await updateTaxIdentity(request, request.params.partyId, request.params.taxIdentityId, request.body, idempotencyKeyFrom(request)),
  }))

  app.get('/parties/:partyId/vies-checks', { schema: viesHistoryContract }, async (request) => viesHistory(request, request.params.partyId, request.query))
  app.post('/parties/:partyId/vies-checks', { schema: checkViesContract }, async (request, reply) =>
    reply.code(201).send(await checkVies(request, request.params.partyId, request.body, idempotencyKeyFrom(request))),
  )
})
