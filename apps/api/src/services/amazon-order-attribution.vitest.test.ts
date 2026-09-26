/**
 * CX A5 — the attribution script's own guards. The attribution rule, its compare-and-set and its race
 * with ingestion are proven against throwaway PostgreSQL in amazon-finances-postgres.vitest.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { assertPinnedTarget, attributeBatch, executeAttribution, runAttributionCensus, type QueryClient } from './amazon-order-attribution.js'

function recording(fail?: RegExp, bypass = true): QueryClient & { sql: string[] } {
  const sql: string[] = []
  return {
    sql,
    async query(text: string) {
      sql.push(text.trim().split('\n')[0]!.trim())
      if (fail && fail.test(text)) throw new Error('boom')
      if (/rolbypassrls/.test(text)) return { rows: [{ role: 'operator', bypass }] as never[] }
      if (/count\(\*\)::int AS n FROM "Order"/.test(text)) return { rows: [{ n: 9 }] as never[] }
      if (/count\(\*\)::int AS unattributed/.test(text)) return { rows: [{ unattributed: 3, attributable: 1, also_inactive: 0, ambiguous: 1, inactive_only: 0, none: 1 }] as never[] }
      if (/SELECT \(SELECT count\(\*\) FROM picked\)/.test(text)) return { rows: [{ picked: 0, attributed: 0 }] as never[] }
      return { rows: [] }
    },
  }
}

describe('A5 — the pinned target', () => {
  it('runs only against the host and database named on the command line', () => {
    expect(assertPinnedTarget('postgres://u:p@db.example.test:5432/nexus', 'db.example.test', 'nexus').hostname).toBe('db.example.test')
    expect(() => assertPinnedTarget('postgres://u:p@other.example.test:5432/nexus', 'db.example.test', 'nexus')).toThrow(/Refusing other\.example\.test\/nexus/)
    expect(() => assertPinnedTarget('postgres://u:p@db.example.test:5432/other', 'db.example.test', 'nexus')).toThrow(/Refusing/)
    expect(() => assertPinnedTarget('postgres://u:p@db.example.test:5432/nexus', undefined, 'nexus')).toThrow(/--target-host and --database/)
    expect(() => assertPinnedTarget(undefined, 'db.example.test', 'nexus')).toThrow(/DATABASE_URL/)
  })

  it('never reads an .env file and prints no connection detail', () => {
    const script = readFileSync(new URL('../../../../scripts/amazon-order-attribution-backfill.mts', import.meta.url), 'utf8')
    expect(script).toContain("assertPinnedTarget(process.env.DATABASE_URL, flag('--target-host'), flag('--database'))")
    expect(script).not.toMatch(/dotenv|readFileSync|\.env['"]/)
    expect(script).toContain("if (mode === 'describe') process.exit(0)")
  })
})

describe('A5 — census and batches', () => {
  it('the census is a REPEATABLE READ, READ ONLY transaction that is always rolled back', async () => {
    const client = recording()
    expect(await runAttributionCensus(client)).toMatchObject({ readProof: { role: 'operator', bypassesRowSecurity: true }, amazonOrdersVisible: 9, unattributedOrders: 3, attributable: 1, ambiguous: 1, noMatchingAccount: 1 })
    expect(client.sql[0]).toBe('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    expect(client.sql.at(-1)).toBe('ROLLBACK')
    const failing = recording(/unattributed/)
    await expect(runAttributionCensus(failing)).rejects.toThrow('boom')
    expect(failing.sql.at(-1)).toBe('ROLLBACK')
  })

  it('bounds each batch and rolls a failed batch back', async () => {
    for (const bad of [0, -1, 1.5, 1001]) await expect(attributeBatch(recording(), bad)).rejects.toThrow(/between 1 and 1000/)
    const failing = recording(/WITH picked AS/)
    await expect(executeAttribution(failing)).rejects.toThrow('boom')
    expect(failing.sql.at(-1)).toBe('ROLLBACK')
    const quiet = recording()
    expect(await executeAttribution(quiet)).toEqual({ batches: 1, picked: 0, attributed: 0, lostToConcurrentLink: 0, complete: true })
    expect(quiet.sql).toEqual([expect.stringMatching(/rolbypassrls/), 'BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED', "SET LOCAL statement_timeout = '60s'", 'WITH picked AS (', 'COMMIT'])
  })

  it('review #8 — refuses before reading or writing anything when the role cannot bypass row security', async () => {
    const census = recording(undefined, false)
    await expect(runAttributionCensus(census)).rejects.toThrow(/operator cannot read every business/)
    expect(census.sql.some(line => /FROM "Order"|WITH target/.test(line))).toBe(false)
    expect(census.sql.at(-1)).toBe('ROLLBACK')
    const execute = recording(undefined, false)
    await expect(executeAttribution(execute)).rejects.toThrow(/cannot read every business/)
    expect(execute.sql).toHaveLength(1)
  })
})
