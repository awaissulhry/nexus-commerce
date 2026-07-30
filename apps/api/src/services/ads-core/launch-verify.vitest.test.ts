import { describe, it, expect } from 'vitest'
import { verifyEntity, summarise, describeVerdict, type EntityPair } from './launch-verify.js'

const pair = (over: Partial<EntityPair> = {}): EntityPair => ({
  entityType: 'CAMPAIGN', localId: 'c1', externalId: 'AMZ1', label: 'Test campaign',
  intended: { name: 'Test campaign', state: 'ENABLED' },
  observed: { name: 'Test campaign', state: 'ENABLED' },
  ...over,
})

describe('AX-VT.4 — intended vs observed', () => {
  it('VERIFIED when every specified field agrees', () => {
    const r = verifyEntity(pair())
    expect(r.verdict).toBe('VERIFIED')
    expect(r.deltas).toEqual([])
  })

  it('ignores formatting differences, reusing the drift comparison rule', () => {
    // "20" vs "20.00" and ENABLED vs enabled must never read as a mismatch.
    const r = verifyEntity(pair({
      intended: { dailyBudget: 20, state: 'ENABLED' },
      observed: { dailyBudget: '20.00', state: 'enabled' },
    }))
    expect(r.verdict).toBe('VERIFIED')
  })

  it('MISMATCH names the field, what was asked and what Amazon has', () => {
    const r = verifyEntity(pair({
      intended: { name: 'A', dailyBudget: 50 },
      observed: { name: 'A', dailyBudget: 10 },
    }))
    expect(r.verdict).toBe('MISMATCH')
    expect(r.deltas).toEqual([{ field: 'dailyBudget', intended: '50', observed: '10' }])
  })

  it('NOT_PUSHED when we hold no external id — the create never happened', () => {
    const r = verifyEntity(pair({ externalId: null }))
    expect(r.verdict).toBe('NOT_PUSHED')
    expect(describeVerdict(r)).toContain('never reached Amazon')
  })

  it('MISSING_ON_AMAZON when we hold an id Amazon does not return', () => {
    // Distinct from NOT_PUSHED: this one will not fix itself by pushing again.
    const r = verifyEntity(pair({ observed: undefined }))
    expect(r.verdict).toBe('MISSING_ON_AMAZON')
    expect(describeVerdict(r)).toContain('will not fix itself')
  })

  it('skips a field Amazon did not report rather than calling it a mismatch', () => {
    // A partial response must never look like Amazon blanking a value.
    const r = verifyEntity(pair({
      intended: { name: 'A', targetingType: 'MANUAL' },
      observed: { name: 'A' },
    }))
    expect(r.verdict).toBe('VERIFIED')
  })

  it('skips a field we never specified', () => {
    const r = verifyEntity(pair({
      intended: { name: 'A', portfolioId: null },
      observed: { name: 'A', portfolioId: '999' },
    }))
    expect(r.verdict).toBe('VERIFIED')
  })

  it('reports an explicit null ONLY for opted-in fields — the portfolio case', () => {
    // This is the exact 2026-07-30 defect: we asked for a portfolio, Amazon has none.
    const withOptIn = verifyEntity(pair({
      intended: { portfolioId: '190601227863497' },
      observed: { portfolioId: null },
    }), ['portfolioId'])
    expect(withOptIn.verdict).toBe('MISMATCH')
    expect(withOptIn.deltas).toEqual([{ field: 'portfolioId', intended: '190601227863497', observed: null }])
    expect(describeVerdict(withOptIn)).toContain('portfolioId is empty')

    const withoutOptIn = verifyEntity(pair({
      intended: { portfolioId: '190601227863497' },
      observed: { portfolioId: null },
    }))
    expect(withoutOptIn.verdict).toBe('VERIFIED')
  })

  it('treats present-but-undefined as absence even when opted in', () => {
    const r = verifyEntity(pair({
      intended: { portfolioId: '111' },
      observed: { portfolioId: undefined },
    }), ['portfolioId'])
    expect(r.verdict).toBe('VERIFIED')
  })
})

describe('AX-VT.4 — summary', () => {
  it('ok only when everything verified', () => {
    const ok = summarise([verifyEntity(pair()), verifyEntity(pair({ localId: 'c2' }))])
    expect(ok).toMatchObject({ ok: true, total: 2, verified: 2, mismatch: 0, missingOnAmazon: 0, notPushed: 0 })

    const notOk = summarise([verifyEntity(pair()), verifyEntity(pair({ externalId: null }))])
    expect(notOk).toMatchObject({ ok: false, total: 2, verified: 1, notPushed: 1 })
  })

  it('a single mismatch is enough to fail the launch', () => {
    const s = summarise([verifyEntity(pair({ intended: { name: 'A' }, observed: { name: 'B' } }))])
    expect(s.ok).toBe(false)
    expect(s.mismatch).toBe(1)
  })

  it('an empty launch is vacuously ok', () => {
    expect(summarise([])).toMatchObject({ ok: true, total: 0 })
  })
})
