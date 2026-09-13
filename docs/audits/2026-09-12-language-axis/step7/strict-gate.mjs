import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
const directory = 'docs/audits/2026-09-12-language-axis/step7/'
const script = 'scripts/check-editor-open.mjs'
const env = { ...process.env, EDITOR_BASE: 'http://localhost:4121', EDITOR_API: 'http://localhost:4122', STUDIO_API_BASE: 'http://localhost:4122', EDITOR_PRODUCT: 'cmokmy3a40078pm0p1fvnu523' }
for (const key of ['EDITOR_ONLY', 'EDITOR_REPS', 'STUDIO_STORAGE_STATE', 'CENSUS_STORAGE_STATE', 'STUDIO_TEST_EMAIL', 'STUDIO_TEST_PASSWORD']) delete env[key]
const receipt = { command: 'node scripts/check-editor-open.mjs --strict', start: new Date().toISOString(), web: env.EDITOR_BASE, api: env.EDITOR_API, product: env.EDITOR_PRODUCT, authentication: 'Synthetic fixed identity; UI/data gate, not authentication verification', scriptSha256: createHash('sha256').update(await fs.readFile(script)).digest('hex'), writeProtection: 'Gate aborts API mutations; isolated API additionally allows only reads and estimates, database enforced read-only' }
const log = await fs.open(directory + 'strict-gate.log', 'w')
const child = spawn(process.execPath, [script, '--strict'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.on('data', chunk => { process.stdout.write(chunk); void log.write(chunk) })
child.stderr.on('data', chunk => { process.stderr.write(chunk); void log.write(chunk) })
const result = await new Promise(resolve => { child.on('exit', (code, signal) => resolve({ code, signal })); child.on('error', error => resolve({ code: null, error: error.message })) })
await log.close()
await fs.writeFile(directory + 'strict-gate.json', JSON.stringify({ ...receipt, finish: new Date().toISOString(), ...result }, null, 2))
process.exitCode = result.code ?? 1
