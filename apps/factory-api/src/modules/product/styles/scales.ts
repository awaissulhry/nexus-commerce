import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { assertTransition } from '@nexus/factory-domain/state/machine'
import type { AddSizesBody, CreateScaleBody, ListScalesQuery, ReorderSizesBody, ScaleRow, ScaleView, UpdateScaleBody, UpdateSizeBody } from '@nexus/factory-domain/product/sizes/contracts'
import {
  insertSizes,
  measureUnitProblems,
  measureUnitsOf,
  normaliseScale,
  normaliseSize,
  reorderProblems,
  scaleOrder,
  scaleProblems,
  sequenceOf,
  sizeCodeChangeRefusal,
  sizeListProblems,
  sizeMachine,
  sizeProblems,
  sizeScaleMachine,
  type BodyMeasures,
  type MasterStatus,
  type SizeFields,
} from '@nexus/factory-domain/product/sizes/rules'
import { PRODUCT_STYLES_MANAGE, PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { afterCursor, decodeCursor, encodeCursor } from './cursor'
import {
  assertMayWrite,
  bumpVersion,
  clearBodyMeasures,
  contextOf,
  invalid,
  isUniqueViolation,
  lockScale,
  prefixed,
  readScale,
  SCALE_COLUMNS,
  SCALE_SCOPE,
  SIZE_COLUMNS,
  type ScaleRowData,
  type SizeRowData,
} from './store'

/**
 * The size scale library (A2 SCR-049, size scales tab; features PRD-047, PRD-022): scales with their ordered sizes and
 * body measures. While no style uses a scale its code and order may change; once one does, sizes are still added (at
 * the end or before a size), edited (label, measures) and archived, and a size's code changes only while nothing names
 * it (factory-domain product/sizes). Writes to a scale's sizes lock the scale row first (command()'s guard on the scale,
 * or `lockScale`), then the sizes; a style that picks sizes holds the scale FOR SHARE meanwhile.
 */

const SCALE_NOUN = 'size scale'

/** The scale's sizes as the order needs them, every status. */
const readSizes = (client: FactoryClient | CommandTx, scaleId: string): Promise<SizeRowData[]> =>
  client.size.findMany({ where: { scaleId }, select: SIZE_COLUMNS, orderBy: [{ seq: 'asc' }, { code: 'asc' }] })

const styleCountOf = (client: FactoryClient | CommandTx, scaleId: string): Promise<number> => client.style.count({ where: { sizeScaleId: scaleId } })

/**
 * The scale's size codes something names: a style's range or base size, a SKU, a BOM size quantity, certificate
 * coverage, a quote or order line's size or base size. Their codes never change.
 */
export async function sizeCodesInUse(client: FactoryClient | CommandTx, scaleId: string): Promise<Set<string>> {
  const styles = await client.style.findMany({ where: { sizeScaleId: scaleId }, select: { id: true, sizes: true, baseSize: true } })
  const used = new Set<string>()
  for (const style of styles) {
    for (const size of style.sizes) used.add(size)
    if (style.baseSize) used.add(style.baseSize)
  }
  if (styles.length === 0) return used
  const styleId = { in: styles.map((style) => style.id) }
  const add = (rows: readonly { size?: string | null; baseSize?: string | null; sizes?: readonly string[] }[]) => {
    for (const row of rows) {
      if (row.size) used.add(row.size)
      if (row.baseSize) used.add(row.baseSize)
      for (const size of row.sizes ?? []) used.add(size)
    }
  }
  add(await client.variant.findMany({ where: { styleId }, select: { size: true }, distinct: ['size'] }))
  add(await client.bomLineSize.findMany({ where: { bomLine: { styleId } }, select: { size: true }, distinct: ['size'] }))
  add(await client.certificateCoverage.findMany({ where: { styleId }, select: { sizes: true } }))
  add(await client.quoteLineSize.findMany({ where: { line: { styleId } }, select: { size: true }, distinct: ['size'] }))
  add(await client.quoteLine.findMany({ where: { styleId, baseSize: { not: null } }, select: { baseSize: true }, distinct: ['baseSize'] }))
  add(await client.salesOrderLineSize.findMany({ where: { line: { styleId } }, select: { size: true }, distinct: ['size'] }))
  add(await client.salesOrderLine.findMany({ where: { styleId, baseSize: { not: null } }, select: { baseSize: true }, distinct: ['baseSize'] }))
  return used
}

// ---- views --------------------------------------------------------------------------------------------------------------

function scaleRowView(row: ScaleRowData, sizes: readonly Pick<SizeRowData, 'code' | 'seq' | 'status'>[], styleCount: number): ScaleRow {
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    name: row.name,
    codes: scaleOrder(sizes.filter((size) => size.status === 'ACTIVE')),
    styleCount,
    status: row.status,
    version: row.version,
    updatedAt: toUtcIso(row.updatedAt),
  }
}

function scaleViewOf(row: ScaleRowData, sizes: readonly SizeRowData[], styleCount: number, inUse: ReadonlySet<string>): ScaleView {
  const ordered = [...sizes].sort((a, b) => a.seq - b.seq || (a.code < b.code ? -1 : 1))
  return {
    ...scaleRowView(row, sizes, styleCount),
    sizes: ordered.map((size) => ({
      id: size.id,
      code: size.code,
      label: size.label,
      seq: size.seq,
      bodyMeasures: (size.bodyMeasures as BodyMeasures | null) ?? null,
      status: size.status,
      version: size.version,
      inUse: inUse.has(size.code),
    })),
    measureUnits: measureUnitsOf(ordered.map((size) => ({ bodyMeasures: (size.bodyMeasures as BodyMeasures | null) ?? null }))),
    createdAt: toUtcIso(row.createdAt),
    createdById: row.createdById,
  }
}

async function viewWith(client: FactoryClient | CommandTx, scaleId: string): Promise<ScaleView> {
  const row = await client.sizeScale.findUniqueOrThrow({ where: { id: scaleId }, select: SCALE_COLUMNS })
  return scaleViewOf(row, await readSizes(client, scaleId), await styleCountOf(client, scaleId), await sizeCodesInUse(client, scaleId))
}

// ---- reads --------------------------------------------------------------------------------------------------------------

/** The scales the caller may see, by code (SCR-049). */
export async function listScales(caller: CommandCaller, query: ListScalesQuery): Promise<{ scales: ScaleRow[]; nextCursor: string | null; count: number }> {
  const context = contextOf(caller)
  const search = query.q?.trim()
  const filters: Prisma.SizeScaleWhereInput[] = [
    scopeWhere(actorOf(context), PRODUCT_STYLES_VIEW, SCALE_SCOPE) as Prisma.SizeScaleWhereInput,
    query.status === 'ALL' ? {} : { status: query.status },
    search ? { OR: [{ code: { contains: search, mode: 'insensitive' } }, { name: { contains: search, mode: 'insensitive' } }] } : {},
    query.companyId ? { OR: [{ companyId: query.companyId }, { companyId: null }] } : {},
  ]
  const cursor = decodeCursor(query.cursor)
  return caller.withClient(async (client) => {
    const rows = await client.sizeScale.findMany({ where: { AND: [...filters, afterCursor(cursor)] }, select: SCALE_COLUMNS, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: query.limit + 1 })
    const count = await client.sizeScale.count({ where: { AND: filters } })
    const page = rows.slice(0, query.limit)
    const ids = page.map((row) => row.id)
    const sizes = await client.size.findMany({ where: { scaleId: { in: ids } }, select: { scaleId: true, code: true, seq: true, status: true } })
    const styles = await client.style.groupBy({ by: ['sizeScaleId'], where: { sizeScaleId: { in: ids } }, _count: { _all: true } })
    const styleCount = new Map(styles.map((entry) => [entry.sizeScaleId, entry._count._all]))
    const last = page.at(-1)
    return {
      scales: page.map((row) => scaleRowView(row, sizes.filter((size) => size.scaleId === row.id), styleCount.get(row.id) ?? 0)),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
      count,
    }
  })
}

/** One scale with every size (archived ones too), which sizes are in use, and its measure units. */
export async function getScale(caller: CommandCaller, scaleId: string): Promise<ScaleView> {
  await readScale(caller, scaleId)
  return caller.withClient((client) => viewWith(client, scaleId))
}

// ---- writes -------------------------------------------------------------------------------------------------------------

const codeConflict = (code: string) => new ConflictError(`The size scale code ${code} is taken.`)
const audited = (size: SizeFields) => ({ code: size.code, label: size.label, bodyMeasures: size.bodyMeasures })

function openScale(status: MasterStatus): void {
  if (status !== 'ACTIVE') throw new InvalidStateError('This size scale is archived: reactivate it before changing it.')
}

function changed(tools: CommandTools, scale: { id: string; code: string; companyId: string | null }): void {
  tools.emit({ type: 'size_scale.changed', subject: scale.id, companyId: scale.companyId, payload: { sizeScaleId: scale.id, code: scale.code } })
}

async function insertSizeRows(tools: CommandTools, scale: { id: string; companyId: string | null }, sizes: readonly SizeFields[], seqOf: ReadonlyMap<string, number>): Promise<void> {
  const { tx, now, context } = tools
  const createdById = context.audience === 'office' ? context.actorId : null
  const rows = sizes.map((size) => ({ id: newId(), size }))
  await tx.size.createMany({
    data: rows.map(({ id, size }) => ({
      id,
      scaleId: scale.id,
      code: size.code,
      label: size.label,
      ...(size.bodyMeasures === null ? {} : { bodyMeasures: size.bodyMeasures as unknown as Prisma.InputJsonValue }),
      seq: seqOf.get(size.code)!,
      createdAt: now,
      updatedAt: now,
      createdById,
    })),
  })
  for (const { id, size } of rows) tools.audit({ recordType: 'Size', recordId: id, companyId: scale.companyId, after: { ...audited(size), seq: seqOf.get(size.code), status: 'ACTIVE' } })
}

/** product.styles.createScale: a scale with its sizes, from small to large. */
export async function createScale(caller: CommandCaller, body: CreateScaleBody, idempotencyKey?: string): Promise<ScaleView> {
  const context = contextOf(caller)
  const companyId = body.companyId ?? null
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, companyId, SCALE_NOUN)
  const fields = normaliseScale(body)
  const sizes = body.sizes.map(normaliseSize)
  const issues = [...prefixed(scaleProblems(fields)), ...prefixed(sizeListProblems(sizes))]
  if (issues.length > 0) throw invalid(issues, SCALE_NOUN)

  const { result } = await command(caller, { name: 'product.styles.createScale', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    if (companyId !== null && !(await tx.company.findUnique({ where: { id: companyId }, select: { id: true } }))) {
      throw invalid([{ path: 'body/companyId', message: 'No such company.' }], SCALE_NOUN)
    }
    if (await tx.sizeScale.findFirst({ where: { code: fields.code }, select: { id: true } })) throw codeConflict(fields.code)
    const id = newId()
    await tx.sizeScale.create({
      data: { id, companyId, ...fields, createdAt: now, updatedAt: now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null },
      select: { id: true },
    })
    await insertSizeRows(tools, { id, companyId }, sizes, sequenceOf(sizes.map((size) => size.code)))
    tools.audit({ recordType: 'SizeScale', recordId: id, companyId, after: { ...fields, status: 'ACTIVE', sizes: sizes.map(audited) } })
    tools.emit({ type: 'size_scale.created', subject: id, companyId, payload: { sizeScaleId: id, code: fields.code } })
    return viewWith(tx, id)
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw codeConflict(fields.code)
    throw error
  })
  return result
}

/** product.styles.updateScale: its name; its code only while no style uses it (versioned). */
export async function updateScale(caller: CommandCaller, scaleId: string, body: UpdateScaleBody, idempotencyKey?: string): Promise<ScaleView> {
  const context = contextOf(caller)
  const seen = await readScale(caller, scaleId)
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, seen.companyId, SCALE_NOUN)
  openScale(seen.status)
  const next = normaliseScale({ code: body.code ?? seen.code, name: body.name ?? seen.name })
  const issues = prefixed(scaleProblems(next))
  if (issues.length > 0) throw invalid(issues, SCALE_NOUN)

  const { result } = await command(
    caller,
    { name: 'product.styles.updateScale', idempotencyKey, input: { scaleId, ...body }, record: { type: 'SizeScale', id: scaleId, expectedVersion: body.version } },
    async (tools) => {
      const { tx } = tools
      const row = await tx.sizeScale.findUniqueOrThrow({ where: { id: scaleId }, select: SCALE_COLUMNS })
      openScale(row.status)
      if (next.code !== row.code) {
        const styles = await styleCountOf(tx, scaleId)
        if (styles > 0) throw new ConflictError(`${styles} style(s) use this scale: its code stays ${row.code}.`)
        if (await tx.sizeScale.findFirst({ where: { code: next.code, id: { not: scaleId } }, select: { id: true } })) throw codeConflict(next.code)
      }
      await tx.sizeScale.update({ where: { id: scaleId }, data: next, select: { id: true } })
      tools.audit({ recordType: 'SizeScale', recordId: scaleId, companyId: row.companyId, before: { code: row.code, name: row.name }, after: next })
      changed(tools, { id: scaleId, code: next.code, companyId: row.companyId })
      return viewWith(tx, scaleId)
    },
  ).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw codeConflict(next.code)
    throw error
  })
  return result
}

/** product.styles.addSizes: sizes added before a size or at the end (also to a scale in use); a code it had is restored instead. */
export async function addSizes(caller: CommandCaller, scaleId: string, body: AddSizesBody, idempotencyKey?: string): Promise<ScaleView> {
  const context = contextOf(caller)
  const seen = await readScale(caller, scaleId)
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, seen.companyId, SCALE_NOUN)
  openScale(seen.status)
  const sizes = body.sizes.map(normaliseSize)
  const issues = prefixed(sizeListProblems(sizes))
  if (issues.length > 0) throw invalid(issues, SCALE_NOUN)

  const { result } = await command(
    caller,
    { name: 'product.styles.addSizes', idempotencyKey, input: { scaleId, ...body }, record: { type: 'SizeScale', id: scaleId, expectedVersion: body.version } },
    async (tools) => {
      const { tx } = tools
      const row = await tx.sizeScale.findUniqueOrThrow({ where: { id: scaleId }, select: SCALE_COLUMNS })
      openScale(row.status)
      const current = await readSizes(tx, scaleId)
      const archived = sizes.filter((size) => current.some((entry) => entry.code === size.code && entry.status === 'ARCHIVED'))
      if (archived.length > 0) throw new ConflictError(`The scale had size ${archived.map((size) => size.code).join(', ')}; restore it instead.`)
      const problems = prefixed(sizeListProblems(sizes, { taken: current.map((entry) => entry.code), units: measureUnitsOf(current.map((entry) => ({ bodyMeasures: (entry.bodyMeasures as BodyMeasures | null) ?? null }))) }))
      const order = insertSizes(current, sizes.map((size) => size.code), body.before)
      if (!order.ok) problems.push(...prefixed(order.issues))
      if (problems.length > 0 || !order.ok) throw invalid(problems, SCALE_NOUN)
      const seqOf = sequenceOf(order.order)
      for (const entry of current) {
        const seq = seqOf.get(entry.code)!
        if (seq !== entry.seq) await tx.size.update({ where: { id: entry.id }, data: { seq }, select: { id: true } })
      }
      await insertSizeRows(tools, row, sizes, seqOf)
      tools.audit({ recordType: 'SizeScale', recordId: scaleId, companyId: row.companyId, before: { order: scaleOrder(current) }, after: { order: order.order, added: sizes.map(audited) } })
      changed(tools, row)
      return viewWith(tx, scaleId)
    },
  ).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw new ConflictError('A size of this code was added at the same time: load the scale again.')
    throw error
  })
  return result
}

/** product.styles.reorderSizes: the order of every size, while no style uses the scale (their ranges keep its order). */
export async function reorderSizes(caller: CommandCaller, scaleId: string, body: ReorderSizesBody, idempotencyKey?: string): Promise<ScaleView> {
  const context = contextOf(caller)
  const seen = await readScale(caller, scaleId)
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, seen.companyId, SCALE_NOUN)
  openScale(seen.status)

  const { result } = await command(
    caller,
    { name: 'product.styles.reorderSizes', idempotencyKey, input: { scaleId, ...body }, record: { type: 'SizeScale', id: scaleId, expectedVersion: body.version } },
    async (tools) => {
      const { tx } = tools
      const row = await tx.sizeScale.findUniqueOrThrow({ where: { id: scaleId }, select: SCALE_COLUMNS })
      openScale(row.status)
      const styles = await styleCountOf(tx, scaleId)
      if (styles > 0) throw new ConflictError(`${styles} style(s) use this scale: its order stays (their ranges keep it). Add sizes before a size instead.`)
      const current = await readSizes(tx, scaleId)
      const problems = reorderProblems(scaleOrder(current), body.codes)
      if (problems.length > 0) throw invalid(prefixed(problems), SCALE_NOUN)
      const seqOf = sequenceOf(body.codes)
      for (const entry of current) {
        const seq = seqOf.get(entry.code)!
        if (seq !== entry.seq) await tx.size.update({ where: { id: entry.id }, data: { seq }, select: { id: true } })
      }
      tools.audit({ recordType: 'SizeScale', recordId: scaleId, companyId: row.companyId, before: { order: scaleOrder(current) }, after: { order: [...body.codes] } })
      changed(tools, row)
      return viewWith(tx, scaleId)
    },
  )
  return result
}

/**
 * product.styles.updateSize: a size's label and body measures; its code only while nothing names it; `status`
 * ARCHIVED takes it out of new ranges (styles keep it), ACTIVE restores it. Versioned per size, after the scale's lock.
 */
export async function updateSize(caller: CommandCaller, scaleId: string, sizeId: string, body: UpdateSizeBody, idempotencyKey?: string): Promise<ScaleView> {
  const context = contextOf(caller)
  const seen = await readScale(caller, scaleId)
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, seen.companyId, SCALE_NOUN)
  openScale(seen.status)
  if (!isUuid(sizeId)) throw new NotFoundError('Size not found.')
  const found = await caller.withClient((client) => client.size.findUnique({ where: { id: sizeId }, select: { scaleId: true } }))
  if (!found || found.scaleId !== scaleId) throw new NotFoundError('Size not found.')

  const { result } = await command(caller, { name: 'product.styles.updateSize', idempotencyKey, input: { scaleId, sizeId, ...body } }, async (tools) => {
    const { tx } = tools
    const scale = await lockScale(tx, scaleId, 'update')
    if (!scale) throw new NotFoundError('Size scale not found.')
    openScale(scale.status)
    await bumpVersion(tx, 'size', sizeId, body.version)
    const sizes = await readSizes(tx, scaleId)
    const current = sizes.find((entry) => entry.id === sizeId)!
    const others = sizes.filter((entry) => entry.id !== sizeId)
    const before: SizeFields = { code: current.code, label: current.label, bodyMeasures: (current.bodyMeasures as BodyMeasures | null) ?? null }
    const next = normaliseSize({
      code: body.code ?? current.code,
      label: body.label === undefined ? current.label : body.label,
      bodyMeasures: body.bodyMeasures === undefined ? before.bodyMeasures : body.bodyMeasures,
    })
    const problems: Issue[] = [
      ...prefixed(sizeProblems(next)),
      ...prefixed(measureUnitProblems([next], measureUnitsOf(others.map((entry) => ({ bodyMeasures: (entry.bodyMeasures as BodyMeasures | null) ?? null }))), '')).map((issue) => ({
        ...issue,
        path: issue.path.replace(/^body\/0\//, 'body/'),
      })),
    ]
    if (problems.length > 0) throw invalid(problems, 'size')
    if (next.code !== current.code) {
      const refusal = sizeCodeChangeRefusal(current.code, await sizeCodesInUse(tx, scaleId))
      if (refusal) throw new ConflictError(refusal)
      if (others.some((entry) => entry.code === next.code)) throw new ConflictError(`The scale has size ${next.code} already.`)
    }
    const move = body.status !== undefined && body.status !== current.status ? body.status : undefined
    if (move) assertTransition(sizeMachine, current.status, move)
    await tx.size.update({
      where: { id: sizeId },
      data: { code: next.code, label: next.label, ...(next.bodyMeasures === null ? {} : { bodyMeasures: next.bodyMeasures as unknown as Prisma.InputJsonValue }), ...(move ? { status: move } : {}) },
      select: { id: true },
    })
    if (next.bodyMeasures === null && before.bodyMeasures !== null) await clearBodyMeasures(tx, sizeId)
    const after = { ...audited(next), status: move ?? current.status }
    tools.audit({ recordType: 'Size', recordId: sizeId, companyId: scale.companyId, before: { ...audited(before), status: current.status }, after })
    tools.audit({ recordType: 'SizeScale', recordId: scaleId, companyId: scale.companyId, after: { size: { id: sizeId, ...after } } })
    changed(tools, { id: scaleId, code: scale.code, companyId: scale.companyId })
    return viewWith(tx, scaleId)
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw new ConflictError('The scale has a size with this code already.')
    throw error
  })
  return result
}

/** product.styles.archiveScale / reactivateScale: out of new use (no new style picks it; styles keep it) and back. */
export async function moveScale(caller: CommandCaller, scaleId: string, to: MasterStatus, body: { version: number; reason?: string | undefined }, idempotencyKey?: string): Promise<ScaleView> {
  const context = contextOf(caller)
  const seen = await readScale(caller, scaleId)
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, seen.companyId, SCALE_NOUN)
  const { result } = await command(
    caller,
    {
      name: to === 'ARCHIVED' ? 'product.styles.archiveScale' : 'product.styles.reactivateScale',
      idempotencyKey,
      input: { scaleId, ...body },
      record: { type: 'SizeScale', id: scaleId, expectedVersion: body.version, transition: { machine: sizeScaleMachine, to } },
    },
    async (tools) => {
      const { tx, record } = tools
      tools.audit({ recordType: 'SizeScale', recordId: scaleId, companyId: seen.companyId, before: { status: record!.from }, after: { status: to }, ...(body.reason ? { reason: body.reason } : {}) })
      changed(tools, seen)
      return viewWith(tx, scaleId)
    },
  )
  return result
}
