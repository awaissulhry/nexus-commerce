import { describe, expect, it } from 'vitest'
import { fakePrintRelay } from './fake'
import { RelayError, type RelayJob } from './port'

const job = (jobId: string): RelayJob => ({
  jobId,
  tenantId: 't',
  siteId: 's',
  printer: { id: 'p', code: 'LBL-01', kind: 'LABEL_ZPL', target: 'label-printer:9100' },
  copies: 1,
  payload: { kind: 'ZPL', zpl: '^XA^XZ' },
})

describe('the fake print relay', () => {
  it('records each job once and answers the same relay id for a job submitted again', async () => {
    const relay = fakePrintRelay({ environment: 'test' })
    expect(await relay.submit(job('a'))).toEqual({ relayJobId: 'fake-1' })
    expect(await relay.submit(job('b'))).toEqual({ relayJobId: 'fake-2' })
    expect(await relay.submit(job('a'))).toEqual({ relayJobId: 'fake-1' })
    expect(relay.jobs.map((entry) => entry.job.jobId)).toEqual(['a', 'b'])
    expect(relay.attempts).toEqual(['a', 'b', 'a'])
  })

  it('fails the next submissions when asked, retryable or final', async () => {
    const relay = fakePrintRelay({ environment: 'test' })
    relay.failNext(1)
    relay.failNext(1, { message: 'Printer unknown.', retryable: false })
    await expect(relay.submit(job('a'))).rejects.toMatchObject({ name: 'RelayError', retryable: true })
    const final = await relay.submit(job('a')).catch((error: RelayError) => error)
    expect(final).toBeInstanceOf(RelayError)
    expect(final).toMatchObject({ message: 'Printer unknown.', retryable: false })
    expect(await relay.submit(job('a'))).toEqual({ relayJobId: 'fake-1' })
  })

  it('exists only in local and test runs', () => {
    expect(() => fakePrintRelay({ environment: 'production' })).toThrow(/local and test runs only/)
    expect(() => fakePrintRelay({ environment: 'staging' })).toThrow(/local and test runs only/)
  })
})
