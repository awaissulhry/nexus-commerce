import { describe, expect, expectTypeOf, it } from 'vitest'
import { UnauthenticatedError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { assertJson, COMMAND_SETTINGS, idempotencyKeyFrom, requestHash, runCommand, type CommandCaller, type CommandSpec, type VersionedModel } from './command'
import type { RequestContext } from './context'
import { ApiError } from './errors'

// command()'s pure parts and the refusals that happen before the database: no database here (the PostgreSQL tests
// are in command.pg.vitest.test.ts).

const office: RequestContext = { audience: 'office', tenantId: newId(), actorId: newId(), grants: [], requestId: 'req-1' }
const spec = (input: unknown, extra: Partial<CommandSpec> = {}): CommandSpec => ({ name: 'sites.rename', input, ...extra })

/** A caller whose database must never be reached. */
const untouched = (context: RequestContext | null): CommandCaller => ({
  factoryContext: context,
  withClient: () => {
    throw new Error('the database was reached')
  },
})
const run = (context: RequestContext | null, extra: Partial<CommandSpec> = {}) =>
  runCommand(untouched(context), spec({}, extra), async () => null, COMMAND_SETTINGS)

describe('requestHash', () => {
  it('is the same for the same request, whatever the key order or an undefined field', () => {
    expect(requestHash(spec({ a: 1, b: { c: 2, d: [1, 2] } }), office)).toBe(requestHash(spec({ b: { d: [1, 2], c: 2 }, a: 1, e: undefined }), office))
    expect(requestHash(spec({ at: new Date('2026-10-28T09:00:00.000Z') }), office)).toBe(requestHash(spec({ at: '2026-10-28T09:00:00.000Z' }), office))
    expect(requestHash(spec({}), office)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('differs with the input, the command, the record, the caller or the audience', () => {
    const base = requestHash(spec({ name: 'A' }), office)
    const siteId = newId()
    expect(requestHash(spec({ name: 'B' }), office)).not.toBe(base)
    expect(requestHash({ ...spec({ name: 'A' }), name: 'sites.archive' }, office)).not.toBe(base)
    expect(requestHash(spec({ name: 'A' }, { record: { type: 'Site', id: siteId } }), office)).not.toBe(base)
    expect(requestHash(spec({ name: 'A' }, { record: { type: 'Site', id: siteId, expectedVersion: 2 } }), office)).not.toBe(
      requestHash(spec({ name: 'A' }, { record: { type: 'Site', id: siteId, expectedVersion: 3 } }), office),
    )
    expect(requestHash(spec({ name: 'A' }), { ...office, actorId: newId() })).not.toBe(base)
    expect(requestHash(spec({ name: 'A' }), { ...office, audience: 'system', actorId: '00000000-0000-7000-8000-000000000000' })).not.toBe(base)
  })
})

describe('assertJson', () => {
  it('passes plain JSON', () => {
    expect(() => assertJson({ a: [1, 'b', true, null, { c: -2.5 }] })).not.toThrow()
    expect(() => assertJson(null)).not.toThrow()
  })

  it.each<[string, unknown, RegExp]>([
    ['a Date', { at: new Date() }, /a Date object at result\.at/],
    ['undefined in an object', { a: undefined }, /undefined at result\.a/],
    ['a hole in an array', [1, undefined], /undefined at result\[1\]/],
    ['NaN', { n: Number.NaN }, /NaN at result\.n/],
    ['a bigint', { n: 1n }, /a bigint at result\.n/],
    ['a Map', new Map(), /a Map object at result/],
    ['nothing at all', undefined, /undefined at result/],
  ])('refuses %s', (_label, value, message) => {
    expect(() => assertJson(value)).toThrow(ApiError)
    expect(() => assertJson(value)).toThrow(message)
  })
})

describe('idempotencyKeyFrom', () => {
  it('reads a well-formed Idempotency-Key header, or nothing', () => {
    const id = newId()
    expect(idempotencyKeyFrom({ headers: { 'idempotency-key': id } })).toBe(id)
    expect(idempotencyKeyFrom({ headers: {} })).toBeUndefined()
  })

  it.each(['short', 'a'.repeat(129), 'has space in it', '-starts-with-a-dash', 'ünïcode-key-1'])('refuses %j with a 400', (value) => {
    expect(() => idempotencyKeyFrom({ headers: { 'idempotency-key': value } })).toThrow(ValidationError)
  })
})

describe('refusals before the database', () => {
  it('no context: 401', async () => {
    await expect(run(null)).rejects.toThrow(UnauthenticatedError)
  })

  it('a platform context: it has no tenant to audit in', async () => {
    await expect(run({ audience: 'platform', actorId: newId(), grants: [], requestId: 'r' })).rejects.toThrow(/needs a tenant/)
  })

  it('a floor or link write without a key, a malformed key, a bad version or record id', async () => {
    const floor: RequestContext = { audience: 'floor', tenantId: newId(), actorId: newId(), siteId: newId(), deviceId: newId(), grants: [], requestId: 'r' }
    await expect(run(floor)).rejects.toThrow(/required for floor writes/)
    await expect(run(office, { idempotencyKey: 'bad key!' })).rejects.toThrow(ValidationError)
    await expect(run(office, { record: { type: 'Site', id: newId(), expectedVersion: 0 } })).rejects.toThrow(/version is not valid/)
    await expect(run(office, { record: { type: 'Site', id: 'not-a-uuid' } })).rejects.toMatchObject({ code: 'not_found' })
    await expect(run(office, { name: 'Rename' as never })).rejects.toThrow(/is not <module>\.<action>/)
  })
})

describe('types', () => {
  it('guards only models with an id and a version', () => {
    expectTypeOf<'Site'>().toExtend<VersionedModel>()
    expectTypeOf<'Company'>().toExtend<VersionedModel>()
    expectTypeOf<'AuditLog'>().not.toExtend<VersionedModel>()
    expectTypeOf<'IdempotencyReceipt'>().not.toExtend<VersionedModel>()
  })

  it('writes events with the outbox writer, which refuses an undeclared type', async () => {
    await expect(COMMAND_SETTINGS.writeEvents({} as never, [])).resolves.toBeUndefined()
    await expect(COMMAND_SETTINGS.writeEvents({} as never, [{ type: 'site.renamed', version: 1 } as never])).rejects.toThrow(/not declared in the event catalogue/)
  })
})
