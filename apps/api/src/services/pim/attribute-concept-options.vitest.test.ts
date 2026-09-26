/**
 * The concept value lists as business options (the Owner's "option A", 2026-09-26): `applyConceptOptions` adds the
 * `color` and `size` values to the attribute linked to each concept, on PostgreSQL with the generated row-level-security
 * policies (`formulaDatabase`). Businesses are created through the real `createWorkspaceService().create`; a new business
 * now starts WITH these options (`optionsFor`), so `beforeAll` removes them to stand in for a business created before —
 * what the backfill exists for (both businesses in production were).
 *
 * Run: npx vitest run src/services/pim/attribute-concept-options.vitest.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
import prisma from '../../db.js'
import { createWorkspaceService } from '../workspace.service.js'
import { withWorkspace, type WorkspaceContext } from '../../lib/workspace-context.js'
import { applyConceptOptions, conceptOptionsPlan, ConceptOptionsError } from './attribute-concepts.service.js'

const businesses: Record<'a' | 'b' | 'c', WorkspaceContext> = {} as never
const inBusiness = <T>(key: keyof typeof businesses, work: () => Promise<T>) => withWorkspace(businesses[key], work)
const optionsOf = (key: keyof typeof businesses, code: string) => inBusiness(key, () => prisma.attributeOption.findMany({
  where: { attribute: { code } }, orderBy: { sortOrder: 'asc' }, select: { code: true, label: true, synonyms: true, sortOrder: true, metadata: true } }))

const COLOURS = ['black', 'white', 'grey', 'red', 'blue', 'green', 'yellow', 'orange', 'brown', 'pink', 'purple', 'beige', 'multicolour']
const SIZES = ['xxs', 'xs', 's', 'm', 'l', 'xl', 'xxl', '3xl', '4xl', '5xl', 'one_size']

beforeAll(async () => {
  await state.db.client.role.create({ data: { key: 'OWNER', name: 'Owner', isSystem: true } })
  const service = createWorkspaceService(state.db.client)
  for (const key of ['a', 'b', 'c'] as const) {
    const user = await state.db.client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active' } })
    const created = await service.create(user.id, { name: `Business ${key}`, country: 'IT', currency: 'EUR', timezone: 'Europe/Rome', creationKey: randomUUID() })
    businesses[key] = (await service.membership(user.id, created.id)).context
    await inBusiness(key, () => prisma.attributeOption.deleteMany({ where: { attribute: { code: { in: ['color', 'size'] } } } }))
  }
}, 180_000)
afterAll(async () => { await state.db?.close() }, 30_000)

describe('colour and size options from the concept lists', () => {
  it('plans every value in concept order, with the Italian label and every language, and writes nothing on a dry run', async () => {
    const plan = await inBusiness('a', () => applyConceptOptions())
    expect(plan).toMatchObject({ applied: false, counts: { create: COLOURS.length + SIZES.length, present: 0, matched: 0, 'no-attribute': 0 } })
    const created = plan.entries.filter(e => e.action === 'create')
    expect(created.filter(e => e.concept === 'color').map(e => e.code)).toEqual(COLOURS)
    expect(created.filter(e => e.concept === 'size').map(e => [e.code, e.action === 'create' && e.sortOrder])).toEqual(SIZES.map((code, i) => [code, i]))
    const black = created.find(e => e.code === 'black')!
    expect(black).toMatchObject({ label: 'Nero', labels: { en: 'Black', it: 'Nero', de: 'Schwarz', fr: 'Noir', es: 'Negro' } })
    expect(black.action === 'create' && black.synonyms).toEqual(expect.arrayContaining(['Black', 'Schwarz', 'Noir', 'Negro']))
    expect(black.action === 'create' && black.synonyms).not.toContain('Nero')
    expect(created.find(e => e.code === 'orange')).toMatchObject({ label: 'Arancione', synonyms: expect.arrayContaining(['Arancia']) })
    expect(created.find(e => e.code === 'one_size')).toMatchObject({ label: 'Taglia unica' })
    expect(created.find(e => e.code === 'xs')).toMatchObject({ label: 'XS', synonyms: [] })
    expect(await optionsOf('a', 'color')).toEqual([])
  })

  it('writes the plan, then finds every option present and writes nothing more', async () => {
    const applied = await inBusiness('a', () => applyConceptOptions({ dryRun: false }))
    expect(applied).toMatchObject({ applied: true, counts: { create: COLOURS.length + SIZES.length } })
    const colours = await optionsOf('a', 'color')
    expect(colours.map(o => o.code)).toEqual(COLOURS)
    expect(colours.find(o => o.code === 'black')).toMatchObject({ label: 'Nero', metadata: { labels: { en: 'Black', de: 'Schwarz' } } })
    expect((await optionsOf('a', 'size')).map(o => o.code)).toEqual(SIZES)
    const again = await inBusiness('a', () => applyConceptOptions({ dryRun: false }))
    expect(again.counts).toMatchObject({ create: 0, present: COLOURS.length + SIZES.length })
    expect(await optionsOf('a', 'color')).toEqual(colours)
  })

  it('never changes or duplicates an option the business already has, and appends after it', async () => {
    const color = await inBusiness('b', () => prisma.customAttribute.findFirstOrThrow({ where: { code: 'color' }, select: { id: true } }))
    await inBusiness('b', () => prisma.attributeOption.createMany({ data: [
      { attributeId: color.id, code: 'nero', label: 'Nero', sortOrder: 4 },
      { attributeId: color.id, code: 'red', label: 'Rosso scuro', sortOrder: 5 },
    ] }))
    const plan = await inBusiness('b', () => conceptOptionsPlan(['color']))
    expect(plan.entries.find(e => e.code === 'black')).toMatchObject({ action: 'matched', existingCode: 'nero' })
    expect(plan.entries.find(e => e.code === 'red')).toMatchObject({ action: 'present', existingCode: 'red' })
    expect(plan.entries.find(e => e.code === 'white')).toMatchObject({ action: 'create', sortOrder: 6 })
    await inBusiness('b', () => applyConceptOptions({ concepts: ['color'], dryRun: false }))
    const after = await optionsOf('b', 'color')
    expect(after.filter(o => ['nero', 'red', 'black'].includes(o.code)).map(o => [o.code, o.label])).toEqual([['nero', 'Nero'], ['red', 'Rosso scuro']])
    expect(after).toHaveLength(2 + COLOURS.length - 2)
    // Only the concept asked for: size is untouched.
    expect(await optionsOf('b', 'size')).toEqual([])
  })

  it('keeps businesses apart', async () => {
    expect(await optionsOf('c', 'color')).toEqual([])
    const a = await optionsOf('a', 'color')
    expect(a.map(o => o.code)).toEqual(COLOURS)
  })

  it('skips an archived attribute and refuses a concept without a value list', async () => {
    await inBusiness('c', () => prisma.customAttribute.updateMany({ where: { code: 'size' }, data: { archivedAt: new Date() } }))
    const plan = await inBusiness('c', () => conceptOptionsPlan(['size']))
    expect(plan.entries).toEqual([{ concept: 'size', action: 'no-attribute' }])
    await expect(inBusiness('c', () => conceptOptionsPlan(['title']))).rejects.toBeInstanceOf(ConceptOptionsError)
    await expect(inBusiness('c', () => conceptOptionsPlan(['no_such_concept']))).rejects.toBeInstanceOf(ConceptOptionsError)
  })
})
