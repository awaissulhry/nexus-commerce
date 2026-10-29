import { ConflictError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { changeAddress, checkAddress, defaultProblems } from '@nexus/factory-domain/parties/addresses'
import { changeContact, checkContact } from '@nexus/factory-domain/parties/contacts'
import type { AddressBody, ContactBody, DefaultAddressesBody, PartyView, UpdateAddressBody, UpdateContactBody } from '@nexus/factory-domain/parties/contracts'
import { PARTIES_MANAGE } from '@nexus/factory-domain/parties/permissions'
import { command, type CommandCaller, type CommandTools } from '../../core/command'
import { getParty, viewInTx } from './parties'
import {
  ADDRESS_COLUMNS,
  addressFieldsOf,
  assertMayWrite,
  assertWritable,
  bumpVersion,
  clearDefault,
  CONTACT_COLUMNS,
  contactFieldsOf,
  contextOf,
  insertAddress,
  insertContact,
  lockParty,
  readParty,
  touchParty,
  withDefaults,
  type PartyRowData,
} from './store'

/**
 * A party's addresses and contacts (features SAL-003, SAL-004, SCM-004): added, changed, removed (archived: quotes,
 * shipments and mail point at them; no runtime role deletes a party's row) and restored, and the party's default
 * invoice and delivery addresses. Each write takes the party's lock first, then compares and sets the child's own
 * version, so a contact change never clashes with an edit of the party itself; a default that moves moves the party's
 * version too. Each write records an audit row on the child and one on the party (the party's history shows its
 * children), and its event.
 */

const prefixed = (issues: readonly Issue[], at = 'body'): Issue[] => issues.map((issue) => ({ path: `${at}/${issue.path}`, message: issue.message }))

function recordOnParty(tools: CommandTools, party: PartyRowData, what: 'address' | 'contact', change: { before?: unknown; after: unknown }): void {
  tools.audit({ recordType: 'Party', recordId: party.id, companyId: party.companyId, ...(change.before === undefined ? {} : { before: { [what]: change.before } }), after: { [what]: change.after } })
}

async function writableParty(caller: CommandCaller, partyId: string): Promise<PartyRowData> {
  const party = await readParty(caller, partyId)
  assertMayWrite(contextOf(caller), PARTIES_MANAGE, party)
  assertWritable(party.status)
  return party
}

/** Inside the command: the party's lock, and it is still not archived. */
async function lockWritable(tools: CommandTools, partyId: string): Promise<void> {
  assertWritable((await lockParty(tools.tx, partyId)).status)
}

// ---- addresses ---------------------------------------------------------------------------------------------------------

/**
 * parties.addAddress: a new address (SAL-003). Marked as a default, or the party's first address with that use, it
 * becomes the default invoice (delivery) address and the old default stops being one.
 */
export async function addAddress(caller: CommandCaller, partyId: string, body: AddressBody, idempotencyKey?: string): Promise<PartyView> {
  const party = await writableParty(caller, partyId)
  const outcome = checkAddress(body)
  if (!outcome.ok) throw new ValidationError('The address is not valid.', prefixed(outcome.issues))
  const asked = { isDefaultBillTo: body.isDefaultBillTo === true, isDefaultShipTo: body.isDefaultShipTo === true }
  const problems = defaultProblems(outcome.address.kinds, asked)
  if (problems.length > 0) throw new ValidationError('The address is not valid.', prefixed(problems))

  const { result } = await command(caller, { name: 'parties.addAddress', idempotencyKey, input: { partyId, ...body } }, async (tools) => {
    const { tx } = tools
    await lockWritable(tools, partyId)
    const existing = await tx.partyAddress.findMany({ where: { partyId, status: 'ACTIVE' }, select: { isDefaultBillTo: true, isDefaultShipTo: true } })
    const [defaults] = withDefaults([{ kinds: outcome.address.kinds, ...asked }], { billTo: existing.some((row) => row.isDefaultBillTo) && !asked.isDefaultBillTo, shipTo: existing.some((row) => row.isDefaultShipTo) && !asked.isDefaultShipTo })
    const flags = { isDefaultBillTo: defaults!.isDefaultBillTo, isDefaultShipTo: defaults!.isDefaultShipTo }
    const cleared = [...(flags.isDefaultBillTo ? await clearDefault(tx, partyId, 'isDefaultBillTo', null) : []), ...(flags.isDefaultShipTo ? await clearDefault(tx, partyId, 'isDefaultShipTo', null) : [])]
    const id = await insertAddress(tools, party, outcome.address, flags)
    if (flags.isDefaultBillTo || flags.isDefaultShipTo) await touchParty(tx, partyId)
    recordOnParty(tools, party, 'address', { after: { id, ...outcome.address, ...flags } })
    tools.emit({ type: 'party.addresses_changed', subject: partyId, companyId: party.companyId, payload: { partyId, code: party.code, addressIds: [id, ...new Set(cleared)] } })
    return viewInTx(tx, partyId, tools.now)
  })
  return result
}

/**
 * parties.updateAddress: its fields (versioned), `status` ARCHIVED to remove it, ACTIVE to restore it. A removed
 * address, or one that loses the use, stops being the default for it (the party's version moves).
 */
export async function updateAddress(caller: CommandCaller, partyId: string, addressId: string, body: UpdateAddressBody, idempotencyKey?: string): Promise<PartyView> {
  const party = await writableParty(caller, partyId)
  if (!isUuid(addressId)) throw new NotFoundError('Address not found.')
  const seen = await caller.withClient((client) => client.partyAddress.findUnique({ where: { id: addressId }, select: ADDRESS_COLUMNS }))
  if (!seen || seen.partyId !== partyId) throw new NotFoundError('Address not found.')
  const { version, status, ...patch } = body
  const preview = changeAddress(addressFieldsOf(seen), patch)
  if (!preview.ok) throw new ValidationError('The address is not valid.', prefixed(preview.issues))
  if (preview.changed.length === 0 && (status === undefined || status === seen.status)) return getParty(caller, partyId)

  const { result } = await command(caller, { name: 'parties.updateAddress', idempotencyKey, input: { partyId, addressId, ...body } }, async (tools) => {
    const { tx } = tools
    await lockWritable(tools, partyId)
    await bumpVersion(tx, 'address', addressId, version)
    const row = await tx.partyAddress.findUniqueOrThrow({ where: { id: addressId }, select: ADDRESS_COLUMNS })
    const change = changeAddress(addressFieldsOf(row), patch)
    if (!change.ok) throw new ValidationError('The address is not valid.', prefixed(change.issues))
    const next = { ...change.address, status: status ?? row.status }
    const archived = next.status === 'ARCHIVED'
    const flags = {
      isDefaultBillTo: row.isDefaultBillTo && !archived && next.kinds.includes('BILL_TO'),
      isDefaultShipTo: row.isDefaultShipTo && !archived && next.kinds.includes('SHIP_TO'),
    }
    const before = { ...addressFieldsOf(row), status: row.status, isDefaultBillTo: row.isDefaultBillTo, isDefaultShipTo: row.isDefaultShipTo }
    const after = { ...change.address, status: next.status, ...flags }
    await tx.partyAddress.update({ where: { id: addressId }, data: { ...change.address, kinds: [...change.address.kinds], status: next.status, ...flags }, select: { id: true } })
    if (flags.isDefaultBillTo !== row.isDefaultBillTo || flags.isDefaultShipTo !== row.isDefaultShipTo) await touchParty(tx, partyId)
    tools.audit({ recordType: 'PartyAddress', recordId: addressId, companyId: party.companyId, before, after })
    recordOnParty(tools, party, 'address', { before: { id: addressId, ...before }, after: { id: addressId, ...after } })
    tools.emit({ type: 'party.addresses_changed', subject: partyId, companyId: party.companyId, payload: { partyId, code: party.code, addressIds: [addressId] } })
    return viewInTx(tx, partyId, tools.now)
  })
  return result
}

/**
 * parties.setDefaultAddresses: the party's default invoice and delivery addresses (versioned on the PARTY: two changes
 * of a default never both win). Left out: unchanged; null: no default; an id: an active address of the party with that
 * use, and the old default stops being one.
 */
export async function setDefaultAddresses(caller: CommandCaller, partyId: string, body: DefaultAddressesBody, idempotencyKey?: string): Promise<PartyView> {
  const party = await writableParty(caller, partyId)
  const { result } = await command(
    caller,
    { name: 'parties.setDefaultAddresses', idempotencyKey, input: { partyId, ...body }, record: { type: 'Party', id: partyId, expectedVersion: body.version } },
    async (tools) => {
      const { tx } = tools
      assertWritable((await tx.party.findUniqueOrThrow({ where: { id: partyId }, select: { status: true } })).status)
      const addresses = await tx.partyAddress.findMany({ where: { partyId }, select: ADDRESS_COLUMNS })
      const before = { billToAddressId: addresses.find((row) => row.isDefaultBillTo)?.id ?? null, shipToAddressId: addresses.find((row) => row.isDefaultShipTo)?.id ?? null }
      const issues: Issue[] = []
      const changed = new Set<string>()
      const set = async (target: string | null | undefined, which: 'isDefaultBillTo' | 'isDefaultShipTo', kind: 'BILL_TO' | 'SHIP_TO', path: string) => {
        if (target === undefined) return
        if (target !== null) {
          const address = addresses.find((row) => row.id === target)
          if (!address || address.status !== 'ACTIVE') return void issues.push({ path, message: 'Expected an active address of this party.' })
          if (!address.kinds.includes(kind)) return void issues.push({ path, message: `The address is not a ${kind} address.` })
        }
        for (const id of await clearDefault(tx, partyId, which, target)) changed.add(id)
        if (target !== null && !addresses.find((row) => row.id === target)![which]) {
          await tx.partyAddress.update({ where: { id: target }, data: { [which]: true, version: { increment: 1 } }, select: { id: true } })
          changed.add(target)
        }
      }
      await set(body.billToAddressId, 'isDefaultBillTo', 'BILL_TO', 'body/billToAddressId')
      await set(body.shipToAddressId, 'isDefaultShipTo', 'SHIP_TO', 'body/shipToAddressId')
      if (issues.length > 0) throw new ValidationError('The default addresses are not valid.', issues)
      const after = {
        billToAddressId: body.billToAddressId === undefined ? before.billToAddressId : body.billToAddressId,
        shipToAddressId: body.shipToAddressId === undefined ? before.shipToAddressId : body.shipToAddressId,
      }
      tools.audit({ recordType: 'Party', recordId: partyId, companyId: party.companyId, before, after })
      if (changed.size > 0) tools.emit({ type: 'party.addresses_changed', subject: partyId, companyId: party.companyId, payload: { partyId, code: party.code, addressIds: [...changed] } })
      return viewInTx(tx, partyId, tools.now)
    },
  )
  return result
}

// ---- contacts ----------------------------------------------------------------------------------------------------------

async function emailTaken(tools: CommandTools, partyId: string, email: string | null, except: string | null): Promise<void> {
  if (email === null) return
  const other = await tools.tx.partyContact.findFirst({ where: { partyId, email, status: 'ACTIVE', ...(except ? { id: { not: except } } : {}) }, select: { id: true } })
  if (other) throw new ConflictError(`Another contact of this party has ${email}: change that one, or give this one another address.`)
}

/** parties.addContact: a person at the party, with what they deal with (SAL-004, SCM-004). */
export async function addContact(caller: CommandCaller, partyId: string, body: ContactBody, idempotencyKey?: string): Promise<PartyView> {
  const party = await writableParty(caller, partyId)
  const outcome = checkContact(body)
  if (!outcome.ok) throw new ValidationError('The contact is not valid.', prefixed(outcome.issues))
  const { result } = await command(caller, { name: 'parties.addContact', idempotencyKey, input: { partyId, ...body } }, async (tools) => {
    await lockWritable(tools, partyId)
    await emailTaken(tools, partyId, outcome.contact.email, null)
    const id = await insertContact(tools, party, outcome.contact)
    recordOnParty(tools, party, 'contact', { after: { id, ...outcome.contact } })
    tools.emit({ type: 'party.contacts_changed', subject: partyId, companyId: party.companyId, payload: { partyId, code: party.code, contactIds: [id] } })
    return viewInTx(tools.tx, partyId, tools.now)
  })
  return result
}

/** parties.updateContact: its fields (versioned), `status` ARCHIVED to remove it, ACTIVE to restore it. */
export async function updateContact(caller: CommandCaller, partyId: string, contactId: string, body: UpdateContactBody, idempotencyKey?: string): Promise<PartyView> {
  const party = await writableParty(caller, partyId)
  if (!isUuid(contactId)) throw new NotFoundError('Contact not found.')
  const seen = await caller.withClient((client) => client.partyContact.findUnique({ where: { id: contactId }, select: CONTACT_COLUMNS }))
  if (!seen || seen.partyId !== partyId) throw new NotFoundError('Contact not found.')
  const { version, status, ...patch } = body
  const preview = changeContact(contactFieldsOf(seen), patch)
  if (!preview.ok) throw new ValidationError('The contact is not valid.', prefixed(preview.issues))
  if (preview.changed.length === 0 && (status === undefined || status === seen.status)) return getParty(caller, partyId)

  const { result } = await command(caller, { name: 'parties.updateContact', idempotencyKey, input: { partyId, contactId, ...body } }, async (tools) => {
    const { tx } = tools
    await lockWritable(tools, partyId)
    await bumpVersion(tx, 'contact', contactId, version)
    const row = await tx.partyContact.findUniqueOrThrow({ where: { id: contactId }, select: CONTACT_COLUMNS })
    const change = changeContact(contactFieldsOf(row), patch)
    if (!change.ok) throw new ValidationError('The contact is not valid.', prefixed(change.issues))
    const nextStatus = status ?? row.status
    if (nextStatus === 'ACTIVE') await emailTaken(tools, partyId, change.contact.email, contactId)
    const before = { ...contactFieldsOf(row), status: row.status }
    const after = { ...change.contact, status: nextStatus }
    await tx.partyContact.update({ where: { id: contactId }, data: { ...change.contact, roles: [...change.contact.roles], status: nextStatus }, select: { id: true } })
    tools.audit({ recordType: 'PartyContact', recordId: contactId, companyId: party.companyId, before, after })
    recordOnParty(tools, party, 'contact', { before: { id: contactId, ...before }, after: { id: contactId, ...after } })
    tools.emit({ type: 'party.contacts_changed', subject: partyId, companyId: party.companyId, payload: { partyId, code: party.code, contactIds: [contactId] } })
    return viewInTx(tx, partyId, tools.now)
  })
  return result
}
