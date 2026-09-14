import { createHash, randomUUID } from 'node:crypto'
import prisma from '../../../db.js'
import { inDatabaseTransaction } from '../../../lib/database-context.js'
import { assertFormulaListingScope, previewCellFormula, readFormulaCell, setCellFormula, setCellLiteral, restoreFormulaSnapshot, type CellCoordinate } from './cell-formula.service.js'

export interface FormulaBatchInput extends Omit<CellCoordinate, 'productId'> {
  operationId?: string
  expr: string
  rows: Array<{ productId: string; label?: string; expectedState?: string; expectedValue?: unknown }>
  mode: 'once' | 'linked'
  updatedBy?: string | null
  ip?: string | null
}
type Actor = Pick<FormulaBatchInput, 'updatedBy' | 'ip'>
type Snapshot = Awaited<ReturnType<typeof readFormulaCell>>
type Recipe = { kind: 'product-formula-v2'; destinationVersion?: 1; hash: string; familyProductId: string; input: FormulaBatchInput }
export type FormulaOperationRow = { productId: string; label?: string; ok: boolean; status: 'pending' | 'applied' | 'failed' | 'restored' | 'undo-refused' | 'not-applied'; before?: unknown; value?: unknown; error?: string }
const reason = (error: unknown) => error instanceof Error ? error.message : String(error)
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const receiptId = (id: string, phase: string, position: number) => `formula:${digest([id, phase, position])}`
const receiptWhere = (id: string) => ({ entityType: 'FormulaOperation', entityId: id })
const coordinate = (input: FormulaBatchInput, productId: string): CellCoordinate => ({ productId,
  fieldKey: input.fieldKey, scope: input.scope, channel: input.channel, marketplace: input.marketplace,
  market: input.market, locale: input.locale, channelConnectionId: input.channelConnectionId, aliasKey: input.aliasKey,
  contentAddress: input.contentAddress, contentAcknowledged: input.contentAcknowledged })

function assertRecoveryDestination(recipe: Recipe) {
  if (recipe.input.scope === 'channel' && recipe.destinationVersion !== 1) throw new Error('This older operation has no recorded account destination. Its history is preserved; review and bind the original account before continuing or restoring it.')
}

async function operationFor(id: string, actor: Actor) {
  const operation = await prisma.bulkOperation.findUnique({ where: { id } })
  const recipe = operation?.changes as unknown as Recipe
  if (!operation || recipe?.kind !== 'product-formula-v2') throw new Error('This saved formula operation was not found.')
  if (operation.userId && operation.userId !== actor.updatedBy) throw new Error('This operation belongs to another user.')
  return { operation, recipe }
}

export async function previewFormulaBatch(input: FormulaBatchInput) {
  const rows = []
  // Keep schema/database work bounded while preserving the selection order.
  for (let start = 0; start < input.rows.length; start += 4) {
    rows.push(...await Promise.all(input.rows.slice(start, start + 4).map(async row => {
      try { return { productId: row.productId, ...await previewCellFormula({ ...input, ...row, allowSelfReference: input.mode === 'once' }) } }
      catch (error) { return { productId: row.productId, ok: false, error: reason(error) } }
    })))
  }
  return { rows }
}

export async function readFormulaOperation(id: string, actor: Actor) {
  const { operation, recipe } = await operationFor(id, actor)
  const receipts = await prisma.auditLog.findMany({ where: receiptWhere(id), orderBy: { createdAt: 'asc' } })
  const byId = new Map(receipts.map(row => [row.id, row]))
  const rows: FormulaOperationRow[] = recipe.input.rows.map((row, position) => {
    const applied = byId.get(receiptId(id, 'apply', position))
    const undo = byId.get(receiptId(id, 'undo', position))
    const metadata = (undo?.metadata ?? applied?.metadata) as unknown as FormulaOperationRow | undefined
    return { productId: row.productId, label: row.label, ok: false, status: operation.status.startsWith('UNDO') ? 'not-applied' : 'pending',
      ...(applied ? { before: (applied.before as unknown as Snapshot | null)?.value, value: (applied.after as unknown as Snapshot | null)?.value } : {}), ...metadata }
  })
  return { operationId: id, status: operation.status, processed: operation.processed ?? 0, total: operation.total ?? rows.length,
    createdAt: operation.createdAt, fieldKey: recipe.input.fieldKey, expr: recipe.input.expr, mode: recipe.input.mode, rows }
}

export async function listFormulaOperations(input: { channelConnectionId?: string; aliasKey?: string; familyProductId: string; scope: string; channel?: string; marketplace?: string; market?: string; locale?: string } & Actor) {
  const operations = await prisma.bulkOperation.findMany({ where: {
    userId: input.updatedBy ?? null,
    AND: [
      { changes: { path: ['kind'], equals: 'product-formula-v2' } },
      { changes: { path: ['familyProductId'], equals: input.familyProductId } },
      ...(['scope', 'channel', 'marketplace', 'market', 'locale', 'channelConnectionId', 'aliasKey'] as const).filter(key => input[key] !== undefined).map(key => ({ changes: { path: ['input', key], equals: input[key]! } })),
    ],
  }, orderBy: { createdAt: 'desc' }, take: 20 })
  return { operations: operations.map(operation => {
    const recipe = operation.changes as unknown as Recipe
    return { operationId: operation.id, status: operation.status, createdAt: operation.createdAt,
      processed: operation.processed ?? 0, total: operation.total ?? 0, fieldKey: recipe.input.fieldKey, expr: recipe.input.expr, mode: recipe.input.mode }
  }) }
}

/** The caller retains this ID before sending. Replaying a lost response cannot apply twice. */
export async function applyFormulaBatch(input: FormulaBatchInput) {
  await assertFormulaListingScope(input)
  const { operationId = randomUUID(), updatedBy, ip, ...request } = input
  const hash = digest(request)
  const first = await prisma.product.findUnique({ where: { id: request.rows[0].productId }, select: { id: true, parentId: true } })
  if (!first) throw new Error('The selected product was not found.')
  const recipe: Recipe = { kind: 'product-formula-v2', destinationVersion: 1, hash, familyProductId: first.parentId ?? first.id, input: request }
  await prisma.bulkOperation.upsert({ where: { id: operationId }, update: {}, create: {
    id: operationId, userId: updatedBy, productCount: request.rows.length, changeCount: request.rows.length,
    status: 'APPLYING', changes: recipe as never, total: request.rows.length, processed: 0,
  } })
  const saved = await operationFor(operationId, input)
  if (saved.recipe.hash !== hash) throw new Error('This operation ID already belongs to a different formula. Preview a new operation.')
  return continueFormulaBatch(operationId, { updatedBy, ip })
}

async function lockOperation(id: string) {
  await prisma.$queryRaw`SELECT id FROM "BulkOperation" WHERE id = ${id} FOR UPDATE`
  return prisma.bulkOperation.findUniqueOrThrow({ where: { id } })
}

async function record(id: string, phase: 'apply' | 'undo', position: number, row: FormulaOperationRow, actor: Actor, before?: Snapshot, after?: Snapshot) {
  await prisma.auditLog.create({ data: { id: receiptId(id, phase, position), ...receiptWhere(id),
    action: `formula.bulk.${row.status}`, userId: actor.updatedBy, ip: actor.ip,
    ...(before ? { before: before as never } : {}), ...(after ? { after: after as never } : {}), metadata: row as never } })
  await prisma.bulkOperation.update({ where: { id }, data: { processed: { increment: 1 } } })
}

/** At most five products per request. Closing or reloading can safely resume at the durable cursor. */
export async function continueFormulaBatch(id: string, actor: Actor) {
  const { recipe } = await operationFor(id, actor)
  assertRecoveryDestination(recipe)
  const changed: FormulaOperationRow[] = []
  for (let step = 0; step < 5; step++) {
    let attempted: { phase: 'apply' | 'undo'; position: number; cursor: number } | undefined
    try {
      const result = await inDatabaseTransaction(prisma, async () => {
        const operation = await lockOperation(id)
        const phase = operation.status === 'APPLYING' ? 'apply' : operation.status === 'UNDOING' ? 'undo' : null
        const cursor = operation.processed ?? 0
        if (!phase || cursor >= recipe.input.rows.length) return null
        const position = phase === 'apply' ? cursor : recipe.input.rows.length - 1 - cursor
        attempted = { phase, position, cursor }
        const target = recipe.input.rows[position]
        const coord = coordinate(recipe.input, target.productId)
        const row: FormulaOperationRow = { productId: target.productId, label: target.label, ok: true, status: phase === 'apply' ? 'applied' : 'restored' }
        if (phase === 'apply') {
          if (!target.expectedState) throw new Error('Preview this product before applying the formula.')
          const before = await readFormulaCell(coord)
          if (before.expectedState !== target.expectedState) throw new Error('This product changed after the preview. Preview again before applying.')
          const checked = await previewCellFormula({ ...coord, expr: recipe.input.expr, allowSelfReference: recipe.input.mode === 'once' })
          if (!checked.ok) throw new Error(checked.error ?? 'This formula cannot be applied.')
          if (Object.prototype.hasOwnProperty.call(target, 'expectedValue') && digest(target.expectedValue) !== digest(checked.value)) throw new Error('The calculation changed after the preview. Preview again before applying.')
          if (recipe.input.mode === 'once') await setCellLiteral({ ...coord, value: checked.value, expectedState: target.expectedState, ...actor })
          else {
            const saved = await setCellFormula({ ...coord, expr: recipe.input.expr, expectedState: target.expectedState, expectedValue: checked.value, ...actor })
            if (saved.error) throw new Error(saved.error)
          }
          const after = await readFormulaCell(coord)
          Object.assign(row, { before: before.value, value: after.value })
          await record(id, phase, position, row, actor, before, after)
        } else {
          const receipt = await prisma.auditLog.findUnique({ where: { id: receiptId(id, 'apply', position) } })
          if (receipt?.action !== 'formula.bulk.applied') {
            row.status = 'not-applied'; row.ok = false
            await record(id, phase, position, row, actor)
            return row
          }
          const before = receipt.before as unknown as Snapshot
          const after = receipt.after as unknown as Snapshot
          const current = await readFormulaCell(coord)
          if (current.targetState !== after.targetState) throw new Error('This product changed since the operation. Its newer changes were kept.')
          await restoreFormulaSnapshot({ ...coord, snapshot: before, expectedState: current.expectedState, ...actor })
          const restored = await readFormulaCell(coord)
          Object.assign(row, { before: before.value, value: restored.value })
          await record(id, phase, position, row, actor, current, restored)
        }
        return row
      })
      if (!result) break
      changed.push(result)
    } catch (error) {
      if (!attempted) throw error
      const { phase, position, cursor } = attempted
      // A fresh transaction establishes whether the previous commit succeeded before recording a refusal.
      const result = await inDatabaseTransaction(prisma, async () => {
        const operation = await lockOperation(id)
        const receipt = await prisma.auditLog.findUnique({ where: { id: receiptId(id, phase, position) } })
        if (receipt) return receipt.metadata as unknown as FormulaOperationRow
        if (operation.processed !== cursor || operation.status !== (phase === 'apply' ? 'APPLYING' : 'UNDOING')) return null
        const target = recipe.input.rows[position]
        const row: FormulaOperationRow = { productId: target.productId, label: target.label, ok: false, status: phase === 'apply' ? 'failed' : 'undo-refused', error: reason(error) }
        await record(id, phase, position, row, actor)
        return row
      })
      if (result) changed.push(result)
    }
  }
  const operation = await inDatabaseTransaction(prisma, async () => {
    const current = await lockOperation(id)
    if ((current.processed ?? 0) < recipe.input.rows.length || !['APPLYING', 'UNDOING'].includes(current.status)) return current
    const undo = current.status === 'UNDOING'
    const failed = await prisma.auditLog.count({ where: { ...receiptWhere(id), action: undo ? 'formula.bulk.undo-refused' : 'formula.bulk.failed' } })
    const status = undo ? (failed ? 'UNDO_PARTIAL' : 'UNDONE') : failed === recipe.input.rows.length ? 'FAILED' : failed ? 'PARTIAL' : 'SUCCESS'
    return prisma.bulkOperation.update({ where: { id }, data: { status, completedAt: new Date() } })
  })
  return { operationId: id, status: operation.status, processed: operation.processed ?? 0, total: recipe.input.rows.length, rows: changed }
}

export async function undoFormulaBatch(id: string, actor: Actor) {
  const { recipe } = await operationFor(id, actor)
  assertRecoveryDestination(recipe)
  await inDatabaseTransaction(prisma, async () => {
    const operation = await lockOperation(id)
    if (['APPLYING', 'SUCCESS', 'PARTIAL'].includes(operation.status)) {
      await prisma.bulkOperation.update({ where: { id }, data: { status: 'UNDOING', processed: 0, completedAt: null } })
    }
  })
  return continueFormulaBatch(id, actor)
}
