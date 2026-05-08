#!/usr/bin/env node
// One-shot: confirm Channel table is unused before any cleanup decision.
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
const url = process.env.DATABASE_URL?.replace('-pooler', '')
const c = new pg.Client({ connectionString: url })
await c.connect()
console.log('Channel rows:', (await c.query(`SELECT count(*)::int as n FROM "Channel"`)).rows[0].n)
const r = await c.query(`SELECT array_agg(DISTINCT channel ORDER BY channel) as channels, count(DISTINCT channel)::int as n FROM "ChannelListing"`)
console.log('ChannelListing.channel distinct:', r.rows[0])
await c.end()
