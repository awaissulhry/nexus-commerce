import { describe, expect, it } from 'vitest'
import type { HistoryRun, HistoryState } from '@nexus/shared/publication-history'
import { runStatusMeta } from './runActions'
import {
  accountLine, byText, checkedLine, durationText, finishedAnnouncement, productText, resultsText, rowAriaLabel, runColumnKeys,
} from './runColumns'

const counts = (over: Partial<HistoryRun['counts']> = {}): HistoryRun['counts'] => ({ accepted: 0, verified: 0, failed: 0, waiting: 0, notSent: 0, skipped: 0, unknown: 0, ...over })

const run = (over: Partial<HistoryRun> = {}): HistoryRun => ({
  id: 'r1', source: 'studio', batchId: null, startedAt: '2026-10-01T20:20:00Z', finishedAt: null, state: 'succeeded', status: 'VERIFIED',
  kind: 'update', productId: 'fam-1', familySku: 'GALE', familyTitle: 'Gale jacket', channel: 'EBAY', marketplace: 'IT', accountId: 'acc-1',
  accountLabel: 'Xavia Racing', aliasKey: '', aliasLabel: null, fieldCount: 3, productCount: 23, counts: counts({ verified: 23 }),
  userId: 'u1', userName: 'Dev Owner', reference: 'FEED-1', message: null, lastCheckedAt: null, needsCheck: false, checkedAt: null, checkedBy: null,
  ...over,
})

describe('the columns by scope and width', () => {
  it('a phone shows status, destination and started only', () => {
    expect(runColumnKeys('business', 'phone')).toEqual(['status', 'destination', 'started'])
    expect(runColumnKeys('product', 'phone')).toEqual(['status', 'destination', 'started'])
  })
  it('a product\'s own list has no Product column; the business list has it', () => {
    expect(runColumnKeys('product', 'desktop')).not.toContain('product')
    expect(runColumnKeys('business', 'desktop')).toContain('product')
  })
  it('the Source column is always on the desktop list (the Owner\'s D1: old uploads are marked by where they came from)', () => {
    expect(runColumnKeys('business', 'desktop')).toContain('source')
    expect(runColumnKeys('product', 'desktop')).toContain('source')
  })
})

describe('one word per state, the same as the detail', () => {
  const legacy = (state: HistoryState, status: string) => runStatusMeta(run({ source: 'ebay-flat-file', state, status }))

  it('older sources are labelled by their state, never by their raw status word', () => {
    expect(legacy('failed', 'FATAL')).toMatchObject({ label: 'Failed', tone: 'danger' })
    expect(legacy('succeeded', 'DONE')).toMatchObject({ label: 'Accepted', tone: 'info' })
    expect(legacy('partial', 'DONE')).toMatchObject({ label: 'Partly failed', tone: 'warning' })
    expect(legacy('needs_check', 'RUNNING')).toMatchObject({ label: 'Result unknown', tone: 'warning' })
    expect(legacy('in_progress', 'RUNNING')).toMatchObject({ label: 'Waiting for channel', tone: 'info' })
    for (const state of ['in_progress', 'succeeded', 'partial', 'failed', 'needs_check'] as HistoryState[])
      expect(legacy(state, 'FATAL').label).not.toMatch(/FATAL|DONE|RUNNING|POOL/)
  })

  it('a product sheet run keeps its own publish word; only Verified carries the check', () => {
    expect(runStatusMeta(run({ status: 'VERIFIED' }))).toMatchObject({ label: 'Verified', tone: 'success', glyph: 'check' })
    expect(runStatusMeta(run({ status: 'ACCEPTED' })).glyph).toBeUndefined()
  })

  it('a run marked as checked still has no result: "Result unknown", with who checked it underneath', () => {
    const checked = run({ state: 'needs_check', status: 'SUBMITTED', checkedAt: '2026-10-02T09:00:00Z', checkedBy: 'Dev Owner' })
    expect(runStatusMeta(checked).label).toBe('Result unknown')
    expect(checkedLine(checked)).toBe('Checked by Dev Owner')
    expect(checkedLine(run())).toBeNull()
    // The spoken row name keeps the person's own spelling.
    expect(rowAriaLabel(checked, Date.parse('2026-10-02T12:00:00Z'))).toContain('checked by Dev Owner')
  })
})

describe('cell words', () => {
  it('results hide zero parts and read in a fixed order', () => {
    expect(resultsText(counts({ accepted: 21, failed: 2, waiting: 1 }))).toBe('21 accepted · 2 failed · 1 waiting')
    expect(resultsText(counts({ verified: 11 }))).toBe('11 verified')
    expect(resultsText(counts())).toBe('—')
  })

  it('a duration only for a run that finished', () => {
    expect(durationText({ startedAt: '2026-10-01T20:20:00Z', finishedAt: '2026-10-01T20:21:04Z' })).toBe('1 min 4 s')
    expect(durationText({ startedAt: '2026-10-01T20:20:00Z', finishedAt: null })).toBe('')
  })

  it('account and alias on one line; the person or "Not recorded"; several families say so', () => {
    expect(accountLine({ accountLabel: 'Xavia Racing', aliasLabel: 'Second listing' })).toBe('Xavia Racing · Second listing')
    expect(accountLine({ accountLabel: null, aliasLabel: null })).toBe('')
    expect(byText({ userName: null })).toBe('Not recorded')
    expect(productText({ familySku: null, familyTitle: null })).toEqual({ sku: 'Several products', title: null })
  })
})

describe('screen reader', () => {
  it('a row is named by its status, destination, account, failures and start', () => {
    const label = rowAriaLabel(run({ state: 'partial', status: 'PARTIAL', counts: counts({ accepted: 21, failed: 2 }) }), Date.parse('2026-10-02T12:00:00Z'))
    expect(label).toMatch(/^Partly failed, eBay IT, Xavia Racing, 2 failed of 23, started /)
  })

  it('a finished run is announced in one sentence', () => {
    expect(finishedAnnouncement(run({ state: 'partial', counts: counts({ accepted: 21, failed: 2 }) }))).toBe('eBay IT publish finished: 21 accepted, 2 failed.')
    expect(finishedAnnouncement(run({ state: 'needs_check' }))).toMatch(/no confirmed result/)
  })
})

it('offers the channel reference on a desktop only (it starts hidden; Customise switches it on)', () => {
  expect(runColumnKeys('business', 'desktop')).toContain('reference')
  expect(runColumnKeys('business', 'phone')).not.toContain('reference')
})
