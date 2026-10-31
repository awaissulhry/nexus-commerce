import type { Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PARTIES_MANAGE } from '@nexus/factory-domain/parties/permissions'
import { listCodeOf, listFieldProblems, validityProblems, type PriceListKind, type PriceListState } from '@nexus/factory-domain/sales/pricelists/pricelists'
import { PRICE_LISTS_MANAGE, PRICE_LISTS_VIEW } from '@nexus/factory-domain/sales/pricelists/permissions'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { mayWrite as mayWriteParty } from '../../parties/store'
import { officeContextOf, type Reader } from '../quotes/store'
import { assignmentStartsOf, givePriceListInCommand } from './assignments'
import { assertMayChangeList, dayValue, LIST_COLUMNS, LIST_SCOPE, listRowsOf, lockList, readListFor, versionsOf, versionViewOf, type ListRow } from './store'

/**
 * Price lists (B-W2a-19; SAL-165; design sales.pricelists: the list with its tiles, "New price list", the record's
 * Customers tab): the list screen (pricelists.view), one list with its versions, the lists that fall back to it and its
 * customers, a new list with its first DRAFT version (its planned days), an edit (name, code, the list it falls back to,
 * note), archive and reactivate, and giving the list to customers or taking it from them (pricelists.manage, and
 * parties.manage on each customer). Each is ONE command that locks the list's row first. Kind, currency and company are
 * fixed once made (the database guard holds currency and company too). One ACTIVE BASE list per company (or every
 * company) and currency: it prices a customer without a list of its own.
 */

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const invalid = (issues: readonly Issue[]): ValidationError => new ValidationError(issues.length === 1 ? issues[0]!.message : 'The price list is not valid.', issues.map((issue) => ({ path: issue.path.startsWith('body') ? issue.path : `body/${issue.path}`, message: issue.message })))
const codeTaken = (code: string) => new ConflictError(`The price list code ${code} is taken.`)
const isUnique = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'

/** The record as the command left it. */
export async function listDetailOf(db: Reader, list: ListRow, today: BusinessDate) {
  const [row] = await listRowsOf(db, [list], today)
  const versions = await versionsOf(db, [list.id])
  const counts = await db.priceListEntry.groupBy({ by: ['versionId'], where: { versionId: { in: versions.map((version) => version.id) } }, _count: { _all: true } })
  const entriesOf = new Map(counts.map((entry) => [entry.versionId, entry._count._all]))
  const parties = await db.party.findMany({ where: { priceListId: list.id }, select: { id: true, code: true, legalName: true, status: true, companyId: true, version: true, priceListId: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: 500 })
  // B-W2b-16: since when each customer has the list (its open assignment row; before W2b: the audit's day).
  const starts = await assignmentStartsOf(db, parties)
  const customers = parties.map(({ priceListId: _list, ...party }) => ({ ...party, from: starts.get(party.id)?.from ?? null, fromSource: starts.get(party.id)?.source ?? null }))
  const fallbackOf = await db.priceList.findMany({ where: { baseListId: list.id }, select: { id: true, code: true, name: true, kind: true, status: true }, orderBy: { code: 'asc' } })
  return {
    ...row!,
    note: list.note,
    createdAt: toUtcIso(list.createdAt),
    createdById: list.createdById,
    versions: [...versions].reverse().map((version) => versionViewOf(version, entriesOf.get(version.id) ?? 0)),
    customers,
    fallbackOf: fallbackOf.map((entry) => ({ ...entry, kind: entry.kind as PriceListKind })),
  }
}
export type ListDetail = Awaited<ReturnType<typeof listDetailOf>>

const detailInCommand = async (tools: CommandTools, listId: string): Promise<{ list: ListDetail }> => ({ list: await listDetailOf(tools.tx, (await tools.tx.priceList.findUniqueOrThrow({ where: { id: listId }, select: LIST_COLUMNS })), businessDate(tools.now)) })

// ---- reads -------------------------------------------------------------------------------------------------------------

export interface ListListsQuery {
  readonly companyId?: string | undefined
  readonly kind?: PriceListKind | undefined
  readonly state?: PriceListState | undefined
  readonly q?: string | undefined
}

/**
 * GET /sales/price-lists: the lists the caller may see (archived ones only with state=ARCHIVED), by code, each with its
 * state today, the version shown, its customers and styles priced; and the tiles (in force, starting and ending within
 * 30 days) over the lists before the state filter.
 */
export async function listLists(caller: CommandCaller, query: ListListsQuery) {
  const context = officeContextOf(caller)
  const search = query.q?.trim()
  const where: Prisma.PriceListWhereInput = {
    AND: [
      scopeWhere(actorOf(context), PRICE_LISTS_VIEW, LIST_SCOPE) as Prisma.PriceListWhereInput,
      { status: query.state === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE' },
      query.companyId ? { OR: [{ companyId: query.companyId }, { companyId: null }] } : {},
      query.kind ? { kind: query.kind } : {},
      search ? { OR: [{ code: { contains: search, mode: 'insensitive' } }, { name: { contains: search, mode: 'insensitive' } }] } : {},
    ],
  }
  const today = businessDate(serverClock.now())
  return caller.withClient(async (client) => {
    const lists = await client.priceList.findMany({ where, select: LIST_COLUMNS, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: 500 })
    const rows = await listRowsOf(client, lists, today)
    return {
      asOf: today,
      lists: query.state && query.state !== 'ARCHIVED' ? rows.filter((row) => row.state === query.state) : rows,
      tiles: { inForce: rows.filter((row) => row.state === 'IN_FORCE').length, startingIn30Days: rows.filter((row) => row.startsSoon).length, endingIn30Days: rows.filter((row) => row.endsSoon).length },
    }
  })
}

/** GET /sales/price-lists/:listId: the record. */
export async function getList(caller: CommandCaller, listId: string): Promise<{ list: ListDetail }> {
  const list = await readListFor(caller, listId)
  return caller.withClient(async (client) => ({ list: await listDetailOf(client, list, businessDate(serverClock.now())) }))
}

// ---- writes -------------------------------------------------------------------------------------------------------------

/** The list a list may fall back to: visible, active, of its currency, of every company or its own company. */
async function checkBase(tx: CommandTx, list: { id: string | null; companyId: string | null; currency: string }, baseListId: string): Promise<ListRow> {
  const base = isUuid(baseListId) ? await tx.priceList.findUnique({ where: { id: baseListId }, select: LIST_COLUMNS }) : null
  const at = 'body/baseListId'
  if (!base) throw new ValidationError('No such price list to fall back to.', [{ path: at, message: 'Not a price list you may see.' }])
  if (base.id === list.id) throw new ValidationError('A price list never falls back to itself.', [{ path: at, message: 'Choose another list.' }])
  if (base.status !== 'ACTIVE') throw new ValidationError(`${base.code} is archived.`, [{ path: at, message: 'Fall back to an active list.' }])
  if (base.currency !== list.currency) throw new ValidationError(`${base.code} is in ${base.currency}, this list in ${list.currency}.`, [{ path: at, message: 'Fall back to a list of the same currency.' }])
  if (base.companyId !== null && base.companyId !== list.companyId) throw new ValidationError(`${base.code} belongs to another company.`, [{ path: at, message: "Fall back to a list of this list's company, or of every company." }])
  if (list.id !== null) {
    // No circle: the base (through its own fallbacks) never reaches this list.
    let step: string | null = base.baseListId
    for (let depth = 0; step !== null && depth < 64; depth += 1) {
      if (step === list.id) throw new ValidationError(`${base.code} falls back to this list already: no circle.`, [{ path: at, message: 'Choose a list that does not fall back to this one.' }])
      step = (await tx.priceList.findUnique({ where: { id: step }, select: { baseListId: true } }))?.baseListId ?? null
    }
  }
  return base
}

/** One ACTIVE BASE list per company (or every company) and currency: the lock and the check, inside the command. */
async function assertOneBase(tx: CommandTx, tenantId: string, list: { id: string; companyId: string | null; currency: string }): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.price-list-base', ${tenantId}::uuid, ${list.companyId ?? 'all'}::text, ${list.currency}::text), 0))`
  const other = await tx.priceList.findFirst({ where: { kind: 'BASE', status: 'ACTIVE', currency: list.currency, companyId: list.companyId, id: { not: list.id } }, select: { code: true } })
  if (other) throw new ConflictError(`${other.code} is the base list of ${list.companyId === null ? 'every company' : 'this company'} in ${list.currency} already: one base list each (archive it first, or make a customer, group or contract list).`)
}

export interface CreateListBody {
  readonly companyId?: string | null | undefined
  readonly code: string
  readonly name: string
  readonly kind: PriceListKind
  readonly currency?: string | undefined
  readonly baseListId?: string | null | undefined
  readonly note?: string | null | undefined
  /** The first version's planned days (design "validity"); its prices are added while it is a draft. */
  readonly validFrom?: BusinessDate | null | undefined
  readonly validTo?: BusinessDate | null | undefined
}

/** POST /sales/price-lists (design "New price list" → Create draft): the list and its first DRAFT version. */
export async function createList(caller: CommandCaller, body: CreateListBody, idempotencyKey?: string): Promise<{ list: ListDetail }> {
  const context = officeContextOf(caller)
  const companyId = body.companyId ?? null
  assertMayChangeList(context, PRICE_LISTS_MANAGE, companyId)
  const currency = body.currency ?? 'EUR'
  const issues = [...listFieldProblems({ code: body.code, name: body.name, currency, note: body.note }), ...validityProblems(body.validFrom ?? null, body.validTo ?? null)]
  if (issues.length > 0) throw invalid(issues)
  const code = listCodeOf(body.code)
  const { result } = await command(caller, { name: 'priceLists.create', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    if (companyId !== null && !(await tx.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw new ValidationError('No such company.', [{ path: 'body/companyId', message: 'No such company.' }])
    if (await tx.priceList.findFirst({ where: { code }, select: { id: true } })) throw codeTaken(code)
    const id = newId()
    const base = body.baseListId ? await checkBase(tx, { id: null, companyId, currency }, body.baseListId) : null
    if (body.kind === 'BASE') await assertOneBase(tx, context.tenantId, { id, companyId, currency })
    const stamp = { createdAt: now, updatedAt: now, createdById: context.actorId }
    await tx.priceList.create({ data: { id, companyId, code, name: body.name.trim(), kind: body.kind, currency, baseListId: base?.id ?? null, note: blankToNull(body.note), ...stamp }, select: { id: true } })
    const versionId = newId()
    await tx.priceListVersion.create({ data: { id: versionId, listId: id, revision: 1, validFrom: body.validFrom ? dayValue(body.validFrom) : null, validTo: body.validTo ? dayValue(body.validTo) : null, ...stamp }, select: { id: true } })
    tools.audit({ action: 'priceLists.create', recordType: 'PriceList', recordId: id, companyId, after: { code, name: body.name.trim(), kind: body.kind, currency, baseListId: base?.id ?? null, versionId, revision: 1, validFrom: body.validFrom ?? null, validTo: body.validTo ?? null } })
    tools.emit({ type: 'price_list.changed', subject: id, companyId, payload: { listId: id, code, change: 'CREATED', fields: [], partyIds: [] } })
    tools.emit({ type: 'price_list.version_changed', subject: id, companyId, payload: { listId: id, versionId, revision: 1, change: 'CREATED' } })
    return detailInCommand(tools, id)
  }).catch((error: unknown) => {
    if (isUnique(error)) throw codeTaken(code)
    throw error
  })
  return result
}

export interface UpdateListBody {
  readonly version: number
  readonly code?: string | undefined
  readonly name?: string | undefined
  readonly baseListId?: string | null | undefined
  readonly note?: string | null | undefined
}

/** PATCH /sales/price-lists/:listId: its code, name, the list it falls back to, its note (kind, currency, company fixed). */
export async function updateList(caller: CommandCaller, listId: string, body: UpdateListBody, idempotencyKey?: string): Promise<{ list: ListDetail }> {
  const context = officeContextOf(caller)
  const seen = await readListFor(caller, listId)
  assertMayChangeList(context, PRICE_LISTS_MANAGE, seen.companyId)
  const issues = listFieldProblems({ code: body.code, name: body.name, note: body.note })
  if (issues.length > 0) throw invalid(issues)
  if (body.code === undefined && body.name === undefined && body.baseListId === undefined && body.note === undefined) throw new ValidationError('Nothing to change.', [{ path: 'body', message: 'Send at least one field.' }])
  const { result } = await command(caller, { name: 'priceLists.update', idempotencyKey, input: { listId, ...body }, record: { type: 'PriceList', id: listId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const list = await lockList(tx, listId)
    if (list.status === 'ARCHIVED') throw new InvalidStateError(`${list.code} is archived: reactivate it before changing it.`)
    const code = body.code === undefined ? list.code : listCodeOf(body.code)
    if (code !== list.code && (await tx.priceList.findFirst({ where: { code, id: { not: listId } }, select: { id: true } }))) throw codeTaken(code)
    const baseListId = body.baseListId === undefined ? list.baseListId : body.baseListId === null ? null : (await checkBase(tx, list, body.baseListId)).id
    const next = { code, name: body.name === undefined ? list.name : body.name.trim(), baseListId, note: body.note === undefined ? list.note : blankToNull(body.note) }
    const fields = (['code', 'name', 'baseListId', 'note'] as const).filter((field) => next[field] !== list[field])
    if (fields.length > 0) await tx.priceList.update({ where: { id: listId }, data: { ...next, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'priceLists.update', recordType: 'PriceList', recordId: listId, companyId: list.companyId, before: { code: list.code, name: list.name, baseListId: list.baseListId, note: list.note }, after: next })
    if (fields.length > 0) tools.emit({ type: 'price_list.changed', subject: listId, companyId: list.companyId, payload: { listId, code, change: 'UPDATED', fields: [...fields], partyIds: [] } })
    return detailInCommand(tools, listId)
  }).catch((error: unknown) => {
    if (isUnique(error)) throw new ConflictError('The price list code is taken.')
    throw error
  })
  return result
}

/**
 * POST /sales/price-lists/:listId/archive | reactivate. Archiving is refused while a customer is priced from the list or
 * an active list falls back to it (in words, with how many); a quote that kept one of its versions keeps it.
 */
export async function moveList(caller: CommandCaller, listId: string, move: 'archive' | 'reactivate', body: { version: number }, idempotencyKey?: string): Promise<{ list: ListDetail }> {
  const context = officeContextOf(caller)
  const seen = await readListFor(caller, listId)
  assertMayChangeList(context, PRICE_LISTS_MANAGE, seen.companyId)
  const to = move === 'archive' ? 'ARCHIVED' : 'ACTIVE'
  const { result } = await command(caller, { name: `priceLists.${move}`, idempotencyKey, input: { listId, ...body }, record: { type: 'PriceList', id: listId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const list = await lockList(tx, listId)
    if (list.status === to) throw new InvalidStateError(move === 'archive' ? `${list.code} is archived already.` : `${list.code} is active already.`)
    if (move === 'archive') {
      const customers = await tx.party.count({ where: { priceListId: listId, status: { not: 'ARCHIVED' } } })
      if (customers > 0) throw new ConflictError(`${customers} ${customers === 1 ? 'customer is' : 'customers are'} priced from ${list.code}: give ${customers === 1 ? 'it' : 'them'} another list first.`)
      const lists = await tx.priceList.findMany({ where: { baseListId: listId, status: 'ACTIVE' }, select: { code: true } })
      if (lists.length > 0) throw new ConflictError(`${lists.map((row) => row.code).join(', ')} ${lists.length === 1 ? 'falls' : 'fall'} back to ${list.code}: change ${lists.length === 1 ? 'it' : 'them'} first.`)
    } else {
      if (list.kind === 'BASE') await assertOneBase(tx, context.tenantId, list)
      if (list.baseListId) {
        const base = await tx.priceList.findUnique({ where: { id: list.baseListId }, select: { code: true, status: true } })
        if (base?.status === 'ARCHIVED') throw new ConflictError(`${list.code} falls back to ${base.code}, which is archived: reactivate that one first, or change the list it falls back to.`)
      }
    }
    await tx.priceList.update({ where: { id: listId }, data: { status: to, updatedAt: now }, select: { id: true } })
    tools.audit({ action: `priceLists.${move}`, recordType: 'PriceList', recordId: listId, companyId: list.companyId, before: { status: list.status }, after: { status: to } })
    tools.emit({ type: 'price_list.changed', subject: listId, companyId: list.companyId, payload: { listId, code: list.code, change: move === 'archive' ? 'ARCHIVED' : 'REACTIVATED', fields: ['status'], partyIds: [] } })
    return detailInCommand(tools, listId)
  })
  return result
}

/**
 * The checks of giving a list to a customer (here and from the customer's commercial terms): the list is active, of the
 * customer's company or every company, in the customer's currency.
 */
export function listProblemFor(list: Pick<ListRow, 'code' | 'status' | 'companyId' | 'currency'>, party: { readonly companyId: string | null; readonly currency: string; readonly code: string }): string | null {
  if (list.status !== 'ACTIVE') return `${list.code} is archived: a customer is priced from an active list.`
  if (list.companyId !== null && party.companyId !== null && list.companyId !== party.companyId) return `${list.code} belongs to another company than ${party.code}.`
  if (list.currency !== party.currency) return `${list.code} is in ${list.currency}; ${party.code}'s documents are in ${party.currency}.`
  return null
}

/**
 * POST /sales/price-lists/:listId/customers (add) and …/customers/remove: the customers priced from this list by default
 * (a GROUP list: its members). Each customer is changed with parties.manage on it; one command; each party's version
 * moves (its record re-reads on party.updated).
 */
export async function setCustomers(caller: CommandCaller, listId: string, action: 'add' | 'remove', body: { partyIds: readonly string[]; validFrom?: BusinessDate | undefined }, idempotencyKey?: string): Promise<{ list: ListDetail }> {
  const context = officeContextOf(caller)
  const seen = await readListFor(caller, listId)
  assertMayChangeList(context, PRICE_LISTS_MANAGE, seen.companyId)
  const ids = [...new Set(body.partyIds)].sort()
  const { result } = await command(caller, { name: action === 'add' ? 'priceLists.addCustomers' : 'priceLists.removeCustomers', idempotencyKey, input: { listId, ...body } }, async (tools) => {
    const { tx, now } = tools
    // FOR SHARE: an archive waits for this command, then counts its customers.
    await tx.$queryRaw`SELECT id FROM "PriceList" WHERE id = ${listId}::uuid FOR SHARE`
    const list = await tx.priceList.findUniqueOrThrow({ where: { id: listId }, select: LIST_COLUMNS })
    const parties = await tx.party.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, companyId: true, currency: true, status: true, priceListId: true, createdAt: true } })
    const issues: Issue[] = []
    for (const [index, partyId] of ids.entries()) {
      const party = parties.find((row) => row.id === partyId)
      const at = `body/partyIds/${index}`
      if (!party) issues.push({ path: at, message: 'No such customer.' })
      else if (!mayWriteParty(actorOf(context), PARTIES_MANAGE, party)) issues.push({ path: at, message: `You may not change ${party.code}.` })
      else if (party.status === 'ARCHIVED') issues.push({ path: at, message: `${party.code} is archived.` })
      else if (action === 'add') {
        const problem = listProblemFor(list, party)
        if (problem) issues.push({ path: at, message: problem })
      } else if (party.priceListId !== listId) issues.push({ path: at, message: `${party.code} is not priced from ${list.code}.` })
    }
    if (issues.length > 0) throw new ValidationError(issues.length === 1 ? issues[0]!.message : 'Some customers cannot be changed.', issues)
    const changed = parties.filter((party) => (action === 'add' ? party.priceListId !== listId : true))
    // B-W2b-16: the customers' list history follows (from `validFrom`, default today; one change per day).
    const codes = await listCodesOf(tx, [listId, ...changed.flatMap((party) => (party.priceListId ? [party.priceListId] : []))])
    for (const party of changed) {
      await givePriceListInCommand(tools, party, action === 'add' ? listId : null, (id) => codes.get(id) ?? id, action === 'add' ? body.validFrom : undefined)
      await tx.party.update({ where: { id: party.id }, data: { priceListId: action === 'add' ? listId : null, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      tools.audit({ action: action === 'add' ? 'parties.setPriceList' : 'parties.clearPriceList', recordType: 'Party', recordId: party.id, companyId: party.companyId, before: { listId: party.priceListId }, after: { listId: action === 'add' ? listId : null } })
      tools.emit({ type: 'party.updated', subject: party.id, companyId: party.companyId, payload: { partyId: party.id, code: party.code, fields: ['priceListId'] } })
    }
    tools.audit({ action: action === 'add' ? 'priceLists.addCustomers' : 'priceLists.removeCustomers', recordType: 'PriceList', recordId: listId, companyId: list.companyId, after: { partyIds: changed.map((party) => party.id) } })
    if (changed.length > 0) tools.emit({ type: 'price_list.changed', subject: listId, companyId: list.companyId, payload: { listId, code: list.code, change: 'CUSTOMERS', fields: [], partyIds: changed.map((party) => party.id) } })
    return detailInCommand(tools, listId)
  })
  return result
}


/** B-W2b-16: the codes of price lists, for the words of a refused list change. */
export async function listCodesOf(db: Reader, ids: readonly string[]): Promise<Map<string, string>> {
  const rows = await db.priceList.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, code: true } })
  return new Map(rows.map((row) => [row.id, row.code]))
}
