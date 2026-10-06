/**
 * ADS AUTONOMY W4 review — the daily-run modules load in any order a process loads them, in real Node ESM. The run
 * record, its tools, Claude's trust rules and the tool registry import one another; a constant one of them reads WHILE
 * LOADING must already exist whichever module came first, or the process dies at boot ("Cannot access … before
 * initialization") and every cron or route with it. vitest's module runner does not reproduce that, so each case runs a
 * fresh Node process (tsx, as the API runs in development) that imports the modules in the given order and nothing else
 * — no server, no worker, no scheduler is started. The database URL is this run's guarded loopback one; Redis is off.
 */
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const API = fileURLToPath(new URL('../..', import.meta.url))
const TSX = fileURLToPath(new URL('../../../../node_modules/.bin/tsx', import.meta.url))
const LOADER = 'src/test-support/import-in-order.ts'

function importInOrder(...files: string[]): Promise<string> {
  return new Promise((done) => {
    execFile(TSX, [LOADER, ...files], { cwd: API, timeout: 240_000, env: { ...process.env, REDIS_URL: '', NEXUS_ENABLE_QUEUE_WORKERS: '0' } }, (_error, stdout) => {
      done(stdout.split('\n').find((line) => line.startsWith('IMPORT-')) ?? `IMPORT-FAILED (no answer): ${stdout.slice(-300)}`)
    })
  })
}

const RUN_SERVICE = 'src/services/agents/ads-manager-run.service.ts'
const TOOLS = 'src/services/agents/tools/ads-manager.tools.ts'
/** W4-5 — the watch-week comparison the ads-manager tools read. */
const WATCH_WEEK = 'src/services/agents/ads-watch-week.service.ts'
const REGISTRY = 'src/services/agents/tool-registry.ts'
const WATCHDOG = 'src/services/agents/ads-manager-watchdog.service.ts'
const WATCHDOG_JOB = 'src/jobs/claude-ads-run-watchdog.job.ts'

describe('W4 — the daily-run modules load whichever comes first (real Node ESM)', () => {
  it.each([
    ['the run record first', [RUN_SERVICE, REGISTRY]],
    ['the ads-manager tools first', [TOOLS, REGISTRY]],
    ['the watch-week comparison first', [WATCH_WEEK, REGISTRY]],
    ['the tool registry first (the API\'s order)', [REGISTRY, RUN_SERVICE]],
    ['the OAuth server first', ['src/services/oauth/oauth-server.ts', REGISTRY]],
    ['the scheduler first', ['src/runtime/scheduler.ts', REGISTRY]],
    // W4-2 — the scheduler imports the watchdog job early; the job's tick loads the watchdog service.
    ['the watchdog job first, then the scheduler', [WATCHDOG_JOB, 'src/runtime/scheduler.ts', REGISTRY]],
    ['the watchdog service first (what the tick loads)', [WATCHDOG, REGISTRY]],
    ['the tool registry first, then the watchdog', [REGISTRY, WATCHDOG]],
    ['the ads-manager tools first, then the watchdog', [TOOLS, WATCHDOG]],
    // PB-5b — the playbook's start and its tool reach the artifacts hook, the bid floors and the registry.
    ['the playbook start first', ['src/services/advertising/ads-playbook/start.ts', REGISTRY]],
    ['the playbook apply tool first', ['src/services/agents/tools/ads-playbook-apply.tools.ts', REGISTRY]],
  ])('%s', async (_label, files) => {
    expect(await importInOrder(...files)).toBe('IMPORT-OK')
  }, 240_000)
})
