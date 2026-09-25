import { describe, expect, it } from 'vitest'
import { scopeArguments, scopeUniqueWhere } from '../workspace-client.ts'
import { LEGACY_WORKSPACE_ID } from '../workspace-context.ts'

// These are the actual literal-ID singleton contracts in schema.prisma. Prisma 7
// runtime DMMF omits their ID/default metadata, which previously made every new
// business try to use the legacy row's globally unique primary key.
describe.each([
  ['ReviewMailerState', 'default'],
  ['AdsAutomationState', 'singleton'],
  ['AgentFleetState', 'singleton'],
])('%s business singleton identity', (model, literalId) => {
  const first = 'business_singleton_a'
  const second = 'business_singleton_b'

  it('creates distinct default IDs for two businesses and selects their own rows', () => {
    for (const workspace of [first, second]) {
      const expectedId = `${workspace}:${literalId}`
      expect(scopeArguments(model, 'create', { data: {} }, workspace)).toEqual({ data: { id: expectedId } })
      expect(scopeArguments(model, 'create', { data: { id: literalId } }, workspace)).toEqual({ data: { id: expectedId } })
      expect(scopeUniqueWhere(model, { id: literalId }, workspace)).toEqual({ id: expectedId })
    }
    const a = scopeUniqueWhere(model, { id: literalId }, first)
    const b = scopeUniqueWhere(model, { id: literalId }, second)
    expect(a.id).not.toBe(b.id)
  })

  it('keeps repeated upserts addressed to the same business singleton', () => {
    const expectedId = `${first}:${literalId}`
    const scoped = scopeArguments(model, 'upsert', {
      where: { id: literalId }, create: {}, update: {},
    }, first)
    expect(scoped).toEqual({
      where: { id: expectedId }, create: { id: expectedId }, update: { id: expectedId },
    })
    expect(scopeUniqueWhere(model, scoped.where as Record<string, unknown>, first)).toEqual({ id: expectedId })
  })

  it('retains legacy IDs and leaves an already-scoped ID unchanged', () => {
    expect(scopeArguments(model, 'create', { data: {} }, LEGACY_WORKSPACE_ID)).toEqual({ data: { id: literalId } })
    expect(scopeUniqueWhere(model, { id: literalId }, LEGACY_WORKSPACE_ID)).toEqual({ id: literalId })
    const scopedId = `${second}:${literalId}`
    expect(scopeArguments(model, 'create', { data: { id: scopedId } }, second)).toEqual({ data: { id: scopedId } })
    expect(scopeUniqueWhere(model, { id: scopedId }, second)).toEqual({ id: scopedId })
  })
})
