/** Runs only the two Owner-authorized schema commands for the ONE LX.5 table-only folder. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { databaseTarget } from '../step1/target.mjs'

const [name, action] = process.argv.slice(2)
assert.ok(['execute', 'resolve'].includes(action), 'Action must be execute or resolve.')
const target = await databaseTarget(name)
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const folder = '20260912_lx5_readiness_index'
const schema = `${root}packages/database/prisma/schema.prisma`
const args = action === 'execute' ? ['db', 'execute', '--file', `${root}packages/database/prisma/migrations/${folder}/migration.sql`, '--schema', schema]
  : ['migrate', 'resolve', '--applied', folder, '--schema', schema]
const ledger = `${root}docs/pes-claims.md`
fs.appendFileSync(ledger, `\nLX Step 5 migration BEFORE · ${new Date().toISOString()} · ${name} · prisma ${args.join(' ')} · one table-only folder; no existing business values changed.\n`)
console.log(JSON.stringify({ at: new Date().toISOString(), ...target.identity, command: ['prisma', ...args] }))
const result = spawnSync(`${root}node_modules/.bin/prisma`, args, { env: { ...process.env, DATABASE_URL: target.connectionString }, encoding: 'utf8' })
fs.writeFileSync(new URL(`${name}-${action}.json`, import.meta.url), JSON.stringify({at:new Date().toISOString(),target:target.identity,args,status:result.status,stdout:result.stdout,stderr:result.stderr,error:result.error?.message},null,2)+'\n')
fs.appendFileSync(ledger, `\nLX Step 5 migration AFTER · ${new Date().toISOString()} · ${name} · ${action} · exit ${result.status}; receipt step5/${name}-${action}.json.\n`)
console.log(result.stdout ?? ''); console.error(result.stderr ?? '')
if (result.error) throw result.error
process.exit(result.status ?? 1)
