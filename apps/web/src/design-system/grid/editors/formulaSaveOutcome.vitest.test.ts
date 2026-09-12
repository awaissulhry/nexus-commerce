import { describe, expect, it } from 'vitest'

import { formulaSaveOutcome, FORMULA_STORED_NOT_EVALUATED } from './formulaEditing'

/**
 * The first case is the point of this file: it is the payload MEASURED on a live refusal
 * (UX.1, 2026-09-03, master·DE, `batteries_included = "maybe"`), which arrives as **HTTP 200**.
 * A `save()` that trusted the status code would have called it a success.
 */
describe('formulaSaveOutcome', () => {
  it('treats HTTP 200 + ok:false as a REFUSAL and surfaces the server sentence verbatim', () => {
    const measured = {
      ok: false,
      lastError: '"maybe" is not an allowed value for Are batteries included? — choose one of: true, false',
    }
    expect(formulaSaveOutcome(measured)).toEqual({
      ok: false,
      error: '"maybe" is not an allowed value for Are batteries included? — choose one of: true, false',
    })
  })

  it('reads the reason from any of the three shapes the route has carried', () => {
    expect(formulaSaveOutcome({ ok: false, error: 'top-level error' })).toEqual({ ok: false, error: 'top-level error' })
    expect(formulaSaveOutcome({ lastError: 'top-level lastError' })).toEqual({ ok: false, error: 'top-level lastError' })
    expect(formulaSaveOutcome({ formula: { lastError: 'nested' } })).toEqual({ ok: false, error: 'nested' })
  })

  it('refuses without a reason rather than showing a blank warning', () => {
    expect(formulaSaveOutcome({ ok: false })).toEqual({ ok: false, error: FORMULA_STORED_NOT_EVALUATED })
  })

  it('does NOT read a missing ok as a refusal', () => {
    // `ok === false`, not `!ok` — an older payload that omits the flag is not a refusal.
    expect(formulaSaveOutcome({})).toEqual({ ok: true })
    expect(formulaSaveOutcome({ ok: true })).toEqual({ ok: true })
  })

  it('survives a null body rather than throwing inside a save handler', () => {
    expect(formulaSaveOutcome(null)).toEqual({ ok: true })
    expect(formulaSaveOutcome(undefined)).toEqual({ ok: true })
  })
})
