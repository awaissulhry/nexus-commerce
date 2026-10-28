import type { ApiError } from '../../lib/api/errors'

/**
 * The states of a one-off link page (SCR-028; SAL-099; A2 §3.2): valid, already used, expired, wrong person, withdrawn
 * — each says what happened and whom to ask. Pure, so the tests hold it.
 *
 * What the API tells: opening a link answers its purpose and record, or ONE 404 whatever was wrong (revoked, used up,
 * expired, unknown): a stranger holding an old link learns nothing. So `/link/open` gives `valid` or `unavailable`
 * ("used, expired or withdrawn"). The page knows more in a few places, and then says it exactly: right after its own
 * answer used the last use (`used`), when the expiry passes while the page is open (`expired`), and when an answer's
 * check of the typed name or address fails (`wrong_person`, from the module's answer route, W1).
 */

export const LINK_STATES = ['loading', 'valid', 'used', 'expired', 'wrong_person', 'withdrawn', 'unavailable', 'missing', 'error'] as const
export type LinkState = (typeof LINK_STATES)[number]

/** How a state looks: the DS tone and whether the person can still do anything here. */
export interface LinkStateLook {
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger'
  /** The link is usable on this page. */
  usable: boolean
  /** Asking the sender is the way on (every end state but loading and valid). */
  askSender: boolean
}

export function linkStateLook(state: LinkState): LinkStateLook {
  switch (state) {
    case 'loading':
      return { tone: 'neutral', usable: false, askSender: false }
    case 'valid':
      return { tone: 'success', usable: true, askSender: false }
    case 'used':
      return { tone: 'info', usable: false, askSender: true }
    case 'expired':
    case 'withdrawn':
    case 'unavailable':
    case 'missing':
      return { tone: 'warning', usable: false, askSender: true }
    case 'wrong_person':
      return { tone: 'danger', usable: false, askSender: true }
    case 'error':
      return { tone: 'danger', usable: false, askSender: false }
  }
}

/** The state for a failed open. */
export function linkStateFromError(error: Pick<ApiError, 'kind'>): LinkState {
  if (error.kind === 'not_found') return 'unavailable'
  if (error.kind === 'forbidden') return 'wrong_person'
  return 'error'
}

/** The state of a link that opened, by the clock: past its expiry it is expired, with no uses left it is used. */
export function linkStateOfOpened(link: { expiresAt: string; usesLeft: number }, now: Date): LinkState {
  if (Date.parse(link.expiresAt) <= now.getTime()) return 'expired'
  if (link.usesLeft <= 0) return 'used'
  return 'valid'
}
