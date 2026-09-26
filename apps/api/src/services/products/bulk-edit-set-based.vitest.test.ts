/**
 * P2 (docs/attributes/PLAN.md §4.7) — the set-based master attribute writes must store EXACTLY what the old
 * per-product statements stored. Each case runs both on twin products (same starting row) and compares the rows.
 *
 * The old statements are copied here verbatim from bulk-edit.service.ts before P2, so this file keeps the reference
 * even after the per-product path is gone.
 */
import { afterAll, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
import prisma from '../../db.js'
import { SET_BASED_CHUNK, setBasedAttrMerges, setBasedCascadedFields } from './bulk-edit.service.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
/** Production runs with business profiles on: every database call here runs inside a business, as real callers do. */
const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)

afterAll(async () => { await state.db?.close() })

type Merge = { id: string; patch: Record<string, unknown>; remove: string[] }

/** The pre-P2 statement, verbatim (the non-axis branch of `writeAttrMerge`). */
const oldMerge = (productId: string, patch: Record<string, unknown>, remove: string[] = []) => prisma.$executeRaw`
  UPDATE "Product"
  SET "categoryAttributes" = (COALESCE("categoryAttributes", '{}'::jsonb) - ${remove}::text[]) || ${JSON.stringify(patch)}::jsonb
  WHERE id = ${productId}
`
const oldRemove = (productId: string, fieldName: string) => prisma.$executeRaw`
  UPDATE "Product"
  SET "cascadedFields" = array_remove("cascadedFields", ${fieldName})
  WHERE id = ${productId}
`
const oldPush = (productId: string, fieldName: string) => prisma.product.update({ where: { id: productId }, data: { cascadedFields: { push: fieldName } } as any })

const START: Record<string, { attrs: Record<string, unknown> | null; cascaded: string[] }> = {
  p1: { attrs: { color: 'Nero', size: 'M', material: ['Poliestere'], keep: 1 }, cascaded: ['attr_color', 'attr_size', 'attr_color'] },
  p2: { attrs: null, cascaded: [] },
  p3: { attrs: { variations: { Color: 'Nero' }, pattern: 'Solid' }, cascaded: ['attr_pattern'] },
}

beforeEach(() => scoped(async () => {
  await prisma.product.deleteMany({ where: { sku: { startsWith: 'SETBASED-' } } })
  for (const twin of ['old', 'new']) for (const [id, start] of Object.entries(START)) {
    await prisma.product.create({ data: { id: `${twin}-${id}`, sku: `SETBASED-${twin}-${id}`, name: id, basePrice: 1,
      categoryAttributes: (start.attrs ?? undefined) as never, cascadedFields: start.cascaded } })
  }
}))

async function rows(twin: 'old' | 'new') {
  const found = await prisma.product.findMany({ where: { id: { startsWith: `${twin}-` } }, select: { id: true, categoryAttributes: true, cascadedFields: true }, orderBy: { id: 'asc' } })
  return found.map(row => ({ ...row, id: row.id.slice(twin.length + 1) }))
}

const SEQUENCE: Merge[] = [
  { id: 'p1', patch: { color: 'Rosso' }, remove: [] },
  { id: 'p1', patch: { size: 'L', fit: 'Slim' }, remove: ['material'] },
  { id: 'p1', patch: { material: ['Cotone'] }, remove: ['fit'] },          // a later step re-sets a removed key and removes an earlier set key
  { id: 'p2', patch: { color: 'Blu' }, remove: ['nothing-there'] },         // NULL bag
  { id: 'p3', patch: { pattern: 'Striped' }, remove: [] },
  { id: 'p3', patch: {}, remove: ['pattern'] },                             // set, then cleared
]

it('stores exactly what the old per-product statements stored, for a mixed ordered sequence', () => scoped(async () => {
  for (const merge of SEQUENCE) await oldMerge(`old-${merge.id}`, merge.patch, merge.remove)
  const noAxes = new Map()
  const statements = setBasedAttrMerges(SEQUENCE.map(m => ({ ...m, id: `new-${m.id}` })), () => { throw new Error('no axis merge expected') }, noAxes)
  expect(statements).toHaveLength(1)
  for (const statement of statements) await statement
  const expected = await rows('old')
  expect(await rows('new')).toEqual(expected)
  // Positive control: the sequence really changed the rows (a no-op would also compare equal).
  expect(expected.find(r => r.id === 'p1')!.categoryAttributes).toEqual({ color: 'Rosso', size: 'L', material: ['Cotone'], keep: 1 })
  expect(expected.find(r => r.id === 'p3')!.categoryAttributes).toEqual({ variations: { Color: 'Nero' } })
}))

it('removes and pushes cascadedFields exactly as array_remove and Prisma push did', () => scoped(async () => {
  const removals = new Map([['p1', ['attr_color']], ['p3', ['attr_pattern', 'attr_absent']]])
  const pushes = new Map([['p1', ['attr_fit', 'attr_fit']], ['p2', ['attr_color']]])
  for (const [id, fields] of removals) for (const field of fields) await oldRemove(`old-${id}`, field)
  for (const [id, fields] of pushes) for (const field of fields) await oldPush(`old-${id}`, field)
  const prefix = (m: Map<string, string[]>) => new Map([...m].map(([id, f]) => [`new-${id}`, f]))
  for (const statement of setBasedCascadedFields(prefix(removals), 'remove')) await statement
  for (const statement of setBasedCascadedFields(prefix(pushes), 'push')) await statement
  const expected = await rows('old')
  expect((await rows('new')).map(r => ({ id: r.id, cascadedFields: r.cascadedFields }))).toEqual(expected.map(r => ({ id: r.id, cascadedFields: r.cascadedFields })))
  expect(expected.find(r => r.id === 'p1')!.cascadedFields).toEqual(['attr_size', 'attr_fit', 'attr_fit'])
}))

it('keeps the per-product statement, in order, for a product whose merge touches its variation axes', () => scoped(async () => {
  const owners = new Map([['new-p3', { categoryAttributes: { variations: { Color: 'Nero' } }, variantAttributes: null, variationAxes: ['Color'] }]])
  const calls: string[] = []
  const statements = setBasedAttrMerges([
    { id: 'new-p1', patch: { color: 'Rosso' }, remove: [] },
    { id: 'new-p3', patch: { Color: 'Giallo' }, remove: [] },
    { id: 'new-p3', patch: { pattern: 'Striped' }, remove: [] },
  ], (id, patch) => { calls.push(`${id}:${Object.keys(patch).join(',')}`); return Promise.resolve() }, owners)
  // Both of p3's merges go through the axis-aware writer, in order; p1 is one set-based statement.
  expect(calls).toEqual(['new-p3:Color', 'new-p3:pattern'])
  expect(statements).toHaveLength(3)
}))

it('writes 2,500 products in two statements: the count follows the chunk size, not the product count', () => scoped(async () => {
  const merges = Array.from({ length: 2500 }, (_, i) => ({ id: `x${i}`, patch: { color: 'Nero' }, remove: [] }))
  expect(SET_BASED_CHUNK).toBe(2000)
  expect(setBasedAttrMerges(merges, () => Promise.resolve(), new Map())).toHaveLength(2)
  expect(setBasedCascadedFields(new Map(merges.map(m => [m.id, ['attr_color']])), 'push')).toHaveLength(2)
}))
