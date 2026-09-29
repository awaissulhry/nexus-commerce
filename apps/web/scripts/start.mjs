// The Railway start command: `node apps/web/scripts/start.mjs`.
//
// `next start` closes gracefully on SIGTERM and then exits 143 on purpose (next/dist/server/lib/start-server.js), and
// `npm run start` adds seven "npm error … signal SIGTERM" lines. Railway reports a replaced deployment that exits
// non-zero as CRASHED (2026-09-29, after RAILWAY_DEPLOYMENT_DRAINING_SECONDS=300). This runs `next start` as a child,
// passes the stop signal on, and reports the stop it asked for as a clean exit. Any other exit keeps its code.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const web = fileURLToPath(new URL('..', import.meta.url))
const next = createRequire(import.meta.url).resolve('next/dist/bin/next')
const child = spawn(process.execPath, [next, 'start', ...process.argv.slice(2)], { cwd: web, stdio: 'inherit' })

let stopping = false
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopping = true
    child.kill(signal)
  })
}

child.on('exit', (code, signal) => {
  const askedToStop = stopping && (signal !== null || code === 143 || code === 130)
  process.exit(askedToStop ? 0 : (code ?? 1))
})
