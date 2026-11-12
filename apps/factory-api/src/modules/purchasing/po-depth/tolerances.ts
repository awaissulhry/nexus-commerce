import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, grantsFor, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PURCHASING_TOLERANCES_MANAGE } from '@nexus/factory-domain/purchasing/po-depth/permissions'
import { sameScope, toleranceProblems, type ToleranceAction } from '@nexus/factory-domain/purchasing/po-depth/tolerances'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import type { ItemKind } from '@nexus/factory-domain/product/materials/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { officeContextOf, type Reader } from '../store'

/**
 * Delivery tolerances (B-W2b-296; SCM-061; design purchasing.settings "Delivery tolerances"; factory-db buying-depth.prisma
 * DeliveryTolerance): how far over or under the ordered quantity a receipt may be, per company (or every company), supplier
 * (or every supplier) and material, kind of material or every material; beyond it the extra is refused or waits for a
 * yes. Read at every receipt (purchasing/receiving.ts receiptTolerancesOf; the rules are factory-domain
 * purchasing/po-depth/tolerances). One ACTIVE rule per scope; a rule's scope never changes (archive it and add another);
 * archived, never deleted.
 *
 *   GET  /purchasing/tolerances?companyId&supplierId&itemId&status    purchasing.view (a company's rows over that company;
 *                                                                    every company's rows to every reader of purchasing)
 *   POST /purchasing/tolerances                                       purchasing.tolerances.manage over the company (every
 *   PATCH /purchasing/tolerances/:toleranceId                         company's: a role over every company)
 *   POST /purchasing/tolerances/:toleranceId/archive | reactivate     the same
 */

const COLUMNS = {
  id: true,
  companyId: true,
  supplierId: true,
  itemId: true,
  itemKind: true,
  overPct: true,
  underPct: true,
  whenBeyond: true,
  status: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  updatedById: true,
  company: { select: { code: true, legalName: true } },
  supplier: { select: { code: true, legalName: true, roles: true } },
  item: { select: { code: true, name: true } },
} as const satisfies Prisma.DeliveryToleranceSelect
type Row = Prisma.DeliveryToleranceGetPayload<{ select: typeof COLUMNS }>

const everyCompany = (context: OfficeContext, permission: Permission): boolean => grantsFor(actorOf(context), permission).some((grant) => grant.companies === 'all')
const mayAt = (context: OfficeContext, permission: Permission, companyId: string | null): boolean => (companyId === null ? everyCompany(context, permission) : can(actorOf(context), permission, { companyId }))
const percentText = (value: { toString(): string }): string => new Dec(value.toString()).toString()
const KIND_WORDS: Readonly<Record<string, string>> = { LEATHER: 'leather', TEXTILE: 'textiles', LINING: 'linings', MEMBRANE: 'membranes', PADDING: 'padding', THREAD: 'thread', TRIM: 'trims', HARDWARE: 'hardware', PROTECTOR: 'protectors', LABEL: 'labels', PACKAGING: 'packaging', COMPONENT: 'components' }

function viewOf(context: OfficeContext, row: Row) {
  const scope = [row.company ? row.company.legalName : 'Every company', row.supplier ? row.supplier.legalName : 'every supplier', row.item ? `${row.item.code} ${row.item.name}` : row.itemKind ? KIND_WORDS[row.itemKind] ?? row.itemKind : 'every material'].join(' · ')
  return {
    id: row.id,
    companyId: row.companyId,
    company: row.company ? { code: row.company.code, name: row.company.legalName } : null,
    supplierId: row.supplierId,
    supplier: row.supplier ? { code: row.supplier.code, name: row.supplier.legalName } : null,
    itemId: row.itemId,
    item: row.item ? { code: row.item.code, name: row.item.name } : null,
    itemKind: row.itemKind as ItemKind | null,
    overPct: percentText(row.overPct),
    underPct: percentText(row.underPct),
    whenBeyond: row.whenBeyond as ToleranceAction,
    status: row.status as 'ACTIVE' | 'ARCHIVED',
    note: row.note,
    scope,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
    updatedById: row.updatedById,
    mayChange: mayAt(context, PURCHASING_TOLERANCES_MANAGE, row.companyId),
  }
}
export type ToleranceView = ReturnType<typeof viewOf>

/** The rows the caller may read: every company's, and those of the companies it may see purchasing of. */
const visible = (context: OfficeContext, row: Pick<Row, 'companyId'>): boolean => row.companyId === null || can(actorOf(context), PURCHASING_VIEW, { companyId: row.companyId })

export async function listTolerances(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly supplierId?: string | undefined; readonly itemId?: string | undefined; readonly status?: 'ACTIVE' | 'ARCHIVED' | undefined }) {
  const context = officeContextOf(caller)
  if (query.companyId && !can(actorOf(context), PURCHASING_VIEW, { companyId: query.companyId })) throw new NotFoundError('Company not found.')
  const where: Prisma.DeliveryToleranceWhereInput = {
    ...(query.companyId ? { OR: [{ companyId: null }, { companyId: query.companyId }] } : {}),
    ...(query.supplierId ? { supplierId: query.supplierId } : {}),
    ...(query.itemId ? { itemId: query.itemId } : {}),
    ...(query.status ? { status: query.status } : {}),
  }
  const rows = await caller.withClient((client) => client.deliveryTolerance.findMany({ where, select: COLUMNS, orderBy: [{ status: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }], take: 1000 }))
  return { tolerances: rows.filter((row) => visible(context, row)).map((row) => viewOf(context, row)) }
}

export interface ToleranceBody {
  readonly companyId: string | null
  readonly supplierId: string | null
  readonly itemId: string | null
  readonly itemKind: ItemKind | null
  readonly overPct: string
  readonly underPct: string
  readonly whenBeyond: ToleranceAction
  readonly note?: string | null | undefined
}

const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/** Another ACTIVE rule of the same scope: a 409 in words. */
async function assertOnlyOne(tx: Reader, scope: { readonly companyId: string | null; readonly supplierId: string | null; readonly itemId: string | null; readonly itemKind: string | null }, except: string | null): Promise<void> {
  const others = await tx.deliveryTolerance.findMany({ where: { status: 'ACTIVE', companyId: scope.companyId, supplierId: scope.supplierId, itemId: scope.itemId, itemKind: scope.itemKind as ItemKind | null, ...(except ? { id: { not: except } } : {}) }, select: { id: true, companyId: true, supplierId: true, itemId: true, itemKind: true } })
  if (others.some((other) => sameScope(other, scope))) throw new ConflictError('An active delivery tolerance of this company, supplier and material already exists: change that one, or archive it first.')
}

/** The scope's parts exist and fit: the company, a supplier, a material (never a finished garment). */
async function assertScope(tools: CommandTools, body: Pick<ToleranceBody, 'companyId' | 'supplierId' | 'itemId'>): Promise<void> {
  const { tx } = tools
  if (body.companyId !== null && !(await tx.company.findUnique({ where: { id: body.companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
  if (body.supplierId !== null) {
    const party = await tx.party.findUnique({ where: { id: body.supplierId }, select: { legalName: true, roles: true } })
    if (!party) throw new NotFoundError('Supplier not found.')
    if (!party.roles.some((role) => role === 'SUPPLIER' || role === 'SUBCONTRACTOR')) throw new ValidationError(`${party.legalName} is not a supplier.`, [{ path: 'body/supplierId', message: 'A supplier or a workshop that sells us material.' }])
  }
  if (body.itemId !== null) {
    const item = await tx.item.findUnique({ where: { id: body.itemId }, select: { kind: true, companyId: true, code: true } })
    if (!item || (item.companyId !== null && body.companyId !== null && item.companyId !== body.companyId)) throw new NotFoundError('Material not found.')
    if (item.kind === 'FINISHED') throw new ValidationError(`${item.code} is a finished garment: it takes no delivery tolerance.`, [{ path: 'body/itemId', message: 'A material.' }])
  }
}

export async function createTolerance(caller: CommandCaller, body: ToleranceBody, idempotencyKey?: string): Promise<{ tolerance: ToleranceView }> {
  const context = officeContextOf(caller)
  if (body.companyId !== null && !can(actorOf(context), PURCHASING_VIEW, { companyId: body.companyId })) throw new NotFoundError('Company not found.')
  if (!mayAt(context, PURCHASING_TOLERANCES_MANAGE, body.companyId)) throw new ForbiddenError(body.companyId === null ? 'A tolerance of every company is kept only by a role over every company.' : 'Keeping delivery tolerances needs purchasing.tolerances.manage.')
  const note = blank(body.note)
  const problems = toleranceProblems({ itemId: body.itemId, itemKind: body.itemKind, overPct: body.overPct, underPct: body.underPct, note })
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const { result } = await command(caller, { name: 'purchasing.tolerances.create', idempotencyKey, input: body }, async (tools) => {
    await assertScope(tools, body)
    await assertOnlyOne(tools.tx, body, null)
    const id = newId()
    await tools.tx.deliveryTolerance.create({
      data: { id, companyId: body.companyId, supplierId: body.supplierId, itemId: body.itemId, itemKind: body.itemKind, overPct: body.overPct.trim(), underPct: body.underPct.trim(), whenBeyond: body.whenBeyond, note, createdById: context.actorId, updatedById: context.actorId },
      select: { id: true },
    })
    const row = await tools.tx.deliveryTolerance.findUniqueOrThrow({ where: { id }, select: COLUMNS })
    const view = viewOf(context, row)
    tools.audit({ action: 'purchasing.tolerances.create', recordType: 'DeliveryTolerance', recordId: id, companyId: body.companyId, after: { scope: view.scope, companyId: body.companyId, supplierId: body.supplierId, itemId: body.itemId, itemKind: body.itemKind, overPct: view.overPct, underPct: view.underPct, whenBeyond: body.whenBeyond, note } })
    tools.emit({ type: 'delivery_tolerance.changed', subject: id, companyId: body.companyId, payload: { toleranceId: id, companyId: body.companyId, action: 'CREATED' } })
    return { tolerance: view }
  })
  return result
}

/** The rule the caller may change, read under the command (404 when it may not see it, 403 when it may not change it). */
async function ruleFor(tools: CommandTools, context: OfficeContext, toleranceId: string): Promise<Row> {
  const row = isUuid(toleranceId) ? await tools.tx.deliveryTolerance.findUnique({ where: { id: toleranceId }, select: COLUMNS }) : null
  if (!row || !visible(context, row)) throw new NotFoundError('Delivery tolerance not found.')
  if (!mayAt(context, PURCHASING_TOLERANCES_MANAGE, row.companyId)) throw new ForbiddenError(row.companyId === null ? 'A tolerance of every company is kept only by a role over every company.' : 'Keeping delivery tolerances needs purchasing.tolerances.manage.')
  return row
}

export async function updateTolerance(caller: CommandCaller, toleranceId: string, body: { readonly version: number; readonly overPct?: string | undefined; readonly underPct?: string | undefined; readonly whenBeyond?: ToleranceAction | undefined; readonly note?: string | null | undefined }, idempotencyKey?: string): Promise<{ tolerance: ToleranceView }> {
  const context = officeContextOf(caller)
  const { version, ...fields } = body
  if (Object.values(fields).every((value) => value === undefined)) throw new ValidationError('Nothing to change.', [{ path: 'body', message: 'Send at least one field.' }])
  const { result } = await command(caller, { name: 'purchasing.tolerances.update', idempotencyKey, input: { toleranceId, ...body }, record: { type: 'DeliveryTolerance', id: toleranceId, expectedVersion: version } }, async (tools) => {
    const row = await ruleFor(tools, context, toleranceId)
    if (row.status !== 'ACTIVE') throw new ConflictError('The tolerance is archived: reactivate it to change it.')
    const merged = { overPct: fields.overPct ?? percentText(row.overPct), underPct: fields.underPct ?? percentText(row.underPct), note: fields.note === undefined ? row.note : blank(fields.note) }
    const problems = toleranceProblems({ itemId: row.itemId, itemKind: row.itemKind, ...merged })
    if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
    await tools.tx.deliveryTolerance.update({ where: { id: row.id }, data: { overPct: merged.overPct.trim(), underPct: merged.underPct.trim(), ...(fields.whenBeyond ? { whenBeyond: fields.whenBeyond } : {}), note: merged.note, updatedById: context.actorId }, select: { id: true } })
    const after = await tools.tx.deliveryTolerance.findUniqueOrThrow({ where: { id: row.id }, select: COLUMNS })
    const before = viewOf(context, row)
    const view = viewOf(context, after)
    tools.audit({ action: 'purchasing.tolerances.update', recordType: 'DeliveryTolerance', recordId: row.id, companyId: row.companyId, before: { overPct: before.overPct, underPct: before.underPct, whenBeyond: before.whenBeyond, note: before.note }, after: { overPct: view.overPct, underPct: view.underPct, whenBeyond: view.whenBeyond, note: view.note } })
    tools.emit({ type: 'delivery_tolerance.changed', subject: row.id, companyId: row.companyId, payload: { toleranceId: row.id, companyId: row.companyId, action: 'UPDATED' } })
    return { tolerance: view }
  })
  return result
}

export async function moveTolerance(caller: CommandCaller, toleranceId: string, to: 'archive' | 'reactivate', body: { readonly version: number }, idempotencyKey?: string): Promise<{ tolerance: ToleranceView }> {
  const context = officeContextOf(caller)
  const { result } = await command(caller, { name: `purchasing.tolerances.${to}`, idempotencyKey, input: { toleranceId, ...body }, record: { type: 'DeliveryTolerance', id: toleranceId, expectedVersion: body.version } }, async (tools) => {
    const row = await ruleFor(tools, context, toleranceId)
    const status = to === 'archive' ? 'ARCHIVED' : 'ACTIVE'
    if (row.status === status) throw new ConflictError(to === 'archive' ? 'The tolerance is archived already.' : 'The tolerance is active already.')
    if (status === 'ACTIVE') await assertOnlyOne(tools.tx, row, row.id)
    await tools.tx.deliveryTolerance.update({ where: { id: row.id }, data: { status, updatedById: context.actorId }, select: { id: true } })
    const view = viewOf(context, await tools.tx.deliveryTolerance.findUniqueOrThrow({ where: { id: row.id }, select: COLUMNS }))
    tools.audit({ action: `purchasing.tolerances.${to}`, recordType: 'DeliveryTolerance', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status } })
    tools.emit({ type: 'delivery_tolerance.changed', subject: row.id, companyId: row.companyId, payload: { toleranceId: row.id, companyId: row.companyId, action: to === 'archive' ? 'ARCHIVED' : 'REACTIVATED' } })
    return { tolerance: view }
  })
  return result
}
