import { describe, expect, it } from 'vitest'
import type { QueueItem } from './model'
import { DeviceReporter, readBattery, REPORT_EVERY_MS, reportDue, type DeviceState } from './report'
import { AppUpdater, queuedCount, updateStep } from './update'

/**
 * Safe app updates (PLT-241; B-W2a-42): the floor app takes a new version only when its queue is empty, the network is
 * there and the screen holds nothing typed — never a queued scan at risk; one reload per version. And the tablet's own
 * report (app version, battery, queue count) to Admin › Devices. Made-up ids only.
 */

const item = (state: QueueItem['state'], final: boolean | null = null): QueueItem => ({
  clientEventId: `evt-${Math.random()}`,
  seq: 1,
  kind: 'production.scan.report',
  payload: {},
  occurredAt: '2026-10-30T08:00:00.000Z',
  workerId: 'w-1',
  deviceId: 'd-1',
  state,
  attempts: 0,
  refusal: final === null ? null : { id: 'r', code: 'X', message: 'm', fix: 'f', final },
  recordedAt: null,
  result: null,
  numbered: null,
})

const ready = { running: '1.0.0', latest: '1.1.0', queued: 0, sending: false, online: true, path: '/floor' }

describe('updateStep', () => {
  it('waits for the queue to empty first: a queued scan is never at risk', () => {
    expect(updateStep({ ...ready, queued: 3 })).toBe('waitQueue')
    expect(updateStep({ ...ready, sending: true })).toBe('waitQueue')
    expect(updateStep({ ...ready, queued: 3, online: false })).toBe('waitQueue')
  })

  it('then for the network (no offline shell yet) and for a screen at rest', () => {
    expect(updateStep({ ...ready, online: false })).toBe('waitNetwork')
    expect(updateStep({ ...ready, path: '/floor/cut' })).toBe('waitScreen')
    for (const path of ['/floor', '/floor/sign-in', '/floor/sync', '/floor/enrol']) expect(updateStep({ ...ready, path })).toBe('apply')
  })

  it('does nothing without a newer version, or for a version already tried', () => {
    expect(updateStep({ ...ready, latest: null })).toBe('none')
    expect(updateStep({ ...ready, latest: '1.0.0' })).toBe('none')
    expect(updateStep({ ...ready, triedFor: '1.1.0' })).toBe('none')
  })

  it('counts what still has to be sent: waiting, and refusals that may pass later', () => {
    expect(queuedCount([item('waiting'), item('refused', false), item('refused', true), item('recorded'), item('discarded')])).toBe(2)
    expect(queuedCount([])).toBe(0)
  })
})

describe('AppUpdater', () => {
  it('learns the server version, reloads once for it, and never again for the same one', async () => {
    let tried: string | null = null
    let reloads = 0
    const updater = new AppUpdater('1.0.0', { fetchLatest: async () => '1.1.0', memory: { get: () => tried, set: (value) => (tried = value) }, reload: () => reloads++ })
    expect(updater.getSnapshot()).toMatchObject({ running: '1.0.0', latest: null, triedFor: null })
    let changed = 0
    updater.subscribe(() => changed++)
    await updater.check()
    expect(changed).toBe(1)
    expect(updater.getSnapshot()).toMatchObject({ latest: '1.1.0', checkedAt: expect.any(String) })
    updater.apply()
    updater.apply()
    expect(reloads).toBe(1)
    expect(tried).toBe('1.1.0')
    // After the reload the page still runs 1.0.0 (a cache served the old page): no loop.
    const again = new AppUpdater('1.0.0', { fetchLatest: async () => '1.1.0', memory: { get: () => tried, set: (value) => (tried = value) }, reload: () => reloads++ })
    await again.check()
    expect(updateStep({ ...ready, latest: again.getSnapshot().latest, triedFor: again.getSnapshot().triedFor })).toBe('none')
    again.apply()
    expect(reloads).toBe(1)
  })

  it('keeps what it knew when the server does not answer', async () => {
    let answer: string | null = '1.1.0'
    const updater = new AppUpdater('1.0.0', { fetchLatest: async () => answer, memory: { get: () => null, set: () => undefined }, reload: () => undefined })
    await updater.check()
    answer = null
    await updater.check()
    expect(updater.getSnapshot().latest).toBe('1.1.0')
  })
})

describe('the device report', () => {
  const state = (over: Partial<DeviceState> = {}): DeviceState => ({ appVersion: '1.0.0', batteryPercent: 60, batteryCharging: false, queuedActions: 0, ...over })

  it('is due at start, on a new version, when the queue empties or fills, and every five minutes', () => {
    expect(reportDue(null, state(), 0)).toBe(true)
    const last = { at: 0, state: state() }
    expect(reportDue(last, state({ batteryPercent: 59 }), 1_000)).toBe(false)
    expect(reportDue(last, state({ appVersion: '1.1.0' }), 1_000)).toBe(true)
    expect(reportDue(last, state({ queuedActions: 2 }), 1_000)).toBe(true)
    expect(reportDue({ at: 0, state: state({ queuedActions: 2 }) }, state({ queuedActions: 3 }), 1_000)).toBe(false)
    expect(reportDue(last, state(), REPORT_EVERY_MS)).toBe(true)
  })

  it('sends one at a time and tries again after a failure', async () => {
    let now = 0
    const sent: DeviceState[] = []
    let fail = true
    const reporter = new DeviceReporter(async (body) => {
      if (fail) throw new Error('offline')
      sent.push(body)
    }, () => now)
    expect(await reporter.report(state())).toBe(false)
    fail = false
    expect(await reporter.report(state())).toBe(true)
    expect(await reporter.report(state({ batteryPercent: 10 }))).toBe(false)
    now = REPORT_EVERY_MS
    expect(await reporter.report(state({ batteryPercent: 10 }))).toBe(true)
    expect(sent.map((body) => body.batteryPercent)).toEqual([60, 10])
  })

  it('says no battery where the browser does not tell it', async () => {
    expect(await readBattery()).toEqual({ percent: null, charging: null })
  })
})
