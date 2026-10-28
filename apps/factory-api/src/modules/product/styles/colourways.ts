import { ConflictError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { assertTransition } from '@nexus/factory-domain/state/machine'
import { colourwayCodeChangeRefusal, colourwayMachine, colourwayProblems, colourwayListProblems, normaliseColourway } from '@nexus/factory-domain/product/styles/colourways'
import type { ColourwayBody, StyleView, UpdateColourwayBody } from '@nexus/factory-domain/product/styles/contracts'
import { followPlan } from '@nexus/factory-domain/product/styles/matrix'
import { PRODUCT_STYLES_MANAGE } from '@nexus/factory-domain/product/styles/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { applyMatrixPlan, emitSkus } from './skus'
import {
  assertMayWrite,
  bumpVersion,
  colourProblems,
  colourwaysInUse,
  contextOf,
  invalid,
  isUniqueViolation,
  lockStyle,
  offerOf,
  prefixed,
  readStyle,
  styleViewInTx,
  VARIANT_COLUMNS,
} from './store'

/**
 * A style's colourways (feature PRD-004): added, renamed, archived (out of new use: their SKUs go off, never deleted,
 * PRD-022) and restored (their SKUs in the range come back). A colourway's code changes only while nothing names it
 * (SKUs, BOM colours, order lines, coverage). Each write locks the style first (the matrix changes with it), then
 * compares and sets the colourway's own version; it records an audit row on the colourway and one on its style, and
 * `style.colourways_changed` (and `style.skus_changed` when SKUs moved).
 */

interface LockedStyle {
  readonly id: string
  readonly code: string
  readonly companyId: string | null
}

async function lockOpenStyle(tools: CommandTools, styleId: string): Promise<LockedStyle> {
  const locked = await lockStyle(tools.tx, styleId)
  if (locked.status === 'ARCHIVED') throw new InvalidStateError('This style is archived: reactivate it before changing its colourways.')
  return { id: styleId, code: locked.code, companyId: locked.companyId }
}

function recordOnStyle(tools: CommandTools, style: LockedStyle, colourwayId: string, change: { before?: unknown; after: unknown }): void {
  tools.audit({ recordType: 'Style', recordId: style.id, companyId: style.companyId, ...(change.before === undefined ? {} : { before: { colourway: change.before } }), after: { colourway: change.after } })
  tools.emit({ type: 'style.colourways_changed', subject: style.id, companyId: style.companyId, payload: { styleId: style.id, code: style.code, colourwayIds: [colourwayId] } })
}

/** Moves the SKUs after a colourway came or went (once the matrix exists). */
async function followColourways(tools: CommandTools, style: LockedStyle, before: readonly { id: string; code: string; status: 'ACTIVE' | 'ARCHIVED' }[]): Promise<void> {
  const { tx } = tools
  const row = await tx.style.findUniqueOrThrow({ where: { id: style.id }, select: { sizes: true } })
  const after = await tx.colourway.findMany({ where: { styleId: style.id }, select: { id: true, code: true, status: true } })
  const variants = await tx.variant.findMany({ where: { styleId: style.id }, select: VARIANT_COLUMNS })
  const plan = followPlan(style.code, offerOf(row.sizes, before), offerOf(row.sizes, after), variants)
  emitSkus(tools, style, await applyMatrixPlan(tools, style, plan))
}

/** product.styles.addColourway: a new colourway; once the matrix exists, its SKUs in every size of the range. */
export async function addColourway(caller: CommandCaller, styleId: string, body: ColourwayBody, idempotencyKey?: string): Promise<StyleView> {
  const context = contextOf(caller)
  const seen = await readStyle(caller, styleId)
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, seen.companyId)
  if (seen.status === 'ARCHIVED') throw new InvalidStateError('This style is archived: reactivate it before changing its colourways.')
  const colourway = normaliseColourway(body)
  const problems = prefixed(colourwayProblems(colourway))
  if (problems.length > 0) throw invalid(problems, 'colourway')

  const { result } = await command(caller, { name: 'product.styles.addColourway', idempotencyKey, input: { styleId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const style = await lockOpenStyle(tools, styleId)
    const library = await colourProblems(tx, colourway.colourId, style.companyId, 'body/colourId')
    if (library.length > 0) throw invalid(library, 'colourway')
    const before = await tx.colourway.findMany({ where: { styleId }, select: { id: true, code: true, status: true } })
    const taken = before.find((entry) => entry.code === colourway.code)
    if (taken) throw new ConflictError(taken.status === 'ARCHIVED' ? `The style had colourway ${colourway.code}; restore it instead.` : `The style has colourway ${colourway.code} already.`)
    const count = colourwayListProblems([colourway], before.map((entry) => entry.code))
    if (count.length > 0) throw invalid(prefixed(count), 'colourway')
    const id = newId()
    await tx.colourway.create({
      data: { id, styleId, ...colourway, createdAt: now, updatedAt: now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null },
      select: { id: true },
    })
    const after = { ...colourway, status: 'ACTIVE' }
    tools.audit({ recordType: 'Colourway', recordId: id, companyId: style.companyId, after })
    recordOnStyle(tools, style, id, { after: { id, ...after } })
    await followColourways(tools, style, before)
    return styleViewInTx(tx, styleId)
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw new ConflictError(`The style has colourway ${colourway.code} already.`)
    throw error
  })
  return result
}

/**
 * product.styles.updateColourway: its name, library colour or description (versioned per colourway); its code while
 * nothing names it; `status` ARCHIVED takes it out of new use (its SKUs go off), ACTIVE restores it.
 */
export async function updateColourway(caller: CommandCaller, styleId: string, colourwayId: string, body: UpdateColourwayBody, idempotencyKey?: string): Promise<StyleView> {
  const context = contextOf(caller)
  const seen = await readStyle(caller, styleId)
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, seen.companyId)
  if (seen.status === 'ARCHIVED') throw new InvalidStateError('This style is archived: reactivate it before changing its colourways.')
  if (!isUuid(colourwayId)) throw new NotFoundError('Colourway not found.')
  const found = await caller.withClient((client) => client.colourway.findUnique({ where: { id: colourwayId }, select: { styleId: true } }))
  if (!found || found.styleId !== styleId) throw new NotFoundError('Colourway not found.')

  const { result } = await command(caller, { name: 'product.styles.updateColourway', idempotencyKey, input: { styleId, colourwayId, ...body } }, async (tools) => {
    const { tx } = tools
    const style = await lockOpenStyle(tools, styleId)
    const before = await tx.colourway.findMany({ where: { styleId }, select: { id: true, code: true, status: true } })
    await bumpVersion(tx, 'colourway', colourwayId, body.version)
    const current = await tx.colourway.findUniqueOrThrow({ where: { id: colourwayId }, select: { code: true, name: true, colourId: true, description: true, status: true } })
    const next = normaliseColourway({
      code: body.code ?? current.code,
      name: body.name ?? current.name,
      colourId: body.colourId === undefined ? current.colourId : body.colourId,
      description: body.description === undefined ? current.description : body.description,
    })
    const problems = prefixed(colourwayProblems(next))
    if (body.colourId !== undefined && body.colourId !== current.colourId) problems.push(...(await colourProblems(tx, next.colourId, style.companyId, 'body/colourId')))
    if (problems.length > 0) throw invalid(problems, 'colourway')
    if (next.code !== current.code) {
      const refusal = colourwayCodeChangeRefusal(current.code, (await colourwaysInUse(tx, styleId)).has(colourwayId) ? 1 : 0)
      if (refusal) throw new ConflictError(refusal)
      if (before.some((entry) => entry.code === next.code)) throw new ConflictError(`The style has colourway ${next.code} already.`)
    }
    const move = body.status !== undefined && body.status !== current.status ? body.status : undefined
    if (move) assertTransition(colourwayMachine, current.status, move)
    await tx.colourway.update({ where: { id: colourwayId }, data: { ...next, ...(move ? { status: move } : {}) }, select: { id: true } })
    const shape = (entry: { code: string; name: string; colourId: string | null; description: string | null; status: string }) => ({
      code: entry.code,
      name: entry.name,
      colourId: entry.colourId,
      description: entry.description,
      status: entry.status,
    })
    const after = shape({ ...next, status: move ?? current.status })
    tools.audit({ recordType: 'Colourway', recordId: colourwayId, companyId: style.companyId, before: shape(current), after })
    recordOnStyle(tools, style, colourwayId, { before: { id: colourwayId, ...shape(current) }, after: { id: colourwayId, ...after } })
    if (move) await followColourways(tools, style, before)
    return styleViewInTx(tx, styleId)
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw new ConflictError('The style has a colourway with this code already.')
    throw error
  })
  return result
}
