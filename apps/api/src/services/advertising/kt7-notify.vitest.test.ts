/**
 * KT.7 §4.3 — the digest's sentences, and the two defects reading the rendered subject caught.
 *
 * Pure rendering only; the send path is exercised for real against prod by `_kt7-digest.mts`, which
 * asserts the transport's own `dryRun`/recipient state rather than trusting that "it worked".
 */
import { describe, it, expect } from 'vitest'
import { renderKtDigest, kt7Thresholds, type Kt7DigestData } from './kt7-notify.service.js'

const base: Kt7DigestData = {
  since: new Date('2026-08-12T12:00:00Z'),
  until: new Date('2026-08-13T12:00:00Z'),
  applied: 0, appliedTargets: 0, appliedCommitCents: 0,
  refused: 0, reversed: 0, proposedOpen: 0,
  notable: [], thresholds: kt7Thresholds(), engineBidWrites: 859,
}

describe('renderKtDigest', () => {
  it('names the reversals in the SUBJECT — "0 applied" alone was true and misleading', () => {
    // Observed on prod: two changes were applied and then undone, and the subject read
    // "0 changes applied". An operator reading only the subject would conclude nothing happened.
    const s = renderKtDigest({ ...base, applied: 0, reversed: 2 })
    expect(s.subject).toContain('2 reversed')
    expect(s.subject).not.toMatch(/^Keyword Tracker — 0 changes applied/)
  })

  it('labels the WINDOW, not a single day — the 24h window straddles midnight', () => {
    const s = renderKtDigest({ ...base, applied: 1 })
    expect(s.subject).toContain('2026-08-12 12:00–2026-08-13 12:00 UTC')
    expect(s.subject).not.toMatch(/on 2026-08-12$/)
  })

  it('does not count a reversed change as applied', () => {
    const s = renderKtDigest({ ...base, applied: 0, reversed: 2 })
    expect(s.text).toContain('applied and then undone, so they are NOT counted above')
  })

  it('distinguishes a quiet window from a digest that could not tell', () => {
    const s = renderKtDigest(base)
    expect(s.subject).toContain('nothing was changed')
    expect(s.text).toContain('"nothing was asked of it", not "it could not tell"')
  })

  it('always prints the thresholds it judged with, and why percentage is not one', () => {
    const s = renderKtDigest({ ...base, applied: 3 })
    expect(s.text).toContain('Thresholds used:')
    expect(s.text).toContain('NEXUS_KT_BIG_')
    expect(s.text).toContain('percentage-change threshold is deliberately NOT used')
    expect(s.text).toContain('1,650%')
  })

  it('gives engine activity as context, so the page is not read as the only writer', () => {
    expect(renderKtDigest(base).text).toContain('automation made 859 keyword bid writes')
  })

  it('names each notable event with the threshold it crossed, never a bare "big"', () => {
    const s = renderKtDigest({
      ...base, applied: 1,
      notable: [{
        kind: 'applied', id: 'x', term: 'giacca moto', marketplace: 'IT', at: new Date(),
        targets: 39, campaigns: 14, commitCents: 2145, bidCents: 55,
        tripped: ['39 targets (≥ 20)', '14 campaigns (≥ 5)', 'commits €21.45 (≥ €11.58)'],
        text: 'Set the bid to €0.55 on 39 targets.',
      }],
    })
    expect(s.text).toContain('39 targets (≥ 20)')
    expect(s.text).toContain('commits €21.45 (≥ €11.58)')
    expect(s.text.toLowerCase()).not.toMatch(/\bbig\b/)
  })
})
