import { describe, expect, it } from 'vitest'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { assertMayTakeOptions } from './options-entry'

describe("a typed order's options (B-W2b-374; XF3:02)", () => {
  it('go only on an order made CONFIRMED: one that would wait for a yes is refused in words (409)', () => {
    expect(() => assertMayTakeOptions('CONFIRMED', 2)).not.toThrow()
    expect(() => assertMayTakeOptions('PENDING_APPROVAL', 0)).not.toThrow()
    let error: unknown
    try {
      assertMayTakeOptions('PENDING_APPROVAL', 1)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(DomainError)
    expect((error as DomainError).code).toBe('conflict')
    expect((error as DomainError).message).toMatch(/wait for a yes .* takes options only once it is confirmed: make it without the options/)
  })
})
