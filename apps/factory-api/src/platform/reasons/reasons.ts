import type { Prisma } from '@nexus/factory-db'
import { DomainError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { grantsFor, type Actor } from '@nexus/factory-domain/core/permissions'
import { fieldsOf, REASON_LISTS, sourceOf, type ReasonList } from '@nexus/factory-domain/reasons/lists'
import { REASONS_MANAGE } from '@nexus/factory-domain/reasons/permissions'
import { mergedWords, nextSortOrder, orderProblems, reasonDraftProblems, sortOrdersOf, type ReasonDraft } from '@nexus/factory-domain/reasons/rules'
import { missingStandardReasons } from '@nexus/factory-domain/reasons/standard'
import { command, type CommandCaller, type CommandTools } from '../../core/command'
import { actorOf, type RequestContext } from '../../core/context'
import { ApiError } from '../../core/errors'
import type { CreateBody, EditBody, ListView, ReasonView } from './contract'
import { modelOf, rowsOf, storeOf, type ReasonChange, type ReasonRow } from './sources'

/**
 * The reason lists (B-W2a-18; PLT-116): the pickers' read, the editor's read and the editor's commands, the same for
 * every list whatever table keeps it (sources.ts). A list is the whole tenant's — every company and site picks from it —
 * so keeping one needs reasons.manage over every company and site (`mayKeep`, 403 in words). Each write is ONE command():
 * its audit row per reason changed and one `reason.changed` event. A code never changes and a reason is never deleted:
 * "remove" is set inactive (records keep the code), and a code taken in the list, active or not, is refused in words.
 */

type Client = Prisma.TransactionClient

function contextOf(caller: CommandCaller): RequestContext {
  if (!caller.factoryContext) throw new ApiError('unauthenticated')
  return caller.factoryContext
}
const actor = (caller: CommandCaller): Actor => actorOf(contextOf(caller))
const createdBy = (context: RequestContext) => (context.audience === 'office' ? context.actorId : null)
const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'
/** A command that changed nothing (a race left nothing to do) still records that it ran, on the tenant. */
const tenantOf = (tools: CommandTools): string => (tools.context as { readonly tenantId: string }).tenantId
const prefixed = (issues: readonly Issue[]): Issue[] => issues.map((issue) => ({ path: `body/${issue.path}`, message: issue.message }))

/** Keeping the lists reaches every company and site: a grant over all of them holding reasons.manage. */
export const keepsReasons = (who: Actor): boolean => grantsFor(who, REASONS_MANAGE).some((grant) => grant.companies === 'all' && grant.sites === 'all')

function mayKeep(who: Actor): void {
  if (!keepsReasons(who)) throw new ForbiddenError("The reason lists are the whole group's: keeping them needs reasons.manage over every company and site.")
}

/** `?list=A,B` → the lists asked, once each, in the order asked; none: every list. */
export function listsOf(query: string | undefined): ReasonList[] {
  if (!query) return [...REASON_LISTS]
  return [...new Set(query.split(',').map((entry) => entry.trim()))].filter((entry): entry is ReasonList => (REASON_LISTS as readonly string[]).includes(entry))
}

function checkDraft(list: ReasonList, draft: ReasonDraft): void {
  const problems = reasonDraftProblems(list, draft)
  if (problems.length > 0) throw new ValidationError('The reason is not valid.', prefixed(problems))
}

// ---- views ----------------------------------------------------------------------------------------------------------

const viewOf = (row: ReasonRow, usedCount: number): ReasonView => ({
  id: row.id,
  list: row.list,
  code: row.code,
  labelIt: row.labelIt,
  labelEn: row.labelEn,
  labelI18n: { ...row.labelI18n },
  icon: row.icon,
  colour: row.colour,
  needsDetail: row.needsDetail,
  sortOrder: row.sortOrder,
  active: row.active,
  usedCount,
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
})

/** One list as the editor shows it: its reasons with how often each is used, the counts, the standard codes it lacks. */
export async function listViewOf(client: Client, list: ReasonList, known?: readonly ReasonRow[]): Promise<ListView> {
  const store = storeOf(list)
  const rows = known ?? (await store.rows(client, [list]))
  const used = await store.usage(client, list)
  return {
    list,
    source: sourceOf(list),
    fields: { ...fieldsOf(list) },
    active: rows.filter((row) => row.active).length,
    inactive: rows.filter((row) => !row.active).length,
    standardMissing: missingStandardReasons(list, rows.map((row) => row.code)).map((reason) => reason.code),
    reasons: rows.map((row) => viewOf(row, used.get(row.code) ?? 0)),
  }
}

async function usedCountOf(client: Client, row: ReasonRow): Promise<number> {
  return (await storeOf(row.list).usage(client, row.list)).get(row.code) ?? 0
}

/** The tenant's other floor languages: every site's floorLocales but Italian and English, sorted. */
async function floorLanguages(client: Client): Promise<string[]> {
  const sites = await client.site.findMany({ select: { floorLocales: true } })
  return [...new Set(sites.flatMap((site) => site.floorLocales))].filter((language) => language !== 'it' && language !== 'en').sort()
}

const audited = (row: ReasonRow) => ({ list: row.list, code: row.code, labelIt: row.labelIt, labelEn: row.labelEn, labelI18n: row.labelI18n, icon: row.icon, colour: row.colour, needsDetail: row.needsDetail, sortOrder: row.sortOrder, active: row.active })

function emitChange(tools: CommandTools, list: ReasonList, change: 'CREATED' | 'EDITED' | 'DEACTIVATED' | 'REACTIVATED' | 'REORDERED' | 'STANDARD_ADDED', codes: readonly string[]): void {
  tools.emit({ type: 'reason.changed', subject: list, companyId: null, siteId: null, payload: { list, change, codes: [...codes] } })
}

// ---- reads ----------------------------------------------------------------------------------------------------------

/** GET /reasons: the active reasons of the lists asked, in tile order (any office or floor session; the pickers). */
export async function pickerReasons(caller: CommandCaller, query: { list?: string | undefined }) {
  const lists = listsOf(query.list)
  return caller.withClient(async (client) => ({
    reasons: (await rowsOf(client, lists, { activeOnly: true })).map((row) => ({
      id: row.id,
      list: row.list,
      code: row.code,
      labelIt: row.labelIt,
      labelEn: row.labelEn,
      labelI18n: { ...row.labelI18n },
      icon: row.icon,
      colour: row.colour,
      needsDetail: row.needsDetail,
      sortOrder: row.sortOrder,
    })),
  }))
}

/** GET /reasons/lists: every list asked as the editor shows it (reasons.view). */
export async function editorLists(caller: CommandCaller, query: { list?: string | undefined }) {
  const lists = listsOf(query.list)
  const who = actor(caller)
  return caller.withClient(async (client) => {
    const rows = await rowsOf(client, lists)
    const views: ListView[] = []
    for (const list of lists) views.push(await listViewOf(client, list, rows.filter((row) => row.list === list)))
    return { lists: views, languages: await floorLanguages(client), canManage: keepsReasons(who) }
  })
}

// ---- writes ---------------------------------------------------------------------------------------------------------

/** reasons.create: a new reason at the end of its list. */
export async function createReason(caller: CommandCaller, list: ReasonList, body: CreateBody, idempotencyKey?: string): Promise<ReasonView> {
  mayKeep(actor(caller))
  const draft: ReasonDraft = { code: body.code, labelIt: body.labelIt, labelEn: body.labelEn, labelI18n: body.labelI18n, icon: body.icon ?? null, colour: body.colour ?? null, needsDetail: body.needsDetail ?? false }
  checkDraft(list, draft)
  const store = storeOf(list)
  const taken = (code: string, active: boolean) =>
    new DomainError('conflict', active ? `The list already has the code ${code}.` : `The list already has the code ${code}, set inactive: set it active again instead of adding it.`, [{ path: 'body/code', message: active ? 'taken' : 'taken, inactive' }])
  try {
    const { result } = await command(caller, { name: 'reasons.create', idempotencyKey, input: { list, ...body } }, async (tools) => {
      // Inside the work: a repeated Idempotency-Key gets its stored answer before this check.
      const rows = await store.rows(tools.tx, [list])
      const same = rows.find((row) => row.code === body.code)
      if (same) throw taken(same.code, same.active)
      const row = await store.create(tools.tx, list, {
        id: newId(),
        code: body.code,
        labelIt: body.labelIt.trim(),
        labelEn: body.labelEn.trim(),
        labelI18n: mergedWords({}, body.labelI18n),
        icon: body.icon ?? null,
        colour: body.colour ? body.colour.toLowerCase() : null,
        needsDetail: body.needsDetail ?? false,
        sortOrder: nextSortOrder(rows.map((entry) => entry.sortOrder)),
        at: tools.now,
        createdById: createdBy(tools.context),
      })
      tools.audit({ recordType: modelOf(list), recordId: row.id, companyId: null, after: audited(row) })
      emitChange(tools, list, 'CREATED', [row.code])
      return viewOf(row, 0)
    })
    return result
  } catch (error) {
    if (isUniqueViolation(error)) throw taken(body.code, true)
    throw error
  }
}

/** reasons.edit: words (one language at a time or several), icon, colour, "needs a note", active — at the version read. */
export async function editReason(caller: CommandCaller, list: ReasonList, reasonId: string, body: EditBody, idempotencyKey?: string): Promise<ReasonView> {
  mayKeep(actor(caller))
  const store = storeOf(list)
  const found = await caller.withClient((client) => store.row(client, list, reasonId))
  if (!found) throw new NotFoundError('The reason was not found in this list.')
  checkDraft(list, { labelIt: body.labelIt, labelEn: body.labelEn, labelI18n: body.labelI18n, icon: body.icon, colour: body.colour, needsDetail: body.needsDetail })
  const { result } = await command(
    caller,
    { name: 'reasons.edit', idempotencyKey, input: { list, reasonId, ...body }, record: { type: modelOf(list), id: reasonId, expectedVersion: body.version } },
    async (tools) => {
      const before = await store.row(tools.tx, list, reasonId)
      if (!before) throw new NotFoundError('The reason was not found in this list.')
      const change: ReasonChange = {
        ...(body.labelIt === undefined ? {} : { labelIt: body.labelIt.trim() }),
        ...(body.labelEn === undefined ? {} : { labelEn: body.labelEn.trim() }),
        ...(body.labelI18n === undefined ? {} : { labelI18n: mergedWords(before.labelI18n, body.labelI18n) }),
        ...(body.icon === undefined ? {} : { icon: body.icon }),
        ...(body.colour === undefined ? {} : { colour: body.colour === null ? null : body.colour.toLowerCase() }),
        ...(body.needsDetail === undefined ? {} : { needsDetail: body.needsDetail }),
        ...(body.active === undefined ? {} : { active: body.active }),
      }
      const row = await store.update(tools.tx, list, reasonId, change, tools.now)
      tools.audit({ recordType: modelOf(list), recordId: row.id, companyId: null, before: audited(before), after: audited(row) })
      const moved = body.active !== undefined && body.active !== before.active
      const onlyActive = Object.keys(change).every((key) => key === 'active')
      emitChange(tools, list, moved && onlyActive ? (row.active ? 'REACTIVATED' : 'DEACTIVATED') : 'EDITED', [row.code])
      return viewOf(row, await usedCountOf(tools.tx, row))
    },
  )
  return result
}

function staleAt(index: number, code: string): DomainError {
  return new DomainError('conflict', `The reason ${code} changed since the list was read: reload it and try again.`, [{ path: `body/reasons/${index}/version`, message: 'changed since it was read' }])
}

/** reasons.deactivate | reasons.reactivate: many reasons of one list at once (the editor's bulk action). */
export async function setActive(caller: CommandCaller, list: ReasonList, body: { active: boolean; reasons: readonly { id: string; version: number }[] }, idempotencyKey?: string): Promise<{ list: ListView; changed: string[] }> {
  mayKeep(actor(caller))
  const store = storeOf(list)
  const { result } = await command(caller, { name: body.active ? 'reasons.reactivate' : 'reasons.deactivate', idempotencyKey, input: { list, ...body } }, async (tools) => {
    const changed: string[] = []
    for (const [index, sent] of body.reasons.entries()) {
      const current = await store.row(tools.tx, list, sent.id)
      if (!current) throw new DomainError('not_found', 'A reason was not found in this list.', [{ path: `body/reasons/${index}/id`, message: 'not of this list' }])
      if (current.version !== sent.version) throw staleAt(index, current.code)
      if (current.active === body.active) continue
      const row = await store.updateAtVersion(tools.tx, list, sent.id, sent.version, { active: body.active }, tools.now)
      if (!row) throw staleAt(index, current.code)
      tools.audit({ recordType: modelOf(list), recordId: row.id, companyId: null, before: { active: current.active }, after: { active: row.active, code: row.code, list } })
      changed.push(row.code)
    }
    if (changed.length > 0) emitChange(tools, list, body.active ? 'REACTIVATED' : 'DEACTIVATED', changed)
    else tools.audit({ recordType: 'Tenant', recordId: tenantOf(tools), companyId: null, after: { list, active: body.active, changed: 0 } })
    return { list: await listViewOf(tools.tx, list), changed }
  })
  return result
}

/** reasons.reorder: the list's tile order, every reason of the list named once, each at the version read. */
export async function reorder(caller: CommandCaller, list: ReasonList, body: { reasons: readonly { id: string; version: number }[] }, idempotencyKey?: string): Promise<{ list: ListView }> {
  mayKeep(actor(caller))
  const store = storeOf(list)
  const { result } = await command(caller, { name: 'reasons.reorder', idempotencyKey, input: { list, ...body } }, async (tools) => {
    const rows = await store.rows(tools.tx, [list])
    const problems = orderProblems(
      rows.map((row) => row.id),
      body.reasons.map((entry) => entry.id),
    )
    if (problems.length > 0) throw new ValidationError('The order does not name every reason of the list once.', prefixed(problems))
    const orders = sortOrdersOf(body.reasons.map((entry) => entry.id))
    const byId = new Map(rows.map((row) => [row.id, row]))
    let moved = 0
    for (const [index, sent] of body.reasons.entries()) {
      const current = byId.get(sent.id)!
      if (current.version !== sent.version) throw staleAt(index, current.code)
      const sortOrder = orders.get(sent.id)!
      if (current.sortOrder === sortOrder) continue
      const row = await store.updateAtVersion(tools.tx, list, sent.id, sent.version, { sortOrder }, tools.now)
      if (!row) throw staleAt(index, current.code)
      tools.audit({ recordType: modelOf(list), recordId: row.id, companyId: null, before: { sortOrder: current.sortOrder }, after: { sortOrder, code: row.code, list } })
      moved++
    }
    const codes = body.reasons.map((entry) => byId.get(entry.id)!.code)
    if (moved > 0) emitChange(tools, list, 'REORDERED', codes)
    else tools.audit({ recordType: 'Tenant', recordId: tenantOf(tools), companyId: null, after: { list, reordered: 0 } })
    return { list: await listViewOf(tools.tx, list) }
  })
  return result
}

/**
 * The standard reasons a list is missing, added at its end in their own order (inside a command: the API's route, the
 * new-tenant job). Codes the list has, active or not, are never touched. Returns the codes added.
 */
export async function addStandardInCommand(tools: CommandTools, list: ReasonList): Promise<string[]> {
  const store = storeOf(list)
  const rows = await store.rows(tools.tx, [list])
  const missing = missingStandardReasons(
    list,
    rows.map((row) => row.code),
  )
  let sortOrder = nextSortOrder(rows.map((row) => row.sortOrder))
  const added: string[] = []
  for (const reason of missing) {
    const row = await store.create(tools.tx, list, { id: newId(), code: reason.code, labelIt: reason.labelIt, labelEn: reason.labelEn, labelI18n: {}, icon: reason.icon, colour: reason.colour, needsDetail: reason.needsDetail, sortOrder, at: tools.now, createdById: createdBy(tools.context) })
    tools.audit({ action: 'reasons.addStandard', recordType: modelOf(list), recordId: row.id, companyId: null, after: audited(row) })
    added.push(row.code)
    sortOrder += 10
  }
  if (added.length > 0) emitChange(tools, list, 'STANDARD_ADDED', added)
  return added
}

/** reasons.addStandard: "Add the standard reasons" — the ones this list is missing. Nothing missing: nothing written. */
export async function addStandard(caller: CommandCaller, list: ReasonList, idempotencyKey?: string): Promise<{ list: ListView; added: string[] }> {
  mayKeep(actor(caller))
  const missing = await caller.withClient(async (client) => missingStandardReasons(list, (await storeOf(list).rows(client, [list])).map((row) => row.code)))
  if (missing.length === 0) return { list: await caller.withClient((client) => listViewOf(client, list)), added: [] }
  const { result } = await command(caller, { name: 'reasons.addStandard', idempotencyKey, input: { list } }, async (tools) => {
    const added = await addStandardInCommand(tools, list)
    if (added.length === 0) tools.audit({ recordType: 'Tenant', recordId: tenantOf(tools), companyId: null, after: { list, added: 0 } })
    return { list: await listViewOf(tools.tx, list), added }
  })
  return result
}
