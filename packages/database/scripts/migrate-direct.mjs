#!/usr/bin/env node
/**
 * Run `prisma migrate deploy` against the DIRECT (non-pooler) Neon endpoint.
 *
 * WHY
 * ---
 * `migrate deploy` takes a SESSION-scoped advisory lock (pg_advisory_lock(72707369)).
 * Through the Neon POOLER, pgbouncer hands it a pooled server connection. If the migrate
 * process then exits without releasing — a crash, an OOM, a container kill mid-deploy —
 * the lock survives, because it belongs to the server session that pgbouncer keeps alive
 * and recycles for ordinary traffic. Nothing releases it.
 *
 * Every subsequent boot then waits 10s for that lock, times out with P1002, and crashes.
 * Railway restarts, and it happens again: a self-sustaining outage that only ends when
 * pgbouncer happens to recycle the holding connection. That is exactly what took the API
 * down on 2026-08-04 (~14:18, roughly 20 minutes).
 *
 * On a DIRECT connection there is no pooler in between, so the session ends when this
 * process ends and Postgres releases the lock automatically.
 *
 * WHY NOT `directUrl = env("DIRECT_DATABASE_URL")`
 * -----------------------------------------------
 * That variable exists on Railway but is referenced nowhere in this repo, so its value
 * cannot be verified from here — and a stale one (after the pending Neon password
 * rotation, say) would fail the boot outright rather than merely lose the benefit.
 * Deriving from DATABASE_URL keeps ONE credential in play and tracks rotations for free.
 *
 * Degrades safely: if DATABASE_URL has no `-pooler` (local Postgres, direct Neon), the
 * URL is passed through unchanged.
 */
import { spawnSync } from 'node:child_process'

const url = process.env.DATABASE_URL ?? ''
if (!url) {
  console.error('[migrate] DATABASE_URL is not set')
  process.exit(1)
}

// Neon's pooled host is the direct host with `-pooler` appended to the endpoint id:
//   ep-x-y-pooler.c-3.eu-central-1.aws.neon.tech -> ep-x-y.c-3.eu-central-1.aws.neon.tech
const direct = url.replace('-pooler', '')
const host = (u) => (u.split('@')[1] ?? '').split('/')[0]

if (direct === url) {
  console.log('[migrate] DATABASE_URL is already a direct endpoint — using it as-is')
} else {
  console.log(`[migrate] stripping pooler for migrations: ${host(url)} -> ${host(direct)}`)
}

const res = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: direct },
})

if (res.error) {
  console.error('[migrate] failed to spawn prisma:', res.error.message)
  process.exit(1)
}
process.exit(res.status ?? 1)
