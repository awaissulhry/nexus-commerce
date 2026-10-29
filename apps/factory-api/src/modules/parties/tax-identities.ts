import { ConflictError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { PartyView, TaxIdentityBody, UpdateTaxIdentityBody } from '@nexus/factory-domain/parties/contracts'
import { PARTIES_MANAGE } from '@nexus/factory-domain/parties/permissions'
import { checkTaxIdentity, TAX_IDENTITY_FIELDS, type TaxIdentityFields } from '@nexus/factory-domain/parties/tax'
import { command, type CommandCaller } from '../../core/command'
import { getParty, viewInTx } from './parties'
import {
  assertMayWrite,
  assertNoTaxDuplicate,
  assertWritable,
  bumpVersion,
  contextOf,
  dateValue,
  insertTaxIdentity,
  isUniqueViolation,
  lockParty,
  readParty,
  TAX_COLUMNS,
  taxFieldsOf,
  today,
} from './store'

/**
 * A party's tax identities (feature SAL-005; D.Lgs. 127/2015): what an e-invoice to it needs, from a date. A change from
 * a date is a new identity (`addTaxIdentity`: one per day, the identity at a date is the newest validFrom on or before
 * it); a mistake is corrected in place (`updateTaxIdentity`, versioned): issued documents keep their own copy, and the
 * VIES checks keep the number they checked, so a corrected number starts unchecked. Every write refuses a VAT number or
 * codice fiscale another party of the tenant holds (store.ts assertNoTaxDuplicate).
 */

const prefixed = (issues: readonly Issue[], at = 'body'): Issue[] => issues.map((issue) => ({ path: `${at}/${issue.path}`, message: issue.message }))
const dayTaken = (day: string) => new ConflictError(`The party has a tax identity from ${day}: correct that one, or give this one another first day.`)

async function writableParty(caller: CommandCaller, partyId: string) {
  const party = await readParty(caller, partyId)
  assertMayWrite(contextOf(caller), PARTIES_MANAGE, party)
  assertWritable(party.status)
  return party
}

/** parties.addTaxIdentity: the party's tax identity from a day (default today, Europe/Rome). */
export async function addTaxIdentity(caller: CommandCaller, partyId: string, body: TaxIdentityBody, idempotencyKey?: string): Promise<PartyView> {
  const context = contextOf(caller)
  const party = await writableParty(caller, partyId)
  const outcome = checkTaxIdentity({ ...body, validFrom: body.validFrom ?? today() })
  if (!outcome.ok) throw new ValidationError('The tax identity is not valid.', prefixed(outcome.issues))
  const identity = outcome.identity

  const { result } = await command(caller, { name: 'parties.addTaxIdentity', idempotencyKey, input: { partyId, ...body } }, async (tools) => {
    const { tx } = tools
    assertWritable((await lockParty(tx, partyId)).status)
    if (await tx.partyTaxIdentity.findFirst({ where: { partyId, validFrom: dateValue(identity.validFrom) }, select: { id: true } })) throw dayTaken(identity.validFrom)
    await assertNoTaxDuplicate(tx, context, partyId, identity)
    const id = await insertTaxIdentity(tools, party, identity)
    tools.audit({ recordType: 'Party', recordId: partyId, companyId: party.companyId, after: { taxIdentity: { id, ...identity } } })
    tools.emit({ type: 'party.tax_identity_changed', subject: partyId, companyId: party.companyId, payload: { partyId, code: party.code, taxIdentityId: id } })
    return viewInTx(tx, partyId, tools.now)
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw dayTaken(identity.validFrom)
    throw error
  })
  return result
}

const changedFields = (before: TaxIdentityFields, after: TaxIdentityFields) => TAX_IDENTITY_FIELDS.filter((field) => before[field] !== after[field])

/** parties.updateTaxIdentity: corrects an identity (versioned); the fields left out stay as they are. */
export async function updateTaxIdentity(caller: CommandCaller, partyId: string, taxIdentityId: string, body: UpdateTaxIdentityBody, idempotencyKey?: string): Promise<PartyView> {
  const context = contextOf(caller)
  const party = await writableParty(caller, partyId)
  if (!isUuid(taxIdentityId)) throw new NotFoundError('Tax identity not found.')
  const seen = await caller.withClient((client) => client.partyTaxIdentity.findUnique({ where: { id: taxIdentityId }, select: TAX_COLUMNS }))
  if (!seen || seen.partyId !== partyId) throw new NotFoundError('Tax identity not found.')
  const { version, ...patch } = body
  const merge = (current: TaxIdentityFields) => checkTaxIdentity({ ...current, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) })
  const preview = merge(taxFieldsOf(seen))
  if (!preview.ok) throw new ValidationError('The tax identity is not valid.', prefixed(preview.issues))
  if (changedFields(taxFieldsOf(seen), preview.identity).length === 0) return getParty(caller, partyId)

  const { result } = await command(caller, { name: 'parties.updateTaxIdentity', idempotencyKey, input: { partyId, taxIdentityId, ...body } }, async (tools) => {
    const { tx } = tools
    assertWritable((await lockParty(tx, partyId)).status)
    await bumpVersion(tx, 'identity', taxIdentityId, version)
    const row = await tx.partyTaxIdentity.findUniqueOrThrow({ where: { id: taxIdentityId }, select: TAX_COLUMNS })
    const current = taxFieldsOf(row)
    const change = merge(current)
    if (!change.ok) throw new ValidationError('The tax identity is not valid.', prefixed(change.issues))
    const next = change.identity
    const fields = changedFields(current, next)
    if (fields.includes('validFrom') && (await tx.partyTaxIdentity.findFirst({ where: { partyId, validFrom: dateValue(next.validFrom), id: { not: taxIdentityId } }, select: { id: true } }))) {
      throw dayTaken(next.validFrom)
    }
    if (fields.includes('vatNumber') || fields.includes('fiscalCode')) await assertNoTaxDuplicate(tx, context, partyId, next)
    await tx.partyTaxIdentity.update({ where: { id: taxIdentityId }, data: { ...next, validFrom: dateValue(next.validFrom) }, select: { id: true } })
    const before = Object.fromEntries(fields.map((field) => [field, current[field]]))
    const after = Object.fromEntries(fields.map((field) => [field, next[field]]))
    tools.audit({ recordType: 'PartyTaxIdentity', recordId: taxIdentityId, companyId: party.companyId, before, after })
    tools.audit({ recordType: 'Party', recordId: partyId, companyId: party.companyId, before: { taxIdentity: { id: taxIdentityId, ...before } }, after: { taxIdentity: { id: taxIdentityId, ...after } } })
    tools.emit({ type: 'party.tax_identity_changed', subject: partyId, companyId: party.companyId, payload: { partyId, code: party.code, taxIdentityId } })
    return viewInTx(tx, partyId, tools.now)
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw dayTaken(body.validFrom ?? '')
    throw error
  })
  return result
}
