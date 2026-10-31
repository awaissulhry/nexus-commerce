import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { FLOOR_REASON_LISTS, missingFullReasons, type FloorReasonList } from '@nexus/factory-domain/production/settings/reason-lists'
import { nextSortOrder } from '@nexus/factory-domain/reasons/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { keepsReasons } from '../../../platform/reasons/reasons'
import { modelOf, storeOf, type ReasonRow } from '../../../platform/reasons/sources'

/**
 * The floor's full reason lists (B-W2b-53; MES-293; design production.settings "Reason codes" fr-reasons: "W1 a short
 * platform list, W2b full lists"), through the W2a reason editor's own stores (platform/reasons sources.ts: ReasonCode for
 * pause, downtime, help call, adjustment, hold and cancel; ScrapReason for scrap and rework). The editor keeps the lists
 * as before (words, languages, icon, colour, order, active); this adds the codes of the full list a list lacks.
 *
 *   GET  /production/settings/reasons        each floor list: active, inactive, the full list's codes it lacks (reasons.view)
 *   POST /production/settings/reasons/full   ONE command: the missing codes of the lists asked (all floor lists when none)
 *                                            at the end of each list, in the full list's order; an audit row per reason
 *                                            and one `reason.changed` (STANDARD_ADDED) per list, as the editor's "Add the
 *                                            standard reasons" writes them. Keeping a list needs reasons.manage over every
 *                                            company and site (the lists are the whole group's, B-W2a-18). Nothing
 *                                            missing: nothing written.
 *
 * A code a list has, active or not, is never added again and never changed: the editor's words stay the tenant's.
 */

type Client = Prisma.TransactionClient

export const FULL_REASONS_ACTION = 'production.addFullReasons'

function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

const audited = (row: ReasonRow) => ({ list: row.list, code: row.code, labelIt: row.labelIt, labelEn: row.labelEn, icon: row.icon, colour: row.colour, needsDetail: row.needsDetail, sortOrder: row.sortOrder, active: row.active })

async function listView(client: Client, list: FloorReasonList) {
  const rows = await storeOf(list).rows(client, [list])
  const active = rows.filter((row) => row.active).length
  return { list, active, inactive: rows.length - active, fullMissing: missingFullReasons(list, rows.map((row) => row.code)).map((reason) => reason.code) }
}

async function listsView(client: Client, lists: readonly FloorReasonList[]) {
  const answer = []
  for (const list of lists) answer.push(await listView(client, list))
  return answer
}

/** reasons.view: each floor list's counts and the full list's codes it lacks. */
export async function reasonLists(caller: CommandCaller) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => ({ lists: await listsView(client, FLOOR_REASON_LISTS), canManage: keepsReasons(actorOf(context)) }))
}

/** Inside a command: the full list's missing codes of one list, at its end; an audit row each; one event for the list. */
async function addMissingInCommand(tools: CommandTools, list: FloorReasonList): Promise<string[]> {
  const store = storeOf(list)
  const rows = await store.rows(tools.tx, [list])
  let sortOrder = nextSortOrder(rows.map((row) => row.sortOrder))
  const added: string[] = []
  for (const reason of missingFullReasons(list, rows.map((row) => row.code))) {
    const row = await store.create(tools.tx, list, { id: newId(), code: reason.code, labelIt: reason.labelIt, labelEn: reason.labelEn, labelI18n: {}, icon: reason.icon, colour: reason.colour, needsDetail: reason.needsDetail, sortOrder, at: tools.now, createdById: (tools.context as OfficeContext).actorId })
    tools.audit({ action: FULL_REASONS_ACTION, recordType: modelOf(list), recordId: row.id, companyId: null, after: audited(row) })
    added.push(row.code)
    sortOrder += 10
  }
  if (added.length > 0) tools.emit({ type: 'reason.changed', subject: list, companyId: null, siteId: null, payload: { list, change: 'STANDARD_ADDED', codes: added } })
  return added
}

/** reasons.manage over every company and site: the full lists' missing codes of the lists asked (every floor list when none). */
export async function addFullReasons(caller: CommandCaller, body: { readonly lists?: readonly FloorReasonList[] | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  if (!keepsReasons(actorOf(context))) throw new ForbiddenError("The reason lists are the whole group's: keeping them needs reasons.manage over every company and site.")
  const lists = FLOOR_REASON_LISTS.filter((list) => !body.lists || body.lists.includes(list))
  const before = await caller.withClient((client) => listsView(client, FLOOR_REASON_LISTS))
  if (before.filter((view) => lists.includes(view.list)).every((view) => view.fullMissing.length === 0)) return { lists: before, canManage: true, added: [] }
  const { result } = await command(caller, { name: FULL_REASONS_ACTION, idempotencyKey, input: { lists } }, async (tools) => {
    const added: { list: FloorReasonList; codes: string[] }[] = []
    for (const list of lists) {
      const codes = await addMissingInCommand(tools, list)
      if (codes.length > 0) added.push({ list, codes })
    }
    // A race left nothing to add: the command still records that it ran, on the tenant.
    if (added.length === 0) tools.audit({ action: FULL_REASONS_ACTION, recordType: 'Tenant', recordId: context.tenantId, companyId: null, after: { lists, added: 0 } })
    return { lists: await listsView(tools.tx, FLOOR_REASON_LISTS), canManage: true, added }
  })
  return result
}
