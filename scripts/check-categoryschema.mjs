#!/usr/bin/env node
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const url = process.env.DATABASE_URL?.replace('-pooler', '')
const c = new pg.Client({ connectionString: url })
await c.connect()
const r = await c.query(`SELECT count(*)::int as n, count(*) FILTER (WHERE "schemaVersion" = 'unknown')::int as unknown_n FROM "CategorySchema"`)
console.log('CategorySchema:', r.rows[0])
await c.end()
