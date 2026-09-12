/** Runs only the two Owner-authorized schema commands for the ONE LX.2 column-and-metadata-backfill folder. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { databaseTarget } from '../step1/target.mjs'

const [name, action] = process.argv.slice(2)
assert.ok(['execute', 'resolve'].includes(action), 'Action must be execute or resolve.')
const target = await databaseTarget(name)
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const folder = '20260912_lx2_marketplace_languages'
const schema = `${root}packages/database/prisma/schema.prisma`
const args = action === 'execute' ? ['db', 'execute', '--file', `${root}packages/database/prisma/migrations/${folder}/migration.sql`, '--schema', schema]
  : ['migrate', 'resolve', '--applied', folder, '--schema', schema]
console.log(JSON.stringify({ at: new Date().toISOString(), ...target.identity, command: ['prisma', ...args] }))
const result = spawnSync(`${root}node_modules/.bin/prisma`, args, { env: { ...process.env, DATABASE_URL: target.connectionString }, stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
