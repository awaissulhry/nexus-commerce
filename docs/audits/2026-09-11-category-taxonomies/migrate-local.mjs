/** Apply ONLY the category migration to the configured LOCAL development DB through Prisma. */
import { readFile, mkdtemp, mkdir, copyFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { Client } from 'pg'
import { parse } from 'dotenv'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const env = parse(await readFile(`${root}apps/api/.env`))
const target = new URL(env.DATABASE_URL)
if (!['127.0.0.1', 'localhost', '::1'].includes(target.hostname)) throw new Error('This migration runner refuses remote databases.')
const name = '20260911_category_taxonomies'
const migrations = `${root}packages/database/prisma/migrations`
const checksum = createHash('sha256').update(await readFile(`${migrations}/${name}/migration.sql`)).digest('hex')
const db = new Client({ connectionString: target.href, connectionTimeoutMillis: 10_000, statement_timeout: 15_000 })
let applied = false
try {
  await db.connect()
  const history = (await db.query('SELECT migration_name, checksum, finished_at, rolled_back_at FROM "_prisma_migrations"')).rows
  if (history.some(r => !r.finished_at && !r.rolled_back_at)) throw new Error('Resolve the existing failed migration before continuing.')
  if (!history.some(r => r.migration_name === '20260908b_workspace_data_isolation' && r.finished_at && !r.rolled_back_at)) throw new Error('The workspace isolation prerequisite has not been applied.')
  const prior = history.find(r => r.migration_name === name && r.finished_at && !r.rolled_back_at)
  if (prior && prior.checksum !== checksum) throw new Error('The applied taxonomy migration has a different checksum.')
  applied = !!prior
} finally { await db.end() }
if (applied) console.log('Category migration already applied with the expected checksum.')
else {
  const stage = await mkdtemp(join(tmpdir(), 'nexus-category-migration-'))
  await mkdir(join(stage, 'migrations', name), { recursive: true })
  await writeFile(join(stage, 'schema.prisma'), 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n')
  await copyFile(`${migrations}/migration_lock.toml`, join(stage, 'migrations', 'migration_lock.toml'))
  await copyFile(`${migrations}/${name}/migration.sql`, join(stage, 'migrations', name, 'migration.sql'))
  const child = spawn(process.execPath, [`${root}node_modules/prisma/build/index.js`, 'migrate', 'deploy', '--schema', join(stage, 'schema.prisma')], {
    cwd: stage, env: { ...process.env, DATABASE_URL: target.href }, stdio: 'inherit',
  })
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)) })
}
