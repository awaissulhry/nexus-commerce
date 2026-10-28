import { describe, expect, it } from 'vitest'

import { emptyValueA11y } from './emptyValue'

/*
 * FE.1's probe (hub #313), as node tests.
 *
 * It arrived as four rendered assertions, which this repo cannot run: `apps/web` vitest is
 * `environment: 'node'` by deliberate decision and jsdom is not a devDependency anywhere. The rule
 * was extracted out of the component instead — which is the stronger test, because the invariant
 * being defended is which string goes where, not what the DOM does with it.
 *
 * The defect these lock: `<EmptyValue measuredZero />` used to render `aria-label={undefined}` — no
 * accessible name at all on an element whose only content is an em-dash — while the UNMEASURED case
 * was named "Not measured". A screen-reader user got a name for the value we know nothing about and
 * silence for the one we measured.
 */
describe('EmptyValue — the honest-zero primitive names both cases', () => {
  it('names the unmeasured value and gives it NO tooltip', () => {
    expect(emptyValueA11y(false)).toEqual({ title: undefined, ariaLabel: 'Not measured' })
  })

  it('carries the reason as both tooltip and name for a measured zero', () => {
    expect(emptyValueA11y(true, 'No sales in 7 days')).toEqual({
      title: 'No sales in 7 days',
      ariaLabel: 'No sales in 7 days',
    })
  })

  it('🔴 an UNMEASURED value never carries a measured-zero explanation, even if passed one', () => {
    // The honesty invariant. A caller handing a reason to a value nobody measured is a caller bug,
    // and the primitive refuses it rather than displaying a reason that was never established.
    expect(emptyValueA11y(false, 'No sales in 7 days')).toEqual({ title: undefined, ariaLabel: 'Not measured' })
  })

  it('🔴 a measured zero is NEVER nameless — the floor beats silence', () => {
    // The union makes this unreachable from a direct caller; NumericCell is the one path that can
    // still arrive without a reason, because `zeroTitle` cannot be made conditional on `zero:
    // 'dash'` in the type. Weaker than a real reason, stronger than no accessible name.
    const a = emptyValueA11y(true, undefined)
    expect(a.ariaLabel).toBe('Measured zero')
    expect(a.ariaLabel).not.toBe('Not measured') // the inversion this whole file exists to prevent
    expect(a.title).toBeUndefined() // no invented tooltip for sighted users
  })
})
