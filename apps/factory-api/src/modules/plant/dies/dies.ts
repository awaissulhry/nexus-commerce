import type { DieCondition as DbDieCondition, Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { holds, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { PLANT_MACHINES_MANAGE, PLANT_VIEW } from '@nexus/factory-domain/plant/permissions'
import {
  DIE_CHANGEABLE,
  dieDraftProblems,
  dieRefusal,
  isSettableCondition,
  normalDieCode,
  retiredNote,
  RETIRED_DIE_CHANGEABLE,
  sizeFits,
  type DieChangeable,
  type DieCondition,
  type DieRefusal,
} from '@nexus/factory-domain/plant/machines/dies'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { assertMay, assertMayWrite, assertVersion, bodyIssue, officeOf, problemsError, scopeOf } from '../access'

/**
 * The clicking-die register (B-W2b-136; QHS-173; design plant.machines "Clicking dies": cutting dies per style, size and
 * piece). Office routes: plant.view reads, plant.machines.manage writes (the register of machines and equipment, dies
 * included), each die checked with can() against its company and site; its purchase cost only with the cost grain.
 *
 *   GET   /plant/dies                    the register of the caller's sites (a site, a style, conditions, words), number
 *                                        order, pages; retired dies only when asked
 *   GET   /plant/dies/styles             the styles a die may cut (the New die dialog's picker: no product right needed)
 *   GET   /plant/dies/choices            one style's sizes and the pattern pieces of its newest revision in use
 *   POST  /plant/dies                    a die at a site, GOOD, for one style, one size or every size, one piece
 *   PATCH /plant/dies/:dieId             its rack, condition (good, worn, damaged), size, piece, material, supplier, cost, note
 *   POST  /plant/dies/:dieId/retire      retired for good with the reason (kept in the audit row and the note)
 *
 * Every write is one command() on the die row (locked first), with an Idempotency-Key and the version read; the
 * …_plant_care_w2b_guards ClickingDie trigger stays the last word. A refusal is a 409 `refusal/<CODE>` + `fix`.
 */

export class DieRefusedError extends ConflictError {
  override name = 'DieRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: DieRefusal) {
    super(refusal.message)
    this.issues = [
      { path: `refusal/${refusal.code}`, message: refusal.message },
      { path: 'fix', message: refusal.fix },
    ]
  }
}

const refuse = (refusal: DieRefusal): never => {
  throw new DieRefusedError(refusal)
}

// ---- rows and views ---------------------------------------------------------------------------------------------------

const DIE_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  code: true,
  styleId: true,
  size: true,
  piece: true,
  patternPieceId: true,
  rackLocation: true,
  material: true,
  supplierId: true,
  purchaseCost: true,
  condition: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  site: { select: { code: true } },
  style: { select: { id: true, code: true, name: true, sizes: true } },
  patternPiece: { select: { id: true, name: true, revision: { select: { revision: true } } } },
  supplier: { select: { id: true, code: true, legalName: true } },
} as const satisfies Prisma.ClickingDieSelect

type DieRow = Prisma.ClickingDieGetPayload<{ select: typeof DIE_COLUMNS }>
type Reader = Pick<CommandTx, 'clickingDie'>

const readDie = async (db: Reader, id: string): Promise<DieRow | null> => db.clickingDie.findUnique({ where: { id }, select: DIE_COLUMNS })

/** A die as the register shows it; the cost marked with its grain (the serializer drops it for whoever lacks it). */
export function dieView(row: DieRow) {
  return {
    id: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    siteCode: row.site.code,
    code: row.code,
    style: { id: row.style.id, code: row.style.code, name: row.style.name },
    size: row.size,
    piece: row.piece,
    patternPiece: row.patternPiece ? { id: row.patternPiece.id, name: row.patternPiece.name, revision: row.patternPiece.revision.revision } : null,
    rackLocation: row.rackLocation,
    material: row.material,
    supplier: row.supplier ? { id: row.supplier.id, code: row.supplier.code, name: row.supplier.legalName } : null,
    purchaseCost: asMoney('cost', row.purchaseCost ?? null),
    condition: row.condition as DieCondition,
    note: row.note,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** What the audit rows keep of a die (the cost with its grain). */
const audited = (row: Pick<DieRow, 'code' | 'styleId' | 'size' | 'piece' | 'patternPieceId' | 'rackLocation' | 'material' | 'supplierId' | 'purchaseCost' | 'condition' | 'note'>) => ({
  code: row.code,
  styleId: row.styleId,
  size: row.size,
  piece: row.piece,
  patternPieceId: row.patternPieceId,
  rackLocation: row.rackLocation,
  material: row.material,
  supplierId: row.supplierId,
  purchaseCost: markMoney('cost', row.purchaseCost ?? null),
  condition: row.condition,
  note: row.note,
})

/** The one event of the register: ids, the number, what changed (names only). */
function emitDie(tools: CommandTools, row: { readonly id: string; readonly code: string; readonly styleId: string; readonly companyId: string; readonly siteId: string }, change: 'REGISTERED' | 'CHANGED' | 'RETIRED', fields: readonly string[]): void {
  tools.emit({ type: 'clicking_die.changed', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { dieId: row.id, code: row.code, styleId: row.styleId, change, fields: [...fields] } })
}

// ---- reads ------------------------------------------------------------------------------------------------------------

const SORT: Prisma.ClickingDieOrderByWithRelationInput[] = [{ code: 'asc' }, { id: 'asc' }]

export interface ListQuery {
  readonly siteId?: string | undefined
  readonly styleId?: string | undefined
  readonly condition?: readonly DieCondition[] | undefined
  readonly q?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** GET /plant/dies: number order; a cursor is the last row's id. */
export async function listDies(caller: CommandCaller, query: ListQuery) {
  const context = officeOf(caller)
  const conditions = query.condition && query.condition.length > 0 ? [...query.condition] : null
  const where: Prisma.ClickingDieWhereInput = {
    AND: [
      scopeOf(context, PLANT_VIEW) as Prisma.ClickingDieWhereInput,
      query.siteId ? { siteId: query.siteId } : {},
      query.styleId ? { styleId: query.styleId } : {},
      conditions ? { condition: { in: conditions as DbDieCondition[] } } : { condition: { not: 'RETIRED' } },
      query.q
        ? {
            OR: [
              { code: { contains: query.q, mode: 'insensitive' } },
              { piece: { contains: query.q, mode: 'insensitive' } },
              { rackLocation: { contains: query.q, mode: 'insensitive' } },
              { material: { contains: query.q, mode: 'insensitive' } },
              { style: { code: { contains: query.q, mode: 'insensitive' } } },
            ],
          }
        : {},
    ],
  }
  return caller.withClient(async (client) => {
    let after: Prisma.ClickingDieWhereInput = {}
    if (query.cursor) {
      const last = await client.clickingDie.findUnique({ where: { id: query.cursor }, select: { code: true, id: true } })
      if (last) after = { OR: [{ code: { gt: last.code } }, { code: last.code, id: { gt: last.id } }] }
    }
    const rows = await client.clickingDie.findMany({ where: { AND: [where, after] }, orderBy: SORT, take: query.limit + 1, select: DIE_COLUMNS })
    const page = rows.slice(0, query.limit)
    return { dies: page.map(dieView), nextCursor: rows.length > query.limit ? page.at(-1)!.id : null, canManage: holds(actorOf(context), PLANT_MACHINES_MANAGE) }
  })
}

/** The styles the caller's plant.view reaches (the group's, or of a company it reaches). */
const styleScope = (context: OfficeContext): Prisma.StyleWhereInput => scopeWhere(actorOf(context), PLANT_VIEW, { company: { field: 'companyId', nullable: true } }) as Prisma.StyleWhereInput

/** GET /plant/dies/styles: at most 20 styles by code or name, the newest code first when nothing is typed. */
export async function dieStyles(caller: CommandCaller, query: { readonly q?: string | undefined }) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const rows = await client.style.findMany({
      where: { AND: [styleScope(context), query.q ? { OR: [{ code: { contains: query.q, mode: 'insensitive' } }, { name: { contains: query.q, mode: 'insensitive' } }] } : {}] },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
      take: 20,
      select: { id: true, code: true, name: true, sizes: true },
    })
    return { styles: rows.map((row) => ({ id: row.id, code: row.code, name: row.name, sizes: [...row.sizes] })) }
  })
}

/** GET /plant/dies/choices: one style's sizes and the pattern pieces of its newest revision that is not obsolete. */
export async function dieChoices(caller: CommandCaller, query: { readonly styleId: string }) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const style = await client.style.findFirst({ where: { AND: [styleScope(context), { id: query.styleId }] }, select: { id: true, code: true, name: true, sizes: true } })
    if (!style) throw new NotFoundError('Style not found.')
    const revision = await client.styleRevision.findFirst({ where: { styleId: style.id, status: { not: 'OBSOLETE' } }, orderBy: [{ revision: 'desc' }], select: { id: true, revision: true } })
    const pieces = revision ? await client.patternPiece.findMany({ where: { revisionId: revision.id }, orderBy: [{ seq: 'asc' }, { id: 'asc' }], select: { id: true, name: true, sizes: true } }) : []
    return {
      style: { id: style.id, code: style.code, name: style.name },
      sizes: [...style.sizes],
      pieces: pieces.map((piece) => ({ id: piece.id, name: piece.name, revision: revision!.revision, sizes: [...piece.sizes] })),
    }
  })
}

// ---- writes -----------------------------------------------------------------------------------------------------------

/** The cost may be sent only with the cost grain (the grain filter refuses a value before; this says it for a null). */
function assertCostGrain(context: OfficeContext, sent: boolean): void {
  if (sent && !holds(actorOf(context), 'money.cost')) throw new ForbiddenError("A die's purchase cost is changed only with the cost grain.")
}

const clean = (value: string | null | undefined): string | null => (value === undefined || value === null ? null : value.trim() || null)

interface Refs {
  readonly size?: string | null | undefined
  readonly patternPieceId?: string | null | undefined
  readonly supplierId?: string | null | undefined
}

/** The style's size, its pattern piece and a supplier: each refused in words or as a 400 naming the field. */
async function checkRefs(tx: CommandTx, style: { readonly id: string; readonly code: string; readonly sizes: readonly string[] }, refs: Refs): Promise<void> {
  if (refs.size !== undefined && !sizeFits(refs.size, style.sizes)) refuse(dieRefusal.sizeNotInStyle(refs.size!, style.code))
  if (refs.patternPieceId) {
    const piece = await tx.patternPiece.findUnique({ where: { id: refs.patternPieceId }, select: { styleId: true } })
    if (!piece || piece.styleId !== style.id) refuse(dieRefusal.pieceOtherStyle(style.code))
  }
  if (refs.supplierId) {
    const party = await tx.party.findUnique({ where: { id: refs.supplierId }, select: { roles: true } })
    if (!party) throw bodyIssue('supplierId', 'Not a party of the group.')
    if (!party.roles.includes('SUPPLIER')) throw bodyIssue('supplierId', 'This party is not a supplier.')
  }
}

/** The die row locked for the command (one lock order: the die alone). */
async function lockDie(tx: CommandTx, id: string): Promise<DieRow | null> {
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "ClickingDie" WHERE "id" = ${id}::uuid FOR UPDATE`
  return locked.length === 0 ? null : readDie(tx, id)
}

/** A die the caller may see (404 otherwise) and may keep (403 in words otherwise). */
async function keptDie(caller: CommandCaller, context: OfficeContext, dieId: string, words: string): Promise<DieRow> {
  const known = isUuid(dieId) ? await caller.withClient((client) => readDie(client, dieId)) : null
  if (!known) throw new NotFoundError('Die not found.')
  assertMay(context, PLANT_VIEW, known, 'Die')
  assertMayWrite(context, PLANT_MACHINES_MANAGE, known, words)
  return known
}

export interface CreateBody {
  readonly siteId: string
  readonly code: string
  readonly styleId: string
  readonly size?: string | null | undefined
  readonly piece: string
  readonly patternPieceId?: string | null | undefined
  readonly rackLocation?: string | null | undefined
  readonly material?: string | null | undefined
  readonly supplierId?: string | null | undefined
  readonly purchaseCost?: number | null | undefined
  readonly note?: string | null | undefined
}

/** POST /plant/dies. */
export async function createDie(caller: CommandCaller, body: CreateBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const problems = dieDraftProblems(body, true)
  if (problems.length > 0) throw problemsError(problems, 'The die is not valid.')
  assertCostGrain(context, body.purchaseCost !== undefined)
  const site = await caller.withClient((client) => client.site.findUnique({ where: { id: body.siteId }, select: { id: true, companyId: true, status: true } }))
  if (!site) throw bodyIssue('siteId', 'Not a site of the group.')
  assertMayWrite(context, PLANT_MACHINES_MANAGE, { companyId: site.companyId, siteId: site.id }, "The dies of this site are registered by a role that keeps the plant's register (plant.machines.manage).")
  if (site.status !== 'ACTIVE') throw bodyIssue('siteId', 'This site is archived.')
  const code = normalDieCode(body.code)
  const id = newId()
  const { result, replayed } = await command(caller, { name: 'plant.registerDie', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const style = await tx.style.findFirst({ where: { AND: [styleScope(context), { id: body.styleId }] }, select: { id: true, code: true, sizes: true } })
    if (!style) refuse(dieRefusal.styleUnknown())
    await checkRefs(tx, style!, { size: body.size ?? null, patternPieceId: body.patternPieceId, supplierId: body.supplierId })
    if (await tx.clickingDie.findFirst({ where: { code }, select: { id: true } })) refuse(dieRefusal.numberTaken(code))
    const data: Prisma.ClickingDieUncheckedCreateInput = {
      id,
      companyId: site.companyId,
      siteId: site.id,
      code,
      styleId: style!.id,
      size: body.size ?? null,
      piece: body.piece.trim(),
      patternPieceId: body.patternPieceId ?? null,
      rackLocation: clean(body.rackLocation),
      material: clean(body.material),
      supplierId: body.supplierId ?? null,
      purchaseCost: body.purchaseCost ?? null,
      condition: 'GOOD',
      note: clean(body.note),
      createdAt: now,
      updatedAt: now,
      createdById: context.actorId,
    }
    await tx.clickingDie.create({ data, select: { id: true } })
    const row = (await readDie(tx, id))!
    tools.audit({ action: 'plant.registerDie', recordType: 'ClickingDie', recordId: id, companyId: site.companyId, siteId: site.id, after: audited(row) })
    emitDie(tools, row, 'REGISTERED', [])
    return { die: dieView(row) }
  })
  return { ...result, replayed }
}

export interface UpdateBody {
  readonly version: number
  readonly size?: string | null | undefined
  readonly piece?: string | undefined
  readonly patternPieceId?: string | null | undefined
  readonly rackLocation?: string | null | undefined
  readonly material?: string | null | undefined
  readonly supplierId?: string | null | undefined
  readonly purchaseCost?: number | null | undefined
  readonly condition?: DieCondition | undefined
  readonly note?: string | null | undefined
}

/** PATCH /plant/dies/:dieId: only what changed; a retired die only its note. */
export async function updateDie(caller: CommandCaller, dieId: string, body: UpdateBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const problems = dieDraftProblems(body, false)
  if (problems.length > 0) throw problemsError(problems, 'The change is not valid.')
  if (body.condition !== undefined && !isSettableCondition(body.condition)) refuse(dieRefusal.retiredByRetire())
  assertCostGrain(context, body.purchaseCost !== undefined)
  await keptDie(caller, context, dieId, "Dies are changed by a role that keeps the plant's register (plant.machines.manage).")
  const { result } = await command(caller, { name: 'plant.changeDie', idempotencyKey, input: { dieId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const die = (await lockDie(tx, dieId))!
    assertVersion('die', die.version, body.version)
    const next: Partial<Record<DieChangeable, unknown>> = {}
    for (const field of DIE_CHANGEABLE) {
      const value = body[field]
      if (value === undefined) continue
      const typed = field === 'rackLocation' || field === 'material' || field === 'note' ? clean(value as string | null) : field === 'piece' ? (value as string).trim() : value
      if (typed === (die as Record<string, unknown>)[field]) continue
      next[field] = typed
    }
    const fields = Object.keys(next) as DieChangeable[]
    if (die.condition === 'RETIRED' && fields.some((field) => !RETIRED_DIE_CHANGEABLE.includes(field))) refuse(dieRefusal.retired(die.code))
    if (fields.length === 0) {
      tools.audit({ action: 'plant.changeDie', recordType: 'ClickingDie', recordId: die.id, companyId: die.companyId, siteId: die.siteId, after: { unchanged: true } })
      return { die: dieView(die) }
    }
    await checkRefs(tx, die.style, { ...(fields.includes('size') ? { size: next.size as string | null } : {}), ...(fields.includes('patternPieceId') ? { patternPieceId: next.patternPieceId as string | null } : {}), ...(fields.includes('supplierId') ? { supplierId: next.supplierId as string | null } : {}) })
    await tx.clickingDie.update({ where: { id: die.id }, data: { ...(next as Prisma.ClickingDieUncheckedUpdateInput), version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const after = (await readDie(tx, die.id))!
    tools.audit({ action: 'plant.changeDie', recordType: 'ClickingDie', recordId: die.id, companyId: die.companyId, siteId: die.siteId, before: audited(die), after: audited(after) })
    emitDie(tools, after, 'CHANGED', fields)
    return { die: dieView(after) }
  })
  return result
}

/** POST /plant/dies/:dieId/retire: RETIRED for good, the reason in the audit row and on the note. */
export async function retireDie(caller: CommandCaller, dieId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  await keptDie(caller, context, dieId, "Dies are retired by a role that keeps the plant's register (plant.machines.manage).")
  const { result, replayed } = await command(caller, { name: 'plant.retireDie', idempotencyKey, input: { dieId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const die = (await lockDie(tx, dieId))!
    assertVersion('die', die.version, body.version)
    if (die.condition === 'RETIRED') refuse(dieRefusal.retired(die.code))
    const reason = body.reason.trim()
    await tx.clickingDie.update({ where: { id: die.id }, data: { condition: 'RETIRED', note: retiredNote(die.note, reason, businessDate(now)), version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const after = (await readDie(tx, die.id))!
    tools.audit({ action: 'plant.retireDie', recordType: 'ClickingDie', recordId: die.id, companyId: die.companyId, siteId: die.siteId, reason, before: audited(die), after: audited(after) })
    emitDie(tools, after, 'RETIRED', ['condition', 'note'])
    return { die: dieView(after) }
  })
  return { ...result, replayed }
}
