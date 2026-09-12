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
  const available = new Set(['title', 'basePrice', 'categoryAttributes.material'])
  it('accepts catalog attributes', () => {
    expect(isValidSource('title', available)).toBe(true)
    expect(isValidSource('basePrice', available)).toBe(true)
    expect(isValidSource('categoryAttributes.material', available)).toBe(true)
  })
  it('refuses invented category attributes, even when syntactically valid', () => {
    expect(isValidSource('categoryAttributes.sleeve_type', available)).toBe(false)
  })
  it('rejects unknown / malformed / non-string', () => {
    expect(isValidSource('foo', available)).toBe(false)
    expect(isValidSource('categoryAttributes.', available)).toBe(false)
    expect(isValidSource(null, available)).toBe(false)
    expect(isValidSource(42, available)).toBe(false)
  })
})
