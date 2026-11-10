import type { FactoryClient } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import type { CreatePrepackBody, PrepackStatusBody, PrepackView, StylePrepacksView, UpdatePrepackBody } from '@nexus/factory-domain/product/prepacks/contracts'
import { PRODUCT_PREPACKS_MANAGE } from '@nexus/factory-domain/product/prepacks/permissions'
import { codeProblems, linePlan, linesProblems, nameProblems, type PrepackContext, type PrepackLineInput } from '@nexus/factory-domain/product/prepacks/rules'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { PREPACK_CHANGES } from '@nexus/factory-domain/product-prepacks/events'
import { command, StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { requireEditRule } from '../lifecycle/edit-rule'
import { contextOf, mayWrite } from '../materials/store'
import { lockScale, lockStyle, readStyle } from '../styles/store'
import {
  invalid,
  PREPACK_COLUMNS,
  prefixed,
  prepacksGuarded,
  prepackViewOf,
  readColourways,
  readLines,
  SCALE_COLUMNS,
  scaleSizes,
  STYLE_COLUMNS,
  stylePrepacksView,
  type LineRow,
  type PrepackRow,
  type ScaleRow,
} from './store'

/**
 * Prepacks (B-W2b-233; PRD-055; design products.styles › Sizes & measurements › Prepacks: "fixed size mixes for B2B",
 * used by orders and packing): a style's own prepacks, and those of every style of its size scale, read on the style
 * (product.styles.view) and kept with product.prepacks.manage over the style's (or the scale's) company. A style's prepack
 * is a commercial assortment, not a part of a revision: its writes ask the style's edit rule as a change of its details
 * (B-W2b-221, kind DETAILS: free unless the style's state blocks every change). Every write: one command(), the style
 * (or scale) row locked first, the prepack's version (409 when stale), an audit row per prepack, `prepack.changed`.
 * Refused in words before the database: a code with spaces or taken in the scale, a size outside the style's range (or the
 * scale), a colourway not the style's, a size both for any colourway and per colourway, an archived prepack changed.
 */

type Change = (typeof PREPACK_CHANGES)[number]

function emitChange(tools: CommandTools, row: Pick<PrepackRow, 'id' | 'code' | 'sizeScaleId' | 'styleId'>, companyId: string | null, change: Change): void {
  tools.emit({ type: 'prepack.changed', subject: row.id, companyId, payload: { prepackId: row.id, code: row.code, sizeScaleId: row.sizeScaleId, styleId: row.styleId, change } })
}

const auditedLines = (lines: readonly Pick<LineRow, 'size' | 'colourwayId' | 'quantity'>[]) => lines.map((line) => ({ size: line.size, colourwayId: line.colourwayId, quantity: line.quantity }))

function assertManage(caller: CommandCaller, companyId: string | null): void {
  if (!mayWrite(actorOf(contextOf(caller)), PRODUCT_PREPACKS_MANAGE, companyId)) {
    throw new ForbiddenError(companyId === null ? 'A prepack for every company is changed only by a role over every company.' : undefined)
  }
}

/** The prepack as the caller may see it, with whose company it is; another company's or tenant's is not found. */
async function readPrepackFor(caller: CommandCaller, prepackId: string): Promise<{ row: PrepackRow; scale: ScaleRow; companyId: string | null; range: string[] | null }> {
  if (!isUuid(prepackId)) throw new NotFoundError('Prepack not found.')
  const found = await caller.withClient(async (client) => {
    const row = await client.prepack.findUnique({ where: { id: prepackId }, select: PREPACK_COLUMNS })
    if (!row) return null
    const scale = await client.sizeScale.findUniqueOrThrow({ where: { id: row.sizeScaleId }, select: SCALE_COLUMNS })
    const style = row.styleId ? await client.style.findUnique({ where: { id: row.styleId }, select: STYLE_COLUMNS }) : null
    return { row, scale, style }
  })
  if (!found) throw new NotFoundError('Prepack not found.')
  const companyId = found.style ? found.style.companyId : found.scale.companyId
  if (!can(actorOf(contextOf(caller)), PRODUCT_STYLES_VIEW, { companyId })) throw new NotFoundError('Prepack not found.')
  return { row: found.row, scale: found.scale, companyId, range: found.style ? [...found.style.sizes] : null }
}

/** One prepack as it is now, against a style's range (a scale's prepack against its scale). */
async function prepackViewInTx(tx: CommandTx | FactoryClient, prepackId: string): Promise<PrepackView> {
  const row = await tx.prepack.findUniqueOrThrow({ where: { id: prepackId }, select: PREPACK_COLUMNS })
  const scale = await tx.sizeScale.findUniqueOrThrow({ where: { id: row.sizeScaleId }, select: SCALE_COLUMNS })
  const order = await scaleSizes(tx, scale.id)
  const style = row.styleId ? await tx.style.findUnique({ where: { id: row.styleId }, select: STYLE_COLUMNS }) : null
  return prepackViewOf(row, await readLines(tx, [row.id]), scale, order, await readColourways(tx, row.styleId ? [row.styleId] : []), style ? style.sizes : order)
}

/** GET /product/styles/:styleId/prepacks — the style's section. */
export async function getStylePrepacks(caller: CommandCaller, styleId: string): Promise<StylePrepacksView> {
  const style = await readStyle(caller, styleId)
  return caller.withClient(async (client) => stylePrepacksView(client, await client.style.findUniqueOrThrow({ where: { id: style.id }, select: STYLE_COLUMNS })))
}

/** GET /product/prepacks/:prepackId — one prepack (W2b-5: the order line that takes it). */
export async function getPrepack(caller: CommandCaller, prepackId: string): Promise<PrepackView> {
  const { row } = await readPrepackFor(caller, prepackId)
  return caller.withClient((client) => prepackViewInTx(client, row.id))
}

/**
 * The first lock of a write to a style's prepack: the style row (FOR UPDATE), not archived, its edit rule asked (DETAILS).
 * A scale's prepack locks its scale (FOR SHARE), not archived.
 */
async function lockOwner(tx: CommandTx, row: Pick<PrepackRow, 'styleId' | 'sizeScaleId'>): Promise<void> {
  if (row.styleId) {
    const style = await lockStyle(tx, row.styleId)
    if (style.status === 'ARCHIVED') throw new InvalidStateError(`Style ${style.code} is archived: reactivate it before changing its prepacks.`)
    await requireEditRule(tx, row.styleId, 'DETAILS')
    return
  }
  const scale = await lockScale(tx, row.sizeScaleId, 'share')
  if (!scale) throw new NotFoundError('Size scale not found.')
  if (scale.status === 'ARCHIVED') throw new InvalidStateError(`Size scale ${scale.code} is archived: its prepacks do not change.`)
}

/** What a line may name: the style's range and colourways (a style's prepack) or the scale's sizes. */
async function contextFor(tx: CommandTx, row: Pick<PrepackRow, 'styleId' | 'sizeScaleId'>, existing: readonly PrepackLineInput[] = []): Promise<PrepackContext> {
  if (row.styleId) {
    const style = await tx.style.findUniqueOrThrow({ where: { id: row.styleId }, select: STYLE_COLUMNS })
    const colourways = await readColourways(tx, [row.styleId])
    return { scope: 'STYLE', sizes: style.sizes, sizesOf: `the sizes of style ${style.code}`, colourways: [...colourways.values()], existing }
  }
  const scale = await tx.sizeScale.findUniqueOrThrow({ where: { id: row.sizeScaleId }, select: SCALE_COLUMNS })
  return { scope: 'SCALE', sizes: await scaleSizes(tx, row.sizeScaleId), sizesOf: `the sizes of scale ${scale.code}`, colourways: [], existing }
}

async function codeTaken(tx: CommandTx, scaleId: string, code: string, exceptId: string | null): Promise<boolean> {
  const rows = await tx.prepack.findMany({ where: { sizeScaleId: scaleId, code, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true }, take: 1 })
  return rows.length > 0
}

const takenWords = (code: string, scaleCode: string) => `The prepack code ${code} is taken in size scale ${scaleCode}: pick another.`

async function writeLines(tools: CommandTools, prepack: Pick<PrepackRow, 'id' | 'styleId'>, existing: readonly LineRow[], wanted: readonly PrepackLineInput[]): Promise<boolean> {
  const { tx, now } = tools
  const plan = linePlan(existing, wanted)
  if (plan.removed.length > 0) await tx.prepackLine.deleteMany({ where: { id: { in: plan.removed.map((line) => line.id) }, prepackId: prepack.id } })
  for (const change of plan.changed) {
    const { count } = await tx.prepackLine.updateMany({ where: { id: change.from.id, version: change.from.version }, data: { quantity: change.quantity, version: change.from.version + 1, updatedAt: now } })
    if (count !== 1) throw new ConflictError('Someone changed this prepack at the same time: load it again.')
  }
  if (plan.added.length > 0) {
    const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
    await tx.prepackLine.createMany({
      data: plan.added.map((line) => ({
        id: newId(),
        prepackId: prepack.id,
        size: line.size,
        styleId: line.colourwayId ? prepack.styleId : null,
        colourwayId: line.colourwayId,
        quantity: line.quantity,
        createdAt: now,
        updatedAt: now,
        createdById,
      })),
    })
  }
  return plan.removed.length + plan.changed.length + plan.added.length > 0
}

/** product.prepacks.create: a prepack of the style (STYLE) or of every style of its size scale (SCALE), with its lines. */
export async function createPrepack(caller: CommandCaller, styleId: string, body: CreatePrepackBody, idempotencyKey?: string): Promise<PrepackView> {
  const style = await readStyle(caller, styleId)
  const scale = await caller.withClient((client) => client.sizeScale.findUniqueOrThrow({ where: { id: style.sizeScale.id }, select: SCALE_COLUMNS }))
  assertManage(caller, body.scope === 'STYLE' ? style.companyId : scale.companyId)
  const { result } = await prepacksGuarded(
    () =>
      command(caller, { name: 'product.prepacks.create', idempotencyKey, input: { styleId, ...body } }, async (tools) => {
        const { tx, now } = tools
        // The style row first (its scale may not move under the write), then the owner's lock and rule.
        const locked = await lockStyle(tx, styleId)
        const fresh = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: STYLE_COLUMNS })
        const owner = { styleId: body.scope === 'STYLE' ? styleId : null, sizeScaleId: fresh.sizeScaleId }
        if (body.scope === 'STYLE') {
          if (locked.status === 'ARCHIVED') throw new InvalidStateError(`Style ${locked.code} is archived: reactivate it before changing its prepacks.`)
          await requireEditRule(tx, styleId, 'DETAILS')
        } else await lockOwner(tx, owner)
        const lines = body.lines.map((line) => ({ size: line.size, colourwayId: line.colourwayId, quantity: line.quantity }))
        const problems: Issue[] = [...prefixed(codeProblems(body.code)), ...prefixed(nameProblems(body.name)), ...prefixed(linesProblems(lines, await contextFor(tx, owner)))]
        if (problems.length > 0) throw invalid(problems)
        const scaleRow = await tx.sizeScale.findUniqueOrThrow({ where: { id: fresh.sizeScaleId }, select: SCALE_COLUMNS })
        if (await codeTaken(tx, fresh.sizeScaleId, body.code, null)) throw new ConflictError(takenWords(body.code, scaleRow.code))
        const id = newId()
        const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
        const row = { id, sizeScaleId: fresh.sizeScaleId, styleId: owner.styleId, code: body.code, name: body.name }
        await tx.prepack.create({ data: { ...row, status: 'ACTIVE', createdAt: now, updatedAt: now, createdById }, select: { id: true } })
        await writeLines(tools, row, [], lines)
        const companyId = owner.styleId ? fresh.companyId : scaleRow.companyId
        tools.audit({ recordType: 'Prepack', recordId: id, companyId, after: { scope: body.scope, sizeScaleId: row.sizeScaleId, styleId: row.styleId, code: row.code, name: row.name, lines: auditedLines(lines) } })
        emitChange(tools, row, companyId, 'CREATED')
        return prepackViewInTx(tx, id)
      }),
    `The prepack code ${body.code} is taken in this size scale: pick another.`,
  )
  return result
}

/** product.prepacks.update: a prepack's code, name or whole list of lines, at its version. */
export async function updatePrepack(caller: CommandCaller, prepackId: string, body: UpdatePrepackBody, idempotencyKey?: string): Promise<PrepackView> {
  const seen = await readPrepackFor(caller, prepackId)
  assertManage(caller, seen.companyId)
  const { version, ...patch } = body
  if (Object.keys(patch).length === 0) throw invalid([{ path: 'body', message: 'Nothing changes: name the code, the name or the lines.' }])
  const { result } = await prepacksGuarded(() =>
    command(caller, { name: 'product.prepacks.update', idempotencyKey, input: { prepackId, ...body } }, async (tools) => {
      const { tx, now } = tools
      await lockOwner(tx, seen.row)
      const [current] = await tx.$queryRaw<{ version: number; status: string }[]>`SELECT "version", "status"::text AS "status" FROM "Prepack" WHERE "id" = ${prepackId}::uuid FOR UPDATE`
      if (!current) throw new NotFoundError('Prepack not found.')
      if (current.version !== version) throw new StaleVersionError('Prepack', prepackId, current.version, version)
      const before = await tx.prepack.findUniqueOrThrow({ where: { id: prepackId }, select: PREPACK_COLUMNS })
      if (current.status !== 'ACTIVE') throw new InvalidStateError(`Prepack ${before.code} is archived: restore it to change it.`)
      const existing = await readLines(tx, [prepackId])
      const problems: Issue[] = []
      if (patch.code !== undefined) problems.push(...prefixed(codeProblems(patch.code)))
      if (patch.name !== undefined) problems.push(...prefixed(nameProblems(patch.name)))
      const wanted = patch.lines?.map((line) => ({ size: line.size, colourwayId: line.colourwayId, quantity: line.quantity }))
      if (wanted) problems.push(...prefixed(linesProblems(wanted, await contextFor(tx, before, existing))))
      if (problems.length > 0) throw invalid(problems)
      if (patch.code !== undefined && patch.code !== before.code && (await codeTaken(tx, before.sizeScaleId, patch.code, prepackId))) throw new ConflictError(takenWords(patch.code, seen.scale.code))
      const linesChanged = wanted ? await writeLines(tools, before, existing, wanted) : false
      const fields = { ...(patch.code !== undefined ? { code: patch.code } : {}), ...(patch.name !== undefined ? { name: patch.name } : {}) }
      const fieldsChanged = (fields.code !== undefined && fields.code !== before.code) || (fields.name !== undefined && fields.name !== before.name)
      const { count } = await tx.prepack.updateMany({ where: { id: prepackId, version }, data: { ...fields, version: version + 1, updatedAt: now } })
      if (count !== 1) throw new StaleVersionError('Prepack', prepackId, version + 1, version)
      const after = { code: fields.code ?? before.code, name: fields.name ?? before.name }
      tools.audit({
        recordType: 'Prepack',
        recordId: prepackId,
        companyId: seen.companyId,
        before: { code: before.code, name: before.name, ...(wanted ? { lines: auditedLines(existing) } : {}) },
        after: { ...after, ...(wanted ? { lines: auditedLines(wanted) } : {}) },
      })
      emitChange(tools, { ...before, ...after }, seen.companyId, linesChanged && !fieldsChanged ? 'LINES' : 'UPDATED')
      return prepackViewInTx(tx, prepackId)
    }),
  )
  return result
}

/** product.prepacks.status: the selection archived (its lines freeze) or restored, each at its version; all or none. */
export async function setPrepackStatus(caller: CommandCaller, body: PrepackStatusBody, idempotencyKey?: string): Promise<PrepackView[]> {
  const seen: (Awaited<ReturnType<typeof readPrepackFor>> & { version: number })[] = []
  for (const entry of body.prepacks) {
    const one = await readPrepackFor(caller, entry.id)
    assertManage(caller, one.companyId)
    seen.push({ ...one, version: entry.version })
  }
  const { result } = await prepacksGuarded(() =>
    command(caller, { name: 'product.prepacks.status', idempotencyKey, input: body }, async (tools) => {
      const { tx, now } = tools
      // The owners first (styles in id order, then scales), then the prepacks in id order.
      const owners = [...new Map(seen.map((one) => [one.row.styleId ?? `scale:${one.row.sizeScaleId}`, one.row])).values()].sort((a, b) => (a.styleId ?? `~${a.sizeScaleId}`).localeCompare(b.styleId ?? `~${b.sizeScaleId}`))
      for (const owner of owners) await lockOwner(tx, owner)
      const ids = [...new Set(seen.map((one) => one.row.id))].sort()
      const rows = await tx.$queryRaw<{ id: string; version: number; status: string }[]>`SELECT "id"::text AS "id", "version", "status"::text AS "status" FROM "Prepack" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR UPDATE`
      const out: string[] = []
      for (const one of seen) {
        const row = rows.find((candidate) => candidate.id === one.row.id)
        if (!row) throw new NotFoundError('Prepack not found.')
        if (row.version !== one.version) throw new StaleVersionError('Prepack', one.row.id, row.version, one.version)
        if (row.status === body.status) {
          out.push(one.row.id)
          continue
        }
        await tx.prepack.update({ where: { id: one.row.id }, data: { status: body.status, version: row.version + 1, updatedAt: now }, select: { id: true } })
        tools.audit({ recordType: 'Prepack', recordId: one.row.id, companyId: one.companyId, before: { status: row.status }, after: { status: body.status } })
        emitChange(tools, one.row, one.companyId, body.status === 'ARCHIVED' ? 'ARCHIVED' : 'RESTORED')
        out.push(one.row.id)
      }
      if (out.length > 0 && rows.every((row) => row.status === body.status)) {
        // Nothing moved: still one audit row (every command records one), naming the selection.
        tools.audit({ recordType: 'Prepack', recordId: ids[0]!, companyId: seen[0]!.companyId, after: { status: body.status, unchanged: ids } })
      }
      const views: PrepackView[] = []
      for (const id of out) views.push(await prepackViewInTx(tx, id))
      return views
    }),
  )
  return result
}
