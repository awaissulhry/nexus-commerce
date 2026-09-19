/**
 * Shared stock step 7 — which connection the live-sync worker LISTENs on (build doc §7). A LISTEN made
 * through Neon's pooler never hears a notify, so the worker must reach the direct host the same way the
 * migration runner (packages/database/scripts/migrate-direct.mjs) does.
 */
import { describe, expect, it } from 'vitest'
import { listenUrlFrom } from './sync-worker.js'

const pooled = 'postgresql://owner:secret@ep-quiet-river-123-pooler.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require'
const direct = 'postgresql://owner:secret@ep-quiet-river-123.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require'

describe('AE.4 — the listener URL', () => {
  it('takes the pooler off DATABASE_URL, keeping the same credential, database and options', () => {
    expect(listenUrlFrom({ DATABASE_URL: pooled })).toBe(direct)
  })

  it('prefers DIRECT_URL when it is set', () => {
    const other = 'postgresql://owner:secret@127.0.0.1:5432/other'
    expect(listenUrlFrom({ DATABASE_URL: pooled, DIRECT_URL: other })).toBe(other)
  })

  it('passes a direct or local URL through unchanged, and has none without a database URL', () => {
    expect(listenUrlFrom({ DATABASE_URL: direct })).toBe(direct)
    expect(listenUrlFrom({ DATABASE_URL: 'postgresql://postgres@127.0.0.1:55611/ss_ui' })).toBe('postgresql://postgres@127.0.0.1:55611/ss_ui')
    expect(listenUrlFrom({})).toBeNull()
  })

  it('matches the migration runner: the same input gives the same host', async () => {
    const { readFileSync } = await import('node:fs')
    const runner = readFileSync(new URL('../../../../../packages/database/scripts/migrate-direct.mjs', import.meta.url), 'utf8')
    expect(runner).toContain(".replace('-pooler', '')")
  })
})
