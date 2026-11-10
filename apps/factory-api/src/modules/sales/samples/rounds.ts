import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayStart, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { markMoney } from '@nexus/factory-domain/money/marked'
import type { CancelRoundBody, CreateRoundBody, MoveRoundBody, RoundListQuery, RoundView, UpdateRoundBody } from '@nexus/factory-domain/sales/samples/contracts'
import { SALES_SAMPLES_MANAGE, SALES_SAMPLES_VIEW } from '@nexus/factory-domain/sales/samples/permissions'
import {
  BOARD_LANES,
  cancelRefusal,
  cellsProblems,
  chargeRefusal,
  MANUAL_STAGES,
  nextRoundNo,
  noRevisionRefusal,
  revisionRefusal,
  ROUND_TILES,
  roundEditRefusal,
  stageMoveRefusal,
  storedCells,
  styleRefusal,
  testZonesRefusal,
  type RoundTile,
  type SampleCell,
  type SampleKind,
  type SampleStage,
} from '@nexus/factory-domain/sales/samples/rules'
import { relativeRange } from '@nexus/factory-domain/views/quick/relative'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { followInCommand } from '../../../platform/threads/followers'
import { asDay, badBody, databaseRefusal, dayOrNull, may, officeOf, officeRound, readRoundRow, refuse, ROUND_COLUMNS, roundRowsOf, roundViewOf, type Reader, type RoundData } from './store'

/**
 * Sample rounds (B-W2b-246; SAL-311; design products.samples SCR-110: the tiles, the board and the list, "New sample request",
 * "Move to…", the round's Request tab). The sample work order is ./work-orders.ts, the shipments ./shipments.ts; the decision is
 * B-W2b-252's.
 *
 *   GET   /sales/samples/rounds                 sales.samples.view: the rounds the caller may see (company, customer), with the
 *                                               tiles (open, due this week, late, waiting for the customer's decision, rejected
 *                                               this month, all) and the board's lanes counted under the filters
 *   GET   /sales/samples/rounds/:roundId        the record: the request, its work orders, its shipments, the decision as recorded,
 *                                               the moves and actions allowed now (else the refusal in words)
 *   POST  /sales/samples/rounds                 sales.samples.manage: ask for a round (numbered SR-…; its maker follows it)
 *   PATCH /sales/samples/rounds/:roundId        the request while open (the revision only while REQUESTED)
 *   POST  /sales/samples/rounds/:roundId/move   one of the four manual stages (never DECIDED: the decision does it)
 *   POST  /sales/samples/rounds/:roundId/cancel CANCELLED with why
 *
 * Each write is ONE command on the round at the version the caller read; the charge (a price) is marked in the audit rows.
 */

const LIST_LIMIT = 100

const todayNow = (): BusinessDate => businessDate(serverClock.now())
const authorOf = (tools: CommandTools): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

export async function readRound(caller: CommandCaller, roundId: string): Promise<RoundView> {
  const { context, round } = await officeRound(caller, roundId)
  return caller.withClient((db) => roundViewOf(db, context, round, todayNow()))
}

// ---- the list ----------------------------------------------------------------------------------------------------------

/** The filters but the tile and the stage, over what the caller may see. */
function baseWhere(context: OfficeContext, query: RoundListQuery): Prisma.SampleRoundWhereInput {
  const q = query.q?.trim()
  return {
    AND: [
      scopeWhere(actorOf(context), SALES_SAMPLES_VIEW, { company: 'companyId', party: { field: 'partyId', nullable: true } }) as Prisma.SampleRoundWhereInput,
      query.kind ? { kind: query.kind } : {},
      query.styleId ? { styleId: query.styleId } : {},
      query.revisionId ? { revisionId: query.revisionId } : {},
      query.partyId ? { partyId: query.partyId } : {},
      query.internal === true ? { partyId: null } : query.internal === false ? { partyId: { not: null } } : {},
      query.companyId ? { companyId: query.companyId } : {},
      query.dueFrom || query.dueTo ? { dueDate: { ...(query.dueFrom ? { gte: asDay(query.dueFrom) } : {}), ...(query.dueTo ? { lte: asDay(query.dueTo) } : {}) } } : {},
      q
        ? {
            OR: [
              { number: { contains: q, mode: 'insensitive' } },
              { style: { code: { contains: q, mode: 'insensitive' } } },
              { style: { name: { contains: q, mode: 'insensitive' } } },
              { party: { code: { contains: q, mode: 'insensitive' } } },
              { party: { legalName: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {},
    ],
  }
}

const OPEN: Prisma.SampleRoundWhereInput = { stage: { in: [...MANUAL_STAGES] } }

/** A tile's saved filter (SCR-110 "Saved-filter tiles"), today in Europe/Rome. */
function tileWhere(tile: RoundTile, today: BusinessDate): Prisma.SampleRoundWhereInput {
  switch (tile) {
    case 'OPEN':
      return OPEN
    case 'DUE_THIS_WEEK': {
      const week = relativeRange('this-week', today)
      return { AND: [OPEN, { dueDate: { gte: asDay(week.from!), lte: asDay(week.to!) } }] }
    }
    case 'LATE':
      return { AND: [OPEN, { dueDate: { lt: asDay(today) } }] }
    case 'WAITING_DECISION':
      return { stage: 'UNDER_REVIEW', partyId: { not: null } }
    case 'REJECTED_THIS_MONTH': {
      const month = relativeRange('this-month', today)
      const next = new Date(asDay(month.to!).getTime() + 86_400_000).toISOString().slice(0, 10)
      return { decision: 'REJECTED', decidedAt: { gte: businessDayStart(month.from!), lt: businessDayStart(next) } }
    }
    case 'ALL':
      return {}
  }
}

/** GET /sales/samples/rounds: the earliest due first (none last), then the newest. */
export async function listRounds(caller: CommandCaller, query: RoundListQuery) {
  const context = officeOf(caller)
  const today = todayNow()
  const tile = query.tile ?? 'ALL'
  const limit = query.limit ?? LIST_LIMIT
  const base = baseWhere(context, query)
  const stage = query.stage ? { stage: query.stage } : {}
  return caller.withClient(async (db) => {
    const rows = await db.sampleRound.findMany({
      where: { AND: [base, tileWhere(tile, today), stage] },
      select: ROUND_COLUMNS,
      orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    })
    const counts = {} as Record<RoundTile, number>
    for (const each of ROUND_TILES) counts[each] = await db.sampleRound.count({ where: { AND: [base, tileWhere(each, today), stage] } })
    const byStage = await db.sampleRound.groupBy({ by: ['stage'], where: { AND: [base, tileWhere(tile, today)] }, _count: { _all: true } })
    return {
      rows: await roundRowsOf(db, rows.slice(0, limit), today),
      counts,
      lanes: BOARD_LANES.map((lane) => ({ stage: lane, count: byStage.find((row) => row.stage === lane)?._count._all ?? 0 })),
      complete: rows.length <= limit,
    }
  })
}

// ---- what a request names ------------------------------------------------------------------------------------------------

const STYLE_COLUMNS = { id: true, code: true, name: true, companyId: true, sizes: true, status: true, lifecycle: true } as const satisfies Prisma.StyleSelect

async function colourwayIdsOf(db: Reader, styleId: string): Promise<string[]> {
  return (await db.colourway.findMany({ where: { styleId }, select: { id: true } })).map((row) => row.id)
}

function assertCells(cells: readonly SampleCell[], style: { code: string; sizes: readonly string[] }, colourwayIds: readonly string[], path: string): void {
  const problems = cellsProblems(cells, { code: style.code, sizes: style.sizes, colourwayIds }, path)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'These cells cannot be the round.', problems)
}

/** The brand or customer a round is for: a CUSTOMER or BRAND party of the company (or tenant-wide), not archived. */
async function assertCustomer(db: Reader, partyId: string, companyId: string): Promise<void> {
  const party = await db.party.findUnique({ where: { id: partyId }, select: { companyId: true, roles: true, status: true } })
  if (!party || (party.companyId !== null && party.companyId !== companyId)) badBody('partyId', 'No such customer or brand for this company.')
  if (!party.roles.some((role) => role === 'CUSTOMER' || role === 'BRAND')) badBody('partyId', 'This party is not a customer or a brand.')
  if (party.status === 'ARCHIVED') badBody('partyId', 'This customer is archived.')
}

/** The revision of the style a round is made from: of the style, not obsolete. */
async function revisionFor(db: Reader, style: { id: string; code: string }, revisionId: string | undefined): Promise<{ id: string; revision: number; status: string }> {
  const revision = revisionId
    ? await db.styleRevision.findUnique({ where: { id: revisionId }, select: { id: true, styleId: true, revision: true, status: true } })
    : await db.styleRevision.findFirst({ where: { styleId: style.id, status: { not: 'OBSOLETE' } }, select: { id: true, styleId: true, revision: true, status: true }, orderBy: { revision: 'desc' } })
  if (revisionId && (!revision || revision.styleId !== style.id)) badBody('revisionId', `No such revision of style ${style.code}.`)
  if (!revision) refuse(noRevisionRefusal(style.code))
  refuse(revisionRefusal(revision!))
  return revision!
}

/** Both or neither: a charge has its amount and its currency. */
function assertCharge(amount: number | null | undefined, currency: string | null | undefined): void {
  if ((amount === undefined) !== (currency === undefined) || (amount === null) !== (currency === null)) {
    badBody('chargeCurrency', 'A charge has its amount and its currency (ISO 4217), both or neither.')
  }
}

const roundNoOf = async (db: Reader, styleId: string, kind: SampleKind): Promise<number> =>
  nextRoundNo((await db.sampleRound.findMany({ where: { styleId, kind }, select: { roundNo: true } })).map((row) => row.roundNo))

// ---- create --------------------------------------------------------------------------------------------------------------

/** POST /sales/samples/rounds */
export async function createRound(caller: CommandCaller, body: CreateRoundBody, idempotencyKey?: string): Promise<RoundView> {
  const context = officeOf(caller)
  const amount = body.chargeAmountMinor as number | undefined
  assertCharge(amount, body.chargeCurrency)
  const checked = await caller.withClient(async (db) => {
    const style = await db.style.findUnique({ where: { id: body.styleId }, select: STYLE_COLUMNS })
    if (!style || (style.companyId !== null && !may(context, SALES_SAMPLES_VIEW, { companyId: style.companyId, partyId: null }))) throw new NotFoundError('Style not found.')
    // The company it is numbered in: the style's; a tenant-wide style's: the one named, else the screen's.
    const companyId = style.companyId ?? body.companyId ?? context.companyId ?? null
    if (companyId === null) badBody('companyId', `Style ${style.code} is every company's: say which company the round is for.`)
    if (style.companyId !== null && body.companyId !== undefined && body.companyId !== style.companyId) badBody('companyId', "The round is for the style's own company.")
    if (style.companyId === null && !(await db.company.findUnique({ where: { id: companyId! }, select: { id: true } }))) badBody('companyId', 'No such company.')
    refuse(styleRefusal(style))
    const revision = await revisionFor(db, style, body.revisionId)
    if (body.partyId) {
      await assertCustomer(db, body.partyId, companyId!)
      if (!may(context, SALES_SAMPLES_VIEW, { companyId: companyId!, partyId: body.partyId })) badBody('partyId', 'No such customer or brand for this company.')
    }
    assertCells(body.cells, style, await colourwayIdsOf(db, style.id), 'body/cells')
    refuse(chargeRefusal(body.partyId ?? null, amount !== undefined))
    refuse(testZonesRefusal(body.kind, body.testZones ?? null))
    return { style, revision, companyId: companyId! }
  })
  if (!may(context, SALES_SAMPLES_MANAGE, { companyId: checked.companyId, partyId: body.partyId ?? null })) {
    throw new ForbiddenError('Your role does not ask for sample rounds for this company or customer (sales.samples.manage).')
  }
  const id = newId()
  await command(caller, { name: 'sales.samples.request', idempotencyKey, input: { ...body, chargeAmountMinor: markMoney('price', amount ?? null) } }, async (tools) => {
    const { tx, now } = tools
    const { formatted: number } = await allocateNumber(tools, { companyId: checked.companyId, kind: 'SAMPLE_ROUND' }, { type: 'SampleRound', id })
    const createdById = authorOf(tools)
    const roundNo = body.roundNo ?? (await roundNoOf(tx, checked.style.id, body.kind))
    const data = {
      id,
      companyId: checked.companyId,
      number,
      styleId: checked.style.id,
      revisionId: checked.revision.id,
      kind: body.kind,
      roundNo,
      partyId: body.partyId ?? null,
      cells: storedCells(body.cells),
      dueDate: body.dueDate ? asDay(body.dueDate) : null,
      instructions: body.instructions ?? null,
      chargeAmountMinor: amount ?? null,
      chargeCurrency: body.chargeCurrency ?? null,
      testZones: body.testZones ?? null,
      createdAt: now,
      updatedAt: now,
      createdById,
    }
    await tx.sampleRound.create({ data, select: { id: true } })
    tools.audit({
      action: 'sales.samples.request',
      recordType: 'SampleRound',
      recordId: id,
      companyId: checked.companyId,
      after: { ...data, stage: 'REQUESTED', dueDate: body.dueDate ?? null, chargeAmountMinor: markMoney('price', data.chargeAmountMinor), createdAt: toUtcIso(now), updatedAt: undefined },
    })
    if (createdById) await followInCommand(tools, { type: 'SampleRound', id, companyId: checked.companyId, siteId: null }, createdById, 'CREATOR', createdById)
    tools.emit({
      type: 'sample_round.requested',
      subject: id,
      companyId: checked.companyId,
      payload: { sampleRoundId: id, number, styleId: checked.style.id, revisionId: checked.revision.id, kind: body.kind, roundNo, partyId: data.partyId },
    })
    return { id }
  }).catch(databaseRefusal)
  return readRound(caller, id)
}

// ---- change ------------------------------------------------------------------------------------------------------------

type Changes = Omit<UpdateRoundBody, 'version'>

/** PATCH /sales/samples/rounds/:roundId */
export async function updateRound(caller: CommandCaller, roundId: string, body: UpdateRoundBody, idempotencyKey?: string): Promise<RoundView> {
  const { round: seen } = await officeRound(caller, roundId, SALES_SAMPLES_MANAGE)
  const { version, ...changes } = body
  const fields = (Object.keys(changes) as (keyof Changes)[]).filter((key) => changes[key] !== undefined)
  if (fields.length === 0) badBody('version', 'Say what changes.')
  const amount = changes.chargeAmountMinor as number | null | undefined
  if (amount !== undefined || changes.chargeCurrency !== undefined) assertCharge(amount, changes.chargeCurrency)
  await caller.withClient(async (db) => {
    const style = await db.style.findUniqueOrThrow({ where: { id: seen.styleId }, select: STYLE_COLUMNS })
    if (changes.revisionId) await revisionFor(db, style, changes.revisionId)
    if (changes.cells) assertCells(changes.cells, style, await colourwayIdsOf(db, style.id), 'body/cells')
  })
  if (amount !== undefined) refuse(chargeRefusal(seen.partyId, amount !== null))
  if (changes.testZones !== undefined) refuse(testZonesRefusal(seen.kind as SampleKind, changes.testZones))
  await command(
    caller,
    { name: 'sales.samples.update', idempotencyKey, input: { roundId, ...body, ...(amount !== undefined ? { chargeAmountMinor: markMoney('price', amount) } : {}) }, record: { type: 'SampleRound', id: roundId, expectedVersion: version } },
    async (tools) => {
      const { tx } = tools
      const row = (await readRoundRow(tx, roundId))!
      const pinned = await tx.styleRevision.findUniqueOrThrow({ where: { id: row.revisionId }, select: { revision: true } })
      // The same revision again is no change of it.
      const changing = fields.filter((field) => !(field === 'revisionId' && changes.revisionId === row.revisionId))
      refuse(roundEditRefusal({ number: row.number, stage: row.stage as SampleStage, revision: pinned.revision }, changing))
      const data: Prisma.SampleRoundUncheckedUpdateInput = {
        ...(changes.revisionId !== undefined ? { revisionId: changes.revisionId } : {}),
        ...(changes.roundNo !== undefined ? { roundNo: changes.roundNo } : {}),
        ...(changes.cells !== undefined ? { cells: storedCells(changes.cells) } : {}),
        ...(changes.dueDate !== undefined ? { dueDate: changes.dueDate === null ? null : asDay(changes.dueDate) } : {}),
        ...(changes.instructions !== undefined ? { instructions: changes.instructions } : {}),
        ...(amount !== undefined ? { chargeAmountMinor: amount, chargeCurrency: changes.chargeCurrency ?? null } : {}),
        ...(changes.testZones !== undefined ? { testZones: changes.testZones } : {}),
      }
      await tx.sampleRound.update({ where: { id: roundId }, data, select: { id: true } })
      const before: Record<string, unknown> = {}
      const after: Record<string, unknown> = {}
      for (const key of Object.keys(data) as (keyof RoundData)[]) {
        const was = key === 'dueDate' ? dayOrNull(row.dueDate) : row[key]
        const now = key === 'dueDate' ? (changes.dueDate ?? null) : (data as Record<string, unknown>)[key]
        before[key] = key === 'chargeAmountMinor' ? markMoney('price', was) : was
        after[key] = key === 'chargeAmountMinor' ? markMoney('price', now) : now
      }
      tools.audit({ action: 'sales.samples.update', recordType: 'SampleRound', recordId: roundId, companyId: row.companyId, before, after })
      tools.emit({
        type: 'sample_round.changed',
        subject: roundId,
        companyId: row.companyId,
        payload: { sampleRoundId: roundId, number: row.number, styleId: row.styleId, stage: row.stage, previousStage: row.stage, change: 'UPDATED', workOrderId: null },
      })
      return null
    },
  ).catch(databaseRefusal)
  return readRound(caller, roundId)
}

// ---- the board -----------------------------------------------------------------------------------------------------------

/** POST /sales/samples/rounds/:roundId/move: one of the four manual stages, in any order. */
export async function moveRound(caller: CommandCaller, roundId: string, body: MoveRoundBody, idempotencyKey?: string): Promise<RoundView> {
  const { round: seen } = await officeRound(caller, roundId, SALES_SAMPLES_MANAGE)
  refuse(stageMoveRefusal({ number: seen.number, stage: seen.stage as SampleStage }, body.to))
  await command(caller, { name: 'sales.samples.move', idempotencyKey, input: { roundId, ...body }, record: { type: 'SampleRound', id: roundId, expectedVersion: body.version } }, async (tools) => {
    const { tx } = tools
    const row = (await readRoundRow(tx, roundId))!
    refuse(stageMoveRefusal({ number: row.number, stage: row.stage as SampleStage }, body.to))
    await tx.sampleRound.update({ where: { id: roundId }, data: { stage: body.to }, select: { id: true } })
    tools.audit({ action: 'sales.samples.move', recordType: 'SampleRound', recordId: roundId, companyId: row.companyId, before: { stage: row.stage }, after: { stage: body.to } })
    tools.emit({
      type: 'sample_round.changed',
      subject: roundId,
      companyId: row.companyId,
      payload: { sampleRoundId: roundId, number: row.number, styleId: row.styleId, stage: body.to, previousStage: row.stage, change: 'MOVED', workOrderId: null },
    })
    return null
  }).catch(databaseRefusal)
  return readRound(caller, roundId)
}

/** POST /sales/samples/rounds/:roundId/cancel: CANCELLED with why (its sample work orders stay: W1's cancel is theirs). */
export async function cancelRound(caller: CommandCaller, roundId: string, body: CancelRoundBody, idempotencyKey?: string): Promise<RoundView> {
  const { round: seen } = await officeRound(caller, roundId, SALES_SAMPLES_MANAGE)
  refuse(cancelRefusal({ number: seen.number, stage: seen.stage as SampleStage }))
  await command(caller, { name: 'sales.samples.cancel', idempotencyKey, input: { roundId, ...body }, record: { type: 'SampleRound', id: roundId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const row = (await readRoundRow(tx, roundId))!
    refuse(cancelRefusal({ number: row.number, stage: row.stage as SampleStage }))
    await tx.sampleRound.update({ where: { id: roundId }, data: { stage: 'CANCELLED', cancelledAt: now, cancelReason: body.reason }, select: { id: true } })
    tools.audit({ action: 'sales.samples.cancel', recordType: 'SampleRound', recordId: roundId, companyId: row.companyId, before: { stage: row.stage }, after: { stage: 'CANCELLED', cancelledAt: toUtcIso(now) }, reason: body.reason })
    tools.emit({
      type: 'sample_round.changed',
      subject: roundId,
      companyId: row.companyId,
      payload: { sampleRoundId: roundId, number: row.number, styleId: row.styleId, stage: 'CANCELLED', previousStage: row.stage, change: 'CANCELLED', workOrderId: null },
    })
    return null
  }).catch(databaseRefusal)
  return readRound(caller, roundId)
}
