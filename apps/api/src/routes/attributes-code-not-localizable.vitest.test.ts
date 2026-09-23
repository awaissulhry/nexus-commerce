import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

/**
 * A-25 (R-22) — "factual attributes never per-language: a code with a localized label, never
 * per-language free text" (docs/2026-09-11-language-axis-design.md:85-86). Enforced at the source:
 * the attributes route refuses a per-language choice list, the column router never sends one to
 * per-language storage, and the code-defined dictionary may not declare one.
 */
const db = vi.hoisted(() => ({ group: vi.fn(), create: vi.fn(), current: vi.fn(), update: vi.fn() }))
vi.mock('../db.js', () => ({ default: {
  attributeGroup: { findUnique: db.group },
  customAttribute: { create: db.create, findUnique: db.current, update: db.update },
} }))
import attributesRoutes, { CODE_NOT_LOCALIZABLE } from './attributes.routes.js'
import { buildSheetColumns } from '../services/pim/sheet-columns.service.js'
import { INFORMATION_DICTIONARY_PLAN } from '../services/pim/information-dictionary-plan.js'

const app = async () => { const a = Fastify(); await a.register(attributesRoutes); return a }
beforeEach(() => {
  for (const f of Object.values(db)) f.mockReset()
  db.group.mockResolvedValue({ id: 'g' })
  db.create.mockImplementation(async ({ data }: any) => ({ id: 'new', ...data }))
  db.update.mockImplementation(async ({ data }: any) => ({ id: 'a', ...data }))
})

describe('the attributes route: a choice list cannot be made per-language', () => {
  it.each(['select', 'multiselect'])('POST refuses a per-language %s, by name, and writes nothing', async type => {
    const res = await (await app()).inject({ method: 'POST', url: '/attributes',
      payload: { code: 'closure_kind', label: 'Closure', groupId: 'g', type, localizable: true } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe(CODE_NOT_LOCALIZABLE)
    expect(db.create).not.toHaveBeenCalled()
  })

  it('positive controls: a per-language text attribute and a single-language choice list are created', async () => {
    const a = await app()
    expect((await a.inject({ method: 'POST', url: '/attributes',
      payload: { code: 'care_note', label: 'Care', groupId: 'g', type: 'text', localizable: true } })).statusCode).toBe(201)
    expect((await a.inject({ method: 'POST', url: '/attributes',
      payload: { code: 'size_system', label: 'Size system', groupId: 'g', type: 'select', localizable: false } })).statusCode).toBe(201)
  })

  it('PATCH refuses making a stored choice list per-language; a text attribute may be', async () => {
    const a = await app()
    db.current.mockResolvedValue({ type: 'select' })
    const refused = await a.inject({ method: 'PATCH', url: '/attributes/a', payload: { localizable: true } })
    expect(refused.statusCode).toBe(400)
    expect(refused.json().error).toBe(CODE_NOT_LOCALIZABLE)
    expect(db.update).not.toHaveBeenCalled()
    db.current.mockResolvedValue({ type: 'text' })
    expect((await a.inject({ method: 'PATCH', url: '/attributes/a', payload: { localizable: true } })).statusCode).toBe(200)
  })
})

describe('the column router and the dictionary', () => {
  it('a choice list flagged per-language still stores one code; a per-language text goes to per-language storage', () => {
    const { columns } = buildSheetColumns({ coordinates: [], scopeKind: 'master', fields: [
      { id: 'attr_closure_kind', label: 'Closure', type: 'select', category: 'category', localizable: true, options: ['zip', 'button'] } as never,
      { id: 'attr_care_note', label: 'Care', type: 'text', category: 'category', localizable: true } as never,
    ] })
    expect(columns.find(c => c.key === 'closure_kind')?.storage).toBe('categoryAttributes')
    expect(columns.find(c => c.key === 'care_note')?.storage).toBe('localizedContent')
  })

  it('the code-defined dictionary declares no per-language choice list', () => {
    const entries = [...INFORMATION_DICTIONARY_PLAN.update, ...INFORMATION_DICTIONARY_PLAN.add] as Array<{ code: string; type?: string; localizable?: boolean }>
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.filter(e => (e.type === 'select' || e.type === 'multiselect') && e.localizable).map(e => e.code)).toEqual([])
  })
})
