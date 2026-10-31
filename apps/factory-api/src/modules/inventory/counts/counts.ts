import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { DocumentLanguage } from '@nexus/factory-domain/documents/model'
import {
  INVENTORY_COUNTS_APPROVE,
  INVENTORY_COUNTS_MANAGE,
  INVENTORY_COUNTS_SIGNOFF,
  INVENTORY_COUNTS_VIEW,
} from '@nexus/factory-domain/inventory/counts/permissions'
import {
  approveProblems,
  COUNT_LIMITS,
  countMoveNote,
  createProblems,
  differenceValue,
  differs,
  needsApproval,
  plannedMoveOf,
  quantityProblem,
  signOffProblems,
  snapshotFor,
  snapshotLines,
  submitProblems,
  type CountProblem,
} from '@nexus/factory-domain/inventory/counts/rules'
import { INVENTORY_ADJUST } from '@nexus/factory-domain/inventory/permissions'
import { locatedKeyOf, quantityText, type LocatedKey } from '@nexus/factory-domain/inventory/ledger/moves'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { COMMAND_SETTINGS, runCommand, StaleVersionError, type CommandCaller, type CommandSpec, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock, type Clock } from '../../../core/time'
import { putGeneratedFile, recordGeneratedFile } from '../../../platform/files/files'
import { processFiles } from '../../../platform/files/service'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { officeContextOf, seesCost, siteFor } from '../ledger/access'
import { postMoves, type MoveDraft, type PostedMove } from '../ledger/post-moves'
import type { PeriodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import type { AddLineBody, CountRecordView, CreateCountBody, EditCountBody, LineView, RecordLinesBody } from './contract'
import { balancesAt, heldByOtherCounts, siteLocations, subtreeOf, unitCostOf, unitCostsOf } from './ledger-at'
import { countSheetsPdf, valuedListFiles } from './papers'
import {
  deleteLine,
  insertCount,
  insertLine,
  insertSnapshotLines,
  LINE_COLUMNS,
  lockCount,
  lockSiteCounts,
  readCount,
  readLines,
  shareCount,
  updateCount,
  updateLine,
  type CountRow,
  type LineChanges,
  type LineRow,
} from './store'
import { factsOf, lineViews, peopleNames, recordView, scopeOf } from './views'

/**
 * Stock counts and the year-end physical inventory, office side (B-W2a-15; SCM-224, SCM-230; SCM-229, SCM-293). Every
 * write is ONE command(): a move of a count locks its row first (store.ts lockCount: FOR UPDATE + the version the caller
 * read) and checks the domain's rules in words (409, issues `problem/<CODE>`) before the …_stock_plan_w2a_guards
 * triggers would refuse it; typing lines takes the count's row FOR SHARE (many people type at once) and each line's
 * version (compare-and-set). A count's start and an added line take the site's count lock, so no stock key is in two
 * open counts. Applying posts the COUNT moves through the ledger's postMoves (modules/inventory/ledger), dated at the
 * snapshot, then names each line's move, then moves the count: lines first (the trigger reads them on the move).
 *
 * Scope: a count belongs to its site and company; each is checked with can() (a count the caller may not view is not
 * found). Office only.
 */

let clock: Clock = serverClock
/** Test only: the clock of the counts' commands and checks (default the server clock). */
export function useCountsClock(next: Clock | undefined): void {
  clock = next ?? serverClock
}

/** A start, an apply or a sign-off of a whole site touches thousands of rows: their command may take longer. */
const LONG_COMMAND_MS = 120_000

function countsCommand<Result>(caller: CommandCaller, spec: CommandSpec, work: (tools: CommandTools) => Promise<Result>, long = false) {
  return runCommand(caller, spec, work, { ...COMMAND_SETTINGS, clock, ...(long ? { timeoutMs: LONG_COMMAND_MS, maxWaitMs: 10_000 } : {}) })
}

/** A refusal in plain words: 409, each problem an issue `problem/<CODE>`. */
export class CountRefusedError extends InvalidStateError {
  override name = 'CountRefusedError'
  override readonly issues: readonly Issue[]
  constructor(message: string, problems: readonly CountProblem[]) {
    super(`${message} ${problems.map((problem) => problem.message).join(' ')}`.trim())
    this.issues = problems.map((problem) => ({ path: `problem/${problem.code}`, message: problem.message }))
  }
}

const refuse = (message: string, code: string, detail: string): CountRefusedError => new CountRefusedError(message, [{ code, message: detail }])

function must(context: OfficeContext, permission: Permission, row: { readonly companyId: string; readonly siteId: string }, words?: string): void {
  if (!can(actorOf(context), permission, scopeOf(row))) throw new ForbiddenError(words ?? `This needs ${permission}.`)
}

/** A count the caller may view, or not found. */
async function visibleCount(caller: CommandCaller, countId: string): Promise<CountRow> {
  const context = officeContextOf(caller)
  if (!isUuid(countId)) throw new NotFoundError('Stock count not found.')
  const row = await caller.withClient((client) => readCount(client, countId))
  if (!row || !can(actorOf(context), INVENTORY_COUNTS_VIEW, scopeOf(row))) throw new NotFoundError('Stock count not found.')
  return row
}

/** The record as the caller sees it now. */
export async function countRecord(caller: CommandCaller, countId: string): Promise<CountRecordView> {
  const context = officeContextOf(caller)
  const row = await visibleCount(caller, countId)
  return caller.withClient((client) => recordView(client, row, context, clock.now()))
}

const dayOf = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null)
const toDay = (value: string): Date => new Date(`${value}T00:00:00.000Z`)

function changed(tools: Pick<CommandTools, 'emit'>, row: CountRow, change: 'CREATED' | 'STARTED' | 'EDITED' | 'SUBMITTED' | 'APPROVED' | 'SENT_BACK' | 'CANCELLED', previousStatus: CountRow['status'] | null, lines: number): void {
  tools.emit({
    type: 'inventory.count_changed',
    subject: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    payload: {
      countId: row.id,
      number: row.number,
      kind: row.kind,
      status: row.status,
      previousStatus,
      change,
      lines,
      approvalRequired: row.submittedAt ? row.approvalRequired : null,
      scopeLocationId: row.locationId,
      scopeItemId: row.itemId,
      scopeLotId: row.lotId,
      scopeItemKind: row.itemKind,
    },
  })
}

async function lineTotals(tx: CommandTx, countId: string): Promise<{ lines: number; counted: number }> {
  const lines = await tx.stockCountLine.count({ where: { countId } })
  const counted = await tx.stockCountLine.count({ where: { countId, countedQuantity: { not: null } } })
  return { lines, counted }
}

function recorded(tools: Pick<CommandTools, 'emit'>, row: CountRow, change: 'COUNTED' | 'RECOUNT_ASKED' | 'ADDED' | 'REMOVED', lineIds: readonly string[], totals: { lines: number; counted: number }): void {
  if (lineIds.length === 0) return
  tools.emit({
    type: 'inventory.count_recorded',
    subject: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    payload: { countId: row.id, number: row.number, change, lineIds: [...lineIds], lines: totals.lines, counted: totals.counted },
  })
}

// ---- make, edit, start ----------------------------------------------------------------------------------------------------

/** inventory.counts.create: a count of a site's stock (DRAFT), or straight COUNTING with `start`. */
export async function createCount(caller: CommandCaller, body: CreateCountBody, idempotencyKey?: string): Promise<CountRecordView> {
  const context = officeContextOf(caller)
  const site = await siteFor(caller, body.siteId, INVENTORY_COUNTS_MANAGE, 'body/siteId')
  const problems = createProblems({ kind: body.kind, inventoryDate: body.inventoryDate ?? null })
  const scope = await caller.withClient(async (client) => {
    const issues: Issue[] = []
    if (body.locationId) {
      const location = await client.location.findUnique({ where: { id: body.locationId }, select: { siteId: true } })
      if (location?.siteId !== site.id) issues.push({ path: 'body/locationId', message: 'Not a location of this site.' })
    }
    let itemId = body.itemId ?? null
    if (body.lotId) {
      const lot = await client.lot.findUnique({ where: { id: body.lotId }, select: { siteId: true, itemId: true } })
      if (!lot || lot.siteId !== site.id) issues.push({ path: 'body/lotId', message: 'Not a lot of this site.' })
      else if (itemId && itemId !== lot.itemId) issues.push({ path: 'body/lotId', message: 'The lot is of another item.' })
      else itemId = lot.itemId
    }
    if (body.itemId) {
      const item = await client.item.findUnique({ where: { id: body.itemId }, select: { kind: true } })
      if (!item) issues.push({ path: 'body/itemId', message: 'Not an item of the tenant.' })
      else if (body.itemKind && item.kind !== body.itemKind) issues.push({ path: 'body/itemKind', message: `The item is ${item.kind}, not ${body.itemKind}.` })
    }
    return { itemId, issues }
  })
  const all = [...problems, ...scope.issues]
  if (all.length > 0) throw new ValidationError(all.length === 1 ? all[0]!.message : 'The count is not valid.', all)
  const { result } = await countsCommand(
    caller,
    { name: 'inventory.counts.create', idempotencyKey, input: body },
    async (tools) => {
      const id = newId()
      const issued = await countNumber(tools, site.companyId, id, body.kind === 'YEAR_END' ? (body.inventoryDate ?? null) : null)
      let row = await insertCount(tools, {
        id,
        companyId: site.companyId,
        siteId: site.id,
        number: issued.formatted,
        kind: body.kind,
        locationId: body.locationId ?? null,
        itemId: scope.itemId,
        lotId: body.lotId ?? null,
        itemKind: body.itemKind ?? null,
        inventoryDate: body.inventoryDate ? toDay(body.inventoryDate) : null,
        countTeam: body.countTeam ?? null,
        note: body.note ?? null,
        createdById: context.actorId,
      })
      changed(tools, row, 'CREATED', null, 0)
      if (body.start) row = await startInCommand(tools, row)
      return { countId: row.id }
    },
    body.start === true,
  )
  return countRecord(caller, result.countId)
}

/**
 * The count's number from the company's COUNT series. A year-end inventory takes it from its own year's series
 * (CNT-2026-… for 31 Dec 2026, also when made in January); when that year has no series (an inventory of a year before
 * the factory numbered counts), from the current one.
 */
async function countNumber(tools: CommandTools, companyId: string, id: string, inventoryDate: string | null) {
  const series = { companyId, kind: 'COUNT' as const }
  if (inventoryDate === null) return allocateNumber(tools, series, { type: 'StockCount', id })
  try {
    return await allocateNumber(tools, series, { type: 'StockCount', id, date: inventoryDate })
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error
    return allocateNumber(tools, series, { type: 'StockCount', id })
  }
}

/** inventory.counts.update: the team and the note, while DRAFT or COUNTING. */
export async function editCount(caller: CommandCaller, countId: string, body: EditCountBody, idempotencyKey?: string): Promise<CountRecordView> {
  const context = officeContextOf(caller)
  must(context, INVENTORY_COUNTS_MANAGE, await visibleCount(caller, countId))
  await countsCommand(caller, { name: 'inventory.counts.update', idempotencyKey, input: { countId, ...body } }, async (tools) => {
    const row = await lockCount(tools.tx, countId, body.version)
    if (row.status !== 'DRAFT' && row.status !== 'COUNTING') throw refuse(`Count ${row.number} is ${row.status}.`, 'NOT_EDITABLE', 'Only a DRAFT or COUNTING count changes its team or note.')
    const written = await updateCount(tools, row, {
      ...(body.countTeam !== undefined ? { countTeam: body.countTeam || null } : {}),
      ...(body.note !== undefined ? { note: body.note || null } : {}),
    })
    changed(tools, written, 'EDITED', row.status, (await lineTotals(tools.tx, countId)).lines)
    return { countId }
  })
  return countRecord(caller, countId)
}

/** inventory.counts.start: freeze the expected quantities (the snapshot's lines) and start counting. */
export async function startCount(caller: CommandCaller, countId: string, body: { readonly version: number }, idempotencyKey?: string): Promise<CountRecordView> {
  const context = officeContextOf(caller)
  must(context, INVENTORY_COUNTS_MANAGE, await visibleCount(caller, countId))
  await countsCommand(
    caller,
    { name: 'inventory.counts.start', idempotencyKey, input: { countId, ...body } },
    async (tools) => {
      const row = await lockCount(tools.tx, countId, body.version)
      if (row.status !== 'DRAFT') throw refuse(`Count ${row.number} is ${row.status}.`, 'NOT_DRAFT', 'Only a DRAFT count is started.')
      await startInCommand(tools, row)
      return { countId }
    },
    true,
  )
  return countRecord(caller, countId)
}

/**
 * The start, inside the caller's command on a locked DRAFT count: the snapshot's instant, the balances of the scope at
 * it (the ledger by occurredAt), one line per stock key held there in walking order, no key another open count holds;
 * then the count COUNTING with its start and snapshot (one UPDATE), then its lines (the trigger lets them in while it is
 * COUNTING).
 */
async function startInCommand(tools: CommandTools, row: CountRow): Promise<CountRow> {
  const { tx, now, context } = tools
  if (context.audience !== 'office') throw new ForbiddenError()
  const snapshot = snapshotFor(row.kind, dayOf(row.inventoryDate), now)
  if (snapshot.at === undefined) throw refuse(`Count ${row.number} cannot start yet.`, 'TOO_EARLY', snapshot.problem)
  await lockSiteCounts(tx, context.tenantId, row.siteId)
  const locations = await siteLocations(tx, row.siteId)
  const scoped = row.locationId ? subtreeOf(locations, row.locationId) : null
  const balances = await balancesAt(tx, { siteId: row.siteId, locationIds: scoped, itemId: row.itemId, lotId: row.lotId, itemKind: row.itemKind }, snapshot.at)
  const held = balances.filter((balance) => balance.onHand.greaterThan(0))
  if (held.length > COUNT_LIMITS.maxLines) {
    throw refuse(`Count ${row.number} cannot start.`, 'TOO_MANY_LINES', `Its scope holds ${held.length} stock keys; a count holds at most ${COUNT_LIMITS.maxLines}. Count a location, an item or a kind of material at a time.`)
  }
  const ids = (pick: (key: LocatedKey) => string | null) => [...new Set(held.map(pick).filter((id): id is string => id !== null))]
  const items = new Map((await tx.item.findMany({ where: { id: { in: ids((key) => key.itemId) } }, select: { id: true, code: true } })).map((item) => [item.id, item.code]))
  const colours = new Map((await tx.itemColour.findMany({ where: { id: { in: ids((key) => key.itemColourId) } }, select: { id: true, code: true } })).map((colour) => [colour.id, colour.code]))
  const lots = new Map((await tx.lot.findMany({ where: { id: { in: ids((key) => key.lotId) } }, select: { id: true, code: true } })).map((lot) => [lot.id, lot.code]))
  const hides = new Map((await tx.hide.findMany({ where: { id: { in: ids((key) => key.hideId) } }, select: { id: true, code: true } })).map((hide) => [hide.id, hide.code]))
  const lines = snapshotLines(held, (key) => [
    locations.get(key.locationId)?.path ?? '',
    items.get(key.itemId) ?? '',
    key.itemColourId ? (colours.get(key.itemColourId) ?? '') : '',
    key.lotId ? (lots.get(key.lotId) ?? '') : '',
    key.hideId ? (hides.get(key.hideId) ?? '') : '',
  ])
  const taken = await heldByOtherCounts(tx, row.siteId, row.id, lines)
  if (taken.length > 0) {
    const numbers = [...new Set(taken.map((entry) => entry.number))].sort()
    throw refuse(`Count ${row.number} cannot start.`, 'HELD_BY_OTHER_COUNT', `${taken.length} of its stock keys are being counted by ${numbers.join(', ')}; finish or cancel ${numbers.length === 1 ? 'that count' : 'those counts'} first, or narrow the scope.`)
  }
  const started = await updateCount(tools, row, { status: 'COUNTING', startedAt: now, snapshotAt: snapshot.at }, { action: 'inventory.counts.start' })
  await insertSnapshotLines(
    tx,
    now,
    lines.map((line) => ({
      id: newId(),
      siteId: row.siteId,
      countId: row.id,
      seq: line.seq,
      locationId: line.locationId,
      itemId: line.itemId,
      itemColourId: line.itemColourId,
      lotId: line.lotId,
      hideId: line.hideId,
      origin: 'SNAPSHOT' as const,
      expectedQuantity: line.expected,
      createdById: context.actorId,
    })),
  )
  tools.audit({ action: 'inventory.counts.snapshot', recordType: 'StockCount', recordId: row.id, companyId: row.companyId, siteId: row.siteId, after: { snapshotAt: toUtcIso(snapshot.at), lines: lines.length } })
  changed(tools, started, 'STARTED', row.status, lines.length)
  return started
}

// ---- the lines --------------------------------------------------------------------------------------------------------------

/** The active codes of the ADJUSTMENT reason list (the reasons a difference is given). */
async function adjustmentCodes(tx: CommandTx): Promise<Set<string>> {
  return new Set((await tx.reasonCode.findMany({ where: { list: 'ADJUSTMENT', active: true }, select: { code: true } })).map((row) => row.code))
}

function reasonIssue(code: string | null | undefined, codes: ReadonlySet<string>, path: string): Issue | null {
  if (code === undefined || code === null) return null
  return codes.has(code) ? null : { path, message: `${code} is not an active reason of the adjustment list.` }
}

async function countingCount(tx: CommandTx, countId: string): Promise<CountRow> {
  const row = await shareCount(tx, countId)
  if (row.status !== 'COUNTING') throw refuse(`Count ${row.number} is ${row.status}.`, 'NOT_COUNTING', 'Lines are typed while the count is COUNTING; its lines are history once it is submitted.')
  return row
}

async function hideAreas(tx: CommandTx, lines: readonly { readonly hideId: string | null }[]): Promise<Map<string, string>> {
  const ids = [...new Set(lines.flatMap((line) => (line.hideId ? [line.hideId] : [])))]
  if (ids.length === 0) return new Map()
  return new Map((await tx.hide.findMany({ where: { id: { in: ids } }, select: { id: true, baseArea: true } })).map((hide) => [hide.id, hide.baseArea.toString()]))
}

/** inventory.counts.record: counts, recounts and reasons typed (the count sheet's entry, or one cell). */
export async function recordLines(caller: CommandCaller, countId: string, body: RecordLinesBody, idempotencyKey?: string): Promise<{ lines: LineView[]; counted: number; all: number }> {
  const context = officeContextOf(caller)
  must(context, INVENTORY_COUNTS_MANAGE, await visibleCount(caller, countId))
  const seen = new Set<string>()
  body.lines.forEach((line, index) => {
    if (seen.has(line.lineId)) throw new ValidationError('A line is typed once per request.', [{ path: `body/lines/${index}/lineId`, message: 'This line is in the request twice.' }])
    seen.add(line.lineId)
  })
  const { result } = await countsCommand(caller, { name: 'inventory.counts.record', idempotencyKey, input: { countId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const count = await countingCount(tx, countId)
    const rows = new Map((await tx.stockCountLine.findMany({ where: { countId, id: { in: body.lines.map((line) => line.lineId) } }, select: LINE_COLUMNS })).map((row) => [row.id, row]))
    const areas = await hideAreas(tx, [...rows.values()])
    const codes = await adjustmentCodes(tx)
    const issues: Issue[] = []
    const planned: { row: LineRow; changes: LineChanges; version: number }[] = []
    body.lines.forEach((input, index) => {
      const at = `body/lines/${index}`
      const row = rows.get(input.lineId)
      if (!row) return void issues.push({ path: `${at}/lineId`, message: 'Not a line of this count.' })
      const changes: { -readonly [K in keyof LineChanges]: LineChanges[K] } = {}
      const asked = row.recountRequestedAt !== null
      const area = row.hideId ? (areas.get(row.hideId) ?? null) : null
      if (input.counted !== undefined) {
        if (asked) issues.push({ path: `${at}/counted`, message: `Line ${row.seq} waits for its recount: type the recount instead.` })
        else if (input.counted === null) Object.assign(changes, { countedQuantity: null, countedAt: null, countedById: null })
        else {
          const problem = quantityProblem(input.counted, `${at}/counted`, area)
          if (problem) issues.push(problem)
          else Object.assign(changes, { countedQuantity: quantityText(input.counted), countedAt: now, countedById: context.actorId })
        }
      }
      if (input.recount !== undefined) {
        if (!asked) issues.push({ path: `${at}/recount`, message: `Line ${row.seq} has no recount asked for.` })
        else if (row.countedQuantity === null) issues.push({ path: `${at}/recount`, message: `Line ${row.seq} is recounted after its first count.` })
        else {
          const problem = quantityProblem(input.recount, `${at}/recount`, area)
          if (problem) issues.push(problem)
          else Object.assign(changes, { recountQuantity: quantityText(input.recount), recountedAt: now, recountedById: context.actorId })
        }
      }
      if (input.reasonCode !== undefined) {
        const problem = reasonIssue(input.reasonCode, codes, `${at}/reasonCode`)
        if (problem) issues.push(problem)
        else changes.reasonCode = input.reasonCode
      }
      if (input.reasonNote !== undefined) changes.reasonNote = input.reasonNote || null
      if (Object.keys(changes).length > 0) planned.push({ row, changes, version: input.version })
    })
    if (issues.length > 0) throw new ValidationError(issues.length === 1 ? issues[0]!.message : 'These lines are not valid.', issues)
    const written: string[] = []
    for (const entry of planned) written.push((await updateLine(tools, entry.row, entry.changes, entry.version)).id)
    const totals = await lineTotals(tx, countId)
    recorded(tools, count, 'COUNTED', written, totals)
    if (written.length === 0) tools.audit({ recordType: 'StockCount', recordId: countId, companyId: count.companyId, siteId: count.siteId, after: { unchanged: body.lines.length } })
    return { lineIds: body.lines.map((line) => line.lineId), ...totals }
  })
  return caller.withClient(async (client) => {
    const count = (await readCount(client, countId))!
    const lines = await client.stockCountLine.findMany({ where: { countId, id: { in: result.lineIds } }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } })
    return { lines: await lineViews(client, count, lines, context), counted: result.counted, all: result.lines }
  })
}

/**
 * inventory.counts.addLine: a stock key found while counting where the ledger held none at the snapshot (an extra hide, a
 * lot in another bin): an ADDED line, expected 0, counted at once. A known item, lot and hide only (the COUNT move needs
 * their ids), inside the count's scope, at a location of it that takes stock, and in no other open count.
 */
export async function addLine(caller: CommandCaller, countId: string, body: AddLineBody, idempotencyKey?: string): Promise<{ line: LineView }> {
  const context = officeContextOf(caller)
  must(context, INVENTORY_COUNTS_MANAGE, await visibleCount(caller, countId))
  const quantity = quantityProblem(body.counted, 'body/counted')
  if (quantity) throw new ValidationError(quantity.message, [quantity])
  if (!new Dec(body.counted).greaterThan(0)) {
    throw new ValidationError('A line found while counting holds something.', [{ path: 'body/counted', message: 'Expected a quantity above 0 (what was not found has no line to add).' }])
  }
  const { result } = await countsCommand(caller, { name: 'inventory.counts.addLine', idempotencyKey, input: { countId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const count = await countingCount(tx, countId)
    await lockSiteCounts(tx, context.tenantId, count.siteId)
    const issues: Issue[] = []
    const locations = await siteLocations(tx, count.siteId)
    const location = locations.get(body.locationId)
    if (!location) issues.push({ path: 'body/locationId', message: 'Not a location of this site.' })
    else if (location.status === 'ARCHIVED') issues.push({ path: 'body/locationId', message: `Location ${location.code} is archived; it takes no stock.` })
    else if (count.locationId && !subtreeOf(locations, count.locationId).has(body.locationId)) issues.push({ path: 'body/locationId', message: 'The location is outside the count\'s scope.' })
    const item = await tx.item.findUnique({ where: { id: body.itemId }, select: { id: true, code: true, kind: true, tracking: true } })
    if (!item) issues.push({ path: 'body/itemId', message: 'Not an item of the tenant.' })
    else {
      if (count.itemId && count.itemId !== item.id) issues.push({ path: 'body/itemId', message: 'The item is outside the count\'s scope.' })
      if (count.itemKind && count.itemKind !== item.kind) issues.push({ path: 'body/itemId', message: `The count is of ${count.itemKind}; this item is ${item.kind}.` })
    }
    let lotId = body.lotId ?? null
    let colourId = body.itemColourId ?? null
    let area: string | null = null
    if (item) {
      if (item.tracking === 'HIDE') {
        const hide = body.hideId ? await tx.hide.findUnique({ where: { id: body.hideId }, select: { siteId: true, lotId: true, itemId: true, code: true, state: true, baseArea: true } }) : null
        if (!body.hideId) issues.push({ path: 'body/hideId', message: `${item.code} is counted hide by hide: name the hide.` })
        else if (!hide || hide.siteId !== count.siteId || hide.itemId !== item.id) issues.push({ path: 'body/hideId', message: 'Not a hide of this item at this site.' })
        else if (hide.state === 'CONSUMED' || hide.state === 'SCRAPPED') issues.push({ path: 'body/hideId', message: `Hide ${hide.code} is ${hide.state}: it left the stock for good; reverse its last move in Movements first.` })
        else if (lotId && lotId !== hide.lotId) issues.push({ path: 'body/lotId', message: 'The hide is of another lot.' })
        else {
          lotId = hide.lotId
          area = hide.baseArea.toString()
        }
      } else if (body.hideId) issues.push({ path: 'body/hideId', message: `${item.code} is not counted by hide.` })
      if (item.tracking === 'LOT' || item.tracking === 'HIDE') {
        const lot = lotId ? await tx.lot.findUnique({ where: { id: lotId }, select: { siteId: true, itemId: true, itemColourId: true } }) : null
        if (!lotId) issues.push({ path: 'body/lotId', message: `${item.code} is tracked by lot: name the lot.` })
        else if (!lot || lot.siteId !== count.siteId || lot.itemId !== item.id) issues.push({ path: 'body/lotId', message: 'Not a lot of this item at this site.' })
        else if (colourId && colourId !== lot.itemColourId) issues.push({ path: 'body/itemColourId', message: 'The lot is of another colour.' })
        else colourId = lot.itemColourId
        if (count.lotId && lotId !== count.lotId) issues.push({ path: 'body/lotId', message: 'The lot is outside the count\'s scope.' })
      } else if (lotId) issues.push({ path: 'body/lotId', message: `${item.code} is not tracked by lot.` })
      if (colourId && !(await tx.itemColour.findFirst({ where: { id: colourId, itemId: item.id }, select: { id: true } }))) issues.push({ path: 'body/itemColourId', message: 'Not a colour of this item.' })
    }
    if (area !== null) {
      const problem = quantityProblem(body.counted, 'body/counted', area)
      if (problem) issues.push(problem)
    }
    const codes = await adjustmentCodes(tx)
    const reason = reasonIssue(body.reasonCode, codes, 'body/reasonCode')
    if (reason) issues.push(reason)
    if (issues.length > 0) throw new ValidationError(issues.length === 1 ? issues[0]!.message : 'The line is not valid.', issues)
    const key: LocatedKey = { siteId: count.siteId, locationId: body.locationId, itemId: body.itemId, itemColourId: colourId, lotId, hideId: body.hideId ?? null }
    const same = (await readLines(tx, countId, { locationId: body.locationId, itemId: body.itemId })).find((line) => locatedKeyOf(line) === locatedKeyOf(key))
    if (same) throw refuse('The stock is on the count already.', 'ALREADY_COUNTED', `Line ${same.seq} counts it: type its count there.`)
    const taken = await heldByOtherCounts(tx, count.siteId, countId, [key])
    if (taken.length > 0) throw refuse('The stock is in another open count.', 'HELD_BY_OTHER_COUNT', `${taken[0]!.number} counts it; finish or cancel that count first.`)
    const last = await tx.stockCountLine.findFirst({ where: { countId }, orderBy: { seq: 'desc' }, select: { seq: true } })
    const line = await insertLine(tools, {
      id: newId(),
      siteId: count.siteId,
      countId,
      seq: (last?.seq ?? 0) + 10,
      locationId: body.locationId,
      itemId: body.itemId,
      itemColourId: colourId,
      lotId,
      hideId: body.hideId ?? null,
      origin: 'ADDED',
      expectedQuantity: quantityText('0'),
      countedQuantity: quantityText(body.counted),
      countedAt: now,
      countedById: context.actorId,
      reasonCode: body.reasonCode ?? null,
      reasonNote: body.reasonNote ?? null,
      createdById: context.actorId,
    })
    recorded(tools, count, 'ADDED', [line.id], await lineTotals(tx, countId))
    return { lineId: line.id }
  })
  return caller.withClient(async (client) => {
    const count = (await readCount(client, countId))!
    const lines = await client.stockCountLine.findMany({ where: { id: result.lineId }, select: LINE_COLUMNS })
    return { line: (await lineViews(client, count, lines, context))[0]! }
  })
}

/** inventory.counts.removeLine: a line found while counting taken back (the snapshot's lines stay: they are the frozen expectation). */
export async function removeLine(caller: CommandCaller, countId: string, lineId: string, body: { readonly version: number }, idempotencyKey?: string): Promise<{ removed: string }> {
  const context = officeContextOf(caller)
  must(context, INVENTORY_COUNTS_MANAGE, await visibleCount(caller, countId))
  if (!isUuid(lineId)) throw new NotFoundError('Line not found.')
  await countsCommand(caller, { name: 'inventory.counts.removeLine', idempotencyKey, input: { countId, lineId, ...body } }, async (tools) => {
    const count = await countingCount(tools.tx, countId)
    const line = await tools.tx.stockCountLine.findFirst({ where: { id: lineId, countId }, select: LINE_COLUMNS })
    if (!line) throw new NotFoundError('Line not found.')
    if (line.origin !== 'ADDED') throw refuse(`Line ${line.seq} is part of the snapshot.`, 'SNAPSHOT_LINE', 'Only a line found while counting is removed; type 0 for what the snapshot expected but was not found.')
    if (line.version !== body.version) throw new StaleVersionError('StockCountLine', lineId, line.version, body.version)
    await deleteLine(tools, line, body.version)
    recorded(tools, count, 'REMOVED', [lineId], await lineTotals(tools.tx, countId))
    return { removed: lineId }
  })
  return { removed: lineId }
}

/** inventory.counts.recount: count these lines again (asked again: an earlier recount is replaced, kept in the audit). */
export async function askRecounts(caller: CommandCaller, countId: string, body: { readonly lineIds: readonly string[] }, idempotencyKey?: string): Promise<{ lines: LineView[] }> {
  const context = officeContextOf(caller)
  must(context, INVENTORY_COUNTS_MANAGE, await visibleCount(caller, countId))
  const unique = [...new Set(body.lineIds)]
  await countsCommand(caller, { name: 'inventory.counts.recount', idempotencyKey, input: { countId, lineIds: unique } }, async (tools) => {
    const count = await countingCount(tools.tx, countId)
    const written = await recountInCommand(tools, count, unique, context.actorId, 'body/lineIds')
    recorded(tools, count, 'RECOUNT_ASKED', written, await lineTotals(tools.tx, countId))
    return { lineIds: written }
  })
  return caller.withClient(async (client) => {
    const count = (await readCount(client, countId))!
    const lines = await client.stockCountLine.findMany({ where: { countId, id: { in: unique } }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } })
    return { lines: await lineViews(client, count, lines, context) }
  })
}

async function recountInCommand(tools: CommandTools, count: CountRow, lineIds: readonly string[], askedBy: string, path: string): Promise<string[]> {
  const rows = new Map((await tools.tx.stockCountLine.findMany({ where: { countId: count.id, id: { in: [...lineIds] } }, select: LINE_COLUMNS })).map((row) => [row.id, row]))
  const issues: Issue[] = []
  lineIds.forEach((id, index) => {
    const row = rows.get(id)
    if (!row) issues.push({ path: `${path}/${index}`, message: 'Not a line of this count.' })
    else if (row.countedQuantity === null) issues.push({ path: `${path}/${index}`, message: `Line ${row.seq} is not counted yet; count it first.` })
  })
  if (issues.length > 0) throw new ValidationError(issues.length === 1 ? issues[0]!.message : 'These lines cannot be recounted.', issues)
  const written: string[] = []
  for (const id of lineIds) {
    const row = rows.get(id)!
    await updateLine(tools, row, { recountRequestedAt: tools.now, recountRequestedById: askedBy, recountQuantity: null, recountedAt: null, recountedById: null }, undefined, { action: 'inventory.counts.recount' })
    written.push(id)
  }
  return written
}

// ---- submit, approve, send back, cancel ------------------------------------------------------------------------------------

/** The value of the count's differences now (each line at its unit cost) and whether it needs an approval. */
async function valueOf(tx: CommandTx, count: CountRow, lines: readonly LineRow[]) {
  const company = await tx.company.findUnique({ where: { id: count.companyId }, select: { currency: true } })
  const costs = await unitCostsOf(tx, count.siteId, lines, null)
  const value = differenceValue(
    lines.map((line) => {
      const cost = unitCostOf(costs, line)
      return { ...factsOf(line), unitCost: cost.unitCost, currency: cost.currency }
    }),
    company?.currency ?? 'EUR',
  )
  return { value, required: needsApproval(value) }
}

/** inventory.counts.submit: every line counted, every recount done, every difference with its reason; then valued. */
export async function submitCount(caller: CommandCaller, countId: string, body: { readonly version: number }, idempotencyKey?: string): Promise<CountRecordView> {
  const context = officeContextOf(caller)
  must(context, INVENTORY_COUNTS_MANAGE, await visibleCount(caller, countId))
  await countsCommand(
    caller,
    { name: 'inventory.counts.submit', idempotencyKey, input: { countId, ...body } },
    async (tools) => {
      const row = await lockCount(tools.tx, countId, body.version)
      if (row.status !== 'COUNTING') throw refuse(`Count ${row.number} is ${row.status}.`, 'NOT_COUNTING', 'Only a COUNTING count is submitted.')
      const lines = await readLines(tools.tx, countId)
      const problems = submitProblems(lines.map((line) => ({ ...factsOf(line), seq: line.seq, reasonCode: line.reasonCode })))
      if (problems.length > 0) throw new CountRefusedError(`Count ${row.number} is not ready to submit.`, problems)
      const { value, required } = await valueOf(tools.tx, row, lines)
      const written = await updateCount(tools, row, { status: 'SUBMITTED', submittedAt: tools.now, submittedById: context.actorId, differenceAmount: value.amount, approvalRequired: required })
      changed(tools, written, 'SUBMITTED', row.status, lines.length)
      return { countId }
    },
    true,
  )
  return countRecord(caller, countId)
}

/** inventory.counts.approve: the differences approved; over the limit never by a person who counted one of them. */
export async function approveCount(caller: CommandCaller, countId: string, body: { readonly version: number; readonly note?: string | undefined }, idempotencyKey?: string): Promise<CountRecordView> {
  const context = officeContextOf(caller)
  must(context, INVENTORY_COUNTS_APPROVE, await visibleCount(caller, countId))
  await countsCommand(caller, { name: 'inventory.counts.approve', idempotencyKey, input: { countId, ...body } }, async (tools) => {
    const row = await lockCount(tools.tx, countId, body.version)
    if (row.status !== 'SUBMITTED') throw refuse(`Count ${row.number} is ${row.status}.`, 'NOT_SUBMITTED', 'Only a SUBMITTED count is approved.')
    const lines = await readLines(tools.tx, countId)
    const own = approveProblems(row.approvalRequired, context.actorId, lines.map((line) => ({ ...factsOf(line), seq: line.seq, countedById: line.countedById, recountedById: line.recountedById })))
    if (own.length > 0) throw new CountRefusedError(`You cannot approve count ${row.number}.`, own)
    const written = await updateCount(tools, row, { status: 'APPROVED', approvedAt: tools.now, approvedById: context.actorId, approvalNote: body.note ?? null })
    changed(tools, written, 'APPROVED', row.status, lines.length)
    return { countId }
  })
  return countRecord(caller, countId)
}

/** inventory.counts.sendBack: back to COUNTING with the reason (the submission cleared), lines to recount asked at once. */
export async function sendBack(caller: CommandCaller, countId: string, body: { readonly version: number; readonly reason: string; readonly recountLineIds?: readonly string[] | undefined }, idempotencyKey?: string): Promise<CountRecordView> {
  const context = officeContextOf(caller)
  must(context, INVENTORY_COUNTS_APPROVE, await visibleCount(caller, countId))
  const recount = [...new Set(body.recountLineIds ?? [])]
  await countsCommand(caller, { name: 'inventory.counts.sendBack', idempotencyKey, input: { countId, ...body } }, async (tools) => {
    const row = await lockCount(tools.tx, countId, body.version)
    if (row.status !== 'SUBMITTED') throw refuse(`Count ${row.number} is ${row.status}.`, 'NOT_SUBMITTED', 'Only a SUBMITTED count is sent back.')
    const written = await updateCount(
      tools,
      row,
      { status: 'COUNTING', submittedAt: null, submittedById: null, differenceAmount: null, approvalRequired: true, rejectedAt: tools.now, rejectedById: context.actorId, rejectReason: body.reason },
      { reason: body.reason },
    )
    const asked = recount.length > 0 ? await recountInCommand(tools, written, recount, context.actorId, 'body/recountLineIds') : []
    const totals = await lineTotals(tools.tx, countId)
    changed(tools, written, 'SENT_BACK', row.status, totals.lines)
    recorded(tools, written, 'RECOUNT_ASKED', asked, totals)
    return { countId }
  })
  return countRecord(caller, countId)
}

/** inventory.counts.cancel: before the differences are applied, with the reason. */
export async function cancelCount(caller: CommandCaller, countId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string): Promise<CountRecordView> {
  const context = officeContextOf(caller)
  must(context, INVENTORY_COUNTS_MANAGE, await visibleCount(caller, countId))
  await countsCommand(caller, { name: 'inventory.counts.cancel', idempotencyKey, input: { countId, ...body } }, async (tools) => {
    const row = await lockCount(tools.tx, countId, body.version)
    if (!['DRAFT', 'COUNTING', 'SUBMITTED', 'APPROVED'].includes(row.status)) {
      throw refuse(`Count ${row.number} is ${row.status}.`, 'NOT_CANCELLABLE', row.status === 'CANCELLED' ? 'It is cancelled already.' : 'Its differences are posted; reverse a move in Movements instead.')
    }
    const written = await updateCount(tools, row, { status: 'CANCELLED', cancelledAt: tools.now, cancelReason: body.reason }, { reason: body.reason })
    changed(tools, written, 'CANCELLED', row.status, (await lineTotals(tools.tx, countId)).lines)
    return { countId }
  })
  return countRecord(caller, countId)
}

// ---- apply ------------------------------------------------------------------------------------------------------------------

export interface AppliedMove {
  readonly id: string
  readonly lineId: string
  readonly seq: number
  readonly direction: 'IN' | 'OUT'
  readonly baseQuantity: string
}

/**
 * inventory.counts.apply (inventory.adjust): in ONE command, one COUNT move per line that differs through the ledger's
 * postMoves (into its location for more, out of it for less; its colour, lot and hide; dated at the snapshot; valued as
 * the ledger values them; idempotency key `inventory.count:<count>:<line>`), each line naming its move while the count
 * is APPROVED, then the count APPLIED. A SUBMITTED count under the approval limit is approved by the same command.
 */
export async function applyCount(caller: CommandCaller, countId: string, body: { readonly version: number; readonly periodLockOverride?: PeriodLockOverride | undefined }, idempotencyKey?: string): Promise<{ count: CountRecordView; moves: AppliedMove[] }> {
  const context = officeContextOf(caller)
  must(context, INVENTORY_ADJUST, await visibleCount(caller, countId), 'Posting a count\'s differences needs inventory.adjust.')
  const { result } = await countsCommand(
    caller,
    { name: 'inventory.counts.apply', idempotencyKey, input: { countId, ...body } },
    async (tools) => {
      let row = await lockCount(tools.tx, countId, body.version)
      let approvedWithApply = false
      if (row.status === 'SUBMITTED' && !row.approvalRequired) {
        row = await updateCount(tools, row, { status: 'APPROVED', approvedAt: tools.now, approvedById: context.actorId }, { action: 'inventory.counts.approve', reason: 'Under the approval limit: approved with the apply.' })
        approvedWithApply = true
      } else if (row.status === 'SUBMITTED') {
        throw refuse(`Count ${row.number} waits for its approval.`, 'NOT_APPROVED', 'Its differences are over the approval limit: a person who did not count them approves them first.')
      } else if (row.status !== 'APPROVED') {
        throw refuse(`Count ${row.number} is ${row.status}.`, 'NOT_APPROVED', 'A count is applied once it is approved.')
      }
      const lines = await readLines(tools.tx, countId)
      const differing = lines.filter((line) => differs(factsOf(line)))
      const drafts: MoveDraft[] = differing.map((line) => {
        const planned = plannedMoveOf({ ...factsOf(line), locationId: line.locationId })!
        return {
          siteId: row.siteId,
          reason: 'COUNT',
          itemId: line.itemId,
          itemColourId: line.itemColourId,
          lotId: line.lotId,
          hideId: line.hideId,
          fromLocationId: planned.fromLocationId,
          toLocationId: planned.toLocationId,
          quantity: planned.baseQuantity,
          note: countMoveNote(row.number, line.seq, line.reasonCode, line.reasonNote),
          reference: row.number,
          occurredAt: row.snapshotAt!,
          idempotencyKey: `inventory.count:${countId}:${line.seq}`,
        }
      })
      const posted: PostedMove[] = []
      for (let start = 0; start < drafts.length; start += 500) {
        const chunk = drafts.slice(start, start + 500)
        posted.push(
          ...(await postMoves(tools, chunk, {
            issuePath: (index) => `lines/${differing[start + index]!.seq}`,
            periodLockOverride: body.periodLockOverride,
          })),
        )
      }
      const moves: AppliedMove[] = []
      for (const [index, line] of differing.entries()) {
        const move = posted[index]!
        await updateLine(tools, line, { moveId: move.id }, undefined, { action: 'inventory.counts.apply' })
        moves.push({ id: move.id, lineId: line.id, seq: line.seq, direction: move.fromLocationId ? 'OUT' : 'IN', baseQuantity: move.baseQuantity })
      }
      const written = await updateCount(tools, row, { status: 'APPLIED', appliedAt: tools.now, appliedById: context.actorId })
      tools.emit({
        type: 'inventory.count_applied',
        subject: written.id,
        companyId: written.companyId,
        siteId: written.siteId,
        payload: { countId: written.id, number: written.number, kind: written.kind, approvedWithApply, moveIds: moves.map((move) => move.id), differences: moves.length, snapshotAt: toUtcIso(written.snapshotAt!) },
      })
      return { countId, moves }
    },
    true,
  )
  return { count: await countRecord(caller, countId), moves: result.moves }
}

// ---- the year-end sign-off --------------------------------------------------------------------------------------------------

const TEN_YEARS_MS = 10 * 366 * 24 * 60 * 60 * 1000

/**
 * inventory.counts.signOff (+ the cost grain): an APPLIED year-end inventory, its number typed. The valued list (PDF and
 * XLSX) is made and put in the store first, outside any transaction; then ONE command on the locked count records both
 * files (the PDF in the fiscal archive, ten years; the sheet a document kept as long, c.c. art. 2220) and signs the count
 * off naming the PDF. A put whose command fails leaves objects no row names (removed by a later sweep).
 */
export async function signOffCount(caller: CommandCaller, countId: string, body: { readonly version: number; readonly phrase: string; readonly language?: DocumentLanguage | undefined }, idempotencyKey?: string): Promise<CountRecordView> {
  const context = officeContextOf(caller)
  const row = await visibleCount(caller, countId)
  must(context, INVENTORY_COUNTS_SIGNOFF, row)
  if (!seesCost(context)) throw new ForbiddenError('The valued list is a cost document: signing it off needs the cost grain.')
  const spec = { name: 'inventory.counts.signOff' as const, idempotencyKey, input: { countId, ...body } }
  if (row.status === 'SIGNED_OFF' && idempotencyKey) {
    // A repeated request answers from its receipt; anything else is refused in the command.
    await countsCommand(caller, spec, async () => {
      throw new CountRefusedError(`Inventory ${row.number} cannot be signed off.`, signOffProblems(row, body.phrase))
    })
    return countRecord(caller, countId)
  }
  if (row.version !== body.version) throw new StaleVersionError('StockCount', countId, row.version, body.version)
  const problems = signOffProblems(row, body.phrase)
  if (problems.length === 1 && problems[0]!.code === 'PHRASE') throw new ValidationError(problems[0]!.message, [{ path: 'body/phrase', message: problems[0]!.message }])
  if (problems.length > 0) throw new CountRefusedError(`Inventory ${row.number} cannot be signed off.`, problems)
  const at = clock.now()
  const me = (await caller.withClient((client) => peopleNames(client, [context.actorId]))).get(context.actorId) ?? ''
  const files = await valuedListFiles(caller, row, { language: body.language ?? 'it', preview: false, signedOff: { at, by: me }, at })
  const runtime = processFiles()
  const pdf = await putGeneratedFile(runtime, caller, { companyId: row.companyId, recordType: 'StockCount', recordId: row.id, kind: 'FISCAL_ARCHIVE', originalName: files.pdfName, contentType: 'application/pdf', body: files.pdf })
  const sheet = await putGeneratedFile(runtime, caller, {
    companyId: row.companyId,
    recordType: 'StockCount',
    recordId: row.id,
    kind: 'DOCUMENT',
    originalName: files.sheetName,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    body: files.sheet,
    retainUntil: new Date(at.getTime() + TEN_YEARS_MS),
  })
  await countsCommand(caller, spec, async (tools) => {
    const locked = await lockCount(tools.tx, countId, body.version)
    const again = signOffProblems(locked, body.phrase)
    if (again.length > 0) throw new CountRefusedError(`Inventory ${locked.number} cannot be signed off.`, again)
    const details = { document: 'VALUED_LIST', number: locked.number, rows: files.list.rows.length }
    const pdfFile = await recordGeneratedFile(tools, pdf, { action: 'inventory.counts.valuedList', details: { ...details, format: 'pdf' } })
    const sheetFile = await recordGeneratedFile(tools, sheet, { action: 'inventory.counts.valuedList', details: { ...details, format: 'xlsx' } })
    const written = await updateCount(tools, locked, { status: 'SIGNED_OFF', signedOffAt: tools.now, signedOffById: context.actorId, valuedListFileId: pdfFile.id })
    tools.emit({
      type: 'inventory.count_signed_off',
      subject: written.id,
      companyId: written.companyId,
      siteId: written.siteId,
      payload: { countId: written.id, number: written.number, inventoryDate: dayOf(written.inventoryDate)!, valuedListFileId: pdfFile.id, valuedListSheetFileId: sheetFile.id, rows: files.list.rows.length },
    })
    return { countId }
  })
  return countRecord(caller, countId)
}

/** The valued list before the sign-off (a preview, with a banner, stored nowhere): a year-end inventory from SUBMITTED on. */
export async function previewValuedList(caller: CommandCaller, countId: string, format: 'pdf' | 'xlsx', language: DocumentLanguage | undefined): Promise<{ body: Buffer; fileName: string; contentType: string }> {
  const context = officeContextOf(caller)
  const row = await visibleCount(caller, countId)
  if (!seesCost(context)) throw new ForbiddenError('The valued list shows costs: it needs the cost grain.')
  if (row.kind !== 'YEAR_END') throw refuse(`Count ${row.number} is a cycle count.`, 'NOT_YEAR_END', 'Only a year-end inventory has a valued list.')
  if (row.status === 'SIGNED_OFF') throw refuse(`Inventory ${row.number} is signed off.`, 'SIGNED_OFF', 'Its valued list is frozen: download its files from the count.')
  if (!['SUBMITTED', 'APPROVED', 'APPLIED'].includes(row.status)) throw refuse(`Inventory ${row.number} is ${row.status}.`, 'NOT_SUBMITTED', 'The valued list is made once every line is counted and the count is submitted.')
  const at = clock.now()
  const files = await valuedListFiles(caller, row, { language: language ?? 'it', preview: true, signedOff: null, at })
  return format === 'pdf'
    ? { body: files.pdf, fileName: files.pdfName, contentType: 'application/pdf' }
    : { body: files.sheet, fileName: files.sheetName, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
}

/** The count sheets (PDF, stored nowhere): from COUNTING on, with or without the expected quantities. */
export async function countSheets(caller: CommandCaller, countId: string, withExpected: boolean, language: DocumentLanguage | undefined) {
  const row = await visibleCount(caller, countId)
  if (row.status === 'DRAFT') throw refuse(`Count ${row.number} is a DRAFT.`, 'NOT_STARTED', 'Its sheets are printed once it is started (the expected quantities frozen).')
  if (row.status === 'CANCELLED') throw refuse(`Count ${row.number} is cancelled.`, 'CANCELLED', 'A cancelled count has no sheets to print.')
  return countSheetsPdf(caller, row, { withExpected, language: language ?? 'it', at: clock.now() })
}

