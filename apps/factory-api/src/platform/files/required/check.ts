import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ConflictError } from '@nexus/factory-domain/core/errors'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { dayOf } from '@nexus/factory-domain/files/expiry/rules'
import {
  blockedSentence,
  isRequiredRecordType,
  problemsOf,
  requirementSentence,
  requirementStates,
  rulesThatApply,
  type RequiredRecordType,
  type RequiredRule,
  type RequirementState,
} from '@nexus/factory-domain/files/required/rules'
import type { CommandTools, CommandTx } from '../../../core/command'

/**
 * requiredDocumentsProblems (COL-048; B-W2b-177): what a record lacks before a status move, by the company's rules
 * (admin.documents › Required documents). A module calls it INSIDE its own status command, with its transaction, before it
 * moves the record:
 *
 *   const { warnings } = await assertRequiredDocuments(tools, { recordType: 'PurchaseOrder', recordId, toStatus: 'CONFIRMED' })
 *
 * BLOCK rules not met refuse the move (409 in words, naming each missing document); WARN rules come back for the module to
 * show or record. The answer reads the record's company and party (the registry below), the company's active rules for that
 * move (the party's roles pick the party-role rules), and the CURRENT documents of the record and of its party (a supplier's
 * certificate is kept once, on the supplier). The first callers are the supplier documents (B-W2b-189) and the ship notice
 * (B-W2b-182); the record's Files panel shows the same answer before anyone tries (./record.ts).
 */

type Client = Pick<FactoryClient | CommandTx, 'storedFile' | 'requiredDocumentRule' | 'party' | 'purchaseOrder' | 'goodsReceipt' | 'shipNotice' | 'subcontractOrder' | 'shipment'>

/** What the check needs of a record: its company, its party and the party's roles, its status and a label. */
export interface RecordFacts {
  readonly companyId: string | null
  readonly partyId: string | null
  readonly partyRoles: readonly string[]
  readonly status: string
  readonly label: string
}

type Resolver = (client: Client, id: string) => Promise<Omit<RecordFacts, 'partyRoles'> | null>

const RESOLVERS: Readonly<Record<RequiredRecordType, Resolver>> = Object.freeze({
  PurchaseOrder: async (client, id) => {
    const row = await client.purchaseOrder.findUnique({ where: { id }, select: { companyId: true, partyId: true, status: true, number: true } })
    return row && { companyId: row.companyId, partyId: row.partyId, status: row.status, label: row.number }
  },
  GoodsReceipt: async (client, id) => {
    const row = await client.goodsReceipt.findUnique({ where: { id }, select: { companyId: true, supplierId: true, status: true, number: true } })
    return row && { companyId: row.companyId, partyId: row.supplierId, status: row.status, label: row.number }
  },
  ShipNotice: async (client, id) => {
    const row = await client.shipNotice.findUnique({ where: { id }, select: { companyId: true, partyId: true, status: true, number: true } })
    return row && { companyId: row.companyId, partyId: row.partyId, status: row.status, label: row.number ?? 'Ship notice' }
  },
  SubcontractOrder: async (client, id) => {
    const row = await client.subcontractOrder.findUnique({ where: { id }, select: { companyId: true, partyId: true, status: true, number: true } })
    return row && { companyId: row.companyId, partyId: row.partyId, status: row.status, label: row.number }
  },
  Shipment: async (client, id) => {
    const row = await client.shipment.findUnique({ where: { id }, select: { companyId: true, partyId: true, status: true, number: true } })
    return row && { companyId: row.companyId, partyId: row.partyId, status: row.status, label: row.number }
  },
  Party: async (client, id) => {
    const row = await client.party.findUnique({ where: { id }, select: { companyId: true, status: true, code: true, legalName: true } })
    return row && { companyId: row.companyId, partyId: id, status: row.status, label: `${row.code} ${row.legalName}` }
  },
})

/** The record's facts, or null when the type has no rules or the record is not there (in the caller's scope). */
export async function recordFactsOf(client: Client, recordType: string, recordId: string): Promise<RecordFacts | null> {
  if (!isRequiredRecordType(recordType)) return null
  const facts = await RESOLVERS[recordType](client, recordId)
  if (!facts) return null
  const party = facts.partyId ? await client.party.findUnique({ where: { id: facts.partyId }, select: { roles: true } }) : null
  return { ...facts, partyRoles: party?.roles ?? [] }
}

const RULE_SELECT = { id: true, companyId: true, recordType: true, category: true, beforeStatus: true, partyRole: true, level: true, active: true, version: true, createdAt: true, updatedAt: true } as const satisfies Prisma.RequiredDocumentRuleSelect
export type RuleRow = Prisma.RequiredDocumentRuleGetPayload<{ select: typeof RULE_SELECT }>
export { RULE_SELECT }

/**
 * The active rules a record of `companyId` meets (a tenant-wide record — a party — with no company named: every company's,
 * the strictest reading).
 */
export async function activeRulesOf(client: Client, recordType: string, companyId: string | null): Promise<RuleRow[]> {
  return client.requiredDocumentRule.findMany({
    where: { recordType, active: true, ...(companyId ? { companyId } : {}) },
    select: RULE_SELECT,
    orderBy: [{ beforeStatus: 'asc' }, { category: 'asc' }, { id: 'asc' }],
  })
}

const FILE_SELECT = { id: true, category: true, status: true, supersededAt: true, expiresOn: true, originalName: true, recordType: true, recordId: true } as const satisfies Prisma.StoredFileSelect
export type DocumentRow = Prisma.StoredFileGetPayload<{ select: typeof FILE_SELECT }>

/** The current documents of the record and of its party (tagged with a category). */
export async function documentsOf(client: Client, recordType: string, recordId: string, partyId: string | null): Promise<DocumentRow[]> {
  const owners: Prisma.StoredFileWhereInput[] = [{ recordType, recordId }]
  if (partyId && !(recordType === 'Party' && recordId === partyId)) owners.push({ recordType: 'Party', recordId: partyId })
  return client.storedFile.findMany({
    where: { OR: owners, status: 'AVAILABLE', supersededAt: null, category: { not: null } },
    select: FILE_SELECT,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 500,
  })
}

const asRule = (row: RuleRow): RequiredRule => ({ id: row.id, recordType: row.recordType, category: row.category, beforeStatus: row.beforeStatus, partyRole: row.partyRole, level: row.level, active: row.active })
const asDocument = (row: DocumentRow) => ({ id: row.id, category: row.category, status: row.status, supersededAt: row.supersededAt, expiresOn: row.expiresOn === null ? null : dayOf(row.expiresOn) })

export interface RequiredAnswer {
  readonly facts: RecordFacts
  readonly states: RequirementState[]
  readonly blocks: RequirementState[]
  readonly warnings: RequirementState[]
}

/**
 * What the record lacks before moving to `toStatus` (every applying rule's state, then the BLOCK and WARN ones not met), or
 * null when the record type has no rules or the record is not there.
 */
export async function requiredDocumentsProblems(
  client: Client,
  input: { readonly recordType: string; readonly recordId: string; readonly toStatus: string; readonly companyId?: string | null; readonly today: BusinessDate },
): Promise<RequiredAnswer | null> {
  const facts = await recordFactsOf(client, input.recordType, input.recordId)
  if (!facts) return null
  const companyId = facts.companyId ?? input.companyId ?? null
  const rules = rulesThatApply((await activeRulesOf(client, input.recordType, companyId)).map(asRule), input.recordType, input.toStatus, facts.partyRoles)
  if (rules.length === 0) return { facts, states: [], blocks: [], warnings: [] }
  const states = requirementStates(rules, (await documentsOf(client, input.recordType, input.recordId, facts.partyId)).map(asDocument), input.today)
  return { facts, states, ...problemsOf(states) }
}

/**
 * Inside a module's status command: refuses the move (409, the missing documents in words) when a BLOCK rule is not met;
 * otherwise answers the warnings. A record type with no rules answers none.
 */
export async function assertRequiredDocuments(
  tools: Pick<CommandTools, 'tx' | 'now'>,
  input: { readonly recordType: string; readonly recordId: string; readonly toStatus: string; readonly companyId?: string | null },
): Promise<{ readonly warnings: RequirementState[]; readonly sentences: string[] }> {
  const answer = await requiredDocumentsProblems(tools.tx, { ...input, today: businessDate(tools.now) })
  if (!answer) return { warnings: [], sentences: [] }
  if (answer.blocks.length > 0) throw new ConflictError(blockedSentence(answer.blocks))
  return { warnings: answer.warnings, sentences: answer.warnings.map(requirementSentence) }
}
