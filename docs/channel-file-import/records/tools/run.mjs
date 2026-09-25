// Starts the harness with the gate runner's production guard: every key the repo-root .env (PRODUCTION) defines
// and apps/api/.env does not is set to '' (dotenv never overrides a set variable), DATABASE_URL points at the clone.
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const ROOT = '/Users/awais/nexus-commerce'
const keys = f => readFileSync(f, 'utf8').split('\n').map(l => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1]).filter(Boolean)
const apiKeys = new Set(keys(`${ROOT}/apps/api/.env`))
const blanks = Object.fromEntries(keys(`${ROOT}/.env`).filter(k => !apiKeys.has(k)).map(k => [k, '']))
const local = readFileSync(`${ROOT}/apps/api/.env`, 'utf8').split('\n').find(l => l.startsWith('DATABASE_URL=')).slice(13).trim().replace(/^["']|["']$/g, '')
const u = new URL(local); if (u.hostname !== '127.0.0.1' || u.port !== '55439') throw new Error('apps/api/.env is not the local docker db')
u.pathname = '/nexus_cfi_20260924'
const env = { ...process.env, ...blanks, DATABASE_URL: u.toString(), DIRECT_URL: u.toString(), NEXUS_API_HOST: '127.0.0.1', NEXUS_DISABLE_BACKGROUND_JOBS: '1', ENABLE_QUEUE_WORKERS: '0', NEXUS_AMAZON_ENV_TOKEN: 'off' }
const r = spawnSync(process.execPath, ['--max-old-space-size=4096', '--import', 'tsx', new URL(process.argv[3] ?? './harness.mts', import.meta.url).pathname, process.argv[2]], { cwd: `${ROOT}/apps/api`, env, stdio: 'inherit', timeout: 20 * 60_000 })
process.exit(r.status ?? 1)
