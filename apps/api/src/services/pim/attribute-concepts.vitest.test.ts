/**
 * P3 (docs/attributes/PLAN.md §4.1, §4.8) — the concept dictionary, the bulk dictionary writer, and tenant safety,
 * on PostgreSQL with the generated row-level-security policies (`formulaDatabase`).
 *
 * Businesses are created through the real `createWorkspaceService().create`, so a new business's starter dictionary
 * is the one production creates.
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
import { customAttributeConcepts } from '@nexus/shared/attribute-concepts'
import { createWorkspaceService } from '../workspace.service.js'
import { withWorkspace, type WorkspaceContext } from '../../lib/workspace-context.js'
import { applyConceptDictionary, conceptDictionaryPlan, starterDictionaryRows } from './attribute-concepts.service.js'
import { upsertAttributes } from './attribute-dictionary.service.js'

const businesses: Record<'a' | 'b' | 'legacy', WorkspaceContext> = {} as never
const inBusiness = <T>(key: keyof typeof businesses, work: () => Promise<T>) => withWorkspace(businesses[key], work)

beforeAll(async () => {
  await state.db.client.role.create({ data: { key: 'OWNER', name: 'Owner', isSystem: true } })
  const service = createWorkspaceService(state.db.client)
  for (const key of ['a', 'b', 'legacy'] as const) {
    const user = await state.db.client.userProfile.create({ data: { email: `${randomUUID()}@example.test`, status: 'active' } })
    const created = await service.create(user.id, { name: `Business ${key}`, country: 'IT', currency: 'EUR', timezone: 'Europe/Rome', creationKey: randomUUID() })
    businesses[key] = (await service.membership(user.id, created.id)).context
  }
}, 180_000)
afterAll(async () => { await state.db?.close() }, 30_000)

describe('starter dictionary', () => {
  it('builds one linked attribute per custom concept, and options only for closed-list concepts', () => {
    let n = 0
    const rows = starterDictionaryRows(() => `id-${n++}`)
    expect(rows.attributes.map(a => a.code).sort()).toEqual(customAttributeConcepts().map(c => c.key).sort())
    expect(rows.attributes.every(a => a.semanticKey === a.code)).toBe(true)
    expect(new Set(rows.attributes.map(a => a.groupId))).toEqual(new Set(rows.groups.map(g => g.id)))
    const gender = rows.attributes.find(a => a.code === 'target_gender')!
    expect(gender.type).toBe('select')
    expect(rows.options.filter(o => o.attributeId === gender.id).map(o => o.code)).toEqual(['men', 'women', 'unisex'])
    expect(rows.options.find(o => o.code === 'women')).toMatchObject({ label: 'Women', synonyms: expect.arrayContaining(['Donna', 'Damen']) })
    // Open-text concepts get no options (their dropdown comes from the channels, P6).
    expect(rows.options.some(o => o.attributeId === rows.attributes.find(a => a.code === 'color')!.id)).toBe(false)
    expect(rows.attributes.find(a => a.code === 'material')).toMatchObject({ type: 'text', validation: { shape: 'list' } })
  })

  it('is created with every new business', async () => {
    const attributes = await inBusiness('a', () => prisma.customAttribute.findMany({ select: { code: true, semanticKey: true } }))
    expect(attributes.map(a => a.code).sort()).toEqual(customAttributeConcepts().map(c => c.key).sort())
    expect(attributes.every(a => a.semanticKey === a.code)).toBe(true)
    const plan = await inBusiness('a', conceptDictionaryPlan)
    expect(plan.counts).toMatchObject({ adopt: 0, create: 0, blocked: 0, linked: customAttributeConcepts().length })
  })
})

describe('tenant safety (row-level security)', () => {
  it('shows each business only its own dictionary, and lets both link the same concept', async () => {
    const a = await inBusiness('a', () => prisma.customAttribute.findMany({ select: { id: true, code: true, workspaceId: true } }))
    const b = await inBusiness('b', () => prisma.customAttribute.findMany({ select: { id: true, code: true, workspaceId: true } }))
    expect(a.every(row => row.workspaceId === businesses.a.workspaceId)).toBe(true)
    expect(b.every(row => row.workspaceId === businesses.b.workspaceId)).toBe(true)
    expect(a.some(row => b.some(other => other.id === row.id))).toBe(false)
    // Both have a `color` attribute linked to the concept: the concept is unique per business, not globally.
    expect(a.some(row => row.code === 'color') && b.some(row => row.code === 'color')).toBe(true)
  })

  it('cannot read, change or attach options to another business’s attribute', async () => {
    const foreign = await inBusiness('b', () => prisma.customAttribute.findFirstOrThrow({ where: { code: 'target_gender' }, select: { id: true, label: true } }))
    await inBusiness('a', async () => {
      expect(await prisma.customAttribute.findUnique({ where: { id: foreign.id } })).toBeNull()
      await expect(prisma.customAttribute.update({ where: { id: foreign.id }, data: { label: 'Hijacked' } })).rejects.toMatchObject({ code: 'P2025' })
      await expect(prisma.attributeOption.create({ data: { attributeId: foreign.id, code: 'x', label: 'X' } })).rejects.toThrow()
      const bulk = await upsertAttributes([{ code: 'target_gender', label: 'Mine' }])
      // `target_gender` resolves to business A's OWN attribute — the foreign one is invisible.
      expect(bulk.applied).toBe(true)
    })
    const untouched = await inBusiness('b', () => prisma.customAttribute.findUniqueOrThrow({ where: { id: foreign.id }, select: { label: true } }))
    expect(untouched.label).toBe(foreign.label)
  })
})

describe('an existing business adopts the concepts', () => {
  beforeAll(async () => {
    // Replace the starter dictionary with a legacy one, as a business created before P3 has.
    await inBusiness('legacy', async () => {
      await prisma.attributeOption.deleteMany({})
      await prisma.customAttribute.deleteMany({})
      const group = await prisma.attributeGroup.create({ data: { code: 'attributes', label: 'Specifications' } })
      const make = (code: string, semanticKey: string | null = null, type = 'text') => prisma.customAttribute.create({ data: { code, label: code, groupId: group.id, type, semanticKey } })
      await make('color')                 // same code as the concept → adopt
      await make('fit_type')              // an adopt code of `fit` → adopt
      await make('size', 'size')          // already linked
      await make('material', 'features')  // code of one concept, linked to another → `material` is blocked
    })
  }, 60_000)

  it('plans adopt / linked / blocked / create without writing, and says why a concept is blocked', async () => {
    const plan = await inBusiness('legacy', conceptDictionaryPlan)
    const byConcept = new Map(plan.entries.map(e => [e.concept, e]))
    expect(byConcept.get('color')).toMatchObject({ action: 'adopt', code: 'color' })
    expect(byConcept.get('fit')).toMatchObject({ action: 'adopt', code: 'fit_type' })
    expect(byConcept.get('size')).toMatchObject({ action: 'linked', code: 'size' })
    expect(byConcept.get('features')).toMatchObject({ action: 'linked', code: 'material' })
    expect(byConcept.get('material')).toMatchObject({ action: 'blocked', reason: expect.stringContaining('"features"') })
    expect(byConcept.get('brand')).toMatchObject({ action: 'master', masterField: 'brand' })
    expect(byConcept.get('pattern')).toMatchObject({ action: 'create', code: 'pattern' })
    const dry = await inBusiness('legacy', () => applyConceptDictionary())
    expect(dry.applied).toBe(false)
    expect(await inBusiness('legacy', () => prisma.customAttribute.findFirstOrThrow({ where: { code: 'color' } }))).toMatchObject({ semanticKey: null })
  })

  it('applies once, and a second apply changes nothing', async () => {
    const before = await inBusiness('legacy', () => prisma.customAttribute.count())
    const applied = await inBusiness('legacy', () => applyConceptDictionary({ dryRun: false }))
    expect(applied.applied).toBe(true)
    const rows = await inBusiness('legacy', () => prisma.customAttribute.findMany({ select: { code: true, semanticKey: true, options: { select: { code: true } } } }))
    expect(rows.find(r => r.code === 'color')!.semanticKey).toBe('color')
    expect(rows.find(r => r.code === 'fit_type')!.semanticKey).toBe('fit')
    expect(rows.find(r => r.code === 'pattern')!.semanticKey).toBe('pattern')
    expect(rows.find(r => r.code === 'target_gender')!.options.map(o => o.code)).toEqual(expect.arrayContaining(['men', 'women', 'unisex']))
    expect(rows.length).toBe(before + applied.counts.create)
    const again = await inBusiness('legacy', () => applyConceptDictionary({ dryRun: false }))
    expect(again.counts).toMatchObject({ adopt: 0, create: 0, blocked: 1 })
    expect(await inBusiness('legacy', () => prisma.customAttribute.count())).toBe(rows.length)
  })
})

describe('bulk dictionary writer', () => {
  it('is all-or-nothing: one wrong row and nothing is written, with every problem named', async () => {
    await inBusiness('b', async () => {
      const result = await upsertAttributes([
        { code: 'rain_rating', label: 'Rain rating', type: 'number', groupCode: 'specifications' },
        { code: 'color', type: 'number' },
        { code: 'bad rules', label: 'x', type: 'text', groupCode: 'specifications', validation: { minimum: 5, maximum: 1 } },
        { code: 'shell', label: 'Shell', type: 'text', groupCode: 'specifications', semanticKey: 'brand' },
      ])
      expect(result.applied).toBe(false)
      const errors = Object.fromEntries(result.results.map(r => [r.code, r.ok ? [] : r.errors]))
      expect(errors.rain_rating).toEqual([])
      expect(errors.color).toEqual(['type cannot change from "text" to "number": stored values would be orphaned'])
      expect(errors['bad rules']).toEqual(expect.arrayContaining([expect.stringContaining('lowercase snake_case'), 'validation — minimum is greater than maximum']))
      expect(errors.shell).toEqual(['"brand" is already the master field "brand"; it cannot also be a custom attribute'])
      expect(await prisma.customAttribute.findFirst({ where: { code: 'rain_rating' } })).toBeNull()
    })
  })

  it('creates, updates, adds option synonyms and retires an option in one call', async () => {
    await inBusiness('b', async () => {
      const result = await upsertAttributes([
        { code: 'protection_level', label: 'Protection level', type: 'select', groupCode: 'specifications',
          options: [{ code: 'level_1', label: 'Level 1', synonyms: ['Livello 1', 'Stufe 1'] }, { code: 'level_2', label: 'Level 2' }] },
        { code: 'target_gender', label: 'Gender', options: [{ code: 'unisex', archived: true }, { code: 'kids', label: 'Kids', synonyms: ['Bambino'] }] },
      ])
      expect(result.applied).toBe(true)
      expect(result.results).toEqual([
        expect.objectContaining({ code: 'protection_level', ok: true, created: true, options: { created: 2, updated: 0 } }),
        expect.objectContaining({ code: 'target_gender', ok: true, created: false, options: { created: 1, updated: 1 } }),
      ])
      const gender = await prisma.customAttribute.findFirstOrThrow({ where: { code: 'target_gender' }, include: { options: true } })
      expect(gender.label).toBe('Gender')
      expect(gender.options.find(o => o.code === 'unisex')!.archivedAt).toBeInstanceOf(Date)
      expect(gender.options.find(o => o.code === 'kids')).toMatchObject({ label: 'Kids', synonyms: ['Bambino'], archivedAt: null })
      const level = await prisma.attributeOption.findFirstOrThrow({ where: { code: 'level_1' } })
      expect(level.synonyms).toEqual(['Livello 1', 'Stufe 1'])
    })
  })

  it('refuses a concept already linked elsewhere, but lets one batch move it', async () => {
    await inBusiness('b', async () => {
      const taken = await upsertAttributes([{ code: 'shell_color', label: 'Shell color', type: 'text', groupCode: 'specifications', semanticKey: 'color' }])
      expect(taken.results[0]).toMatchObject({ ok: false, errors: ['concept "color" is already linked to attribute "color"'] })
      const moved = await upsertAttributes([
        { code: 'color', semanticKey: null },
        { code: 'shell_color', label: 'Shell color', type: 'text', groupCode: 'specifications', semanticKey: 'color' },
      ])
      expect(moved.applied).toBe(true)
      const linked = await prisma.customAttribute.findMany({ where: { semanticKey: 'color' }, select: { code: true } })
      expect(linked).toEqual([{ code: 'shell_color' }])
    })
  })
})
