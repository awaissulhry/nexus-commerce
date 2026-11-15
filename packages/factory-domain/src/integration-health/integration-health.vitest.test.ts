import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { dismissReasonProblem, errorKeyOf, fixPlaceOf, reasonCodeOf, reasonTextOf, retryHeldOf } from './errors'
import { events } from './events'
import { CronScheduleError, jobStateOf, missedTickOf, nextRunOf, parseCron, runErrorOf, runNowHeldOf, runNowKeyOf, tickKeyOf, STUCK_AFTER_MS } from './jobs'
import { INTEGRATION_HEALTH_PERMISSIONS } from './permissions'

const ROME = 'Europe/Rome'
const at = (iso: string) => new Date(iso)

describe('integration health: permissions and events', () => {
  it('declares both permissions and every event', () => {
    for (const name of INTEGRATION_HEALTH_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(name)).toBe(true)
    for (const definition of events) expect(EVENT_CATALOGUE.find(definition.type, 1)).toBeTruthy()
  })
})

describe('the error queue rules', () => {
  it('says why Retry is held', () => {
    expect(retryHeldOf({ source: 'OUTBOX', state: 'OPEN', reasonCode: 'publish_failed' })).toBeNull()
    expect(retryHeldOf({ source: 'WEBHOOK', state: 'OPEN', reasonCode: 'processing_failed' })).toBeNull()
    expect(retryHeldOf({ source: 'WEBHOOK', state: 'OPEN', reasonCode: 'signature_mismatch' })).toBe('SIGNATURE')
    expect(retryHeldOf({ source: 'CALL', state: 'OPEN', reasonCode: 'timeout' })).toBe('FROM_RECORD')
    expect(retryHeldOf({ source: 'OUTBOX', state: 'RETRIED', reasonCode: 'job_failed' })).toBe('WAITING')
    expect(retryHeldOf({ source: 'OUTBOX', state: 'DISMISSED', reasonCode: 'job_failed' })).toBe('DISMISSED')
  })

  it('checks a dismiss reason and shapes codes, texts and keys', () => {
    expect(dismissReasonProblem('')).toBe('REQUIRED')
    expect(dismissReasonProblem(' ab ')).toBe('TOO_SHORT')
    expect(dismissReasonProblem('x'.repeat(501))).toBe('TOO_LONG')
    expect(dismissReasonProblem('Sent by hand to the customer')).toBeNull()
    expect(reasonCodeOf('00404')).toBe('00404')
    expect(reasonCodeOf('not a code!')).toBe('provider_error')
    expect(reasonCodeOf(null)).toBe('provider_error')
    expect(reasonTextOf('  two\nlines  ')).toBe('two lines')
    expect(reasonTextOf('   ')).toBeNull()
    expect(errorKeyOf('CALL', 'abc')).toBe('call:abc')
    expect(fixPlaceOf('CALL', 'sdi.send_invoice')).toBe('invoices')
    expect(fixPlaceOf('CALL', 'parcel.create')).toBe('shipments')
    expect(fixPlaceOf('CALL', 'unknown.op')).toBeNull()
    expect(fixPlaceOf('OUTBOX', 'sdi.send_invoice')).toBeNull()
  })
})

describe('cron schedules', () => {
  it('reads 5 and 6 fields and refuses the rest', () => {
    expect([...parseCron('*/15 8-18 * * 1-5').minutes]).toEqual([0, 15, 30, 45])
    expect([...parseCron('*/10 * * * * *').seconds]).toEqual([0, 10, 20, 30, 40, 50])
    expect(parseCron('0 9 * * 7').weekdays.has(0)).toBe(true)
    expect(() => parseCron('* * *')).toThrow(CronScheduleError)
    expect(() => parseCron('61 * * * *')).toThrow(CronScheduleError)
    expect(() => parseCron('a * * * *')).toThrow(CronScheduleError)
  })

  it('finds the next run in the time zone, across days and the clock change', () => {
    // 20 0 * * * in Rome (UTC+1 in November): 00:20 Rome = 23:20 UTC the day before.
    expect(nextRunOf('20 0 * * *', ROME, at('2026-11-15T10:00:00Z'))?.toISOString()).toBe('2026-11-15T23:20:00.000Z')
    expect(nextRunOf('* * * * *', ROME, at('2026-11-15T10:00:30Z'))?.toISOString()).toBe('2026-11-15T10:01:00.000Z')
    expect(nextRunOf('*/5 * * * *', ROME, at('2026-11-15T10:00:00Z'))?.toISOString()).toBe('2026-11-15T10:05:00.000Z')
    // Weekdays only: from Friday evening to Monday 16:30 Rome.
    expect(nextRunOf('30 16,18 * * 1-5', ROME, at('2026-11-13T18:00:00Z'))?.toISOString()).toBe('2026-11-16T15:30:00.000Z')
    // Summer time (UTC+2): 03:15 Rome = 01:15 UTC.
    expect(nextRunOf('15 3 * * *', ROME, at('2026-07-01T12:00:00Z'))?.toISOString()).toBe('2026-07-02T01:15:00.000Z')
    expect(nextRunOf('*/10 * * * * *', ROME, at('2026-11-15T10:00:05Z'))?.toISOString()).toBe('2026-11-15T10:00:10.000Z')
  })
})

describe('a job state', () => {
  const run = (status: 'RUNNING' | 'SUCCEEDED' | 'FAILED', iso: string, trigger: 'SCHEDULE' | 'RUN_NOW' = 'SCHEDULE') => ({ status, trigger, scheduledAt: at(iso), startedAt: at(iso) })
  const base = { schedule: '*/5 * * * *', timeZone: ROME }

  it('is never, running, stuck, failing, missed or ok', () => {
    const now = at('2026-11-15T10:02:00Z')
    expect(jobStateOf({ ...base, last: null, lastFinished: null, lastScheduled: null, now })).toBe('never')
    const ok = run('SUCCEEDED', '2026-11-15T10:00:00Z')
    expect(jobStateOf({ ...base, last: ok, lastFinished: ok, lastScheduled: ok, now })).toBe('ok')
    const failed = run('FAILED', '2026-11-15T10:00:00Z')
    expect(jobStateOf({ ...base, last: failed, lastFinished: failed, lastScheduled: failed, now })).toBe('failing')
    const running = run('RUNNING', '2026-11-15T10:00:00Z')
    expect(jobStateOf({ ...base, last: running, lastFinished: ok, lastScheduled: running, now })).toBe('running')
    expect(jobStateOf({ ...base, last: running, lastFinished: ok, lastScheduled: running, now: new Date(now.getTime() + STUCK_AFTER_MS) })).toBe('stuck')
    const later = at('2026-11-15T10:20:00Z')
    expect(jobStateOf({ ...base, last: ok, lastFinished: ok, lastScheduled: ok, now: later })).toBe('missed')
    expect(missedTickOf({ ...base, lastScheduled: ok, now: later })?.toISOString()).toBe('2026-11-15T10:05:00.000Z')
  })

  it('says why Run now is held and shapes keys and errors', () => {
    expect(runNowHeldOf({ known: false, policy: null, switchedOn: null, asked: false })).toBe('UNKNOWN_JOB')
    expect(runNowHeldOf({ known: true, policy: 'schedule', switchedOn: null, asked: false })).toBe('SCHEDULE_ONLY')
    expect(runNowHeldOf({ known: true, policy: 'check', switchedOn: false, asked: false })).toBe('SWITCHED_OFF')
    expect(runNowHeldOf({ known: true, policy: 'check', switchedOn: true, asked: true })).toBe('ASKED')
    expect(runNowHeldOf({ known: true, policy: 'check', switchedOn: null, asked: false })).toBeNull()
    expect(runNowKeyOf('outbox.lag', 'req-1')).toBe('outbox.lag@now:req-1')
    expect(tickKeyOf('outbox.lag', at('2026-11-15T10:00:00.400Z'))).toBe('outbox.lag@1794736800')
    expect(runErrorOf(new Error('boom'))).toBe('Error: boom')
    expect(runErrorOf('')).toBe('The job failed without a message.')
    expect(runErrorOf(new Error('x'.repeat(5000))).length).toBe(4000)
  })
})
