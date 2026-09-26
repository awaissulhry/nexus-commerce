import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { workspacePrisma } from '@nexus/database/workspace-router'
import { Pool } from 'pg'
import { existsSync, readFileSync } from 'node:fs'
import { applyFormulaSchema, PGLITE_SNAPSHOT_ENV } from './formula-schema.js'
import { fixExtendedQueryReady } from './pglite-protocol.js'

/** Disposable real PostgreSQL + the generated production Prisma client. No catalog connection. */
export async function formulaDatabase(options: { maxConnections?: number; port?: number } = {}) {
  // A copy of the run's snapshot (pglite-snapshot.global.ts) when there is one: 0.34 s instead of
  // 2.3 s per file, measured 2026-09-26. Still ONE fresh database per test file — only the build is
  // shared. NEXUS_TEST_NO_TEMPLATE=1 builds it here instead, as before.
  const snapshot = process.env.NEXUS_TEST_NO_TEMPLATE === '1' ? undefined : process.env[PGLITE_SNAPSHOT_ENV]
  const fromSnapshot = Boolean(snapshot && existsSync(snapshot))
  const db = fromSnapshot ? await PGlite.create({ loadDataDir: new Blob([readFileSync(snapshot!)]) }) : await PGlite.create()
  fixExtendedQueryReady(db) // the pg driver talks to it through the socket bridge below
  if (!fromSnapshot) await applyFormulaSchema(db)
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port: options.port ?? 0, maxConnections: options.maxConnections ?? 1 })
  let port = 0
  server.addEventListener('listening', (event: any) => { port = event.detail.port })
  await Promise.race([server.start(), new Promise<never>((_, reject) => server.addEventListener('error', (event: any) => reject(event.detail)))])
  const pool = new Pool({ host: '127.0.0.1', port, user: 'postgres', database: 'template1', max: 1, connectionTimeoutMillis: 5_000 })
  const client = workspacePrisma(pool)
  return { client, db, connectionString: `postgresql://postgres@127.0.0.1:${port}/template1`, async close() { await client.$disconnect(); await pool.end(); await server.stop(); await db.close() } }
}
