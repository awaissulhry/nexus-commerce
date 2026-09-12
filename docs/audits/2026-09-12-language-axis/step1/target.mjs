import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse } from 'dotenv'

/** Reads connection configuration only; never exports credentials to output or argv. */
export async function databaseTarget(name) {
  assert.ok(['production', 'local'].includes(name), 'Target must be production or local.')
  const env = name === 'local' ? parse(await readFile(new URL('../../../../apps/api/.env', import.meta.url))) : process.env
  if (name === 'production') assert.equal(process.env.RAILWAY_ENVIRONMENT_NAME, 'production', 'Use Railway production --no-local.')
  assert.ok(env.DATABASE_URL, 'DATABASE_URL missing.')
  const url = new URL(env.DATABASE_URL)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  assert.equal(local, name === 'local', 'Database target does not match the requested environment.')
  if (!local) url.hostname = url.hostname.replace('-pooler', '')
  return { connectionString: url.href, identity: { target: name, host: url.hostname, database: url.pathname.slice(1) } }
}
