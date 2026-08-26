import '../src/env.js'
import { spawnSync } from 'node:child_process'
const r = spawnSync('node', ['scripts/migrate-direct.mjs'], {
  cwd: '/Users/awais/nexus-commerce/packages/database',
  env: process.env,
  encoding: 'utf8',
})
console.log(r.stdout ?? '')
console.error(r.stderr ?? '')
process.exit(r.status ?? 1)
