/**
 * NAF.A2 — rate cards after the ProviderName widening.
 *
 * Two jobs: prove 'local' prices at exactly zero and is reported as a KNOWN
 * rate (not an estimate), and prove the widening changed nothing for the two
 * cloud providers — including the dated-suffix strip and the unknown-model
 * fallback that the model catalog's `costEstimated` flag depends on.
 */
import { describe, expect, it } from 'vitest'

import {
  ANTHROPIC_DEFAULT_MODEL,
  GEMINI_DEFAULT_MODEL,
  priceFor,
  rateCardFor,
  rateInfoFor,
} from './rate-cards.js'

describe('local provider pricing', () => {
  it('prices at exactly zero and reports the rate as known, not estimated', () => {
    expect(rateInfoFor('local', 'qwen3-14b')).toEqual({
      inputPer1M: 0,
      outputPer1M: 0,
      known: true,
    })
  })

  it('is zero for any model id, including ones no table has ever seen', () => {
    expect(rateInfoFor('local', 'some-model-nobody-has-heard-of').known).toBe(true)
    expect(priceFor('local', 'qwen3-14b', 1_000_000, 1_000_000)).toBe(0)
    expect(priceFor('local', 'mistral-small-3.2-24b', 12_345, 6_789)).toBe(0)
    expect(rateCardFor('local', 'anything')).toEqual({
      inputPer1M: 0,
      outputPer1M: 0,
    })
  })
})

describe('REGRESSION: cloud pricing is untouched by the widening', () => {
  it('keeps seeded Anthropic and Gemini rates', () => {
    expect(rateInfoFor('anthropic', 'claude-haiku-4-5')).toEqual({
      inputPer1M: 1.0,
      outputPer1M: 5.0,
      known: true,
    })
    expect(rateInfoFor('gemini', GEMINI_DEFAULT_MODEL)).toEqual({
      inputPer1M: 0.3,
      outputPer1M: 2.5,
      known: true,
    })
  })

  it('still strips a dated suffix to inherit the bare-name rate', () => {
    expect(rateInfoFor('anthropic', 'claude-sonnet-4-6-20260401')).toEqual({
      inputPer1M: 3.0,
      outputPer1M: 15.0,
      known: true,
    })
  })

  it('still falls back to the provider default with known:false on an unseen model', () => {
    const unseen = rateInfoFor('anthropic', 'claude-something-new')
    expect(unseen.known).toBe(false)
    expect(unseen.inputPer1M).toBe(
      rateInfoFor('anthropic', ANTHROPIC_DEFAULT_MODEL).inputPer1M,
    )
  })

  it('still computes a non-zero price for cloud calls', () => {
    expect(priceFor('anthropic', 'claude-haiku-4-5', 1_000_000, 0)).toBe(1.0)
    expect(priceFor('gemini', GEMINI_DEFAULT_MODEL, 0, 1_000_000)).toBe(2.5)
  })
})
