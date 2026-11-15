import { KeyRound } from 'lucide-react'
import type { AreaNav, AreaNavArea } from '@nexus/ui/patterns/shell/index'

/**
 * B-W2b-F58 (the Owner signed in on his local test server, 11-15, and saw an empty navigation with no word why): a person
 * whose role asks for two-factor gets no grants until the code is proved on this session (apps/factory-api
 * platform/auth/sessions/grants.ts, by design), so the navigation has no row. It then shows ONE row in words that opens
 * Me › Authenticator (where that card comes first): "Set up your authenticator app to see your work", or — the app is set up
 * but this session never proved a code (it began before) — "Sign in again with your authenticator app to see your work".
 * Once the code is proved, the page reloads the session (areas/me MyProfile: router.refresh) and the areas replace the row.
 */

export const MFA_HINT_ID = 'authenticator-first'
/** Me › Authenticator (company-free, as every navigation address). */
export const MFA_HINT_HREF = '/me#authenticator'

export interface MfaState {
  enabled: boolean
  required: boolean
  satisfied: boolean
}

/** What the person's roles wait for: the app set up, a sign-in with its code, or nothing (null). */
export function mfaWaits(mfa: MfaState): 'setup' | 'signIn' | null {
  if (!mfa.required || mfa.satisfied) return null
  return mfa.enabled ? 'signIn' : 'setup'
}

/** The navigation with the hint row first while the person's roles wait for two-factor (labels are message keys). */
export function navWithMfaHint(nav: AreaNav, mfa: MfaState): AreaNav {
  const waits = mfaWaits(mfa)
  if (!waits) return nav
  const hint: AreaNavArea = { id: MFA_HINT_ID, label: `shell:nav.mfaHint.${waits}`, href: MFA_HINT_HREF, icon: KeyRound, phone: 'tab' }
  return { ...nav, areas: [hint, ...nav.areas.filter((area) => area.id !== MFA_HINT_ID)] }
}
