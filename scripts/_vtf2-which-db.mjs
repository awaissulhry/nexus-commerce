/**
 * VT.F2 — R-VT-12's BEFORE measurement. Env read ONLY; opens no connection.
 *
 * Reproduces exactly what `apps/api/src/env.ts` does (non-overriding dotenv, CWD's .env first, then the
 * repo-root .env) and prints the host + database it resolves for THIS process's CWD. Run it from both the
 * repo root and from `apps/api` to see which database a test run would have talked to.
 */
import { config } from 'dotenv'
import { resolve } from 'path'
const repoRoot = resolve(new URL('.', import.meta.url).pathname, '..')
const ambient = process.env.DATABASE_URL ? 'SET (an exported DATABASE_URL wins over every .env)' : 'unset'
config()
config({ path: resolve(repoRoot, '.env') })
const url = process.env.DATABASE_URL
let host = '(unparseable)', db = ''
try { const u = new URL(url); host = u.hostname; db = u.pathname.replace(/^\//, '') } catch {}
console.log(`cwd=${process.cwd()}\n  ambient DATABASE_URL: ${ambient}\n  resolved host: ${host}\n  resolved database: ${db}`)
