/**
 * Two-factor on the profiles page (2026-10-01). Business pages refuse a sign-in that did not complete two-factor
 * ("Complete two-factor authentication"); this says which step gets the person in, instead of a "Retry" that never can:
 *   sign-in-again  two-factor is set up: sign in again and enter the code from the authenticator app;
 *   set-up         two-factor is required but not set up: set it up in Personal settings (that sign-in then counts).
 */
export type MfaStep = 'sign-in-again' | 'set-up'

export function mfaStepOf(user: { mfaIncomplete?: boolean; mfaEnabled?: boolean } | null | undefined): MfaStep | null {
  if (!user?.mfaIncomplete) return null
  return user.mfaEnabled ? 'sign-in-again' : 'set-up'
}
