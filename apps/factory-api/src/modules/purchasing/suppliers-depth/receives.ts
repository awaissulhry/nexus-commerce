import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { PARTIES_MANAGE } from '@nexus/factory-domain/parties/permissions'
import { normaliseReceives, receivesProblems, type ContactReceives } from '@nexus/factory-domain/purchasing/suppliers-depth/routing'
import { command, type CommandCaller } from '../../../core/command'
import { assertMayWrite, assertWritable, bumpVersion, contextOf, lockParty } from '../../parties/store'
import { CONTACT_COLUMNS, readSupplier, readSupplierRow } from './store'
import { supplierView } from './view'

/**
 * What a supplier's contact receives (B-W2b-311; SCM-004; design purchasing.suppliers › Contacts "Contacts and what they
 * receive", a Checkbox per cell, autosave): POs, claims, remittances, quality mail, document requests. parties.manage over
 * the supplier's company and itself; the whole list of one contact at a time, its version the edit guard (the parties'
 * lock order: the party first, then the contact's compare-and-set). Only an ACTIVE contact with an e-mail receives
 * anything. Audited; party.contacts_changed.
 *
 * Note (B-W2b-287): a change of the contact moves its updatedAt, so a bank account proposed before it can no longer be
 * called back on that contact's phone (the call-back's "on file before the proposal" rule reads it).
 */

/** parties.manage: one contact's list of what it receives. */
export async function setReceives(caller: CommandCaller, partyId: string, contactId: string, body: { readonly version: number; readonly receives: readonly ContactReceives[] }, idempotencyKey?: string) {
  const context = contextOf(caller)
  const party = await readSupplier(caller, partyId)
  assertMayWrite(context, PARTIES_MANAGE, party)
  assertWritable(party.status)
  if (!isUuid(contactId)) throw new NotFoundError('Contact not found.')
  const seen = await caller.withClient((client) => client.partyContact.findUnique({ where: { id: contactId }, select: CONTACT_COLUMNS }))
  if (!seen || seen.partyId !== partyId) throw new NotFoundError('Contact not found.')
  const receives = normaliseReceives(body.receives)
  const problems = receivesProblems(receives, seen)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems.map((issue) => ({ path: `body/${issue.path}`, message: issue.message })))

  const { result } = await command(caller, { name: 'purchasing.suppliers.receives', idempotencyKey, input: { partyId, contactId, ...body } }, async (tools) => {
    const { tx } = tools
    assertWritable((await lockParty(tx, partyId)).status)
    await bumpVersion(tx, 'contact', contactId, body.version)
    const row = await tx.partyContact.findUniqueOrThrow({ where: { id: contactId }, select: CONTACT_COLUMNS })
    const again = receivesProblems(receives, row)
    if (again.length > 0) throw new ValidationError(again[0]!.message, again.map((issue) => ({ path: `body/${issue.path}`, message: issue.message })))
    if (JSON.stringify(row.receives) !== JSON.stringify(receives)) {
      await tx.partyContact.update({ where: { id: contactId }, data: { receives: [...receives] }, select: { id: true } })
      tools.audit({ action: 'purchasing.suppliers.receives', recordType: 'PartyContact', recordId: contactId, companyId: party.companyId, before: { receives: [...row.receives] }, after: { receives: [...receives] } })
      tools.emit({ type: 'party.contacts_changed', subject: partyId, companyId: party.companyId, payload: { partyId, code: party.code, contactIds: [contactId] } })
    }
    return { supplier: await supplierView(tx, (await readSupplierRow(tx, partyId))!, tools.now) }
  })
  return result
}
