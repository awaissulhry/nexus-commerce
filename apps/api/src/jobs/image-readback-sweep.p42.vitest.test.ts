/**
 * P4.2d — the sweep actually runs.
 *
 * 🔴 P4.2c's whole finding was that Amazon and Shopify had a read-back FUNCTION
 * and no HABIT: nothing scheduled it, so drift stayed invisible until somebody
 * opened a screen. It then shipped the sweep into `CRON_REGISTRY` only — which is
 * a MANUAL TRIGGER, and therefore exactly the state it had just called the
 * defect. I reported it as "one variable starts detecting drift"; the variable
 * alone would have changed nothing, because nothing called it.
 *
 * These tests exist so that cannot be true again: a sweep must be REACHABLE by a
 * schedule, not only by a person.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..')
const job = readFileSync(join(SRC, 'jobs', 'image-readback-sweep.job.ts'), 'utf8')
const index = readFileSync(join(SRC, 'index.ts'), 'utf8')
const service = readFileSync(join(SRC, 'services', 'images', 'live-image-readback.service.ts'), 'utf8')

describe('it is scheduled, not only registered', () => {
  it('schedules a cron', () => {
    expect(job).toContain('cron.schedule(')
    expect(job).toContain("const JOB_NAME = 'image-readback-sweep'")
  })

  it('is started at boot, beside eBay’s', () => {
    expect(index).toContain('startImageReadbackSweepCron')
    expect(index).toContain('startImageReadbackSweepCron();')
    // Next to the eBay one, so the two are read together.
    const iEbay = index.indexOf('startEbayImageReadbackCron();')
    const iThis = index.indexOf('startImageReadbackSweepCron();')
    expect(iEbay).toBeGreaterThan(0)
    expect(Math.abs(iThis - iEbay)).toBeLessThan(200)
  })

  it('records its run like every other cron', () => {
    expect(job).toContain('recordCronRun(JOB_NAME')
  })
})

describe('ONE switch, not two', () => {
  it('the cron reads the same variable the sweep reads', () => {
    // Two switches for one fact is the drift shape this programme keeps
    // finding — and here it would produce the worst outcome of all: a job that
    // runs every six hours and returns "off" every time.
    expect(job).toContain("process.env.NEXUS_ENABLE_IMAGE_READBACK_SWEEP !== 'true'")
    expect(service).toContain("process.env.NEXUS_ENABLE_IMAGE_READBACK_SWEEP === 'true'")
    // No second flag invented for the cron.
    const flags = [...job.matchAll(/NEXUS_ENABLE_[A-Z_]+/g)].map((m) => m[0])
    expect([...new Set(flags)]).toEqual(['NEXUS_ENABLE_IMAGE_READBACK_SWEEP'])
  })

  it('says plainly when it is off, naming the variable', () => {
    expect(job).toContain('cron disabled (set NEXUS_ENABLE_IMAGE_READBACK_SWEEP=true)')
  })
})

describe('the run reports numbers, and a blind run cannot read as a clean one', () => {
  it('prints unconfigured beside empty', () => {
    for (const field of ['eligible', 'scanned', 'refreshed', 'empty', 'skipped', 'unconfigured', 'errored']) {
      expect(job, `the summary must report ${field}`).toContain(`${field} $`)
    }
    expect(job).toContain('CAPPED')
  })

  it('does not collide with eBay’s 6-hourly read-back', () => {
    // eBay runs at minute 45 of every 6th hour. A different minute AND different
    // hours, so a deploy does not start both sweeps at once.
    expect(job).toContain("'25 2,8,14,20 * * *'")
    const ebayJob = readFileSync(join(SRC, 'jobs', 'ebay-image-readback.job.ts'), 'utf8')
    expect(ebayJob).toContain("'45 */6 * * *'") // the one it must not match
  })
})
