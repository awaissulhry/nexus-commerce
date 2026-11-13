import { ConflictError, DomainError, InvalidStateError, type Issue } from '@nexus/factory-domain/core/errors'
import { pickTakesProblem, takesChangeProblem, type OptionGroupTakes, type TakesBody, type TakesView } from '@nexus/factory-domain/product/options/takes'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { PRODUCT_OPTIONS_MANAGE } from '@nexus/factory-domain/product/options/permissions'
import { mayWrite } from '../materials/store'
import { assertMayManage, contextOf, GROUP_COLUMNS, readGroup, type Db, type GroupRow } from './store'

/**
 * What a chosen value of an option group takes with it (B-W2b-374; XF3:05; OptionGroup.takes): COLOUR, a colour of the colour
 * library (a panel); MATERIAL, a material and its colour (leather by article); null, either (B-W2b-340's configurator as before).
 *
 *   GET /product/option-groups/:groupId/takes   product.styles.view   what the group takes, the chosen options (quotes and
 *                                                                     orders) that pick each kind, whether the person may change it
 *   PUT /product/option-groups/:groupId/takes   product.options.manage {version, takes}: ONE command on the group (its version);
 *                                                                     refused in words (409) while chosen options pick the other
 *                                                                     kind; audit, option_group.changed {UPDATED}
 *
 * `assertPicksTake` is the configurator's (and the copies' and typed lines') check of a choice before it is written: a COLOUR
 * group's value names no material, a MATERIAL group's no library colour (409 in words; the …_followups_sales_w2b5_guards
 * triggers hold the same rule). The configurator offers only the picker the group takes (style.ts `takes`).
 */

type Picking = { readonly colours: number; readonly materials: number }

async function pickingOf(db: Db, groupId: string): Promise<Picking> {
  const [quoteColours, orderColours, quoteMaterials, orderMaterials] = await Promise.all([
    db.quoteLineOption.count({ where: { groupId, colourId: { not: null } } }),
    db.salesOrderLineOption.count({ where: { groupId, colourId: { not: null } } }),
    db.quoteLineOption.count({ where: { groupId, itemId: { not: null } } }),
    db.salesOrderLineOption.count({ where: { groupId, itemId: { not: null } } }),
  ])
  return { colours: quoteColours + orderColours, materials: quoteMaterials + orderMaterials }
}

function viewOf(row: Pick<GroupRow, 'id' | 'code' | 'version' | 'takes' | 'status' | 'companyId'>, picking: Picking, mayManage: boolean): TakesView {
  const held = !mayManage
    ? { it: 'Lo leggi: cambiarlo spetta a chi gestisce la libreria delle opzioni.', en: 'You may read it: changing it is for people who keep the option library.' }
    : row.status === 'ARCHIVED'
      ? { it: 'Il gruppo è archiviato: ripristinalo prima di cambiarlo.', en: 'The group is archived: restore it before changing it.' }
      : null
  return { groupId: row.id, code: row.code, version: row.version, takes: row.takes, picking: { ...picking }, may: { change: held === null, held } }
}

const mayManageOf = (caller: CommandCaller, companyId: string | null): boolean => mayWrite(actorOf(contextOf(caller)), PRODUCT_OPTIONS_MANAGE, companyId)

/** GET /product/option-groups/:groupId/takes (product.styles.view). */
export async function readTakes(caller: CommandCaller, groupId: string): Promise<TakesView> {
  const row = await readGroup(caller, groupId)
  return caller.withClient(async (db) => viewOf(row, await pickingOf(db, row.id), mayManageOf(caller, row.companyId)))
}

/** A refusal of the …_followups_sales_w2b5_guards triggers (a race the checks did not see) is a 409 in its words. */
export async function takesGuarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
    if (cause?.originalCode === '23514' && typeof cause.originalMessage === 'string' && cause.originalMessage.startsWith('options: ')) {
      const words = cause.originalMessage.slice('options: '.length)
      throw new ConflictError(`${words.charAt(0).toUpperCase()}${words.slice(1)}. Load the options again.`)
    }
    throw error
  }
}

/** PUT /product/option-groups/:groupId/takes (product.options.manage): see the file's head. */
export async function setTakes(caller: CommandCaller, groupId: string, body: TakesBody, idempotencyKey?: string): Promise<TakesView> {
  const seen = await readGroup(caller, groupId)
  assertMayManage(contextOf(caller), seen.companyId)
  const { result } = await takesGuarded(() =>
    command(caller, { name: 'product.options.setTakes', idempotencyKey, input: { groupId, ...body }, record: { type: 'OptionGroup', id: groupId, expectedVersion: body.version } }, async (tools) => {
      const { tx } = tools
      const row = await tx.optionGroup.findUniqueOrThrow({ where: { id: groupId }, select: GROUP_COLUMNS })
      if (row.status === 'ARCHIVED') throw new InvalidStateError(`Option group ${row.code} is archived: restore it before changing it.`)
      if (row.takes === body.takes) {
        tools.audit({ recordType: 'OptionGroup', recordId: groupId, companyId: row.companyId, before: {}, after: {} })
        return viewOf(row, await pickingOf(tx, groupId), true)
      }
      // The chosen options that pick the other kind (quotes and orders) are read under the group's lock (command()'s record guard).
      const picking = await pickingOf(tx, groupId)
      const problem = takesChangeProblem(row.code, body.takes, picking)
      if (problem) throw new DomainError('conflict', problem.en, [{ path: 'body/takes', message: problem.en }])
      await tx.optionGroup.update({ where: { id: groupId }, data: { takes: body.takes, updatedAt: tools.now }, select: { id: true } })
      tools.audit({ recordType: 'OptionGroup', recordId: groupId, companyId: row.companyId, before: { takes: row.takes }, after: { takes: body.takes } })
      tools.emit({ type: 'option_group.changed', subject: groupId, companyId: row.companyId, payload: { optionGroupId: groupId, code: row.code, change: 'UPDATED', valueIds: [] } })
      const fresh = await tx.optionGroup.findUniqueOrThrow({ where: { id: groupId }, select: GROUP_COLUMNS })
      return viewOf(fresh, picking, true)
    }),
  )
  return result
}

/** A pick as the checks read it: its value, and the colour or material picked with it. */
export interface TakesPick {
  readonly valueId: string
  readonly colourId?: string | null | undefined
  readonly itemId?: string | null | undefined
}

/** The problems of picks whose colour or material is not what their group takes (by index, at `at`), in English. */
export async function picksTakesProblems(db: Db, picks: readonly TakesPick[], at = 'body/picks'): Promise<Issue[]> {
  const extra = picks.filter((pick) => pick.colourId || pick.itemId)
  if (extra.length === 0) return []
  const values = await db.optionValue.findMany({ where: { id: { in: [...new Set(extra.map((pick) => pick.valueId))] } }, select: { id: true, groupId: true } })
  const groupOf = new Map(values.map((value) => [value.id, value.groupId]))
  const groups = new Map((await db.optionGroup.findMany({ where: { id: { in: [...new Set(values.map((value) => value.groupId))] } }, select: { id: true, code: true, takes: true } })).map((group) => [group.id, group]))
  const issues: Issue[] = []
  picks.forEach((pick, index) => {
    const group = groups.get(groupOf.get(pick.valueId) ?? '')
    if (!group) return
    const problem = pickTakesProblem({ code: group.code, takes: group.takes as OptionGroupTakes | null }, pick)
    if (problem) issues.push({ path: `${at}/${index}/${group.takes === 'COLOUR' ? 'itemId' : 'colourId'}`, message: problem.en })
  })
  return issues
}

/** The configurator's check before it writes a choice: a pick that does not fit its group's takes is a 409 in words. */
export async function assertPicksTake(db: Db, picks: readonly TakesPick[], at = 'body/picks'): Promise<void> {
  const issues = await picksTakesProblems(db, picks, at)
  if (issues.length > 0) throw new DomainError('conflict', issues[0]!.message, issues)
}
