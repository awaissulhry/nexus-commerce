/**
 * P3b S3 (docs/attributes/PLAN.md §10.9) — placement, archive instead of delete, and undo.
 *
 *   · pure: the placement asked for, and what it does to family requirements;
 *   · on PostgreSQL (the scope fixtures, row-level security): a move restricts an "everywhere" requirement to the
 *     channels and writes an audit row; undo restores exactly, and refuses once the attribute changed again; a move
 *     that would hide a required attribute is refused and changes nothing; archive refuses a required attribute;
 *     delete refuses an attribute with values or links ("archive instead") and deletes an unused one;
 *   · publish parity on F4: the eBay values resolved for the product are identical before and after a move; the
 *     Shared view loses exactly the moved attributes that no family requires (S4), and keeps the required one;
 *   · another business cannot move this business's attribute.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(), refreshMany: vi.fn() }, FACE_IMAGE_ORDER_BY: [], FACE_IMAGE_SELECT: {}, pickFaceImage: () => null }))
import prisma from '../../db.js'
import { withWorkspace } from '../../lib/workspace-context.js'
import { createScopeFixtures, type ScopeFixture, type ScopeFixtureKey } from '../../test-support/attribute-scope-fixtures.js'
import {
  archiveAttribute, attributeUsage, deleteAttribute, parsePlacement, PlacementError, requirementsAfter, restoreAttribute,
  setAttributePlacement, undoPlacementChange,
} from './attribute-placement.service.js'
import { resolveBatch } from './mapping/resolve-batch.service.js'
import { getStudioSheet } from './studio-sheet.service.js'

describe('parsePlacement — pure', () => {
  it('normalises channels (upper case, unique, sorted)', () => {
    expect(parsePlacement({ placement: 'channel', channels: ['ebay', 'AMAZON', 'ebay'] })).toEqual({ placement: 'channel', placementChannels: ['AMAZON', 'EBAY'] })
    expect(parsePlacement({ placement: 'shared' })).toEqual({ placement: 'shared', placementChannels: [] })
  })
  it.each([
    [{ placement: 'global' }, "placement must be 'shared' or 'channel'"],
    [{ placement: 'channel' }, 'name at least one channel'],
    [{ placement: 'channel', channels: ['OTTO'] }, 'unknown channel: OTTO'],
    [{ placement: 'shared', channels: ['EBAY'] }, 'a Shared attribute takes no channels'],
    [{ placement: 'channel', channels: 'EBAY' }, 'channels must be a list'],
  ])('refuses %j', (input, message) => {
    expect(() => parsePlacement(input)).toThrow(message)
  })
})

describe('requirementsAfter — pure', () => {
  const req = (familyLabel: string, channels: string[]) => ({ familyAttributeId: familyLabel, familyId: familyLabel, familyLabel, channels })
  it('restricts an "everywhere" requirement to the new channels, keeps one inside them, flags one outside them', () => {
    const r = requirementsAfter([req('Jackets', []), req('Suits', ['AMAZON']), req('Gloves', ['EBAY'])], { placement: 'channel', placementChannels: ['AMAZON'] })
    expect(r.requirements.map(x => [x.familyLabel, x.channels])).toEqual([['Jackets', ['AMAZON']], ['Suits', ['AMAZON']], ['Gloves', ['EBAY']]])
    expect(r.conflicts).toEqual([{ familyLabel: 'Gloves', channels: ['EBAY'] }])
  })
  it('moving to Shared changes no requirement', () => {
    const before = [req('Jackets', ['AMAZON'])]
    expect(requirementsAfter(before, { placement: 'shared', placementChannels: [] })).toEqual({ requirements: before, conflicts: [] })
  })
})

describe('on PostgreSQL — the scope fixtures', () => {
  let fixtures: Record<ScopeFixtureKey, ScopeFixture>
  const inF4 = <T>(work: () => Promise<T>) => withWorkspace(fixtures.F4.context, work)
  const attr = (code: string) => inF4(() => prisma.customAttribute.findFirstOrThrow({ where: { code }, include: { familyAttributes: true } }))
  const refusal = async (work: () => Promise<unknown>) => { try { await work(); return null } catch (e) { if (e instanceof PlacementError) return { status: e.status, message: e.message }; throw e } }

  beforeAll(async () => {
    fixtures = await createScopeFixtures(state.db.client)
    // F4's Jackets family requires `department` everywhere and `closure` on eBay only.
    await inF4(async () => {
      for (const [code, channels] of [['department', []], ['closure', ['EBAY']]] as const) {
        const a = await prisma.customAttribute.findFirstOrThrow({ where: { code } })
        await prisma.familyAttribute.updateMany({ where: { attributeId: a.id }, data: { required: true, channels: [...channels] } })
      }
    })
  }, 300_000)
  afterAll(async () => { await state.db?.close() }, 30_000)

  it('a move restricts the "everywhere" requirement, is audited, and undo restores it exactly', async () => {
    const department = await attr('department')
    const moved = await inF4(() => setAttributePlacement(department.id, { placement: 'channel', channels: ['AMAZON'] }, { userId: null, ip: '127.0.0.1' }))
    expect(moved.changed).toBe(true)
    expect((await attr('department'))).toMatchObject({ placement: 'channel', placementChannels: ['AMAZON'] })
    expect((await attr('department')).familyAttributes[0].channels).toEqual(['AMAZON'])
    const audit = await inF4(() => prisma.auditLog.findUniqueOrThrow({ where: { id: moved.auditId! } }))
    expect(audit).toMatchObject({ entityType: 'CustomAttribute', entityId: department.id, action: 'attribute.placement', ip: '127.0.0.1' })
    // The same move again is a no-op: no second audit row.
    expect(await inF4(() => setAttributePlacement(department.id, { placement: 'channel', channels: ['AMAZON'] }))).toMatchObject({ changed: false, auditId: null })

    const undone = await inF4(() => undoPlacementChange(moved.auditId!))
    expect(await attr('department')).toMatchObject({ placement: 'shared', placementChannels: [] })
    expect((await attr('department')).familyAttributes[0]).toMatchObject({ required: true, channels: [] })
    expect(undone.restored.placement).toBe('shared')
    // The attribute no longer equals that change's `after`: a second undo of it is refused.
    expect(await refusal(() => inF4(() => undoPlacementChange(moved.auditId!)))).toMatchObject({ status: 409 })
  })

  it('refuses a move that would hide a required attribute, and changes nothing', async () => {
    const closure = await attr('closure')
    const r = await refusal(() => inF4(() => setAttributePlacement(closure.id, { placement: 'channel', channels: ['AMAZON'] })))
    expect(r).toMatchObject({ status: 409, message: expect.stringContaining('required on EBAY in the family Jackets') })
    expect(await attr('closure')).toMatchObject({ placement: 'shared', placementChannels: [] })
    expect((await attr('closure')).familyAttributes[0].channels).toEqual(['EBAY'])
  })

  it('archive refuses a required attribute; an optional one is archived and restored', async () => {
    expect(await refusal(async () => inF4(async () => archiveAttribute((await attr('department')).id)))).toMatchObject({ status: 409 })
    const flavor = await attr('flavor')
    expect(await inF4(() => archiveAttribute(flavor.id))).toMatchObject({ changed: true })
    expect((await attr('flavor')).archivedAt).not.toBeNull()
    expect(await refusal(() => inF4(() => setAttributePlacement(flavor.id, { placement: 'channel', channels: ['AMAZON'] })))).toMatchObject({ status: 409 })
    expect(await inF4(() => restoreAttribute(flavor.id))).toMatchObject({ changed: true })
    expect((await attr('flavor')).archivedAt).toBeNull()
  })

  it('delete refuses an attribute with family links or values ("archive instead"), and deletes an unused one', async () => {
    const scent = await attr('scent')
    expect(await refusal(() => inF4(() => deleteAttribute(scent.id)))).toMatchObject({ status: 409, message: expect.stringContaining('Archive it instead') })
    // A value alone also counts.
    await inF4(() => prisma.product.update({ where: { id: fixtures.F4.productId }, data: { categoryAttributes: { lone_value: 'kept' } } }))
    const group = await inF4(() => prisma.attributeGroup.findFirstOrThrow({ where: { code: 'scope-copied' } }))
    const lone = await inF4(() => prisma.customAttribute.create({ data: { code: 'lone_value', label: 'Lone', type: 'text', groupId: group.id } }))
    expect(await inF4(() => attributeUsage('lone_value', lone.id))).toEqual({ products: 1, translations: 0, families: 0 })
    expect(await refusal(() => inF4(() => deleteAttribute(lone.id)))).toMatchObject({ status: 409 })
    const unused = await inF4(() => prisma.customAttribute.create({ data: { code: 'never_used', label: 'Never used', type: 'text', groupId: group.id } }))
    expect(await inF4(() => deleteAttribute(unused.id))).toEqual({ ok: true, id: unused.id })
    expect(await inF4(() => prisma.customAttribute.findUnique({ where: { id: unused.id } }))).toBeNull()
    expect(await inF4(() => prisma.auditLog.count({ where: { entityId: unused.id, action: 'attribute.delete' } }))).toBe(1)
  })

  it('publish parity: the eBay values are identical after a move; Shared drops only the moved optional attributes (S4)', async () => {
    const snapshot = () => inF4(async () => {
      const batch = await resolveBatch({ productIds: [fixtures.F4.productId], channel: 'EBAY', marketplace: 'IT' })
      const sheet = await getStudioSheet({ productId: fixtures.F4.productId, scope: 'master', market: 'IT', locale: 'it' } as never)
      return { cells: JSON.stringify(batch.products.map(p => p.cells)), columns: sheet.columns.map(c => c.key) }
    })
    const before = await snapshot()
    const moved: string[] = []
    for (const code of ['department', 'weave_type', 'batteries_required']) {
      const a = await attr(code)
      const r = await inF4(() => setAttributePlacement(a.id, { placement: 'channel', channels: ['AMAZON'] }))
      if (r.changed) moved.push(r.auditId!)
    }
    expect(moved.length).toBe(3)
    const after = await snapshot()
    expect(after.cells).toBe(before.cells)
    // `department` is required (on Amazon now): never hidden. The two optional ones leave Shared, and nothing else does.
    expect(before.columns.filter(k => !after.columns.includes(k)).sort()).toEqual(['batteries_required', 'weave_type'])
    expect(after.columns.filter(k => !before.columns.includes(k))).toEqual([])
    for (const auditId of moved.reverse()) await inF4(() => undoPlacementChange(auditId))
    expect((await snapshot()).columns).toEqual(before.columns)                      // undo brings them back at once
  }, 180_000)

  it('another business cannot move this business\'s attribute', async () => {
    const department = await attr('department')
    expect(await refusal(() => withWorkspace(fixtures.F1.context, () => setAttributePlacement(department.id, { placement: 'shared' })))).toMatchObject({ status: 404 })
  })
})
