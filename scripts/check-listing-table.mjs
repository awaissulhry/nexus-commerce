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
console.log('Listing rows:', (await c.query(`SELECT count(*)::int as n FROM "Listing"`)).rows[0].n)
await c.end()
