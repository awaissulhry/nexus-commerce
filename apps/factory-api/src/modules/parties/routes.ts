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
import { getCommercialTerms, updateCommercialTerms } from './commercial-terms'
import { getCommercialTermsContract, updateCommercialTermsContract } from './contract'
import { manifest } from './manifest'
import { createParty, getParty, listParties, moveParty, updateParty } from './parties'
import { addTaxIdentity, updateTaxIdentity } from './tax-identities'
import { checkVies, viesHistory } from './vies'
// B-W2b-290: customers in depth (SAL-013, SAL-014, SAL-021, SAL-022, SAL-023, SAL-028).
import { requireStepUp } from '../../platform/auth/office/account'
import { officeAuthOf } from '../../platform/auth/sessions/office-auth'
import { endCompanyTermsContract, getCompanyTermsContract, setCompanyTermsContract } from './company-terms/contract'
import { endCompanyTerms, getCompanyTerms, setCompanyTerms } from './company-terms/company-terms'
import { accessCopyContract, eraseContactContract, getContactsPrivacyContract, recordObjectionContract, setLawfulBasisContract } from './contact-privacy/contract'
import { accessCopy, eraseContact, getContactsPrivacy, recordObjection, setLawfulBasis } from './contact-privacy/privacy'
import { getHoldsContract, placeHoldContract, releaseHoldContract } from './holds/contract'
import { getHolds, placeHold, releaseHold } from './holds/holds'
import { addRequirementContract, endRequirementContract, getRequirementsContract, replaceRequirementContract, requirementsForRecordContract } from './requirements/contract'
import { addRequirement, assertRecordType, endRequirement, getRequirements, replaceRequirement, requirementsForRecord } from './requirements/requirements'
import { getRidersContract, setTeamContract } from './riders/contract'
import { getRiders, setTeam } from './riders/riders'

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

  // B-W2a-19 (SAL-012): the commercial terms its new quotes and orders start with.
  app.get('/parties/:partyId/commercial-terms', { schema: getCommercialTermsContract }, async (request) => getCommercialTerms(request, request.params.partyId))
  app.patch('/parties/:partyId/commercial-terms', { schema: updateCommercialTermsContract }, async (request) => updateCommercialTerms(request, request.params.partyId, request.body, idempotencyKeyFrom(request)))

  // B-W2b-290 (SAL-014): the customer's requirements, and those that apply on a quote, order, shipment or invoice.
  app.get('/parties/:partyId/requirements', { schema: getRequirementsContract }, async (request) => getRequirements(request, request.params.partyId))
  app.post('/parties/:partyId/requirements', { schema: addRequirementContract }, async (request, reply) => reply.code(201).send(await addRequirement(request, request.params.partyId, request.body, idempotencyKeyFrom(request))))
  app.post('/parties/:partyId/requirements/:requirementId/replace', { schema: replaceRequirementContract }, async (request, reply) =>
    reply.code(201).send(await replaceRequirement(request, request.params.partyId, request.params.requirementId, request.body, idempotencyKeyFrom(request))),
  )
  app.post('/parties/:partyId/requirements/:requirementId/end', { schema: endRequirementContract }, async (request) => endRequirement(request, request.params.partyId, request.params.requirementId, request.body, idempotencyKeyFrom(request)))
  app.get('/parties/requirements/for/:recordType/:recordId', { schema: requirementsForRecordContract }, async (request) => {
    assertRecordType(request.params.recordType)
    return requirementsForRecord(request, request.params.recordType, request.params.recordId)
  })

  // B-W2b-290 (SAL-023): the account on hold, placed and released with words.
  app.get('/parties/:partyId/holds', { schema: getHoldsContract }, async (request) => getHolds(request, request.params.partyId))
  app.post('/parties/:partyId/holds', { schema: placeHoldContract }, async (request, reply) => reply.code(201).send(await placeHold(request, request.params.partyId, request.body, idempotencyKeyFrom(request))))
  app.post('/parties/:partyId/holds/:holdId/release', { schema: releaseHoldContract }, async (request) => releaseHold(request, request.params.partyId, request.params.holdId, request.body, idempotencyKeyFrom(request)))

  // B-W2b-290 (SAL-028, SAL-013): the terms with each of our companies (PO number required among them).
  app.get('/parties/:partyId/company-terms', { schema: getCompanyTermsContract }, async (request) => getCompanyTerms(request, request.params.partyId))
  app.put('/parties/:partyId/company-terms/:companyId', { schema: setCompanyTermsContract }, async (request) => setCompanyTerms(request, request.params.partyId, request.params.companyId, request.body, idempotencyKeyFrom(request)))
  app.post('/parties/:partyId/company-terms/:companyId/end', { schema: endCompanyTermsContract }, async (request) => endCompanyTerms(request, request.params.partyId, request.params.companyId, request.body, idempotencyKeyFrom(request)))

  // B-W2b-290 (SAL-022): the contacts' lawful basis and consent, an objection, the access copy, the erasure (a fresh code).
  app.get('/parties/:partyId/contacts/privacy', { schema: getContactsPrivacyContract }, async (request) => getContactsPrivacy(request, request.params.partyId))
  app.put('/parties/:partyId/contacts/:contactId/lawful-basis', { schema: setLawfulBasisContract }, async (request) => setLawfulBasis(request, request.params.partyId, request.params.contactId, request.body, idempotencyKeyFrom(request)))
  app.post('/parties/:partyId/contacts/:contactId/objection', { schema: recordObjectionContract }, async (request) => recordObjection(request, request.params.partyId, request.params.contactId, request.body, idempotencyKeyFrom(request)))
  app.post('/parties/:partyId/contacts/:contactId/access-copy', { schema: accessCopyContract }, async (request, reply) => reply.code(201).send(await accessCopy(request, request.params.partyId, request.params.contactId, request.body, idempotencyKeyFrom(request))))
  app.post('/parties/:partyId/contacts/:contactId/erase', { schema: eraseContactContract }, async (request) => {
    requireStepUp(officeAuthOf(app), request)
    return eraseContact(request, request.params.partyId, request.params.contactId, request.body, idempotencyKeyFrom(request))
  })

  // B-W2b-290 (SAL-021): riders (people) under a team or dealer.
  app.get('/parties/:partyId/riders', { schema: getRidersContract }, async (request) => getRiders(request, request.params.partyId))
  app.put('/parties/:partyId/team', { schema: setTeamContract }, async (request) => setTeam(request, request.params.partyId, request.body, idempotencyKeyFrom(request)))
})
