/**
 * PR 1d — the campaign-manager screens read every write's answer through one reader (CM-8, CM-10, CM-11, CM-26).
 * A 200 with `ok:false` is a refusal; the server's own reason is what the screen shows; an add counts as added only
 * when Amazon holds it (202 = saved in Nexus only).
 */
import { describe, expect, it } from 'vitest'
import { addSummary, eachSummary, readAdd, readWrite, reasonText } from './adsWrite'

describe('readWrite — a PATCH answer', () => {
  it('a 200 with ok:false is a refusal with the server\'s sentence (it used to read as saved)', () => {
    expect(readWrite(200, { ok: false, error: 'Not sent to Amazon: campaign c-1 is not on the live-write allowlist' }))
      .toEqual({ ok: false, outcome: 'refused', reason: 'Not sent to Amazon: campaign c-1 is not on the live-write allowlist' })
  })
  it('a placement block carries `reason`; a refused negative carries `refusal.reason`', () => {
    expect(readWrite(200, { ok: false, mode: 'blocked', reason: 'ads automation is stopped' }).reason).toBe('ads automation is stopped')
    expect(readWrite(403, { refusal: { deniedAt: 'keyword_protected', reason: 'a protected term' } }).reason).toBe('a protected term')
  })
  it('codes read as words; a crash is an error, not a refusal', () => {
    expect(readWrite(200, { ok: false, error: 'entity_orphaned' }).reason).toBe('Amazon no longer has this item, so nothing was sent.')
    expect(readWrite(400, { ok: false, error: 'bid_below_floor_5_cents' })).toMatchObject({ ok: false, outcome: 'refused' })
    expect(readWrite(500, { error: 'boom' })).toEqual({ ok: false, outcome: 'error', reason: 'boom' })
    expect(readWrite(502, {})).toEqual({ ok: false, outcome: 'error', reason: 'The server answered 502 without a reason.' })
  })
  it('queued vs applied, and "no changes" is fine', () => {
    expect(readWrite(200, { ok: true, outboundQueueId: 'q1', error: null })).toEqual({ ok: true, outcome: 'queued', reason: null })
    expect(readWrite(200, { ok: true, outboundQueueId: null, error: 'no_changes' })).toEqual({ ok: true, outcome: 'applied', reason: null })
  })
  it('reasonText', () => {
    expect(reasonText('  Amazon refused it: Bid too low ')).toBe('Amazon refused it: Bid too low')
    expect(reasonText(undefined)).toBe('No answer from the server.')
  })
})

describe('readAdd — an add counts only when Amazon holds it', () => {
  it('200 = added; 202 = saved in Nexus only; 403 / 502 = not added, with the reason', () => {
    expect(readAdd(200, { ok: true, outcome: 'created', id: 't1' })).toEqual({ added: true, savedOnly: false, reason: null })
    expect(readAdd(202, { ok: false, outcome: 'local', reason: 'The campaign is not on Amazon yet.' }))
      .toEqual({ added: false, savedOnly: true, reason: 'The campaign is not on Amazon yet.' })
    expect(readAdd(403, { ok: false, outcome: 'refused', reason: 'payload value 60000¢ exceeds cap 50000¢', error: 'payload value 60000¢ exceeds cap 50000¢' }))
      .toEqual({ added: false, savedOnly: false, reason: 'payload value 60000¢ exceeds cap 50000¢' })
    expect(readAdd(502, { error: 'amazon_rejected', reason: 'Amazon refused it: Duplicate keyword' }).reason).toBe('Amazon refused it: Duplicate keyword')
    expect(readAdd(502, { error: 'amazon_rejected' }).reason).toBe('Amazon refused it.')
  })
  it('an old-style 200 that carries an error or a refusal is not "added"', () => {
    expect(readAdd(200, { id: 't1', denied: { reason: 'x' }, error: 'gate' }).added).toBe(false)
    expect(readAdd(200, { refusal: { deniedAt: 'x', reason: 'refused' } })).toEqual({ added: false, savedOnly: false, reason: 'refused' })
  })
})

describe('summaries say what changed and why the rest did not', () => {
  it('eachSummary', () => {
    expect(eachSummary({ done: ['a', 'b'], queued: 2, failed: [] }, 'target'))
      .toEqual({ tone: 'success', text: '2 targets saved — Amazon gets the change in a few minutes' })
    expect(eachSummary({ done: ['a'], queued: 0, failed: [{ id: 'b', reason: 'Nexus refuses bids under 5 cents.' }, { id: 'c', reason: 'Nexus refuses bids under 5 cents.' }] }, 'target'))
      .toEqual({ tone: 'warning', text: '1 target saved · 2 targets not changed: Nexus refuses bids under 5 cents. (2×)' })
    expect(eachSummary({ done: [], queued: 0, failed: [{ id: 'b', reason: 'x' }, { id: 'c', reason: 'y' }] }, 'ad'))
      .toEqual({ tone: 'danger', text: '2 ads not changed: x · 1 for other reasons' })
  })
  it('addSummary', () => {
    const added = { added: true, savedOnly: false, reason: null }
    const refused = { added: false, savedOnly: false, reason: 'Amazon refused it: Duplicate keyword' }
    expect(addSummary([added, added], 'keyword')).toEqual({ allAdded: true, anyAdded: true, text: '2 keywords added on Amazon' })
    expect(addSummary([added, refused], 'keyword'))
      .toEqual({ allAdded: false, anyAdded: true, text: '1 keyword added on Amazon · 1 keyword not added: Amazon refused it: Duplicate keyword' })
    expect(addSummary([{ added: false, savedOnly: true, reason: 'not on Amazon yet' }], 'ad group'))
      .toEqual({ allAdded: false, anyAdded: true, text: '1 ad group saved in Nexus only: not on Amazon yet' })
  })
})
