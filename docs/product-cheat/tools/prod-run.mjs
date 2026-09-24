// Runs one of this lane's scripts against PRODUCTION (or --local), safely:
// Neon host only, Redis pointed at a dead port (no queue is ever touched), business profiles ON.
// Usage: node prod-run.mjs <derive|backfill|fill-axes|content-drift> [--local] [script flags, e.g. --apply --workspace <id>]
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire('/Users/awais/nexus-commerce/apps/api/package.json')
const [which, ...rest] = process.argv.slice(2)
const scripts = { derive: 'src/scripts/derive-required-attributes.ts', backfill: 'src/scripts/readiness-backfill.ts', 'fill-axes': 'src/scripts/fill-variation-store.ts', 'content-drift': 'src/scripts/content-drift-dry-run.ts' }
if (!scripts[which]) { console.error('usage: node prod-run.mjs <derive|backfill|fill-axes|content-drift> [--local] [flags]'); process.exit(2) }
const local = rest.includes('--local')
const args = rest.filter(a => a !== '--local')
const env = require('dotenv').parse(readFileSync(local ? '/Users/awais/nexus-commerce/apps/api/.env' : '/Users/awais/nexus-commerce/.env'))
const url = new URL(env.DATABASE_URL)
if (local ? url.hostname !== '127.0.0.1' : !/neon\.tech$/.test(url.hostname)) { console.error('REFUSE: unexpected host ' + url.hostname); process.exit(1) }
console.log(`[prod-run] ${which} → ${url.hostname}${url.pathname} ${local ? '(LOCAL)' : '(PRODUCTION)'} · ${args.includes('--apply') || args.includes('--revert') ? 'WRITES' : 'dry run'} · args: ${args.join(' ') || '(none)'}`)
const r = spawnSync('npx', ['tsx', scripts[which], ...args], {
  cwd: '/Users/awais/nexus-commerce/apps/api', stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: env.DATABASE_URL, DIRECT_URL: env.DIRECT_URL ?? env.DATABASE_URL, REDIS_URL: 'redis://127.0.0.1:1', NEXUS_WORKSPACES_ENABLED: '1' },
})
process.exit(r.status ?? 1)
