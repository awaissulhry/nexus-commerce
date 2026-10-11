/**
 * Negative Targeting (2026-10-11, PLAN D2) — the kept-paused lock's rules, pure (waste/hold.ts): which writes it refuses,
 * who passes, the hold's state and its end, and what an Amazon-side ENABLED means. Made-up ids and dates.
 */
import { describe, expect, it } from 'vitest'
import { amazonOnVerdict, holdActive, holdData, holdOf, holdStateOf, holderWords, keepUntilOf, keptPausedRefusal, NO_HOLD, type HoldColumns } from './hold.js'

const NOW = new Date('2026-10-11T10:00:00Z')
const held = (extra: Partial<HoldColumns> = {}): HoldColumns => ({ keptPausedAt: new Date('2026-10-10T08:00:00Z'), keptPausedBy: 'user:u-owner', keptPausedUntil: null, keptPausedReason: 'spends with no orders', ...extra })
const turnOn = (over: Partial<Parameters<typeof keptPausedRefusal>[0]> = {}) =>
  keptPausedRefusal({ hold: held(), fromStatus: 'PAUSED', toStatus: 'ENABLED', person: false, release: false, actor: 'automation:rule-1', label: 'keyword "made up"', now: NOW, ...over })

describe('the hold', () => {
  it('holds while set and not past its end; always when no end', () => {
    expect(holdActive(held(), NOW)).toBe(true)
    expect(holdActive(held({ keptPausedUntil: new Date('2026-10-12T00:00:00Z') }), NOW)).toBe(true)
    expect(holdActive(held({ keptPausedUntil: new Date('2026-10-11T09:59:00Z') }), NOW)).toBe(false)
    expect(holdActive(NO_HOLD, NOW)).toBe(false)
    expect(holdActive(null, NOW)).toBe(false)
    expect(holdOf(held(), NOW)).toEqual({ at: held().keptPausedAt, by: 'user:u-owner', until: null, reason: 'spends with no orders' })
  })

  it('reads KEPT_PAUSED paused, TURNED_ON_ELSEWHERE when Amazon serves it, and never for a negative', () => {
    expect(holdStateOf({ ...held(), status: 'PAUSED' }, NOW)).toBe('KEPT_PAUSED')
    expect(holdStateOf({ ...held(), status: 'ENABLED' }, NOW)).toBe('TURNED_ON_ELSEWHERE')
    expect(holdStateOf({ ...NO_HOLD, status: 'PAUSED' }, NOW)).toBe('PAUSED')
    expect(holdStateOf({ ...NO_HOLD, status: 'ENABLED' }, NOW)).toBe('RUNNING')
    expect(holdStateOf({ ...held(), status: 'ARCHIVED' }, NOW)).toBe('ARCHIVED')
    expect(holdStateOf({ ...held(), status: 'PAUSED', isNegative: true }, NOW)).toBe('PAUSED')
    // An ended hold reads as a plain pause.
    expect(holdStateOf({ ...held({ keptPausedUntil: new Date('2026-10-01T00:00:00Z') }), status: 'PAUSED' }, NOW)).toBe('PAUSED')
  })

  it('names who holds it in plain words: You, a name, the Brain — never an id', () => {
    expect(holderWords('user:u-owner')).toBe('a person')
    expect(holderWords('user:u-owner', undefined, 'user:u-owner')).toBe('You')
    expect(holderWords('user:u-owner', new Map([['user:u-owner', 'Rita']]))).toBe('Rita')
    expect(holderWords('automation:ads-brain-negatives')).toBe('the Brain')
    expect(holderWords('automation:rule-1')).toBe('a rule')
    expect(holderWords('automation:rule-1', new Map([['automation:rule-1', 'Stop waste']]))).toBe('the rule "Stop waste"')
    expect(holderWords(null)).toBe('someone Nexus did not record')
  })

  it('a new hold: now, who, until (null = always), why trimmed', () => {
    expect(holdData('user:u-1', { until: null, reason: '  why  ' }, NOW)).toEqual({ keptPausedAt: NOW, keptPausedBy: 'user:u-1', keptPausedUntil: null, keptPausedReason: 'why' })
    expect(holdData('automation:rule-1', {}, NOW).keptPausedReason).toBeNull()
  })

  it('keepUntil: absent or null = always; a past or unreadable date is refused', () => {
    expect(keepUntilOf(null, NOW)).toEqual({ until: null })
    expect(keepUntilOf(undefined, NOW)).toEqual({ until: null })
    expect(keepUntilOf('2026-12-31', NOW)).toEqual({ until: new Date('2026-12-31T00:00:00Z') })
    expect(keepUntilOf('2026-10-01', NOW)).toMatchObject({ refusal: expect.stringMatching(/not in the future/) })
    expect(keepUntilOf('soon', NOW)).toMatchObject({ refusal: expect.stringMatching(/not a date/) })
  })
})

describe('the lock — a turn-on of a kept-paused keyword', () => {
  it('refuses every automatic writer, by name', () => {
    for (const actor of ['automation:rule-1', 'automation:ads-brain-state', 'automation:auto-bid', 'automation:ads-playbook-drift']) {
      const why = turnOn({ actor })!
      expect(why).toMatch(/^Kept paused by a person since 10 Oct, 10:00 \(Always · spends with no orders\)\./)
      expect(why).toMatch(/may not turn it on: only a person can, from Negative Targeting\. Nothing was sent\.$/)
      expect(why).not.toMatch(/user:|automation:|UTC|enable-ads|releaseKeep/)
    }
  })

  it('refuses a person\'s plain click (a bulk sheet, a campaign screen, an Undo of another change)', () => {
    expect(turnOn({ person: true, actor: 'user:u-2' })).toMatch(/Turning it on lets it spend: turn it on from Negative Targeting, or confirm the release\./)
    // The holder asking reads "You".
    expect(turnOn({ person: true, actor: 'user:u-owner' })).toMatch(/^Kept paused by You since/)
  })

  it('refuses a release that is not a person\'s (Claude by rule, an engine passing the flag)', () => {
    expect(turnOn({ person: false, release: true, actor: 'user:u-claude' })).toMatch(/This change cannot release it: only a person can\./)
  })

  it('lets a person who releases it pass', () => {
    expect(turnOn({ person: true, release: true, actor: 'user:u-owner' })).toBeNull()
  })

  it('judges only a turn-on: a pause, an archive, a bid and what Amazon already serves pass', () => {
    expect(turnOn({ toStatus: 'PAUSED' })).toBeNull()
    expect(turnOn({ toStatus: 'ARCHIVED' })).toBeNull()
    expect(turnOn({ toStatus: undefined })).toBeNull()
    expect(turnOn({ fromStatus: 'ENABLED' })).toBeNull()
  })

  it('never holds a negative, an ended hold or none', () => {
    expect(turnOn({ isNegative: true })).toBeNull()
    expect(turnOn({ hold: held({ keptPausedUntil: new Date('2026-10-11T09:00:00Z') }) })).toBeNull()
    expect(turnOn({ hold: NO_HOLD })).toBeNull()
  })
})

describe('Amazon reports a kept-paused keyword ENABLED', () => {
  it('pending pause: nothing; a pause that never landed: the hold ends; otherwise turned on elsewhere', () => {
    expect(amazonOnVerdict({ amazonResponseStatus: 'PENDING' })).toBe('pending')
    for (const s of ['SKIPPED', 'FAILED', 'CANCELLED', 'SUPERSEDED']) expect(amazonOnVerdict({ amazonResponseStatus: s })).toBe('refused_pause')
    expect(amazonOnVerdict({ amazonResponseStatus: 'SUCCESS' })).toBe('turned_on')
    // Kept while already paused (no pause of its own): someone switched it on.
    expect(amazonOnVerdict(null)).toBe('turned_on')
  })
})
