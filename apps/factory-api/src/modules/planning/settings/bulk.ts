import { ConflictError, InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { itemPlanningProblems, mergeItemPlanning, type ItemPlanningValues } from '@nexus/factory-domain/planning/settings/items'
import { PLANNING_ITEMS_MANAGE, PLANNING_SETTINGS_MANAGE } from '@nexus/factory-domain/planning/settings/permissions'
import { efficiencyPctOf } from '@nexus/factory-domain/planning/settings/settings'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { command, StaleVersionError, type CommandCaller } from '../../../core/command'
import { officeContextOf, siteFor } from '../access'
import type { BulkItemParametersBody, BulkLanesBody, LaneView } from './contract'
import { emitChange, factProblems, ITEM_FIELDS, lockKey, patchOf, readItem } from './items'
import { laneViewOf, readLanes, type CapacityRow, type LaneFacts } from './lanes'
import { auditValuesOf, defaultEfficiencyOf, itemParametersViewOf, itemPlanningValuesOf, readItemPlanning, readSettings, siteViewOf } from './store'

/**
 * Bulk writes of a site's planning settings (B-W2b-20; B-W2a-59's gap: the grids' "Edit N", "Plan N by defaults" and
 * "the same % for N lanes" sent one write after the other, each named in the result):
 *
 *   POST  /planning/item-parameters/bulk   item parameters of one site: rows changed at their versions, rows made for
 *                                          items (and colours) the site plans by their defaults, rows removed — ONE
 *                                          command, all or nothing (planning.items.manage over the site)
 *   PATCH /planning/lanes                  planned efficiency, people and note of many lines and work centres of one site
 *                                          in ONE command (planning.settings.manage over the site)
 *
 * The rules are the single writes' (./items, ./lanes; factory-domain planning/settings): every row is checked, and every
 * problem is answered at once — 400 with issues `body/changes/<i>/<field>`, `body/lanes/<i>/<field>`; a row changed since
 * it was read is a 409 (stale version) naming it, a row taken since (another one for the same item and colour) a 409 —
 * and then nothing is written. Each row has its own audit row and event (planning.item_parameters_changed,
 * planning.capacity_changed), as a single write has.
 */

const at = (prefix: string, issues: readonly Issue[]): Issue[] => issues.map((issue) => ({ path: `${prefix}/${issue.path.replace(/^body\//, '')}`, message: issue.message }))

function refuseAll(problems: readonly Issue[], what: string): void {
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : `${what}: ${problems.length} problems; nothing was saved.`, problems)
}

/** POST /planning/item-parameters/bulk. */
export async function bulkItemParameters(caller: CommandCaller, body: BulkItemParametersBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const site = await siteFor(caller, body.siteId, PLANNING_ITEMS_MANAGE)
  if (site.status !== 'ACTIVE') throw new InvalidStateError('This site is archived: its planning cannot change.')
  const changes = body.changes ?? []
  const removals = body.remove ?? []
  if (changes.length + removals.length === 0) throw new ValidationError('Send at least one change or removal.', [{ path: 'body/changes', message: 'Nothing to save.' }])
  if (changes.length + removals.length > 200) throw new ValidationError('At most 200 rows at once.', [{ path: 'body/changes', message: 'Send at most 200 changes and removals together.' }])
  // The shape of each change, before anything is read.
  const shape: Issue[] = []
  changes.forEach((change, index) => {
    const existing = change.itemPlanningId !== undefined
    if (existing && (change.version === undefined || change.itemId !== undefined || change.itemColourId !== undefined)) shape.push({ path: `body/changes/${index}`, message: 'A change of a row names the row and its version, not the item.' })
    if (!existing && (change.itemId === undefined || change.version !== undefined)) shape.push({ path: `body/changes/${index}`, message: 'A new row names the item (and its colour), without a version.' })
  })
  const named = [...changes.flatMap((change) => (change.itemPlanningId ? [change.itemPlanningId] : [])), ...removals.map((row) => row.itemPlanningId)]
  if (new Set(named).size !== named.length) shape.push({ path: 'body', message: 'A row is named twice: change or remove each row once.' })
  const fresh = changes.flatMap((change) => (change.itemPlanningId === undefined && change.itemId ? [`${change.itemId}|${change.itemColourId ?? '*'}`] : []))
  if (new Set(fresh).size !== fresh.length) shape.push({ path: 'body/changes', message: 'Two new rows name the same item and colour.' })
  refuseAll(shape, 'The bulk change is not valid')

  const { result, replayed } = await command(caller, { name: 'planning.bulkItemParameters', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    const problems: Issue[] = []
    const plans: ({ kind: 'EDIT'; index: number; id: string; version: number; from: ItemPlanningValues; values: ItemPlanningValues; cleared: string[] } | { kind: 'CREATE'; index: number; itemId: string; itemColourId: string | null; values: ItemPlanningValues; cleared: string[] })[] = []
    for (const [index, change] of changes.entries()) {
      const prefix = `body/changes/${index}`
      const patch = patchOf(change)
      if (change.itemPlanningId) {
        const row = await readItemPlanning(tx, change.itemPlanningId)
        if (!row || row.siteId !== site.id) {
          problems.push({ path: `${prefix}/itemPlanningId`, message: 'No such item parameters at this site.' })
          continue
        }
        if (row.version !== change.version) throw new StaleVersionError('ItemPlanning', row.id, row.version, change.version!)
        const from = itemPlanningValuesOf(row)
        const next = mergeItemPlanning(from, patch)
        const valueProblems = itemPlanningProblems(next.values)
        const item = await readItem(tx, row.itemId)
        const facts = valueProblems.length === 0 && item ? await factProblems(tx, site, item, row.itemColourId, next.values, from) : []
        problems.push(...at(prefix, [...valueProblems, ...facts]))
        plans.push({ kind: 'EDIT', index, id: row.id, version: row.version, from, values: next.values, cleared: next.cleared as string[] })
        continue
      }
      const itemColourId = change.itemColourId ?? null
      const item = await readItem(tx, change.itemId!)
      if (!item || (item.companyId !== null && item.companyId !== site.companyId)) {
        problems.push({ path: `${prefix}/itemId`, message: 'No such item for this site: choose an item of the site’s company.' })
        continue
      }
      if (item.status !== 'ACTIVE') {
        problems.push({ path: `${prefix}/itemId`, message: `${item.code} is archived: archived items are not planned.` })
        continue
      }
      if (itemColourId !== null && !item.colours.some((colour) => colour.id === itemColourId)) {
        problems.push({ path: `${prefix}/itemColourId`, message: `No such colour of ${item.code}: choose one of its active colours, or none for every colour.` })
        continue
      }
      await lockKey(tx, context.tenantId, site, item.id, itemColourId)
      const taken = await tx.itemPlanning.findFirst({ where: { siteId: site.id, itemId: item.id, itemColourId }, select: { id: true } })
      if (taken) throw new ConflictError(`Row ${index + 1}: this site already plans ${item.code}${itemColourId ? ' in this colour' : ' (every colour)'} with item parameters ${taken.id}; change those instead.`)
      const next = mergeItemPlanning(null, patch)
      const valueProblems = itemPlanningProblems(next.values)
      const facts = valueProblems.length === 0 ? await factProblems(tx, site, item, itemColourId, next.values, null) : []
      problems.push(...at(prefix, [...valueProblems, ...facts]))
      plans.push({ kind: 'CREATE', index, itemId: item.id, itemColourId, values: next.values, cleared: next.cleared as string[] })
    }
    const removing: { id: string; version: number; index: number }[] = []
    for (const [index, removal] of removals.entries()) {
      const row = await readItemPlanning(tx, removal.itemPlanningId)
      if (!row || row.siteId !== site.id) {
        problems.push({ path: `body/remove/${index}/itemPlanningId`, message: 'No such item parameters at this site.' })
        continue
      }
      if (row.version !== removal.version) throw new StaleVersionError('ItemPlanning', row.id, row.version, removal.version)
      removing.push({ id: row.id, version: row.version, index })
    }
    refuseAll(problems, 'The item parameters cannot be saved this way')

    const out: { index: number; kind: 'CREATED' | 'EDITED' | 'UNCHANGED'; parameters: ReturnType<typeof itemParametersViewOf>; cleared: string[] }[] = []
    for (const plan of plans) {
      if (plan.kind === 'EDIT') {
        const changed = ITEM_FIELDS.filter((key) => plan.values[key] !== plan.from[key])
        if (changed.length > 0) {
          const { count } = await tx.itemPlanning.updateMany({ where: { id: plan.id, version: plan.version }, data: { ...plan.values, version: plan.version + 1 } })
          if (count !== 1) throw new StaleVersionError('ItemPlanning', plan.id, plan.version + 1, plan.version)
        }
        const after = (await readItemPlanning(tx, plan.id))!
        if (changed.length > 0) {
          tools.audit({ action: 'planning.bulkItemParameters', recordType: 'ItemPlanning', recordId: plan.id, companyId: site.companyId, siteId: site.id, before: auditValuesOf(plan.from), after: auditValuesOf(itemPlanningValuesOf(after)) })
          emitChange(tools, after, site, after.method, 'EDITED')
        }
        out.push({ index: plan.index, kind: changed.length > 0 ? 'EDITED' : 'UNCHANGED', parameters: itemParametersViewOf(after), cleared: changed.length > 0 ? plan.cleared : [] })
        continue
      }
      const id = newId()
      await tx.itemPlanning.create({ data: { id, companyId: site.companyId, siteId: site.id, itemId: plan.itemId, itemColourId: plan.itemColourId, ...plan.values, createdById: context.actorId }, select: { id: true } })
      const row = (await readItemPlanning(tx, id))!
      tools.audit({ action: 'planning.bulkItemParameters', recordType: 'ItemPlanning', recordId: id, companyId: site.companyId, siteId: site.id, before: null, after: { itemId: plan.itemId, itemColourId: plan.itemColourId, ...auditValuesOf(itemPlanningValuesOf(row)) } })
      emitChange(tools, row, site, row.method, 'CREATED')
      out.push({ index: plan.index, kind: 'CREATED', parameters: itemParametersViewOf(row), cleared: plan.cleared })
    }
    const removed: { itemPlanningId: string; itemId: string; itemColourId: string | null }[] = []
    for (const removal of removing) {
      const before = (await readItemPlanning(tx, removal.id))!
      const { count } = await tx.itemPlanning.deleteMany({ where: { id: removal.id, version: removal.version } })
      if (count !== 1) throw new StaleVersionError('ItemPlanning', removal.id, before.version, removal.version)
      tools.audit({ action: 'planning.bulkItemParameters', recordType: 'ItemPlanning', recordId: removal.id, companyId: site.companyId, siteId: site.id, before: { itemId: before.itemId, itemColourId: before.itemColourId, ...auditValuesOf(itemPlanningValuesOf(before)) }, after: null })
      emitChange(tools, before, site, before.method, 'DELETED')
      removed.push({ itemPlanningId: removal.id, itemId: before.itemId, itemColourId: before.itemColourId })
    }
    // command() records at least one audit row: a bulk change whose every row was already so says so once.
    if (out.every((entry) => entry.kind === 'UNCHANGED') && removed.length === 0) {
      tools.audit({ action: 'planning.bulkItemParameters', recordType: 'Site', recordId: site.id, companyId: site.companyId, siteId: site.id, before: null, after: { unchanged: out.length } })
    }
    return { changes: out.sort((a, b) => a.index - b.index), removed }
  })
  return { site: siteViewOf(site), ...result, replayed }
}

/** PATCH /planning/lanes. */
export async function bulkLanes(caller: CommandCaller, body: BulkLanesBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const site = await siteFor(caller, body.siteId, PLANNING_SETTINGS_MANAGE)
  const keys = body.lanes.map((lane) => `${lane.kind}:${lane.id}`)
  if (new Set(keys).size !== keys.length) throw new ValidationError('A lane is named twice.', [{ path: 'body/lanes', message: 'Name each lane once.' }])
  const shape: Issue[] = []
  body.lanes.forEach((lane, index) => {
    if (lane.plannedEfficiencyPct !== undefined && efficiencyPctOf(lane.plannedEfficiencyPct) === null) shape.push({ path: `body/lanes/${index}/plannedEfficiencyPct`, message: 'Give a percent above 0 and at most 200, with at most two decimals (85 or 92.5).' })
  })
  refuseAll(shape, 'The lanes cannot be saved this way')
  const { result, replayed } = await command(caller, { name: 'planning.bulkLanes', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    const settings = await readSettings(tx, site.id)
    const { lines, workCentres } = await readLanes(tx, site.id)
    const problems: Issue[] = []
    const found: { index: number; lane: LaneFacts }[] = []
    for (const [index, asked] of body.lanes.entries()) {
      const lane = (asked.kind === 'LINE' ? lines : workCentres).find((candidate) => candidate.id === asked.id)
      if (!lane) {
        problems.push({ path: `body/lanes/${index}/id`, message: `No active ${asked.kind === 'LINE' ? 'line' : 'work centre'} of this site.` })
        continue
      }
      if (!lane.row && asked.version !== undefined) problems.push({ path: `body/lanes/${index}/version`, message: `${lane.code} has no capacity of its own yet: save it without a version.` })
      if (lane.row && asked.version !== undefined && lane.row.version !== asked.version) throw new StaleVersionError(asked.kind === 'LINE' ? 'LineCapacity' : 'WorkCentreCapacity', lane.id, lane.row.version, asked.version)
      found.push({ index, lane })
    }
    refuseAll(problems, 'The lanes cannot be saved this way')
    const out: { lane: LaneView; changed: string[] }[] = []
    for (const { index, lane } of found) {
      const asked = body.lanes[index]!
      const row: CapacityRow | null = lane.row
      const values = {
        plannedEfficiencyPct: asked.plannedEfficiencyPct !== undefined ? efficiencyPctOf(asked.plannedEfficiencyPct)! : (row?.plannedEfficiencyPct ?? defaultEfficiencyOf(settings).efficiencyPct),
        people: asked.people === undefined ? (row?.people ?? null) : asked.people,
        note: asked.note === undefined ? (row?.note ?? null) : asked.note === '' ? null : asked.note,
      }
      const changed: ('plannedEfficiencyPct' | 'people' | 'note')[] = []
      if (!row || !new Dec(row.plannedEfficiencyPct).eq(values.plannedEfficiencyPct)) changed.push('plannedEfficiencyPct')
      if ((row?.people ?? null) !== values.people) changed.push('people')
      if ((row?.note ?? '') !== (values.note ?? '')) changed.push('note')
      const peopleField = lane.kind === 'LINE' ? 'operators' : 'units'
      const data = { plannedEfficiencyPct: values.plannedEfficiencyPct, [peopleField]: values.people, note: values.note }
      if (changed.length > 0) {
        if (row) {
          const where = { id: lane.id, version: row.version }
          const { count } = lane.kind === 'LINE' ? await tx.lineCapacity.updateMany({ where, data: { ...data, version: row.version + 1 } }) : await tx.workCentreCapacity.updateMany({ where, data: { ...data, version: row.version + 1 } })
          if (count !== 1) throw new StaleVersionError(lane.kind === 'LINE' ? 'LineCapacity' : 'WorkCentreCapacity', lane.id, row.version + 1, row.version)
        } else {
          const base = { id: lane.id, companyId: lane.companyId, siteId: lane.siteId, ...data, createdById: context.actorId }
          const { count } = lane.kind === 'LINE' ? await tx.lineCapacity.createMany({ data: [{ ...base, lineId: lane.id }], skipDuplicates: true }) : await tx.workCentreCapacity.createMany({ data: [{ ...base, workCentreId: lane.id }], skipDuplicates: true })
          if (count !== 1) throw new ConflictError(`The capacity of ${lane.code} was just saved by someone else; reload it and save again.`)
        }
      }
      const saved = (lane.kind === 'LINE' ? (await readLanes(tx, site.id, { kind: 'LINE', id: lane.id })).lines : (await readLanes(tx, site.id, { kind: 'WORK_CENTRE', id: lane.id })).workCentres)[0]!
      if (changed.length > 0) {
        const auditOf = (capacity: CapacityRow | null) => (capacity ? { plannedEfficiencyPct: capacity.plannedEfficiencyPct, [peopleField]: capacity.people, note: capacity.note } : null)
        const recordType = lane.kind === 'LINE' ? 'LineCapacity' : 'WorkCentreCapacity'
        tools.audit({ action: 'planning.bulkLanes', recordType, recordId: lane.id, companyId: lane.companyId, siteId: lane.siteId, before: auditOf(row), after: auditOf(saved.row) })
        tools.emit({ type: 'planning.capacity_changed', subject: lane.id, companyId: lane.companyId, siteId: lane.siteId, payload: { siteId: lane.siteId, laneKind: lane.kind, laneId: lane.id, change: row ? 'EDITED' : 'CREATED', changed } })
      }
      out.push({ lane: laneViewOf(saved, settings, null), changed })
    }
    if (out.every((entry) => entry.changed.length === 0)) {
      tools.audit({ action: 'planning.bulkLanes', recordType: 'Site', recordId: site.id, companyId: site.companyId, siteId: site.id, before: null, after: { unchanged: out.length } })
    }
    return { lanes: out }
  })
  return { site: siteViewOf(site), ...result, replayed }
}
