#!/usr/bin/env node
// @ts-check
/**
 * Seed (or re-seed) the synthetic Shopify family of `tests/sheet-shopify-control.spec.ts`. LOCAL ONLY: the private sheet
 * database (`sheet-database-target.mjs`), never a repository .env. See `shopify-control-fixture.mjs`.
 *
 *   E2E_DATABASE_URL=postgresql://…@127.0.0.1:55530/nexus_pse_test node tests/fixtures/shopify-control-seed.mjs
 */
import pg from 'pg'
import { privateSheetDatabaseConfig } from './sheet-database-target.mjs'
import { seedShopifyControl } from './shopify-control-fixture.mjs'

const db = new pg.Client(privateSheetDatabaseConfig(process.env.E2E_DATABASE_URL))
await db.connect()
try {
  await db.query('BEGIN')
  await seedShopifyControl(db)
  await db.query('COMMIT')
  console.log('Seeded the synthetic Shopify control family (no store credentials, no store calls).')
} catch (error) {
  await db.query('ROLLBACK')
  throw error
} finally { await db.end() }
