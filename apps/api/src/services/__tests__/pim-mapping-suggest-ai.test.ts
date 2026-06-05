/**
 * BM.2 — AI-mapping safety helpers (parse + source validation). The LLM call
 * itself is integration-tested on prod; here we pin the guards against AI
 * garbage. Module deps stubbed.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: {} }))
vi.mock('../ai/providers/index.js', () => ({ getProvider: () => null, isAiKillSwitchOn: () => true }))
vi.mock('../ai/usage-logger.service.js', () => ({ logUsage: () => {} }))

import { parseAiJson, isValidSource } from '../pim/mapping-suggest-ai.service.js'

describe('parseAiJson', () => {
  it('parses plain JSON', () => {
    expect(parseAiJson('{"a":{"source":"title"}}')).toEqual({ a: { source: 'title' } })
  })
  it('strips ```json fences', () => {
    expect(parseAiJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })
  it('extracts the JSON object from surrounding prose', () => {
    expect(parseAiJson('Here is the mapping: {"a":1} — done')).toEqual({ a: 1 })
  })
  it('returns {} on non-JSON', () => {
    expect(parseAiJson('I could not map these')).toEqual({})
  })
})

describe('isValidSource', () => {
  it('accepts catalog attributes', () => {
    expect(isValidSource('title')).toBe(true)
    expect(isValidSource('our_price')).toBe(true)
    expect(isValidSource('categoryAttributes.material')).toBe(true)
  })
  it('accepts categoryAttributes.<snake_case>', () => {
    expect(isValidSource('categoryAttributes.sleeve_type')).toBe(true)
  })
  it('rejects unknown / malformed / non-string', () => {
    expect(isValidSource('foo')).toBe(false)
    expect(isValidSource('categoryAttributes.')).toBe(false)
    expect(isValidSource(null)).toBe(false)
    expect(isValidSource(42)).toBe(false)
  })
})
