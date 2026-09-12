/**
 * PES.7 — the job log's readings. The fixtures below are the shapes actually measured on
 * GALE-JACKET's 78 jobs, including the two that contradict themselves.
 */
import { describe, expect, it } from 'vitest'

import { readJob, readReceipt, summariseJobs, type PublishJob } from './jobs'

const NOW = new Date('2026-09-01T12:00:00Z')

function job(over: Partial<PublishJob> = {}): PublishJob {
  return {
    id: 'j1',
    channel: 'AMAZON',
    marketplace: 'ES',
    status: 'IN_PROGRESS',
    submittedAt: '2026-06-10T22:24:32.816Z',
    completedAt: null,
    errorMessage: null,
    ...over,
  }
}

const line = (sku: string, accepted = true, errors: Array<{ code: string; message: string }> = []) =>
  ({ sku, asin: null, accepted, errors })

describe('readReceipt', () => {
  it('is null when the job carries no report', () => {
    expect(readReceipt(job())).toBeNull()
    expect(readReceipt(job({ perSku: [] }))).toBeNull()
  })

  it('folds rejections and counts each distinct reason', () => {
    const r = readReceipt(job({
      perSku: [
        line('A'),
        line('B', false, [{ code: 'X', message: 'Image too small' }]),
        line('C', false, [{ code: 'X', message: 'Image too small' }]),
        line('D', false, [{ code: 'Y', message: 'Bad aspect ratio' }]),
      ],
    }))!
    expect(r.lines).toBe(4)
    expect(r.rejected).toBe(3)
    expect(r.reasons).toEqual([
      { message: 'Image too small', count: 2 },
      { message: 'Bad aspect ratio', count: 1 },
    ])
  })

  it('still counts a rejection that arrived with no reason attached', () => {
    const r = readReceipt(job({ perSku: [line('A', false, [])] }))!
    expect(r.rejected).toBe(1)
    expect(r.reasons).toEqual([])
  })

  it('falls back to the error code when the message is blank', () => {
    const r = readReceipt(job({ perSku: [line('A', false, [{ code: 'CODE_ONLY', message: '  ' }])] }))!
    expect(r.reasons).toEqual([{ message: 'CODE_ONLY', count: 1 }])
  })
})

describe('readJob — the shapes measured on prod', () => {
  it('the 37: IN_PROGRESS, a finish time, and an all-accepted receipt', () => {
    const r = readJob(job({
      completedAt: '2026-07-06T12:06:10.908Z',
      perSku: Array.from({ length: 18 }, (_, i) => line(`SKU${i}`)),
    }), NOW)
    expect(r.state).toBe('endedNoRejections')
    expect(r.label).toBe('Ended')
    // The whole point: it must not read as a success.
    expect(r.note).toMatch(/evidence it finished rather than proof it published/)
    expect(r.label).not.toMatch(/complete|success|published/i)
  })

  it('the 6: DONE with no finish time and no report', () => {
    const r = readJob(job({ status: 'DONE', completedAt: null }), NOW)
    expect(r.state).toBe('done')
    expect(r.note).toMatch(/no per-SKU report was stored/)
  })

  it('a completed job explains itself with its own message when it has one', () => {
    const r = readJob(job({
      status: 'DONE', completedAt: null,
      errorMessage: 'No variants with ASINs + images found. Skipped no-ASIN: [], no-images: []',
    }), NOW)
    expect(r.state).toBe('done')
    expect(r.note).toMatch(/No variants with ASINs \+ images found/)
  })

  it('the two "ended" states do not share a label', () => {
    const withReceipt = readJob(job({ completedAt: '2026-07-06T12:06:10.908Z', perSku: [line('A')] }), NOW)
    const without = readJob(job({ completedAt: '2026-07-06T12:06:10.908Z' }), NOW)
    expect(withReceipt.label).not.toBe(without.label)
  })

  it('a named rejection outranks the status field', () => {
    const r = readJob(job({
      status: 'DONE',
      perSku: [line('A'), line('B', false, [{ code: 'E', message: 'Image too small' }])],
    }), NOW)
    expect(r.state).toBe('rejected')
    expect(r.label).toBe('1 of 2 rejected')
    expect(r.note).toBe('Image too small')
  })

  it('eBay FATAL carries its error through', () => {
    const r = readJob(job({
      channel: 'EBAY', status: 'FATAL', completedAt: '2026-07-20T10:00:00Z',
      errorMessage: 'eBay publish failed: inventory_item PUT 400',
    }), NOW)
    expect(r.state).toBe('failed')
    expect(r.note).toMatch(/inventory_item PUT 400/)
  })

  it('a finish time with no report is unknown, not success', () => {
    const r = readJob(job({ completedAt: '2026-07-06T12:06:10.908Z' }), NOW)
    expect(r.state).toBe('endedUnrecorded')
    expect(r.label).toBe('Ended, no report')
    expect(r.note).toMatch(/whether it succeeded is not recorded/)
  })

  it('old, running, nothing recorded → stalled, with the age spelled out', () => {
    const r = readJob(job(), NOW)
    expect(r.state).toBe('stalled')
    expect(r.note).toMatch(/83 days ago/)
  })

  it('recent and running is left alone', () => {
    const r = readJob(job({ submittedAt: '2026-09-01T11:30:00Z' }), NOW)
    expect(r.state).toBe('running')
    expect(r.label).toBe('In progress')
  })
})

describe('summariseJobs', () => {
  const fleet: PublishJob[] = [
    // 2 of the 37
    ...Array.from({ length: 2 }, (_, i) => job({
      id: `a${i}`, completedAt: '2026-07-06T12:06:10.908Z',
      perSku: Array.from({ length: 18 }, (_, k) => line(`S${k}`)),
    })),
    // 1 of the 6
    job({ id: 'b0', status: 'DONE', completedAt: null }),
    // an eBay failure
    job({ id: 'c0', channel: 'EBAY', status: 'FATAL', errorMessage: 'boom', completedAt: '2026-07-20T10:00:00Z' }),
    // a genuine rejection
    job({ id: 'd0', status: 'DONE', completedAt: '2026-07-20T10:00:00Z', perSku: [line('Z', false, [{ code: 'E', message: 'Image too small' }])] }),
  ]

  it('counts the states it actually found', () => {
    const s = summariseJobs(fleet, NOW)
    expect(s.total).toBe(5)
    expect(s.byState.endedNoRejections).toBe(2)
    expect(s.byState.done).toBe(1)
    expect(s.byState.failed).toBe(1)
    expect(s.byState.rejected).toBe(1)
  })

  it('separates "not recorded" from "the record disagrees with itself"', () => {
    const s = summariseJobs(fleet, NOW)
    // Nothing here is genuinely unknown — every row says something.
    expect(s.unknown).toBe(0)
    // The two receipts-with-stale-status, plus the DONE with no finish time.
    expect(s.contradictory).toBe(3)
  })

  it('totals SKU lines and rejections across receipts', () => {
    const s = summariseJobs(fleet, NOW)
    expect(s.skuLines).toBe(37)
    expect(s.skuRejected).toBe(1)
  })

  it('gathers failure reasons from job errors and receipts alike', () => {
    const s = summariseJobs(fleet, NOW)
    expect(s.failures).toEqual(expect.arrayContaining([
      { message: 'boom', count: 1 },
      { message: 'Image too small', count: 1 },
    ]))
  })

  it('an empty log summarises to zeroes rather than throwing', () => {
    const s = summariseJobs([], NOW)
    expect(s).toMatchObject({ total: 0, unknown: 0, contradictory: 0, skuLines: 0, skuRejected: 0 })
    expect(s.failures).toEqual([])
  })
})
