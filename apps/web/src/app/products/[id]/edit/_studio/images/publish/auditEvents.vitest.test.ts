/**
 * PES.7 — audit-trail readings. Fixtures are the exact metadata shapes measured on prod.
 */
import { describe, expect, it } from 'vitest'

import { failureHeadline, readAuditEntry, summariseAudit, type AuditEntry } from './auditEvents'

const started = (over: Partial<Record<string, unknown>> = {}): AuditEntry => ({
  id: 'a1', action: 'imagePublishStarted', createdAt: '2026-06-10T22:24:33.956Z', userId: null,
  metadata: {
    jobId: 'cmq8mz67j0j29ms01j6ixyojx', dryRun: false, feedId: '105489020614', forced: false,
    channel: 'AMAZON', skuCount: 18, marketplace: 'ES', ...over,
  },
})

const failed = (error: string): AuditEntry => ({
  id: `f${error.length}`, action: 'imagePublishFailed', createdAt: '2026-07-20T10:00:00.000Z',
  userId: null,
  metadata: { error, channel: 'EBAY', marketplace: null, pictureCount: 0, colorSetCount: 0 },
})

const completed = (): AuditEntry => ({
  id: 'c1', action: 'imagePublishCompleted', createdAt: '2026-07-26T10:00:00.000Z', userId: null,
  metadata: { channel: 'EBAY', marketplace: null, pictureCount: 12, colorSetCount: 3 },
})

describe('readAuditEntry', () => {
  it('reads an Amazon start, job id and all', () => {
    const e = readAuditEntry(started())
    expect(e.kind).toBe('started')
    expect(e.label).toBe('Submitted')
    expect(e.facts).toBe('18 SKUs')
    expect(e.channel).toBe('AMAZON')
    expect(e.jobId).toBe('cmq8mz67j0j29ms01j6ixyojx')
    // The feed id is the value the job row also stores, so the Amazon half stays matchable by eye.
    expect(e.reference).toBe('105489020614')
    expect(e.dryRun).toBe(false)
  })

  it('never lets a dry run read as a send', () => {
    const e = readAuditEntry(started({ dryRun: true }))
    expect(e.dryRun).toBe(true)
    expect(e.facts).toMatch(/nothing was sent to the channel/)
  })

  it('a start says submitted, never published', () => {
    expect(readAuditEntry(started()).label).not.toMatch(/publish|complete|success/i)
  })

  it('the pill is a word, never the raw kind', () => {
    for (const [action, pill] of [
      ['imagePublishStarted', 'Submitted'], ['imagePublishCompleted', 'Complete'],
      ['imagePublishFailed', 'Failed'], ['imagePublishBulk', 'Bulk'], ['whateverElse', 'Recorded'],
    ] as const) {
      const e = readAuditEntry({ id: action, action, createdAt: '2026-01-01T00:00:00Z', userId: null, metadata: {} })
      expect(e.label).toBe(pill)
      expect(e.label).not.toBe(e.kind)
    }
  })

  it('reads an eBay outcome, which carries no job id', () => {
    const e = readAuditEntry(completed())
    expect(e.kind).toBe('completed')
    expect(e.label).toBe('Complete')
    expect(e.facts).toBe('12 pictures · 3 colour sets')
    expect(e.jobId).toBeNull()
    expect(e.reference).toBeNull()
  })

  it('carries the failure text through', () => {
    const e = readAuditEntry(failed('eBay publish failed: No IT price set'))
    expect(e.kind).toBe('failed')
    expect(e.detail).toBe('eBay publish failed: No IT price set')
  })

  it('survives null metadata and an unknown action', () => {
    const e = readAuditEntry({ id: 'x', action: 'somethingElse', createdAt: '2026-01-01T00:00:00Z', userId: null, metadata: null })
    expect(e.kind).toBe('other')
    expect(e.channel).toBeNull()
    expect(e.label).toBe('Recorded')
    expect(e.facts).toBeNull()
  })

  it('ignores a non-numeric skuCount rather than printing it', () => {
    expect(readAuditEntry(started({ skuCount: 'lots' })).facts).toBeNull()
  })

  it('omits a zero colour-set count instead of printing "0 colour sets"', () => {
    const e = readAuditEntry(failed('boom'))
    expect(e.facts).toBe('0 pictures')
  })
})

describe('summariseAudit — the join gap', () => {
  const trail = [started(), started(), completed(), failed('boom'), failed('boom'), failed('other')]

  it('names the channel that starts but never finishes', () => {
    const s = summariseAudit(trail)
    expect(s.channelsMissingOutcomes).toEqual(['AMAZON'])
  })

  it('names the channel that finishes but never starts', () => {
    const s = summariseAudit(trail)
    expect(s.channelsMissingStarts).toEqual(['EBAY'])
  })

  it('counts outcomes that cannot be tied to any job', () => {
    // All four eBay outcomes lack a jobId — that is the whole reason the logs cannot be joined.
    expect(summariseAudit(trail).unattributableOutcomes).toBe(4)
  })

  it('groups repeated failures instead of listing them twice', () => {
    expect(summariseAudit(trail).failures).toEqual([
      { message: 'boom', count: 2 },
      { message: 'other', count: 1 },
    ])
  })

  it('counts dry runs separately from real sends', () => {
    expect(summariseAudit([started(), started({ dryRun: true })]).dryRuns).toBe(1)
  })

  it('reports no gap when a channel logs both halves', () => {
    const s = summariseAudit([started({ channel: 'EBAY' }), completed()])
    expect(s.channelsMissingOutcomes).toEqual([])
    expect(s.channelsMissingStarts).toEqual([])
  })

  it('an empty trail summarises to zeroes', () => {
    const s = summariseAudit([])
    expect(s).toMatchObject({ total: 0, unattributableOutcomes: 0, dryRuns: 0 })
    expect(s.channelsMissingOutcomes).toEqual([])
  })
})

describe('failureHeadline', () => {
  it('cuts an embedded JSON body off the sentence', () => {
    const raw = 'eBay publish failed: inventory_item PUT 400 (we sent quantity=12): {"errors":[{"errorId":25718}]}'
    expect(failureHeadline(raw)).toBe('eBay publish failed: inventory_item PUT 400 (we sent quantity=12)…')
  })

  it('leaves a plain sentence alone', () => {
    const raw = 'eBay publish failed: No IT price set for GALE-JACKET-BLACK-MEN-XXS'
    expect(failureHeadline(raw)).toBe(raw)
  })
})
