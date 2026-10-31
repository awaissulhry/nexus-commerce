import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { INVENTORY_ADJUST } from '@nexus/factory-domain/inventory/permissions'
import {
  INVENTORY_COUNTS_APPROVE,
  INVENTORY_COUNTS_MANAGE,
  INVENTORY_COUNTS_SIGNOFF,
  INVENTORY_COUNTS_VIEW,
} from '@nexus/factory-domain/inventory/counts/permissions'
import {
  approveProblems,
  COUNT_RULES,
  countListViewFilter,
  differenceOf,
  differencePercent,
  differenceValue,
  differs,
  finalCount,
  lineStatus,
  lineValue,
  needsApproval,
  plannedMoveOf,
  recountSuggested,
  snapshotFor,
  submitProblems,
  type CountListView,
  type LineFacts,
} from '@nexus/factory-domain/inventory/counts/rules'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { seesCost } from '../ledger/access'
import type { CountRecordView, CountView, LineView } from './contract'
import { movedSince, siteLocations, unitCostOf, unitCostsOf, type LocationNode } from './ledger-at'
import { LINE_COLUMNS, readLines, type CountRow, type LineRow } from './store'

/**
 * The counts' views (B-W2a-15): a count as the list shows it, its record (summary, approval, what the caller may do)
 * and its lines (expected, counted, difference, the COUNT move, the worth with the cost grain). Read only; names come
 * with the rows they belong to, never a figure per person.
 */

type Client = FactoryClient | CommandTx

export const COUNT_SCOPE = { company: 'companyId', site: 'siteId' } as const
export const scopeOf = (row: { readonly companyId: string; readonly siteId: string }) => ({ companyId: row.companyId, siteId: row.siteId })

const iso = (value: Date | null): string | null => (value ? toUtcIso(value) : null)
const day = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null)
const text = (value: Prisma.Decimal | null): string | null => (value === null ? null : value.toFixed(4))

export const factsOf = (line: Pick<LineRow, 'expectedQuantity' | 'countedQuantity' | 'recountRequestedAt' | 'recountQuantity'>): LineFacts => ({
  expected: line.expectedQuantity.toString(),
  counted: line.countedQuantity === null ? null : line.countedQuantity.toString(),
  recountRequested: line.recountRequestedAt !== null,
  recount: line.recountQuantity === null ? null : line.recountQuantity.toString(),
})

export async function peopleNames(client: Client, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((id): id is string => typeof id === 'string'))]
  if (wanted.length === 0) return new Map()
  return new Map((await client.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]))
}

interface Aggregate {
  readonly all: number
  readonly counted: number
  readonly differing: number
}

/** Lines, counted lines and lines that differ, per count (one query). */
async function aggregatesOf(client: Client, countIds: readonly string[]): Promise<Map<string, Aggregate>> {
  if (countIds.length === 0) return new Map()
  const rows = await client.$queryRaw<{ countId: string; all: number; counted: number; differing: number }[]>`
    SELECT "countId"::text AS "countId", count(*)::int AS "all", count("countedQuantity")::int AS "counted",
           count(*) FILTER (WHERE coalesce("recountQuantity", "countedQuantity") IS NOT NULL
                              AND coalesce("recountQuantity", "countedQuantity") <> "expectedQuantity")::int AS "differing"
      FROM "StockCountLine" WHERE "countId" = ANY(${[...countIds]}::uuid[]) GROUP BY "countId"`
  return new Map(rows.map((row) => [row.countId, { all: row.all, counted: row.counted, differing: row.differing }]))
}

/** The counts as the list shows them (their site, scope and line figures read in a few queries; no person's name). */
export async function countViews(client: Client, rows: readonly CountRow[]): Promise<CountView[]> {
  if (rows.length === 0) return []
  const ids = (pick: (row: CountRow) => string | null) => [...new Set(rows.map(pick).filter((id): id is string => id !== null))]
  const sites = await client.site.findMany({ where: { id: { in: ids((row) => row.siteId) } }, select: { id: true, code: true, name: true } })
  const companies = await client.company.findMany({ where: { id: { in: ids((row) => row.companyId) } }, select: { id: true, currency: true } })
  const items = await client.item.findMany({ where: { id: { in: ids((row) => row.itemId) } }, select: { id: true, code: true, name: true } })
  const lots = await client.lot.findMany({ where: { id: { in: ids((row) => row.lotId) } }, select: { id: true, code: true } })
  const locationRows = await client.location.findMany({ where: { id: { in: ids((row) => row.locationId) } }, select: { siteId: true, id: true } })
  const trees = new Map<string, Map<string, LocationNode>>()
  for (const siteId of new Set(locationRows.map((row) => row.siteId))) trees.set(siteId, await siteLocations(client, siteId))
  const sheets = await client.storedFile.findMany({
    where: { recordType: 'StockCount', recordId: { in: rows.filter((row) => row.valuedListFileId).map((row) => row.id) }, status: 'AVAILABLE', id: { notIn: ids((row) => row.valuedListFileId) } },
    select: { id: true, recordId: true },
    orderBy: { createdAt: 'desc' },
  })
  const aggregates = await aggregatesOf(client, rows.map((row) => row.id))
  const site = new Map(sites.map((row) => [row.id, row]))
  const currency = new Map(companies.map((row) => [row.id, row.currency]))
  const item = new Map(items.map((row) => [row.id, row]))
  const lot = new Map(lots.map((row) => [row.id, row]))
  const sheet = new Map<string, string>()
  for (const file of sheets) if (!sheet.has(file.recordId)) sheet.set(file.recordId, file.id)
  return rows.map((row) => {
    const location = row.locationId ? trees.get(row.siteId)?.get(row.locationId) : undefined
    const lines = aggregates.get(row.id) ?? { all: 0, counted: 0, differing: 0 }
    const siteRow = site.get(row.siteId)
    return {
      id: row.id,
      number: row.number,
      kind: row.kind,
      status: row.status,
      companyId: row.companyId,
      site: { id: row.siteId, code: siteRow?.code ?? '', name: siteRow?.name ?? '' },
      scope: {
        location: location ? { id: location.id, code: location.code, name: location.name, path: location.path } : null,
        item: row.itemId ? { id: row.itemId, code: item.get(row.itemId)?.code ?? '', name: item.get(row.itemId)?.name ?? '' } : null,
        lot: row.lotId ? { id: row.lotId, code: lot.get(row.lotId)?.code ?? '' } : null,
        itemKind: row.itemKind,
      },
      inventoryDate: day(row.inventoryDate),
      countTeam: row.countTeam,
      note: row.note,
      startedAt: iso(row.startedAt),
      snapshotAt: iso(row.snapshotAt),
      submittedAt: iso(row.submittedAt),
      approvalRequired: row.submittedAt ? row.approvalRequired : null,
      differenceAmount: asMoney('cost', row.differenceAmount),
      currency: currency.get(row.companyId) ?? 'EUR',
      approvedAt: iso(row.approvedAt),
      approvalNote: row.approvalNote,
      rejectedAt: iso(row.rejectedAt),
      rejectReason: row.rejectReason,
      appliedAt: iso(row.appliedAt),
      signedOffAt: iso(row.signedOffAt),
      valuedList: row.valuedListFileId ? { pdfFileId: row.valuedListFileId, sheetFileId: sheet.get(row.id) ?? null } : null,
      cancelledAt: iso(row.cancelledAt),
      cancelReason: row.cancelReason,
      lines,
      version: row.version,
      createdAt: toUtcIso(row.createdAt),
      updatedAt: toUtcIso(row.updatedAt),
    }
  })
}

// ---- one count's record -------------------------------------------------------------------------------------------------

type Action = { allowed: boolean; reason: string | null }
const yes: Action = { allowed: true, reason: null }
const no = (reason: string): Action => ({ allowed: false, reason })

/** What the count's lines add up to now, and what the caller may do with it. */
export async function recordView(client: Client, row: CountRow, context: OfficeContext, now: Date): Promise<CountRecordView> {
  const [view] = await countViews(client, [row])
  const lines = await readLines(client, row.id)
  const costs = await unitCostsOf(client, row.siteId, lines, null)
  const moved = row.snapshotAt && (row.status === 'COUNTING' || row.status === 'SUBMITTED' || row.status === 'APPROVED') ? await movedSince(client, row.siteId, lines, row.snapshotAt) : new Set<string>()
  const facts = lines.map((line) => ({ ...factsOf(line), seq: line.seq, reasonCode: line.reasonCode, countedById: line.countedById, recountedById: line.recountedById, hideId: line.hideId }))
  const valued = lines.map((line, index) => {
    const cost = unitCostOf(costs, line)
    return { ...facts[index]!, unitCost: cost.unitCost, currency: cost.currency }
  })
  const value = differenceValue(valued, view!.currency)
  const statuses = facts.map((line) => lineStatus(line))
  const submittedNow = row.submittedAt !== null
  const required = submittedNow ? row.approvalRequired : needsApproval(value)
  const actor = actorOf(context)
  const allowedTo = (permission: Parameters<typeof can>[1]) => can(actor, permission, scopeOf(row))
  const manage = allowedTo(INVENTORY_COUNTS_MANAGE)
  const approve = allowedTo(INVENTORY_COUNTS_APPROVE)
  const own = approveProblems(required, context.actorId, facts)
  const held = row.status !== 'SUBMITTED' ? 'NOT_SUBMITTED' : !approve ? 'NO_RIGHT' : own.length > 0 ? 'OWN_VARIANCE' : null
  const heldReason =
    held === 'NOT_SUBMITTED' ? 'The count is approved once it is submitted.' : held === 'NO_RIGHT' ? 'Approving needs inventory.counts.approve.' : held === 'OWN_VARIANCE' ? own[0]!.message : null
  const blocked = submitProblems(facts)
  const noManage = 'Needs inventory.counts.manage.'
  const live = ['DRAFT', 'COUNTING', 'SUBMITTED', 'APPROVED'].includes(row.status)
  const start = (() => {
    if (row.status !== 'DRAFT') return no('Only a DRAFT count is started.')
    if (!manage) return no(noManage)
    const snapshot = snapshotFor(row.kind, day(row.inventoryDate), now)
    return snapshot.problem ? no(snapshot.problem) : yes
  })()
  const applyAction = (() => {
    if (!(row.status === 'APPROVED' || (row.status === 'SUBMITTED' && !row.approvalRequired))) {
      return no(row.status === 'SUBMITTED' ? 'The differences wait for their approval.' : 'A count is applied once it is approved.')
    }
    return allowedTo(INVENTORY_ADJUST) ? yes : no('Posting the differences needs inventory.adjust.')
  })()
  const signOffAction = (() => {
    if (row.kind !== 'YEAR_END') return no('Only a year-end inventory is signed off.')
    if (row.status !== 'APPLIED') return no(row.status === 'SIGNED_OFF' ? 'Signed off already.' : 'It is signed off once its differences are applied.')
    if (!allowedTo(INVENTORY_COUNTS_SIGNOFF)) return no('Signing off needs inventory.counts.signoff.')
    return seesCost(context) ? yes : no('The valued list is a cost document: signing it off needs the cost grain.')
  })()
  const names = await peopleNames(client, [row.createdById, row.submittedById, row.approvedById, row.rejectedById, row.appliedById, row.signedOffById])
  const name = (id: string | null) => (id ? (names.get(id) ?? null) : null)
  return {
    ...view!,
    people: {
      createdBy: name(row.createdById),
      submittedBy: name(row.submittedById),
      approvedBy: name(row.approvedById),
      rejectedBy: name(row.rejectedById),
      appliedBy: name(row.appliedById),
      signedOffBy: name(row.signedOffById),
    },
    summary: {
      lines: lines.length,
      counted: statuses.filter((status) => status !== 'UNCOUNTED').length,
      uncounted: statuses.filter((status) => status === 'UNCOUNTED').length,
      recountsDue: statuses.filter((status) => status === 'RECOUNT_DUE').length,
      differing: value.lines,
      unreasoned: facts.filter((line, index) => statuses[index] === 'COUNTED' && differs(line) && !line.reasonCode).length,
      recountSuggested: facts.filter((line) => recountSuggested(line)).length,
      movedSinceSnapshot: moved.size,
      differenceAmount: asMoney('cost', submittedNow && row.differenceAmount !== null ? row.differenceAmount : value.amount),
      unvalued: value.unvalued + value.otherCurrency,
    },
    approval: {
      required,
      limitAmount: asMoney('cost', COUNT_RULES.approvalLimitMinor),
      mayApprove: held === null,
      held,
      heldReason,
    },
    actions: {
      edit: row.status === 'DRAFT' || row.status === 'COUNTING' ? (manage ? yes : no(noManage)) : no('Only a DRAFT or COUNTING count is edited.'),
      start,
      record: row.status === 'COUNTING' ? (manage ? yes : no(noManage)) : no('Lines are counted while the count is COUNTING.'),
      submit: row.status !== 'COUNTING' ? no('Only a COUNTING count is submitted.') : !manage ? no(noManage) : blocked.length > 0 ? no(blocked.map((problem) => problem.message).join(' ')) : yes,
      approve: held === null ? yes : no(heldReason!),
      sendBack: row.status !== 'SUBMITTED' ? no('Only a SUBMITTED count is sent back.') : approve ? yes : no('Sending back needs inventory.counts.approve.'),
      apply: applyAction,
      signOff: signOffAction,
      cancel: !live ? no(`A ${row.status} count is not cancelled.`) : manage ? yes : no(noManage),
    },
  }
}

// ---- lines ----------------------------------------------------------------------------------------------------------------

/** The lines' views: names, what was counted, the difference, its move and (with the cost grain) its worth. */
export async function lineViews(client: Client, count: CountRow, lines: readonly LineRow[], context: OfficeContext): Promise<LineView[]> {
  if (lines.length === 0) return []
  const ids = (pick: (line: LineRow) => string | null) => [...new Set(lines.map(pick).filter((id): id is string => id !== null))]
  const items = await client.item.findMany({ where: { id: { in: ids((line) => line.itemId) } }, select: { id: true, code: true, name: true, kind: true, tracking: true, baseUom: true } })
  const locations = await client.location.findMany({ where: { id: { in: ids((line) => line.locationId) } }, select: { id: true, code: true, name: true } })
  const colours = await client.itemColour.findMany({ where: { id: { in: ids((line) => line.itemColourId) } }, select: { id: true, code: true, name: true } })
  const lots = await client.lot.findMany({ where: { id: { in: ids((line) => line.lotId) } }, select: { id: true, code: true } })
  const hides = await client.hide.findMany({ where: { id: { in: ids((line) => line.hideId) } }, select: { id: true, code: true, baseArea: true } })
  const withCost = seesCost(context)
  const costs = withCost ? await unitCostsOf(client, count.siteId, lines, null) : new Map()
  const moved = count.snapshotAt && (count.status === 'COUNTING' || count.status === 'SUBMITTED' || count.status === 'APPROVED') ? await movedSince(client, count.siteId, lines, count.snapshotAt) : new Set<string>()
  const posted = await client.stockMove.findMany({ where: { id: { in: ids((line) => line.moveId) } }, select: { id: true, fromLocationId: true, baseQuantity: true } })
  const item = new Map(items.map((row) => [row.id, row]))
  const location = new Map(locations.map((row) => [row.id, row]))
  const colour = new Map(colours.map((row) => [row.id, row]))
  const lot = new Map(lots.map((row) => [row.id, row]))
  const hide = new Map(hides.map((row) => [row.id, row]))
  const move = new Map(posted.map((row) => [row.id, row]))
  return lines.map((line) => {
    const facts = factsOf(line)
    const final = finalCount(facts)
    const difference = differenceOf(facts)
    const planned = plannedMoveOf({ ...facts, locationId: line.locationId })
    const postedMove = line.moveId ? move.get(line.moveId) : undefined
    const itemRow = item.get(line.itemId)
    const hideRow = line.hideId ? hide.get(line.hideId) : undefined
    const cost = withCost ? unitCostOf(costs, line) : null
    return {
      id: line.id,
      seq: line.seq,
      location: { id: line.locationId, code: location.get(line.locationId)?.code ?? '', name: location.get(line.locationId)?.name ?? '' },
      item: { id: line.itemId, code: itemRow?.code ?? '', name: itemRow?.name ?? '', kind: itemRow?.kind ?? '', tracking: itemRow?.tracking ?? 'NONE', uom: itemRow?.baseUom ?? 'PCS' },
      colour: line.itemColourId ? { id: line.itemColourId, code: colour.get(line.itemColourId)?.code ?? '', name: colour.get(line.itemColourId)?.name ?? '' } : null,
      lot: line.lotId ? { id: line.lotId, code: lot.get(line.lotId)?.code ?? '' } : null,
      hide: line.hideId ? { id: line.hideId, code: hideRow?.code ?? '', area: hideRow ? hideRow.baseArea.toFixed(4) : '0.0000' } : null,
      origin: line.origin,
      expected: line.expectedQuantity.toFixed(4),
      counted: text(line.countedQuantity),
      countedAt: iso(line.countedAt),
      countedByYou: line.countedById === context.actorId || line.recountedById === context.actorId,
      recount: line.recountRequestedAt ? { requestedAt: toUtcIso(line.recountRequestedAt), quantity: text(line.recountQuantity), at: iso(line.recountedAt) } : null,
      final: final === null ? null : quantityText(final),
      difference: difference === null ? null : quantityText(difference),
      percent: differencePercent(facts),
      status: lineStatus(facts),
      recountSuggested: recountSuggested({ ...facts, hideId: line.hideId }),
      reasonCode: line.reasonCode,
      reasonNote: line.reasonNote,
      move: postedMove
        ? { id: postedMove.id, direction: postedMove.fromLocationId ? ('OUT' as const) : ('IN' as const), baseQuantity: postedMove.baseQuantity.toFixed(4) }
        : planned
          ? { id: null, direction: planned.direction, baseQuantity: planned.baseQuantity }
          : null,
      unitCost: asMoney('cost', cost?.unitCost ?? null),
      differenceAmount: asMoney('cost', cost ? lineValue(facts, cost.unitCost, cost.currency) : null),
      movedSinceSnapshot: moved.has(line.id),
      version: line.version,
    }
  })
}

export const LINE_FILTER_WHERE: Readonly<Record<string, Prisma.StockCountLineWhereInput>> = Object.freeze({
  all: {},
  uncounted: { countedQuantity: null },
  recount: { recountRequestedAt: { not: null }, recountQuantity: null },
  added: { origin: 'ADDED' },
})

/** A page of lines by filter; "differs" is decided on the decimals (the page reads on until it is full). */
export async function pageOfLines(client: Client, countId: string, query: { readonly filter: string; readonly locationId?: string | undefined; readonly q?: string | undefined; readonly cursor?: number | undefined; readonly limit: number }): Promise<{ lines: LineRow[]; nextCursor: number | null }> {
  const where: Prisma.StockCountLineWhereInput = {
    AND: [
      LINE_FILTER_WHERE[query.filter] ?? {},
      query.locationId ? { locationId: query.locationId } : {},
      query.q
        ? {
            OR: [
              { item: { code: { contains: query.q, mode: 'insensitive' } } },
              { item: { name: { contains: query.q, mode: 'insensitive' } } },
              { lot: { code: { contains: query.q, mode: 'insensitive' } } },
              { hide: { code: { contains: query.q, mode: 'insensitive' } } },
            ],
          }
        : {},
      query.filter === 'differs' ? { countedQuantity: { not: null } } : {},
    ],
  }
  const found: LineRow[] = []
  let after = query.cursor
  for (;;) {
    const batch = await client.stockCountLine.findMany({
      where: { AND: [{ countId }, where, after !== undefined ? { seq: { gt: after } } : {}] },
      select: LINE_COLUMNS,
      orderBy: { seq: 'asc' },
      take: query.limit + 1,
    })
    for (const line of query.filter === 'differs' ? batch.filter((row) => differs(factsOf(row))) : batch) found.push(line)
    if (found.length > query.limit) return { lines: found.slice(0, query.limit), nextCursor: found[query.limit - 1]!.seq }
    if (batch.length <= query.limit) return { lines: found, nextCursor: null }
    after = batch[batch.length - 1]!.seq
  }
}

/** The counts the caller may see, newest first (UUIDv7 ids), with the list's filters. */
export function listWhere(
  context: OfficeContext,
  query: { readonly siteId?: string | undefined; readonly status?: string | undefined; readonly kind?: string | undefined; readonly open?: string | undefined; readonly view?: CountListView | undefined; readonly q?: string | undefined },
): Prisma.StockCountWhereInput {
  return {
    AND: [
      scopeWhere(actorOf(context), INVENTORY_COUNTS_VIEW, COUNT_SCOPE) as Prisma.StockCountWhereInput,
      query.siteId ? { siteId: query.siteId } : {},
      // B-W2b-15: the tiles' saved rows (waiting for approval, to apply), filtered here as the tiles count them.
      query.view ? { OR: countListViewFilter(query.view) } : {},
      query.status ? { status: query.status as CountRow['status'] } : {},
      query.kind ? { kind: query.kind as CountRow['kind'] } : {},
      query.open === 'true' ? { OR: [{ status: { in: ['DRAFT', 'COUNTING', 'SUBMITTED', 'APPROVED'] } }, { status: 'APPLIED', kind: 'YEAR_END' }] } : {},
      query.q
        ? { OR: [{ number: { contains: query.q, mode: 'insensitive' } }, { countTeam: { contains: query.q, mode: 'insensitive' } }, { note: { contains: query.q, mode: 'insensitive' } }] }
        : {},
    ],
  }
}
