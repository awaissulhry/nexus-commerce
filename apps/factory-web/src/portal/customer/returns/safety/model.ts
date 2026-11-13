import type { PortalSafetyStatus } from './api'

/**
 * The portal's Report a safety incident (B-W2b-357; design portal.customer.returns h.more "Report a safety incident" and
 * pop:safety-report "⋯ › Report a safety incident, or 'Safety incident' in step 2"; follow-up GP2:02), pure: why its two
 * openers (the band's ⋯ and the start's card) wait, in words — the door is closed until the privacy notice for these
 * reports is published (GATE-PRIVACY), the person's role follows cases but does not send them, an office preview, no
 * connection — so no opener leads nowhere. The form is the shared one (lib/safety-reports).
 */

export type SafetyDoor = { readonly state: 'loading' } | { readonly state: 'failed' } | { readonly state: 'read'; readonly status: PortalSafetyStatus }

/** Why the openers wait (a key of `safety-reports`), or null. */
export function safetyHeldOf(door: SafetyDoor, who: { readonly offline: boolean; readonly preview: boolean }): string | null {
  if (who.preview) return 'portal.held.preview'
  if (who.offline) return 'portal.held.offline'
  if (door.state === 'loading') return 'portal.held.reading'
  if (door.state === 'failed') return 'portal.held.failed'
  if (!door.status.mayRequest) return 'portal.held.noRequest'
  if (!door.status.open) return 'portal.held.closed'
  return null
}
