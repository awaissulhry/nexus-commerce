#!/usr/bin/env node
// READ-ONLY: confirm the gate flip stopped the live FBA quantity pushes.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'; import pg from 'pg'
const here = path.dirname(fileURLToPath(import.meta.url)); dotenv.config({ path: path.join(here, '..', '.env') })
const url = process.env.DATABASE_URL?.replace('-pooler', ''); if (!url) { console.error('no DATABASE_URL'); process.exit(1) }
const c = new pg.Client({ connectionString: url }); await c.connect()
const hr = (t) => console.log('\n' + '─'.repeat(64) + '\n' + t)
const Q = async (l, s) => { try { return (await c.query(s)).rows } catch (e) { console.log(`  [${l}] ${e.message}`); return [] } }

const nowRow = await Q('now', `SELECT to_char(now(),'YYYY-MM-DD HH24:MI:SS') t`)
console.log(`DB now(): ${nowRow[0]?.t}`)

hr('Last 15 QUANTITY_UPDATE→AMAZON queue rows (status transition):')
const rows = await Q('q', `
  SELECT to_char("createdAt",'MM-DD HH24:MI') ts, "syncStatus"::text st,
         left(coalesce("errorMessage",''),60) msg
  FROM "OutboundSyncQueue"
  WHERE "targetChannel"='AMAZON' AND "syncType"='QUANTITY_UPDATE'
  ORDER BY "createdAt" DESC LIMIT 15`)
rows.forEach(r=>console.log(`  ${r.ts}  ${r.st.padEnd(9)} ${r.msg}`))

hr('QUANTITY_UPDATE→AMAZON in the last 30 min, by status:')
const last30 = await Q('30', `
  SELECT "syncStatus"::text st, count(*) c FROM "OutboundSyncQueue"
  WHERE "targetChannel"='AMAZON' AND "syncType"='QUANTITY_UPDATE'
    AND "createdAt" > now() - interval '30 minutes'
  GROUP BY "syncStatus" ORDER BY c DESC`)
if (last30.length) last30.forEach(r=>console.log(`  ${r.st.padEnd(9)} ${r.c}`)); else console.log('  (none in last 30 min)')

hr('Most recent LIVE Amazon publish attempts (should stop after cutover):')
const live = await Q('live', `
  SELECT to_char("attemptedAt",'MM-DD HH24:MI') ts, sku, marketplace mkt, outcome
  FROM "ChannelPublishAttempt"
  WHERE channel='AMAZON' AND mode='live'
  ORDER BY "attemptedAt" DESC LIMIT 8`)
live.forEach(r=>console.log(`  ${r.ts}  ${r.sku} [${r.mkt}] ${r.outcome}`))

await c.end(); console.log('\nDone (read-only).')
