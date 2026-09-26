import { describe, expect, it } from 'vitest'
import { migrationConnection } from './migration-connection.mjs'

describe('migration credential and endpoint', () => {
  it('uses a dedicated migration credential, preserving password and URL options', () => {
    const url = 'postgresql://owner:secret-pooler@ep-example-pooler.eu.neon.tech/db-pooler?application_name=migrate-pooler'
    expect(migrationConnection({ MIGRATION_DATABASE_URL: url, DATABASE_URL: 'postgresql://runtime@localhost/app' }))
      .toBe('postgresql://owner:secret-pooler@ep-example.eu.neon.tech/db-pooler?application_name=migrate-pooler')
  })
  it('allows the local development credential without changing non-Neon hosts', () => {
    expect(migrationConnection({ DATABASE_URL: 'postgresql://dev@my-pooler.internal/test' }))
      .toBe('postgresql://dev@my-pooler.internal/test')
  })
  it('refuses production without an explicit migration credential', () => {
    expect(() => migrationConnection({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://runtime@localhost/app' }))
      .toThrow('MIGRATION_DATABASE_URL')
  })
  it.each([{}, { DATABASE_URL: 'bad-secret-value' }, { DATABASE_URL: 'https://example.com/db' }])('rejects invalid configuration without echoing credentials', (env) => {
    expect(() => migrationConnection(env)).toThrow(/PostgreSQL|not set/)
    try { migrationConnection(env) } catch (error) { expect(String(error)).not.toContain('bad-secret-value') }
  })
})
