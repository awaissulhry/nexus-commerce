/**
 * P1.8 review (2026-09-23) — what the CronRun row says about a contract run, through the real
 * `recordCronRun` (its database stood in).
 *
 * Before: a partial or not-configured run completed its row as SUCCESS, which both cron dashboards draw as a
 * green tick; the hub's manual trigger ran even with the run switched off, wrote a second "manual trigger"
 * SUCCESS row around the real one, and a run that threw before finishing returned LAST night's summary.
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  run: null as null | (() => Promise<unknown>),
}))
vi.mock('../db.js', () => ({ default: { cronRun: {
  create: vi.fn(async ({ data }: any) => { h.rows.push({ id: `run-${h.rows.length + 1}`, ...data }); return { id: `run-${h.rows.length}` } }),
  update: vi.fn(async ({ where, data }: any) => Object.assign(h.rows.find((row) => row.id === where.id)!, data)),
} } }))
vi.mock('../services/contract/contract-run.service.js', () => ({
  isContractRunEnabled: () => process.env.NEXUS_ENABLE_CHANNEL_CONTRACT_RUN === 'true',
  runChannelContracts: vi.fn(async () => h.run!()),
}))

import { recordCronRun } from '../utils/cron-observability.js'
import { getChannelContractStatus, runChannelContractsOnce, runChannelContractsManual } from './channel-contract.job.js'
import { runChannelContracts } from '../services/contract/contract-run.service.js'

const summaryOf = (status: string, sentence: string) => ({ status, passed: 1, failed: status === 'red' ? 1 : 0, notConfigured: 0, notApplicable: 2, required: 9, proven: 5, channels: [], gaps: [], results: [], sentence })

beforeEach(() => { h.rows = []; h.run = null; vi.mocked(runChannelContracts).mockClear(); vi.stubEnv('NEXUS_ENABLE_CHANNEL_CONTRACT_RUN', '') })
afterEach(() => vi.unstubAllEnvs())

describe('recordCronRun — a completed run is not always a pass', () => {
  it('a summary string or {summary} completes as SUCCESS (every other job, unchanged)', async () => {
    await recordCronRun('some-job', async () => 'did 3 things')
    await recordCronRun('some-job', async () => ({ summary: 'did 4 things' }))
    expect(h.rows.map((row) => [row.status, row.outputSummary])).toEqual([['SUCCESS', 'did 3 things'], ['SUCCESS', 'did 4 things']])
  })
  it('{summary, cronStatus} completes with that status: PARTIAL and NOT_CONFIGURED', async () => {
    await recordCronRun('some-job', async () => ({ summary: '5/11 proven', cronStatus: 'PARTIAL' as const }))
    await recordCronRun('some-job', async () => ({ summary: '0/11 proven', cronStatus: 'NOT_CONFIGURED' as const }))
    expect(h.rows.map((row) => [row.status, row.outputSummary])).toEqual([['PARTIAL', '5/11 proven'], ['NOT_CONFIGURED', '0/11 proven']])
  })
  it('a thrown handler is still FAILED', async () => {
    await expect(recordCronRun('some-job', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(h.rows[0]).toMatchObject({ status: 'FAILED', errorMessage: 'boom' })
  })
})

describe('the nightly contract run → its CronRun row', () => {
  it.each([
    ['green', 'SUCCESS'],
    ['partial', 'PARTIAL'],
    ['not-configured', 'NOT_CONFIGURED'],
  ])('%s → %s, with the summary as written (proven/required first)', async (status, cronStatus) => {
    h.run = async () => summaryOf(status, `5/11 required operations proven — ${status}`)
    const summary = await runChannelContractsOnce('cron')
    expect(summary.status).toBe(status)
    expect(h.rows).toHaveLength(1)
    expect(h.rows[0]).toMatchObject({ jobName: 'channel-contract-run', status: cronStatus, outputSummary: `5/11 required operations proven — ${status}` })
  })
  it('red → FAILED with the sentence', async () => {
    h.run = async () => summaryOf('red', '5/11 required operations proven — Red: 1 channel contract check(s) failed')
    const summary = await runChannelContractsOnce('cron')
    expect(summary.status).toBe('red')
    expect(h.rows[0]).toMatchObject({ status: 'FAILED', errorMessage: expect.stringContaining('Red: 1 channel contract check(s) failed') })
  })
  it('a run that throws before it finishes reports THIS run as red — never the previous night\'s summary', async () => {
    h.run = async () => summaryOf('partial', 'last night')
    await runChannelContractsOnce('cron')
    h.run = async () => { throw new Error('database unreachable') }
    const summary = await runChannelContractsOnce('cron')
    expect(summary.status).toBe('red')
    expect(summary.sentence).toMatch(/did not complete: database unreachable/)
    expect(getChannelContractStatus().last).toEqual(summary)
    expect(h.rows.at(-1)).toMatchObject({ status: 'FAILED', errorMessage: 'database unreachable' })
  })
})

describe('the hub\'s manual trigger', () => {
  it('switched off: reports NOT run, NOT_CONFIGURED, and asks no channel', async () => {
    // A run that WOULD answer, so a trigger that ignores the switch fails by assertion, not by a crash.
    h.run = async () => summaryOf('partial', '5/11 required operations proven — Partial, not green.')
    const result = await runChannelContractsManual()
    expect(result).toEqual({ summary: expect.stringMatching(/^Not run: the channel contract run is switched off/), cronStatus: 'NOT_CONFIGURED' })
    expect(runChannelContracts).not.toHaveBeenCalled()
  })
  it('switched on: runs, and returns the status for the trigger route\'s ONE row — it writes no row of its own', async () => {
    vi.stubEnv('NEXUS_ENABLE_CHANNEL_CONTRACT_RUN', 'true')
    h.run = async () => summaryOf('partial', '5/11 required operations proven — Partial, not green.')
    expect(await runChannelContractsManual()).toEqual({ summary: '5/11 required operations proven — Partial, not green.', cronStatus: 'PARTIAL' })
    expect(h.rows).toEqual([])
    h.run = async () => summaryOf('red', '5/11 required operations proven — Red: x')
    await expect(runChannelContractsManual()).rejects.toThrow('Red: x')
    expect(h.rows).toEqual([])
  })
  it('the registry triggers the manual function, not the self-recording nightly one', () => {
    const registry = readFileSync(new URL('./cron-registry.ts', import.meta.url), 'utf8')
    expect(registry).toMatch(/'channel-contract-run': \(\) => runChannelContractsManual\(\),/)
    expect(registry).not.toMatch(/runChannelContractsOnce/)
  })
})
