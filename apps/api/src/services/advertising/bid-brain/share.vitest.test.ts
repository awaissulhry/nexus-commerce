/**
 * LANE 5 (2026-10-10) — the share layer's pure parts: the reading (grain, days, weighting, when it counts), the move toward
 * the target (D1 = A: raise below, lower above, hold within ±5 points), its caps, the words — and the words never call a
 * share anything but a share.
 *
 * Made-up numbers only (the repository is public).
 */
import { describe, expect, it } from 'vitest'
import {
  nextLastMove, readingWords, readLastMove, shareEvidence, shareMove, shareMoveApplied, sharePct, shareReadingOf, tosLaneCap,
  type ShareDay, type ShareFacts, type ShareMove,
} from './share.js'

const TODAY = '2026-10-10'
/** A keyword-grain day: its own share and impressions; the campaign's row beside it. */
const kwDay = (day: string, share: number | null, impressions: number, campaign: Partial<NonNullable<ShareDay['campaign']>> = {}): ShareDay => ({
  day, keyword: { impressions, share }, campaign: { impressions: impressions * 3, share: 0.5, capped: false, ...campaign },
})
/** A day the campaign served this keyword alone (its share is the keyword's), no keyword-grain share. */
const soloDay = (day: string, share: number, impressions: number, capped: boolean | null = false): ShareDay => ({
  day, keyword: { impressions, share: null }, campaign: { impressions, share, capped },
})
const NO_PLACE_WORDS = /rank|position/i

describe('the reading', () => {
  it('keyword grain: impression-weighted over the newest 7 reading days, the range and the impressions said', () => {
    const days = [kwDay('2026-10-01', 0.1, 100), kwDay('2026-10-07', 0.2, 300), kwDay('2026-10-08', 0.4, 100), kwDay('2026-10-09', null, 50)]
    const r = shareReadingOf(days, { today: TODAY })
    expect(r.held).toBeNull()
    // (10 % × 100 + 20 % × 300 + 40 % × 100) ÷ 500 = 22 %
    expect(r.reading).toEqual({ pct: expect.closeTo(22, 6), grain: 'keyword', days: 3, impressions: 500, from: '2026-10-01', to: '2026-10-08' })
    expect(readingWords(r.reading!)).toBe('top-of-search impression share 22% (computed by Nexus: the impression-weighted average of Amazon\'s daily shares, keyword grain, 3 reading days 2026-10-01 to 2026-10-08, 500 impressions)')
    const eight = Array.from({ length: 9 }, (_, i) => kwDay(`2026-10-0${i + 1}`, 0.3, 50))
    expect(shareReadingOf(eight, { today: TODAY }).reading).toMatchObject({ days: 7, from: '2026-10-03', to: '2026-10-09' })
  })

  it('no keyword-grain share: the campaign\'s, on single-target days only (the keyword holds ≥ 99 % of its impressions)', () => {
    const shared: ShareDay = { day: '2026-10-07', keyword: { impressions: 50, share: null }, campaign: { impressions: 400, share: 0.6, capped: false } }
    const r = shareReadingOf([shared, soloDay('2026-10-08', 0.3, 120), soloDay('2026-10-09', 0.1, 80)], { today: TODAY })
    expect(r.reading).toEqual({ pct: expect.closeTo(22, 6), grain: 'campaign', days: 2, impressions: 200, from: '2026-10-08', to: '2026-10-09' })
    expect(readingWords(r.reading!)).toMatch(/campaign grain, on days the campaign served this keyword alone, 2 reading days 2026-10-08 to 2026-10-09, 200 impressions/)
    // A campaign share on a day several keywords served is never this keyword's.
    expect(shareReadingOf([shared], { today: TODAY }).reading).toBeNull()
  })

  it('counts only after the last move: the reading days after its day; right after the move it waits', () => {
    const move: ShareMove = { moveDay: '2026-10-07', dataDay: '2026-10-05', readingTo: '2026-10-05', fromCents: 30, toCents: 33 }
    const days = [kwDay('2026-10-06', 0.1, 500), kwDay('2026-10-07', 0.1, 500), kwDay('2026-10-08', 0.3, 200)]
    const waiting = shareReadingOf(days, { today: TODAY, lastMove: move })
    expect(waiting).toMatchObject({ waiting: true, reading: { days: 1, from: '2026-10-08' } })
    expect(waiting.held).toBe('waits for 2 reading days after its share move on 2026-10-07 (30¢ → 33¢) (1 so far)')
    const counted = shareReadingOf([...days, kwDay('2026-10-09', 0.3, 200)], { today: TODAY, lastMove: move })
    expect(counted).toMatchObject({ held: null, waiting: false, reading: { days: 2, from: '2026-10-08', to: '2026-10-09', pct: expect.closeTo(30, 6) } })
    // A move older than the wait: no longer a wait — the reading's own gates say why it does not count.
    const old: ShareMove = { ...move, moveDay: '2026-10-01' }
    expect(shareReadingOf([kwDay('2026-10-02', 0.3, 300)], { today: TODAY, lastMove: old })).toMatchObject({ waiting: false, held: expect.stringMatching(/the newest reading day 2026-10-02 is 8 days old \(at most 4\)/) })
  })

  it('moves nothing on a stale, thin or budget-capped reading, or with none — and says why', () => {
    expect(shareReadingOf([kwDay('2026-10-04', 0.2, 300), kwDay('2026-10-05', 0.2, 300)], { today: TODAY }).held).toBe('the newest reading day 2026-10-05 is 5 days old (at most 4)')
    expect(shareReadingOf([kwDay('2026-10-09', 0.2, 300)], { today: TODAY }).held).toBe('1 reading day — it needs 2')
    expect(shareReadingOf([kwDay('2026-10-08', 0.2, 40), kwDay('2026-10-09', 0.2, 40)], { today: TODAY }).held).toBe('80 impressions over the reading days — it needs 100')
    expect(shareReadingOf([kwDay('2026-10-08', 0.2, 300, { capped: true }), kwDay('2026-10-09', 0.2, 300)], { today: TODAY }).held)
      .toBe('the campaign spent at least 95 % of its budget on 2026-10-08: the budget, not the bid, held the share')
    const none = shareReadingOf([kwDay('2026-10-09', null, 300)], { today: TODAY })
    expect(none).toMatchObject({ reading: null, waiting: false })
    expect(none.held).toBe('no top-of-search impression share reading — none at keyword grain, nor at campaign grain on a day the campaign served this keyword alone, in the 14 days 2026-09-26 to 2026-10-09')
    // Today is never a reading day (not finished).
    expect(shareReadingOf([kwDay(TODAY, 0.2, 300)], { today: TODAY }).reading).toBeNull()
  })
})

describe('the move (D1 = A)', () => {
  const caps = [{ cents: 40, from: 'the bid where the expected ACoS meets the band top 28%' }, { cents: 80, from: 'the strategy highest bid' }]
  it('below target − 5 points: one step up, at most 10 % (or the strategy\'s smaller largest change)', () => {
    expect(shareMove({ currentCents: 30, reading: { pct: 20 }, targetPct: 40, maxChangePct: 25, caps, floorCents: 5 })).toEqual({ dir: 'raise', cents: 33, stepPct: 10, capped: null })
    expect(shareMove({ currentCents: 30, reading: { pct: 20 }, targetPct: 40, maxChangePct: 5, caps, floorCents: 5 })).toMatchObject({ dir: 'raise', cents: 32, stepPct: 5 })
    // A small bid still moves by a cent.
    expect(shareMove({ currentCents: 6, reading: { pct: 20 }, targetPct: 40, maxChangePct: 25, caps, floorCents: 5 })).toMatchObject({ dir: 'raise', cents: 7 })
  })
  it('held to the lowest cap; at the cap it holds and names it', () => {
    expect(shareMove({ currentCents: 38, reading: { pct: 20 }, targetPct: 40, maxChangePct: 25, caps, floorCents: 5 })).toEqual({ dir: 'raise', cents: 40, stepPct: 10, capped: caps[0] })
    expect(shareMove({ currentCents: 40, reading: { pct: 20 }, targetPct: 40, maxChangePct: 25, caps, floorCents: 5 })).toEqual({ dir: 'hold', cents: 40, stepPct: 10, why: 'at_cap', capped: caps[0] })
  })
  it('above target + 5 points: one step down, never below the floor; within ±5 points: hold', () => {
    expect(shareMove({ currentCents: 30, reading: { pct: 60 }, targetPct: 40, maxChangePct: 25, caps, floorCents: 5 })).toEqual({ dir: 'lower', cents: 27, stepPct: 10, capped: null })
    expect(shareMove({ currentCents: 6, reading: { pct: 60 }, targetPct: 40, maxChangePct: 25, caps, floorCents: 6 })).toMatchObject({ dir: 'hold', why: 'at_floor' })
    for (const pct of [35, 40, 45]) expect(shareMove({ currentCents: 30, reading: { pct }, targetPct: 40, maxChangePct: 25, caps, floorCents: 5 })).toMatchObject({ dir: 'hold', why: 'dead_zone', cents: 30 })
  })
  it('the top-of-search lane cap: its CPC ceiling ÷ ((1 + plan %) × dynamic bidding)', () => {
    expect(tosLaneCap([{ lane: 'TOP_OF_SEARCH', planPct: 50, maxCpcCents: 90, dynamic: 2 }])).toEqual({ cents: 30, from: 'the top-of-search CPC ceiling 90¢ ÷ (1 + 50 % placement) ÷ ×2 Amazon dynamic bidding' })
    expect(tosLaneCap([{ lane: 'PRODUCT_PAGE', planPct: 0, maxCpcCents: 90 }])).toBeNull()
    expect(tosLaneCap([{ lane: 'TOP_OF_SEARCH', planPct: 0, maxCpcCents: null }])).toBeNull()
  })
})

describe('words and memory', () => {
  it('a tiny share is "<0.01%", never "0.00%"; one reading day is Amazon\'s own value', () => {
    expect(sharePct(0.004)).toBe('<0.01%')
    expect(sharePct(0.5)).toBe('0.5%')
    expect(sharePct(0)).toBe('0%')
    expect(sharePct(37.25)).toBe('37.3%')
    expect(readingWords({ pct: 12, grain: 'keyword', days: 1, impressions: 1500, from: '2026-10-09', to: '2026-10-09' }))
      .toBe('top-of-search impression share 12% (Amazon\'s, keyword grain, 1 reading day 2026-10-09, 1,500 impressions)')
  })

  it('a share write is the new last move (the run\'s day); anything else keeps the previous one', () => {
    const share: ShareFacts = { targetPct: 40, targetBy: 'the Owner\'s keyword override', reading: { pct: 20, grain: 'keyword', days: 2, impressions: 300, from: '2026-10-08', to: '2026-10-09' }, held: null, waiting: false, lastMove: null }
    const write = { layer: 'share', action: 'write', currentCents: 30, bidCents: 33, dataDay: '2026-10-08' }
    expect(nextLastMove(write, share, TODAY)).toEqual({ moveDay: TODAY, dataDay: '2026-10-08', readingTo: '2026-10-09', fromCents: 30, toCents: 33 })
    expect(nextLastMove({ ...write, action: 'hold', bidCents: 30 }, share, TODAY)).toBeNull()
    expect(nextLastMove({ ...write, layer: 'goal' }, share, TODAY)).toBeNull()
    const ev = shareEvidence(write, share, TODAY)
    expect(readLastMove(JSON.parse(JSON.stringify(ev)).lastMove)).toEqual(ev.lastMove)
    expect(readLastMove({ moveDay: 'yesterday', fromCents: 1, toCents: 2 })).toBeNull()
  })

  it('review fix — a LIVE share write the gate, dial, caps or kill switch kept back is no move: the previous one stays', () => {
    const previous: ShareMove = { moveDay: '2026-10-07', dataDay: '2026-10-05', readingTo: '2026-10-05', fromCents: 27, toCents: 30 }
    const share: ShareFacts = { targetPct: 40, targetBy: 'the Owner\'s keyword override', reading: { pct: 20, grain: 'keyword', days: 2, impressions: 300, from: '2026-10-08', to: '2026-10-09' }, held: null, waiting: false, lastMove: previous }
    const write = { layer: 'share', action: 'write', currentCents: 30, bidCents: 33, dataDay: '2026-10-08' }
    // A shadow campaign records its move (nothing is sent in shadow); a LIVE one only when its write was queued.
    expect(shareMoveApplied(false, undefined)).toBe(true)
    expect(shareMoveApplied(true, { sent: 'queued' })).toBe(true)
    for (const sent of ['refused', 'deferred', 'would-apply', 'unchanged']) expect(shareMoveApplied(true, { sent })).toBe(false)
    expect(shareMoveApplied(true, undefined)).toBe(false)
    expect(shareEvidence(write, share, TODAY, false).lastMove).toEqual(previous)
    expect(shareEvidence(write, share, TODAY, true).lastMove).toMatchObject({ moveDay: TODAY, fromCents: 30, toCents: 33 })
  })

  it('no line of the reading ever calls a share a rank or a position', () => {
    const lines: string[] = []
    const move: ShareMove = { moveDay: '2026-10-07', dataDay: '2026-10-05', readingTo: '2026-10-05', fromCents: 30, toCents: 33 }
    for (const days of [[], [kwDay('2026-10-09', 0.2, 300)], [kwDay('2026-10-08', 0.2, 30), kwDay('2026-10-09', 0.2, 30)], [kwDay('2026-10-01', 0.2, 300)], [soloDay('2026-10-08', 0.3, 300, true), soloDay('2026-10-09', 0.3, 300)]]) {
      for (const lastMove of [null, move]) {
        const r = shareReadingOf(days, { today: TODAY, lastMove })
        if (r.held) lines.push(r.held)
        if (r.reading) lines.push(readingWords(r.reading))
      }
    }
    expect(lines.length).toBeGreaterThan(5)
    for (const l of lines) expect(l).not.toMatch(NO_PLACE_WORDS)
  })
})
