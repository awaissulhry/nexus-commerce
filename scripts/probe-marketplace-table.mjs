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
  SELECT code, name, "marketplaceId", "isActive", "isParticipating", region
  FROM "Marketplace"
  WHERE channel = 'AMAZON'
  ORDER BY code;
`)
console.table(r.rows)
await c.end()
