import { expect, it, vi } from 'vitest'
vi.mock('../../db.js', () => ({ default: {} }))
import { familyAccountId } from './family-account.js'
it('uses existing family attribution when several accounts are active', () => {
  expect(familyAccountId(['a', 'b'], ['b', 'b'])).toBe('b')
  expect(familyAccountId(['a', 'b'], ['a', 'b'])).toBeNull()
  expect(familyAccountId(['a', 'b'], [])).toBeNull()
  expect(familyAccountId(['a'], [])).toBe('a')
  expect(familyAccountId([], ['b'])).toBeNull()
})
