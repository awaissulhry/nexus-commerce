import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const files = JSON.parse(readFileSync(new URL('scope.json', import.meta.url))).filter(p => p.startsWith('apps/api/') && p.endsWith('.ts') && existsSync(p))
files.push('apps/api/src/services/pim/information-database.vitest.test.ts')
const startedAt = new Date().toISOString()
const result = spawnSync('node', ['scripts/typecheck-scoped.mjs', ...files], { encoding: 'utf8', maxBuffer: 10*1024*1024 })
const output = (result.stdout ?? '') + (result.stderr ?? '')
writeFileSync(new URL('api-typecheck.json', import.meta.url), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), files, exitCode: result.status, output }, null, 2)+'\n')
console.log(output)
process.exitCode = result.status ?? 1
