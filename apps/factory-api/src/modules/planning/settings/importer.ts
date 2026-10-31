import type { Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, type Actor } from '@nexus/factory-domain/core/permissions'
import type { CellValue } from '@nexus/factory-domain/imports/cells'
import type { ExistingRecord, RowIssue, RowValues } from '@nexus/factory-domain/imports/importer'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { itemPlanningProblems, mergeItemPlanning, type ItemPlanningPatch, type ItemPlanningValues } from '@nexus/factory-domain/planning/settings/items'
import { EVERY_COLOUR, importRecordValues, itemParametersImporter, patchOf as rowPatchOf } from '@nexus/factory-domain/planning/settings/importer'
import { PLANNING_ITEMS_MANAGE } from '@nexus/factory-domain/planning/settings/permissions'
import type { CommandTools, CommandTx } from '../../../core/command'
import { ApiError } from '../../../core/errors'
// Types only: platform/imports/registry.ts lists this adapter, so a value import back from it would be a cycle.
import type { CheckRow, ImportAdapter, ImportScope } from '../../../platform/imports/registry'
import { SITE_COLUMNS, type SiteRow } from '../store'
import { emitChange, factProblems, lockKey } from './items'
import { auditValuesOf, ITEM_PLANNING_SELECT, ITEM_SELECT, itemPlanningValuesOf, readItemPlanning, type ItemPlanningRow, type ItemRow } from './store'

/**
 * The item parameters' import adapter (B-W2b-20; platform/imports; factory-domain planning/settings/importer): a row is
 * a site's row of item parameters, found by the site's code (a site of the job's company), the item's code and the
 * colour's code (`*`: the row for every colour).
 *
 *   authorize  item parameters are a site's: a job for every company (companyId null) is refused; import per company.
 *              The engine checks planning.items.manage against the job's company and planning.view to see the plans.
 *   load       the site's rows the keys name, as the import sees them (the supplier's and make site's codes).
 *   check      every row against what it names, read again: the site (of the job's company, active, and one the person
 *              may plan at: planning.items.manage over the company and that site), the item (active, of the company
 *              or of every company), its colour, the supplier (an active supplier and an approved source of the item:
 *              items.ts `factProblems`, the routes' own) and the make site (an active plant of the company), and every
 *              item parameters rule on the row as it would be stored.
 *   write      one row in the batch's command: a new key takes the routes' lock (site, item, colour) and looks again
 *              (a row made since stops the batch: run the dry run again); a known row FOR UPDATE, merged as the PATCH
 *              merges (a change of method or source clears what it clears), version + 1; audited
 *              (planning.importItemParameters, before and after) with planning.item_parameters_changed.
 *
 * No money, no person.
 */

const ACTION = 'planning.importItemParameters'

/** Stops the batch: the row no longer fits what it names, or a row was made or changed since the dry run. */
class ImportRowRefused extends ApiError {
  constructor(what: string, detail: string) {
    super('conflict', `The import row for ${what} no longer fits: ${detail}. Run the dry run again.`)
  }
}

const codeOf = (values: Readonly<Record<string, unknown>>, column: 'site' | 'item' | 'colour'): string => String(values[column])
const whatOf = (key: Readonly<Record<string, unknown>>): string => `${codeOf(key, 'site')} · ${codeOf(key, 'item')} · ${codeOf(key, 'colour')}`

/** What one call reads once: the job company's sites by code, the items by code. */
interface Facts {
  readonly sites: ReadonlyMap<string, SiteRow>
  readonly items: ReadonlyMap<string, ItemRow>
}

async function factsFor(client: CommandTx, keys: readonly Readonly<Record<string, CellValue>>[], scope: ImportScope): Promise<Facts> {
  const siteCodes = [...new Set(keys.map((key) => codeOf(key, 'site')))]
  const itemCodes = [...new Set(keys.map((key) => codeOf(key, 'item')))]
  const sites = scope.companyId === null || siteCodes.length === 0 ? [] : await client.site.findMany({ where: { companyId: scope.companyId, code: { in: siteCodes } }, select: SITE_COLUMNS })
  const items = itemCodes.length === 0 ? [] : await client.item.findMany({ where: { code: { in: itemCodes } }, select: ITEM_SELECT })
  return { sites: new Map(sites.map((site) => [site.code, site])), items: new Map(items.map((item) => [item.code, item])) }
}

/** The colour id a key names (null: every colour); undefined when the item has no such active colour. */
const colourIdOf = (item: ItemRow, colour: string): string | null | undefined => (colour === EVERY_COLOUR ? null : item.colours.find((entry) => entry.code === colour)?.id)

/** The site's row for a key, or null. */
const rowAt = (client: CommandTx, siteId: string, itemId: string, itemColourId: string | null): Promise<ItemPlanningRow | null> =>
  client.itemPlanning.findFirst({ where: { siteId, itemId, itemColourId }, select: ITEM_PLANNING_SELECT })

/** A stored row as the import sees it: the supplier's and make site's codes where the ids stand. */
function importedOf(row: ItemPlanningRow): ItemPlanningValues {
  return { ...itemPlanningValuesOf(row), supplierId: row.supplier?.code ?? null, makeSiteId: row.makeSite?.code ?? null }
}

/** A rule's or fact's path (`body/<field>`) as the import column it is about. */
function rowIssue(issue: Issue): RowIssue {
  const field = issue.path.split('/').at(-1) ?? ''
  const column = field === 'supplierId' ? 'supplier' : field === 'makeSiteId' ? 'makeSite' : Object.hasOwn(itemParametersImporter.columns, field) ? field : undefined
  return column ? { column, message: issue.message } : { message: issue.message }
}

/** A row resolved against the database: its site, item and colour, the stored row (or null) and the values it stores. */
interface Resolved {
  readonly site: SiteRow
  readonly item: ItemRow
  readonly itemColourId: string | null
  readonly current: ItemPlanningRow | null
  /** The stored row after the row's cells (ids), and what the merge cleared. */
  readonly values: ItemPlanningValues
  readonly before: ItemPlanningValues | null
}

type Resolution = { readonly ok: true; readonly row: Resolved } | { readonly ok: false; readonly issues: RowIssue[] }

/**
 * Resolves one row: the site and its right, the item and its colour, the codes it gives as ids (supplier, make site),
 * merged over the stored row, every rule and fact checked (the routes' own). Reads only.
 */
async function resolve(client: CommandTx, key: Readonly<Record<string, CellValue>>, values: RowValues, scope: ImportScope, facts: Facts, actor: Actor | null): Promise<Resolution> {
  const siteCode = codeOf(key, 'site')
  const site = facts.sites.get(siteCode)
  if (!site) return { ok: false, issues: [{ column: 'site', message: `No site ${siteCode} in this company.` }] }
  if (site.status !== 'ACTIVE') return { ok: false, issues: [{ column: 'site', message: `Site ${siteCode} is archived: its planning cannot change.` }] }
  if (actor !== null && !can(actor, PLANNING_ITEMS_MANAGE, { companyId: site.companyId, siteId: site.id })) {
    return { ok: false, issues: [{ column: 'site', message: `Keeping the item parameters of site ${siteCode} needs planning.items.manage at that site.` }] }
  }
  const itemCode = codeOf(key, 'item')
  const item = facts.items.get(itemCode)
  if (!item) return { ok: false, issues: [{ column: 'item', message: `No item ${itemCode}.` }] }
  if (item.companyId !== null && item.companyId !== site.companyId) return { ok: false, issues: [{ column: 'item', message: `Item ${itemCode} belongs to another company: import its parameters with that company.` }] }
  if (item.status !== 'ACTIVE') return { ok: false, issues: [{ column: 'item', message: `Item ${itemCode} is archived: archived items are not planned.` }] }
  const colour = codeOf(key, 'colour')
  const itemColourId = colourIdOf(item, colour)
  if (itemColourId === undefined) return { ok: false, issues: [{ column: 'colour', message: `Item ${itemCode} has no active colour ${colour} (write * for every colour).` }] }

  const issues: RowIssue[] = []
  const patch: Record<string, unknown> = { ...rowPatchOf(values) }
  if (typeof values.supplier === 'string') {
    const party = await client.party.findFirst({ where: { code: values.supplier }, select: { id: true } })
    if (!party) issues.push({ column: 'supplier', message: `No supplier ${values.supplier}.` })
    else patch.supplierId = party.id
  }
  if (typeof values.makeSite === 'string') {
    const plant = scope.companyId === null ? null : await client.site.findFirst({ where: { companyId: scope.companyId, code: values.makeSite }, select: { id: true } })
    if (!plant) issues.push({ column: 'makeSite', message: `No site ${values.makeSite} in this company to make the item at.` })
    else patch.makeSiteId = plant.id
  }
  if (issues.length > 0) return { ok: false, issues }

  const current = await rowAt(client, site.id, item.id, itemColourId)
  const before = current ? itemPlanningValuesOf(current) : null
  const merged = mergeItemPlanning(before, patch as ItemPlanningPatch)
  const problems = itemPlanningProblems(merged.values)
  if (problems.length > 0) return { ok: false, issues: problems.map(rowIssue) }
  const named = await factProblems(client, site, item, itemColourId, merged.values, before)
  if (named.length > 0) return { ok: false, issues: named.map(rowIssue) }
  return { ok: true, row: { site, item, itemColourId, current, values: merged.values, before } }
}

const tenantOf = (tools: CommandTools): string => {
  const context = tools.context as { readonly tenantId?: string }
  if (!context.tenantId) throw new ApiError('internal_error', 'An item parameters import runs in a tenant.')
  return context.tenantId
}

export const itemParametersImportAdapter = Object.freeze({
  importer: itemParametersImporter,
  permission: PLANNING_ITEMS_MANAGE,
  viewPermission: PLANNING_VIEW,

  authorize(_actor, job) {
    if (job.companyId === null) return [{ path: 'companyId', message: "Item parameters belong to a company's sites: import them for one company." }]
    return []
  },

  async load(client, keys, scope) {
    const facts = await factsFor(client, keys, scope)
    const records: ExistingRecord[] = []
    for (const key of keys) {
      const site = facts.sites.get(codeOf(key, 'site'))
      const item = facts.items.get(codeOf(key, 'item'))
      if (!site || !item) continue
      const itemColourId = colourIdOf(item, codeOf(key, 'colour'))
      if (itemColourId === undefined) continue
      const row = await rowAt(client, site.id, item.id, itemColourId)
      // The key columns too: the engine finds each record's row by them.
      if (row) records.push({ id: row.id, values: { site: site.code, item: item.code, colour: codeOf(key, 'colour'), ...importRecordValues(importedOf(row)) } })
    }
    return records
  },

  async check(client, rows: readonly CheckRow[], scope, actor) {
    const facts = await factsFor(client, rows.map((row) => row.key), scope)
    const answers: RowIssue[][] = []
    for (const row of rows) {
      const resolved = await resolve(client, row.key, row.values, scope, facts, actor)
      answers.push(resolved.ok ? [] : resolved.issues)
    }
    return answers
  },

  async write(tools: CommandTools, row, scope) {
    const { tx, now } = tools
    const what = whatOf(row.key)
    const facts = await factsFor(tx, [row.key], scope)
    const site = facts.sites.get(codeOf(row.key, 'site'))
    const item = facts.items.get(codeOf(row.key, 'item'))
    if (!site || !item) throw new ImportRowRefused(what, 'the site or the item is gone')
    const colourId = colourIdOf(item, codeOf(row.key, 'colour'))
    if (colourId === undefined) throw new ImportRowRefused(what, 'the colour is gone')
    // The routes' lock on the key (a create looks after it), then the stored row FOR UPDATE (its own writes bump its version).
    await lockKey(tx, tenantOf(tools), site, item.id, colourId)
    if (row.action === 'UPDATE') await tx.$queryRaw`SELECT "id" FROM "ItemPlanning" WHERE "id" = ${row.recordId}::uuid FOR UPDATE`
    // The person was checked by the batch's check(); here the row is resolved again under the locks.
    const resolved = await resolve(tx, row.key, row.values, scope, facts, null)
    if (!resolved.ok) throw new ImportRowRefused(what, resolved.issues.map((issue) => issue.message).join(' '))
    const { current, values, before } = resolved.row
    if ((row.action === 'UPDATE') !== (current !== null) || (current !== null && current.id !== row.recordId)) throw new ImportRowRefused(what, row.action === 'CREATE' ? 'the site has made a row for it since' : 'the row was removed')

    if (current === null) {
      const id = newId()
      const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
      await tx.itemPlanning.create({ data: { id, companyId: site.companyId, siteId: site.id, itemId: item.id, itemColourId: colourId, ...values, createdById, createdAt: now, updatedAt: now }, select: { id: true } })
      const saved = (await readItemPlanning(tx, id))!
      tools.audit({ action: ACTION, recordType: 'ItemPlanning', recordId: id, companyId: site.companyId, siteId: site.id, before: null, after: { itemId: item.id, itemColourId: colourId, ...auditValuesOf(itemPlanningValuesOf(saved)) } })
      emitChange(tools, saved, site, saved.method, 'CREATED')
      return { recordId: id }
    }
    // The routes' version moves: an open edit of the row sees the import as a newer version.
    await tx.itemPlanning.update({ where: { id: current.id }, data: { ...values, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const saved = (await readItemPlanning(tx, current.id))!
    tools.audit({ action: ACTION, recordType: 'ItemPlanning', recordId: current.id, companyId: site.companyId, siteId: site.id, before: auditValuesOf(before), after: auditValuesOf(itemPlanningValuesOf(saved)) })
    emitChange(tools, saved, site, saved.method, 'EDITED')
    return { recordId: current.id }
  },
} satisfies ImportAdapter)

