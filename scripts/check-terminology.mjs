#!/usr/bin/env node
// One-shot read-only check for TerminologyPreference seed state.
// Used during the P0 #27 verification — confirm whether Xavia's
// Italian glossary entries are present.

import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const url = process.env.DATABASE_URL?.replace('-pooler', '')
if (!url) {
  console.error('DATABASE_URL missing — set it in .env')
  process.exit(1)
}

const c = new pg.Client({ connectionString: url })
await c.connect()
const r = await c.query(
  `SELECT id, brand, marketplace, language, preferred, avoid, context
   FROM "TerminologyPreference"
   ORDER BY marketplace, brand NULLS FIRST, preferred`,
)
console.log(`Rows: ${r.rows.length}`)
if (r.rows.length > 0) console.table(r.rows)
await c.end()
