import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { MARKET_CATALOGUE } from './market-catalogue.js'

/**
 * A-53 step 3 — the backfill migration, applied to a real PostgreSQL (PGlite) with four businesses:
 *   EMPTY    active, 0 market rows            → gains the whole catalogue (Motovento's case)
 *   PARTIAL  active, 3 rows, one of them edited → gains the 17 it lacks; its own rows are untouched
 *   ARCHIVED archived, 0 rows                   → gains nothing (the plan: active businesses)
 *   LEGACY   active, the whole catalogue, one row edited → gains nothing, changes nothing (Xavia's case)
 * Owner ruling Q1 (2026-09-24): per ROW, create-only — the same rule as POST /marketplaces/seed.
 * The SQL runs as the database superuser, as the migration role (BYPASSRLS) does in production.
 */
const MIGRATION = readFileSync(new URL('../../../../../packages/database/prisma/migrations/20260924a_a53_market_catalogue_backfill/migration.sql', import.meta.url), 'utf8')
const COLUMNS = `channel, code, name, "marketplaceId", region, currency, language, languages, "domainUrl", "vatRate"::text AS "vatRate", "taxInclusive", "isActive"`

describe('A-53 backfill migration', () => {
  let database: Awaited<ReturnType<typeof formulaDatabase>>
  const rows = async (workspaceId: string) => (await database.db.query<Record<string, unknown>>(
    `SELECT id, ${COLUMNS} FROM "Marketplace" WHERE "workspaceId" = $1 ORDER BY channel, code`, [workspaceId])).rows
  const business = (id: string, status: string) => database.db.query(
    `INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, $2, 'test', $1, CURRENT_TIMESTAMP)`, [id, status])
  const market = (workspaceId: string, channel: string, code: string, extra: { name?: string; languages?: string[]; vatRate?: string } = {}) => {
    const m = MARKET_CATALOGUE.find(row => row.channel === channel && row.code === code)!
    return database.db.query(
      `INSERT INTO "Marketplace" (id, "workspaceId", channel, code, name, "marketplaceId", region, currency, language, languages, "domainUrl", "vatRate", "taxInclusive", "isActive", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, CURRENT_TIMESTAMP)`,
      [`seed-${workspaceId}-${channel}-${code}`, workspaceId, channel, code, extra.name ?? m.name, m.marketplaceId, m.region, m.currency, m.language,
        extra.languages ?? [...m.languages], m.domainUrl, extra.vatRate ?? m.vatRate, m.taxInclusive, m.isActive])
  }

  beforeAll(async () => {
    database = await formulaDatabase()
    await business('EMPTY', 'active')
    await business('PARTIAL', 'active')
    await business('ARCHIVED', 'archived')
    await market('PARTIAL', 'EBAY', 'IT', { name: 'eBay Italia (own)', languages: ['it', 'en'], vatRate: '10.00' })
    await market('PARTIAL', 'AMAZON', 'DE')
    await market('PARTIAL', 'ETSY', 'GLOBAL')
    // `nexus_legacy_workspace` is created by formulaDatabase(); give it the whole catalogue, one row edited.
    for (const m of MARKET_CATALOGUE) await market('nexus_legacy_workspace', m.channel, m.code, m.channel === 'AMAZON' && m.code === 'IT' ? { vatRate: '21.50' } : {})
  }, 120_000)
  afterAll(async () => { await database?.close() }, 30_000)

  it('the reproduction: before the migration EMPTY has no market at all', async () => {
    expect(await rows('EMPTY')).toEqual([])
  })

  it('gives EMPTY the catalogue row for row, and nothing else changes shape', async () => {
    const before = { partial: await rows('PARTIAL'), legacy: await rows('nexus_legacy_workspace') }
    await database.db.exec(MIGRATION)
    const empty = await rows('EMPTY')
    expect(empty.map(({ id: _id, ...rest }) => rest)).toEqual(MARKET_CATALOGUE.map(m => ({ ...m, languages: [...m.languages] })))
    expect(empty.every(row => typeof row.id === 'string' && (row.id as string).length > 0)).toBe(true)

    // PARTIAL: the 17 it lacked, and its three rows byte-for-byte as they were (its own name, languages, VAT).
    const partial = await rows('PARTIAL')
    expect(partial).toHaveLength(20)
    for (const row of before.partial) expect(partial.find(r => r.id === row.id)).toEqual(row)
    expect(partial.find(r => r.channel === 'EBAY' && r.code === 'IT')).toMatchObject({ name: 'eBay Italia (own)', languages: ['it', 'en'], vatRate: '10.00' })

    // LEGACY (Xavia's shape): already whole — nothing added, its edited VAT kept.
    expect(await rows('nexus_legacy_workspace')).toEqual(before.legacy)
    // ARCHIVED: not an active business, so nothing.
    expect(await rows('ARCHIVED')).toEqual([])
  })

  it('is safe to run again: a second run adds and changes nothing', async () => {
    const snapshot = { empty: await rows('EMPTY'), partial: await rows('PARTIAL'), legacy: await rows('nexus_legacy_workspace') }
    await database.db.exec(MIGRATION)
    expect({ empty: await rows('EMPTY'), partial: await rows('PARTIAL'), legacy: await rows('nexus_legacy_workspace') }).toEqual(snapshot)
    expect((await database.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "Marketplace"`)).rows[0].n).toBe(60)
  })
})
