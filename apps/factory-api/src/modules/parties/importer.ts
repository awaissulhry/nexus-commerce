import type { Issue } from '@nexus/factory-domain/core/errors'
import { grantsFor } from '@nexus/factory-domain/core/permissions'
import { addressOfRow, contactOfRow, identityOfRow, importRecordValues, matchContact, partiesImporter, partyPatchOfRow } from '@nexus/factory-domain/parties/importer'
import { PARTIES_MANAGE, PARTIES_VIEW } from '@nexus/factory-domain/parties/permissions'
import { changeParty, isCustomer, newParty, type PartyFields } from '@nexus/factory-domain/parties/rules'
import { identityAt, TAX_IDENTITY_FIELDS, type TaxIdentityFields } from '@nexus/factory-domain/parties/tax'
import type { CommandTools } from '../../core/command'
import { ApiError } from '../../core/errors'
// Types only: platform/imports/registry.ts lists this adapter, so a value import back from it would be a cycle.
import type { ImportAdapter, ImportScope } from '../../platform/imports/registry'
import {
  ADDRESS_COLUMNS,
  addressFieldsOf,
  assertNoTaxDuplicate,
  CONTACT_COLUMNS,
  contactFieldsOf,
  dateText,
  dateValue,
  dayOf,
  insertAddress,
  insertContact,
  insertParty,
  insertTaxIdentity,
  lockParty,
  PARTY_COLUMNS,
  partyFieldsOf,
  TAX_COLUMNS,
  taxFieldsOf,
  today,
} from './store'

/**
 * The customers and suppliers import's adapter (platform/imports; features SCM-289 → PLT-176, SAL-001, SCM-001):
 * factory-domain's `partiesImporter` decides what each row does in the dry run; this loads the parties the codes find
 * (with the identity in force today, the registered office and the active contacts) and writes one planned row inside
 * the batch's command. Running and applying it needs parties.manage, seeing its plans parties.view (the engine checks
 * both against the job's company). `authorize` adds the routes' own rules, at the start, in the dry run and at the
 * apply: a job for every company (no company) needs parties.manage over every company, and any job a grant over every
 * party (a role limited to some customers adds no new ones).
 *
 * Write checks the party again as it is now and refuses (a failed batch, applied again later) a row the dry run would
 * now refuse, and a VAT number or codice fiscale another party holds: the dry run reads only the parties its codes
 * find, so that check happens here, with the code of the party that holds the number.
 */

const ACTION = 'parties.import'

/** Stops the batch: the party changed since the dry run in a way the row no longer fits. */
class ImportRowRefused extends ApiError {
  constructor(code: string, detail: string) {
    super('conflict', `The import row for ${code} no longer fits the party: ${detail}. Run the dry run again.`)
  }
}
const withoutValidFrom = ({ validFrom: _validFrom, ...identity }: TaxIdentityFields): Omit<TaxIdentityFields, 'validFrom'> => identity
const messages = (issues: readonly Issue[]): string => issues.map((issue) => `${issue.path}: ${issue.message}`).join(' ')

async function updateRow(tools: CommandTools, recordId: string, code: string, values: Parameters<typeof partyPatchOfRow>[0], scope: ImportScope): Promise<void> {
  const { tx, now, context } = tools
  const locked = await lockParty(tx, recordId)
  if (locked.status === 'ARCHIVED' || locked.companyId !== scope.companyId) throw new ImportRowRefused(code, 'it was archived or moved')
  const row = await tx.party.findUniqueOrThrow({ where: { id: recordId }, select: PARTY_COLUMNS })
  const party = { id: recordId, companyId: row.companyId }
  const current = partyFieldsOf(row)
  const change = changeParty(current, partyPatchOfRow(values))
  if (!change.ok) throw new ImportRowRefused(code, messages(change.issues))
  const next = change.party
  const touched = { addresses: [] as string[], contacts: [] as string[] }

  if (change.changed.length > 0) {
    const changes = Object.fromEntries(change.changed.map((field) => [field, next[field]])) as Partial<PartyFields>
    // command() bumps only the record it guards (the import job): the party's version moves here.
    await tx.party.update({ where: { id: recordId }, data: { ...changes, roles: changes.roles ? [...changes.roles] : undefined, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: ACTION, recordType: 'Party', recordId, companyId: row.companyId, before: Object.fromEntries(change.changed.map((field) => [field, current[field]])), after: changes })
    tools.emit({ type: 'party.updated', subject: recordId, companyId: row.companyId, payload: { partyId: recordId, code: next.code, fields: [...change.changed] } })
  }

  const day = dayOf(now)
  const identities = await tx.partyTaxIdentity.findMany({ where: { partyId: recordId }, select: TAX_COLUMNS })
  const inForce = identityAt(identities.map((identity) => ({ identity, validFrom: dateText(identity.validFrom) })), day)?.identity ?? null
  const identity = identityOfRow(values, next, inForce ? taxFieldsOf(inForce) : null)
  if (identity && !identity.ok) throw new ImportRowRefused(code, messages(identity.issues))
  if (identity?.ok) {
    const fields = { ...identity.identity, validFrom: day }
    const before = inForce ? taxFieldsOf(inForce) : null
    const changed = TAX_IDENTITY_FIELDS.filter((field) => field !== 'validFrom' && before?.[field] !== fields[field])
    if (changed.length > 0) {
      await assertNoTaxDuplicate(tx, context, recordId, fields)
      let identityId: string
      if (inForce && dateText(inForce.validFrom) === day) {
        // Changed on the day it began: corrected in place (one identity per day).
        identityId = inForce.id
        await tx.partyTaxIdentity.update({ where: { id: inForce.id }, data: { ...fields, validFrom: dateValue(day), version: { increment: 1 } }, select: { id: true } })
        tools.audit({ action: ACTION, recordType: 'PartyTaxIdentity', recordId: inForce.id, companyId: row.companyId, before: Object.fromEntries(changed.map((field) => [field, before![field]])), after: Object.fromEntries(changed.map((field) => [field, fields[field]])) })
      } else {
        identityId = await insertTaxIdentity(tools, party, fields, ACTION)
      }
      tools.emit({ type: 'party.tax_identity_changed', subject: recordId, companyId: row.companyId, payload: { partyId: recordId, code: next.code, taxIdentityId: identityId } })
    }
  }

  const addresses = await tx.partyAddress.findMany({ where: { partyId: recordId, status: 'ACTIVE' }, select: ADDRESS_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const registered = addresses.find((address) => address.kinds.includes('REGISTERED')) ?? null
  const address = addressOfRow(values, next, registered ? addressFieldsOf(registered) : null)
  if (address && !address.ok) throw new ImportRowRefused(code, messages(address.issues))
  if (address?.ok) {
    if (registered) {
      const before = addressFieldsOf(registered)
      if (JSON.stringify(before) !== JSON.stringify(address.address)) {
        await tx.partyAddress.update({ where: { id: registered.id }, data: { ...address.address, kinds: [...address.address.kinds], version: { increment: 1 } }, select: { id: true } })
        tools.audit({ action: ACTION, recordType: 'PartyAddress', recordId: registered.id, companyId: row.companyId, before, after: address.address })
        touched.addresses.push(registered.id)
      }
    } else {
      const defaults = {
        isDefaultBillTo: address.address.kinds.includes('BILL_TO') && !addresses.some((entry) => entry.isDefaultBillTo),
        isDefaultShipTo: address.address.kinds.includes('SHIP_TO') && isCustomer(next.roles) && !addresses.some((entry) => entry.isDefaultShipTo),
      }
      touched.addresses.push(await insertAddress(tools, party, address.address, defaults, ACTION))
    }
  }

  const contacts = await tx.partyContact.findMany({ where: { partyId: recordId, status: 'ACTIVE' }, select: CONTACT_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const match = matchContact(values, contacts.map(contactFieldsOf))
  const matched = match ? contacts.find((contact) => contact.email === match.email && contact.name === match.name)! : null
  const contact = contactOfRow(values, match)
  if (contact && !contact.ok) throw new ImportRowRefused(code, messages(contact.issues))
  if (contact?.ok) {
    if (matched) {
      const before = contactFieldsOf(matched)
      if (before.name !== contact.contact.name || before.phone !== contact.contact.phone) {
        await tx.partyContact.update({ where: { id: matched.id }, data: { name: contact.contact.name, phone: contact.contact.phone, version: { increment: 1 } }, select: { id: true } })
        tools.audit({ action: ACTION, recordType: 'PartyContact', recordId: matched.id, companyId: row.companyId, before: { name: before.name, phone: before.phone }, after: { name: contact.contact.name, phone: contact.contact.phone } })
        touched.contacts.push(matched.id)
      }
    } else {
      if (contact.contact.email !== null && contacts.some((entry) => entry.email === contact.contact.email)) throw new ImportRowRefused(code, `another contact has ${contact.contact.email}`)
      touched.contacts.push(await insertContact(tools, party, contact.contact, ACTION))
    }
  }
  if (touched.addresses.length > 0) tools.emit({ type: 'party.addresses_changed', subject: recordId, companyId: row.companyId, payload: { partyId: recordId, code: next.code, addressIds: touched.addresses } })
  if (touched.contacts.length > 0) tools.emit({ type: 'party.contacts_changed', subject: recordId, companyId: row.companyId, payload: { partyId: recordId, code: next.code, contactIds: touched.contacts } })
}

export const partiesImportAdapter = Object.freeze({
  importer: partiesImporter,
  permission: PARTIES_MANAGE,
  viewPermission: PARTIES_VIEW,

  authorize(actor, job) {
    const grants = grantsFor(actor, PARTIES_MANAGE)
    if (job.companyId === null) {
      return grants.some((grant) => grant.companies === 'all' && grant.parties === 'all')
        ? []
        : [{ path: 'companyId', message: 'A parties import for every company needs parties.manage over every company; import for one company instead.' }]
    }
    const companyId = job.companyId
    return grants.some((grant) => (grant.companies === 'all' || grant.companies.includes(companyId)) && grant.parties === 'all')
      ? []
      : [{ path: 'companyId', message: "Importing parties needs parties.manage over every party of the import's company: a role limited to some customers or suppliers adds no new ones." }]
  },

  async load(client, keys, scope) {
    const codes = keys.map((key) => String(key.code))
    const parties = await client.party.findMany({ where: { code: { in: codes } }, select: PARTY_COLUMNS })
    const ids = parties.map((party) => party.id)
    const identities = await client.partyTaxIdentity.findMany({ where: { partyId: { in: ids } }, select: TAX_COLUMNS })
    const addresses = await client.partyAddress.findMany({ where: { partyId: { in: ids }, status: 'ACTIVE' }, select: ADDRESS_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    const contacts = await client.partyContact.findMany({ where: { partyId: { in: ids }, status: 'ACTIVE' }, select: CONTACT_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    const day = today()
    return parties.map((party) => {
      const inForce = identityAt(identities.filter((identity) => identity.partyId === party.id).map((identity) => ({ identity, validFrom: dateText(identity.validFrom) })), day)?.identity ?? null
      const registered = addresses.find((address) => address.partyId === party.id && address.kinds.includes('REGISTERED')) ?? null
      const identity = inForce ? withoutValidFrom(taxFieldsOf(inForce)) : null
      return {
        id: party.id,
        values: importRecordValues({
          fields: partyFieldsOf(party),
          status: party.status,
          foreign: party.companyId !== scope.companyId,
          identity,
          registered: registered ? addressFieldsOf(registered) : null,
          contacts: contacts.filter((contact) => contact.partyId === party.id).map(contactFieldsOf),
        }),
      }
    })
  },

  async write(tools, row, scope) {
    const values = row.values
    const code = String(row.key.code)
    if (row.action === 'UPDATE') {
      await updateRow(tools, row.recordId!, code, values, scope)
      return { recordId: row.recordId! }
    }
    const patch = partyPatchOfRow(values)
    const outcome = newParty({ ...patch, code, legalName: String(values.legalName), roles: patch.roles ?? [] })
    if (!outcome.ok) throw new ImportRowRefused(code, messages(outcome.issues))
    const party = outcome.party
    const identity = identityOfRow(values, party, null)
    const address = addressOfRow(values, party, null)
    const contact = contactOfRow(values, null)
    const problems = [...(identity && !identity.ok ? identity.issues : []), ...(address && !address.ok ? address.issues : []), ...(contact && !contact.ok ? contact.issues : [])]
    if (problems.length > 0) throw new ImportRowRefused(code, messages(problems))
    const recordId = await insertParty(
      tools,
      {
        companyId: scope.companyId,
        status: 'ACTIVE',
        fields: party,
        identity: identity?.ok ? { ...identity.identity, validFrom: dayOf(tools.now) } : null,
        addresses: address?.ok ? [{ ...address.address, isDefaultBillTo: address.address.kinds.includes('BILL_TO'), isDefaultShipTo: address.address.kinds.includes('SHIP_TO') }] : [],
        contacts: contact?.ok ? [contact.contact] : [],
      },
      ACTION,
    )
    return { recordId }
  },
} satisfies ImportAdapter)
