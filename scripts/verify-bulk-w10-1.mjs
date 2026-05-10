#!/usr/bin/env node
// Verify W10.1 — SSE progress stream for active bulk jobs.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')

let failures = 0
function check(label, cond) {
  console.log(`  ${cond ? '✓' : '✗'} ${label}`)
  if (!cond) failures++
}

console.log('\nW10.1 — SSE progress stream\n')

const routes = fs.readFileSync(
  path.join(repo, 'apps/api/src/routes/bulk-operations.routes.ts'),
  'utf8',
)
const strip = fs.readFileSync(
  path.join(repo, 'apps/web/src/app/bulk-operations/ActiveJobsStrip.tsx'),
  'utf8',
)

console.log('Case 1: SSE route registered')
check("registers GET '/bulk-operations/:id/events'",
  /'\/bulk-operations\/:id\/events'/.test(routes))
check('writes text/event-stream headers',
  /'Content-Type': 'text\/event-stream'/.test(routes))
check('disables proxy buffering',
  /'X-Accel-Buffering': 'no'/.test(routes))
check('keep-alive header set',
  /Connection: 'keep-alive'/.test(routes))

console.log('\nCase 2: stream lifecycle')
check('emits initial snapshot event',
  /send\('snapshot', initial\)/.test(routes))
check('emits update events on change',
  /send\('update', row\)/.test(routes))
check('emits done event on terminal status',
  /send\('done', \{ status: row\.status \}\)/.test(routes))
check('closes connection after terminal',
  /TERMINAL\.has\(row\.status\)[\s\S]{0,200}close\(\)/.test(routes))
check('TERMINAL set covers all 4 terminal states',
  /COMPLETED[\s\S]{0,80}FAILED[\s\S]{0,80}PARTIALLY_COMPLETED[\s\S]{0,80}CANCELLED/.test(routes))
check('1s poll interval',
  /pollTimer = setInterval\([\s\S]+?\}, 1000\)/.test(routes))
check('25s heartbeat',
  /setInterval\([\s\S]{0,200}25_000\)/.test(routes) ||
  /setInterval\([\s\S]{0,200}25000\)/.test(routes))

console.log('\nCase 3: change-signature gating')
check('sigFor helper hashes tracked fields',
  /function sigFor\(/.test(routes) &&
  /processedItems[\s\S]{0,80}failedItems[\s\S]{0,80}skippedItems/.test(routes) &&
  /progressPercent[\s\S]{0,80}lastError/.test(routes))
check('only emits update when sig changes',
  /sig !== lastSig[\s\S]{0,200}send\('update'/.test(routes))

console.log('\nCase 4: cleanup on disconnect')
check('cleans up timers on close',
  /clearInterval\(pollTimer\)/.test(routes) &&
  /clearInterval\(heartbeat\)/.test(routes))
check("hooks request 'close' to close handler",
  /request\.raw\.on\('close', close\)/.test(routes))
check('404s when job missing before stream opens',
  /code\(404\)[\s\S]{0,80}Job not found:/.test(routes))

console.log('\nCase 5: ActiveJobsStrip subscribes')
check('imports useRef',
  /useRef/.test(strip))
check('opens EventSource per job',
  /new EventSource\(\s*`\$\{getBackendUrl\(\)\}\/api\/bulk-operations\/\$\{job\.id\}\/events`/.test(strip))
check('listens for update events',
  /addEventListener\('update'/.test(strip))
check('listens for done events',
  /addEventListener\('done'/.test(strip))
check('updates per-job state on update',
  /setJobs\(\(prev\) => prev\.map/.test(strip))
check('refetches list on done',
  /addEventListener\('done',[\s\S]{0,300}fetchActive\(\)/.test(strip))
check('closes stale subs when job leaves the list',
  /!wantedIds\.has\(id\)[\s\S]{0,200}es\.close\(\)/.test(strip))
check('closes all subs on unmount',
  /for \(const es of subs\.values\(\)\) es\.close\(\)/.test(strip))
check('guards against SSR (typeof EventSource check)',
  /typeof EventSource === 'undefined'/.test(strip))

if (failures > 0) {
  console.log(`\n✗ ${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\n✓ all assertions passed')
