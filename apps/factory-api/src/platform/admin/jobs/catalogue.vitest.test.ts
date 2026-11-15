import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { nextRunOf, parseCron } from '@nexus/factory-domain/integration-health/jobs'
import type { CronJob } from '../../../core/cron'
import { JOB_CATALOGUE } from './catalogue'

/**
 * The jobs page's catalogue is every cron background.ts schedules, name and schedule alike: this test builds each cron
 * factory background.ts imports (with stand-in dependencies: building a cron touches nothing) and compares. A new cron
 * needs its line in catalogue.ts (and its words in the web's admin-integration-health.json).
 */

const BACKGROUND = fileURLToPath(new URL('../../../background.ts', import.meta.url))

async function scheduledCrons(): Promise<CronJob[]> {
  const source = readFileSync(BACKGROUND, 'utf8')
  const imports = [...source.matchAll(/^import \{([^}]+)\} from '(\.\/[^']+)'/gm)]
  const stand = { database: {}, kit: {}, log: { info() {}, warn() {}, error() {} }, memory: {}, cookieSecret: 'x'.repeat(32), redis: {} }
  const jobs: CronJob[] = []
  for (const [, names, path] of imports) {
    const factories = names!
      .split(',')
      .map((name) => name.trim().split(/\s+as\s+/).pop()!.trim())
      .filter((name) => /Cron$/.test(name) && name !== 'startCrons' && name !== 'recordedCrons')
    if (factories.length === 0) continue
    const module = (await import(new URL(path!.replace(/^\.\//, '../../../'), import.meta.url).href)) as Record<string, (options: unknown) => CronJob>
    for (const name of factories) {
      // A factory background.ts imports but does not call is not scheduled.
      const called = new RegExp(`\\b${name}\\(`).test(source.slice(source.indexOf('const crons')))
      if (!called) continue
      jobs.push(module[name]!(stand))
    }
  }
  return jobs
}

describe('the jobs catalogue', () => {
  it('names every cron background.ts schedules, with its schedule', async () => {
    const crons = await scheduledCrons()
    expect(crons.length).toBeGreaterThan(40)
    const scheduled = new Map(crons.map((job) => [job.name, job.schedule]))
    // The error queue's collector is pushed by background.ts too; the catalogue lists it.
    for (const [name, schedule] of scheduled) expect(JOB_CATALOGUE.find((entry) => entry.key === name)?.schedule, name).toBe(schedule)
    for (const entry of JOB_CATALOGUE) expect(scheduled.has(entry.key), entry.key).toBe(true)
  }, 120_000)

  it('has each job once, a schedule that parses and a next run', () => {
    const keys = JOB_CATALOGUE.map((entry) => entry.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const entry of JOB_CATALOGUE) {
      expect(() => parseCron(entry.schedule), entry.key).not.toThrow()
      expect(nextRunOf(entry.schedule, entry.timeZone, new Date('2026-11-15T10:00:00Z')), entry.key).not.toBeNull()
    }
  })
})
