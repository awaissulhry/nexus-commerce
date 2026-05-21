#!/usr/bin/env node
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()
const r = await c.query(`
  SELECT "channelOrderId", marketplace, status, "totalPrice"::numeric(10,2) AS price, "purchaseDate"
  FROM "Order"
  WHERE channel='AMAZON' AND "deletedAt" IS NULL
    AND "purchaseDate" >= date_trunc('day', now() AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome'
  ORDER BY "purchaseDate";
`)
console.log(`TODAY (Europe/Rome) — ${r.rows.length} rows, all statuses`)
if (r.rows.length) console.table(r.rows)
await c.end()
