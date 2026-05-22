#!/usr/bin/env node
/**
 * MS.5 — fix the Marketplace table seed for Amazon EU markets.
 *
 * Issues spotted in prod:
 *   1. IE marketplaceId was set to 'AMEN7PMS3EDWL' which is Belgium's
 *      official SP-API ID. Should be 'A28R8C7NBKEWEA'.
 *   2. BE and TR are missing entirely.
 *   3. US is set isActive=true but lives in the NA SP-API region and
 *      isn't part of Xavia's EU credentials. Marking inactive.
 *
 * Idempotent — re-running is safe. Reports the diffs it applied.
 */

import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

const CORRECT_AMAZON_EU = [
  { code: 'IT', marketplaceId: 'APJ6JRA9NG5V4', name: 'Amazon Italy', currency: 'EUR', language: 'it', domainUrl: 'amazon.it', vatRate: 22 },
  { code: 'DE', marketplaceId: 'A1PA6795UKMFR9', name: 'Amazon Germany', currency: 'EUR', language: 'de', domainUrl: 'amazon.de', vatRate: 19 },
  { code: 'FR', marketplaceId: 'A13V1IB3VIYZZH', name: 'Amazon France', currency: 'EUR', language: 'fr', domainUrl: 'amazon.fr', vatRate: 20 },
  { code: 'ES', marketplaceId: 'A1RKKUPIHCS9HS', name: 'Amazon Spain', currency: 'EUR', language: 'es', domainUrl: 'amazon.es', vatRate: 21 },
  { code: 'UK', marketplaceId: 'A1F83G8C2ARO7P', name: 'Amazon UK', currency: 'GBP', language: 'en', domainUrl: 'amazon.co.uk', vatRate: 20 },
  { code: 'NL', marketplaceId: 'A1805IZSGTT6HS', name: 'Amazon Netherlands', currency: 'EUR', language: 'nl', domainUrl: 'amazon.nl', vatRate: 21 },
  { code: 'SE', marketplaceId: 'A2NODRKZP88ZB9', name: 'Amazon Sweden', currency: 'SEK', language: 'sv', domainUrl: 'amazon.se', vatRate: 25 },
  { code: 'PL', marketplaceId: 'A1C3SOZRARQ6R3', name: 'Amazon Poland', currency: 'PLN', language: 'pl', domainUrl: 'amazon.pl', vatRate: 23 },
  { code: 'BE', marketplaceId: 'AMEN7PMS3EDWL', name: 'Amazon Belgium', currency: 'EUR', language: 'nl', domainUrl: 'amazon.com.be', vatRate: 21 },
  { code: 'IE', marketplaceId: 'A28R8C7NBKEWEA', name: 'Amazon Ireland', currency: 'EUR', language: 'en', domainUrl: 'amazon.ie', vatRate: 23 },
  { code: 'TR', marketplaceId: 'A33AVAJ2PDY3EV', name: 'Amazon Turkey', currency: 'TRY', language: 'tr', domainUrl: 'amazon.com.tr', vatRate: 18 },
]

const changes = []

for (const m of CORRECT_AMAZON_EU) {
  const existing = await c.query(
    `SELECT id, "marketplaceId", "isActive", region FROM "Marketplace" WHERE channel='AMAZON' AND code=$1`,
    [m.code],
  )
  if (existing.rows.length === 0) {
    await c.query(
      `INSERT INTO "Marketplace" (id, channel, code, name, "marketplaceId", region, currency, language, "domainUrl", "isActive", "vatRate", "taxInclusive", "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, 'AMAZON', $1, $2, $3, 'EU', $4, $5, $6, true, $7, true, now(), now())`,
      [m.code, m.name, m.marketplaceId, m.currency, m.language, m.domainUrl, m.vatRate],
    )
    changes.push(`INSERTED ${m.code} (${m.marketplaceId})`)
  } else {
    const r = existing.rows[0]
    if (r.marketplaceId !== m.marketplaceId || r.region !== 'EU') {
      await c.query(
        `UPDATE "Marketplace"
         SET "marketplaceId"=$1, region='EU', name=$2, currency=$3, language=$4, "domainUrl"=$5, "vatRate"=$6, "taxInclusive"=true, "updatedAt"=now()
         WHERE id=$7`,
        [m.marketplaceId, m.name, m.currency, m.language, m.domainUrl, m.vatRate, r.id],
      )
      changes.push(`UPDATED ${m.code}: marketplaceId ${r.marketplaceId} → ${m.marketplaceId}`)
    }
  }
}

// Deactivate US (different SP-API region; can't ingest with EU creds)
const us = await c.query(
  `UPDATE "Marketplace" SET "isActive"=false, "updatedAt"=now() WHERE channel='AMAZON' AND code='US' AND "isActive"=true RETURNING code`,
)
if (us.rowCount && us.rowCount > 0) changes.push('DEACTIVATED US (NA region, out of EU credentials scope)')

console.log(changes.length ? changes.join('\n') : 'No changes needed.')
await c.end()
