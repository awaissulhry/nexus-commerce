import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, holds, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { SAFETY_VIEW } from '@nexus/factory-domain/safety/organisation/permissions'
import { SAFETY_PPE_MANAGE } from '@nexus/factory-domain/safety/ppe/permissions'
import { cleanSizes, COMMON_PPE, itemProblems, normalPpeCode, PPE_LAW, PPE_LIMITS, PPE_REFUSALS, type PpeCategory } from '@nexus/factory-domain/safety/ppe/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { actorIdOf, assertMayAt, assertMayWriteAt, assertVersion, officeOf, problemsError, refuse } from '../organisation/access'
import { ITEM_SELECT, itemView, readItem, type ItemRow } from './store'

/**
 * The PPE catalogue (B-W2b-134; QHS-259; design plant.ppe "Catalogue" (art. 77 c.1), the pop-up "PPE item", the empty state
 * "Start from common items"), office only, each write one command with an Idempotency-Key:
 *
 *   GET   /safety/ppe/items                 a company's items (safety.view; ?companyId&status&q): category, standard, sizes,
 *                                           life, supplier, the unit cost (cost grain), how many kits name it
 *   GET   /safety/ppe/items/:id             one item and the ACTIVE role kits that name it
 *   POST  /safety/ppe/items                 add one (safety.ppe.manage): a code unique in the tenant (capitals), category
 *                                           I, II or III, sizes each once, 1 to 120 months, a supplier of the company or
 *                                           the group (an organisation), a unit cost only with the cost grain
 *   PATCH /safety/ppe/items/:id             change it at its version (the code and the company never change)
 *   POST  /safety/ppe/items/:id/archive     once no ACTIVE role's kit names it (IN_KIT); /restore brings it back
 *   POST  /safety/ppe/items/common          the common items the company has none of yet (by code; a code another company
 *                                           holds gets the company's code after it), in one command
 * A role's kit is the role sheet's (B-W2b-128): it is read here, never written.
 */

const MANAGE_WORDS = 'The PPE catalogue of this company is kept by a role that keeps it (safety.ppe.manage).'

const holdsHere = (context: OfficeContext, permission: Parameters<typeof can>[1]): boolean => (context.companyId ? can(actorOf(context), permission, { companyId: context.companyId }) : holds(actorOf(context), permission))

/** The items the caller's grants reach (an item is a company's: a grant over a site of the company reads its catalogue). */
function itemScope(context: OfficeContext): Prisma.PpeItemWhereInput {
  const reach = scopeWhere(actorOf(context), SAFETY_VIEW, { company: 'companyId' }) as Prisma.PpeItemWhereInput
  return context.companyId ? { AND: [reach, { companyId: context.companyId }] } : reach
}

async function readableItem(caller: CommandCaller, context: OfficeContext, itemId: string): Promise<ItemRow> {
  const row = isUuid(itemId) ? await caller.withClient((client) => readItem(client, itemId)) : null
  if (!row) throw new NotFoundError('PPE item not found.')
  assertMayAt(context, SAFETY_VIEW, { companyId: row.companyId, siteId: null }, 'PPE item')
  return row
}

/** GET /safety/ppe/items. */
export async function listItems(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly status?: 'ACTIVE' | 'ARCHIVED' | 'all' | undefined; readonly q?: string | undefined }) {
  const context = officeOf(caller)
  const status = query.status ?? 'ACTIVE'
  const q = query.q?.trim()
  const rows = (await caller.withClient((client) =>
    client.ppeItem.findMany({
      where: {
        AND: [
          itemScope(context),
          ...(query.companyId ? [{ companyId: query.companyId }] : []),
          ...(status === 'all' ? [] : [{ status }]),
          ...(q ? [{ OR: [{ code: { contains: q, mode: 'insensitive' as const } }, { name: { contains: q, mode: 'insensitive' as const } }, { standard: { contains: q, mode: 'insensitive' as const } }] }] : []),
        ],
      },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
      take: PPE_LIMITS.list + 1,
      select: ITEM_SELECT,
    }),
  )) as ItemRow[]
  return { items: rows.slice(0, PPE_LIMITS.list).map((row) => itemView(context, row)), complete: rows.length <= PPE_LIMITS.list, canAdd: holdsHere(context, SAFETY_PPE_MANAGE), law: PPE_LAW }
}

/** GET /safety/ppe/items/:ppeItemId: the item and the ACTIVE role kits that name it (read here, edited in the role sheet). */
export async function itemRecord(caller: CommandCaller, itemId: string) {
  const context = officeOf(caller)
  const row = await readableItem(caller, context, itemId)
  const kits = await caller.withClient((client) =>
    client.ppeKitLine.findMany({
      where: { ppeItemId: row.id, roleSheet: { status: 'ACTIVE' } },
      orderBy: [{ roleSheet: { site: { code: 'asc' } } }, { roleSheet: { code: 'asc' } }],
      select: { quantity: true, whenToWear: true, roleSheet: { select: { id: true, code: true, name: true, site: { select: { code: true, name: true } } } } },
    }),
  )
  return {
    item: itemView(context, row),
    kits: kits.map((line) => ({ roleSheetId: line.roleSheet.id, code: line.roleSheet.code, name: line.roleSheet.name, site: { code: line.roleSheet.site.code, name: line.roleSheet.site.name }, quantity: line.quantity, whenToWear: line.whenToWear })),
    law: PPE_LAW,
  }
}

const textOrNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const namesOrNull = (value: Readonly<Record<string, string>> | null | undefined): Record<string, string> | null => {
  if (!value) return null
  const kept = Object.fromEntries(Object.entries(value).map(([language, words]) => [language, words.trim()]).filter(([, words]) => words !== ''))
  return Object.keys(kept).length > 0 ? kept : null
}

/** A supplier the item may name: an organisation of the company or of the group, ACTIVE. */
async function checkSupplier(tools: CommandTools, companyId: string, partyId: string | null | undefined): Promise<void> {
  if (!partyId) return
  const party = await tools.tx.party.findUnique({ where: { id: partyId }, select: { companyId: true, kind: true, status: true } })
  if (!party || party.kind !== 'ORGANISATION' || party.status !== 'ACTIVE' || (party.companyId !== null && party.companyId !== companyId)) refuse('SUPPLIER_NOT_FOUND', PPE_REFUSALS.SUPPLIER_NOT_FOUND, 'supplierPartyId')
}

/** What an audit row keeps of an item (the unit cost marked with its grain). */
const audited = (row: { code: string; name: string; nameI18n: Prisma.JsonValue | null; category: string; standard: string | null; sizes: readonly string[]; lifeMonths: number | null; supplierPartyId: string | null; unitCost: number | null; status: string; note: string | null }) => ({
  code: row.code,
  name: row.name,
  nameI18n: row.nameI18n,
  category: row.category,
  standard: row.standard,
  sizes: [...row.sizes],
  lifeMonths: row.lifeMonths,
  supplierPartyId: row.supplierPartyId,
  unitCost: markMoney('cost', row.unitCost),
  status: row.status,
  note: row.note,
})

export interface ItemBody {
  readonly companyId: string
  readonly code: string
  readonly name: string
  readonly nameI18n?: Readonly<Record<string, string>> | null | undefined
  readonly category: PpeCategory
  readonly standard?: string | null | undefined
  readonly sizes?: readonly string[] | undefined
  readonly lifeMonths?: number | null | undefined
  readonly supplierPartyId?: string | null | undefined
  readonly unitCost?: number | null | undefined
  readonly note?: string | null | undefined
}

/** Inside a command: one item of the company (the code free in the tenant), its audit row and ppe_item.changed ADDED. */
async function insertItem(tools: CommandTools, body: ItemBody): Promise<string> {
  const code = normalPpeCode(body.code)
  if (await tools.tx.ppeItem.findFirst({ where: { code }, select: { id: true } })) refuse('CODE_TAKEN', PPE_REFUSALS.CODE_TAKEN, 'code')
  await checkSupplier(tools, body.companyId, body.supplierPartyId)
  const id = newId()
  const data = {
    code,
    name: body.name.trim(),
    nameI18n: namesOrNull(body.nameI18n),
    category: body.category,
    standard: textOrNull(body.standard),
    sizes: cleanSizes(body.sizes ?? []),
    lifeMonths: body.lifeMonths ?? null,
    supplierPartyId: body.supplierPartyId ?? null,
    unitCost: body.unitCost ?? null,
    status: 'ACTIVE' as const,
    note: textOrNull(body.note),
  }
  await tools.tx.ppeItem.create({ data: { id, companyId: body.companyId, ...data, nameI18n: data.nameI18n ?? undefined, createdAt: tools.now, updatedAt: tools.now, createdById: actorIdOf(tools.context) }, select: { id: true } })
  tools.audit({ action: 'safety.addPpeItem', recordType: 'PpeItem', recordId: id, companyId: body.companyId, after: audited(data) })
  tools.emit({ type: 'ppe_item.changed', subject: id, companyId: body.companyId, payload: { ppeItemId: id, change: 'ADDED' } })
  return id
}

/** POST /safety/ppe/items. */
export async function addItem(caller: CommandCaller, body: ItemBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const company = isUuid(body.companyId) ? await caller.withClient((client) => client.company.findUnique({ where: { id: body.companyId }, select: { id: true } })) : null
  if (!company) throw new NotFoundError('Company not found.')
  assertMayWriteAt(context, SAFETY_PPE_MANAGE, { companyId: company.id, siteId: null }, MANAGE_WORDS)
  const problems = itemProblems(body)
  if (problems.length > 0) throw problemsError(problems, 'The PPE item is not complete.')
  const { result, replayed } = await command(caller, { name: 'safety.addPpeItem', idempotencyKey, input: body }, async (tools) => ({ id: await insertItem(tools, body) }))
  return { item: itemView(context, (await caller.withClient((client) => readItem(client, result.id)))!), replayed }
}

export interface ItemEdit {
  readonly version: number
  readonly name?: string | undefined
  readonly nameI18n?: Readonly<Record<string, string>> | null | undefined
  readonly category?: PpeCategory | undefined
  readonly standard?: string | null | undefined
  readonly sizes?: readonly string[] | undefined
  readonly lifeMonths?: number | null | undefined
  readonly supplierPartyId?: string | null | undefined
  readonly unitCost?: number | null | undefined
  readonly note?: string | null | undefined
}

/** PATCH /safety/ppe/items/:ppeItemId: the fields sent, at the version read; nothing changed → the item as it is. */
export async function editItem(caller: CommandCaller, itemId: string, body: ItemEdit, idempotencyKey?: string) {
  const context = officeOf(caller)
  const row = await readableItem(caller, context, itemId)
  assertMayWriteAt(context, SAFETY_PPE_MANAGE, { companyId: row.companyId, siteId: null }, MANAGE_WORDS)
  const problems = itemProblems(body)
  if (problems.length > 0) throw problemsError(problems, 'The PPE item is not complete.')
  const { result } = await command(caller, { name: 'safety.editPpeItem', idempotencyKey, input: { itemId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await tx.$queryRaw`SELECT "id" FROM "PpeItem" WHERE "id" = ${itemId}::uuid FOR UPDATE`
    const current = (await readItem(tx, itemId))!
    assertVersion('PPE item', current.version, body.version)
    if (current.status !== 'ACTIVE') refuse('ARCHIVED', PPE_REFUSALS.ARCHIVED)
    const next = {
      name: body.name !== undefined ? body.name.trim() : current.name,
      nameI18n: body.nameI18n !== undefined ? namesOrNull(body.nameI18n) : (current.nameI18n as Record<string, string> | null),
      category: body.category ?? current.category,
      standard: body.standard !== undefined ? textOrNull(body.standard) : current.standard,
      sizes: body.sizes !== undefined ? cleanSizes(body.sizes) : current.sizes,
      lifeMonths: body.lifeMonths !== undefined ? body.lifeMonths : current.lifeMonths,
      supplierPartyId: body.supplierPartyId !== undefined ? body.supplierPartyId : current.supplierPartyId,
      unitCost: body.unitCost !== undefined ? body.unitCost : current.unitCost,
      note: body.note !== undefined ? textOrNull(body.note) : current.note,
    }
    const before = audited(current)
    const after = audited({ ...current, ...next })
    if (JSON.stringify(before) === JSON.stringify(after)) {
      tools.audit({ action: 'safety.editPpeItem', recordType: 'PpeItem', recordId: itemId, companyId: current.companyId, after: { unchanged: true } })
      return { changed: false }
    }
    if (body.supplierPartyId !== undefined && body.supplierPartyId !== current.supplierPartyId) await checkSupplier(tools, current.companyId, body.supplierPartyId)
    const { nameI18n, ...rest } = next
    await tx.ppeItem.update({ where: { id: itemId }, data: { ...rest, ...(nameI18n ? { nameI18n } : {}), version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    // factory-db exports Prisma's types, not its runtime DbNull: a JSON column is cleared in SQL (as payment terms do).
    if (nameI18n === null && current.nameI18n !== null) await tx.$executeRaw`UPDATE "PpeItem" SET "nameI18n" = NULL WHERE "id" = ${itemId}::uuid`
    tools.audit({ action: 'safety.editPpeItem', recordType: 'PpeItem', recordId: itemId, companyId: current.companyId, before, after })
    tools.emit({ type: 'ppe_item.changed', subject: itemId, companyId: current.companyId, payload: { ppeItemId: itemId, change: 'EDITED' } })
    return { changed: true }
  })
  return { item: itemView(context, (await caller.withClient((client) => readItem(client, itemId)))!), changed: result.changed }
}

/** POST /safety/ppe/items/:ppeItemId/archive | restore. */
export async function setItemStatus(caller: CommandCaller, itemId: string, status: 'ACTIVE' | 'ARCHIVED', body: { readonly version: number }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const row = await readableItem(caller, context, itemId)
  assertMayWriteAt(context, SAFETY_PPE_MANAGE, { companyId: row.companyId, siteId: null }, MANAGE_WORDS)
  const name = status === 'ARCHIVED' ? 'safety.archivePpeItem' : 'safety.restorePpeItem'
  await command(caller, { name, idempotencyKey, input: { itemId, status, ...body } }, async (tools) => {
    const { tx, now } = tools
    await tx.$queryRaw`SELECT "id" FROM "PpeItem" WHERE "id" = ${itemId}::uuid FOR UPDATE`
    const current = (await readItem(tx, itemId))!
    assertVersion('PPE item', current.version, body.version)
    if (current.status === status) refuse(status === 'ARCHIVED' ? 'ARCHIVED' : 'NOT_ARCHIVED', status === 'ARCHIVED' ? 'This PPE item is archived already.' : PPE_REFUSALS.NOT_ARCHIVED)
    if (status === 'ARCHIVED') {
      const kits = await tx.ppeKitLine.findMany({ where: { ppeItemId: itemId, roleSheet: { status: 'ACTIVE' } }, select: { roleSheet: { select: { code: true } } }, take: 10 })
      if (kits.length > 0) refuse('IN_KIT', `${PPE_REFUSALS.IN_KIT} (${[...new Set(kits.map((line) => line.roleSheet.code))].join(', ')})`)
    }
    await tx.ppeItem.update({ where: { id: itemId }, data: { status, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: name, recordType: 'PpeItem', recordId: itemId, companyId: current.companyId, before: { status: current.status }, after: { status } })
    tools.emit({ type: 'ppe_item.changed', subject: itemId, companyId: current.companyId, payload: { ppeItemId: itemId, change: status === 'ARCHIVED' ? 'ARCHIVED' : 'RESTORED' } })
    return null
  })
  return { item: itemView(context, (await caller.withClient((client) => readItem(client, itemId)))!) }
}

/** POST /safety/ppe/items/common: the common items the company has none of yet, in one command. */
export async function addCommonItems(caller: CommandCaller, body: { readonly companyId: string; readonly codes?: readonly string[] | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const company = isUuid(body.companyId) ? await caller.withClient((client) => client.company.findUnique({ where: { id: body.companyId }, select: { id: true, code: true } })) : null
  if (!company) throw new NotFoundError('Company not found.')
  assertMayWriteAt(context, SAFETY_PPE_MANAGE, { companyId: company.id, siteId: null }, MANAGE_WORDS)
  const wanted = body.codes ? new Set(body.codes.map(normalPpeCode)) : null
  const unknown = wanted ? [...wanted].filter((code) => !COMMON_PPE.some((item) => item.code === code)) : []
  if (unknown.length > 0) throw problemsError([{ path: 'body/codes', message: `Not a common item: ${unknown.join(', ')}.` }], 'Pick common items by their code.')
  const { result } = await command(caller, { name: 'safety.addCommonPpeItems', idempotencyKey, input: body }, async (tools) => {
    const ids: string[] = []
    const skipped: string[] = []
    const own = await tools.tx.ppeItem.findMany({ where: { companyId: company.id }, select: { code: true } })
    for (const common of COMMON_PPE.filter((item) => !wanted || wanted.has(item.code))) {
      const companyCode = `${common.code}-${normalPpeCode(company.code)}`.slice(0, PPE_LIMITS.code)
      if (own.some((item) => item.code === common.code || item.code === companyCode)) {
        skipped.push(common.code)
        continue
      }
      const taken = await tools.tx.ppeItem.findFirst({ where: { code: common.code }, select: { id: true } })
      ids.push(await insertItem(tools, { companyId: company.id, code: taken ? companyCode : common.code, name: common.name, nameI18n: common.nameI18n, category: common.category, standard: common.standard, sizes: common.sizes, lifeMonths: common.lifeMonths }))
    }
    if (ids.length === 0) tools.audit({ action: 'safety.addCommonPpeItems', recordType: 'Company', recordId: company.id, companyId: company.id, after: { added: 0, skipped } })
    return { ids, skipped }
  })
  const rows = (await caller.withClient((client) => client.ppeItem.findMany({ where: { id: { in: result.ids } }, orderBy: [{ code: 'asc' }], select: ITEM_SELECT }))) as ItemRow[]
  return { items: rows.map((row) => itemView(context, row)), added: result.ids.length, skipped: result.skipped }
}
