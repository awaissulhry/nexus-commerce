#!/usr/bin/env node
// AD.4 — Verifies the ads-write-gate denial paths.
//
// Five scenarios:
//   (A) NEXUS_AMAZON_ADS_MODE=sandbox → allowed (mode='sandbox')
//   (B) live env + no connection for marketplace → denied (connection)
//   (C) live env + sandbox-mode connection → denied (connection)
//   (D) live env + production conn, writesEnabledAt=null → denied (connection_writes)
//   (E) live env + production conn + writesEnabledAt + value over cap → denied (value_cap)

import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const url = process.env.DATABASE_URL?.replace('-pooler', '')
if (!url) {
  console.error('DATABASE_URL missing')
  process.exit(1)
}

let exitCode = 0
function fail(msg) {
  console.error(`  ✗ ${msg}`)
  exitCode = 1
}
function pass(msg) {
  console.log(`  ✓ ${msg}`)
}

const c = new pg.Client({ connectionString: url })
await c.connect()

// Seed a controlled test connection per scenario.
const TEST_MARKETPLACE_C = 'TEST-WG-C'
const TEST_MARKETPLACE_D = 'TEST-WG-D'
const TEST_MARKETPLACE_E = 'TEST-WG-E'
const CLEANUP_MARKETPLACES = [TEST_MARKETPLACE_C, TEST_MARKETPLACE_D, TEST_MARKETPLACE_E]

await c.query(
  `INSERT INTO "AmazonAdsConnection" (id, "profileId", marketplace, region, mode, "writesEnabledAt", "isActive", "createdAt", "updatedAt")
   VALUES ($1, $2, $3, 'EU', 'sandbox', NULL, true, NOW(), NOW())`,
  [`wgconn-c-${Date.now()}`, `WG-C-${Date.now()}`, TEST_MARKETPLACE_C],
)
await c.query(
  `INSERT INTO "AmazonAdsConnection" (id, "profileId", marketplace, region, mode, "writesEnabledAt", "isActive", "createdAt", "updatedAt")
   VALUES ($1, $2, $3, 'EU', 'production', NULL, true, NOW(), NOW())`,
  [`wgconn-d-${Date.now()}`, `WG-D-${Date.now()}`, TEST_MARKETPLACE_D],
)
await c.query(
  `INSERT INTO "AmazonAdsConnection" (id, "profileId", marketplace, region, mode, "writesEnabledAt", "isActive", "createdAt", "updatedAt")
   VALUES ($1, $2, $3, 'EU', 'production', NOW(), true, NOW(), NOW())`,
  [`wgconn-e-${Date.now()}`, `WG-E-${Date.now()}`, TEST_MARKETPLACE_E],
)

const { spawnSync } = await import('node:child_process')
const apiRoot = path.join(here, '..', 'apps', 'api')
function runScenario(env, marketplace, payloadValueCents) {
  const result = spawnSync(
    'node',
    [
      '--import',
      'tsx',
      '-e',
      `
      import { checkAdsWriteGate } from './src/services/advertising/ads-write-gate.ts'
      const r = await checkAdsWriteGate({ marketplace: ${marketplace == null ? 'null' : `'${marketplace}'`}, payloadValueCents: ${payloadValueCents} })
      console.log(JSON.stringify(r))
      `,
    ],
    { cwd: apiRoot, encoding: 'utf8', env: { ...process.env, ...env } },
  )
  if (result.status !== 0) {
    fail(`scenario execution failed: ${result.stderr}`)
    return null
  }
  return JSON.parse(result.stdout.trim().split('\n').pop())
}

// (A) sandbox env.
const a = runScenario({ NEXUS_AMAZON_ADS_MODE: 'sandbox' }, 'IT', 1000)
if (a?.allowed === true && a.mode === 'sandbox') pass(`(A) sandbox env → allowed sandbox mode`)
else fail(`(A) expected sandbox-allowed, got ${JSON.stringify(a)}`)

// (B) live env + unknown marketplace.
const b = runScenario({ NEXUS_AMAZON_ADS_MODE: 'live' }, 'XX-UNKNOWN-MKT', 1000)
if (b?.allowed === false && b.deniedAt === 'connection') pass(`(B) live env + no connection → denied(connection)`)
else fail(`(B) expected deny(connection), got ${JSON.stringify(b)}`)

// (C) live env + sandbox-mode connection.
const cRes = runScenario({ NEXUS_AMAZON_ADS_MODE: 'live' }, TEST_MARKETPLACE_C, 1000)
if (cRes?.allowed === false && cRes.deniedAt === 'connection') pass(`(C) live env + sandbox conn → denied(connection)`)
else fail(`(C) expected deny(connection), got ${JSON.stringify(cRes)}`)

// (D) production conn, writesEnabledAt=null.
const d = runScenario({ NEXUS_AMAZON_ADS_MODE: 'live' }, TEST_MARKETPLACE_D, 1000)
if (d?.allowed === false && d.deniedAt === 'connection_writes') pass(`(D) writesEnabledAt=null → denied(connection_writes)`)
else fail(`(D) expected deny(connection_writes), got ${JSON.stringify(d)}`)

// (E) value over cap (default 50000¢; we use 60000).
const e = runScenario(
  { NEXUS_AMAZON_ADS_MODE: 'live', NEXUS_AMAZON_ADS_MAX_WRITE_VALUE_CENTS: '50000' },
  TEST_MARKETPLACE_E,
  60_000,
)
if (e?.allowed === false && e.deniedAt === 'value_cap') pass(`(E) over value cap → denied(value_cap)`)
else fail(`(E) expected deny(value_cap), got ${JSON.stringify(e)}`)

// (F) within value cap.
const f = runScenario(
  { NEXUS_AMAZON_ADS_MODE: 'live', NEXUS_AMAZON_ADS_MAX_WRITE_VALUE_CENTS: '50000' },
  TEST_MARKETPLACE_E,
  10_000,
)
if (f?.allowed === true && f.mode === 'live') pass(`(F) writes enabled + under cap → allowed live`)
else fail(`(F) expected allowed live, got ${JSON.stringify(f)}`)

// Cleanup.
await c.query(`DELETE FROM "AmazonAdsConnection" WHERE marketplace = ANY($1)`, [CLEANUP_MARKETPLACES])

await c.end()
process.exit(exitCode)
