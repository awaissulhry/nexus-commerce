import { expect, it } from 'vitest'
import pg from 'pg'
import { sheetFixtureDatabaseConfig } from '../../../../../scripts/ci/sheet-fixture-target.mjs'

/** pg resolves URL query overrides during construction. These tests never call connect or open a socket. */
function target(raw: string) {
  const client = new pg.Client(sheetFixtureDatabaseConfig(raw))
  return (client as unknown as { connectionParameters: { host: string; port: number; database: string; user: string; password: string; ssl: unknown } }).connectionParameters
}

it('keeps the validated target when query parameters try to replace its host or port', () => {
  const parameters = target('postgresql://fixture:pass@127.0.0.1:55505/nexus_sheet_test?host=outside.invalid&port=6543&sslmode=require')
  expect(parameters.host).toBe('127.0.0.1')
  expect(parameters.port).toBe(55505)
  expect(parameters.database).toBe('nexus_sheet_test')
  expect(parameters.ssl).toBe(false)
})

it.each(['localhost', '127.0.0.1', '[::1]'])('preserves a supported local target at %s', host => {
  const parameters = target(`postgres://fixture%2Duser:p%40ss@${host}:55505/nexus_sheet_test`)
  expect(parameters.host).toBe(host.replace(/^\[|\]$/g, ''))
  expect(parameters.port).toBe(55505)
  expect(parameters.database).toBe('nexus_sheet_test')
  expect(parameters.user).toBe('fixture-user')
  expect(parameters.password).toBe('p@ss')
})

it('supplies explicit defaults instead of inheriting the caller PGHOST, PGPORT or PGDATABASE', () => {
  const before = { PGHOST: process.env.PGHOST, PGPORT: process.env.PGPORT, PGDATABASE: process.env.PGDATABASE }
  Object.assign(process.env, { PGHOST: 'outside.invalid', PGPORT: '6543', PGDATABASE: 'production' })
  try {
    const parameters = target('postgresql://fixture:pass@localhost/nexus_sheet_test')
    expect(parameters.host).toBe('localhost')
    expect(parameters.port).toBe(5432)
    expect(parameters.database).toBe('nexus_sheet_test')
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

it.each([
  'postgresql://fixture:pass@outside.invalid/nexus_sheet_test',
  'postgresql://fixture:pass@127.0.0.1/nexus_development',
  'postgresql://fixture:pass@localhost/test/production',
  'postgresql://fixture:pass@localhost/%2Ftest',
  'https://fixture:pass@localhost/nexus_sheet_test',
])('refuses an unsupported target without retaining supplied secrets: %s', raw => {
  expect(() => sheetFixtureDatabaseConfig(raw)).toThrow('A loopback test database is required')
})

it('redacts malformed URL details as well as invalid credential escapes', () => {
  for (const raw of ['secret malformed URL', 'postgresql://fixture:%ZZ@localhost/nexus_sheet_test']) {
    let message = ''
    try { sheetFixtureDatabaseConfig(raw) } catch (error) { message = String(error) }
    expect(message).toBe('Error: A loopback test database is required for the sheet fixture')
  }
})
