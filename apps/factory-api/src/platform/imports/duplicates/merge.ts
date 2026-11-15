import { ConflictError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import { IMPORTS_DUPLICATES_MERGE } from '@nexus/factory-domain/imports/duplicates/permissions'
import { coloursToMove, contactsToMove, mergeRefusals, useGroups, type DuplicateRecordType, type MergeRefusal, type MergeSide, type TableUse } from '@nexus/factory-domain/imports/duplicates/rules'
import { PARTIES_MANAGE, PARTIES_VIEW } from '@nexus/factory-domain/parties/permissions'
import { partyMachine, type PartyStatus } from '@nexus/factory-domain/parties/rules'
import { PRODUCT_MATERIALS_MANAGE, PRODUCT_MATERIALS_VIEW } from '@nexus/factory-domain/product/materials/permissions'
import { materialMachine } from '@nexus/factory-domain/product/materials/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { ApiError } from '../../../core/errors'
import { mayWrite as mayWriteParty } from '../../../modules/parties/store'
import { mayWrite as mayWriteMaterial } from '../../../modules/product/materials/store'
import { referencesTo, usesOf } from './references'

/**
 * Merge a duplicate into the record that stays (B-W2b-427; PLT-178). A person's decision, never automatic: the preview
 * says what moves, what stays and why a merge cannot go ahead; the merge re-reads all of it inside ONE command and
 * refuses (409 in words) when anything changed.
 *
 * Nothing is deleted and no document is re-pointed: the duplicate is archived (its own audit row, `mergedInto`), and
 * only its own parts nobody else points to move — a party's active contacts (not one whose e-mail the record that stays
 * has) and active, not refused addresses (a moved default stays one only where the record that stays has none), its
 * tax identities when the record that stays has none; a material's active colours whose code the material that stays
 * lacks. A duplicate any other record points to (orders, invoices, stock, BOM lines, portal users …: the foreign keys of
 * the database, references.ts) is refused with what uses it: those records keep the one they were made for.
 */

const PARTY_PARTS = [
  { table: 'PartyContact', column: 'partyId' },
  { table: 'PartyAddress', column: 'partyId' },
  { table: 'PartyTaxIdentity', column: 'partyId' },
] as const
const MATERIAL_PARTS = [{ table: 'ItemColour', column: 'itemId' }] as const

type Reader = Pick<CommandTx, 'party' | 'partyContact' | 'partyAddress' | 'partyTaxIdentity' | 'item' | 'itemColour' | '$queryRaw' | '$queryRawUnsafe'>

interface Side extends MergeSide {
  readonly name: string
  readonly version: number
  readonly roles: readonly string[]
}

interface Counts {
  contacts: number
  addresses: number
  taxIdentities: number
  colours: number
}

/** What a merge would do (or why it cannot), as read now. */
export interface MergePlan {
  readonly recordType: DuplicateRecordType
  readonly kept: Side
  readonly dropped: Side
  readonly refusals: MergeRefusal[]
  readonly uses: TableUse[]
  readonly reverseWorks: boolean
  readonly move: { readonly contacts: string[]; readonly addresses: { id: string; isDefaultBillTo: boolean; isDefaultShipTo: boolean }[]; readonly taxIdentities: string[]; readonly colours: string[] }
  readonly stays: Counts
}

const NONE: Counts = { contacts: 0, addresses: 0, taxIdentities: 0, colours: 0 }

function contextOf(caller: CommandCaller): RequestContext {
  if (!caller.factoryContext) throw new ApiError('unauthenticated')
  return caller.factoryContext
}

const viewOf = (side: Side) => ({ id: side.id, code: side.code, name: side.name, status: side.status, companyId: side.companyId, version: side.version, kind: side.kind ?? null, roles: [...side.roles] })

// ---- parties -----------------------------------------------------------------------------------------------------------

async function partySide(client: Reader, actor: Actor, id: string): Promise<Side> {
  const row = isUuid(id) ? await client.party.findUnique({ where: { id }, select: { id: true, code: true, legalName: true, tradeName: true, status: true, companyId: true, version: true, roles: true } }) : null
  if (!row || !can(actor, PARTIES_VIEW, { companyId: row.companyId, partyId: row.id })) throw new NotFoundError('Party not found.')
  return { id: row.id, code: row.code, name: row.tradeName ?? row.legalName, status: row.status, companyId: row.companyId, version: row.version, roles: [...row.roles], kind: null }
}

const mayMergeParty = (actor: Actor, side: Side) => mayWriteParty(actor, PARTIES_MANAGE, side) && mayWriteParty(actor, IMPORTS_DUPLICATES_MERGE, side)

async function partyPlan(client: Reader, actor: Actor, keptId: string, droppedId: string, droppedStatus?: string): Promise<MergePlan> {
  const kept = await partySide(client, actor, keptId)
  const seen = await partySide(client, actor, droppedId)
  const dropped = droppedStatus ? { ...seen, status: droppedStatus } : seen
  const [contacts, addresses, identities, keptContacts, keptDefaults, keptIdentities] = await Promise.all([
    client.partyContact.findMany({ where: { partyId: dropped.id }, select: { id: true, email: true, status: true, erasedAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    client.partyAddress.findMany({ where: { partyId: dropped.id }, select: { id: true, status: true, approvalStatus: true, isDefaultBillTo: true, isDefaultShipTo: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    client.partyTaxIdentity.findMany({ where: { partyId: dropped.id }, select: { id: true } }),
    client.partyContact.findMany({ where: { partyId: kept.id, erasedAt: null }, select: { email: true } }),
    client.partyAddress.findMany({ where: { partyId: kept.id, OR: [{ isDefaultBillTo: true }, { isDefaultShipTo: true }] }, select: { isDefaultBillTo: true, isDefaultShipTo: true } }),
    client.partyTaxIdentity.count({ where: { partyId: kept.id } }),
  ])
  const [uses, keptUses, contactUses, addressUses, identityUses] = await Promise.all([
    usesOf(client, 'Party', dropped.id, PARTY_PARTS),
    usesOf(client, 'Party', kept.id, PARTY_PARTS),
    referencesTo(client, 'PartyContact', contacts.map((row) => row.id)),
    referencesTo(client, 'PartyAddress', addresses.map((row) => row.id)),
    referencesTo(client, 'PartyTaxIdentity', identities.map((row) => row.id)),
  ])
  const free = contacts.filter((row) => row.status === 'ACTIVE' && row.erasedAt === null && !contactUses.has(row.id))
  const contactSplit = contactsToMove(free, keptContacts.map((row) => row.email))
  const movable = addresses.filter((row) => row.status === 'ACTIVE' && row.approvalStatus !== 'REFUSED' && !addressUses.has(row.id))
  const hasBill = keptDefaults.some((row) => row.isDefaultBillTo)
  const hasShip = keptDefaults.some((row) => row.isDefaultShipTo)
  const identitiesMove = keptIdentities === 0 && identities.every((row) => !identityUses.has(row.id))
  const mayChangeBoth = mayMergeParty(actor, kept) && mayMergeParty(actor, seen)
  const refusals = mergeRefusals({ recordType: 'PARTY', kept, dropped, uses, mayChangeBoth })
  const reverse = mergeRefusals({ recordType: 'PARTY', kept: dropped, dropped: kept, uses: keptUses, mayChangeBoth })
  return {
    recordType: 'PARTY',
    kept,
    dropped,
    refusals,
    uses,
    reverseWorks: refusals.length > 0 && reverse.length === 0,
    move: {
      contacts: contactSplit.move.map((row) => row.id),
      addresses: movable.map((row) => ({ id: row.id, isDefaultBillTo: row.isDefaultBillTo && !hasBill, isDefaultShipTo: row.isDefaultShipTo && !hasShip })),
      taxIdentities: identitiesMove ? identities.map((row) => row.id) : [],
      colours: [],
    },
    stays: { contacts: contacts.length - contactSplit.move.length, addresses: addresses.length - movable.length, taxIdentities: identitiesMove ? 0 : identities.length, colours: 0 },
  }
}

// ---- materials ---------------------------------------------------------------------------------------------------------

async function materialSide(client: Reader, actor: Actor, id: string): Promise<Side> {
  const row = isUuid(id) ? await client.item.findUnique({ where: { id }, select: { id: true, code: true, name: true, status: true, companyId: true, version: true, kind: true } }) : null
  if (!row || row.kind === 'FINISHED' || !can(actor, PRODUCT_MATERIALS_VIEW, { companyId: row.companyId })) throw new NotFoundError('Material not found.')
  return { id: row.id, code: row.code, name: row.name, status: row.status, companyId: row.companyId, version: row.version, roles: [], kind: row.kind }
}

const mayMergeMaterial = (actor: Actor, side: Side) => mayWriteMaterial(actor, PRODUCT_MATERIALS_MANAGE, side.companyId) && mayWriteMaterial(actor, IMPORTS_DUPLICATES_MERGE, side.companyId)

async function materialPlan(client: Reader, actor: Actor, keptId: string, droppedId: string, droppedStatus?: string): Promise<MergePlan> {
  const kept = await materialSide(client, actor, keptId)
  const seen = await materialSide(client, actor, droppedId)
  const dropped = droppedStatus ? { ...seen, status: droppedStatus } : seen
  const [colours, keptColours] = await Promise.all([
    client.itemColour.findMany({ where: { itemId: dropped.id }, select: { id: true, code: true, status: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] }),
    client.itemColour.findMany({ where: { itemId: kept.id }, select: { code: true } }),
  ])
  const [uses, keptUses, colourUses] = await Promise.all([
    usesOf(client, 'Item', dropped.id, MATERIAL_PARTS),
    usesOf(client, 'Item', kept.id, MATERIAL_PARTS),
    referencesTo(client, 'ItemColour', colours.map((row) => row.id)),
  ])
  const split = coloursToMove(
    colours.filter((row) => row.status === 'ACTIVE' && !colourUses.has(row.id)),
    keptColours.map((row) => row.code),
  )
  const mayChangeBoth = mayMergeMaterial(actor, kept) && mayMergeMaterial(actor, seen)
  const refusals = mergeRefusals({ recordType: 'MATERIAL', kept, dropped, uses, mayChangeBoth })
  const reverse = mergeRefusals({ recordType: 'MATERIAL', kept: dropped, dropped: kept, uses: keptUses, mayChangeBoth })
  return {
    recordType: 'MATERIAL',
    kept,
    dropped,
    refusals,
    uses,
    reverseWorks: refusals.length > 0 && reverse.length === 0,
    move: { contacts: [], addresses: [], taxIdentities: [], colours: split.move.map((row) => row.id) },
    stays: { ...NONE, colours: colours.length - split.move.length },
  }
}

// ---- the routes' work --------------------------------------------------------------------------------------------------

const planOf = (client: Reader, actor: Actor, recordType: DuplicateRecordType, keptId: string, droppedId: string, droppedStatus?: string) =>
  recordType === 'PARTY' ? partyPlan(client, actor, keptId, droppedId, droppedStatus) : materialPlan(client, actor, keptId, droppedId, droppedStatus)

const previewOf = (plan: MergePlan) => ({
  recordType: plan.recordType,
  kept: viewOf(plan.kept),
  dropped: viewOf(plan.dropped),
  refusals: plan.refusals,
  uses: useGroups(plan.uses),
  moves: { contacts: plan.move.contacts.length, addresses: plan.move.addresses.length, taxIdentities: plan.move.taxIdentities.length, colours: plan.move.colours.length },
  stays: plan.stays,
  reverseWorks: plan.reverseWorks,
})

/** GET /duplicates/:recordType/merge: what merging `droppedId` into `keptId` would do, or why it cannot. */
export async function previewMerge(caller: CommandCaller, recordType: DuplicateRecordType, keptId: string, droppedId: string) {
  const actor = actorOf(contextOf(caller))
  return previewOf(await caller.withClient((client) => planOf(client, actor, recordType, keptId, droppedId)))
}

/** The refusal of a merge in words (409), the first reason first. */
const REFUSAL_WORDS: Readonly<Record<MergeRefusal, (plan: MergePlan) => string>> = {
  SAME_RECORD: () => 'A record cannot be merged into itself.',
  KEPT_ARCHIVED: (plan) => `${plan.kept.code} is archived: reactivate it before merging into it.`,
  DROPPED_ARCHIVED: (plan) => `${plan.dropped.code} is archived already.`,
  DROPPED_BLOCKED: (plan) => `${plan.dropped.code} is blocked: unblock it first, so the block is never lost.`,
  KIND_DIFFERS: (plan) => `${plan.dropped.code} and ${plan.kept.code} are different kinds of material.`,
  OTHER_COMPANY: (plan) => `${plan.dropped.code} and ${plan.kept.code} belong to different companies.`,
  EVERY_COMPANY: (plan) => `${plan.dropped.code} is for every company: it is merged only into another record for every company.`,
  IN_USE: (plan) => `${plan.dropped.code} is used by other records (${plan.uses.reduce((sum, use) => sum + use.count, 0)}): they keep it. Open it and keep using one of them.`,
  NO_RIGHT: () => 'Merging needs imports.duplicates.merge and the right to change both records.',
}

const isForeignKeyViolation = (error: unknown): boolean => {
  const found = error as { code?: unknown; meta?: { code?: unknown } } | null
  return found?.code === 'P2003' || found?.code === '23503' || found?.meta?.code === '23503'
}

/** Locks the record that stays at the version the person merged into, and moves its version. */
async function lockKept(tx: CommandTx, recordType: DuplicateRecordType, id: string, version: number): Promise<void> {
  const rows =
    recordType === 'PARTY'
      ? await tx.$queryRaw<{ version: number }[]>`SELECT "version" FROM "Party" WHERE "id" = ${id}::uuid FOR UPDATE`
      : await tx.$queryRaw<{ version: number }[]>`SELECT "version" FROM "Item" WHERE "id" = ${id}::uuid FOR UPDATE`
  const row = rows[0]
  if (!row) throw new NotFoundError(recordType === 'PARTY' ? 'Party not found.' : 'Material not found.')
  if (Number(row.version) !== version) throw new ConflictError(`The record that stays changed since it was read (version ${version}); it is now at version ${row.version}. Look at the merge again.`)
  if (recordType === 'PARTY') await tx.party.update({ where: { id }, data: { version: { increment: 1 } }, select: { id: true } })
  else await tx.item.update({ where: { id }, data: { version: { increment: 1 } }, select: { id: true } })
}

async function movePartyParts(tools: CommandTools, plan: MergePlan): Promise<void> {
  const { tx } = tools
  const kept = plan.kept
  const audit = (recordType: string, recordId: string) =>
    tools.audit({ action: 'imports.duplicates.merge', recordType, recordId, companyId: kept.companyId, before: { partyId: plan.dropped.id }, after: { partyId: kept.id } })
  if (plan.move.contacts.length > 0) {
    await tx.partyContact.updateMany({ where: { id: { in: plan.move.contacts }, partyId: plan.dropped.id }, data: { partyId: kept.id, version: { increment: 1 } } })
    for (const id of plan.move.contacts) audit('PartyContact', id)
    tools.emit({ type: 'party.contacts_changed', subject: kept.id, companyId: kept.companyId, payload: { partyId: kept.id, code: kept.code, contactIds: plan.move.contacts } })
  }
  if (plan.move.addresses.length > 0) {
    for (const address of plan.move.addresses) {
      await tx.partyAddress.update({
        where: { id: address.id },
        data: { partyId: kept.id, isDefaultBillTo: address.isDefaultBillTo, isDefaultShipTo: address.isDefaultShipTo, version: { increment: 1 } },
        select: { id: true },
      })
      audit('PartyAddress', address.id)
    }
    tools.emit({ type: 'party.addresses_changed', subject: kept.id, companyId: kept.companyId, payload: { partyId: kept.id, code: kept.code, addressIds: plan.move.addresses.map((address) => address.id) } })
  }
  if (plan.move.taxIdentities.length > 0) {
    await tx.partyTaxIdentity.updateMany({ where: { id: { in: plan.move.taxIdentities }, partyId: plan.dropped.id }, data: { partyId: kept.id, version: { increment: 1 } } })
    for (const id of plan.move.taxIdentities) {
      audit('PartyTaxIdentity', id)
      tools.emit({ type: 'party.tax_identity_changed', subject: kept.id, companyId: kept.companyId, payload: { partyId: kept.id, code: kept.code, taxIdentityId: id } })
    }
  }
}

async function moveMaterialParts(tools: CommandTools, plan: MergePlan): Promise<void> {
  if (plan.move.colours.length === 0) return
  const kept = plan.kept
  await tools.tx.itemColour.updateMany({ where: { id: { in: plan.move.colours }, itemId: plan.dropped.id }, data: { itemId: kept.id, version: { increment: 1 } } })
  for (const id of plan.move.colours) tools.audit({ action: 'imports.duplicates.merge', recordType: 'ItemColour', recordId: id, companyId: kept.companyId, before: { itemId: plan.dropped.id }, after: { itemId: kept.id } })
  tools.emit({ type: 'material.colours_changed', subject: kept.id, companyId: kept.companyId, payload: { itemId: kept.id, code: kept.code, itemColourIds: plan.move.colours } })
}

export interface MergeBody {
  readonly keptId: string
  readonly droppedId: string
  readonly keptVersion: number
  readonly droppedVersion: number
  readonly reason: string
}

/**
 * POST /duplicates/:recordType/merge: ONE command — the duplicate's version guard and its move to ARCHIVED, the record
 * that stays locked at its version, the plan read again inside the transaction (a refusal now is a 409 in words), the
 * free parts moved, an audit row on both records (with the reason) and on each moved part, the records' own events and
 * duplicate.merged.
 */
export async function mergeRecords(caller: CommandCaller, recordType: DuplicateRecordType, body: MergeBody, idempotencyKey?: string) {
  const context = contextOf(caller)
  const actor = actorOf(context)
  const before = await caller.withClient((client) => planOf(client, actor, recordType, body.keptId, body.droppedId))
  if (before.refusals.length > 0) {
    const first = before.refusals[0]!
    if (first === 'NO_RIGHT') throw new ApiError('forbidden', REFUSAL_WORDS.NO_RIGHT(before))
    throw new ConflictError(REFUSAL_WORDS[first](before))
  }
  const reason = body.reason.trim()
  const machine = recordType === 'PARTY' ? partyMachine : materialMachine
  const { result } = await command(
    caller,
    {
      name: 'imports.duplicates.merge',
      idempotencyKey,
      input: { recordType, ...body },
      record: { type: recordType === 'PARTY' ? 'Party' : 'Item', id: body.droppedId, expectedVersion: body.droppedVersion, transition: { machine: machine as typeof partyMachine, to: 'ARCHIVED' as PartyStatus } },
    },
    async (tools) => {
      const { tx, record } = tools
      await lockKept(tx, recordType, body.keptId, body.keptVersion)
      const plan = await planOf(tx, actor, recordType, body.keptId, body.droppedId, record!.from)
      if (plan.refusals.length > 0) throw new ConflictError(REFUSAL_WORDS[plan.refusals[0]!](plan))
      try {
        if (recordType === 'PARTY') await movePartyParts(tools, plan)
        else await moveMaterialParts(tools, plan)
      } catch (error) {
        if (isForeignKeyViolation(error)) throw new ConflictError('A part of the duplicate is now used by another record: look at the merge again.')
        throw error
      }
      const moved = { contacts: plan.move.contacts.length, addresses: plan.move.addresses.length, taxIdentities: plan.move.taxIdentities.length, colours: plan.move.colours.length }
      const recordName = recordType === 'PARTY' ? 'Party' : 'Item'
      tools.audit({ action: 'imports.duplicates.merge', recordType: recordName, recordId: plan.dropped.id, companyId: plan.dropped.companyId, before: { status: record!.from }, after: { status: 'ARCHIVED', mergedInto: plan.kept.id, mergedIntoCode: plan.kept.code }, reason })
      tools.audit({ action: 'imports.duplicates.merge', recordType: recordName, recordId: plan.kept.id, companyId: plan.kept.companyId, after: { merged: plan.dropped.id, mergedCode: plan.dropped.code, moved }, reason })
      if (recordType === 'PARTY') {
        tools.emit({ type: 'party.status_changed', subject: plan.dropped.id, companyId: plan.dropped.companyId, payload: { partyId: plan.dropped.id, code: plan.dropped.code, from: record!.from as PartyStatus, status: 'ARCHIVED' } })
      } else {
        tools.emit({ type: 'material.status_changed', subject: plan.dropped.id, companyId: plan.dropped.companyId, payload: { itemId: plan.dropped.id, code: plan.dropped.code, status: 'ARCHIVED' } })
      }
      tools.emit({
        type: 'duplicate.merged',
        subject: plan.kept.id,
        companyId: plan.kept.companyId,
        payload: { recordType, keptId: plan.kept.id, keptCode: plan.kept.code, mergedId: plan.dropped.id, mergedCode: plan.dropped.code },
      })
      return {
        recordType,
        // The plan read the record that stays after lockKept moved its version.
        kept: viewOf(plan.kept),
        dropped: { ...viewOf(plan.dropped), status: 'ARCHIVED', version: record!.version },
        moved,
      }
    },
  )
  return result
}
