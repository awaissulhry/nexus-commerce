/**
 * MCP full control L10 — arrange-photos, run through the one door (call-tool.ts) on the Media page's photo plan
 * (`applyMediaPlanOps`), against a real PostgreSQL with the production schema and business-isolation policies (PGlite).
 *
 * Proven here: refused while the family is not on the media plan; the dry run is the plan edit written nowhere; the run is
 * that edit at the approved layer revision, as the approver, and a layer that moved since is refused; a photo that is not
 * in the family's library is refused; the undo is the edit's own inverse ops and puts the layer back.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'

const state = vi.hoisted(() => ({ db: null as any, events: [] as unknown[] }))
vi.mock('@nexus/database', async (original) => {
  const { formulaDatabase } = await import('../../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...(await original<object>()), default: state.db.client }
})
vi.mock('../../listing-events.service.js', () => ({ publishListingEvent: (event: unknown) => { state.events.push(event) } }))
vi.mock('../../product-event.service.js', () => ({ productEventService: { emit: async () => undefined, emitTx: async () => undefined } }))

import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const person = (userId: string): UserPrincipal => ({
  kind: 'user', userId, label: userId,
  permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
  workspace: business, via: 'claude',
})
const claude = person('u-l10-asker')
const approver = person('u-l10-approver')
type Json = Record<string, any>
const db = () => state.db.client

const dryRun = async (args: Json) => (await inside(() => callTool(claude, 'arrange-photos', args))).raw as Json
const run = async (args: Json, preview: Json) => (await inside(() => executeTool(approver, 'arrange-photos', args, { approvedPreview: JSON.parse(JSON.stringify(preview)), via: 'claude' }))).raw as Json
const layers = (productId: string) => inside(() => db().productMediaPlan.findMany({ where: { productId }, orderBy: { id: 'asc' } }))

const ids: Record<string, string> = {}
const img: Record<string, string> = {}
const SHARED = { layer: 'SHARED' }

beforeAll(async () => {
  await inside(async () => {
    ids.onPlan = (await db().product.create({ data: { sku: 'TEST-SKU-L10', name: 'L10 jacket', basePrice: 10, isParent: true } })).id
    ids.offPlan = (await db().product.create({ data: { sku: 'TEST-SKU-L10-OFF', name: 'L10 other', basePrice: 10 } })).id
    ids.other = (await db().product.create({ data: { sku: 'TEST-SKU-L10-X', name: 'L10 unrelated', basePrice: 10 } })).id
    for (const name of ['front', 'back', 'side'])
      img[name] = (await db().productImage.create({ data: { productId: ids.onPlan, url: `https://images.example.test/l10/${name}.jpg`, alt: name, type: 'ALT', width: 1600, height: 1600 } })).id
    img.foreign = (await db().productImage.create({ data: { productId: ids.other, url: 'https://images.example.test/l10/foreign.jpg', alt: 'foreign', type: 'ALT', width: 1600, height: 1600 } })).id
    // On the media plan: the family has its Shared layer.
    await db().productMediaPlan.create({ data: { productId: ids.onPlan, layer: 'SHARED', plan: { version: 1, sets: { common: [{ assetId: img.front }, { assetId: img.back }] } } } })
  })
}, 120_000)
afterAll(async () => { await state.db?.close() }, 60_000)
beforeEach(() => { state.events.length = 0 })

describe('arrange-photos', () => {
  it('is refused while the family is not on the media plan', async () => {
    expect((await dryRun({ productId: ids.offPlan, address: SHARED, ops: [{ op: 'axis', axis: null }] })).error).toContain('not on the media plan yet')
  })

  it('previews without writing, runs as approved and as the approver; its undo puts the layer back', async () => {
    const args = { productId: ids.onPlan, address: SHARED, ops: [{ op: 'reorder', set: 'common', assetIds: [img.back, img.front] }] }
    const before = await layers(ids.onPlan)
    const preview = await dryRun(args)
    expect(preview.preview).toMatchObject({ layer: 'SHARED', revision: 1, after: { sets: { common: [{ assetId: img.back }, { assetId: img.front }] } } })
    expect(await layers(ids.onPlan)).toEqual(before)
    expect(state.events).toEqual([])
    const ran = await run(args, preview.preview)
    expect(ran.ok, ran.error).toBe(true)
    const [shared] = await layers(ids.onPlan)
    expect(shared).toMatchObject({ revision: 2, updatedById: 'u-l10-approver', plan: { sets: { common: [{ assetId: img.back }, { assetId: img.front }] } } })
    const tool = getTool('arrange-photos')!
    expect(await inside(() => tool.undo!.current(ran.change))).toEqual(ran.change.after)
    const undo = tool.undo!.request(ran.change) as Json
    expect(undo).toMatchObject({ tool: 'arrange-photos', args: { productId: ids.onPlan, address: SHARED, ops: expect.any(Array) } })
    const back = await dryRun(undo.args)
    expect((await run(undo.args, back.preview)).ok).toBe(true)
    expect((await layers(ids.onPlan))[0].plan).toMatchObject({ sets: { common: [{ assetId: img.front }, { assetId: img.back }] } })
  })

  it('a layer that moved since the approval is refused, and a photo from outside the library too', async () => {
    const args = { productId: ids.onPlan, address: SHARED, ops: [{ op: 'insert', set: 'common', assetIds: [img.side] }] }
    const preview = await dryRun(args)
    await inside(() => db().productMediaPlan.updateMany({ where: { productId: ids.onPlan, layer: 'SHARED' }, data: { revision: { increment: 1 } } }))
    expect(await run(args, preview.preview)).toMatchObject({ ok: false, error: expect.stringContaining('changed since') })
    expect((await dryRun({ ...args, ops: [{ op: 'insert', set: 'common', assetIds: [img.foreign] }] })).error).toContain('not in this product\'s library')
  })
})
