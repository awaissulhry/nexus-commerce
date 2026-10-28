import { describe, expect, it } from 'vitest'
import { makeScope, scopeStatement, TenantScopeError, type ScopeDefinition } from './scope'
import { TenantPg } from './tenant-adapter'
import pg from 'pg'

const floor = {
  role: 'example_floor_runtime',
  settings: {
    tenantId: { setting: 'example.tenant_id', required: true },
    actorId: { setting: 'example.actor_id', required: true },
    siteId: { setting: 'example.site_id', required: true },
    partyId: { setting: 'example.party_id', required: false },
  },
} as const satisfies ScopeDefinition

const code = (work: () => unknown): string | undefined => {
  try {
    work()
    return undefined
  } catch (error) {
    expect(error).toBeInstanceOf(TenantScopeError)
    return (error as TenantScopeError).code
  }
}

describe('makeScope', () => {
  it('freezes the role and every setting in definition order; an absent optional setting becomes empty', () => {
    const scope = makeScope(floor, { tenantId: 't1', actorId: 'u1', siteId: 's1' })
    expect(scope).toEqual({
      role: 'example_floor_runtime',
      settings: [
        ['example.tenant_id', 't1'],
        ['example.actor_id', 'u1'],
        ['example.site_id', 's1'],
        ['example.party_id', ''],
      ],
    })
    expect(Object.isFrozen(scope)).toBe(true)
    expect(Object.isFrozen(scope.settings)).toBe(true)
    expect(Object.isFrozen(scope.settings[0])).toBe(true)
  })

  it.each([
    ['no scope at all', undefined],
    ['a missing required value', { tenantId: 't1', actorId: 'u1' }],
    ['a null required value', { tenantId: 't1', actorId: 'u1', siteId: null }],
    ['an empty required value', { tenantId: '', actorId: 'u1', siteId: 's1' }],
  ])('refuses %s (fail closed, no fallback)', (_label, values) => {
    expect(code(() => makeScope(floor, values as never))).toBe('scope_required')
  })

  it.each([
    ['an unknown key', { tenantId: 't1', actorId: 'u1', siteId: 's1', companyId: 'c1' }],
    ['a value that is not a string', { tenantId: 7, actorId: 'u1', siteId: 's1' }],
    ['a NUL character', { tenantId: 't\u00001', actorId: 'u1', siteId: 's1' }],
  ])('refuses %s', (_label, values) => {
    expect(code(() => makeScope(floor, values as never))).toBe('scope_invalid')
  })

  it.each([
    ['a role with capitals', { role: 'Factory_Runtime', settings: {} }],
    ['a role with a quote', { role: 'x"; DROP', settings: {} }],
    ['a setting without a prefix', { role: 'r', settings: { tenantId: { setting: 'tenant_id', required: true } } }],
    ['a setting with a quote', { role: 'r', settings: { tenantId: { setting: "a.b'c", required: true } } }],
    ['the role setting itself', { role: 'r', settings: { roleName: { setting: 'role', required: true } } }],
    ['a setting listed twice', { role: 'r', settings: { a: { setting: 'x.a', required: true }, b: { setting: 'x.a', required: false } } }],
    ['a setting that does not say whether it is required', { role: 'r', settings: { a: { setting: 'x.a' } } }],
  ])('refuses a definition with %s', (_label, definition) => {
    expect(code(() => makeScope(definition as never, {}))).toBe('scope_invalid')
  })

  it('accepts a definition without settings (a platform role), but still needs an explicit scope object', () => {
    expect(makeScope({ role: 'example_platform', settings: {} }, {})).toEqual({ role: 'example_platform', settings: [] })
    expect(code(() => makeScope({ role: 'example_platform', settings: {} }, undefined))).toBe('scope_required')
  })
})

describe('scopeStatement', () => {
  it('binds the role, every setting name and every value; the text holds only placeholders', () => {
    const scope = makeScope(floor, { tenantId: "t1'; SET ROLE postgres; --", actorId: 'u1', siteId: 's1', partyId: null })
    const { sql, values } = scopeStatement(scope)
    expect(sql).toBe(
      'SELECT set_config($1, $2, true), set_config($3, $4, true), set_config($5, $6, true), set_config($7, $8, true), set_config($9, $10, true)',
    )
    expect(values).toEqual([
      'role',
      'example_floor_runtime',
      'example.tenant_id',
      "t1'; SET ROLE postgres; --",
      'example.actor_id',
      'u1',
      'example.site_id',
      's1',
      'example.party_id',
      '',
    ])
  })
})

describe('TenantPg', () => {
  it('refuses a missing scope before it touches the pool', () => {
    const pool = new pg.Pool({ connectionString: 'postgresql://nobody@127.0.0.1:1/never' })
    expect(code(() => new TenantPg(pool, floor, { tenantId: 't1' }))).toBe('scope_required')
    expect(code(() => new TenantPg(pool, floor, undefined as never))).toBe('scope_required')
    expect(pool.totalCount).toBe(0)
  })
})
