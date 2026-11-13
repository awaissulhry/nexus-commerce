import type { Prisma } from '@nexus/factory-db'
import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, grantsFor, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { QUOTES_TEMPLATES_MANAGE } from '@nexus/factory-domain/sales/quote-templates/permissions'
import { QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
import { curveNameProblems, curveWords, sharesOf, sharesProblems, storedShares, type SizeCurveChange } from '@nexus/factory-domain/sales/size-curves/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { databaseRefusal } from '../quote-templates/store'
import { officeContextOf, type Reader } from '../quotes/store'

/**
 * Size curves (B-W2b-302; SAL-269; design sales.settings ssettings.curves "Saved percent curves for 'Fill by curve'": curve
 * name, scale, % per size that must total 100 %, the total shown live and Save held until 100 %). factory-db SizeCurve: a
 * curve of a company, or of every company (companyId null), over one size scale (fixed, as the company), named once per
 * scale, its shares totalling exactly 100 (the database checks the same). Never deleted: archived and restored.
 *
 *   read   quotes.view over its company (a curve of every company: anyone who reads quotes) — the quote's Fill by curve picks
 *          from them
 *   keep   quotes.templates.manage over its company (a curve of every company: over every company) — the saved starts of
 *          quotes (B-W2b-294's permission: sales and finance, who keep the quote templates beside them in Sales settings)
 *
 * Each write is one command; `size_curve.changed` follows (CREATED, UPDATED, ARCHIVED, RESTORED).
 */

export const CURVE_COLUMNS = { id: true, companyId: true, sizeScaleId: true, name: true, shares: true, status: true, version: true, createdAt: true, updatedAt: true } as const satisfies Prisma.SizeCurveSelect
export type CurveRow = Prisma.SizeCurveGetPayload<{ select: typeof CURVE_COLUMNS }>

const mayRead = (context: OfficeContext, curve: Pick<CurveRow, 'companyId'>): boolean => can(actorOf(context), QUOTES_VIEW, curve.companyId ? { companyId: curve.companyId } : {})

function assertMayKeep(context: OfficeContext, companyId: string | null): void {
  const actor = actorOf(context)
  if (companyId !== null ? can(actor, QUOTES_TEMPLATES_MANAGE, { companyId }) : grantsFor(actor, QUOTES_TEMPLATES_MANAGE).some((grant) => grant.companies === 'all')) return
  throw new ForbiddenError(companyId === null ? 'A size curve of every company is kept only with quotes.templates.manage over every company.' : 'Keeping this size curve needs quotes.templates.manage for its company.')
}

const invalid = (issues: readonly Issue[], fallback = 'The size curve cannot be saved.'): ValidationError => new ValidationError(issues.length === 1 ? issues[0]!.message : fallback, [...issues])

/** The scale's sizes in their order (ACTIVE and archived: a curve keeps an archived size's share). */
async function scaleOf(db: Reader, scaleId: string) {
  const scale = isUuid(scaleId) ? await db.sizeScale.findUnique({ where: { id: scaleId }, select: { id: true, code: true, name: true, companyId: true, status: true } }) : null
  if (!scale) return null
  const sizes = await db.size.findMany({ where: { scaleId: scale.id }, select: { code: true }, orderBy: [{ seq: 'asc' }, { code: 'asc' }] })
  return { ...scale, sizes: sizes.map((row) => row.code) }
}

/** A curve as every reader sees it. */
async function curveViews(db: Reader, rows: readonly CurveRow[]) {
  const scaleIds = [...new Set(rows.map((row) => row.sizeScaleId))]
  const scales = new Map<string, NonNullable<Awaited<ReturnType<typeof scaleOf>>>>()
  for (const id of scaleIds) {
    const scale = await scaleOf(db, id)
    if (scale) scales.set(id, scale)
  }
  const companyIds = [...new Set(rows.flatMap((row) => (row.companyId ? [row.companyId] : [])))]
  const companies = new Map((companyIds.length === 0 ? [] : await db.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, code: true, legalName: true } })).map((row) => [row.id, { id: row.id, code: row.code, name: row.legalName }]))
  return rows.map((row) => {
    const scale = scales.get(row.sizeScaleId)
    const shares = sharesOf(storedShares(row.shares), scale?.sizes ?? [])
    return {
      id: row.id,
      companyId: row.companyId,
      company: row.companyId ? (companies.get(row.companyId) ?? null) : null,
      sizeScale: { id: row.sizeScaleId, code: scale?.code ?? '', name: scale?.name ?? '', sizes: scale?.sizes ?? [] },
      name: row.name,
      shares,
      words: curveWords(shares),
      status: row.status as 'ACTIVE' | 'ARCHIVED',
      version: row.version,
      createdAt: toUtcIso(row.createdAt),
      updatedAt: toUtcIso(row.updatedAt),
    }
  })
}
export type CurveView = Awaited<ReturnType<typeof curveViews>>[number]

export async function readCurve(db: Reader, curveId: string): Promise<CurveRow | null> {
  return isUuid(curveId) ? db.sizeCurve.findUnique({ where: { id: curveId }, select: CURVE_COLUMNS }) : null
}

/** A curve the caller may read (else 404). */
export async function officeCurve(caller: CommandCaller, curveId: string): Promise<{ context: OfficeContext; curve: CurveRow }> {
  const context = officeContextOf(caller)
  const curve = await caller.withClient((db) => readCurve(db, curveId))
  if (!curve || !mayRead(context, curve)) throw new NotFoundError('Size curve not found.')
  return { context, curve }
}

/** The curve's view inside a command (the answer of every write). */
const viewIn = async (db: Reader, curveId: string): Promise<CurveView> => (await curveViews(db, [(await readCurve(db, curveId))!]))[0]!

function emitChanged(tools: CommandTools, curve: Pick<CurveRow, 'id' | 'companyId' | 'sizeScaleId'>, change: SizeCurveChange, fields: string[]): void {
  tools.emit({ type: 'size_curve.changed', subject: curve.id, companyId: curve.companyId, payload: { sizeCurveId: curve.id, companyId: curve.companyId, sizeScaleId: curve.sizeScaleId, change, fields } })
}

/** GET /sales/size-curves: the curves the caller reads (a company's and every company's), by scale and name. */
export async function listCurves(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly sizeScaleId?: string | undefined; readonly status: 'ACTIVE' | 'ARCHIVED' | 'ALL' }) {
  const context = officeContextOf(caller)
  const reach = scopeWhere(actorOf(context), QUOTES_VIEW, { company: { field: 'companyId', nullable: true } }) as Prisma.SizeCurveWhereInput
  const where: Prisma.SizeCurveWhereInput = {
    AND: [reach, query.companyId ? { OR: [{ companyId: query.companyId }, { companyId: null }] } : {}, query.sizeScaleId ? { sizeScaleId: query.sizeScaleId } : {}, query.status === 'ALL' ? {} : { status: query.status }],
  }
  return caller.withClient(async (db) => {
    const rows = await db.sizeCurve.findMany({ where, select: CURVE_COLUMNS, orderBy: [{ sizeScaleId: 'asc' }, { name: 'asc' }, { id: 'asc' }], take: 500 })
    return { curves: await curveViews(db, rows) }
  })
}

/** GET /sales/size-curves/:curveId */
export async function getCurve(caller: CommandCaller, curveId: string) {
  const { curve } = await officeCurve(caller, curveId)
  return { curve: await caller.withClient((db) => viewIn(db, curve.id)) }
}

export interface CreateCurveBody {
  readonly companyId?: string | null | undefined
  readonly sizeScaleId: string
  readonly name: string
  readonly shares: Readonly<Record<string, string>>
}

/** POST /sales/size-curves (quotes.templates.manage over the company, or every company for a curve of every company). */
export async function createCurve(caller: CommandCaller, body: CreateCurveBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const companyId = body.companyId ?? null
  assertMayKeep(context, companyId)
  const { result } = await command(caller, { name: 'sales.sizeCurves.create', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    const scale = await scaleOf(tx, body.sizeScaleId)
    if (!scale) throw invalid([{ path: 'body/sizeScaleId', message: 'Not a size scale.' }])
    if (scale.companyId !== null && scale.companyId !== companyId) throw invalid([{ path: 'body/sizeScaleId', message: companyId === null ? "A curve of every company takes a scale of every company: this scale is one company's." : "Not a scale of this company (or of every company)." }])
    if (scale.status === 'ARCHIVED') throw invalid([{ path: 'body/sizeScaleId', message: `${scale.code} is archived: choose an active scale.` }])
    const issues = [...curveNameProblems(body.name), ...sharesProblems(body.shares, scale.sizes)]
    if (issues.length > 0) throw invalid(issues)
    const clash = await tx.sizeCurve.findFirst({ where: { sizeScaleId: scale.id, name: body.name.trim() }, select: { id: true } })
    if (clash) throw new DomainError('conflict', `A curve "${body.name.trim()}" of ${scale.code} already exists: give this one another name.`, [{ path: 'body/name', message: 'The name is taken on this scale.' }])
    const id = newId()
    const shares = sharesOf(body.shares, scale.sizes)
    await tx.sizeCurve.create({ data: { id, companyId, sizeScaleId: scale.id, name: body.name.trim(), shares, createdById: context.actorId }, select: { id: true } }).catch(databaseRefusal)
    tools.audit({ action: 'sales.sizeCurves.create', recordType: 'SizeCurve', recordId: id, companyId, after: { name: body.name.trim(), sizeScaleId: scale.id, shares } })
    emitChanged(tools, { id, companyId, sizeScaleId: scale.id }, 'CREATED', ['name', 'shares'])
    return { curve: await viewIn(tx, id) }
  })
  return result
}

export interface UpdateCurveBody {
  readonly version: number
  readonly name?: string | undefined
  readonly shares?: Readonly<Record<string, string>> | undefined
}

/** PATCH /sales/size-curves/:curveId: its name and its whole shares, at its version (an archived curve is restored first). */
export async function updateCurve(caller: CommandCaller, curveId: string, body: UpdateCurveBody, idempotencyKey?: string) {
  const { context, curve } = await officeCurve(caller, curveId)
  assertMayKeep(context, curve.companyId)
  const fields = (['name', 'shares'] as const).filter((field) => body[field] !== undefined)
  if (fields.length === 0) throw invalid([{ path: 'body', message: 'Send the name or the shares to change.' }], 'Nothing to change.')
  const { result } = await command(caller, { name: 'sales.sizeCurves.update', idempotencyKey, input: { curveId, ...body }, record: { type: 'SizeCurve', id: curve.id, expectedVersion: body.version } }, async (tools) => {
    const { tx } = tools
    const current = (await readCurve(tx, curve.id))!
    if (current.status === 'ARCHIVED') throw new InvalidStateError('The size curve is archived: restore it before changing it.')
    const scale = (await scaleOf(tx, current.sizeScaleId))!
    const issues = [...curveNameProblems(body.name), ...(body.shares ? sharesProblems(body.shares, scale.sizes) : [])]
    if (issues.length > 0) throw invalid(issues)
    const name = body.name?.trim() ?? current.name
    if (name !== current.name && (await tx.sizeCurve.findFirst({ where: { sizeScaleId: current.sizeScaleId, name, id: { not: current.id } }, select: { id: true } }))) {
      throw new DomainError('conflict', `A curve "${name}" of ${scale.code} already exists: give this one another name.`, [{ path: 'body/name', message: 'The name is taken on this scale.' }])
    }
    const before = { name: current.name, shares: storedShares(current.shares) }
    const shares = body.shares ? sharesOf(body.shares, scale.sizes) : before.shares
    await tx.sizeCurve.update({ where: { id: current.id }, data: { name, shares }, select: { id: true } }).catch(databaseRefusal)
    tools.audit({ action: 'sales.sizeCurves.update', recordType: 'SizeCurve', recordId: current.id, companyId: current.companyId, before, after: { name, shares } })
    emitChanged(tools, current, 'UPDATED', [...fields])
    return { curve: await viewIn(tx, current.id) }
  })
  return result
}

export interface CurveStatusBody {
  readonly curves: readonly { readonly id: string; readonly version: number }[]
  readonly status: 'ACTIVE' | 'ARCHIVED'
}

/** POST /sales/size-curves/status: the selection archived or restored, each at its version; all or none. */
export async function setCurveStatus(caller: CommandCaller, body: CurveStatusBody, idempotencyKey?: string) {
  const seen: { curve: CurveRow; version: number }[] = []
  for (const entry of body.curves) {
    const { context, curve } = await officeCurve(caller, entry.id)
    assertMayKeep(context, curve.companyId)
    seen.push({ curve, version: entry.version })
  }
  const { result } = await command(caller, { name: 'sales.sizeCurves.status', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const ids = [...new Set(seen.map((one) => one.curve.id))].sort()
    const rows = await tx.$queryRaw<{ id: string; version: number; status: string }[]>`SELECT "id"::text AS "id", "version", "status"::text AS "status" FROM "SizeCurve" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR UPDATE`
    let moved = 0
    for (const one of seen) {
      const row = rows.find((candidate) => candidate.id === one.curve.id)
      if (!row) throw new NotFoundError('Size curve not found.')
      if (row.version !== one.version) throw new StaleVersionError('SizeCurve', one.curve.id, row.version, one.version)
      if (row.status === body.status) continue
      // A curve restored keeps its name: another curve of the scale may have taken it meanwhile (the unique says so).
      await tx.sizeCurve.update({ where: { id: one.curve.id }, data: { status: body.status, version: row.version + 1, updatedAt: now }, select: { id: true } }).catch(databaseRefusal)
      tools.audit({ action: 'sales.sizeCurves.status', recordType: 'SizeCurve', recordId: one.curve.id, companyId: one.curve.companyId, before: { status: row.status }, after: { status: body.status } })
      emitChanged(tools, one.curve, body.status === 'ARCHIVED' ? 'ARCHIVED' : 'RESTORED', ['status'])
      moved++
    }
    // Nothing moved: still one audit row (every command records one), naming the selection.
    if (moved === 0) tools.audit({ action: 'sales.sizeCurves.status', recordType: 'SizeCurve', recordId: ids[0]!, companyId: seen[0]!.curve.companyId, after: { status: body.status, unchanged: ids } })
    return { curves: await curveViews(tx, await tx.sizeCurve.findMany({ where: { id: { in: ids } }, select: CURVE_COLUMNS, orderBy: { id: 'asc' } })) }
  })
  return result
}
