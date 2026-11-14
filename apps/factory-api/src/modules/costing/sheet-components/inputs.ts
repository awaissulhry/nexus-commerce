import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayRange, businessDayStart, toUtcIso } from '@nexus/factory-domain/core/time'
import { costingCurrency } from '@nexus/factory-domain/costing/inputs'
import { COSTING_RATES_MANAGE, COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import type {
  ArchiveBody,
  CreateLeatherBasisBody,
  CreateUpliftBody,
  LandedQuery,
  LeatherBasesQuery,
  LeatherBasisView,
  SetPieceRateLabourBody,
  UpdateLeatherBasisBody,
  UpdateUpliftBody,
  UpliftsQuery,
  UpliftView,
} from '@nexus/factory-domain/costing/sheet-components/contracts'
import { COSTING_SHEETS_MANAGE } from '@nexus/factory-domain/costing/sheet-components/permissions'
import {
  COMPONENT_REFUSAL_WORDS,
  componentInputMachine,
  gradeMixOf,
  landedPct,
  leatherBasisProblems,
  leatherKey,
  pieceRateWords,
  upliftFigureProblems,
  upliftKey,
  type UpliftTarget,
} from '@nexus/factory-domain/costing/sheet-components/rules'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import type { ItemKind } from '@nexus/factory-domain/product/materials/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { contextOf, mayWrite } from '../../product/materials/store'
import { ownedLots } from '../valuation/customer-owned'
import { companyOrTenant, dayOf } from '../inputs'
import { componentRefusalOf, refused } from './refusals'
import { payingSitesOf } from './store'

/**
 * What the cost sheet's components read (B-W2b-418; FIN-003, FIN-006, FIN-008, FIN-009): each leather's cost basis, the
 * uplifts on a material, a kind of material or a workshop's operations (with the landed cost a percent is read from), and
 * the company's piece-rate labour switch. Read with costing.view (a transport only with the cost grain); bases and uplifts
 * kept with costing.sheets.manage over their company (every company's: a grant over every company); the switch with
 * costing.rates.manage over the company, on only while a site of the company pays piece rates (GATE-PIECE-PAY, the
 * database's rule too). A basis or an uplift is corrected or archived, never deleted: a new figure from a later day is a new
 * row.
 */

type Reader = FactoryClient | CommandTx
const text = (value: { toString(): string }): string => decimalText(value.toString())
const textOrNull = (value: { toString(): string } | null): string | null => (value === null ? null : text(value))
const dateOf = (day: string): Date => new Date(`${day}T00:00:00.000Z`)
const today = (): string => businessDate(serverClock.now())
const COMPANY_SCOPE = { company: { field: 'companyId', nullable: true } } as const
const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'
const refusedWith = (code: keyof typeof COMPONENT_REFUSAL_WORDS) => refused(code, COMPONENT_REFUSAL_WORDS[code])
const officeActor = (context: RequestContext): string | null => (context.audience === 'office' ? context.actorId : null)

/** The company exists and the caller may see its costs (else 404). */
async function assertCompany(caller: CommandCaller, companyId: string): Promise<RequestContext> {
  const context = contextOf(caller)
  const row = isUuid(companyId) ? await caller.withClient((db) => db.company.findUnique({ where: { id: companyId }, select: { id: true } })) : null
  if (!row || !can(actorOf(context), COSTING_VIEW, { companyId })) throw new NotFoundError('Company not found.')
  return context
}

function assertMayKeep(context: RequestContext, companyId: string | null): void {
  if (!mayWrite(actorOf(context), COSTING_SHEETS_MANAGE, companyId)) throw new ForbiddenError(companyId === null ? "Every company's cost input is changed only by a role over every company." : undefined)
}

// ---- leather cost bases ----------------------------------------------------------------------------------------------------

const BASIS_COLUMNS = { id: true, companyId: true, itemId: true, styleId: true, key: true, areaUnit: true, expectedYieldPct: true, gradeMix: true, validFrom: true, status: true, note: true, version: true, createdAt: true, updatedAt: true } as const satisfies Prisma.LeatherCostBasisSelect
type BasisRow = Prisma.LeatherCostBasisGetPayload<{ select: typeof BASIS_COLUMNS }>

async function basisViews(db: Reader, rows: readonly BasisRow[], on: string): Promise<LeatherBasisView[]> {
  const items = new Map((rows.length === 0 ? [] : await db.item.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.itemId))] } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  return rows.map((row) => {
    const validFrom = dayOf(row.validFrom)
    return {
      id: row.id,
      companyId: row.companyId,
      itemId: row.itemId,
      item: { code: items.get(row.itemId)?.code ?? '', name: items.get(row.itemId)?.name ?? '' },
      styleId: row.styleId,
      key: row.key,
      areaUnit: row.areaUnit as LeatherBasisView['areaUnit'],
      expectedYieldPct: text(row.expectedYieldPct),
      gradeMix: row.gradeMix as Record<string, string>,
      validFrom,
      status: row.status,
      note: row.note,
      inForce: row.status === 'ACTIVE' && validFrom <= on,
      version: row.version,
      createdAt: toUtcIso(row.createdAt),
      updatedAt: toUtcIso(row.updatedAt),
    }
  })
}

async function readBasis(caller: CommandCaller, basisId: string): Promise<BasisRow> {
  const context = contextOf(caller)
  const row = isUuid(basisId) ? await caller.withClient((db) => db.leatherCostBasis.findUnique({ where: { id: basisId }, select: BASIS_COLUMNS })) : null
  if (!row || !can(actorOf(context), COSTING_VIEW, { companyId: row.companyId })) throw new NotFoundError('Leather cost basis not found.')
  return row
}

/** GET /costing/leather-bases */
export async function listLeatherBases(caller: CommandCaller, query: LeatherBasesQuery): Promise<{ bases: LeatherBasisView[] }> {
  const context = contextOf(caller)
  if (query.companyId !== undefined) await assertCompany(caller, query.companyId)
  return caller.withClient(async (db) => {
    const scope = query.companyId === undefined ? (scopeWhere(actorOf(context), COSTING_VIEW, COMPANY_SCOPE) as Prisma.LeatherCostBasisWhereInput) : companyOrTenant(query.companyId)
    const rows = await db.leatherCostBasis.findMany({
      where: { AND: [scope, query.itemId ? { itemId: query.itemId } : {}, query.styleId ? { OR: [{ styleId: query.styleId }, { styleId: null }] } : {}, query.status === 'ALL' ? {} : { status: query.status }] },
      select: BASIS_COLUMNS,
      orderBy: [{ validFrom: 'desc' }, { id: 'asc' }],
      take: 500,
    })
    return { bases: await basisViews(db, rows, today()) }
  })
}

/** GET /costing/leather-bases/:basisId */
export async function leatherBasisRecord(caller: CommandCaller, basisId: string): Promise<{ basis: LeatherBasisView }> {
  const row = await readBasis(caller, basisId)
  return { basis: (await caller.withClient((db) => basisViews(db, [row], today())))[0]! }
}

/** The grades a mix names that the tenant has no longer active, as problems (the database refuses them too). */
async function gradeProblems(db: Reader, mix: Readonly<Record<string, string>>, at: string): Promise<Issue[]> {
  const active = new Set((await db.leatherGrade.findMany({ where: { active: true }, select: { code: true } })).map((row) => row.code))
  return Object.keys(mix).filter((code) => !active.has(code)).map((code) => ({ path: `${at}/gradeMix/${code}`, message: `No active leather grade ${code}.` }))
}

/** costing.createLeatherBasis: a leather article's basis from a day (for every style or one, every company or one). */
export async function createLeatherBasis(caller: CommandCaller, body: CreateLeatherBasisBody, idempotencyKey?: string): Promise<{ basis: LeatherBasisView }> {
  const context = contextOf(caller)
  const companyId = body.companyId ?? null
  const styleId = body.styleId ?? null
  assertMayKeep(context, companyId)
  if (companyId !== null) await assertCompany(caller, companyId)
  const mix = gradeMixOf(body.gradeMix)
  const problems = leatherBasisProblems({ expectedYieldPct: body.expectedYieldPct, gradeMix: mix })
  if (problems.length > 0) throw new ValidationError('The leather cost basis is not valid.', problems)
  const key = leatherKey(body.itemId, styleId, companyId)
  const { result } = await command(caller, { name: 'costing.createLeatherBasis', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const item = await tx.item.findUnique({ where: { id: body.itemId }, select: { id: true, kind: true, companyId: true } })
    const issues: Issue[] = []
    if (!item) throw new NotFoundError('Material not found.')
    if (item.kind !== 'LEATHER') issues.push({ path: 'body/itemId', message: 'A cost basis is for a leather article.' })
    if (item.companyId !== null && item.companyId !== companyId) issues.push({ path: 'body/itemId', message: "This leather is one company's: its basis is that company's." })
    if (styleId !== null) {
      const style = await tx.style.findUnique({ where: { id: styleId }, select: { companyId: true } })
      if (!style) throw new NotFoundError('Style not found.')
      if (style.companyId !== null && style.companyId !== companyId) issues.push({ path: 'body/styleId', message: "This style is one company's: its basis is that company's." })
    }
    issues.push(...(await gradeProblems(tx, mix, 'body')))
    if (issues.length > 0) throw new ValidationError('The leather cost basis is not valid.', issues)
    if (await tx.leatherCostBasis.findFirst({ where: { key, validFrom: dateOf(body.validFrom) }, select: { id: true } })) throw refusedWith('START_TAKEN')
    const id = newId()
    const row = await tx.leatherCostBasis.create({
      data: { id, companyId, itemId: body.itemId, styleId, key, areaUnit: body.areaUnit, expectedYieldPct: body.expectedYieldPct, gradeMix: mix, validFrom: dateOf(body.validFrom), note: body.note ?? null, createdAt: now, updatedAt: now, createdById: officeActor(tools.context) },
      select: BASIS_COLUMNS,
    })
    tools.audit({ recordType: 'LeatherCostBasis', recordId: id, companyId, after: { companyId, itemId: body.itemId, styleId, key, areaUnit: body.areaUnit, expectedYieldPct: body.expectedYieldPct, gradeMix: mix, validFrom: body.validFrom, note: body.note ?? null, status: 'ACTIVE' } })
    tools.emit({ type: 'leather_cost_basis.changed', subject: id, companyId, payload: { basisId: id, itemId: body.itemId, styleId, change: 'created' } })
    return { basis: (await basisViews(tx, [row], businessDate(now)))[0]! }
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw refusedWith('START_TAKEN')
    throw componentRefusalOf(error)
  })
  return result
}

const BASIS_FIELDS = ['areaUnit', 'expectedYieldPct', 'gradeMix', 'note'] as const

/** costing.updateLeatherBasis: a correction of an ACTIVE basis (its unit, yield, grade mix or note). */
export async function updateLeatherBasis(caller: CommandCaller, basisId: string, body: UpdateLeatherBasisBody, idempotencyKey?: string): Promise<{ basis: LeatherBasisView }> {
  const context = contextOf(caller)
  const seen = await readBasis(caller, basisId)
  assertMayKeep(context, seen.companyId)
  const mix = body.gradeMix === undefined ? undefined : gradeMixOf(body.gradeMix)
  const problems = leatherBasisProblems({ expectedYieldPct: body.expectedYieldPct, gradeMix: mix })
  if (problems.length > 0) throw new ValidationError('The leather cost basis is not valid.', problems)
  const { result } = await command(caller, { name: 'costing.updateLeatherBasis', idempotencyKey, input: { basisId, ...body }, record: { type: 'LeatherCostBasis', id: basisId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const row = await tx.leatherCostBasis.findUniqueOrThrow({ where: { id: basisId }, select: BASIS_COLUMNS })
    if (row.status !== 'ACTIVE') throw refusedWith('ARCHIVED')
    const current: Record<(typeof BASIS_FIELDS)[number], unknown> = { areaUnit: row.areaUnit, expectedYieldPct: text(row.expectedYieldPct), gradeMix: row.gradeMix, note: row.note }
    const sent: Partial<Record<(typeof BASIS_FIELDS)[number], unknown>> = {
      ...(body.areaUnit === undefined ? {} : { areaUnit: body.areaUnit }),
      ...(body.expectedYieldPct === undefined ? {} : { expectedYieldPct: decimalText(body.expectedYieldPct) }),
      ...(mix === undefined ? {} : { gradeMix: mix }),
      ...(body.note === undefined ? {} : { note: body.note }),
    }
    const changed = BASIS_FIELDS.filter((field) => field in sent && JSON.stringify(sent[field]) !== JSON.stringify(current[field]))
    if (changed.length === 0) throw refusedWith('NOTHING_CHANGES')
    if (mix !== undefined) {
      const issues = await gradeProblems(tx, mix, 'body')
      if (issues.length > 0) throw new ValidationError('The leather cost basis is not valid.', issues)
    }
    const data = Object.fromEntries(changed.map((field) => [field, sent[field]])) as Prisma.LeatherCostBasisUncheckedUpdateInput
    const updated = await tx.leatherCostBasis.update({ where: { id: basisId }, data: { ...data, updatedAt: now }, select: BASIS_COLUMNS })
    tools.audit({ recordType: 'LeatherCostBasis', recordId: basisId, companyId: row.companyId, before: Object.fromEntries(changed.map((field) => [field, current[field]])), after: Object.fromEntries(changed.map((field) => [field, sent[field]])) })
    tools.emit({ type: 'leather_cost_basis.changed', subject: basisId, companyId: row.companyId, payload: { basisId, itemId: row.itemId, styleId: row.styleId, change: 'updated' } })
    return { basis: (await basisViews(tx, [updated], businessDate(now)))[0]! }
  }).catch((error: unknown) => {
    throw componentRefusalOf(error)
  })
  return result
}

/** costing.archiveLeatherBasis: no cost sheet takes it any more (final). */
export async function archiveLeatherBasis(caller: CommandCaller, basisId: string, body: ArchiveBody, idempotencyKey?: string): Promise<{ basis: LeatherBasisView }> {
  const context = contextOf(caller)
  const seen = await readBasis(caller, basisId)
  assertMayKeep(context, seen.companyId)
  if (seen.status !== 'ACTIVE') throw refusedWith('ARCHIVED')
  const { result } = await command(
    caller,
    { name: 'costing.archiveLeatherBasis', idempotencyKey, input: { basisId, ...body }, record: { type: 'LeatherCostBasis', id: basisId, expectedVersion: body.version, transition: { machine: componentInputMachine, to: 'ARCHIVED' } } },
    async (tools) => {
      tools.audit({ recordType: 'LeatherCostBasis', recordId: basisId, companyId: seen.companyId, before: { status: tools.record!.from }, after: { status: 'ARCHIVED' }, ...(body.reason ? { reason: body.reason } : {}) })
      tools.emit({ type: 'leather_cost_basis.changed', subject: basisId, companyId: seen.companyId, payload: { basisId, itemId: seen.itemId, styleId: seen.styleId, change: 'archived' } })
      const row = await tools.tx.leatherCostBasis.findUniqueOrThrow({ where: { id: basisId }, select: BASIS_COLUMNS })
      return { basis: (await basisViews(tools.tx, [row], businessDate(tools.now)))[0]! }
    },
  )
  return result
}

// ---- uplifts -----------------------------------------------------------------------------------------------------------------

const UPLIFT_COLUMNS = {
  id: true,
  companyId: true,
  target: true,
  itemId: true,
  itemKind: true,
  partyId: true,
  key: true,
  source: true,
  freightPct: true,
  dutyPct: true,
  insurancePct: true,
  transportOutPerPiece: true,
  transportBackPerPiece: true,
  currency: true,
  landedFrom: true,
  landedTo: true,
  validFrom: true,
  status: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.MaterialCostUpliftSelect
type UpliftRow = Prisma.MaterialCostUpliftGetPayload<{ select: typeof UPLIFT_COLUMNS }>

const pctOf = (value: { toString(): string } | null): string | null => (value === null ? null : text(value))
const dayOrNull = (value: Date | null): string | null => (value === null ? null : dayOf(value))

function upliftView(row: UpliftRow, on: string): UpliftView {
  const validFrom = dayOf(row.validFrom)
  return {
    id: row.id,
    companyId: row.companyId,
    target: row.target,
    itemId: row.itemId,
    // A kind uplift is for a material's kind: never FINISHED (no BOM line names a finished garment).
    itemKind: row.itemKind as ItemKind | null,
    partyId: row.partyId,
    key: row.key,
    source: row.source,
    freightPct: pctOf(row.freightPct),
    dutyPct: pctOf(row.dutyPct),
    insurancePct: pctOf(row.insurancePct),
    transportOutPerPiece: asMoney('cost', textOrNull(row.transportOutPerPiece)),
    transportBackPerPiece: asMoney('cost', textOrNull(row.transportBackPerPiece)),
    currency: row.currency,
    landedFrom: dayOrNull(row.landedFrom),
    landedTo: dayOrNull(row.landedTo),
    validFrom,
    status: row.status,
    note: row.note,
    inForce: row.status === 'ACTIVE' && validFrom <= on,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

async function readUplift(caller: CommandCaller, upliftId: string): Promise<UpliftRow> {
  const context = contextOf(caller)
  const row = isUuid(upliftId) ? await caller.withClient((db) => db.materialCostUplift.findUnique({ where: { id: upliftId }, select: UPLIFT_COLUMNS })) : null
  if (!row || !can(actorOf(context), COSTING_VIEW, { companyId: row.companyId })) throw new NotFoundError('Cost uplift not found.')
  return row
}

/** GET /costing/uplifts */
export async function listUplifts(caller: CommandCaller, query: UpliftsQuery): Promise<{ uplifts: UpliftView[] }> {
  const context = contextOf(caller)
  if (query.companyId !== undefined) await assertCompany(caller, query.companyId)
  return caller.withClient(async (db) => {
    const scope = query.companyId === undefined ? (scopeWhere(actorOf(context), COSTING_VIEW, COMPANY_SCOPE) as Prisma.MaterialCostUpliftWhereInput) : companyOrTenant(query.companyId)
    const rows = await db.materialCostUplift.findMany({
      where: {
        AND: [
          scope,
          query.target ? { target: query.target } : {},
          query.itemId ? { itemId: query.itemId } : {},
          query.itemKind ? { itemKind: query.itemKind } : {},
          query.partyId ? { partyId: query.partyId } : {},
          query.status === 'ALL' ? {} : { status: query.status },
        ],
      },
      select: UPLIFT_COLUMNS,
      orderBy: [{ validFrom: 'desc' }, { id: 'asc' }],
      take: 500,
    })
    const on = today()
    return { uplifts: rows.map((row) => upliftView(row, on)) }
  })
}

/** GET /costing/uplifts/:upliftId */
export async function upliftRecord(caller: CommandCaller, upliftId: string): Promise<{ uplift: UpliftView }> {
  return { uplift: upliftView(await readUplift(caller, upliftId), today()) }
}

/**
 * The landed cost of a company's receipts of a material (or a kind) in a window of days: the lots received (POSTED receipts,
 * not reversed, not a customer's own), their received value, and the landed shares POSTED on them; the percent of the one on
 * the other.
 */
async function landedOf(db: Reader, companyId: string, which: { readonly itemId: string | null; readonly itemKind: ItemKind | null }, from: string, to: string) {
  const company = await db.company.findUniqueOrThrow({ where: { id: companyId }, select: { currency: true } })
  const currency = costingCurrency(company.currency)
  const items = which.itemId !== null ? [which.itemId] : (await db.item.findMany({ where: { kind: which.itemKind ?? undefined, OR: [{ companyId: null }, { companyId }] }, select: { id: true } })).map((row) => row.id)
  const moves = items.length === 0
    ? []
    : await db.stockMove.findMany({
        where: { companyId, reason: 'RECEIPT', reversalOfId: null, receiptLineId: { not: null }, lotId: { not: null }, itemId: { in: items }, occurredAt: { gte: businessDayStart(from), lt: businessDayRange(to).end } },
        select: { id: true, lotId: true },
      })
  const reversed = new Set((moves.length === 0 ? [] : await db.stockMove.findMany({ where: { reversalOfId: { in: moves.map((move) => move.id) } }, select: { reversalOfId: true } })).map((row) => row.reversalOfId))
  const owned = await ownedLots(db, moves.map((move) => move.lotId))
  const kept = moves.filter((move) => !reversed.has(move.id) && !owned.has(move.lotId!))
  const lots = [...new Set(kept.map((move) => move.lotId!))]
  const values = kept.length === 0 ? [] : await db.stockValuation.findMany({ where: { moveId: { in: kept.map((move) => move.id) }, currency }, select: { valueAmount: true } })
  const received = values.reduce((sum, row) => sum + row.valueAmount, 0)
  const shares = lots.length === 0 ? [] : await db.landedCostShare.findMany({ where: { lotId: { in: lots }, allocation: { status: 'POSTED', currency } }, select: { amount: true } })
  const landed = shares.reduce((sum, row) => sum + row.amount, 0)
  return { currency, lots: lots.length, received, landed, pct: landedPct(landed, received) }
}

/** GET /costing/uplifts/landed — what the landed cost of a window of receipts comes to, before an uplift is made from it. */
export async function landedPreview(caller: CommandCaller, query: LandedQuery) {
  await assertCompany(caller, query.companyId)
  if ((query.itemId === undefined) === (query.itemKind === undefined)) throw new ValidationError('Name the material or the kind of material.', [{ path: 'querystring/itemId', message: 'Give a material or a kind of material, one of them.' }])
  if (query.from > query.to) throw new ValidationError('The days are not valid.', [{ path: 'querystring/to', message: 'The last day is on or after the first.' }])
  return caller.withClient(async (db) => {
    const found = await landedOf(db, query.companyId, { itemId: query.itemId ?? null, itemKind: query.itemKind ?? null }, query.from, query.to)
    return {
      companyId: query.companyId,
      itemId: query.itemId ?? null,
      itemKind: query.itemKind ?? null,
      from: query.from,
      to: query.to,
      currency: found.currency,
      lots: found.lots,
      receivedAmount: asMoney('cost', found.received),
      landedAmount: asMoney('cost', found.landed),
      pct: asMoney('cost', found.pct),
      words: found.pct === null ? COMPONENT_REFUSAL_WORDS.NO_RECEIPTS : `${found.lots} lot${found.lots === 1 ? '' : 's'} received: their posted landed cost over their received value (freight, duty and broker's charges together; say which percent it fills).`,
    }
  })
}

/** The target's own column and what it names, checked (the database checks the company and the workshop's role too). */
async function targetProblems(db: Reader, body: CreateUpliftBody, companyId: string | null): Promise<Issue[]> {
  const issues: Issue[] = []
  const named = { MATERIAL: body.itemId ?? null, CATEGORY: body.itemKind ?? null, WORKSHOP: body.partyId ?? null } as const
  for (const [target, value] of Object.entries(named) as [UpliftTarget, string | null][]) {
    const field = target === 'MATERIAL' ? 'itemId' : target === 'CATEGORY' ? 'itemKind' : 'partyId'
    if (target === body.target && value === null) issues.push({ path: `body/${field}`, message: `An uplift of a ${target === 'CATEGORY' ? 'kind of material' : target.toLowerCase()} names it.` })
    if (target !== body.target && value !== null) issues.push({ path: `body/${field}`, message: 'An uplift names exactly its target.' })
  }
  if (body.target === 'MATERIAL' && body.itemId) {
    const item = await db.item.findUnique({ where: { id: body.itemId }, select: { companyId: true } })
    if (!item) throw new NotFoundError('Material not found.')
    if (item.companyId !== null && item.companyId !== companyId) issues.push({ path: 'body/itemId', message: "This material is one company's: its uplift is that company's." })
  }
  if (body.target === 'WORKSHOP' && body.partyId) {
    const party = await db.party.findUnique({ where: { id: body.partyId }, select: { roles: true, companyId: true } })
    if (!party) throw new NotFoundError('Workshop not found.')
    if (!party.roles.includes('SUBCONTRACTOR')) issues.push({ path: 'body/partyId', message: 'A transport uplift is for a workshop: a party with the subcontractor role.' })
    if (party.companyId !== null && party.companyId !== companyId) issues.push({ path: 'body/partyId', message: "This workshop is one company's: its uplift is that company's." })
  }
  return issues
}

/**
 * costing.createUplift: freight, duty and insurance percents on a material or a kind (typed, or LANDED_COST: the percent read
 * now from the landed cost of the receipts of landedFrom … landedTo, into the column `landedAs` names), or a workshop's
 * transport out and back per piece, from a day.
 */
export async function createUplift(caller: CommandCaller, body: CreateUpliftBody, idempotencyKey?: string): Promise<{ uplift: UpliftView }> {
  const context = contextOf(caller)
  const companyId = body.companyId ?? null
  assertMayKeep(context, companyId)
  if (companyId !== null) await assertCompany(caller, companyId)
  const landed = body.source === 'LANDED_COST'
  const issues: Issue[] = []
  if (landed) {
    if (body.target === 'WORKSHOP') issues.push({ path: 'body/source', message: 'A workshop’s transport is typed; landed cost is read for a material or a kind.' })
    if (companyId === null) issues.push({ path: 'body/companyId', message: "Landed cost is a company's: name the company." })
    if (!body.landedFrom || !body.landedTo) issues.push({ path: 'body/landedFrom', message: 'Name the first and last day of the receipts to read.' })
    else if (body.landedFrom > body.landedTo || body.landedTo > body.validFrom) issues.push({ path: 'body/landedTo', message: 'The receipts read come before the uplift starts: first day ≤ last day ≤ the uplift’s first day.' })
    for (const field of ['freightPct', 'dutyPct', 'insurancePct'] as const) if (body[field] !== undefined && body[field] !== null) issues.push({ path: `body/${field}`, message: 'The percent of a landed-cost uplift is read from the receipts; say which one it fills with landedAs.' })
  } else {
    if (body.landedFrom || body.landedTo || body.landedAs) issues.push({ path: 'body/landedFrom', message: 'Receipt days and landedAs are for an uplift read from landed cost only.' })
    issues.push(...upliftFigureProblems(body.target, body))
  }
  if (issues.length > 0) throw new ValidationError('The cost uplift is not valid.', issues)
  const key = upliftKey(companyId, { target: body.target, itemId: body.itemId ?? null, itemKind: body.itemKind ?? null, partyId: body.partyId ?? null })
  const { result } = await command(caller, { name: 'costing.createUplift', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const problems = await targetProblems(tx, body, companyId)
    if (problems.length > 0) throw new ValidationError('The cost uplift is not valid.', problems)
    let percents = { freightPct: body.freightPct ?? null, dutyPct: body.dutyPct ?? null, insurancePct: body.insurancePct ?? null }
    if (landed) {
      const found = await landedOf(tx, companyId!, { itemId: body.itemId ?? null, itemKind: body.itemKind ?? null }, body.landedFrom!, body.landedTo!)
      if (found.pct === null) throw refusedWith('NO_RECEIPTS')
      if (new Dec(found.pct).gt(100)) throw new ValidationError('The cost uplift is not valid.', [{ path: 'body/landedTo', message: 'The landed cost of those receipts is more than their value: check the landed charges before reading a percent from them.' }])
      const as = body.landedAs ?? 'FREIGHT'
      percents = { freightPct: as === 'FREIGHT' ? found.pct : null, dutyPct: as === 'DUTY' ? found.pct : null, insurancePct: as === 'INSURANCE' ? found.pct : null }
    }
    if (await tx.materialCostUplift.findFirst({ where: { key, validFrom: dateOf(body.validFrom) }, select: { id: true } })) throw refusedWith('START_TAKEN')
    const id = newId()
    const transport = body.target === 'WORKSHOP'
    const row = await tx.materialCostUplift.create({
      data: {
        id,
        companyId,
        target: body.target,
        itemId: body.target === 'MATERIAL' ? body.itemId! : null,
        itemKind: body.target === 'CATEGORY' ? body.itemKind! : null,
        partyId: transport ? body.partyId! : null,
        key,
        source: body.source,
        ...percents,
        transportOutPerPiece: transport ? (body.transportOutPerPiece ?? null) : null,
        transportBackPerPiece: transport ? (body.transportBackPerPiece ?? null) : null,
        currency: transport ? (body.currency ?? null) : null,
        landedFrom: landed ? dateOf(body.landedFrom!) : null,
        landedTo: landed ? dateOf(body.landedTo!) : null,
        validFrom: dateOf(body.validFrom),
        note: body.note ?? null,
        createdAt: now,
        updatedAt: now,
        createdById: officeActor(tools.context),
      },
      select: UPLIFT_COLUMNS,
    })
    tools.audit({
      recordType: 'MaterialCostUplift',
      recordId: id,
      companyId,
      after: {
        companyId,
        target: body.target,
        key,
        source: body.source,
        ...percents,
        transportOutPerPiece: markMoney('cost', row.transportOutPerPiece === null ? null : text(row.transportOutPerPiece)),
        transportBackPerPiece: markMoney('cost', row.transportBackPerPiece === null ? null : text(row.transportBackPerPiece)),
        currency: row.currency,
        landedFrom: body.landedFrom ?? null,
        landedTo: body.landedTo ?? null,
        validFrom: body.validFrom,
        status: 'ACTIVE',
      },
    })
    tools.emit({ type: 'cost_uplift.changed', subject: id, companyId, payload: { upliftId: id, target: body.target, change: 'created' } })
    return { uplift: upliftView(row, businessDate(now)) }
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw refusedWith('START_TAKEN')
    throw componentRefusalOf(error)
  })
  return result
}

const UPLIFT_FIELDS = ['freightPct', 'dutyPct', 'insurancePct', 'transportOutPerPiece', 'transportBackPerPiece', 'currency', 'note'] as const
type UpliftField = (typeof UPLIFT_FIELDS)[number]
const TRANSPORT_FIELDS: readonly UpliftField[] = ['transportOutPerPiece', 'transportBackPerPiece']

/** costing.updateUplift: a correction of an ACTIVE uplift (its figures or note); a landed-cost uplift's percents stay as read. */
export async function updateUplift(caller: CommandCaller, upliftId: string, body: UpdateUpliftBody, idempotencyKey?: string): Promise<{ uplift: UpliftView }> {
  const context = contextOf(caller)
  const seen = await readUplift(caller, upliftId)
  assertMayKeep(context, seen.companyId)
  const { result } = await command(caller, { name: 'costing.updateUplift', idempotencyKey, input: { upliftId, ...body }, record: { type: 'MaterialCostUplift', id: upliftId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const row = await tx.materialCostUplift.findUniqueOrThrow({ where: { id: upliftId }, select: UPLIFT_COLUMNS })
    if (row.status !== 'ACTIVE') throw refusedWith('ARCHIVED')
    const current: Record<UpliftField, string | null> = {
      freightPct: pctOf(row.freightPct),
      dutyPct: pctOf(row.dutyPct),
      insurancePct: pctOf(row.insurancePct),
      transportOutPerPiece: textOrNull(row.transportOutPerPiece),
      transportBackPerPiece: textOrNull(row.transportBackPerPiece),
      currency: row.currency,
      note: row.note,
    }
    const sent: Partial<Record<UpliftField, string | null>> = Object.fromEntries(
      UPLIFT_FIELDS.flatMap((field) => {
        const value = body[field]
        if (value === undefined) return []
        return [[field, value === null || field === 'currency' || field === 'note' ? value : decimalText(value)]]
      }),
    )
    const changed = UPLIFT_FIELDS.filter((field) => field in sent && sent[field] !== current[field])
    if (changed.length === 0) throw refusedWith('NOTHING_CHANGES')
    if (row.source === 'LANDED_COST' && changed.some((field) => field !== 'note')) {
      throw new ValidationError('The cost uplift is not valid.', [{ path: `body/${changed.find((field) => field !== 'note')}`, message: 'A landed-cost uplift keeps the percent read from its receipts: make a new one from a later day to change it.' }])
    }
    const next = { ...current, ...sent }
    const problems = upliftFigureProblems(row.target, next)
    if (problems.length > 0) throw new ValidationError('The cost uplift is not valid.', problems)
    const data = Object.fromEntries(changed.map((field) => [field, next[field]])) as Prisma.MaterialCostUpliftUncheckedUpdateInput
    const updated = await tx.materialCostUplift.update({ where: { id: upliftId }, data: { ...data, updatedAt: now }, select: UPLIFT_COLUMNS })
    const pick = (values: Record<UpliftField, string | null>) => Object.fromEntries(changed.map((field) => [field, TRANSPORT_FIELDS.includes(field) ? markMoney('cost', values[field]) : values[field]]))
    tools.audit({ recordType: 'MaterialCostUplift', recordId: upliftId, companyId: row.companyId, before: pick(current), after: pick(next) })
    tools.emit({ type: 'cost_uplift.changed', subject: upliftId, companyId: row.companyId, payload: { upliftId, target: row.target, change: 'updated' } })
    return { uplift: upliftView(updated, businessDate(now)) }
  }).catch((error: unknown) => {
    throw componentRefusalOf(error)
  })
  return result
}

/** costing.archiveUplift: no cost sheet takes it any more (final). */
export async function archiveUplift(caller: CommandCaller, upliftId: string, body: ArchiveBody, idempotencyKey?: string): Promise<{ uplift: UpliftView }> {
  const context = contextOf(caller)
  const seen = await readUplift(caller, upliftId)
  assertMayKeep(context, seen.companyId)
  if (seen.status !== 'ACTIVE') throw refusedWith('ARCHIVED')
  const { result } = await command(
    caller,
    { name: 'costing.archiveUplift', idempotencyKey, input: { upliftId, ...body }, record: { type: 'MaterialCostUplift', id: upliftId, expectedVersion: body.version, transition: { machine: componentInputMachine, to: 'ARCHIVED' } } },
    async (tools) => {
      tools.audit({ recordType: 'MaterialCostUplift', recordId: upliftId, companyId: seen.companyId, before: { status: tools.record!.from }, after: { status: 'ARCHIVED' }, ...(body.reason ? { reason: body.reason } : {}) })
      tools.emit({ type: 'cost_uplift.changed', subject: upliftId, companyId: seen.companyId, payload: { upliftId, target: seen.target, change: 'archived' } })
      return { uplift: upliftView(await tools.tx.materialCostUplift.findUniqueOrThrow({ where: { id: upliftId }, select: UPLIFT_COLUMNS }), businessDate(tools.now)) }
    },
  )
  return result
}

// ---- piece-rate labour (GATE-PIECE-PAY) -----------------------------------------------------------------------------------

const SETTINGS = { id: true, companyId: true, costingMethod: true, pieceRateLabour: true, pieceRateLabourAt: true, version: true } as const satisfies Prisma.CostingSettingsSelect

/** The sites of the company whose piece pay is ON (the database's condition for switching on). */
async function switchedOnSites(db: Reader, companyId: string): Promise<string[]> {
  return (await db.piecePaySwitch.findMany({ where: { companyId, state: 'ON' }, select: { siteId: true } })).map((row) => row.siteId)
}

async function pieceRateView(db: Reader, context: RequestContext, companyId: string, on: string) {
  const own = await db.costingSettings.findUnique({ where: { id: companyId }, select: SETTINGS })
  const row = own && own.companyId === companyId ? own : null
  const paying = await payingSitesOf(db, companyId, on)
  const sites = paying.length === 0 ? [] : await db.site.findMany({ where: { id: { in: paying } }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } })
  const manage = can(actorOf(context), COSTING_RATES_MANAGE, { companyId })
  const switchable = (await switchedOnSites(db, companyId)).length > 0
  const isOn = row?.pieceRateLabour ?? false
  return {
    companyId,
    on: isOn,
    onAt: row?.pieceRateLabourAt ? toUtcIso(row.pieceRateLabourAt) : null,
    payingSites: sites,
    settingsVersion: row?.version ?? null,
    can: { manage, switchOn: manage && switchable && !isOn },
    words: !isOn && !switchable ? `${pieceRateWords(false, 0)} ${COMPONENT_REFUSAL_WORDS.PIECE_PAY_OFF}` : pieceRateWords(isOn, sites.length),
  }
}

/** GET /costing/piece-rate-labour?companyId */
export async function pieceRateLabour(caller: CommandCaller, companyId: string) {
  const context = await assertCompany(caller, companyId)
  return caller.withClient((db) => pieceRateView(db, context, companyId, today()))
}

/**
 * costing.setPieceRateLabour — PUT /costing/piece-rate-labour: piece-rate labour on or off on the company's cost sheets (its
 * own costing settings row: made here when it has none, following the tenant-wide overhead and method). On only while a site
 * of the company has piece pay ON (GATE-PIECE-PAY); off always.
 */
export async function setPieceRateLabour(caller: CommandCaller, body: SetPieceRateLabourBody, idempotencyKey?: string) {
  const context = await assertCompany(caller, body.companyId)
  if (!can(actorOf(context), COSTING_RATES_MANAGE, { companyId: body.companyId })) throw new ForbiddenError()
  const existing = await caller.withClient((db) => db.costingSettings.findUnique({ where: { id: body.companyId }, select: SETTINGS }))
  const own = existing && existing.companyId === body.companyId ? existing : null
  if (own && body.version === undefined) throw new ConflictError("The company's costing settings exist: send their version to switch piece-rate labour.")
  if (!own && body.version !== undefined) throw new ConflictError("The company has no costing settings of its own yet: switch piece-rate labour without a version.")
  if ((own?.pieceRateLabour ?? false) === body.on) throw refusedWith('NOTHING_CHANGES')
  const { result } = await command(
    caller,
    { name: 'costing.setPieceRateLabour', idempotencyKey, input: body, ...(own ? { record: { type: 'CostingSettings' as const, id: body.companyId, expectedVersion: body.version! } } : {}) },
    async (tools) => {
      const { tx, now } = tools
      if (body.on && (await switchedOnSites(tx, body.companyId)).length === 0) throw refusedWith('PIECE_PAY_OFF')
      const actorId = officeActor(tools.context)
      const figures = { pieceRateLabour: body.on, pieceRateLabourAt: body.on ? now : null, pieceRateLabourById: body.on ? actorId : null }
      if (!own) {
        // A company's row made for this switch follows the tenant-wide overhead and method (B-W2b-22's overheadFromTenant).
        const tenantRow = await tx.costingSettings.findFirst({ where: { companyId: null }, select: { costingMethod: true } })
        await tx.costingSettings.create({ data: { id: body.companyId, companyId: body.companyId, overheadPct: '0', overheadFromTenant: true, costingMethod: tenantRow?.costingMethod ?? 'UNDECIDED', ...figures, createdAt: now, updatedAt: now, createdById: actorId }, select: { id: true } })
      } else {
        await tx.costingSettings.update({ where: { id: body.companyId }, data: { ...figures, updatedAt: now }, select: { id: true } })
      }
      tools.audit({ recordType: 'CostingSettings', recordId: body.companyId, companyId: body.companyId, before: { pieceRateLabour: own?.pieceRateLabour ?? false }, after: { pieceRateLabour: body.on, ...(own ? {} : { overheadFromTenant: true }) } })
      tools.emit({ type: 'costing_settings.changed', subject: body.companyId, companyId: body.companyId, payload: { settingsId: body.companyId, fields: ['pieceRateLabour'] } })
      return pieceRateView(tx, tools.context, body.companyId, businessDate(now))
    },
  ).catch((error: unknown) => {
    throw componentRefusalOf(error)
  })
  return result
}
