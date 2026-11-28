import { describe, expect, it } from 'vitest'
import { EXTRA_RIGHT_ROLE, EXTRA_RIGHTS, extraRightOf, extraRightsOf, roleWordsOf } from './rules'

/** owb-of2 (order workflow, plan.md § 5f): People by customer's pure rules — the extra rights are the base's offer templates. */

describe('the extra rights', () => {
  it('each right is one ready-made role, and back', () => {
    expect(EXTRA_RIGHT_ROLE).toEqual({ ALLOW_PRODUCTION: 'extra_allow_production', PACK_AND_SEND: 'extra_pack_and_send', PRINT_AND_START: 'extra_print_and_start' })
    for (const right of EXTRA_RIGHTS) expect(extraRightOf(EXTRA_RIGHT_ROLE[right])).toBe(right)
    expect(extraRightOf('sales')).toBeNull()
  })

  it('a person\'s extra rights in order, each once; the role words leave them out', () => {
    const roles = [
      { roleKey: 'extra_print_and_start', roleName: 'Print and start the work' },
      { roleKey: 'designer', roleName: 'Factory designer' },
      { roleKey: 'extra_allow_production', roleName: 'Allow production' },
      { roleKey: 'designer', roleName: 'Factory designer' },
    ]
    expect(extraRightsOf(roles)).toEqual(['ALLOW_PRODUCTION', 'PRINT_AND_START'])
    expect(roleWordsOf(roles)).toBe('Factory designer')
    expect(roleWordsOf([])).toBe('')
  })
})
