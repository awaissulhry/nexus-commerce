import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { markMoney } from '@nexus/factory-domain/money/marked'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import { isPurchaseParty } from '@nexus/factory-domain/purchasing/orders'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { duplicateOf, factorOf, primaryOf, sourceProblems, type SourceFields, type SourcePreference } from '@nexus/factory-domain/purchasing/sources/sources'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { decimal, ITEM_COLUMNS, officeContextOf, seesCost, unitsOf, type ItemRow, type Reader } from '../store'
import { factsOf, lockSourcesOf, mayKeep, SOURCE_COLUMNS, sourcesOfItem, sourceViews, type SourceRow, type SourceView } from './store'

/**
 * Approved sources (B-W2a-10; SCM-005; design purchasing.suppliers › Items & prices "Approved sources", Products ›
 * material "Supplier prices"): a supplier's article for a material, the unit it sells in, its price (a cost), minimum,
 * steps and lead time, PRIMARY or BACKUP. Office only.
 *
 *   read      purchasing.view over the source's company (every company's is seen by all) and supplier; prices only with
 *             the cost grain.
 *   keep      purchasing.sources.manage over the source's company and supplier (a source for every company: a grant over
 *             every company). Each write is ONE command under the material's lock (one active source per supplier and
 *             scope, one PRIMARY per scope), comparing and setting the source's version.
 *   create    the supplier is a SUPPLIER or SUBCONTRACTOR, not archived, of the source's company (or every company's);
 *             the material and colour are active and the company's (or every company's). The unit defaults to the
 *             material's purchase unit, the currency to the supplier's, the article code to the material's when the
 *             supplier is its default one, the colour code to the colour's; the first source of a scope is its PRIMARY.
 *   PRIMARY   making a source PRIMARY makes the scope's other PRIMARY a BACKUP in the same command (audited, its own
 *             event).
 *   archive   no buy suggestion takes it any more; it is kept (orders were made from it) and may be approved again
 *             (restore: refused while the supplier has another active source of the scope; back as a BACKUP when the
 *             scope has a PRIMARY by then).
 */

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

export interface SourceInput {
  readonly supplierArticleCode?: string | null | undefined
  readonly supplierColourCode?: string | null | undefined
  readonly description?: string | null | undefined
  readonly purchaseUom?: Uom | undefined
  readonly unitPrice?: string | null | undefined
  readonly currency?: string | undefined
  readonly minOrderQty?: string | null | undefined
  readonly orderMultiple?: string | null | undefined
  readonly leadTimeDays?: number | null | undefined
  readonly preference?: SourcePreference | undefined
  readonly note?: string | null | undefined
}

export interface CreateSourceInput extends SourceInput {
  readonly companyId: string | null
  readonly partyId: string
  readonly itemId: string
  readonly itemColourId?: string | null | undefined
}

const FIELD_NAMES = ['supplierArticleCode', 'supplierColourCode', 'description', 'purchaseUom', 'unitPrice', 'currency', 'minOrderQty', 'orderMultiple', 'leadTimeDays', 'preference', 'note'] as const

const reaches = (actor: Actor, row: Pick<SourceRow, 'companyId' | 'partyId'>): boolean => can(actor, PURCHASING_VIEW, { companyId: row.companyId, partyId: row.partyId })

/** The source the caller may see (404 otherwise), and keep (403 otherwise) when asked. */
function assertReach(context: OfficeContext, row: SourceRow | null, keep: boolean): asserts row is SourceRow {
  const actor = actorOf(context)
  if (!row || !reaches(actor, row)) throw new NotFoundError('Approved source not found.')
  if (keep && !mayKeep(actor, row)) throw new ForbiddenError(row.companyId === null ? 'A source for every company is kept only by a role over every company.' : undefined)
}

const readRow = (db: Reader, id: string): Promise<SourceRow | null> =>
  isUuid(id) ? db.supplierItem.findUnique({ where: { id }, select: SOURCE_COLUMNS }) : Promise.resolve(null)

/** What the audit keeps of a source (its price marked as a cost). */
const auditOf = (row: Pick<SourceRow, 'purchaseUom' | 'unitPrice' | 'currency' | 'minOrderQty' | 'orderMultiple' | 'leadTimeDays' | 'preference' | 'status' | 'supplierArticleCode' | 'supplierColourCode' | 'description' | 'note'>) => ({
  purchaseUom: row.purchaseUom,
  unitPrice: markMoney('cost', decimal(row.unitPrice)),
  currency: row.currency,
  minOrderQty: decimal(row.minOrderQty),
  orderMultiple: decimal(row.orderMultiple),
  leadTimeDays: row.leadTimeDays,
  preference: row.preference,
  status: row.status,
  supplierArticleCode: row.supplierArticleCode,
  supplierColourCode: row.supplierColourCode,
  description: row.description,
  note: row.note,
})

async function answer(tools: CommandTools, id: string, demoted: SourceRow | null): Promise<{ item: SourceView; demoted: { id: string; partyId: string; supplierName: string } | null }> {
  const context = tools.context as OfficeContext
  const row = (await readRow(tools.tx, id))!
  const [item] = await sourceViews(tools.tx, [row], seesCost(context))
  const party = demoted ? await tools.tx.party.findUnique({ where: { id: demoted.partyId }, select: { legalName: true, tradeName: true } }) : null
  return { item: item!, demoted: demoted ? { id: demoted.id, partyId: demoted.partyId, supplierName: party?.tradeName ?? party?.legalName ?? '' } : null }
}

/** The scope's other PRIMARY becomes a BACKUP (inside the command, under the material's lock). */
async function demote(tools: CommandTools, other: SourceRow, by: string): Promise<SourceRow> {
  const { count } = await tools.tx.supplierItem.updateMany({ where: { id: other.id, version: other.version }, data: { preference: 'BACKUP', version: other.version + 1 } })
  if (count !== 1) throw new StaleVersionError('SupplierItem', other.id, other.version + 1, other.version)
  tools.audit({ action: 'purchasing.sources.demote', recordType: 'SupplierItem', recordId: other.id, companyId: other.companyId, before: { preference: 'PRIMARY' }, after: { preference: 'BACKUP', primaryId: by } })
  tools.emit({ type: 'supplier_item.updated', subject: other.id, companyId: other.companyId, payload: { supplierItemId: other.id, partyId: other.partyId, itemId: other.itemId, fields: ['preference'], demotedId: null } })
  return other
}

function fieldsProblem(fields: SourceFields, item: ItemRow): void {
  const problems = sourceProblems(fields, { units: unitsOf(item) })
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
}

// ---- read ---------------------------------------------------------------------------------------------------------------

export interface ListSourcesQuery {
  readonly partyId?: string | undefined
  readonly itemId?: string | undefined
  readonly itemColourId?: string | undefined
  readonly companyId?: string | undefined
  readonly status: 'ACTIVE' | 'ARCHIVED' | 'ALL'
  readonly preference?: SourcePreference | undefined
  readonly q?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** purchasing.view: the sources the caller reaches, by material code then supplier (a cursor of ids). */
export async function listSources(caller: CommandCaller, query: ListSourcesQuery): Promise<{ items: SourceView[]; nextCursor: string | null }> {
  const context = officeContextOf(caller)
  const scope = scopeWhere(actorOf(context), PURCHASING_VIEW, { company: { field: 'companyId', nullable: true }, party: 'partyId' }) as Prisma.SupplierItemWhereInput
  const filters: Prisma.SupplierItemWhereInput[] = [
    scope,
    query.partyId ? { partyId: query.partyId } : {},
    query.itemId ? { itemId: query.itemId } : {},
    query.itemColourId ? { OR: [{ itemColourId: query.itemColourId }, { itemColourId: null }] } : {},
    query.companyId ? { OR: [{ companyId: query.companyId }, { companyId: null }] } : {},
    query.status === 'ALL' ? {} : { status: query.status },
    query.preference ? { preference: query.preference } : {},
    query.q
      ? { OR: [{ supplierArticleCode: { contains: query.q, mode: 'insensitive' } }, { item: { code: { contains: query.q, mode: 'insensitive' } } }, { item: { name: { contains: query.q, mode: 'insensitive' } } }] }
      : {},
  ]
  return caller.withClient(async (client) => {
    const rows = await client.supplierItem.findMany({
      where: { AND: filters },
      select: SOURCE_COLUMNS,
      orderBy: { id: 'asc' },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    })
    const page = rows.slice(0, query.limit)
    return { items: await sourceViews(client, page, seesCost(context)), nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null }
  })
}

/** purchasing.view: one source. */
export async function getSource(caller: CommandCaller, id: string): Promise<{ item: SourceView }> {
  const context = officeContextOf(caller)
  return caller.withClient(async (client) => {
    const row = await readRow(client, id)
    assertReach(context, row, false)
    const [item] = await sourceViews(client, [row], seesCost(context))
    return { item: item! }
  })
}

// ---- create -------------------------------------------------------------------------------------------------------------

/** purchasing.sources.manage over the company (every company for a source of every company) and the supplier. */
export async function createSource(caller: CommandCaller, body: CreateSourceInput, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const scope = { companyId: body.companyId, partyId: body.partyId }
  if (!can(actor, PURCHASING_VIEW, scope)) throw new NotFoundError('Supplier not found.')
  if (!mayKeep(actor, scope)) throw new ForbiddenError(body.companyId === null ? 'A source for every company is kept only by a role over every company.' : undefined)
  const { result } = await command(caller, { name: 'purchasing.sources.create', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    const party = isUuid(body.partyId) ? await tx.party.findUnique({ where: { id: body.partyId }, select: { id: true, companyId: true, legalName: true, tradeName: true, roles: true, status: true, currency: true } }) : null
    if (!party || (party.companyId !== null && body.companyId !== null && party.companyId !== body.companyId)) throw new NotFoundError('Supplier not found.')
    const name = party.tradeName ?? party.legalName
    if (party.companyId !== null && body.companyId === null) {
      throw new ValidationError(`${name} supplies one company only: its source holds for that company.`, [{ path: 'body/companyId', message: "Give the supplier's company." }])
    }
    if (!isPurchaseParty(party.roles)) throw new ValidationError(`${name} is not a supplier.`, [{ path: 'body/partyId', message: 'Give the party the supplier role first.' }])
    if (party.status === 'ARCHIVED') throw new InvalidStateError(`${name} is archived: it is no approved source any more.`)
    const item = isUuid(body.itemId) ? await tx.item.findUnique({ where: { id: body.itemId }, select: ITEM_COLUMNS }) : null
    if (!item || (item.companyId !== null && body.companyId !== null && item.companyId !== body.companyId)) throw new NotFoundError('Material not found.')
    if (item.companyId !== null && body.companyId === null) {
      throw new ValidationError(`${item.code} is one company's material: its source holds for that company.`, [{ path: 'body/companyId', message: "Give the material's company." }])
    }
    if (item.status !== 'ACTIVE') throw new InvalidStateError(`${item.code} is archived: it is not bought any more.`)
    const colour = body.itemColourId
      ? isUuid(body.itemColourId)
        ? await tx.itemColour.findUnique({ where: { id: body.itemColourId }, select: { id: true, itemId: true, status: true, supplierColourCode: true } })
        : null
      : null
    if (body.itemColourId && (!colour || colour.itemId !== item.id)) throw new ValidationError('Not a colour of this material.', [{ path: 'body/itemColourId', message: 'Choose one of the material’s colours.' }])
    if (colour && colour.status !== 'ACTIVE') throw new ValidationError('The colour is archived.', [{ path: 'body/itemColourId', message: 'Choose an active colour.' }])

    await lockSourcesOf(tx, context.tenantId, item.id)
    const others = (await sourcesOfItem(tx, item.id)).map(factsOf)
    const candidate = { companyId: body.companyId, partyId: party.id, itemId: item.id, itemColourId: colour?.id ?? null }
    if (duplicateOf(candidate, others)) throw new ConflictError(`${name} already has an approved source of ${item.code} for this company and colour: change that one.`)
    const primary = primaryOf(candidate, others)
    const preference: SourcePreference = body.preference ?? (primary ? 'BACKUP' : 'PRIMARY')
    const fields: SourceFields = {
      purchaseUom: body.purchaseUom ?? (item.purchaseUom as Uom),
      unitPrice: body.unitPrice ?? null,
      currency: body.currency ?? party.currency,
      minOrderQty: body.minOrderQty ?? null,
      orderMultiple: body.orderMultiple ?? null,
      leadTimeDays: body.leadTimeDays ?? null,
      supplierArticleCode: body.supplierArticleCode === undefined ? (item.defaultSupplierId === party.id ? item.supplierArticleCode : null) : blankToNull(body.supplierArticleCode),
      supplierColourCode: body.supplierColourCode === undefined ? (colour?.supplierColourCode ?? null) : blankToNull(body.supplierColourCode),
      description: blankToNull(body.description),
      note: blankToNull(body.note),
    }
    fieldsProblem(fields, item)
    const id = newId()
    const demoted = preference === 'PRIMARY' && primary ? await demote(tools, (await readRow(tx, primary.id))!, id) : null
    await tx.supplierItem.create({
      data: { id, ...candidate, ...fields, purchaseFactor: factorOf(fields.purchaseUom, unitsOf(item))!, preference, createdById: context.actorId },
      select: { id: true },
    })
    const created = (await readRow(tx, id))!
    tools.audit({ action: 'purchasing.sources.create', recordType: 'SupplierItem', recordId: id, companyId: body.companyId, after: { partyId: party.id, itemId: item.id, itemColourId: candidate.itemColourId, ...auditOf(created), demotedId: demoted?.id ?? null } })
    tools.emit({ type: 'supplier_item.created', subject: id, companyId: body.companyId, payload: { supplierItemId: id, partyId: party.id, itemId: item.id, preference, demotedId: demoted?.id ?? null } })
    return answer(tools, id, demoted)
  })
  return result
}

// ---- change -------------------------------------------------------------------------------------------------------------

/**
 * Inside the command, under the material's lock: the row as it is now, at the version the caller read (409 otherwise).
 */
async function lockedRow(tools: CommandTools, context: OfficeContext, id: string, version: number): Promise<{ row: SourceRow; item: ItemRow; others: SourceRow[] }> {
  const first = await readRow(tools.tx, id)
  assertReach(context, first, true)
  await lockSourcesOf(tools.tx, context.tenantId, first.itemId)
  const all = await sourcesOfItem(tools.tx, first.itemId)
  const row = all.find((entry) => entry.id === id)!
  if (row.version !== version) throw new StaleVersionError('SupplierItem', id, row.version, version)
  const item = (await tools.tx.item.findUnique({ where: { id: row.itemId }, select: ITEM_COLUMNS }))!
  return { row, item, others: all.filter((entry) => entry.id !== id) }
}

/** Compare and set the row's version with the change. */
async function write(tools: CommandTools, row: SourceRow, data: Prisma.SupplierItemUncheckedUpdateManyInput): Promise<void> {
  const { count } = await tools.tx.supplierItem.updateMany({ where: { id: row.id, version: row.version }, data: { ...data, version: row.version + 1 } })
  if (count !== 1) throw new StaleVersionError('SupplierItem', row.id, row.version + 1, row.version)
}

/** purchasing.sources.manage: the source's codes, unit, price, terms, PRIMARY or BACKUP and note (an active source). */
export async function updateSource(caller: CommandCaller, id: string, body: SourceInput & { readonly version: number }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  assertReach(context, await caller.withClient((client) => readRow(client, id)), true)
  const { version, ...input } = body
  const names = FIELD_NAMES.filter((name) => input[name] !== undefined)
  if (names.length === 0) throw new ValidationError('Nothing to change.', [{ path: 'body', message: 'Send at least one field.' }])
  const { result } = await command(caller, { name: 'purchasing.sources.update', idempotencyKey, input: { id, ...body } }, async (tools) => {
    const { row, item, others } = await lockedRow(tools, context, id, version)
    if (row.status !== 'ACTIVE') throw new InvalidStateError('The source is archived: approve it again first.')
    const current = factsOf(row)
    const fields: SourceFields = {
      purchaseUom: input.purchaseUom ?? current.purchaseUom,
      unitPrice: input.unitPrice === undefined ? current.unitPrice : input.unitPrice,
      currency: input.currency ?? current.currency,
      minOrderQty: input.minOrderQty === undefined ? current.minOrderQty : input.minOrderQty,
      orderMultiple: input.orderMultiple === undefined ? current.orderMultiple : input.orderMultiple,
      leadTimeDays: input.leadTimeDays === undefined ? current.leadTimeDays : input.leadTimeDays,
      supplierArticleCode: input.supplierArticleCode === undefined ? current.supplierArticleCode : blankToNull(input.supplierArticleCode),
      supplierColourCode: input.supplierColourCode === undefined ? current.supplierColourCode : blankToNull(input.supplierColourCode),
      description: input.description === undefined ? row.description : blankToNull(input.description),
      note: input.note === undefined ? row.note : blankToNull(input.note),
    }
    fieldsProblem(fields, item)
    const preference = input.preference ?? current.preference
    const primary = preference === 'PRIMARY' && current.preference !== 'PRIMARY' ? primaryOf(row, others.map(factsOf)) : null
    const demoted = primary ? await demote(tools, others.find((other) => other.id === primary.id)!, row.id) : null
    await write(tools, row, { ...fields, purchaseFactor: factorOf(fields.purchaseUom, unitsOf(item))!, preference })
    const after = (await readRow(tools.tx, id))!
    tools.audit({ action: 'purchasing.sources.update', recordType: 'SupplierItem', recordId: id, companyId: row.companyId, before: auditOf(row), after: { ...auditOf(after), fields: names, demotedId: demoted?.id ?? null } })
    tools.emit({ type: 'supplier_item.updated', subject: id, companyId: row.companyId, payload: { supplierItemId: id, partyId: row.partyId, itemId: row.itemId, fields: [...names], demotedId: demoted?.id ?? null } })
    return answer(tools, id, demoted)
  })
  return result
}

/** purchasing.sources.manage: no buy takes the source any more; it is kept. */
export async function archiveSource(caller: CommandCaller, id: string, body: { readonly version: number; readonly reason?: string | undefined }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  assertReach(context, await caller.withClient((client) => readRow(client, id)), true)
  const { result } = await command(caller, { name: 'purchasing.sources.archive', idempotencyKey, input: { id, ...body } }, async (tools) => {
    const { row } = await lockedRow(tools, context, id, body.version)
    if (row.status === 'ARCHIVED') throw new InvalidStateError('The source is archived already.')
    await write(tools, row, { status: 'ARCHIVED' })
    const reason = blankToNull(body.reason)
    tools.audit({ action: 'purchasing.sources.archive', recordType: 'SupplierItem', recordId: id, companyId: row.companyId, ...(reason ? { reason } : {}), before: { status: 'ACTIVE', preference: row.preference }, after: { status: 'ARCHIVED' } })
    tools.emit({ type: 'supplier_item.archived', subject: id, companyId: row.companyId, payload: { supplierItemId: id, partyId: row.partyId, itemId: row.itemId } })
    return answer(tools, id, null)
  })
  return result
}

/** purchasing.sources.manage: an archived source approved again (a BACKUP when its scope has a PRIMARY by now). */
export async function restoreSource(caller: CommandCaller, id: string, body: { readonly version: number }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  assertReach(context, await caller.withClient((client) => readRow(client, id)), true)
  const { result } = await command(caller, { name: 'purchasing.sources.restore', idempotencyKey, input: { id, ...body } }, async (tools) => {
    const { row, item, others } = await lockedRow(tools, context, id, body.version)
    if (row.status === 'ACTIVE') throw new InvalidStateError('The source is approved already.')
    const facts = others.map(factsOf)
    if (duplicateOf(row, facts)) throw new ConflictError(`The supplier has another approved source of ${item.code} for this company and colour: archive that one first.`)
    const party = await tools.tx.party.findUnique({ where: { id: row.partyId }, select: { status: true, legalName: true, tradeName: true } })
    if (party?.status === 'ARCHIVED') throw new InvalidStateError(`${party.tradeName ?? party.legalName} is archived: it is no approved source any more.`)
    if (item.status !== 'ACTIVE') throw new InvalidStateError(`${item.code} is archived: it is not bought any more.`)
    const preference: SourcePreference = row.preference === 'PRIMARY' && primaryOf(row, facts) ? 'BACKUP' : (row.preference as SourcePreference)
    await write(tools, row, { status: 'ACTIVE', preference })
    const fields = preference === row.preference ? ['status'] : ['status', 'preference']
    tools.audit({ action: 'purchasing.sources.restore', recordType: 'SupplierItem', recordId: id, companyId: row.companyId, before: { status: 'ARCHIVED', preference: row.preference }, after: { status: 'ACTIVE', preference } })
    tools.emit({ type: 'supplier_item.updated', subject: id, companyId: row.companyId, payload: { supplierItemId: id, partyId: row.partyId, itemId: row.itemId, fields, demotedId: null } })
    return answer(tools, id, null)
  })
  return result
}
