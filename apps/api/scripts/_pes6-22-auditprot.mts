import { config as loadEnv } from 'dotenv'
loadEnv({ path: new URL('../../../.env', import.meta.url).pathname })
import pg from 'pg'
const c = new pg.Client({ connectionString: (process.env.DATABASE_URL ?? '').replace('-pooler','') })
await c.connect()
const trg = await c.query(`select tgname, pg_get_triggerdef(oid) as def from pg_trigger where tgrelid = '"AuditLog"'::regclass and not tgisinternal`)
console.log('triggers on AuditLog:', trg.rows.length)
for (const t of trg.rows) console.log(' ', t.tgname, '::', t.def.slice(0, 160))
const rls = await c.query(`select relrowsecurity, relforcerowsecurity from pg_class where oid='"AuditLog"'::regclass`)
console.log('row-level security:', JSON.stringify(rls.rows[0]))
const pol = await c.query(`select polname, polcmd from pg_policy where polrelid='"AuditLog"'::regclass`)
console.log('policies:', pol.rows.map((r:any)=>`${r.polname}(${r.polcmd})`).join(', ') || 'none')
await c.end()
