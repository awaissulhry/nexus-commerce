import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { PARTIES_MANAGE, PARTIES_VIEW } from '@nexus/factory-domain/parties/permissions'
import {
  appliesTo,
  endReasonProblem,
  normaliseRequirement,
  RECORD_STAGES,
  requirementProblems,
  shownOn,
  type RequirementKind,
  type RequirementRecordType,
  type RequirementStage,
} from '@nexus/factory-domain/parties/requirements/requirements'
import { isCustomer, type PartyRole } from '@nexus/factory-domain/parties/rules'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
import { SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { assertMayWrite, contextOf, lockParty, readParty, type PartyRowData } from '../store'

/**
 * A customer's requirements (B-W2b-290; SAL-014; design sales.customers record › Requirements; rules factory-domain
 * parties/requirements): packing, labelling, document, quality, shipping and invoicing rules in words, for one company or
 * every company, for every style or some, with the customer's routing guide, shown where they apply. parties.view reads;
 * parties.manage over the party (and the company the rule is for) writes. Rows of factory-db CustomerRequirement: written in
 * force and fixed; a change ends the old one and writes the one that supersedes it in ONE command; an end has its reason.
 *
 * Where they show: `GET /parties/requirements/for/:recordType/:recordId` answers the requirements in force on a quote
 * (QUOTE), an order (ORDER), a shipment (PACKING: the pick & pack screen; SHIPMENT: the shipping checklist) or an invoice
 * (INVOICE) of the customer, for the record's company and styles, to anyone who may see that record (its own view
 * permission over its place): the screens of those records read it.
 */

export const REQUIREMENT_COLUMNS = {
  id: true,
  partyId: true,
  companyId: true,
  kind: true,
  words: true,
  appliesAt: true,
  styleIds: true,
  fileId: true,
  supersedesId: true,
  active: true,
  endedAt: true,
  endedById: true,
  endReason: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.CustomerRequirementSelect
export type RequirementRow = Prisma.CustomerRequirementGetPayload<{ select: typeof REQUIREMENT_COLUMNS }>

type Reader = FactoryClient | CommandTx

async function labelsOf(db: Reader, rows: readonly RequirementRow[]) {
  const people = [...new Set(rows.flatMap((row) => [row.createdById, row.endedById]).filter((id): id is string => id !== null))]
  const styles = [...new Set(rows.flatMap((row) => row.styleIds))]
  const files = [...new Set(rows.flatMap((row) => (row.fileId ? [row.fileId] : [])))]
  const companies = [...new Set(rows.flatMap((row) => (row.companyId ? [row.companyId] : [])))]
  return {
    people: new Map((people.length > 0 ? await db.user.findMany({ where: { id: { in: people } }, select: { id: true, displayName: true } }) : []).map((row) => [row.id, row.displayName])),
    styles: new Map((styles.length > 0 ? await db.style.findMany({ where: { id: { in: styles } }, select: { id: true, code: true, name: true } }) : []).map((row) => [row.id, { code: row.code, name: row.name }])),
    files: new Map((files.length > 0 ? await db.storedFile.findMany({ where: { id: { in: files } }, select: { id: true, originalName: true } }) : []).map((row) => [row.id, row.originalName])),
    companies: new Map((companies.length > 0 ? await db.company.findMany({ where: { id: { in: companies } }, select: { id: true, code: true } }) : []).map((row) => [row.id, row.code])),
  }
}
type Labels = Awaited<ReturnType<typeof labelsOf>>

function requirementViewOf(row: RequirementRow, labels: Labels) {
  const stages = row.appliesAt as RequirementStage[]
  return {
    id: row.id,
    companyId: row.companyId,
    companyCode: row.companyId ? (labels.companies.get(row.companyId) ?? null) : null,
    kind: row.kind as RequirementKind,
    words: row.words,
    appliesAt: stages,
    shownOn: { en: shownOn(stages, 'en'), it: shownOn(stages, 'it') },
    styles: row.styleIds.map((id) => ({ id, code: labels.styles.get(id)?.code ?? '', name: labels.styles.get(id)?.name ?? '' })),
    everyStyle: row.styleIds.length === 0,
    file: row.fileId ? { id: row.fileId, fileName: labels.files.get(row.fileId) ?? '' } : null,
    supersedesId: row.supersedesId,
    active: row.active,
    createdAt: toUtcIso(row.createdAt),
    createdBy: row.createdById ? (labels.people.get(row.createdById) ?? null) : null,
    endedAt: row.endedAt ? toUtcIso(row.endedAt) : null,
    endedBy: row.endedById ? (labels.people.get(row.endedById) ?? null) : null,
    endReason: row.endReason,
    version: row.version,
  }
}
export type RequirementView = ReturnType<typeof requirementViewOf>

/** The party's requirements the caller may see (its companies' and every company's): in force first, then the history. */
export async function requirementsOf(db: Reader, context: OfficeContext, partyId: string) {
  const party = await db.party.findUniqueOrThrow({ where: { id: partyId }, select: { id: true, code: true } })
  const actor = actorOf(context)
  const rows = (await db.customerRequirement.findMany({ where: { partyId }, select: REQUIREMENT_COLUMNS, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })).filter(
    (row) => row.companyId === null || can(actor, PARTIES_VIEW, { companyId: row.companyId, partyId }),
  )
  const labels = await labelsOf(db, rows)
  const views = rows.map((row) => requirementViewOf(row, labels))
  return { partyId: party.id, code: party.code, inForce: views.filter((view) => view.active), ended: views.filter((view) => !view.active) }
}
export type PartyRequirementsView = Awaited<ReturnType<typeof requirementsOf>>

function officeOf(caller: CommandCaller): OfficeContext {
  const context = contextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** GET /parties/:partyId/requirements (parties.view). */
export async function getRequirements(caller: CommandCaller, partyId: string): Promise<{ requirements: PartyRequirementsView }> {
  const context = officeOf(caller)
  await readParty(caller, partyId)
  return caller.withClient(async (client) => ({ requirements: await requirementsOf(client, context, partyId) }))
}

export interface RequirementBody {
  readonly companyId: string | null
  readonly kind: RequirementKind
  readonly words: string
  readonly appliesAt: readonly RequirementStage[]
  readonly styleIds?: readonly string[] | undefined
  readonly fileId?: string | null | undefined
}

/** parties.manage over the party, and over the company the rule is for (every company: a grant over every company). */
function assertMayKeep(context: OfficeContext, party: PartyRowData, companyId: string | null): void {
  if (companyId === null) assertMayWrite(context, PARTIES_MANAGE, party)
  else if (!can(actorOf(context), PARTIES_MANAGE, { companyId, partyId: party.id })) throw new ForbiddenError()
}

/** The rule's own checks, before the database's: words and stages, the company, the styles and the file. */
async function checkBody(caller: CommandCaller, context: OfficeContext, party: PartyRowData, body: RequirementBody): Promise<void> {
  const issues = requirementProblems(body).map((issue) => ({ path: `body/${issue.path}`, message: issue.message }))
  const companyId = body.companyId ?? null
  if (companyId !== null) {
    if (!isUuid(companyId) || !can(actorOf(context), PARTIES_VIEW, { companyId, partyId: party.id })) issues.push({ path: 'body/companyId', message: 'Expected one of our companies you work for, or none for every company.' })
    else if (party.companyId !== null && party.companyId !== companyId) issues.push({ path: 'body/companyId', message: `${party.code} is a customer of one company only: its own company, or none.` })
  }
  const styleIds = body.styleIds ?? []
  if (styleIds.some((id) => !isUuid(id))) issues.push({ path: 'body/styleIds', message: 'Expected style ids.' })
  else if (styleIds.length > 0) {
    const found = await caller.withClient((client) => client.style.findMany({ where: { id: { in: [...styleIds] } }, select: { id: true, companyId: true } }))
    const fit = (style: { companyId: string | null }) => style.companyId === null || companyId === null || style.companyId === companyId
    if (found.length !== new Set(styleIds).size || !found.every(fit)) issues.push({ path: 'body/styleIds', message: "Styles of the rule's company, or of every company." })
  }
  if (body.fileId) {
    const file = isUuid(body.fileId) ? await caller.withClient((client) => client.storedFile.findUnique({ where: { id: body.fileId! }, select: { recordType: true, recordId: true, status: true } })) : null
    if (!file || file.status === 'DELETED' || !(file.recordType === 'Party' && file.recordId === party.id)) issues.push({ path: 'body/fileId', message: "A file of this customer (upload the routing guide to the customer's Documents first)." })
  }
  if (issues.length > 0) throw new ValidationError(issues.length === 1 ? issues[0]!.message : 'The requirement is not valid.', issues)
}

async function insertRequirement(tools: CommandTools, party: PartyRowData, body: RequirementBody, supersedesId: string | null): Promise<string> {
  const { tx, now, context } = tools
  const actorId = context.audience === 'office' ? context.actorId : null
  const rule = normaliseRequirement(body)
  const id = newId()
  await tx.customerRequirement.create({
    data: { id, partyId: party.id, companyId: body.companyId ?? null, kind: rule.kind, words: rule.words, appliesAt: rule.appliesAt, styleIds: rule.styleIds, fileId: body.fileId ?? null, supersedesId, createdById: actorId, createdAt: now, updatedAt: now },
    select: { id: true },
  })
  tools.audit({ action: 'parties.addRequirement', recordType: 'CustomerRequirement', recordId: id, companyId: body.companyId ?? null, after: { partyId: party.id, companyId: body.companyId ?? null, ...rule, fileId: body.fileId ?? null, supersedesId } })
  return id
}

/** POST /parties/:partyId/requirements (parties.manage): a new requirement in force. */
export async function addRequirement(caller: CommandCaller, partyId: string, body: RequirementBody, idempotencyKey?: string): Promise<{ requirements: PartyRequirementsView; requirementId: string }> {
  const context = officeOf(caller)
  const party = await readParty(caller, partyId)
  if (!isCustomer(party.roles as PartyRole[])) throw new InvalidStateError(`${party.code} is not a customer: requirements are a customer's.`)
  if (party.status === 'ARCHIVED') throw new InvalidStateError(`${party.code} is archived: reactivate it first.`)
  assertMayKeep(context, party, body.companyId ?? null)
  await checkBody(caller, context, party, body)
  const { result } = await command(caller, { name: 'parties.addRequirement', idempotencyKey, input: { partyId, ...body } }, async (tools) => {
    await lockParty(tools.tx, partyId)
    const id = await insertRequirement(tools, party, body, null)
    tools.emit({ type: 'party.requirement_changed', subject: partyId, companyId: body.companyId ?? null, payload: { partyId, code: party.code, requirementId: id, change: 'ADDED' } })
    return { id }
  })
  return { requirementId: result.id, ...(await getRequirements(caller, partyId)) }
}

async function readRequirement(caller: CommandCaller, context: OfficeContext, partyId: string, requirementId: string): Promise<RequirementRow> {
  const row = isUuid(requirementId) ? await caller.withClient((client) => client.customerRequirement.findUnique({ where: { id: requirementId }, select: REQUIREMENT_COLUMNS })) : null
  if (!row || row.partyId !== partyId || (row.companyId !== null && !can(actorOf(context), PARTIES_VIEW, { companyId: row.companyId, partyId }))) throw new NotFoundError('Requirement not found.')
  if (!row.active) throw new InvalidStateError('This requirement was ended already: it stays as history.')
  return row
}

/** Ends a requirement in the command (its version guarded by command()'s record). */
async function endInCommand(tools: CommandTools, row: RequirementRow, reason: string | null): Promise<void> {
  const { tx, now, context } = tools
  await tx.customerRequirement.update({ where: { id: row.id }, data: { active: false, endedAt: now, endedById: context.audience === 'office' ? context.actorId : null, endReason: reason, updatedAt: now }, select: { id: true } })
  tools.audit({ action: 'parties.endRequirement', recordType: 'CustomerRequirement', recordId: row.id, companyId: row.companyId, before: { active: true }, after: { active: false, endReason: reason } })
}

/**
 * POST /parties/:partyId/requirements/:requirementId/replace (parties.manage): the change of a requirement — the old one
 * ended and the new one that supersedes it written, in ONE command (`version`: the old one's).
 */
export async function replaceRequirement(caller: CommandCaller, partyId: string, requirementId: string, body: RequirementBody & { readonly version: number; readonly reason?: string | null | undefined }, idempotencyKey?: string): Promise<{ requirements: PartyRequirementsView; requirementId: string }> {
  const context = officeOf(caller)
  const party = await readParty(caller, partyId)
  if (party.status === 'ARCHIVED') throw new InvalidStateError(`${party.code} is archived: reactivate it first.`)
  const old = await readRequirement(caller, context, partyId, requirementId)
  assertMayKeep(context, party, old.companyId)
  assertMayKeep(context, party, body.companyId ?? null)
  const reasonProblem = endReasonProblem(body.reason)
  if (reasonProblem) throw new ValidationError(reasonProblem, [{ path: 'body/reason', message: reasonProblem }])
  await checkBody(caller, context, party, body)
  const { version, reason, ...rule } = body
  const { result } = await command(caller, { name: 'parties.replaceRequirement', idempotencyKey, input: { partyId, requirementId, ...body }, record: { type: 'CustomerRequirement', id: requirementId, expectedVersion: version } }, async (tools) => {
    await lockParty(tools.tx, partyId)
    await endInCommand(tools, old, (reason ?? '').trim() || 'Replaced by a new requirement.')
    const id = await insertRequirement(tools, party, rule, old.id)
    tools.emit({ type: 'party.requirement_changed', subject: partyId, companyId: rule.companyId ?? null, payload: { partyId, code: party.code, requirementId: id, change: 'REPLACED' } })
    return { id }
  })
  return { requirementId: result.id, ...(await getRequirements(caller, partyId)) }
}

/** POST /parties/:partyId/requirements/:requirementId/end (parties.manage): ended with its reason; the row stays as history. */
export async function endRequirement(caller: CommandCaller, partyId: string, requirementId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string): Promise<{ requirements: PartyRequirementsView }> {
  const context = officeOf(caller)
  const party = await readParty(caller, partyId)
  const old = await readRequirement(caller, context, partyId, requirementId)
  assertMayKeep(context, party, old.companyId)
  const reason = body.reason.trim()
  const problem = reason === '' ? 'Say why the requirement ends.' : endReasonProblem(reason)
  if (problem) throw new ValidationError(problem, [{ path: 'body/reason', message: problem }])
  await command(caller, { name: 'parties.endRequirement', idempotencyKey, input: { partyId, requirementId, ...body }, record: { type: 'CustomerRequirement', id: requirementId, expectedVersion: body.version } }, async (tools) => {
    await lockParty(tools.tx, partyId)
    await endInCommand(tools, old, reason)
    tools.emit({ type: 'party.requirement_changed', subject: partyId, companyId: old.companyId, payload: { partyId, code: party.code, requirementId, change: 'ENDED' } })
    return { id: requirementId }
  })
  return getRequirements(caller, partyId)
}

// ---- where they apply ---------------------------------------------------------------------------------------------------

interface RecordPlace {
  readonly partyId: string
  readonly companyId: string
  readonly siteId: string | null
  readonly number: string
  readonly styleIds: string[]
  readonly permission: Permission
}

const stylesOfOrderLines = async (db: Reader, lineIds: readonly string[]): Promise<string[]> =>
  lineIds.length === 0 ? [] : [...new Set((await db.salesOrderLine.findMany({ where: { id: { in: [...lineIds] } }, select: { styleId: true } })).map((line) => line.styleId))]

/** A record's customer, company, site, number and styles, and the permission that reads it; null: no such record. */
async function placeOf(db: Reader, recordType: RequirementRecordType, recordId: string): Promise<RecordPlace | null> {
  if (recordType === 'Quote') {
    const quote = await db.quote.findUnique({ where: { id: recordId }, select: { partyId: true, companyId: true, number: true, currentRevision: true } })
    if (!quote) return null
    const version = await db.quoteVersion.findFirst({ where: { quoteId: recordId, revision: quote.currentRevision }, select: { id: true } })
    const lines = version ? await db.quoteLine.findMany({ where: { versionId: version.id }, select: { styleId: true } }) : []
    return { partyId: quote.partyId, companyId: quote.companyId, siteId: null, number: quote.number, styleIds: [...new Set(lines.map((line) => line.styleId))], permission: QUOTES_VIEW }
  }
  if (recordType === 'SalesOrder') {
    const order = await db.salesOrder.findUnique({ where: { id: recordId }, select: { partyId: true, companyId: true, number: true } })
    if (!order) return null
    const lines = await db.salesOrderLine.findMany({ where: { orderId: recordId }, select: { styleId: true } })
    return { partyId: order.partyId, companyId: order.companyId, siteId: null, number: order.number, styleIds: [...new Set(lines.map((line) => line.styleId))], permission: ORDERS_VIEW }
  }
  if (recordType === 'Shipment') {
    const shipment = await db.shipment.findUnique({ where: { id: recordId }, select: { partyId: true, companyId: true, siteId: true, number: true, salesOrderId: true } })
    if (!shipment) return null
    const lines = await db.shipmentLine.findMany({ where: { shipmentId: recordId }, select: { salesOrderLineId: true } })
    // A shipment without lines yet shows its order's styles (what will be packed).
    const styleIds = lines.length > 0 ? await stylesOfOrderLines(db, lines.map((line) => line.salesOrderLineId)) : [...new Set((await db.salesOrderLine.findMany({ where: { orderId: shipment.salesOrderId }, select: { styleId: true } })).map((line) => line.styleId))]
    return { partyId: shipment.partyId, companyId: shipment.companyId, siteId: shipment.siteId, number: shipment.number, styleIds, permission: SHIPPING_VIEW }
  }
  const invoice = await db.invoice.findUnique({ where: { id: recordId }, select: { buyerPartyId: true, companyId: true, number: true } })
  if (!invoice) return null
  const lines = await db.invoiceLine.findMany({ where: { invoiceId: recordId }, select: { salesOrderLineId: true } })
  return { partyId: invoice.buyerPartyId, companyId: invoice.companyId, siteId: null, number: invoice.number ?? 'draft', styleIds: await stylesOfOrderLines(db, lines.flatMap((line) => (line.salesOrderLineId ? [line.salesOrderLineId] : []))), permission: INVOICES_VIEW }
}

/** The requirements in force for a customer on a record of `companyId` at `stages`, for `styleIds`. */
export async function requirementsApplying(db: Reader, partyId: string, place: { readonly companyId: string; readonly stages: readonly RequirementStage[]; readonly styleIds: readonly string[] }): Promise<RequirementRow[]> {
  const rows = await db.customerRequirement.findMany({ where: { partyId, active: true }, select: REQUIREMENT_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  return rows.filter((row) => appliesTo({ active: row.active, companyId: row.companyId, appliesAt: row.appliesAt as RequirementStage[], styleIds: row.styleIds }, place))
}

/**
 * GET /parties/requirements/for/:recordType/:recordId (any office session; the record's own view permission over its
 * place inside): the customer's requirements in force there, grouped by where they are shown on that record.
 */
export async function requirementsForRecord(caller: CommandCaller, recordType: RequirementRecordType, recordId: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  return caller.withClient(async (client) => {
    const place = isUuid(recordId) ? await placeOf(client, recordType, recordId) : null
    if (!place || !can(actor, place.permission, { companyId: place.companyId, partyId: place.partyId, ...(place.siteId ? { siteId: place.siteId } : {}) })) throw new NotFoundError(`${recordType} not found.`)
    const stages = RECORD_STAGES[recordType]
    const rows = await requirementsApplying(client, place.partyId, { companyId: place.companyId, stages, styleIds: place.styleIds })
    const labels = await labelsOf(client, rows)
    const party = await client.party.findUnique({ where: { id: place.partyId }, select: { code: true, legalName: true } })
    const views = rows.map((row) => requirementViewOf(row, labels))
    return {
      record: { type: recordType, id: recordId, number: place.number, companyId: place.companyId },
      party: { id: place.partyId, code: party?.code ?? '', legalName: party?.legalName ?? '' },
      stages: stages.map((stage) => ({ stage, requirements: views.filter((view) => view.appliesAt.includes(stage)) })),
      count: views.length,
    }
  })
}

/** Refuses a requirement route that names a record type that shows none (the contract's enum holds the list). */
export function assertRecordType(type: string): asserts type is RequirementRecordType {
  if (!(type in RECORD_STAGES)) throw new DomainError('not_found', 'No requirements are shown on that kind of record.')
}
