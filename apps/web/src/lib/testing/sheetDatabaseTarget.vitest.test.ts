import { afterEach, expect, it, vi } from 'vitest'
import pg from 'pg'
import { privateSheetDatabaseConfig } from '../../../tests/fixtures/sheet-database-target.mjs'

const privateUrl = 'postgresql://fixture@127.0.0.1:55530/nexus_pse_test'
// Construct the real driver's parameters without calling connect or making any socket request.
const target = (client: pg.Client) => {
  const parameters = (client as unknown as { connectionParameters: { host: string; port: number; database: string } }).connectionParameters
  return { host: parameters.host, port: parameters.port, database: parameters.database }
}
afterEach(() => vi.unstubAllEnvs())

it('reports a malformed URL without retaining its input in the error', () => {
  try { privateSheetDatabaseConfig('postgresql://fixture@'); throw new Error('Expected a refusal') }
  catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('Private sheet test database required')
    expect(error).not.toHaveProperty('input')
  }
})

it('the old visible-authority guard misses pg query target overrides (positive control)', () => {
  const raw = `${privateUrl}?host=outside.invalid&port=4444&database=other_database`
  const visible = new URL(raw)
  expect([visible.hostname, visible.port, visible.pathname]).toEqual(['127.0.0.1', '55530', '/nexus_pse_test'])
  expect(target(new pg.Client({ connectionString: raw }))).toEqual({ host: 'outside.invalid', port: 4444, database: 'nexus_pse_test' })
})

it('query parameters and PG environment defaults cannot redirect this fixture', () => {
  vi.stubEnv('PGHOST', 'environment.invalid'); vi.stubEnv('PGPORT', '4445'); vi.stubEnv('PGDATABASE', 'environment_database')
  for (const query of ['', '?host=outside.invalid&port=4444&database=other_database', '?schema=public']) {
    expect(target(new pg.Client(privateSheetDatabaseConfig(privateUrl + query))))
      .toEqual({ host: '127.0.0.1', port: 55530, database: 'nexus_pse_test' })
  }
})

it.each([
  'postgresql://fixture@outside.invalid:55530/nexus_pse_test',
  'postgresql://fixture@127.0.0.1:5432/nexus_pse_test',
  'postgresql://fixture@127.0.0.1:55530/other_database',
  'https://fixture@127.0.0.1:55530/nexus_pse_test',
])('refuses an authority outside the exact private target: %s', raw => {
  expect(() => privateSheetDatabaseConfig(raw)).toThrow('Private sheet test database required')
})
