/**
 * Negative Targeting page, step 4 — the pure half of protect.ts and the Protected tile's filter
 * (pure.ts isKeptSafe, showMatches, totalsOf). Made-up words.
 */
import { describe, expect, it } from 'vitest'
import { protectedTermRefusal } from '../ads-negation-policy.js'
import {
  alsoKeepsOf, ALSO_KEEPS_SHOWN, isUnprotectArgs, linkRemovals, linksOf, protectionsHolding, protectionsInScope, refusedOnlyByRemoved,
  rowProtectionOf, unprotectRequest, type Protection,
} from './protect.js'
import { isKeptSafe, showMatches, totalsOf, type WasteRow } from './pure.js'
import type { StepOut, WasteItem } from './write.js'

const P = (id: string, term: string, extra: Partial<Protection> = {}): Protection => ({ id, term, matchType: 'EXACT', isPrefix: false, reason: null, marketplace: null, market: null, campaignId: null, ...extra })

describe('which protected terms hold a row', () => {
  const list = [
    P('p-contains', 'rain', { matchType: 'CONTAINS', marketplace: 'IT', market: 'IT' }),
    P('p-exact', 'rain jacket'),
    P('p-prefix', 'storm', { matchType: 'PREFIX', campaignId: 'c-1' }),
    P('p-de', 'rain jacket', { marketplace: 'DE', market: 'DE' }),
  ]
  it('the scope: its market or every market, its campaign or every campaign', () => {
    expect(protectionsInScope(list, 'IT', 'c-1').map((p) => p.id)).toEqual(['p-contains', 'p-exact', 'p-prefix'])
    expect(protectionsInScope(list, 'DE', 'c-2').map((p) => p.id)).toEqual(['p-exact', 'p-de'])
  })
  it('every term that holds the words, in order (the first is the one the page names); match types bind as the policy does', () => {
    expect(protectionsHolding(list, 'Rain  Jacket', true).map((p) => p.id)).toEqual(['p-contains', 'p-exact', 'p-de'])
    expect(protectionsHolding(list, 'storm boots', false).map((p) => p.id)).toEqual(['p-prefix'])
    expect(protectionsHolding(list, 'boots storm', false)).toEqual([])
  })
  it('the row shows each term with its match, market, campaign (named from the facts) and why in plain words', () => {
    const f = { campaigns: new Map([['c-1', { name: 'Test summer' }]]) } as never
    const view = rowProtectionOf(f, [list[0], list[2]], { label: 'New place', reason: 'too young' })
    expect(view).toEqual({
      terms: [
        { id: 'p-contains', term: 'rain', match: 'CONTAINS', market: 'IT', campaign: null, reason: null },
        { id: 'p-prefix', term: 'storm', match: 'PREFIX', market: null, campaign: { id: 'c-1', name: 'Test summer', href: '/marketing/ads/campaigns/c-1' }, reason: null },
      ],
      then: { label: 'New place', reason: 'too young' },
    })
  })
})

describe('what else a protected term keeps safe', () => {
  const row = (text: string, met: boolean, ids: string[], extra: Partial<WasteRow> = {}) => ({
    text, kind: 'TERM' as const, test: { met } as WasteRow['test'], protection: { terms: ids.map((id) => ({ id })) as never, then: null }, ...extra,
  })
  it('one line per words over the rows it holds, the row\'s own left out; wasting first, then places', () => {
    const rows = [
      row('rain jacket', true, ['p']), row('rain hat', false, ['p']), row('Rain  Hat', false, ['p']), row('rain boots', true, ['p']),
      row('rain coat', true, ['q']), row('rain cap', true, ['p'], { askOnly: true }),
    ]
    expect(alsoKeepsOf(rows, 'p', new Set(['rain jacket']))).toEqual({
      count: 2,
      terms: [{ text: 'rain boots', kind: 'TERM', places: 1, wasting: true }, { text: 'rain hat', kind: 'TERM', places: 2, wasting: false }],
    })
  })
  it('the list is capped, the count is all of them', () => {
    const rows = Array.from({ length: ALSO_KEEPS_SHOWN + 5 }, (_, i) => row(`rain ${i}`, false, ['p']))
    const out = alsoKeepsOf(rows, 'p', new Set())
    expect([out.count, out.terms.length]).toEqual([ALSO_KEEPS_SHOWN + 5, ALSO_KEEPS_SHOWN])
  })
})

describe('the removal and the stop after it', () => {
  it('the request is Claude\'s guardrail tool, keyed as the term is stored', () => {
    expect(unprotectRequest({ term: ' Rain  Jacket ', marketplace: 'IT', campaignId: null })).toEqual({ tool: 'set-ad-guardrail', args: { kind: 'protected-term', op: 'remove', term: 'rain jacket', marketplace: 'IT' } })
    expect(isUnprotectArgs('set-ad-guardrail', { kind: 'protected-term', op: 'remove' })).toBe(true)
    expect(isUnprotectArgs('set-ad-guardrail', { kind: 'protected-term', op: 'set' })).toBe(false)
    expect(isUnprotectArgs('set-ad-guardrail', { kind: 'spend-ceiling', op: 'remove' })).toBe(false)
  })
  it('a stop waits only when its tool refused it for a term being removed, and every term holding it goes', () => {
    const p = { term: 'rain', matchType: 'CONTAINS', reason: 'our brand' }
    const error = `Not queued: ${protectedTermRefusal('rain hat', { protection: p, via: 'text' })}`
    expect(refusedOnlyByRemoved(error, 'rain hat', [p], ['a'], ['a'])).toBe(true)
    // Another term still holds it: removing this one would not let it go.
    expect(refusedOnlyByRemoved(error, 'rain hat', [p], ['a', 'b'], ['a'])).toBe(false)
    // Something else refused it (Amazon's text limits come before the protection): left out, in the tool's words.
    expect(refusedOnlyByRemoved('Not queued: "rain hat" has 81 characters', 'rain hat', [p], ['a'], ['a'])).toBe(false)
  })
  const ok = (action: WasteItem['action']): StepOut => ({ step: { action, refusal: null } as never, request: { tool: 't', args: {} }, basis: null })
  const no = (action: WasteItem['action'], code: string): StepOut => ({ step: { action, refusal: { code, label: `${code}.` } } as never, request: null, basis: null })
  it('a stop is linked to the removals of its own row, or of a term that holds it (one removal for many rows in bulk)', () => {
    const holding: Record<string, string[]> = { 'kw:k1': ['a'], 'kw:k2': ['a', 'b'], 'kw:k3': [], 'kw:k4': ['b'] }
    const items: WasteItem[] = [
      { rowId: 'kw:k1', action: 'UNPROTECT', protectionId: 'a' }, { rowId: 'kw:k2', action: 'UNPROTECT', protectionId: 'b' },
      { rowId: 'kw:k4', action: 'UNPROTECT', protectionId: 'b' }, { rowId: 'kw:k5', action: 'UNPROTECT' },
      { rowId: 'kw:k1', action: 'PAUSE' }, { rowId: 'kw:k2', action: 'PAUSE' }, { rowId: 'kw:k3', action: 'PAUSE' }, { rowId: 'kw:k4', action: 'PAUSE' }, { rowId: 'kw:k5', action: 'PAUSE' },
    ]
    // The second removal of "b" is refused as named twice: every stop links to its first.
    expect([...linksOf(items, (r) => holding[r] ?? [])]).toEqual([[4, [0]], [5, [0, 1]], [7, [1]], [8, [3]]])
  })
  it('a removal left out leaves its stops out; a removal is left out only when every stop it holds back is', () => {
    const links = new Map([[2, [0]], [3, [0, 1]], [4, [1]]])
    const out = [ok('UNPROTECT'), no('UNPROTECT', 'forbidden'), ok('PAUSE'), ok('PAUSE'), no('PAUSE', 'refused')]
    linkRemovals(out, links)
    expect(out.map((o) => o.step.refusal?.code ?? null)).toEqual([null, 'forbidden', null, 'needs_unprotect', 'refused'])
    expect(out[3].step.refusal!.label).toMatch(/The protection stays \(its removal is left out: forbidden\)/)
    // Every stop "a" holds back is left out: "a" stays as it is.
    const all = [ok('UNPROTECT'), no('PAUSE', 'refused'), no('PAUSE', 'refused')]
    linkRemovals(all, new Map([[1, [0]], [2, [0]]]))
    expect(all[0]).toMatchObject({ request: null, step: { refusal: { code: 'stop_left_out', label: expect.stringMatching(/^Every stop it holds back is left out/) } } })
    // A term already removed (not_protected) does not hold its stop back.
    const done = [no('UNPROTECT', 'not_protected'), ok('PAUSE')]
    linkRemovals(done, new Map([[1, [0]]]))
    expect(done.map((o) => o.step.refusal?.code ?? null)).toEqual(['not_protected', null])
  })
})

describe('the follow-up: what it sends and what a row says', () => {
  it('the removals and the stops that wait for them; a row reads waiting, then not stopped and why (sent: nothing)', async () => {
    const { followUpItems, rowFollowUp } = await import('./follow-up.js')
    const items: WasteItem[] = [{ rowId: 'term:a', action: 'UNPROTECT', protectionId: 'p' }, { rowId: 'kw:k', action: 'PAUSE' }, { rowId: 'term:a', action: 'NEGATE_EXACT' }]
    expect(followUpItems(items, new Set([2]))).toEqual([items[0], items[2]])
    const base = { approvalId: 'cs', changeSetId: null, rowIds: ['term:a', 'term:b'], results: [], why: null, createdAt: '2026-10-25T10:00:00.000Z', endedAt: null }
    expect(rowFollowUp([{ ...base, status: 'WAITING' }], 'term:a')).toMatchObject({ status: 'WAITING' })
    expect(rowFollowUp([{ ...base, status: 'REFUSED', why: 'the protection was not removed' }], 'term:b')).toMatchObject({ status: 'REFUSED', why: 'the protection was not removed' })
    const part = { ...base, status: 'SENT' as const, results: [{ rowId: 'term:a', sent: true, why: null }, { rowId: 'term:b', sent: false, why: 'already negated' }] }
    expect([rowFollowUp([part], 'term:a'), rowFollowUp([part], 'term:b')]).toEqual([null, { status: 'REFUSED', why: 'already negated', at: base.createdAt }])
    expect(rowFollowUp([{ ...base, status: 'CANCELLED' }], 'term:a')).toBeNull()
    expect(rowFollowUp([{ ...base, status: 'WAITING' }], 'term:c')).toBeNull()
  })
})

describe('the Protected tile: one number, one list', () => {
  const base = { test: { met: true } as WasteRow['test'], skipped: null, currency: 'EUR', kind: 'TERM', d: { spendCents: 100 }, via: null, waiting: null, clash: null, id: 'x' } as unknown as WasteRow
  const rows: WasteRow[] = [
    { ...base, id: 'a', state: 'PROTECTED' },
    { ...base, id: 'b', state: 'PROTECTED', skipped: { until: '2099-01-01', by: null, at: null } },
    { ...base, id: 'c', state: 'PROTECTED', test: { met: false } as WasteRow['test'] },
    { ...base, id: 'd', state: 'RUNNING' },
  ]
  it('show=protected: the test met, PROTECTED, not skipped — and totals.protected counts exactly those', () => {
    expect(rows.filter(isKeptSafe).map((r) => r.id)).toEqual(['a'])
    expect(rows.filter((r) => showMatches(r, 'protected')).map((r) => r.id)).toEqual(['a'])
    expect(totalsOf(rows, 'protected', { negated: 0 })).toMatchObject({ protected: 1, wasting: 2, skipped: 1, terms: 1 })
  })
})
